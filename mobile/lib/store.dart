import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';

/// Keeps the session in the phone's secure storage (Keychain / Keystore).
class SessionStore {
  SessionStore([FlutterSecureStorage? storage]) : _s = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  static const _key = 'session';
  Future<Session?> load() async {
    try {
      final raw = await _s.read(key: _key);
      return raw == null ? null : Session.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(Session s) => _s.write(key: _key, value: jsonEncode(s.toJson()));
  Future<void> clear() => _s.delete(key: _key);
  Future<String?> lastEmail() => _s.read(key: 'email');
  Future<void> saveEmail(String e) => _s.write(key: 'email', value: e);
}

