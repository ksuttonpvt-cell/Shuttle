// Running the site on several processor cores.
//
// Node runs JavaScript on one core. To use more, the main process (the "primary") starts one
// copy of the website per core (the "workers"). They all answer on the same port and share the
// database file. Things that live in memory are kept in step through the primary:
//   publish  - tell the other copies something happened (an instant update, "rides changed")
//   ask      - ask the primary, or the copy that runs the background jobs, and wait for the answer
//   gather   - ask every copy and collect the answers (live numbers for Admin → Server)
// With one core there is no primary: the same calls work inside the single process.
const cluster = require('node:cluster');
const os = require('node:os');

const MSG = '__shuttle';
const MAX_AUTO = 16; // more copies than this doesn't help a site this size

function coresAvailable() { return (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1; }

// The "Processor cores" setting ('auto' or a number) → how many copies to run.
function coresWanted(setting, available = coresAvailable()) {
  const n = Number(setting);
  if (setting && setting !== 'auto' && Number.isInteger(n) && n >= 1) return Math.min(n, available);
  return Math.max(1, Math.min(available, MAX_AUTO));
}

// ---------- worker side ----------
function createBus() {
  const clustered = cluster.isWorker && typeof process.send === 'function';
  const jobs = !clustered || process.env.SHUTTLE_JOBS === '1';
  const handlers = new Map(); // kind -> fn(data) answering ask/gather
  const listeners = new Map(); // kind -> [fn(data)] for publish
  const pending = new Map(); let nextId = 0;
  // A callback keeps a closed channel (the main process stopping) from becoming an error.
  const send = (m) => { if (!process.connected) return false; try { process.send(m, () => {}); return true; } catch { return false; } };

  async function answer(kind, data) {
    const h = handlers.get(kind);
    if (!h) throw new Error(`Nothing answers "${kind}".`);
    return h(data);
  }
  if (clustered) {
    // Tell the main process how much memory this copy uses (for the memory limit).
    const report = () => send({ [MSG]: 'mem', rss: process.memoryUsage().rss });
    setTimeout(report, 2000).unref?.(); setInterval(report, 10000).unref?.();
    process.on('message', async (m) => {
      if (!m || !m[MSG]) return;
      if (m[MSG] === 'pub') {
        for (const fn of listeners.get(m.kind) || []) { try { fn(m.data); } catch (e) { console.error(`Message "${m.kind}" failed:`, e.message); } }
      } else if (m[MSG] === 'ask') {
        let out;
        try { out = { ok: true, data: await answer(m.kind, m.data) }; } catch (e) { out = { ok: false, error: e.message }; }
        send({ [MSG]: 'reply', id: m.id, ...out });
      } else if (m[MSG] === 'reply') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'Failed.'));
      }
    });
  }
  function request(msg, ms) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other copies of the site did not answer in time.')); }, ms);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      if (!send({ ...msg, [MSG]: msg.type, id })) { pending.delete(id); clearTimeout(timer); reject(new Error('The main process is not reachable.')); }
    });
  }

  return {
    clustered,
    jobs, // this copy runs the background jobs (offers, nightly clearing, backups, updates)
    worker: Number(process.env.SHUTTLE_WORKER) || 1,
    publish(kind, data = null) { if (clustered) send({ [MSG]: 'pub', kind, data }); },
    on(kind, fn) { if (!listeners.has(kind)) listeners.set(kind, []); listeners.get(kind).push(fn); },
    answer(kind, fn) { handlers.set(kind, fn); },
    // to: 'jobs' (the copy running background jobs) or 'primary'.
    async ask(to, kind, data = null, ms = 10000) {
      if (!clustered) { if (to === 'jobs') return answer(kind, data); throw new Error('There is no main process (one core).'); }
      if (to === 'jobs' && jobs) return answer(kind, data);
      return request({ type: 'ask', to, kind, data, ms }, ms + 1000);
    },
    // Every copy's answer, in a list (this one included).
    async gather(kind, data = null, ms = 3000) {
      if (!clustered) return [await answer(kind, data)];
      return request({ type: 'gather', kind, data, ms }, ms + 2000);
    },
  };
}

// ---------- primary side ----------
// count: how many copies; env: extra environment for them; handle: answers for ask(…'primary'…);
// output(stream, isErr, slot): where their printed output goes; heapMb: memory each copy may use
// for its data; ramMb: the limit for all copies together (the biggest is restarted when over).
function startPrimary({ count, env = {}, handle = {}, output = null, log = console.log, heapMb = 0, ramMb = 0 }) {
  cluster.schedulingPolicy = cluster.SCHED_RR; // share new connections out evenly (Windows too)
  cluster.setupPrimary({ silent: !!output, execArgv: [...process.execArgv.filter((a) => !a.startsWith('--max-old-space-size')), ...(heapMb ? [`--max-old-space-size=${heapMb}`] : [])] });
  const slots = new Map(); // 1..count -> worker; slot 1 runs the background jobs
  const asks = new Map(); let nextAsk = 0; // id -> { worker, id } waiting on another worker's reply
  const gathers = new Map(); // id -> { worker, id, want:Set, results:[], timer }
  let stopping = false; let onStopped = null;

  const tell = (w, m) => { try { if (w.isConnected()) w.send(m); } catch { /* it's going away */ } };
  const live = () => [...slots.values()].filter((w) => w.isConnected());

  function finishGather(gid) {
    const g = gathers.get(gid); if (!g) return;
    gathers.delete(gid); clearTimeout(g.timer);
    tell(g.worker, { [MSG]: 'reply', id: g.id, ok: true, data: g.results });
  }

  function onMessage(w, m) {
    if (!m || !m[MSG]) return;
    const type = m[MSG];
    if (type === 'mem') { w.rss = Number(m.rss) || 0; return; }
    if (type === 'pub') {
      for (const o of live()) if (o !== w) tell(o, m);
    } else if (type === 'ask' && m.to === 'primary') {
      Promise.resolve().then(() => {
        const h = handle[m.kind]; if (!h) throw new Error(`Nothing answers "${m.kind}".`);
        return h(m.data);
      }).then((data) => tell(w, { [MSG]: 'reply', id: m.id, ok: true, data }), (e) => tell(w, { [MSG]: 'reply', id: m.id, ok: false, error: e.message }));
    } else if (type === 'ask') {
      const target = slots.get(1);
      if (!target || !target.isConnected()) { tell(w, { [MSG]: 'reply', id: m.id, ok: false, error: 'The background-jobs copy is restarting. Try again in a moment.' }); return; }
      const id = `a${++nextAsk}`;
      asks.set(id, { worker: w, id: m.id, timer: setTimeout(() => asks.delete(id), (m.ms || 10000) + 2000) });
      tell(target, { [MSG]: 'ask', id, kind: m.kind, data: m.data });
    } else if (type === 'gather') {
      const gid = `g${++nextAsk}`;
      const targets = live();
      const g = { worker: w, id: m.id, want: new Set(targets.map((t) => t.id)), results: [], timer: setTimeout(() => finishGather(gid), m.ms || 3000) };
      gathers.set(gid, g);
      for (const t of targets) tell(t, { [MSG]: 'ask', id: gid, kind: m.kind, data: m.data });
      if (!targets.length) finishGather(gid);
    } else if (type === 'reply') {
      if (typeof m.id === 'string' && m.id.startsWith('g')) {
        const g = gathers.get(m.id); if (!g) return;
        if (m.ok) g.results.push(m.data);
        g.want.delete(w.id);
        if (!g.want.size) finishGather(m.id);
      } else {
        const a = asks.get(m.id); if (!a) return;
        asks.delete(m.id); clearTimeout(a.timer);
        tell(a.worker, { ...m, id: a.id });
      }
    }
  }

  function fork(slot) {
    const w = cluster.fork({ ...env, SHUTTLE_WORKER: String(slot), SHUTTLE_JOBS: slot === 1 ? '1' : '0' });
    w.slot = slot; w.startedAt = Date.now();
    slots.set(slot, w);
    if (output) { output(w.process.stdout, false, slot); output(w.process.stderr, true, slot); }
    w.on('message', (m) => onMessage(w, m));
    w.on('exit', (code, signal) => {
      if (slots.get(slot) === w) slots.delete(slot);
      for (const [gid, g] of gathers) { g.want.delete(w.id); if (!g.want.size) finishGather(gid); }
      if (stopping) { if (!slots.size && onStopped) onStopped(); return; }
      const quick = Date.now() - w.startedAt < 10000;
      log(`Site copy ${slot} stopped (${signal || `code ${code}`}). Starting it again${quick ? ' in 5 seconds' : ''}...`);
      setTimeout(() => { if (!stopping) fork(slot); }, quick ? 5000 : 300).unref?.();
    });
    return w;
  }
  for (let i = 1; i <= count; i++) fork(i);

  // Memory limit: if all copies together stay over it (two checks in a row), restart the
  // biggest one. Its visitors reconnect to another copy within seconds.
  let over = 0; let lastRamRestart = 0; let ramRestarts = 0;
  if (ramMb) {
    setInterval(() => {
      const ws = live();
      const total = ws.reduce((n, w) => n + (w.rss || 0), 0);
      if (total <= ramMb * 1048576) { over = 0; return; }
      over++;
      if (over < 2 || Date.now() - lastRamRestart < 60000 || stopping) return;
      const big = ws.sort((a, b) => (b.rss || 0) - (a.rss || 0))[0];
      if (!big) return;
      over = 0; lastRamRestart = Date.now(); ramRestarts++;
      log(`Memory limit reached (${Math.round(total / 1048576)} of ${ramMb} MB). Restarting site copy ${big.slot} (${Math.round((big.rss || 0) / 1048576)} MB) to free memory.`);
      try { big.disconnect(); } catch { /* gone */ }
      setTimeout(() => { try { big.process.kill(); } catch { /* gone */ } }, 4000).unref?.();
    }, 15000).unref?.();
  }

  // Stop every copy: they finish what they're doing; anything still open after 4 s is ended.
  function stop() {
    return new Promise((resolve) => {
      stopping = true;
      if (!slots.size) return resolve();
      onStopped = resolve;
      for (const w of slots.values()) { try { w.disconnect(); } catch { /* gone */ } }
      setTimeout(() => { for (const w of slots.values()) { try { w.process.kill(); } catch { /* gone */ } } }, 4000).unref?.();
      setTimeout(resolve, 6000).unref?.();
    });
  }
  return { stop, get count() { return live().length; }, get ramRestarts() { return ramRestarts; }, get rssMb() { return Math.round(live().reduce((n, w) => n + (w.rss || 0), 0) / 1048576); }, slots };
}

module.exports = { createBus, startPrimary, coresAvailable, coresWanted, MAX_AUTO };
