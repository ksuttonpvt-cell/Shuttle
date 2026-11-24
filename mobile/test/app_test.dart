import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:turas_driver/api.dart';
import 'package:turas_driver/driver.dart';
import 'package:turas_driver/main.dart';
import 'package:turas_driver/models.dart';
import 'package:turas_driver/steps.dart';
import 'package:turas_driver/store.dart';

import 'fake_server.dart';

/// Keeps the session in memory instead of the phone's secure storage.
class MemoryStore implements SessionStore {
  Session? s;
  String? email;
  @override
  Future<Session?> load() async => s;
  @override
  Future<void> save(Session v) async => s = v;
  @override
  Future<void> clear() async => s = null;
  @override
  Future<String?> lastEmail() async => email;
  @override
  Future<void> saveEmail(String e) async => email = e;
}

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
}
