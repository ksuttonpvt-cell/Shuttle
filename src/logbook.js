// Server log: recent lines kept in memory for the control window and Admin → Server,
// and (when a folder is given) one plain-text file per day, kept for 14 days.
//   data/logs/shuttle-2026-11-15.log
const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 14;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// Guess how serious a line is from its words.
function levelOf(text, fromStderr = false) {
  if (/\b(error|failed|unexpected|crash|stopped unexpectedly|refused|cannot|can't)\b/i.test(text)) return 'error';
  if (/\b(warn|warning|unavailable|retry|retrying|blocked|too many)\b/i.test(text)) return 'warn';
  return fromStderr ? 'error' : 'info';
}

function createLogbook({ dir = null, max = 2000, echo = null } = {}) {
  const lines = []; let seq = 0;
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = null; } }

  function prune() {
    if (!dir) return;
    const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86400000));
    for (const f of fs.readdirSync(dir)) {
      const m = /^shuttle-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
  let prunedDay = null;

  function add(text, { level = null, fromStderr = false, source = 'site' } = {}) {
    const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
      .replace(/^\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}:\d{2}(\s?[AP]M)?\s+/i, '') // the log adds its own time
      .replace(/(password[^:=\n]{0,20}[:=]\s*)\S+/gi, '$1••••••••'); // never keep passwords in logs
    if (!clean.trim()) return null;
    const at = new Date();
    const entry = { seq: ++seq, at: at.toISOString(), level: level || levelOf(clean, fromStderr), source, text: clean };
    lines.push(entry);
    if (lines.length > max) lines.splice(0, lines.length - max);
    if (dir) {
      const day = localDay(at);
      try {
        fs.appendFileSync(path.join(dir, `shuttle-${day}.log`), `${day} ${localTime(at)}  ${entry.level.toUpperCase().padEnd(5)}  ${clean}\n`);
        if (prunedDay !== day) { prunedDay = day; prune(); }
      } catch { /* disk full or locked: keep going with memory only */ }
    }
    if (echo) echo(entry);
    return entry;
  }

  // Lines after a given number (for live tails), filtered by level and words.
  function recent({ after = 0, level = '', q = '', limit = 500 } = {}) {
    const want = level === 'error' ? ['error'] : level === 'warn' ? ['error', 'warn'] : null;
    const words = String(q || '').toLowerCase().trim();
    const out = lines.filter((l) => l.seq > after && (!want || want.includes(l.level)) && (!words || l.text.toLowerCase().includes(words)));
    return out.slice(-Math.min(Math.max(Number(limit) || 500, 1), 2000));
  }
  function counts(sinceMs = 3600000) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const c = { error: 0, warn: 0, info: 0 };
    for (const l of lines) if (l.at >= since) c[l.level]++;
    return c;
  }
  function files() {
    if (!dir) return [];
    return fs.readdirSync(dir).filter((f) => /^shuttle-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse()
      .map((f) => ({ name: f, day: f.slice(8, 18), size: fs.statSync(path.join(dir, f)).size }));
  }
  function filePath(day) {
    if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return null;
    const p = path.join(dir, `shuttle-${day}.log`);
    return fs.existsSync(p) ? p : null;
  }

  // Send console.log / console.error through the log as well (keeps printing as normal).
  function captureConsole(source = 'site') {
    for (const [name, stderr] of [['log', false], ['info', false], ['warn', true], ['error', true]]) {
      const original = console[name].bind(console);
      console[name] = (...args) => {
        original(...args);
        const text = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        add(text, { fromStderr: stderr, level: name === 'warn' ? 'warn' : null, source });
      };
    }
  }

  return { add, recent, counts, files, filePath, captureConsole, get dir() { return dir; } };
}

// Splits a stream into lines and calls fn for each one.
function eachLine(stream, fn) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { fn(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    if (buf.length > 20000) { fn(buf); buf = ''; }
  });
  stream.on('end', () => { if (buf) fn(buf); buf = ''; });
}

module.exports = { createLogbook, eachLine, levelOf, localDay };
