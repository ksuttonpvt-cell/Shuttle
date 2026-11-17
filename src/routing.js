// Route planning: puts a driver's stops in the quickest order.
//
// Driving times come from an OSRM road-routing server (the free public one by default,
// or ROUTING_URL). If it can't be reached, straight-line distance with a road factor is
// used instead, so planning always works.

const { distanceKm } = require('./priority');

const KM_TO_MI = 0.621371;
const ROAD_FACTOR = 1.35;    // roads are longer than a straight line
const FALLBACK_MPH = 28;     // typical town driving speed
const STOP_MINUTES = 3;      // time spent at each stop (loading, hand-off)

// Straight-line estimate: { seconds[i][j], meters[i][j] }.
function estimateMatrix(points) {
  const n = points.length;
  const seconds = []; const meters = [];
  for (let i = 0; i < n; i++) {
    seconds.push([]); meters.push([]);
    for (let j = 0; j < n; j++) {
      const m = i === j ? 0 : distanceKm(points[i], points[j]) * 1000 * ROAD_FACTOR;
      meters[i].push(m);
      seconds[i].push(m / (FALLBACK_MPH * 1609.344 / 3600));
    }
  }
  return { seconds, meters };
}

function createOsrmRouter({ baseUrl = 'https://router.project-osrm.org', timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const coords = (pts) => pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  async function get(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'dealer-shuttle-app' } });
    if (!res.ok) throw new Error(`routing server answered ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`routing server: ${data.code}`);
    return data;
  }
  return {
    async matrix(points) {
      const d = await get(`${base}/table/v1/driving/${coords(points)}?annotations=duration,distance`);
      return { seconds: d.durations, meters: d.distances };
    },
    // Road path for the ordered points, as [[lat, lng], ...].
    async path(points) {
      const d = await get(`${base}/route/v1/driving/${coords(points)}?overview=full&geometries=geojson`);
      return d.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    },
  };
}

// Best order of the free points between the fixed start points and the end point.
// Small sets are solved exactly; bigger ones use nearest-neighbour + 2-opt.
// extra(seq) adds a cost for a whole sequence (used for the seat limit).
function bestOrder(cost, fixed, free, end, extra = null) {
  const total = (order) => {
    const seq = [...fixed, ...order, ...(end == null ? [] : [end])];
    let t = 0; for (let i = 1; i < seq.length; i++) t += cost[seq[i - 1]][seq[i]];
    return extra ? t + extra(seq) : t;
  };
  if (free.length <= 8) {
    let best = null; let bestT = Infinity;
    const permute = (left, acc) => {
      if (!left.length) { const t = total(acc); if (t < bestT) { bestT = t; best = acc.slice(); } return; }
      for (let i = 0; i < left.length; i++) permute([...left.slice(0, i), ...left.slice(i + 1)], [...acc, left[i]]);
    };
    permute(free, []);
    return best || [];
  }
  let order = []; const left = new Set(free); let at = fixed[fixed.length - 1];
  while (left.size) {
    let pick = null; for (const j of left) if (pick == null || cost[at][j] < cost[at][pick]) pick = j;
    order.push(pick); left.delete(pick); at = pick;
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const next = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (total(next) + 1e-6 < total(order)) { order = next; improved = true; }
      }
    }
  }
  return order;
}

// start: {lat,lng,label}; via: optional fixed stop right after start (e.g. the dealership);
// stops: [{lat,lng,...}] in any order (or in driving order with keepOrder); end: {lat,lng,label} or null.
// Returns { legs: [{ point, meters, seconds }], path, source }.
// Seat limit: each point may have `people` (+ get in, - get out); startLoad is who's
// already in the van; capacity is the van's seats. Orders that overfill the van are
// avoided, and `peak` says the most people in the van at once on the chosen order.
function peakLoad(seq, points, startLoad) {
  let load = startLoad; let peak = startLoad;
  for (const i of seq) { load += points[i].people || 0; peak = Math.max(peak, load); }
  return peak;
}

async function planRoute({ start, via = null, stops, end = null, router = null, keepOrder = false, capacity = null, startLoad = 0, log = () => {} }) {
  const points = [start, ...(via ? [via] : []), ...stops, ...(end ? [end] : [])];
  const fixed = via ? [0, 1] : [0];
  const first = fixed.length;
  const free = stops.map((_, i) => first + i);
  const endIdx = end ? points.length - 1 : null;
  let m = null; let source = 'estimate';
  if (router) {
    try {
      m = await router.matrix(points);
      if (!m.seconds || m.seconds.some((row) => row.some((v) => v == null))) throw new Error('a stop could not be reached by road');
      source = 'roads';
    } catch (e) { log(`Road routing unavailable, using an estimate: ${e.message}`); m = null; }
  }
  if (!m) m = estimateMatrix(points);
  // Overfilling the van costs far more than any detour, so the planner drops people off
  // before picking more up when it has to.
  const seatPenalty = capacity ? (seq) => Math.max(0, peakLoad(seq, points, startLoad) - capacity) * 1e7 : null;
  const order = keepOrder ? free : bestOrder(m.seconds, fixed, free, endIdx, seatPenalty); // keepOrder: stops are already in the order to drive
  const seq = [...fixed, ...order, ...(endIdx == null ? [] : [endIdx])];
  const legs = seq.slice(1).map((idx, i) => ({ point: points[idx], meters: m.meters[seq[i]][idx], seconds: m.seconds[seq[i]][idx] }));
  let path = seq.map((i) => [points[i].lat, points[i].lng]);
  if (source === 'roads') {
    try { path = await router.path(seq.map((i) => points[i])); } catch (e) { log(`Road path unavailable: ${e.message}`); }
  }
  let load = startLoad;
  const loads = seq.slice(1).map((i) => { load += points[i].people || 0; return Math.max(0, load); });
  return { legs, path, source, loads, peak: Math.max(startLoad, ...loads) };
}

// ---------- trip planning with dealership stops along the way ----------
// A shuttle trip is more than a shortest loop: picked-up customers are done once they're
// at the dealership, drop-off customers have to be collected there first, some rides are
// due sooner or are urgent, and the van has a seat limit. planTrip looks for the order
// that's best for everyone, and may stop at the dealership in the middle of a trip, to
// let picked-up customers off and collect drop-off customers who are ready, before going
// out again.
//
// Each ride: { id, type: 'pickup'|'dropoff', lat, lng, people, onboard, due (ms), urgent, name, address }.
// Picked-up customers already on board have no stop of their own: they get off at the
// next dealership stop.
const EARLY_MIN = 10;   // don't plan to arrive more than this early; the driver waits instead
const LATE_WEIGHT = 3;  // a minute late counts like three extra minutes of driving…
const URGENT_WEIGHT = 3; // …and three times that for an urgent ride
const RIDE_WEIGHT = 0.5; // extra minutes a customer rides around (beyond the direct trip)

function makeRng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

async function planTrip({ start, dealer, rides, router = null, capacity = null, now = Date.now(), sequence = null, log = () => {}, budgetMs = 250 }) {
  const stopRides = rides.filter((r) => !(r.type === 'pickup' && r.onboard) && r.lat != null);
  const riding = rides.filter((r) => r.type === 'pickup' && r.onboard); // already in the van, heading to the dealership
  const points = [start, dealer, ...stopRides];
  const D = 1;
  let m = null; let source = 'estimate';
  if (router) {
    try {
      m = await router.matrix(points);
      if (!m.seconds || m.seconds.some((row) => row.some((v) => v == null))) throw new Error('a stop could not be reached by road');
      source = 'roads';
    } catch (e) { log(`Road routing unavailable, using an estimate: ${e.message}`); m = null; }
  }
  if (!m) m = estimateMatrix(points);
  const sec = m.seconds;
  const atDealer = distanceKm(start, dealer) < 0.25;
  const STOP = STOP_MINUTES * 60;
  const dueSec = (r) => (r.due == null ? null : (r.due - now) / 1000);
  const idxOf = new Map(stopRides.map((r, i) => [r, i + 2]));

  // Walk through a plan; returns its cost and, with detail, every stop's times and loads.
  function run(tokens, detail = false) {
    const seq = [...tokens, D];
    let t = 0; let at = 0; let cost = 0; let late = 0; let ride = 0; let bad = 0;
    let load = 0; let peak = 0;
    const inVan = new Map(); // ride -> time it got in
    for (const r of riding) { inVan.set(r, 0); load += r.people; }
    for (const r of stopRides) if (r.type === 'dropoff' && r.onboard) { inVan.set(r, 0); load += r.people; }
    peak = load;
    const out = [];
    const over = () => { if (capacity && load > capacity) bad += (load - capacity) * 1e9; if (load > peak) peak = load; };
    over();
    const nextDealerAfter = (pos) => { for (let k = pos + 1; k < seq.length; k++) if (seq[k] === D) return k; return seq.length; };
    const dealerVisit = (pos, arrive) => {
      const off = []; const on = [];
      for (const [r, since] of [...inVan]) {
        if (r.type !== 'pickup') continue;
        inVan.delete(r); load -= r.people; off.push(r);
        ride += Math.max(0, arrive - since - sec[idxOf.get(r) ?? D][D]);
      }
      const until = nextDealerAfter(pos);
      for (let k = pos + 1; k < until; k++) {
        const r = seq[k] !== D && points[seq[k]];
        if (r && r.type === 'dropoff' && !r.onboard && !inVan.has(r)) on.push(r);
      }
      let depart = arrive + (off.length || on.length ? STOP : 0);
      for (const r of on) { const d = dueSec(r); if (d != null) depart = Math.max(depart, d - EARLY_MIN * 60); }
      for (const r of on) {
        inVan.set(r, depart); load += r.people;
        const d = dueSec(r); if (d != null) late += Math.max(0, depart - d) * (r.urgent ? URGENT_WEIGHT : 1); // waiting in the lobby
      }
      over();
      return { off, on, depart };
    };
    if (atDealer) { const v = dealerVisit(-1, 0); t = v.depart; if (detail && (v.on.length)) out.push({ kind: 'dealer', point: dealer, arrive: 0, depart: t, seconds: 0, meters: 0, off: v.off, on: v.on, load, startVisit: true }); }
    for (let k = 0; k < seq.length; k++) {
      const to = seq[k];
      const drive = sec[at][to]; const meters = m.meters[at][to];
      const arrive = t + drive;
      if (to === D) {
        const v = dealerVisit(k, arrive);
        t = v.depart;
        if (detail) out.push({ kind: 'dealer', point: dealer, arrive, depart: t, seconds: drive, meters, off: v.off, on: v.on, load, last: k === seq.length - 1 });
      } else {
        const r = points[to];
        let when = arrive;
        if (r.type === 'pickup') {
          const d = dueSec(r);
          if (d != null) { when = Math.max(arrive, d - EARLY_MIN * 60); late += Math.max(0, when - d) * (r.urgent ? URGENT_WEIGHT : 1); }
          inVan.set(r, when); load += r.people;
        } else {
          if (!inVan.has(r)) bad += 1e10; // a drop-off customer must be collected at the dealership first
          else { ride += Math.max(0, when - inVan.get(r) - sec[D][to]); inVan.delete(r); load -= r.people; }
        }
        over();
        t = when + STOP;
        if (detail) out.push({ kind: r.type, ride: r, point: r, arrive: when, depart: t, seconds: drive, meters, load });
      }
      at = to;
    }
    cost = bad + t + LATE_WEIGHT * late + RIDE_WEIGHT * ride;
    return detail ? { cost, stops: out, peak, finish: t } : cost;
  }

  const ids = stopRides.map((_, i) => i + 2);
  let best;
  if (sequence) {
    best = sequence.map((x) => (x === 0 ? D : idxOf.get(stopRides.find((r) => r.id === x)))).filter((x) => x != null);
  } else {
    // Starting points: soonest due first; quickest loop; and both with a dealership stop
    // before the first drop off. Then improve with small changes, many times over.
    const withCollect = (order) => {
      if (atDealer) return order;
      const i = order.findIndex((x) => points[x].type === 'dropoff' && !points[x].onboard);
      return i < 0 ? order : [...order.slice(0, i), D, ...order.slice(i)];
    };
    const byDue = ids.slice().sort((a, b) => (dueSec(points[a]) ?? 1e12) - (dueSec(points[b]) ?? 1e12) || (points[b].urgent - points[a].urgent));
    const loop = bestOrder(sec, [0], ids, D);
    const seeds = [withCollect(byDue), withCollect(loop), withCollect(byDue.filter((x) => points[x].type === 'pickup').concat([D], byDue.filter((x) => points[x].type === 'dropoff')))];
    const clean = (T) => { const o = []; for (const x of T) if (!(x === D && (o.length ? o[o.length - 1] === D : atDealer))) o.push(x); while (o.length && o[o.length - 1] === D) o.pop(); return o; };
    const improve = (T) => {
      let cur = clean(T); let c = run(cur);
      for (let changed = true; changed;) {
        changed = false;
        const L = cur.length;
        const tryIt = (cand) => { cand = clean(cand); const cc = run(cand); if (cc + 1e-6 < c) { cur = cand; c = cc; changed = true; return true; } return false; };
        outer: for (let i = 0; i < L; i++) {
          for (let j = 0; j <= L; j++) { // move one stop
            if (j === i || j === i + 1) continue;
            const a = cur.slice(); const [x] = a.splice(i, 1); a.splice(j > i ? j - 1 : j, 0, x);
            if (tryIt(a)) break outer;
          }
          for (let j = i + 1; j < L; j++) { // swap two / turn a stretch around
            const a = cur.slice(); [a[i], a[j]] = [a[j], a[i]]; if (tryIt(a)) break outer;
            const b = [...cur.slice(0, i), ...cur.slice(i, j + 1).reverse(), ...cur.slice(j + 1)]; if (tryIt(b)) break outer;
          }
        }
        if (!changed) for (let i = 0; i <= cur.length && !changed; i++) tryIt([...cur.slice(0, i), D, ...cur.slice(i)]); // an extra dealership stop
        if (!changed) for (let i = 0; i < cur.length && !changed; i++) if (cur[i] === D) tryIt([...cur.slice(0, i), ...cur.slice(i + 1)]);
      }
      return { order: cur, cost: c };
    };
    let top = { order: null, cost: Infinity };
    for (const sd of seeds) { const r = improve(sd); if (r.cost < top.cost) top = r; }
    const rng = makeRng(ids.length * 7919 + 17);
    const until = Date.now() + budgetMs;
    for (let n = 0; n < 60 && Date.now() < until && ids.length > 2; n++) { // shake the best plan a little and improve again
      const a = top.order.slice();
      for (let k = 0; k < 3; k++) { const i = Math.floor(rng() * a.length); const j = Math.floor(rng() * a.length); [a[i], a[j]] = [a[j], a[i]]; }
      const r = improve(a); if (r.cost + 1e-6 < top.cost) top = r;
    }
    best = top.order || [];
  }
  const plan = run(best, true);
  const seqPts = [start, ...plan.stops.filter((x) => !x.startVisit).map((x) => x.point)];
  let path = seqPts.map((p) => [p.lat, p.lng]);
  if (source === 'roads') {
    try { path = await router.path(seqPts); } catch (e) { log(`Road path unavailable: ${e.message}`); }
  }
  return { stops: plan.stops, peak: plan.peak, finish: plan.finish, path, source, startsAtDealer: atDealer, sequence: best.map((x) => (x === D ? 0 : points[x].id)) };
}

module.exports = { planRoute, planTrip, peakLoad, createOsrmRouter, estimateMatrix, bestOrder, KM_TO_MI, STOP_MINUTES };
