// Decides "what needs to be picked up first".
//
// Each open ride gets a score (lower = sooner). The score is driven mostly by
// how soon the ride is due, with a boost for urgent rides and overdue rides,
// and a small penalty for distance from where the driver is right now so that
// two rides due at about the same time are taken nearest-first.

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const OPEN = new Set(['requested', 'assigned', 'en_route', 'onboard']);

function rankRides(rides, origin, now = new Date()) {
  const ranked = rides
    .filter((r) => OPEN.has(r.status))
    .map((r) => {
      const minutes = (new Date(r.scheduled_at).getTime() - now.getTime()) / 60000;
      const km = distanceKm(origin, r);
      let score = minutes;
      const reasons = [];
      if (r.status === 'onboard') { score -= 1000; reasons.push('Customer on board'); }
      else if (r.status === 'en_route') { score -= 500; reasons.push('Already en route'); }
      if (r.priority === 'urgent') { score -= 30; reasons.push('Urgent'); }
      if (minutes < 0) { score -= 15; reasons.push(`Late by ${Math.round(-minutes)} min`); }
      else reasons.push(`Due in ${Math.round(minutes)} min`);
      if (km != null) { score += km * 1.5; reasons.push(`${(km * 0.621371).toFixed(1)} mi away`); }
      return { ...r, score: Math.round(score * 10) / 10, distance_mi: km == null ? null : +(km * 0.621371).toFixed(1), reasons };
    })
    .sort((a, b) => a.score - b.score);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

module.exports = { rankRides, distanceKm };
