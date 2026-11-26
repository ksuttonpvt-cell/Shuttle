// Turas Lúbtha Driver: the shuttle driver's app for Android and iPhone.
import 'package:flutter/material.dart';

import 'alerts.dart';
import 'api.dart';
import 'demo.dart';
import 'driver.dart';
import 'tracker.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';
import 'ui/theme.dart';

/// A made-up shuttle for screenshots: flutter build web --dart-define=DEMO=true
/// (?screen=signin, shift, offer, rides, desk or me; &role=admin or advisor). Never part of the real app.
const demo = bool.fromEnvironment('DEMO');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  if (demo) return _demo();
  final driver = Driver(tracker: Tracker(), alerts: PhoneAlerts());
  runApp(TurasDriverApp(driver: driver));
  driver.start();
}

void _demo() {
  final screen = Uri.base.queryParameters['screen'] ?? 'today';
  final f = FakeShuttle(onDuty: screen != 'shift', role: Uri.base.queryParameters['role'] ?? 'driver')..signedIn = screen != 'signin';
  if (screen == 'offer') {
    f.offer = {'id': 5, 'ride_id': 13, 'customer_name': 'Sam Ortiz', 'type': 'pickup', 'address': '410 Baseline Rd', 'passengers': 2, 'seconds_left': 42,
      'scheduled_at': DateTime.now().add(const Duration(minutes: 20)).toUtc().toIso8601String()};
  }
  if (screen == 'here') f.rides.first..['status'] = 'en_route'..['arrived_at'] = DateTime.now().subtract(const Duration(minutes: 2, seconds: 14)).toUtc().toIso8601String();
  final store = MemoryStore()..email = 'dana@drivers.test';
  if (screen != 'signin') store.s = const Session(base: 'https://turaslubtha.com/pinevalley', sid: 'SECRET123');
  final driver = Driver(api: Api(client: f.client), store: store);
  runApp(TurasDriverApp(driver: driver, startTab: {'rides': 1, 'desk': 2, 'me': 3}[screen] ?? 0));
  driver.start();
}

class TurasDriverApp extends StatelessWidget {
  const TurasDriverApp({super.key, required this.driver, this.startTab = 0});
  final Driver driver;
  final int startTab;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Turas Driver',
      debugShowCheckedModeBanner: false,
      theme: turasTheme(Brightness.light),
      darkTheme: turasTheme(Brightness.dark),
      home: ListenableBuilder(
        listenable: driver,
        builder: (context, _) {
          switch (driver.phase) {
            case Phase.starting:
              return const Splash();
            case Phase.signedOut:
              return SignInScreen(driver: driver);
            case Phase.notDriver:
              return NotDriverScreen(driver: driver);
            case Phase.ready:
              return HomeScreen(driver: driver, startTab: startTab);
          }
        },
      ),
    );
  }
}

class Splash extends StatelessWidget {
  const Splash({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: BrandMark(size: 34)));
}

class NotDriverScreen extends StatelessWidget {
  const NotDriverScreen({super.key, required this.driver});
  final Driver driver;
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const BrandMark(size: 28),
            const SizedBox(height: 24),
            Text('This app is for drivers', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text('${driver.me?.name ?? 'Your account'} isn’t set up as a driver. Ask a manager to add the driver role, or use the shuttle website for the desk.',
                textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton(onPressed: driver.signOut, child: const Text('Sign out')),
          ]),
        ),
      ),
    );
  }
}
