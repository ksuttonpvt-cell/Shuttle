// Book a ride, for managers, service advisors and BDC: the same booking as the website, made for
// a phone. Pick up or drop off, the customer, where (address search), when, a few details, then
// text the customer their tracking link.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api.dart';
import '../driver.dart';
import '../models.dart';
import '../steps.dart';
import 'theme.dart';

Future<void> openBooking(BuildContext context, Driver d) async {
  final booked = await Navigator.of(context).push<Booked>(MaterialPageRoute(builder: (_) => BookScreen(driver: d), fullscreenDialog: true));
  if (booked == null || !context.mounted) return;
  await d.refresh(quiet: true);
  if (context.mounted) await showBooked(context, d, booked);
}

class BookScreen extends StatefulWidget {
  const BookScreen({super.key, required this.driver});
  final Driver driver;
  @override
  State<BookScreen> createState() => _BookScreenState();
}

enum When { now, in15, in30, in60, pick }

class _BookScreenState extends State<BookScreen> {
  String _type = 'pickup';
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _address = TextEditingController();
  final _notes = TextEditingController();
  final _why = TextEditingController();
  FoundPlace? _place;
  List<FoundPlace> _results = const [];
  String? _searchNote;
  bool _searching = false;
  Timer? _debounce;
  When _when = When.now;
  DateTime? _picked;
  int _passengers = 1;
  bool _urgent = false;
  List<Person>? _advisors;
  int? _advisorId;
  bool _sending = false;
  String? _error;

  Me get _me => widget.driver.me!;
  bool get _isBdc => _me.roles.contains('bdc') && !_me.isManager;

  @override
  void initState() {
    super.initState();
    // BDC must say whose customer it is; managers may.
    if (_isBdc || _me.isManager) {
      widget.driver.api.advisors().then((a) {
        if (mounted) setState(() => _advisors = a);
      }).catchError((_) {});
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    for (final c in [_name, _phone, _email, _address, _notes, _why]) {
      c.dispose();
    }
    super.dispose();
  }

  void _typed(String text) {
    _place = null;
    _debounce?.cancel();
    if (text.trim().length < 4) {
      setState(() => _results = const []);
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 450), () async {
      setState(() => _searching = true);
      try {
        final (list, note) = await widget.driver.api.findAddress(text.trim());
        if (!mounted || _address.text != text) return;
        setState(() {
          _results = list.take(5).toList();
          // (The server's own note mentions its map; here there's no map to tap.)
          _searchNote = note != null ? 'Address search isn’t answering right now. You can still book it as typed.' : (list.isEmpty ? 'No match yet. Keep typing, or book it as typed.' : null);
        });
      } catch (_) {
        if (mounted) setState(() => _searchNote = 'Address search isn’t answering. You can still book it as typed.');
      } finally {
        if (mounted) setState(() => _searching = false);
      }
    });
  }

  DateTime _time() {
    final now = DateTime.now();
    switch (_when) {
      case When.now:
        return now;
      case When.in15:
        return now.add(const Duration(minutes: 15));
      case When.in30:
        return now.add(const Duration(minutes: 30));
      case When.in60:
        return now.add(const Duration(hours: 1));
      case When.pick:
        return _picked ?? now;
    }
  }

  Future<void> _pickTime() async {
    final now = DateTime.now();
    final day = await showDatePicker(context: context, firstDate: DateTime(now.year, now.month, now.day), lastDate: now.add(const Duration(days: 60)), initialDate: _picked ?? now);
    if (day == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_picked ?? now.add(const Duration(minutes: 30))));
    if (t == null) return;
    setState(() {
      _picked = DateTime(day.year, day.month, day.day, t.hour, t.minute);
      _when = When.pick;
    });
  }

  Future<void> _book() async {
    final name = _name.text.trim();
    final address = _address.text.trim();
    String? problem;
    if (name.isEmpty) {
      problem = 'Enter the customer’s name.';
    } else if (address.isEmpty) {
      problem = 'Enter where to pick up or drop off.';
    } else if (_urgent && _why.text.trim().isEmpty) {
      problem = 'Say why it’s urgent, so everyone knows why it jumped the line.';
    } else if (_isBdc && _advisorId == null) {
      problem = 'Pick the service advisor this customer is with.';
    } else if (_when == When.pick && _picked == null) {
      problem = 'Pick a date and time.';
    }
    if (problem != null) return setState(() => _error = problem);
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final booked = await widget.driver.api.book({
        'type': _type,
        'customer_name': name,
        if (_phone.text.trim().isNotEmpty) 'customer_phone': _phone.text.trim(),
        if (_email.text.trim().isNotEmpty) 'customer_email': _email.text.trim(),
        'address': _place?.label ?? address,
        if (_place != null) 'lat': _place!.lat,
        if (_place != null) 'lng': _place!.lng,
        'scheduled_at': _time().toUtc().toIso8601String(),
        'passengers': _passengers,
        if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
        'priority': _urgent ? 'urgent' : 'normal',
        if (_urgent) 'urgent_reason': _why.text.trim(),
        if (_advisorId != null) 'advisor_id': _advisorId,
      });
      if (mounted) Navigator.of(context).pop(booked);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _me.settings;
    final t = Theme.of(context).textTheme;
    final pickup = _type == 'pickup';
    final wait = !pickup && !_urgent && s.dropoffWaitMin > 0;
    Widget section(String text) => Padding(padding: const EdgeInsets.fromLTRB(0, 20, 0, 8), child: Text(text, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)));
    return Scaffold(
      appBar: AppBar(title: const Text('Book a ride')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'pickup', label: Text('Pick up'), icon: Icon(Icons.login_rounded)),
              ButtonSegment(value: 'dropoff', label: Text('Drop off'), icon: Icon(Icons.logout_rounded)),
            ],
            selected: {_type},
            onSelectionChanged: (v) => setState(() => _type = v.first),
          ),
          const SizedBox(height: 6),
          Text(pickup ? 'Bring the customer to the ${s.place}.' : 'Take the customer from the ${s.place}.', style: t.bodySmall, textAlign: TextAlign.center),

          section('Customer'),
          TextField(controller: _name, textCapitalization: TextCapitalization.words, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Name *')),
          const SizedBox(height: 10),
          TextField(controller: _phone, keyboardType: TextInputType.phone, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Mobile phone', helperText: 'For their tracking link and “your shuttle is here” texts')),
          const SizedBox(height: 10),
          TextField(controller: _email, keyboardType: TextInputType.emailAddress, autocorrect: false, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Email (optional)')),

          section(pickup ? 'Pick up from' : 'Drop off at'),
          TextField(
            controller: _address,
            onChanged: _typed,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              labelText: 'Address *',
              hintText: 'Start typing the street address',
              prefixIcon: Icon(_place != null ? Icons.check_circle_rounded : Icons.search_rounded, color: _place != null ? teal : null),
              suffixIcon: _searching ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))) : null,
            ),
          ),
          if (_place != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Found on the map ✓', style: TextStyle(color: teal, fontWeight: FontWeight.w700))),
          if (_place == null && _results.isNotEmpty)
            Card(
              margin: const EdgeInsets.only(top: 6),
              child: Column(children: [
                for (final p in _results)
                  ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(p.label, maxLines: 2, overflow: TextOverflow.ellipsis),
                    onTap: () => setState(() {
                      _place = p;
                      _address.text = p.label;
                      _results = const [];
                      _searchNote = null;
                    }),
                  ),
              ]),
            ),
          if (_place == null && _searchNote != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_searchNote!, style: t.bodySmall)),

          section('When'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final (w, label) in [(When.now, 'Now'), (When.in15, 'In 15 min'), (When.in30, 'In 30 min'), (When.in60, 'In 1 hour')])
              ChoiceChip(label: Text(label), selected: _when == w, onSelected: (_) => setState(() => _when = w)),
            ChoiceChip(
              label: Text(_when == When.pick && _picked != null ? '${_picked!.month}/${_picked!.day} ${clock(_picked)}' : 'Pick a time…'),
              selected: _when == When.pick,
              onSelected: (_) => _pickTime(),
            ),
          ]),
          if (wait)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Drop offs leave at least ${s.dropoffWaitMin} minutes after booking (unless urgent), so a sooner time moves to then.', style: t.bodySmall),
            ),

          section('Details'),
          Row(children: [
            const Expanded(child: Text('Passengers')),
            IconButton.outlined(onPressed: _passengers > 1 ? () => setState(() => _passengers--) : null, icon: const Icon(Icons.remove_rounded)),
            SizedBox(width: 44, child: Text('$_passengers', textAlign: TextAlign.center, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800))),
            IconButton.outlined(onPressed: _passengers < 15 ? () => setState(() => _passengers++) : null, icon: const Icon(Icons.add_rounded)),
          ]),
          const SizedBox(height: 10),
          TextField(controller: _notes, minLines: 2, maxLines: 4, maxLength: 1000, decoration: const InputDecoration(labelText: 'Notes for the driver', hintText: 'e.g. Side door, has a wheelchair')),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Urgent'),
            subtitle: const Text('Goes to the front of the line'),
            value: _urgent,
            onChanged: (v) => setState(() => _urgent = v),
          ),
          if (_urgent) TextField(controller: _why, decoration: const InputDecoration(labelText: 'Why is it urgent? *', hintText: 'e.g. Flight at 3:10')),

          if (_advisors != null && _advisors!.isNotEmpty) ...[
            section(_isBdc ? 'Service advisor *' : 'Service advisor'),
            DropdownButtonFormField<int>(
              initialValue: _advisorId,
              isExpanded: true,
              decoration: InputDecoration(labelText: _isBdc ? 'Whose customer is this?' : 'Whose customer? (blank: yours)'),
              items: [for (final a in _advisors!) DropdownMenuItem(value: a.id, child: Text(a.name))],
              onChanged: (v) => setState(() => _advisorId = v),
            ),
          ],

          if (_error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontWeight: FontWeight.w700))),
          const SizedBox(height: 20),
          FilledButton(onPressed: _sending ? null : _book, child: Text(_sending ? 'Booking…' : 'Book the ride')),
        ]),
      ),
    );
  }
}

/// After booking: what was booked, and the customer's tracking link.
Future<void> showBooked(BuildContext context, Driver d, Booked b) {
  final r = b.ride;
  final link = r.trackUrl;
  final phone = r.customerPhone;
  return showModalBottomSheet(
    context: context,
    showDragHandle: true,
    builder: (c) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [Icon(Icons.check_circle_rounded, color: teal, size: 30), const SizedBox(width: 8), Text('Booked', style: Theme.of(c).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800))]),
          const SizedBox(height: 8),
          Text('${r.customerName} · ${typeLabel[r.type]} ${clock(r.scheduledAt)}'),
          Text(r.address, style: Theme.of(c).textTheme.bodySmall),
          if (b.adjustedTo != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Moved to ${clock(b.adjustedTo)}: drop offs leave ${b.waitMin} minutes after booking.', style: const TextStyle(fontWeight: FontWeight.w600))),
          const SizedBox(height: 16),
          if (link != null && (phone ?? '').isNotEmpty)
            FilledButton.icon(
              onPressed: () => launchUrl(Uri.parse('sms:${digits(phone!)}?body=${Uri.encodeComponent('Follow your shuttle here: $link')}')),
              icon: const Icon(Icons.sms_rounded),
              label: const Text('Text them the tracking link'),
            ),
          if (link != null) ...[
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: link));
                if (c.mounted) Navigator.pop(c);
              },
              icon: const Icon(Icons.link_rounded),
              label: const Text('Copy the tracking link'),
            ),
          ],
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done')),
        ]),
      ),
    ),
  );
}
