// Instant updates: pages keep one connection open (Server-Sent Events) and the server
// tells them the moment something changes, instead of them asking every few seconds.
// Works through the Cloudflare Tunnel; a small "ping" every 25 s keeps the connection open.

function createLive({ maxClients = 10000, perUser = 6, heartbeatMs = 25000 } = {}) {
  const clients = new Set();
  let nextId = 0;

  function handler(req, res, user) {
    const mine = [...clients].filter((c) => c.user && user && c.user.id === user.id);
    if (clients.size >= maxClients || mine.length >= perUser) {
      // Too many open: close the oldest one for this person, or refuse.
      if (mine.length >= perUser) { const old = mine[0]; old.res.end(); clients.delete(old); } else { res.status(503).end(); return; }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 4000\n\n');
    const c = { id: ++nextId, res, user };
    clients.add(c);
    const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    beat.unref?.();
    req.on('close', () => { clearInterval(beat); clients.delete(c); });
  }

  // Send an event to everyone (or only those `to` returns true for).
  function send(event, data = {}, to = null) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      if (to && !to(c.user)) continue;
      try { c.res.write(msg); } catch { clients.delete(c); }
    }
  }

  // Many changes close together become one message (e.g. a driver's location every few seconds).
  const pending = new Map();
  function soon(event, ms = 600, data = {}, to = null) {
    const key = event + (to ? '?' : '');
    if (pending.has(key)) return;
    pending.set(key, setTimeout(() => { pending.delete(key); send(event, data, to); }, ms));
    pending.get(key).unref?.();
  }

  return { handler, send, soon, get count() { return clients.size; } };
}

module.exports = { createLive };
