// The driver's live state: who's signed in, the rides, any ride offer, and the shift.
// Screens listen to this; it keeps itself fresh by asking the shuttle every few seconds.
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'models.dart';
import 'store.dart';
import 'tracker.dart';

enum Phase { starting, signedOut, notDriver, ready }

class Driver extends ChangeNotifier {
  Driver({Api? api, SessionStore? store, Tracker? tracker, this.alerts})
      : api = api ?? Api(),
        store = store ?? SessionStore(),
        tracker = tracker ?? Tracker.disabled();

  final Api api;
  final SessionStore store;
  final Tracker tracker;
  final Alerts? alerts;

  Phase phase = Phase.starting;
  Me? me;
  RideList rides = RideList(const []);
  Offer? offer;
  String? problem; // shown as a banner when the server can't be reached
  bool busy = false;
  DateTime? lastUpdate;

  Timer? _poll;
  final Set<String> _seen = {};
  bool _firstLoad = true;
  int? _lastOfferId;

  // ---------- starting, signing in and out ----------

  Future<void> start() async {
    final s = await store.load();
    if (s == null) return _set(Phase.signedOut);
    api.session = s;
    await refresh(quiet: true);
    _schedule();
  }

  Future<SignInResult> signIn(String email, String password) async {
    final r = await api.signIn(email, password);
    await store.saveEmail(email.trim());
    if (r.session != null) await _signedIn(r.session!);
    return r;
  }

  Future<void> pickBusiness(BusinessChoice c) async => _signedIn(await api.useHandoff(c.url));

  Future<void> _signedIn(Session s) async {
    await store.save(s);
    _firstLoad = true;
    _seen.clear();
    await refresh(quiet: true);
    _schedule();
  }

  Future<void> signOut() async {
    if (me?.onDuty == true) {
      try {
        await api.endShift();
      } catch (_) {/* signing out anyway */}
    }
    await tracker.stop();
    await api.signOut();
    await store.clear();
    _poll?.cancel();
    me = null;
    rides = RideList(const []);
    offer = null;
    _set(Phase.signedOut);
  }

  // ---------- keeping fresh ----------

  void _schedule() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 6), (_) => refresh(quiet: true));
  }

  Future<void> refresh({bool quiet = false}) async {
    if (api.session == null) return;
    try {
      final m = await api.me();
      me = m;
      if (!m.isDriver) {
        _set(Phase.notDriver);
        return;
      }
      final list = await api.rides();
      _noticeNew(list, m);
      rides = list;
      final o = m.onDuty ? await api.offer() : null;
      if (o != null && o.id != _lastOfferId) {
        _lastOfferId = o.id;
        alerts?.offer(o);
      }
      offer = o;
      problem = null;
      lastUpdate = DateTime.now();
      await _keepTracking(m);
      phase = Phase.ready;
      notifyListeners();
    } on ApiError catch (e) {
      if (e.signedOut) {
        await tracker.stop();
        await store.clear();
        api.session = null;
        _poll?.cancel();
        return _set(Phase.signedOut);
      }
      problem = e.message;
      if (phase == Phase.starting) phase = Phase.ready;
      notifyListeners();
      if (!quiet) rethrow;
    }
  }

  // A ride given to me, or a new ride waiting for a driver while I'm on shift: tell the driver.
  void _noticeNew(RideList list, Me m) {
    String key(Ride r) => '${r.id}:${r.driverId == m.id ? 'me' : 'open'}';
    final relevant = list.rides.where((r) => r.driverId == m.id || (r.driverId == null && m.onDuty));
    final fresh = relevant.where((r) => !_seen.contains(key(r))).toList();
    for (final r in relevant) {
      _seen.add(key(r));
    }
    if (_firstLoad) {
      _firstLoad = false;
      return;
    }
    if (fresh.isNotEmpty) alerts?.newRides(fresh, m.id);
  }

  Future<void> _keepTracking(Me m) async {
    if (m.onDuty) {
      await tracker.start(onPosition: (p) => api.sendLocation(lat: p.lat, lng: p.lng, heading: p.heading, speed: p.speed, battery: p.battery, charging: p.charging));
    } else {
      await tracker.stop();
    }
  }

  // ---------- doing things ----------

  /// Runs an action, then refreshes. Errors come back as text for a message.
  Future<String?> act(Future<void> Function() action) async {
    if (busy) return null;
    busy = true;
    notifyListeners();
    try {
      await action();
      await refresh(quiet: true);
      return null;
    } on ApiError catch (e) {
      if (e.signedOut) await refresh(quiet: true);
      return e.message;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<String?> startShift(int vehicleId) async {
    final ok = await tracker.ask();
    if (!ok) return 'Location is off for Turas Driver. Turn it on in your phone’s settings so the desk and customers can see the van.';
    await alerts?.ask();
    return act(() => api.startShift(vehicleId));
  }

  Future<String?> endShift() async {
    final r = await act(api.endShift);
    if (r == null) await tracker.stop();
    return r;
  }

  void _set(Phase p) {
    phase = p;
    notifyListeners();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }
}

/// Notifications on the phone (new rides, ride offers). Implemented in alerts.dart.
abstract class Alerts {
  Future<void> ask();
  void newRides(List<Ride> rides, int me);
  void offer(Offer o);
}
