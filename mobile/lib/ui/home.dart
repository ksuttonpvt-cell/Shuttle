import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../driver.dart';
import '../models.dart';
import '../steps.dart';
import 'desk.dart';
import 'ride.dart';
import 'theme.dart';
import 'update.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.driver, this.startTab = 0});
  final Driver driver;
  final int startTab;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late int _tab = widget.startTab;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Coming back to the app: get the latest right away.
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) widget.driver.refresh(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.driver;
    final me = d.me;
    if (me == null) return _CantReach(driver: d);
    final mineCount = d.rides.mine(me.id).length;
    final waitingCount = d.rides.waiting().length;
    // Drivers (and managers, who can drive): Today and Rides. Managers and advisors: the Desk.
    final tabs = <(Widget, NavigationDestination)>[
      if (me.canDrive) (TodayTab(driver: d), const NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today')),
      if (me.canDrive)
        (RidesTab(driver: d), NavigationDestination(icon: Badge(isLabelVisible: mineCount > 0, label: Text('$mineCount'), child: const Icon(Icons.list_alt_outlined)), selectedIcon: const Icon(Icons.list_alt), label: 'Rides')),
      if (me.canDesk)
        (DeskTab(driver: d), NavigationDestination(icon: Badge(isLabelVisible: waitingCount > 0, label: Text('$waitingCount'), child: const Icon(Icons.dashboard_outlined)), selectedIcon: const Icon(Icons.dashboard), label: 'Desk')),
      (MeTab(driver: d), const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Me')),
    ];
    final tab = _tab.clamp(0, tabs.length - 1);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(me.settings.businessName, style: const TextStyle(fontWeight: FontWeight.w800)),
          Text(me.canDrive ? (me.onDuty ? 'On shift' : 'Off shift') : me.roleName, style: TextStyle(fontSize: 13, color: me.onDuty ? teal : Theme.of(context).colorScheme.onSurfaceVariant, fontWeight: FontWeight.w600)),
        ]),
        actions: [IconButton(tooltip: 'Refresh', onPressed: () => d.refresh(quiet: true), icon: const Icon(Icons.refresh_rounded))],
      ),
      body: Column(children: [
        if (d.problem != null)
          MaterialBanner(
            content: Text(d.problem!),
            leading: const Icon(Icons.wifi_off_rounded),
            actions: [TextButton(onPressed: () => d.refresh(quiet: true), child: const Text('Try again'))],
          ),
        UpdateBanner(driver: d),
        Expanded(child: tabs[tab].$1),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [for (final t in tabs) t.$2],
      ),
    );
  }
}

class _CantReach extends StatelessWidget {
  const _CantReach({required this.driver});
  final Driver driver;
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const BrandMark(size: 26, sub: 'Driver'),
              const SizedBox(height: 28),
              Text(driver.problem ?? 'Connecting…', textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton(onPressed: () => driver.refresh(quiet: true), child: const Text('Try again')),
              TextButton(onPressed: driver.signOut, child: const Text('Sign out')),
            ]),
          ),
        ),
      );
}

// ---------- Today ----------

class TodayTab extends StatelessWidget {
  const TodayTab({super.key, required this.driver});
  final Driver driver;
  @override
  Widget build(BuildContext context) {
    final d = driver;
    final me = d.me!;
    final next = nextRide(d.rides, me.id, onDuty: me.onDuty);
    final mine = d.rides.mine(me.id);
    return RefreshIndicator(
      onRefresh: () => d.refresh(quiet: true),
      child: ListView(padding: const EdgeInsets.all(14), children: [
        if (!me.onDuty) StartShiftCard(driver: d),
        if (d.offer != null) ...[OfferCard(driver: d, offer: d.offer!), const SizedBox(height: 12)],
        if (me.onDuty && next != null) NextStopCard(key: ValueKey(next.id), driver: d, ride: next),
        if (me.onDuty && next == null)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(children: [
                Icon(Icons.check_circle_outline_rounded, size: 48, color: teal),
                const SizedBox(height: 8),
                Text('No rides right now', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 4),
                const Text('New rides show up here, and your phone buzzes.', textAlign: TextAlign.center),
              ]),
            ),
          ),
        if (me.onDuty && mine.length > 1) ...[
          const SizedBox(height: 18),
          Text('AFTER THAT', style: Theme.of(context).textTheme.labelLarge?.copyWith(letterSpacing: 1.2, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          for (final r in mine.where((r) => r.id != next?.id)) Padding(padding: const EdgeInsets.only(bottom: 8), child: RideTile(driver: d, ride: r)),
        ],
        const SizedBox(height: 18),
        const SafetyNote(),
      ]),
    );
  }
}

class SafetyNote extends StatelessWidget {
  const SafetyNote({super.key});
  @override
  Widget build(BuildContext context) => Text(
        'Pull over before you tap. Navigation and the van’s location keep working while you drive.',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      );
}

class StartShiftCard extends StatefulWidget {
  const StartShiftCard({super.key, required this.driver});
  final Driver driver;
  @override
  State<StartShiftCard> createState() => _StartShiftCardState();
}

class _StartShiftCardState extends State<StartShiftCard> {
  List<Vehicle>? _vans;
  int? _pick;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final all = await widget.driver.api.vehicles();
      final vans = all.where((v) => v.usable).toList();
      if (!mounted) return;
      setState(() {
        _vans = vans;
        final free = vans.where((v) => v.driverId == null || v.driverId == widget.driver.me?.id);
        _pick = widget.driver.me?.vehicleId ?? (free.length == 1 ? free.first.id : null);
      });
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.driver;
    final t = Theme.of(context).textTheme;
    final vans = _vans;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Start your shift', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          const Text("Pick the van you're driving. New rides come to you once you're on shift."),
          const SizedBox(height: 16),
          if (_error != null) Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (vans == null && _error == null) const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator())),
          if (vans != null && vans.isEmpty) const Text('No vans are set up yet. Ask a manager to add one.'),
          if (vans != null && vans.isNotEmpty)
            DropdownButtonFormField<int>(
              initialValue: _pick,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Van'),
              items: [
                for (final v in vans)
                  DropdownMenuItem(
                    value: v.id,
                    enabled: v.driverId == null || v.driverId == d.me!.id,
                    child: Text('${v.name}${v.seats != null ? ' · ${v.seats} seats' : ''}${v.driverName != null && v.driverId != d.me!.id ? ' · ${v.driverName} has it' : ''}'),
                  ),
              ],
              onChanged: (v) => setState(() => _pick = v),
            ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: d.busy || _pick == null ? null : () => tell(context, d.startShift(_pick!)),
            icon: const Icon(Icons.play_arrow_rounded),
            label: const Text('Start shift'),
          ),
          const SizedBox(height: 8),
          Text('While you’re on shift, the app shares the van’s location with the desk and your customers, even with the screen off. It stops when you end your shift.', style: t.bodySmall),
        ]),
      ),
    );
  }
}

// ---------- Rides ----------

class RidesTab extends StatefulWidget {
  const RidesTab({super.key, required this.driver});
  final Driver driver;
  @override
  State<RidesTab> createState() => _RidesTabState();
}

class _RidesTabState extends State<RidesTab> {
  bool _mine = true;
  @override
  Widget build(BuildContext context) {
    final d = widget.driver;
    final me = d.me!;
    final list = _mine ? d.rides.mine(me.id) : d.rides.waiting();
    return RefreshIndicator(
      onRefresh: () => d.refresh(quiet: true),
      child: ListView(padding: const EdgeInsets.all(14), children: [
        SegmentedButton<bool>(
          segments: [
            ButtonSegment(value: true, label: Text('My rides (${d.rides.mine(me.id).length})')),
            ButtonSegment(value: false, label: Text('Waiting (${d.rides.waiting().length})')),
          ],
          selected: {_mine},
          onSelectionChanged: (s) => setState(() => _mine = s.first),
        ),
        const SizedBox(height: 12),
        if (list.isEmpty)
          Padding(
            padding: const EdgeInsets.all(32),
            child: Text(_mine ? 'No rides assigned to you.' : 'No rides are waiting for a driver.', textAlign: TextAlign.center),
          ),
        for (final r in list) Padding(padding: const EdgeInsets.only(bottom: 8), child: RideTile(driver: d, ride: r)),
      ]),
    );
  }
}

// ---------- Me ----------

class MeTab extends StatelessWidget {
  const MeTab({super.key, required this.driver});
  final Driver driver;
  @override
  Widget build(BuildContext context) {
    final d = driver;
    final me = d.me!;
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(14), children: [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(me.name, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            Text('${me.roleName} · ${me.settings.businessName}'),
            const SizedBox(height: 12),
            Row(children: [
              Icon(me.onDuty ? Icons.circle : Icons.circle_outlined, size: 12, color: me.onDuty ? teal : null),
              const SizedBox(width: 8),
              Text(me.onDuty ? 'On shift' : 'Off shift', style: const TextStyle(fontWeight: FontWeight.w700)),
            ]),
            if (me.onDuty) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: d.busy
                    ? null
                    : () async {
                        final mine = d.rides.mine(me.id).where((r) => r.status == 'onboard').isNotEmpty;
                        final ok = await showDialog<bool>(
                          context: context,
                          builder: (c) => AlertDialog(
                            title: const Text('End your shift?'),
                            content: Text(mine ? 'You still have a customer on board. Finish that ride first, or a manager will need to.' : 'You’ll stop getting rides, and the van’s location stops being shared.'),
                            actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Stay on shift')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('End shift'))],
                          ),
                        );
                        if (ok == true && context.mounted) await tell(context, d.endShift(), ok: 'Shift ended. Thanks!');
                      },
                icon: const Icon(Icons.stop_rounded),
                label: const Text('End shift'),
              ),
            ],
          ]),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: Column(children: [
          ListTile(
            leading: Icon(d.tracker.running ? Icons.location_on_rounded : Icons.location_off_outlined, color: d.tracker.running ? teal : null),
            title: const Text('Van location'),
            subtitle: Text(d.tracker.status ?? (d.tracker.running ? 'Sharing while you’re on shift' : 'Off: starts with your shift')),
            trailing: d.tracker.status != null ? TextButton(onPressed: Geolocator.openAppSettings, child: const Text('Settings')) : null,
          ),
          const Divider(height: 1),
          ListTile(
            leading: const Icon(Icons.update_rounded),
            title: const Text('Last update'),
            subtitle: Text(d.lastUpdate == null ? '—' : clock(d.lastUpdate)),
          ),
          const Divider(height: 1),
          VersionTile(driver: d),
        ]),
      ),
      const SizedBox(height: 12),
      OutlinedButton.icon(onPressed: d.signOut, icon: const Icon(Icons.logout_rounded), label: const Text('Sign out')),
      const SizedBox(height: 24),
      const Center(child: BrandMark(size: 16, sub: 'Driver')),
    ]);
  }
}
