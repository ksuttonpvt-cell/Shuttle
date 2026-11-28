// Talking to the shuttle on turaslubtha.com.
//
// Signing in goes through the shared Turas Lúbtha sign-in: the email and password are checked
// in each business's own database, and a one-time pass signs this phone in to the driver's own
// business (turaslubtha.com/<business>). The session is kept in the phone's secure storage.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// The website every business lives under.
const String siteUrl = String.fromEnvironment('SITE_URL', defaultValue: 'https://turaslubtha.com');

class ApiError implements Exception {
  ApiError(this.message, {this.status = 0});
  final String message;
  final int status;
  bool get signedOut => status == 401;
  @override
  String toString() => message;
}

/// Where this phone is signed in: the business's address and its sign-in cookie.
class Session {
  const Session({required this.base, required this.sid});
  final String base; // e.g. https://turaslubtha.com/pinevalley
  final String sid;
  Map<String, String> toJson() => {'base': base, 'sid': sid};
  static Session? fromJson(Map<String, dynamic>? j) =>
      j == null || j['base'] == null || j['sid'] == null ? null : Session(base: j['base'] as String, sid: j['sid'] as String);
}

/// More than one business for this email: the driver picks one.
class BusinessChoice {
  const BusinessChoice(this.name, this.url);
  final String name;
  final String url;
}

class SignInResult {
  const SignInResult({this.session, this.choices = const []});
  final Session? session;
  final List<BusinessChoice> choices;
}

class Api {
  Api({http.Client? client, this.site = siteUrl}) : _http = client ?? http.Client();
  final http.Client _http;
  final String site;
  Session? session;

  static const _timeout = Duration(seconds: 20);

  // ---------- signing in ----------

  /// Email + password at the shared sign-in. Either signs straight in, or lists the businesses.
  Future<SignInResult> signIn(String email, String password) async {
    final res = await _send(() => _http.post(Uri.parse('$site/api/frontdoor/signin'),
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: jsonEncode({'email': email.trim(), 'password': password})));
    final data = _json(res);
    if (res.statusCode >= 400) throw ApiError(_errorOf(data, res.statusCode), status: res.statusCode);
    if (data['go'] is String) return SignInResult(session: await useHandoff(data['go'] as String));
    final list = (data['choose'] as List? ?? const [])
        .map((c) => BusinessChoice((c as Map)['name'] as String, c['url'] as String))
        .toList();
    if (list.isEmpty) throw ApiError('Something went wrong. Try again.');
    return SignInResult(choices: list);
  }

  /// Uses the one-time pass: the shuttle answers with its sign-in cookie and sends us on.
  Future<Session> useHandoff(String url) async {
    final uri = Uri.parse(url);
    final i = uri.path.indexOf('/auth/handoff');
    if (i < 0) throw ApiError('That sign-in link isn’t right.');
    final base = '${uri.scheme}://${uri.authority}${uri.path.substring(0, i)}';
    final req = http.Request('GET', uri)..followRedirects = false;
    final res = await _send(() async => http.Response.fromStream(await _http.send(req)));
    final location = res.headers['location'] ?? '';
    final sid = _sidFrom(res.headers['set-cookie']);
    if (sid == null || location.contains('expired')) throw ApiError('That sign-in ran out. Please sign in again.');
    final s = Session(base: base, sid: sid);
    session = s;
    return s;
  }

  static String? _sidFrom(String? setCookie) {
    if (setCookie == null) return null;
    final m = RegExp(r'(?:^|[,;\s])sid=([^;,\s]+)').firstMatch(setCookie);
    return m == null || m.group(1)!.isEmpty ? null : m.group(1);
  }

  Future<void> signOut() async {
    try {
      await post('/api/logout', {});
    } catch (_) {/* signing out anyway */}
    session = null;
  }

  // ---------- the driver's day ----------

  Future<Me> me() async {
    final d = await get('/api/me');
    if (d['user'] == null) throw ApiError('Please sign in.', status: 401);
    return Me.fromJson(d);
  }

  Future<RideList> rides() async => RideList.fromJson(await get('/api/rides?scope=open'));
  Future<List<Vehicle>> vehicles() async =>
      ((await get('/api/vehicles'))['vehicles'] as List).map((v) => Vehicle.fromJson(v as Map<String, dynamic>)).toList();
  Future<Offer?> offer() async {
    final o = (await get('/api/offers/mine'))['offer'];
    return o == null ? null : Offer.fromJson(o as Map<String, dynamic>);
  }

  Future<void> startShift(int vehicleId) => post('/api/driver/shift', {'on_duty': true, 'vehicle_id': vehicleId});
  Future<void> endShift() => post('/api/driver/shift', {'on_duty': false});
  Future<void> answerOffer(int id, bool take) => post('/api/offers/$id/${take ? 'accept' : 'decline'}', {});

  Future<void> take(Ride r, int myId) => patch('/api/rides/${r.id}', {'driver_id': myId});
  Future<void> giveBack(Ride r) => patch('/api/rides/${r.id}', {'driver_id': null});
  /// Booking: find an address (the shuttle asks the map service, with its own limits).
  Future<(List<FoundPlace>, String?)> findAddress(String text) async {
    final d = await get('/api/geocode?q=${Uri.encodeQueryComponent(text)}');
    final list = (d['results'] as List? ?? const [])
        .map((x) => x as Map<String, dynamic>)
        .map((x) => FoundPlace(x['label'].toString(), (x['lat'] as num).toDouble(), (x['lng'] as num).toDouble()))
        .toList();
    return (list, d['error'] as String?);
  }

  Future<List<Person>> advisors() async =>
      ((await get('/api/advisors'))['advisors'] as List).map((x) => Person((x as Map)['id'] as int, x['name'].toString())).toList();

  /// Book a ride (same checks as the website: service area, the drop-off wait, urgent needs a reason).
  Future<Booked> book(Map<String, dynamic> ride) async => Booked.fromJson(await post('/api/rides', ride));

  /// Desk: give a ride to a driver (or take it off them with null).
  Future<void> assign(Ride r, int? driverId) => patch('/api/rides/${r.id}', {'driver_id': driverId});
  Future<List<DriverInfo>> drivers() async =>
      ((await get('/api/drivers'))['drivers'] as List).map((d) => DriverInfo.fromJson(d as Map<String, dynamic>)).toList();

  /// The full website at this business, as this signed-in person (for the in-app manager site).
  String pageUrl(String path) => '${session!.base}$path';
  Future<void> setStatus(Ride r, String status) => patch('/api/rides/${r.id}', {'status': status});
  Future<void> arrived(Ride r, {bool undo = false}) => post('/api/rides/${r.id}/arrived', undo ? {'undo': true} : {});
  Future<void> cancel(Ride r, String reason) => patch('/api/rides/${r.id}', {'status': 'cancelled', 'cancel_reason': reason});
  Future<String> callThroughBusiness(Ride r) async => ((await post('/api/rides/${r.id}/call', {}))['message'] ?? 'Calling…').toString();
  Future<String> textThroughBusiness(Ride r, String body) async =>
      ((await post('/api/rides/${r.id}/text', {'body': body}))['message'] ?? 'Sent.').toString();

  Future<void> sendLocation({required double lat, required double lng, double? heading, double? speed, int? battery, bool charging = false}) =>
      post('/api/driver/location', {
        'lat': lat, 'lng': lng, 'heading': heading, 'speed': speed, 'battery': battery, 'charging': charging,
      });

  // ---------- plumbing ----------

  Map<String, String> get _headers {
    final s = session;
    if (s == null) throw ApiError('Please sign in.', status: 401);
    return {'Cookie': 'sid=${s.sid}', 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Turas-App': 'driver'};
  }

  Uri _url(String path) => Uri.parse('${session!.base}$path');

  /// Live updates from the shuttle (server-sent events): yields the name of each change
  /// ('rides', 'drivers', 'moved', 'hello'…). Ends or errors when the connection drops.
  Stream<String> events() {
    StreamSubscription<String>? sub;
    var gone = false;
    late final StreamController<String> out;
    void fail(Object e, [StackTrace? st]) {
      if (gone) return; // nobody listening any more (signed out, app closed)
      gone = true;
      out.addError(e, st);
      out.close();
    }

    out = StreamController<String>(
      onListen: () async {
        try {
          final req = http.Request('GET', _url('/api/events'));
          req.headers.addAll({..._headers, 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache'});
          final res = await _http.send(req).timeout(_timeout);
          if (gone) return;
          if (res.statusCode == 401) return fail(ApiError('Please sign in.', status: 401));
          if (res.statusCode != 200) return fail(ApiError('No live updates.', status: res.statusCode));
          var name = 'message';
          var hasData = false;
          // The shuttle sends a ping every 25 seconds; over a minute of silence means the line is dead.
          sub = res.stream.transform(utf8.decoder).transform(const LineSplitter()).timeout(const Duration(seconds: 70)).listen((line) {
            if (line.isEmpty) {
              if (hasData && !gone) out.add(name);
              name = 'message';
              hasData = false;
            } else if (line.startsWith('event:')) {
              name = line.substring(6).trim();
            } else if (line.startsWith('data:')) {
              hasData = true;
            }
          }, onError: fail, onDone: () {
            if (gone) return;
            gone = true;
            out.close();
          }, cancelOnError: true);
        } catch (e, st) {
          fail(e, st);
        }
      },
      onCancel: () {
        gone = true;
        return sub?.cancel();
      },
    );
    return out.stream;
  }

  Future<Map<String, dynamic>> get(String path) async => _check(await _send(() => _http.get(_url(path), headers: _headers)));
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async =>
      _check(await _send(() => _http.post(_url(path), headers: _headers, body: jsonEncode(body))));
  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic> body) async =>
      _check(await _send(() => _http.patch(_url(path), headers: _headers, body: jsonEncode(body))));

  Future<http.Response> _send(Future<http.Response> Function() go) async {
    try {
      return await go().timeout(_timeout);
    } on TimeoutException {
      throw ApiError('The shuttle server is taking too long. Check your signal and try again.');
    } on ApiError {
      rethrow;
    } catch (_) {
      throw ApiError("Can't reach the shuttle server. Check your internet connection.");
    }
  }

  Map<String, dynamic> _check(http.Response res) {
    final data = _json(res);
    if (res.statusCode >= 400) throw ApiError(_errorOf(data, res.statusCode), status: res.statusCode);
    return data;
  }

  static Map<String, dynamic> _json(http.Response res) {
    try {
      final d = jsonDecode(utf8.decode(res.bodyBytes));
      return d is Map<String, dynamic> ? d : {'data': d};
    } catch (_) {
      return {};
    }
  }

  static String _errorOf(Map<String, dynamic> d, int status) =>
      (d['error'] as String?) ??
      (status == 401 ? 'Please sign in again.' : status >= 500 ? 'The shuttle server had a problem. Try again.' : 'That didn’t work. Try again.');
}
