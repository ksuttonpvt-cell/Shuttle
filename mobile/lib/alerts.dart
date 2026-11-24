// Phone notifications: a new ride for you (or waiting for a driver while you're on shift) and
// ride offers. They show even when the app is in the background during a shift.
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'driver.dart';
import 'models.dart';
import 'steps.dart';

class PhoneAlerts implements Alerts {
  final FlutterLocalNotificationsPlugin _n = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  static const _rides = AndroidNotificationDetails('rides', 'Rides',
      channelDescription: 'New rides for you and rides waiting for a driver',
      importance: Importance.high, priority: Priority.high, category: AndroidNotificationCategory.message);
  static const _offers = AndroidNotificationDetails('offers', 'Ride offers',
      channelDescription: 'A ride offered to you: take it before the time runs out',
      importance: Importance.max, priority: Priority.max, category: AndroidNotificationCategory.call);
  static const _ios = DarwinNotificationDetails(presentAlert: true, presentBanner: true, presentList: true, presentSound: true);

  Future<void> _init() async {
    if (_ready || kIsWeb) return;
    await _n.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
      ),
    );
    _ready = true;
  }

  @override
  Future<void> ask() async {
    try {
      await _init();
      await _n.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      await _n.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()?.requestPermissions(alert: true, sound: true, badge: false);
    } catch (_) {/* the app still works without notifications */}
  }

  @override
  void newRides(List<Ride> rides, int me) {
    if (rides.isEmpty) return;
    final r = rides.first;
    final mine = r.driverId == me;
    final more = rides.length > 1 ? ' (+${rides.length - 1} more)' : '';
    _show(r.id, mine ? 'Ride assigned to you' : 'New ride waiting',
        '${r.customerName} · ${typeLabel[r.type]} ${clock(r.scheduledAt)}$more', const NotificationDetails(android: _rides, iOS: _ios));
  }

  @override
  void offer(Offer o) {
    _show(100000 + o.id, '🚐 Ride offer: ${o.customerName}',
        '${typeLabel[o.type]} ${clock(o.scheduledAt)} · ${o.address}. Open the app to take it.', const NotificationDetails(android: _offers, iOS: _ios));
  }

  Future<void> _show(int id, String title, String body, NotificationDetails d) async {
    try {
      await _init();
      await _n.show(id: id, title: title, body: body, notificationDetails: d);
    } catch (_) {/* never let a notification break the app */}
  }
}
