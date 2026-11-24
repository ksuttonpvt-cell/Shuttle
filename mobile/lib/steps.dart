// The driver's next step for a ride: one big button, in the same order as the shuttle's
// web screens: On my way → I'm here → Customer is on board → Ride complete.
import 'models.dart';

const statusLabel = {
  'requested': 'Waiting',
  'assigned': 'Assigned',
  'en_route': 'On the way',
  'onboard': 'On board',
  'completed': 'Completed',
  'cancelled': 'Cancelled',
};
const typeLabel = {'pickup': 'Pick up', 'dropoff': 'Drop off'};

const cancelReasons = [
  'Customer no-show',
  'Customer cancelled',
  'Customer found another ride',
  "Can't find the address / customer",
  'Shuttle or vehicle problem',
  'Duplicate ride',
  'Other',
];

enum StepKind { take, onMyWay, imHere, onBoard, complete, none }

class Step {
  const Step(this.kind, this.label, {this.then = ''});
  final StepKind kind;
  final String label;
  final String then; // what comes after, as a reminder
}

bool isMine(Ride r, int me) => r.driverId == me;
bool isHere(Ride r, int me) => isMine(r, me) && r.arrivedAt != null && (r.status == 'assigned' || r.status == 'en_route');

Step mainStep(Ride r, int me) {
  final mine = isMine(r, me);
  if (r.driverId == null) return const Step(StepKind.take, 'Take this ride');
  if (!mine) return const Step(StepKind.none, '');
  if (isHere(r, me)) return const Step(StepKind.onBoard, 'Customer is on board', then: 'Then: Ride complete');
  switch (r.status) {
    case 'assigned':
      return const Step(StepKind.onMyWay, "Start · I'm on my way", then: "Then: I'm here → On board → Complete");
    case 'en_route':
      return const Step(StepKind.imHere, "I'm here", then: 'Then: Customer is on board → Ride complete');
    case 'onboard':
      return const Step(StepKind.complete, 'Ride complete');
  }
  return const Step(StepKind.none, '');
}

/// The ride to show big on the Today screen: my next one, or one waiting for a driver.
Ride? nextRide(RideList list, int me, {required bool onDuty}) {
  final mine = list.mine(me);
  if (mine.isNotEmpty) {
    // A ride already under way comes first.
    return mine.firstWhere((r) => r.status == 'onboard' || r.status == 'en_route' || r.arrivedAt != null, orElse: () => mine.first);
  }
  final waiting = list.waiting();
  return onDuty && waiting.isNotEmpty ? waiting.first : null;
}

/// Where the driver should drive to next: the customer, or back to the business.
class Place {
  const Place({this.lat, this.lng, required this.address, required this.toBusiness});
  final double? lat;
  final double? lng;
  final String address;
  final bool toBusiness;
}

Place nextPlace(Ride r, Settings s) {
  final toBusiness = (r.isPickup && r.status == 'onboard') || (!r.isPickup && r.status != 'onboard');
  return toBusiness ? Place(lat: s.lat, lng: s.lng, address: s.address, toBusiness: true) : Place(lat: r.lat, lng: r.lng, address: r.address, toBusiness: false);
}

/// "Pick up at 12 Oak St → bring to the dealership"
String routeLine(Ride r, Settings s) {
  if (r.isPickup) return r.status == 'onboard' ? 'On board · bring to the ${s.place}' : '${r.address} → the ${s.place}';
  return r.status == 'onboard' ? 'On board · drop off at ${r.address}' : 'From the ${s.place} → ${r.address}';
}

/// After "I'm here", how long before the driver can mark a no-show.
bool canNoShow(Ride r, Settings s, DateTime now) =>
    r.arrivedAt != null && now.difference(r.arrivedAt!) >= Duration(minutes: s.arriveWaitMin);

String waited(DateTime since, DateTime now) {
  final s = now.difference(since).inSeconds.clamp(0, 359999);
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

String clock(DateTime? t) {
  if (t == null) return '';
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  return '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'AM' : 'PM'}';
}

/// "in 12 min", "5 min ago", "now"
String relative(DateTime? t, DateTime now) {
  if (t == null) return '';
  final m = t.difference(now).inMinutes;
  if (m.abs() < 1) return 'now';
  if (m.abs() >= 90) {
    final h = (m.abs() / 60).round();
    return m > 0 ? 'in $h h' : '$h h ago';
  }
  return m > 0 ? 'in $m min' : '${-m} min ago';
}

String noShowReason(Ride r, DateTime now) {
  final mins = r.arrivedAt == null ? 0 : now.difference(r.arrivedAt!).inMinutes;
  return "No-show: customer didn't come out${mins > 0 ? ' (driver waited $mins min)' : ''}";
}

/// Google Maps directions work on Android and iPhone (app if installed, else the website).
Uri directionsUrl(Place p) => Uri.https('www.google.com', '/maps/dir/', {
      'api': '1',
      'destination': p.lat != null && p.lng != null ? '${p.lat},${p.lng}' : p.address,
      'travelmode': 'driving',
    });

String digits(String phone) => phone.replaceAll(RegExp(r'[^\d+]'), '');
