// Turas Lúbtha Driver: the shuttle driver's app for Android and iPhone.
import 'package:flutter/material.dart';

import 'alerts.dart';
import 'driver.dart';
import 'tracker.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final driver = Driver(tracker: Tracker(), alerts: PhoneAlerts());
  runApp(TurasDriverApp(driver: driver));
  driver.start();
}

class TurasDriverApp extends StatelessWidget {
  const TurasDriverApp({super.key, required this.driver});
  final Driver driver;

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
              return HomeScreen(driver: driver);
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
