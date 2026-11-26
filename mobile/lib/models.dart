// What the shuttle sends: the driver, the business's settings, rides, vans and ride offers.

double? _d(Object? v) => v == null ? null : (v is num ? v.toDouble() : double.tryParse(v.toString()));
int? _i(Object? v) => v == null ? null : (v is num ? v.toInt() : int.tryParse(v.toString()));
String? _s(Object? v) => v?.toString();
DateTime? _t(Object? v) => v == null ? null : DateTime.tryParse(v.toString())?.toLocal();

class Me {
  Me({required this.id, required this.name, required this.roles, this.can = const [], this.role = '', this.home = '', required this.onDuty, this.vehicleId, required this.settings});
  final int id;
  final String name;
  final List<String> roles;
  final List<String> can; // what this person may do (a manager can do everything)
  final String role; // strongest role: admin | advisor | driver
  final String home; // their main web page, e.g. /admin
  final bool onDuty;
  final int? vehicleId;
  final Settings settings;

  bool get isManager => role == 'admin';
  /// Drivers, and managers (who can drive too).
  bool get canDrive => can.contains('driver') || roles.contains('driver');
  /// Managers, service advisors and BDC: the Desk (all rides, assigning drivers).
  bool get canDesk => isManager || can.contains('advisor') || roles.contains('advisor') || roles.contains('bdc');
  bool get isStaff => canDrive || canDesk;
  String get firstName => name.split(' ').first;
  String get roleName => isManager ? 'Manager' : (roles.contains('bdc') ? 'BDC' : canDesk ? 'Service advisor' : 'Driver');

  factory Me.fromJson(Map<String, dynamic> j) {
    final u = j['user'] as Map<String, dynamic>;
    final roles = (u['roles'] as List?)?.map((e) => e.toString()).toList() ?? [u['role'].toString()];
    return Me(
      id: _i(u['id'])!,
      name: _s(u['name']) ?? '',
      roles: roles,
      can: (u['can'] as List?)?.map((e) => e.toString()).toList() ?? roles,
      role: _s(u['role']) ?? '',
      home: _s(u['home']) ?? '',
      onDuty: u['on_duty'] == true,
      vehicleId: _i(u['vehicle_id']),
      settings: Settings.fromJson((j['settings'] as Map?)?.cast<String, dynamic>() ?? const {}),
    );
  }
}

/// The business: its name, where it is, and how calls and texts to customers go.
class Settings {
  Settings({required this.businessName, required this.place, this.lat, this.lng, this.address = '', this.arriveWaitMin = 5,
      this.callsThroughBusiness = false, this.textsThroughBusiness = false, this.brandColor});
  final String businessName;
  final String place; // "dealership", "hotel", "office"…
  final double? lat;
  final double? lng;
  final String address;
  final int arriveWaitMin;
  final bool callsThroughBusiness;
  final bool textsThroughBusiness;
  final String? brandColor;

  factory Settings.fromJson(Map<String, dynamic> s) => Settings(
        businessName: _s(s['dealer_name']) ?? 'Your shuttle',
        place: (_s(s['place']) ?? 'dealership').trim().isEmpty ? 'dealership' : _s(s['place'])!.trim(),
        lat: _d(s['dealer_lat']),
        lng: _d(s['dealer_lng']),
        address: _s(s['dealer_address']) ?? '',
        arriveWaitMin: _i(s['arrive_wait_min']) ?? 5,
        callsThroughBusiness: s['phone_calls'] == 'dealership',
        textsThroughBusiness: s['phone_texts'] == 'dealership',
        brandColor: _s(s['brand_color']),
      );
}

class Ride {
  Ride({required this.id, required this.customerName, required this.type, required this.status, required this.address,
      this.lat, this.lng, this.scheduledAt, this.passengers = 1, this.urgent = false, this.urgentReason, this.notes,
      this.driverId, this.driverName, this.arrivedAt, this.customerReply, this.customerPhone, this.distanceMi, this.rank});
  final int id;
  final String customerName;
  final String type; // pickup | dropoff
  final String status; // requested | assigned | en_route | onboard | completed | cancelled
  final String address;
  final double? lat;
  final double? lng;
  final DateTime? scheduledAt;
  final int passengers;
  final bool urgent;
  final String? urgentReason;
  final String? notes;
  final int? driverId;
  final String? driverName;
  final DateTime? arrivedAt;
  final String? customerReply; // coming | five_minutes
  final String? customerPhone;
  final double? distanceMi;
  final int? rank;

  bool get isPickup => type == 'pickup';
  String get firstName => customerName.split(' ').first;

  factory Ride.fromJson(Map<String, dynamic> j) => Ride(
        id: _i(j['id'])!,
        customerName: _s(j['customer_name']) ?? 'Customer',
        type: _s(j['type']) ?? 'pickup',
        status: _s(j['status']) ?? 'requested',
        address: _s(j['address']) ?? '',
        lat: _d(j['lat']),
        lng: _d(j['lng']),
        scheduledAt: _t(j['scheduled_at']),
        passengers: _i(j['passengers']) ?? 1,
        urgent: j['priority'] == 'urgent',
        urgentReason: _s(j['urgent_reason']),
        notes: _s(j['notes']),
        driverId: _i(j['driver_id']),
        driverName: _s(j['driver_name']),
        arrivedAt: _t(j['arrived_at']),
        customerReply: _s(j['customer_reply']),
        customerPhone: _s(j['customer_phone']),
        distanceMi: _d(j['distance_mi']),
        rank: _i(j['rank']),
      );
}

/// Open rides in the order the shuttle suggests (closest and most urgent first).
class RideList {
  RideList(this.rides);
  final List<Ride> rides;
  factory RideList.fromJson(Map<String, dynamic> j) {
    final all = {for (final r in (j['rides'] as List? ?? const [])) _i((r as Map)['id'])!: Ride.fromJson(r.cast<String, dynamic>())};
    final order = (j['queue'] as List? ?? const []).map((e) => _i(e)!).toList();
    final sorted = [for (final id in order) if (all[id] != null) all[id]!];
    for (final r in all.values) {
      if (!order.contains(r.id)) sorted.add(r);
    }
    return RideList(sorted);
  }
  List<Ride> mine(int me) => rides.where((r) => r.driverId == me).toList();
  List<Ride> waiting() => rides.where((r) => r.driverId == null).toList();
}

class Vehicle {
  Vehicle({required this.id, required this.name, required this.status, this.use, this.seats, this.driverName, this.driverId});
  final int id;
  final String name;
  final String status;
  final String? use;
  final int? seats;
  final String? driverName;
  final int? driverId;
  bool get usable => status == 'available' && use != 'loaner';
  factory Vehicle.fromJson(Map<String, dynamic> j) => Vehicle(
        id: _i(j['id'])!,
        name: _s(j['name']) ?? 'Van',
        status: _s(j['status']) ?? 'available',
        use: _s(j['use']),
        seats: _i(j['seats']),
        driverName: _s(j['driver_name']),
        driverId: _i(j['driver_id']),
      );
}

class Offer {
  Offer({required this.id, required this.rideId, required this.customerName, required this.type, required this.address,
      this.scheduledAt, this.passengers = 1, this.urgent = false, required this.secondsLeft, required this.receivedAt});
  final int id;
  final int rideId;
  final String customerName;
  final String type;
  final String address;
  final DateTime? scheduledAt;
  final int passengers;
  final bool urgent;
  final int secondsLeft;
  final DateTime receivedAt;
  int get secondsNow => (secondsLeft - DateTime.now().difference(receivedAt).inSeconds).clamp(0, 9999);
  factory Offer.fromJson(Map<String, dynamic> j) => Offer(
        id: _i(j['id'])!,
        rideId: _i(j['ride_id']) ?? 0,
        customerName: _s(j['customer_name']) ?? 'Customer',
        type: _s(j['type']) ?? 'pickup',
        address: _s(j['address']) ?? '',
        scheduledAt: _t(j['scheduled_at']),
        passengers: _i(j['passengers']) ?? 1,
        urgent: j['priority'] == 'urgent',
        secondsLeft: _i(j['seconds_left']) ?? 0,
        receivedAt: DateTime.now(),
      );
}

/// A driver, for the Desk (on shift or not).
class DriverInfo {
  DriverInfo({required this.id, required this.name, required this.onDuty, this.vehicleName, this.openRides = 0, this.lastSeen, this.phone});
  final int id;
  final String name;
  final bool onDuty;
  final String? vehicleName;
  final int openRides;
  final DateTime? lastSeen;
  final String? phone;
  factory DriverInfo.fromJson(Map<String, dynamic> j) => DriverInfo(
        id: _i(j['id'])!,
        name: _s(j['name']) ?? 'Driver',
        onDuty: j['on_duty'] == true,
        vehicleName: _s(j['vehicle_name']),
        openRides: _i(j['open_rides']) ?? 0,
        lastSeen: _t(j['last_loc_at']),
        phone: _s(j['phone']),
      );
}
