// The Desk, for managers, service advisors and BDC: every open ride, who's driving it, and the
// drivers. Give a ride to a driver, move it, take it off them, cancel it, call the customer.
// Everything else (booking, people, reports, settings) is in the full site, one tap away.
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../driver.dart';
import '../models.dart';
import '../steps.dart';
import 'ride.dart';
import 'theme.dart';

class DeskTab extends StatelessWidget {
  const DeskTab({super.key, required this.driver});
  final Driver driver;

  @override
  Widget build(BuildContext context) {
    final d = driver;
    final me = d.me!;
    final waiting = d.rides.waiting();
    final withDriver = d.rides.rides.where((r) => r.driverId != null).toList();
    final onShift = d.drivers.where((x) => x.onDuty).toList();
    final t = Theme.of(context).textTheme;
    return RefreshIndicator(
      onRefresh: () => d.refresh(quiet: true),
      child: ListView(padding: const EdgeInsets.all(14), children: [
        Row(children: [
          _Count(label: 'Waiting', value: waiting.length, color: waiting.isEmpty ? null : Colors.orange.shade700),
          const SizedBox(width: 8),
          _Count(label: 'With a driver', value: withDriver.length),
          const SizedBox(width: 8),
          _Count(label: 'On shift', value: onShift.length, color: teal),
        ]),
        const SizedBox(height: 12),
        FilledButton.tonalIcon(
          onPressed: () => openFullSite(context, d, me.home.isEmpty ? (me.isManager ? '/admin' : '/advisor') : me.home),
          icon: const Icon(Icons.open_in_new_rounded),
          label: Text(me.isManager ? 'Full manager site' : 'Full advisor desk'),
        ),
        const SizedBox(height: 4),
        Text('Book rides, people, reports and settings, already signed in.', textAlign: TextAlign.center, style: t.bodySmall),
        const SizedBox(height: 18),
        _Heading('WAITING FOR A DRIVER (${waiting.length})'),
        if (waiting.isEmpty) const _Empty('Every ride has a driver.'),
        for (final r in waiting) _DeskRide(driver: d, ride: r),
        const SizedBox(height: 14),
        _Heading('WITH A DRIVER (${withDriver.length})'),
        if (withDriver.isEmpty) const _Empty('No rides in progress.'),
        for (final r in withDriver) _DeskRide(driver: d, ride: r),
        const SizedBox(height: 14),
        _Heading('DRIVERS'),
        if (d.drivers.isEmpty) const _Empty('No drivers yet. Add them in the full site under People.'),
        for (final x in d.drivers)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              leading: Icon(x.onDuty ? Icons.circle : Icons.circle_outlined, size: 14, color: x.onDuty ? teal : null),
              title: Text(x.name, style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text([
                x.onDuty ? 'On shift${x.vehicleName != null ? ' · ${x.vehicleName}' : ''}' : 'Off shift',
                if (x.openRides > 0) '${x.openRides} ride${x.openRides == 1 ? '' : 's'}',
                if (x.onDuty && x.lastSeen != null) 'seen ${relative(x.lastSeen, DateTime.now())}',
              ].join(' · ')),
              trailing: (x.phone ?? '').isEmpty ? null : IconButton(tooltip: 'Call ${x.name.split(' ').first}', icon: const Icon(Icons.call_rounded), onPressed: () => callNumber(x.phone!)),
            ),
          ),
      ]),
    );
  }
}

class _Count extends StatelessWidget {
  const _Count({required this.label, required this.value, this.color});
  final String label;
  final int value;
  final Color? color;
  @override
  Widget build(BuildContext context) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
            child: Column(children: [
              Text('$value', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800, color: color)),
              Text(label, style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
            ]),
          ),
        ),
      );
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text, style: Theme.of(context).textTheme.labelLarge?.copyWith(letterSpacing: 1.2, fontWeight: FontWeight.w800)),
      );
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.fromLTRB(4, 0, 4, 8), child: Text(text, style: Theme.of(context).textTheme.bodyMedium));
}

class _DeskRide extends StatelessWidget {
  const _DeskRide({required this.driver, required this.ride});
  final Driver driver;
  final Ride ride;
  @override
  Widget build(BuildContext context) {
    final r = ride;
    final s = driver.me!.settings;
    final t = Theme.of(context).textTheme;
    final now = DateTime.now();
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => showDeskRide(context, driver, r),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(r.customerName, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800), overflow: TextOverflow.ellipsis)),
                  if (r.urgent) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.priority_high_rounded, color: Colors.red.shade700, size: 18)),
                ]),
                Text('${typeLabel[r.type]} · ${clock(r.scheduledAt)} (${relative(r.scheduledAt, now)}) · ${statusLabel[r.status]}', style: t.bodySmall),
                Text(routeLine(r, s), style: t.bodyMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                if (r.driverName != null) Text('🚐 ${r.driverName}', style: t.bodySmall),
              ]),
            ),
            if (r.driverId == null)
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                onPressed: driver.busy ? null : () => pickDriver(context, driver, r),
                child: const Text('Assign'),
              )
            else
              const Icon(Icons.chevron_right_rounded),
          ]),
        ),
      ),
    );
  }
}

/// Pick a driver for a ride: drivers on shift first.
Future<void> pickDriver(BuildContext context, Driver d, Ride r) async {
  final list = [...d.drivers]..sort((a, b) => a.onDuty == b.onDuty ? a.openRides.compareTo(b.openRides) : (a.onDuty ? -1 : 1));
  final pick = await showModalBottomSheet<int>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (c) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Who drives ${r.customerName}?', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          if (list.isEmpty) const Text('No drivers yet.'),
          for (final x in list)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(x.onDuty ? Icons.circle : Icons.circle_outlined, size: 14, color: x.onDuty ? teal : null),
              title: Text(x.name),
              subtitle: Text('${x.onDuty ? 'On shift${x.vehicleName != null ? ' · ${x.vehicleName}' : ''}' : 'Off shift'} · ${x.openRides} ride${x.openRides == 1 ? '' : 's'}'),
              trailing: x.id == r.driverId ? const Icon(Icons.check_rounded) : null,
              onTap: () => Navigator.pop(c, x.id),
            ),
        ]),
      ),
    ),
  );
  if (pick == null || pick == r.driverId || !context.mounted) return;
  final name = d.drivers.firstWhere((x) => x.id == pick).name;
  await tell(context, d.act(() => d.api.assign(r, pick)), ok: '${r.customerName} → $name');
}

/// A ride from the Desk: move it, take it off the driver, cancel it, call or text the customer.
Future<void> showDeskRide(BuildContext context, Driver d, Ride ride) => showModalBottomSheet(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (c) => ListenableBuilder(
        listenable: d,
        builder: (c, _) {
          final r = d.rides.rides.where((x) => x.id == ride.id).firstOrNull;
          if (r == null) return const Padding(padding: EdgeInsets.all(24), child: Text('This ride is finished or was cancelled.'));
          final s = d.me!.settings;
          final t = Theme.of(c).textTheme;
          return SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(r.customerName, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                Text('${typeLabel[r.type]} · ${clock(r.scheduledAt)} · ${statusLabel[r.status]}'),
                const SizedBox(height: 4),
                Text(routeLine(r, s), style: t.titleMedium),
                if ((r.notes ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(r.notes!)),
                const SizedBox(height: 10),
                Text(r.driverName == null ? 'No driver yet' : 'Driver: ${r.driverName}', style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: d.busy ? null : () => pickDriver(c, d, r),
                  icon: const Icon(Icons.airport_shuttle_rounded),
                  label: Text(r.driverId == null ? 'Assign a driver' : 'Move to another driver'),
                ),
                if (r.driverId != null && r.status == 'assigned') ...[
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: d.busy ? null : () => tell(c, d.act(() => d.api.assign(r, null)), ok: 'Back to waiting for a driver.'),
                    child: const Text('Take off the driver'),
                  ),
                ],
                if ((r.customerPhone ?? '').isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(child: OutlinedButton.icon(onPressed: () => callCustomer(c, d, r), icon: const Icon(Icons.call_rounded), label: const Text('Call'))),
                    const SizedBox(width: 8),
                    Expanded(child: OutlinedButton.icon(onPressed: () => textCustomer(c, d, r), icon: const Icon(Icons.sms_rounded), label: const Text('Text'))),
                  ]),
                ],
                const SizedBox(height: 8),
                TextButton(onPressed: () => cancelRide(c, d, r), child: Text('Cancel ride', style: TextStyle(color: Theme.of(c).colorScheme.error))),
              ]),
            ),
          );
        },
      ),
    );

/// The full website for this business, inside the app and already signed in.
Future<void> openFullSite(BuildContext context, Driver d, String path) async {
  final session = d.api.session;
  if (session == null) return;
  final uri = Uri.parse(d.api.pageUrl(path));
  final prefix = Uri.parse(session.base).path;
  await WebViewCookieManager().setCookie(WebViewCookie(name: 'sid', value: session.sid, domain: uri.host, path: prefix.isEmpty ? '/' : prefix));
  if (!context.mounted) return;
  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FullSiteScreen(url: uri, title: d.me?.settings.businessName ?? 'Turas Lúbtha')));
  d.refresh(quiet: true);
}

class FullSiteScreen extends StatefulWidget {
  const FullSiteScreen({super.key, required this.url, required this.title});
  final Uri url;
  final String title;
  @override
  State<FullSiteScreen> createState() => _FullSiteScreenState();
}

class _FullSiteScreenState extends State<FullSiteScreen> {
  late final WebViewController _web;
  int _progress = 0;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => mounted ? setState(() => _progress = p) : null,
        // Links to other sites (maps, phone, texts) open in their own apps.
        onNavigationRequest: (req) {
          final u = Uri.tryParse(req.url);
          if (u == null || u.host == widget.url.host) return NavigationDecision.navigate;
          openOutside(u);
          return NavigationDecision.prevent;
        },
      ))
      ..loadRequest(widget.url);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _web.canGoBack()) {
          await _web.goBack();
        } else if (context.mounted) {
          Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.title),
          actions: [IconButton(tooltip: 'Reload', onPressed: () => _web.reload(), icon: const Icon(Icons.refresh_rounded))],
          bottom: _progress < 100 ? PreferredSize(preferredSize: const Size.fromHeight(3), child: LinearProgressIndicator(value: _progress / 100)) : null,
        ),
        body: WebViewWidget(controller: _web),
      ),
    );
  }
}
