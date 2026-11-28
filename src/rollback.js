// Auto-undo for bad updates.
//
// Before an update is installed, the updater writes data/update-pending.json with the version
// it's leaving ("from") and the one it's installing ("to"). Shuttle Control then watches the
// new version: once the website has stayed up and healthy for a while, the update is kept and
// the note is removed. If the new version keeps crashing, or never comes up, Shuttle Control
// puts the old version back (git reset to "from"), writes data/update-undone.json so the
// updater doesn't install the same broken version again, and starts the website.
//
// Only code is put back. Databases are left alone (changes to them only ever add things,
// so the older version keeps working with them).
const fs = require('node:fs');
const path = require('node:path');
const { execFile, exec } = require('node:child_process');

const PENDING = 'update-pending.json';
const UNDONE = 'update-undone.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const isCommit = (s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s);

const pending = (dataDir) => {
  const p = readJson(path.join(dataDir, PENDING));
  return p && isCommit(p.from) && isCommit(p.to) ? p : null;
};
const markPending = (dataDir, { from, to }) => writeJson(path.join(dataDir, PENDING), { from, to, at: new Date().toISOString() });
const clearPending = (dataDir) => { try { fs.unlinkSync(path.join(dataDir, PENDING)); } catch { /* not there */ } };
const lastUndo = (dataDir) => readJson(path.join(dataDir, UNDONE));

const run = (cmd, args, cwd) => new Promise((resolve, reject) =>
  execFile(cmd, args, { cwd, windowsHide: true, timeout: 2 * 60000 }, (err, out, errOut) =>
    (err ? reject(new Error(`${cmd} ${args[0]} failed: ${String(errOut || err.message).trim()}`)) : resolve(String(out).trim()))));
// npm is a .cmd script on Windows, so it needs a shell.
const npmInstall = (cwd) => new Promise((resolve, reject) =>
  exec('npm install --omit=dev --no-audit --no-fund', { cwd, windowsHide: true, timeout: 5 * 60000 }, (err, out, errOut) =>
    (err ? reject(new Error(`npm install failed: ${String(errOut || err.message).trim()}`)) : resolve())));

// Put the version before the update back. Returns the record written to update-undone.json.
async function undo({ root, dataDir, reason, git = (args) => run('git', args, root), installPackages = npmInstall }) {
  const p = pending(dataDir);
  if (!p) throw new Error('No update to undo.');
  const changed = await git(['diff', '--name-only', p.from, p.to]).catch(() => '');
  await git(['reset', '--hard', '--quiet', p.from]);
  if (/(^|\n)package(-lock)?\.json$/m.test(changed)) await installPackages(root);
  const record = { bad: p.to, good: p.from, reason, at: new Date().toISOString() };
  writeJson(path.join(dataDir, UNDONE), record);
  clearPending(dataDir);
  return record;
}

// Watches a freshly installed update. Shuttle Control tells it what happens to the website;
// it answers "keep" or "undo".
//   started()  - the website was started
//   crashed()  - it stopped unexpectedly
//   healthy(ok)- result of a health check (every few seconds)
function createProbation({ dataDir, keepAfterMs = 90000, giveUpAfterMs = 4 * 60000, maxCrashes = 2, now = () => Date.now() }) {
  let watch = null;
  function started() {
    if (watch) return; // already watching (a restart during the trial counts as one trial)
    const p = pending(dataDir);
    if (p) watch = { ...p, since: now(), crashes: 0, goodChecks: 0 };
  }
  function crashed() {
    if (!watch) return null;
    watch.crashes++;
    watch.goodChecks = 0;
    return watch.crashes >= maxCrashes ? `the new version stopped ${watch.crashes} times right after it was installed` : null;
  }
  function healthy(ok) {
    if (!watch) return null;
    if (ok) watch.goodChecks++; else watch.goodChecks = 0;
    const age = now() - watch.since;
    if (ok && watch.goodChecks >= 3 && age >= keepAfterMs) { clearPending(dataDir); watch = null; return 'keep'; }
    if (!ok && age >= giveUpAfterMs) return 'the new version didn\'t come up in time';
    return null;
  }
  const stop = () => { watch = null; };
  return { started, crashed, healthy, stop, get watching() { return watch; } };
}

module.exports = { pending, markPending, clearPending, lastUndo, undo, createProbation, PENDING, UNDONE };
