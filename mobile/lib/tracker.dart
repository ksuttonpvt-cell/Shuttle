// The van's location while the driver is on shift, also with the screen off or another app
// (like Google Maps) in front: an ongoing "On shift" notice on Android, the blue location
// indicator on iPhone. It stops the moment the shift ends.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:battery_plus/battery_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

class Fix {
  const Fix({required this.lat, required this.lng, this.heading, this.speed, this.battery, this.charging = false});
  final double lat;
  final double lng;
  final double? heading;
  final double? speed;
  final int? battery;
  final bool charging;
}

typedef OnFix = Future<void> Function(Fix fix);

class Tracker {
  Tracker() : _enabled = true;
  Tracker.disabled() : _enabled = false; // tests and previews
  final bool _enabled;

  StreamSubscription<Position>? _sub;
  Timer? _heartbeat;
  OnFix? _onFix;
  Position? _last;
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);
  Position? _lastSentPos;
  final Battery _battery = Battery();

  bool get running => _sub != null;
  String? status; // shown on the Me screen

  /// Asks for location (while using the app is enough: the shift keeps it running).
  Future<bool> ask() async {
    if (!_enabled) return true;
    if (!await Geolocator.isLocationServiceEnabled()) {
      status = 'Location is turned off on this phone.';
      return false;
    }
    var p = await Geolocator.checkPermission();
    if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
    final ok = p == LocationPermission.whileInUse || p == LocationPermission.always;
    status = ok ? null : 'Location is blocked for Turas Driver.';
    return ok;
  }

  Future<void> start({required OnFix onPosition}) async {
    _onFix = onPosition;
    if (!_enabled || _sub != null) return;
    final perm = await Geolocator.checkPermission();
    if (perm != LocationPermission.whileInUse && perm != LocationPermission.always) {
      status = 'Location is blocked for Turas Driver.';
      return;
    }
    final LocationSettings settings;
    if (!kIsWeb && Platform.isAndroid) {
      settings = AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 15,
        intervalDuration: const Duration(seconds: 5),
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'On shift',
          notificationText: 'Sharing the van’s location with the desk and your customers.',
          notificationChannelName: 'On shift',
          enableWakeLock: true,
          setOngoing: true,
        ),
      );
    } else if (!kIsWeb && Platform.isIOS) {
      settings = AppleSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 15,
        activityType: ActivityType.automotiveNavigation,
        pauseLocationUpdatesAutomatically: false,
        allowBackgroundLocationUpdates: true,
        showBackgroundLocationIndicator: true,
      );
    } else {
      settings = const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 15);
    }
    status = null;
    _sub = Geolocator.getPositionStream(locationSettings: settings).listen(_got, onError: (Object e) {
      status = 'Can’t get the van’s location right now.';
    });
    // Parked vans still check in every 30 seconds, so the desk knows the phone is fine.
    _heartbeat = Timer.periodic(const Duration(seconds: 30), (_) {
      final p = _last;
      if (p != null && DateTime.now().difference(_lastSent) >= const Duration(seconds: 25)) _send(p);
    });
  }

  void _got(Position p) {
    _last = p;
    final since = DateTime.now().difference(_lastSent);
    final moved = _lastSentPos == null ? 9999.0 : Geolocator.distanceBetween(_lastSentPos!.latitude, _lastSentPos!.longitude, p.latitude, p.longitude);
    if (since >= const Duration(seconds: 8) || moved >= 40) _send(p);
  }

  Future<void> _send(Position p) async {
    final f = _onFix;
    if (f == null) return;
    _lastSent = DateTime.now();
    _lastSentPos = p;
    int? level;
    var charging = false;
    try {
      level = await _battery.batteryLevel;
      final st = await _battery.batteryState;
      charging = st == BatteryState.charging || st == BatteryState.full;
    } catch (_) {/* not every phone tells */}
    try {
      await f(Fix(lat: p.latitude, lng: p.longitude, heading: p.heading >= 0 ? p.heading : null, speed: p.speed >= 0 ? p.speed : null, battery: level, charging: charging));
    } catch (_) {/* the next one will try again */}
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    _last = null;
  }
}
