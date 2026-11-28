// Updating the app from the shuttle PC: "A new version is ready" → one tap downloads it and
// Android asks to install it. Shown only while off shift, so nobody's tapping it while driving.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ota_update/ota_update.dart';

import '../api.dart';
import '../driver.dart';

class UpdateBanner extends StatefulWidget {
  const UpdateBanner({super.key, required this.driver});
  final Driver driver;
  @override
  State<UpdateBanner> createState() => _UpdateBannerState();
}

class _UpdateBannerState extends State<UpdateBanner> {
  String? _note; // progress or a problem
  bool _working = false;
  StreamSubscription<OtaEvent>? _sub;

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _install(AppRelease r) {
    setState(() {
      _working = true;
      _note = 'Downloading…';
    });
    try {
      _sub?.cancel();
      _sub = OtaUpdate()
          .execute(r.url, destinationFilename: 'turas-driver.apk', sha256checksum: r.sha256)
          .listen((e) {
        if (!mounted) return;
        setState(() {
          switch (e.status) {
            case OtaStatus.DOWNLOADING:
              _note = 'Downloading… ${e.value ?? ''}%';
            case OtaStatus.INSTALLING:
            case OtaStatus.INSTALLATION_DONE:
              _working = false;
              _note = 'Tap Install on the next screen.';
            case OtaStatus.PERMISSION_NOT_GRANTED_ERROR:
              _working = false;
              _note = 'Allow Turas Driver to install updates (the switch Android just showed), then tap Update again.';
            case OtaStatus.CHECKSUM_ERROR:
              _working = false;
              _note = 'The download was damaged. Tap Update to try again.';
            default:
              _working = false;
              _note = 'The update didn’t download. Check your signal and try again.';
          }
        });
      }, onError: (Object _) {
        if (!mounted) return;
        setState(() {
          _working = false;
          _note = 'The update didn’t download. Try again.';
        });
      });
    } catch (_) {
      setState(() {
        _working = false;
        _note = 'The update didn’t start. Try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.driver;
    final r = d.update;
    if (r == null || d.me?.onDuty == true) return const SizedBox.shrink();
    return MaterialBanner(
      leading: const Icon(Icons.system_update_rounded),
      content: Text(_note ?? 'A new version of Turas Driver (${r.version}) is ready.'),
      actions: [FilledButton(onPressed: _working ? null : () => _install(r), child: const Text('Update'))],
    );
  }
}

/// The line on the Me tab: which version this is, and whether a newer one is waiting.
class VersionTile extends StatelessWidget {
  const VersionTile({super.key, required this.driver});
  final Driver driver;
  @override
  Widget build(BuildContext context) {
    final r = driver.update;
    return ListTile(
      leading: Icon(r != null ? Icons.system_update_rounded : Icons.verified_outlined),
      title: const Text('App version'),
      subtitle: Text(driver.build > 0 ? 'Build ${driver.build}${r != null ? ' · ${r.version} (build ${r.build}) is ready' : ' · up to date'}' : 'Test build'),
      trailing: driver.canUpdate && driver.build > 0 && r == null ? TextButton(onPressed: () => driver.checkForUpdate(now: true), child: const Text('Check')) : null,
    );
  }
}
