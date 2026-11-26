// A pretend shuttle for the screenshot demo (flutter build web --dart-define=DEMO=true).
// Made-up business, driver and customers. The tests use test/fake_server.dart (the same idea).
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'api.dart';
import 'store.dart';

class FakeShuttle {
  FakeShuttle({this.onDuty = false, this.role = 'driver'});
  bool onDuty;
  String role; // driver | admin | advisor
  int? vehicleId;
  bool signedIn = false;
  final List<String> calls = [];
  final List<Map<String, dynamic>> locations = [];
  Map<String, dynamic>? offer;
  final now = DateTime.now();

  late final List<Map<String, dynamic>> rides = [
    _ride(11, 'Riley Rider', 'pickup', 'assigned', '1520 Pearl St', driver: 7, inMin: 10, phone: '(555) 010-2000', notes: 'Silver Camry, by the side door'),
    _ride(12, 'Morgan Lee', 'dropoff', 'assigned', '88 Canyon Blvd', driver: 7, inMin: 35),
    _ride(13, 'Sam Ortiz', 'pickup', 'requested', '410 Baseline Rd', inMin: 20, urgent: true),
  ];

  Map<String, dynamic> _ride(int id, String name, String type, String status, String address,
          {int? driver, int inMin = 0, String? phone, String? notes, bool urgent = false}) =>
      {
        'id': id, 'customer_name': name, 'type': type, 'status': status, 'address': address, 'lat': 40.01, 'lng': -105.27,
        'scheduled_at': now.add(Duration(minutes: inMin)).toUtc().toIso8601String(), 'passengers': 1,
        'priority': urgent ? 'urgent' : 'normal', 'urgent_reason': urgent ? 'Flight at 3:10' : null, 'notes': notes,
        'driver_id': driver, 'driver_name': driver == null ? null : 'Dana Driver', 'arrived_at': null,
        'customer_phone': phone, 'distance_mi': 1.4,
      };

  late final MockClient client = MockClient((req) async {
    final path = req.url.path;
    calls.add('${req.method} $path');
    Map<String, dynamic> body() => req.body.isEmpty ? {} : jsonDecode(req.body) as Map<String, dynamic>;
    http.Response json(Object o, [int status = 200, Map<String, String> headers = const {}]) =>
        http.Response(jsonEncode(o), status, headers: {'content-type': 'application/json', ...headers});

    if (path == '/api/frontdoor/signin') {
      final b = body();
      if (b['email'] == 'dana@drivers.test' && b['password'] == 'drive-pass-1') {
        return json({'go': 'https://turaslubtha.com/pinevalley/auth/handoff?t=PASS'});
      }
      if (b['email'] == 'two@drivers.test') {
        return json({'choose': [
          {'name': 'Pine Valley Auto', 'url': 'https://turaslubtha.com/pinevalley/auth/handoff?t=A'},
          {'name': 'Lakeside Hotel', 'url': 'https://turaslubtha.com/lakeside/auth/handoff?t=B'},
        ]});
      }
      return json({'error': 'Email or password is incorrect.'}, 401);
    }
    if (path.endsWith('/auth/handoff')) {
      signedIn = true;
      return http.Response('', 302, headers: {'location': '/pinevalley/', 'set-cookie': 'sid=SECRET123; HttpOnly; SameSite=Lax; Path=/pinevalley; Max-Age=1209600; Secure'});
    }
    if (!path.startsWith('/pinevalley/') && !path.startsWith('/lakeside/')) return json({'error': 'Not found.'}, 404);
    if (req.headers['Cookie'] != 'sid=SECRET123' || !signedIn) return path.endsWith('/api/me') ? json({'user': null, 'settings': {}}) : json({'error': 'Please sign in.'}, 401);
    final api = path.substring(path.indexOf('/api/'));

    if (api == '/api/me') {
      return json({
        'user': {
          'id': 7, 'name': role == 'admin' ? 'Mia Manager' : role == 'advisor' ? 'Ava Advisor' : 'Dana Driver', 'role': role, 'roles': [role],
          // A manager can do everything; an advisor books and assigns; a driver drives.
          'can': role == 'admin' ? ['admin', 'advisor', 'driver'] : [role],
          'home': '/$role', 'on_duty': onDuty, 'vehicle_id': vehicleId,
        },
        'settings': {'dealer_name': 'Pine Valley Auto', 'place': 'dealership', 'dealer_lat': '40.02', 'dealer_lng': '-105.24', 'dealer_address': '2465 48th Ct', 'arrive_wait_min': '5', 'phone_calls': 'mine', 'phone_texts': 'mine'},
      });
    }
    if (api == '/api/logout') {
      signedIn = false;
      return json({'ok': true});
    }
    if (api == '/api/vehicles') {
      return json({'vehicles': [
        {'id': 1, 'name': 'Shuttle 1', 'status': 'available', 'use': 'shuttle', 'seats': 7},
        {'id': 2, 'name': 'Loaner Civic', 'status': 'available', 'use': 'loaner'},
      ]});
    }
    if (api == '/api/driver/shift') {
      final b = body();
      onDuty = b['on_duty'] == true;
      vehicleId = onDuty ? b['vehicle_id'] as int? : null;
      return json({'ok': true});
    }
    if (api == '/api/driver/location') {
      locations.add(body());
      return json({'ok': true});
    }
    if (api == '/api/rides' && req.method == 'GET') {
      final open = rides.where((r) => ['requested', 'assigned', 'en_route', 'onboard'].contains(r['status'])).toList();
      return json({'rides': open, 'queue': open.map((r) => r['id']).toList()});
    }
    if (api == '/api/offers/mine') return json({'offer': offer});
    if (api == '/api/geocode') {
      final q = req.url.queryParameters['q'] ?? '';
      return json({'results': q.toLowerCase().contains('pearl')
          ? [{'label': '1520 Pearl Street, Boulder, CO 80302', 'lat': 40.019, 'lng': -105.274}, {'label': '1520 Pearl Court, Lafayette, CO 80026', 'lat': 39.99, 'lng': -105.09}]
          : []});
    }
    if (api == '/api/advisors') return json({'advisors': [{'id': 7, 'name': 'Mia Manager'}, {'id': 9, 'name': 'Ava Advisor'}]});
    if (api == '/api/rides' && req.method == 'POST') {
      final b = body();
      if ((b['customer_name'] ?? '').toString().isEmpty) return json({'error': 'Customer name is required.'}, 400);
      final r = {...b, 'id': 20 + rides.length, 'status': 'requested', 'driver_id': null, 'track_url': 'https://turaslubtha.com/pinevalley/t/AB12CD34'};
      rides.add(r);
      return json({'ride': r, 'adjusted_to': null, 'wait_min': 0}, 201);
    }
    if (api == '/api/drivers') {
      return json({'drivers': [
        {'id': 7, 'name': 'Dana Driver', 'on_duty': true, 'vehicle_name': 'Shuttle 1', 'open_rides': 2, 'phone': '5550101', 'last_loc_at': DateTime.now().toUtc().toIso8601String()},
        {'id': 8, 'name': 'Sam Wheels', 'on_duty': false, 'open_rides': 0},
      ]});
    }
    final m = RegExp(r'^/api/rides/(\d+)(/arrived)?$').firstMatch(api);
    if (m != null) {
      final r = rides.firstWhere((x) => x['id'] == int.parse(m.group(1)!));
      final b = body();
      if (m.group(2) != null) {
        r['arrived_at'] = b['undo'] == true ? null : DateTime.now().toUtc().toIso8601String();
      } else {
        if (b.containsKey('driver_id')) {
          r['driver_id'] = b['driver_id'];
          r['driver_name'] = {7: 'Dana Driver', 8: 'Sam Wheels'}[b['driver_id']];
          r['status'] = b['driver_id'] == null ? 'requested' : 'assigned';
        }
        if (b['status'] != null) r['status'] = b['status'];
      }
      return json({'ride': r});
    }
    return json({'error': 'Not found.'}, 404);
  });
}

/// Keeps the session in memory instead of the phone's secure storage (tests and the demo).
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
