// Bandwidth limit: paces what the site sends so it never uses more than the set speed.
// A shared "bucket" refills at the allowed bytes per second; every response takes from it
// in small slices, so many downloads at once share the speed fairly. Instant-update
// messages and the health check are tiny and always go straight out.
const SLICE = 16 * 1024;
const SKIP = /^\/(api\/events|healthz)\b/;

function createThrottle(rateOf) {
  let tokens = 0; let last = Date.now();
  const waiting = []; let timer = null;

  function refill(rate) {
    const t = Date.now();
    tokens = Math.min(tokens + ((t - last) / 1000) * rate, Math.max(rate / 4, SLICE)); // at most a quarter second saved up
    last = t;
  }
  function run() {
    timer = null;
    const rate = rateOf();
    while (waiting.length) {
      if (!(rate > 0)) { tokens = 0; waiting.shift()(Infinity); continue; } // limit turned off
      refill(rate);
      if (tokens < 1) break;
      const take = Math.min(tokens, SLICE);
      tokens -= take;
      waiting.shift()(take);
    }
    if (waiting.length && !timer) {
      const rate2 = rateOf() || 1;
      timer = setTimeout(run, Math.max(5, Math.ceil(((Math.min(SLICE, rate2 / 4) - tokens) / rate2) * 1000)));
    }
  }
  // Calls back with how many bytes may go out now.
  function allowance(cb) { waiting.push(cb); if (!timer) run(); }

  function middleware(req, res, next) {
    if (SKIP.test(req.path) || !(rateOf() > 0)) return next();
    const write = res.write.bind(res); const end = res.end.bind(res);
    const queue = []; let busy = false; let ended = false;

    const asBuffer = (chunk, enc) => (chunk == null ? null : Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8'));
    function pump() {
      if (busy) return;
      const item = queue[0];
      if (!item) return;
      if (item.end && !item.buf?.length) { queue.shift(); end(item.cb); return; }
      if (!item.buf?.length) { queue.shift(); if (item.cb) item.cb(); if (!queue.length) res.emit('drain'); pump(); return; }
      if (res.destroyed) { queue.length = 0; return; }
      busy = true;
      allowance((n) => {
        busy = false;
        const part = item.buf.subarray(0, Math.max(1, Math.floor(n === Infinity ? item.buf.length : n)));
        item.buf = item.buf.subarray(part.length);
        write(part);
        pump();
      });
    }
    res.write = (chunk, enc, cb) => {
      if (typeof enc === 'function') { cb = enc; enc = null; }
      queue.push({ buf: asBuffer(chunk, enc), cb });
      pump();
      return false; // the sender waits for 'drain', which comes when the queue is sent
    };
    res.end = (chunk, enc, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof enc === 'function') { cb = enc; enc = null; }
      if (ended) return res;
      ended = true;
      queue.push({ buf: asBuffer(chunk, enc), end: true, cb });
      pump();
      return res;
    };
    next();
  }
  return { middleware };
}

module.exports = { createThrottle };
