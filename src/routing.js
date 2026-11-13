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

module.exports = { planRoute, peakLoad, createOsrmRouter, estimateMatrix, bestOrder, KM_TO_MI, STOP_MINUTES };
