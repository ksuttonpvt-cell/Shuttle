import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../driver.dart';
import '../models.dart';
import '../steps.dart';
import 'theme.dart';

void say(BuildContext context, String? message) {
  if (message == null || !context.mounted) return;
  _show(ScaffoldMessenger.of(context), message);
}

void _show(ScaffoldMessengerState m, String message) => m
  ..hideCurrentSnackBar()
  ..showSnackBar(SnackBar(content: Text(message), behavior: SnackBarBehavior.floating));

/// Waits for an action and shows its problem (or [ok]) as a message.
Future<void> tell(BuildContext context, Future<String?> work, {String? ok}) async {
  final m = ScaffoldMessenger.of(context);
  final text = await work ?? ok;
  if (text != null) _show(m, text);
}

/// Runs the main step for a ride (Take / On my way / I'm here / On board / Complete).
Future<void> doStep(BuildContext context, Driver d, Ride r) async {
  final m = ScaffoldMessenger.of(context);
  final me = d.me!;
  final step = mainStep(r, me.id);
  String? err;
  switch (step.kind) {
    case StepKind.take:
      err = await d.act(() => d.api.take(r, me.id));
    case StepKind.onMyWay:
      err = await d.act(() => d.api.setStatus(r, 'en_route'));
    case StepKind.imHere:
      err = await d.act(() => d.api.arrived(r));
    case StepKind.onBoard:
      err = await d.act(() => d.api.setStatus(r, 'onboard'));
    case StepKind.complete:
      err = await d.act(() => d.api.setStatus(r, 'completed')) ;
      err ??= 'Ride complete. Nice work!';
    case StepKind.none:
      break;
  }
  if (err != null) _show(m, err);
}

Future<void> navigate(BuildContext context, Ride r, Settings s) async {
  final p = nextPlace(r, s);
  if (p.lat == null && p.address.trim().isEmpty) return say(context, 'This ride has no address to navigate to.');
  final m = ScaffoldMessenger.of(context);
  final ok = await launchUrl(directionsUrl(p), mode: LaunchMode.externalApplication);
  if (!ok) _show(m, 'Couldn’t open maps.');
}

Future<void> callCustomer(BuildContext context, Driver d, Ride r) async {
  final phone = r.customerPhone;
  if (phone == null || phone.isEmpty) return;
  if (d.me!.settings.callsThroughBusiness) {
    // The business's phone calls the driver, then connects the customer (the customer sees the business number).
    final m = ScaffoldMessenger.of(context);
    try {
      _show(m, await d.api.callThroughBusiness(r));
    } catch (e) {
      _show(m, e.toString());
    }
    return;
  }
  await launchUrl(Uri(scheme: 'tel', path: digits(phone)));
}

Future<void> textCustomer(BuildContext context, Driver d, Ride r) async {
  final phone = r.customerPhone;
  if (phone == null || phone.isEmpty) return;
  if (!d.me!.settings.textsThroughBusiness) {
    await launchUrl(Uri(scheme: 'sms', path: digits(phone)));
    return;
  }
  final ctl = TextEditingController();
  final send = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (c) => Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(c).viewInsets.bottom + 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Text ${r.firstName}', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        const Text('Sent from the business number, signed with your first name.'),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final q in const ["I'm on my way.", "I'm about 5 minutes away.", "I'm here, out front.", 'Your car is ready.'])
            ActionChip(label: Text(q), onPressed: () => Navigator.pop(c, q)),
        ]),
        const SizedBox(height: 12),
        TextField(controller: ctl, maxLength: 480, minLines: 2, maxLines: 4, decoration: const InputDecoration(hintText: 'Or type a message')),
        FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Send')),
      ]),
    ),
  );
  if (send == null || send.isEmpty || !context.mounted) return;
  final m = ScaffoldMessenger.of(context);
  try {
    _show(m, await d.api.textThroughBusiness(r, send));
  } catch (e) {
    _show(m, e.toString());
  }
}

Future<void> cancelRide(BuildContext context, Driver d, Ride r) async {
  String pick = cancelReasons.first;
  final details = TextEditingController();
  final reason = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (c) => StatefulBuilder(
      builder: (c, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(c).viewInsets.bottom + 20),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Cancel ride for ${r.customerName}?', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            RadioGroup<String>(
              groupValue: pick,
              onChanged: (v) => set(() => pick = v ?? pick),
              child: Column(children: [for (final x in cancelReasons) RadioListTile<String>(value: x, title: Text(x), contentPadding: EdgeInsets.zero, dense: true)]),
            ),
            TextField(controller: details, maxLength: 400, decoration: InputDecoration(labelText: pick == 'Other' ? 'What happened? (required)' : 'Details (optional)')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Theme.of(c).colorScheme.error),
              onPressed: () {
                final text = details.text.trim();
                if (pick == 'Other' && text.length < 3) return;
                Navigator.pop(c, text.isEmpty ? pick : (pick == 'Other' ? text : '$pick: $text'));
              },
              child: const Text('Cancel ride'),
            ),
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Keep ride')),
          ]),
        ),
      ),
    ),
  );
  if (reason == null || !context.mounted) return;
  await tell(context, d.act(() => d.api.cancel(r, reason)), ok: 'Ride cancelled.');
}

Future<void> noShow(BuildContext context, Driver d, Ride r) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text("Customer didn't come out?"),
      content: Text('The ride for ${r.customerName} is cancelled as a no-show, with how long you waited.'),
      actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep waiting')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Mark no-show'))],
    ),
  );
  if (ok != true || !context.mounted) return;
  await tell(context, d.act(() => d.api.cancel(r, noShowReason(r, DateTime.now()))), ok: 'Marked as a no-show.');
}

/// The big card on Today: who, where, and one big button for the next step.
class NextStopCard extends StatefulWidget {
  const NextStopCard({super.key, required this.driver, required this.ride});
  final Driver driver;
  final Ride ride;
  @override
  State<NextStopCard> createState() => _NextStopCardState();
}

class _NextStopCardState extends State<NextStopCard> {
  Timer? _tick;
  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.ride.arrivedAt != null) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.driver;
    final r = widget.ride;
    final me = d.me!;
    final s = me.settings;
    final now = DateTime.now();
    final step = mainStep(r, me.id);
    final here = isHere(r, me.id);
    final mine = isMine(r, me.id);
    final t = Theme.of(context).textTheme;
    final place = nextPlace(r, s);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Text(mine ? 'NEXT STOP' : 'A RIDE IS WAITING', style: t.labelLarge?.copyWith(letterSpacing: 1.2, fontWeight: FontWeight.w800, color: Theme.of(context).colorScheme.primary)),
            const SizedBox(width: 8),
            Expanded(child: Text('Due ${clock(r.scheduledAt)} · ${relative(r.scheduledAt, now)}', style: t.bodySmall, textAlign: TextAlign.end, overflow: TextOverflow.ellipsis)),
          ]),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: [
            Chip(label: Text(typeLabel[r.type] ?? r.type), visualDensity: VisualDensity.compact),
            Chip(label: Text(statusLabel[r.status] ?? r.status), visualDensity: VisualDensity.compact),
            if (r.urgent) Chip(label: const Text('Urgent'), backgroundColor: Colors.red.shade700, labelStyle: const TextStyle(color: Colors.white), visualDensity: VisualDensity.compact),
          ]),
          const SizedBox(height: 8),
          Text(r.customerName, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text(routeLine(r, s), style: t.titleMedium),
          const SizedBox(height: 4),
          Text('${r.passengers} passenger${r.passengers == 1 ? '' : 's'}${r.distanceMi != null ? ' · ${r.distanceMi} mi from you' : ''}', style: t.bodyMedium),
          if (r.urgent && (r.urgentReason ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Urgent: ${r.urgentReason}', style: TextStyle(color: Colors.red.shade700, fontWeight: FontWeight.w700))),
          if ((r.notes ?? '').isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(10)),
              child: Text(r.notes!),
            ),
          if (here)
            Container(
              margin: const EdgeInsets.only(top: 12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: teal.withValues(alpha: .12), borderRadius: BorderRadius.circular(12), border: Border.all(color: teal.withValues(alpha: .4))),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text("You're here · waiting ${waited(r.arrivedAt!, now)}", style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(r.customerReply == null ? "We told the customer you're here." : (r.customerReply == 'coming' ? 'Customer is coming out' : 'Customer needs 5 more minutes')),
              ]),
            ),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(child: OutlinedButton.icon(onPressed: () => navigate(context, r, s), icon: const Icon(Icons.navigation_rounded), label: Text(place.toBusiness ? 'To the ${s.place}' : 'Navigate'))),
            if ((r.customerPhone ?? '').isNotEmpty) ...[
              const SizedBox(width: 8),
              IconButton.outlined(tooltip: 'Call', onPressed: () => callCustomer(context, d, r), icon: const Icon(Icons.call_rounded)),
              const SizedBox(width: 4),
              IconButton.outlined(tooltip: 'Text', onPressed: () => textCustomer(context, d, r), icon: const Icon(Icons.sms_rounded)),
            ],
          ]),
          if (step.kind != StepKind.none) ...[
            const SizedBox(height: 14),
            FilledButton(
              onPressed: d.busy ? null : () => doStep(context, d, r),
              style: step.kind == StepKind.complete ? FilledButton.styleFrom(backgroundColor: teal, minimumSize: const Size.fromHeight(64)) : FilledButton.styleFrom(minimumSize: const Size.fromHeight(64)),
              child: Text(step.label),
            ),
            if (step.then.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(step.then, textAlign: TextAlign.center, style: t.bodySmall)),
          ],
          const SizedBox(height: 4),
          Wrap(alignment: WrapAlignment.center, spacing: 4, children: [
            if (mine && r.status == 'assigned' && !here) TextButton(onPressed: () => tell(context, d.act(() => d.api.arrived(r))), child: const Text("I'm already here")),
            if (mine && r.status == 'en_route' && !here) TextButton(onPressed: () => tell(context, d.act(() => d.api.setStatus(r, 'onboard'))), child: const Text('Customer is on board')),
            if (here && canNoShow(r, s, now)) TextButton(onPressed: () => noShow(context, d, r), child: const Text("Customer didn't come out")),
            if (here) TextButton(onPressed: () => tell(context, d.act(() => d.api.arrived(r, undo: true))), child: const Text('Not here yet')),
            if (mine && r.status == 'assigned') TextButton(onPressed: () => tell(context, d.act(() => d.api.giveBack(r))), child: const Text('Give back')),
            if (mine) TextButton(onPressed: () => cancelRide(context, d, r), child: Text('Cancel ride', style: TextStyle(color: Theme.of(context).colorScheme.error))),
          ]),
        ]),
      ),
    );
  }
}

/// A ride in a list. Tap for the full card.
class RideTile extends StatelessWidget {
  const RideTile({super.key, required this.driver, required this.ride});
  final Driver driver;
  final Ride ride;
  @override
  Widget build(BuildContext context) {
    final r = ride;
    final s = driver.me!.settings;
    final now = DateTime.now();
    final t = Theme.of(context).textTheme;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: () => showModalBottomSheet(
          context: context,
          isScrollControlled: true,
          showDragHandle: true,
          builder: (c) => ListenableBuilder(
            listenable: driver,
            builder: (c, _) {
              final fresh = driver.rides.rides.where((x) => x.id == r.id).firstOrNull;
              if (fresh == null) return const Padding(padding: EdgeInsets.all(24), child: Text('This ride is finished or was cancelled.'));
              return SingleChildScrollView(padding: const EdgeInsets.fromLTRB(12, 0, 12, 24), child: NextStopCard(driver: driver, ride: fresh));
            },
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(children: [
            if (r.rank != null)
              CircleAvatar(radius: 15, backgroundColor: r.rank == 1 ? purple : Theme.of(context).colorScheme.surfaceContainerHighest, child: Text('${r.rank}', style: TextStyle(fontWeight: FontWeight.w800, color: r.rank == 1 ? Colors.white : null))),
            if (r.rank != null) const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(r.customerName, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800), overflow: TextOverflow.ellipsis)),
                  if (r.urgent) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(Icons.priority_high_rounded, color: Colors.red.shade700, size: 18)),
                ]),
                const SizedBox(height: 2),
                Text('${typeLabel[r.type]} · ${clock(r.scheduledAt)} (${relative(r.scheduledAt, now)}) · ${statusLabel[r.status]}', style: t.bodySmall),
                Text(routeLine(r, s), style: t.bodyMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                if (r.driverName != null && r.driverId != driver.me!.id) Text('Driver: ${r.driverName}', style: t.bodySmall),
              ]),
            ),
            const Icon(Icons.chevron_right_rounded),
          ]),
        ),
      ),
    );
  }
}

/// A ride offered to this driver, with a countdown.
class OfferCard extends StatefulWidget {
  const OfferCard({super.key, required this.driver, required this.offer});
  final Driver driver;
  final Offer offer;
  @override
  State<OfferCard> createState() => _OfferCardState();
}

class _OfferCardState extends State<OfferCard> {
  Timer? _tick;
  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => mounted ? setState(() {}) : null);
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.offer;
    final d = widget.driver;
    final left = o.secondsNow;
    final t = Theme.of(context).textTheme;
    return Card(
      color: purple,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: DefaultTextStyle(
          style: const TextStyle(color: Colors.white),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              const Text('RIDE OFFER', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2, color: Colors.white)),
              const Spacer(),
              Text(left > 0 ? '${left}s left' : 'Ending…', style: const TextStyle(fontWeight: FontWeight.w700, color: Colors.white)),
            ]),
            const SizedBox(height: 6),
            Text(o.customerName, style: t.headlineSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
            Text('${typeLabel[o.type]} · ${clock(o.scheduledAt)} · ${o.passengers} passenger${o.passengers == 1 ? '' : 's'}', style: const TextStyle(color: Colors.white)),
            Text(o.address, style: const TextStyle(color: Colors.white70)),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white54), minimumSize: const Size(0, 56)),
                  onPressed: d.busy ? null : () => tell(context, d.act(() => d.api.answerOffer(o.id, false))),
                  child: const Text('No thanks'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: neon, foregroundColor: night),
                  onPressed: d.busy || left <= 0 ? null : () => tell(context, d.act(() => d.api.answerOffer(o.id, true)), ok: 'It’s yours.'),
                  child: const Text('Take it'),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}
