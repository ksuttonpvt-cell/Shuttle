// Checks the app's connection against a real shuttle server (not part of the app).
//
//   dart run tool/e2e.dart http://website.localhost:3000 driver@email password
//
// Signs in through the shared sign-in exactly like the app, starts a shift, takes the first
// waiting ride and walks it through every step, then ends the shift.
// *.localhost names are sent to this computer (127.0.0.1), like browsers do.
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:turas_driver/api.dart';
import 'package:turas_driver/steps.dart';

class LocalhostClient extends http.BaseClient {
  final http.Client _inner = http.Client();
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    final u = request.url;
    if (!u.host.endsWith('.localhost')) return _inner.send(request);
    final r = http.Request(request.method, u.replace(host: '127.0.0.1'))
      ..followRedirects = request.followRedirects
      ..headers.addAll(request.headers)
      ..headers['host'] = '${u.host}${u.hasPort ? ':${u.port}' : ''}';
    if (request is http.Request) r.bodyBytes = request.bodyBytes;
    return _inner.send(r);
  }
}

Future<void> main(List<String> args) async {
  final site = args[0];
  final api = Api(client: LocalhostClient(), site: site);
  void ok(String s) => stdout.writeln('✔ $s');

  final r = await api.signIn(args[1], args[2]);
  final session = r.session ?? await api.useHandoff(r.choices.first.url);
  ok('signed in at ${session.base}');
  final me = await api.me();
  ok('${me.name} · roles ${me.roles} · ${me.settings.businessName} (${me.settings.place})');
  if (!me.canDrive) throw 'not a driver';

  // Live updates: listen, then starting the shift should be heard within a few seconds.
  final heard = <String>[];
  final live = api.events().listen(heard.add, onError: (Object e) => heard.add('error: $e'));
  await Future<void>.delayed(const Duration(seconds: 1));
  final vans = (await api.vehicles()).where((v) => v.usable).toList();
  await api.startShift(vans.first.id);
  ok('shift started in ${vans.first.name}');
  for (var i = 0; i < 30 && !heard.contains('drivers'); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
  if (!heard.contains('drivers')) throw 'live updates not heard: $heard';
  ok('live updates heard: ${heard.toSet().join(', ')}');
  await live.cancel();
  await api.sendLocation(lat: 40.02, lng: -105.24, heading: 90, speed: 0, battery: 80, charging: true);
  ok('location sent');

  // Managers and advisors book rides from the app.
  if (me.canDesk) {
    final (found, note) = await api.findAddress('1520 Pearl St Boulder');
    ok('address search: ${found.length} result(s)${note != null ? ' ($note)' : ''}');
    final b = await api.book({
      'type': 'pickup', 'customer_name': 'App Booking', 'customer_phone': '555 010 4000', 'address': found.isNotEmpty ? found.first.label : '1520 Pearl St',
      'lat': found.isNotEmpty ? found.first.lat : 40.019, 'lng': found.isNotEmpty ? found.first.lng : -105.274,
      'scheduled_at': DateTime.now().add(const Duration(minutes: 20)).toUtc().toIso8601String(), 'passengers': 2, 'notes': 'Booked from the app',
    });
    ok('booked ${b.ride.customerName} (ride ${b.ride.id}), tracking link ${b.ride.trackUrl}');
    final drivers = await api.drivers();
    ok('desk sees ${drivers.length} driver(s), ${drivers.where((x) => x.onDuty).length} on shift');
  }

  var list = await api.rides();
  final waiting = list.waiting();
  if (waiting.isEmpty) throw 'no waiting ride';
  var ride = waiting.first;
  ok('${list.rides.length} open ride(s); taking ${ride.customerName}');
  final offer = await api.offer();
  if (offer != null) ok('ride offer ${offer.id} for ${offer.customerName} (${offer.secondsLeft}s)');

  // Walk the steps exactly as the big button would.
  for (var i = 0; i < 6; i++) {
    final step = mainStep(ride, me.id);
    if (step.kind == StepKind.none) break;
    switch (step.kind) {
      case StepKind.take:
        await api.take(ride, me.id);
      case StepKind.onMyWay:
        await api.setStatus(ride, 'en_route');
      case StepKind.imHere:
        await api.arrived(ride);
      case StepKind.onBoard:
        await api.setStatus(ride, 'onboard');
      case StepKind.complete:
        await api.setStatus(ride, 'completed');
      case StepKind.none:
        break;
    }
    ok('step: ${step.label}');
    list = await api.rides();
    final next = list.rides.where((x) => x.id == ride.id).firstOrNull;
    if (next == null) break; // completed rides leave the open list
    ride = next;
    ok('  now ${statusLabel[ride.status]}${ride.arrivedAt != null ? ' (arrived)' : ''} · navigate to ${nextPlace(ride, me.settings).toBusiness ? 'the ${me.settings.place}' : ride.address}');
  }
  if ((await api.rides()).rides.any((x) => x.id == ride.id)) throw 'ride did not complete';
  ok('ride complete');

  await api.endShift();
  ok('shift ended');
  await api.signOut();
  try {
    api.session = session;
    await api.me();
    throw 'still signed in after sign out';
  } on ApiError catch (e) {
    if (!e.signedOut) rethrow;
  }
  ok('signed out (the old sign-in no longer works)');
  exit(0);
}
