import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_test/flutter_test.dart';
import 'package:turas_driver/api.dart';
import 'package:turas_driver/driver.dart';
import 'package:turas_driver/main.dart';
import 'package:turas_driver/models.dart';
import 'package:turas_driver/steps.dart';
import 'package:turas_driver/ui/book.dart';

import 'fake_server.dart';

class RecordAlerts implements Alerts {
  final List<String> shown = [];
  @override
  Future<void> ask() async {}
  @override
  void newRides(List<Ride> rides, int me) => shown.add('rides:${rides.map((r) => r.customerName).join(',')}');
  @override
  void offer(Offer o) => shown.add('offer:${o.customerName}');
}

Ride ride(Map<String, dynamic> j) => Ride.fromJson(j);

/// The fake shuttle plus a live-updates line the test can talk down.
class LiveClient extends http.BaseClient {
  LiveClient(this.inner);
  final http.Client inner;
  StreamController<List<int>>? line;
  String? cookie;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest req) async {
    if (!req.url.path.endsWith('/api/events')) return inner.send(req);
    cookie = req.headers['Cookie'];
    line = StreamController<List<int>>();
    return http.StreamedResponse(line!.stream, 200, headers: {'content-type': 'text/event-stream'});
  }
  void say(String text) => line!.add(utf8.encode(text));
}

void main() {
  group('steps', () {
    final s = Settings.fromJson({'dealer_name': 'Pine Valley', 'place': 'dealership', 'dealer_lat': '40', 'dealer_lng': '-105', 'arrive_wait_min': '5'});
    Map<String, dynamic> base(String status, {int? driver = 7, String type = 'pickup', String? arrived}) =>
        {'id': 1, 'customer_name': 'Riley Rider', 'type': type, 'status': status, 'address': '1 Main', 'lat': 41.0, 'lng': -104.0, 'driver_id': driver, 'arrived_at': arrived};

    test('one big button, in order', () {
      expect(mainStep(ride(base('requested', driver: null)), 7).kind, StepKind.take);
      expect(mainStep(ride(base('assigned')), 7).kind, StepKind.onMyWay);
      expect(mainStep(ride(base('en_route')), 7).kind, StepKind.imHere);
      expect(mainStep(ride(base('en_route', arrived: DateTime.now().toIso8601String())), 7).kind, StepKind.onBoard);
      expect(mainStep(ride(base('onboard')), 7).kind, StepKind.complete);
      expect(mainStep(ride(base('assigned', driver: 9)), 7).kind, StepKind.none, reason: "someone else's ride");
    });

    test('navigates to the customer, then back to the business', () {
      expect(nextPlace(ride(base('assigned')), s).toBusiness, false);
      expect(nextPlace(ride(base('onboard')), s).toBusiness, true);
      expect(nextPlace(ride(base('assigned', type: 'dropoff')), s).toBusiness, true, reason: 'drop offs start at the business');
      expect(nextPlace(ride(base('onboard', type: 'dropoff')), s).toBusiness, false);
      expect(directionsUrl(nextPlace(ride(base('assigned')), s)).toString(), contains('destination=41.0%2C-104.0'));
    });

    test('no-show only after the wait time', () {
      final now = DateTime.now();
      expect(canNoShow(ride(base('en_route', arrived: now.subtract(const Duration(minutes: 2)).toIso8601String())), s, now), false);
      expect(canNoShow(ride(base('en_route', arrived: now.subtract(const Duration(minutes: 6)).toIso8601String())), s, now), true);
      expect(noShowReason(ride(base('en_route', arrived: now.subtract(const Duration(minutes: 7)).toIso8601String())), now), contains('waited 7 min'));
    });

    test('rides come in the suggested order', () {
      final l = RideList.fromJson({'rides': [base('assigned')..['id'] = 1, base('requested', driver: null)..['id'] = 2], 'queue': [2, 1]});
      expect(l.rides.map((r) => r.id), [2, 1]);
      expect(l.mine(7).map((r) => r.id), [1]);
      expect(l.waiting().map((r) => r.id), [2]);
      expect(nextRide(l, 7, onDuty: true)!.id, 1, reason: 'my own ride before a waiting one');
    });
  });

  group('signing in', () {
    test('signs in through the shared sign-in and keeps the business address', () async {
      final f = FakeShuttle();
      final api = Api(client: f.client, site: 'https://turaslubtha.com');
      final r = await api.signIn('dana@drivers.test', 'drive-pass-1');
      expect(r.session!.base, 'https://turaslubtha.com/pinevalley');
      expect(r.session!.sid, 'SECRET123');
      expect((await api.me()).name, 'Dana Driver');
      expect(f.calls, contains('GET /pinevalley/api/me'));
    });

    test('a wrong password says so; two businesses give a choice', () async {
      final f = FakeShuttle();
      final api = Api(client: f.client, site: 'https://turaslubtha.com');
      expect(() => api.signIn('dana@drivers.test', 'nope'), throwsA(isA<ApiError>().having((e) => e.message, 'message', 'Email or password is incorrect.')));
      final r = await api.signIn('two@drivers.test', 'x');
      expect(r.choices.map((c) => c.name), ['Pine Valley Auto', 'Lakeside Hotel']);
    });
  });

  group('the driver', () {
    test('new rides buzz the phone (but not the ones already there)', () async {
      final f = FakeShuttle(onDuty: true);
      final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'SECRET123');
      f.signedIn = true;
      final alerts = RecordAlerts();
      final d = Driver(api: Api(client: f.client), store: store, alerts: alerts);
      await d.start();
      expect(d.phase, Phase.ready);
      expect(alerts.shown, isEmpty, reason: 'nothing new on first look');
      f.rides.add(f.rides.last.map((k, v) => MapEntry(k, v))..['id'] = 14..['customer_name'] = 'Jo New');
      f.offer = {'id': 5, 'ride_id': 14, 'customer_name': 'Jo New', 'type': 'pickup', 'address': '9 Elm', 'seconds_left': 45};
      await d.refresh();
      expect(alerts.shown, ['rides:Jo New', 'offer:Jo New']);
      await d.refresh();
      expect(alerts.shown.length, 2, reason: 'once only');
      d.dispose();
    });

    test('live updates: a change on the shuttle shows up right away', () async {
      final f = FakeShuttle(onDuty: true);
      f.signedIn = true;
      final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'SECRET123');
      final live = LiveClient(f.client);
      final d = Driver(api: Api(client: live), store: store);
      await d.start();
      await Future<void>.delayed(Duration.zero);
      expect(live.cookie, 'sid=SECRET123');
      live.say('retry: 4000\n\nevent: hello\ndata: {}\n\n');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(d.liveOn, isTrue);
      final before = d.rides.rides.length;
      f.rides.add(f.rides.last.map((k, v) => MapEntry(k, v))..['id'] = 15..['customer_name'] = 'Lee Live');
      live.say(': ping\n\nevent: rides\ndata: {}\n\n');
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(d.rides.rides.length, before + 1);
      // The line drops: back to asking often, and it tries again.
      await live.line!.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(d.liveOn, isFalse);
      d.dispose();
    });

    test('a newer app on the shuttle PC is offered (Android builds only)', () async {
      final f = FakeShuttle(onDuty: false)..signedIn = true;
      final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'S');
      f.latestApp = {'build': 12, 'version': '1.0.0', 'size': 100, 'url': '/download/turas-driver.apk', 'sha256': 'abc'};
      final d = Driver(api: Api(client: f.client), store: store, canUpdate: true, build: 10);
      await d.start();
      await d.checkForUpdate(now: true);
      expect(d.update?.build, 12);
      expect(d.update?.url, 'https://turaslubtha.com/download/turas-driver.apk');
      // Already on the newest: nothing offered. Hand-made builds and iPhones never ask.
      final same = Driver(api: Api(client: f.client), store: store, canUpdate: true, build: 12);
      await same.checkForUpdate(now: true);
      expect(same.update, isNull);
      final iphone = Driver(api: Api(client: f.client), store: store, canUpdate: false, build: 10);
      await iphone.checkForUpdate(now: true);
      expect(iphone.update, isNull);
      d.dispose();
    });

    test('signed out elsewhere: back to sign in', () async {
      final f = FakeShuttle();
      final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'OLD');
      final d = Driver(api: Api(client: f.client), store: store);
      await d.start();
      expect(d.phase, Phase.signedOut);
      expect(store.s, isNull);
    });
  });

  group('screens', () {
    testWidgets('sign in, start a shift, and run a ride with the big button', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.6;
      addTearDown(tester.view.reset);
      final f = FakeShuttle();
      final d = Driver(api: Api(client: f.client, site: 'https://turaslubtha.com'), store: MemoryStore());
      await tester.pumpWidget(TurasDriverApp(driver: d));
      await tester.runAsync(d.start);
      await tester.pumpAndSettle();
      expect(find.text('Sign in'), findsWidgets);

      await tester.enterText(find.widgetWithText(TextField, 'Email'), 'dana@drivers.test');
      await tester.enterText(find.widgetWithText(TextField, 'Password'), 'drive-pass-1');
      await tester.runAsync(() async {
        await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pumpAndSettle();
      expect(find.text('Start your shift'), findsOneWidget);
      expect(find.text('Pine Valley Auto'), findsWidgets);

      // The only usable van is picked already (the loaner isn't offered).
      await tester.runAsync(() async {
        await tester.tap(find.widgetWithText(FilledButton, 'Start shift'));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pumpAndSettle();
      expect(f.onDuty, true);
      expect(f.vehicleId, 1);
      expect(find.text('NEXT STOP'), findsOneWidget);
      expect(find.text('Riley Rider'), findsOneWidget);

      for (final label in ["Start · I'm on my way", "I'm here", 'Customer is on board', 'Ride complete']) {
        expect(find.widgetWithText(FilledButton, label), findsOneWidget, reason: label);
        await tester.runAsync(() async {
          await tester.tap(find.widgetWithText(FilledButton, label));
          await Future<void>.delayed(const Duration(milliseconds: 50));
        });
        await tester.pumpAndSettle();
      }
      expect(f.rides.first['status'], 'completed');
      expect(find.text('Morgan Lee'), findsOneWidget, reason: 'on to the next stop');

      // Rides tab: my rides and the waiting one.
      await tester.tap(find.text('Rides'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Waiting ('));
      await tester.pumpAndSettle();
      expect(find.text('Sam Ortiz'), findsOneWidget);
      d.dispose();
    });
  });

  group('managers and advisors', () {
    Future<(FakeShuttle, Driver)> signedIn(WidgetTester tester, String role) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.6;
      addTearDown(tester.view.reset);
      final f = FakeShuttle(role: role)..signedIn = true;
      final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'SECRET123');
      final d = Driver(api: Api(client: f.client), store: store);
      await tester.pumpWidget(TurasDriverApp(driver: d));
      await tester.runAsync(d.start);
      await tester.pumpAndSettle();
      return (f, d);
    }

    testWidgets('a manager signs in: can drive, and has the Desk', (tester) async {
      final (f, d) = await signedIn(tester, 'admin');
      expect(find.text('This app is for drivers'), findsNothing);
      for (final tab in ['Today', 'Rides', 'Desk', 'Me']) {
        expect(find.text(tab), findsWidgets, reason: tab);
      }
      expect(find.text('Start your shift'), findsOneWidget, reason: 'managers can drive too');

      await tester.tap(find.text('Desk'));
      await tester.pumpAndSettle();
      expect(find.text('Full manager site'), findsOneWidget);
      expect(find.text('WAITING FOR A DRIVER (1)'), findsOneWidget);
      expect(find.text('Sam Ortiz'), findsOneWidget);

      // Give the waiting ride to a driver.
      await tester.tap(find.widgetWithText(FilledButton, 'Assign'));
      await tester.pumpAndSettle();
      expect(find.text('Who drives Sam Ortiz?'), findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(find.text('Sam Wheels'));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pumpAndSettle();
      expect(f.rides.firstWhere((r) => r['id'] == 13)['driver_id'], 8);
      expect(f.calls, contains('PATCH /pinevalley/api/rides/13'));
      expect(find.text('WAITING FOR A DRIVER (0)'), findsOneWidget);
      d.dispose();
    });

    testWidgets('a service advisor gets the Desk, not the driving screens', (tester) async {
      final (_, d) = await signedIn(tester, 'advisor');
      expect(find.text('Today'), findsNothing);
      expect(find.text('Desk'), findsWidgets);
      expect(find.text('Full advisor desk'), findsOneWidget);
      expect(find.text('Start your shift'), findsNothing);
      d.dispose();
    });
  });

  testWidgets('booking a ride from the Desk', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.6;
    addTearDown(tester.view.reset);
    final f = FakeShuttle(role: 'admin')..signedIn = true;
    final store = MemoryStore()..s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'SECRET123');
    final d = Driver(api: Api(client: f.client), store: store);
    await tester.pumpWidget(TurasDriverApp(driver: d, startTab: 2));
    await tester.runAsync(d.start);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Book a ride'));
    await tester.pumpAndSettle();
    expect(find.text('Bring the customer to the dealership.'), findsOneWidget);
    final form = find.descendant(of: find.byType(BookScreen), matching: find.byType(Scrollable)).first;

    // Nothing filled in: it says what's missing.
    await tester.scrollUntilVisible(find.widgetWithText(FilledButton, 'Book the ride'), 300, scrollable: form);
    await tester.tap(find.widgetWithText(FilledButton, 'Book the ride'));
    await tester.pumpAndSettle();
    expect(find.text('Enter the customer’s name.'), findsOneWidget);

    await tester.scrollUntilVisible(find.widgetWithText(TextField, 'Name *'), -300, scrollable: form);
    await tester.enterText(find.widgetWithText(TextField, 'Name *'), 'Jo Newman');
    await tester.enterText(find.widgetWithText(TextField, 'Mobile phone'), '555 010 3000');
    await tester.runAsync(() async {
      await tester.enterText(find.widgetWithText(TextField, 'Address *'), '1520 Pearl');
      await Future<void>.delayed(const Duration(milliseconds: 600));
    });
    await tester.pumpAndSettle();
    await tester.tap(find.text('1520 Pearl Street, Boulder, CO 80302'));
    await tester.pumpAndSettle();
    expect(find.text('Found on the map ✓'), findsOneWidget);
    await tester.tap(find.text('In 30 min'));
    await tester.scrollUntilVisible(find.byIcon(Icons.add_rounded).last, 200, scrollable: form);
    await tester.tap(find.byIcon(Icons.add_rounded).last);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.widgetWithText(FilledButton, 'Book the ride'), 300, scrollable: form);
    await tester.runAsync(() async {
      await tester.tap(find.widgetWithText(FilledButton, 'Book the ride'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    final booked = f.rides.last;
    expect(booked['customer_name'], 'Jo Newman');
    expect(booked['customer_phone'], '555 010 3000');
    expect(booked['address'], '1520 Pearl Street, Boulder, CO 80302');
    expect([booked['lat'], booked['lng'], booked['passengers'], booked['type']], [40.019, -105.274, 2, 'pickup']);
    final when = DateTime.parse(booked['scheduled_at'] as String).difference(DateTime.now()).inMinutes;
    expect(when, inInclusiveRange(28, 30));
    expect(find.text('Booked'), findsOneWidget);
    expect(find.text('Text them the tracking link'), findsOneWidget);
    d.dispose();
  });
}
