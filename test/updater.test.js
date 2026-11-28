process.removeAllListeners('warning');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createUpdater } = require('../src/updater');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-upd-'));
  const origin = path.join(dir, 'origin.git'); const dev = path.join(dir, 'dev'); const server = path.join(dir, 'server');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, dev);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(dev, 'config', k, v);
  fs.writeFileSync(path.join(dev, 'app.txt'), 'v1');
  fs.writeFileSync(path.join(dev, 'package-lock.json'), '{"v":1}');
  fs.writeFileSync(path.join(dev, '.env.example'), 'SAMPLE=1');
  fs.writeFileSync(path.join(dev, '.gitignore'), '.env\n');
  git(dev, 'add', '.'); git(dev, 'commit', '-qm', 'v1'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', '-b', 'main', origin, server);
  const push = (file, content) => {
    fs.writeFileSync(path.join(dev, file), content);
    git(dev, 'commit', '-qam', `change ${file}`); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { dir, server, push };
}

test('installs new versions, restarts, and handles problems', async () => {
  const { dir, server, push } = setup();
  let restarts = 0; let installs = 0;
  const u = createUpdater({ cwd: server, enabled: true, restart: () => { restarts++; }, installPackages: async () => { installs++; }, log: () => {} });

  assert.equal(await u.check(), 'up-to-date');
  assert.ok(u.state.version);

  push('app.txt', 'v2');
  assert.equal(await u.check(), 'updated');
  assert.equal(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'v2');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(restarts, 1);
  assert.equal(installs, 0, 'no package changes, so no npm install');

  // A locally rewritten package-lock.json must not block an update that changes it.
  fs.writeFileSync(path.join(server, 'package-lock.json'), '{"rewritten by npm":true}');
  push('package-lock.json', '{"v":2}');
  assert.equal(await u.check(), 'updated');
  assert.equal(installs, 1, 'package change triggers npm install');
  assert.equal(fs.readFileSync(path.join(server, 'package-lock.json'), 'utf8'), '{"v":2}');

  // Settings typed into .env.example are kept in .env and don't block the update.
  push('.env.example', 'SAMPLE=2');
  fs.writeFileSync(path.join(server, '.env.example'), 'PUBLIC_URL=https://mine.example');
  assert.equal(await u.check(), 'updated');
  assert.equal(fs.readFileSync(path.join(server, '.env'), 'utf8'), 'PUBLIC_URL=https://mine.example');
  assert.equal(fs.readFileSync(path.join(server, '.env.example'), 'utf8'), 'SAMPLE=2');
  await new Promise((r) => setTimeout(r, 600));

  // Local edits to app files block the pull; the site keeps running and reports it.
  fs.writeFileSync(path.join(server, 'app.txt'), 'edited on the server');
  push('app.txt', 'v3');
  assert.equal(await u.check(), 'error');
  assert.match(u.state.lastError, /pull failed/);
  assert.equal(await u.check(), 'error', 'does not retry the same failed update');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(restarts, 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turned off without git or with AUTO_UPDATE=0', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-nogit-'));
  const u = createUpdater({ cwd: plain, enabled: true, log: () => {} });
  assert.equal(u.state.enabled, false);
  assert.match(u.state.reason, /git/);
  assert.equal(await u.check(), 'skipped');
  const off = createUpdater({ cwd: path.join(__dirname, '..'), enabled: false, log: () => {} });
  assert.equal(off.state.enabled, false);
  fs.rmSync(plain, { recursive: true, force: true });
});

test('a bad update is undone, not installed again, and the next one installs', async () => {
  const rollback = require('../src/rollback');
  const { dir, server, push } = setup();
  const dataDir = path.join(dir, 'data');
  const u = createUpdater({ cwd: server, enabled: true, watched: true, dataDir, restart: () => {}, installPackages: async () => {}, log: () => {} });
  const good = git(server, 'rev-parse', 'HEAD');
  push('app.txt', 'broken');
  assert.equal(await u.check(), 'updated');
  const p = rollback.pending(dataDir);
  assert.equal(p.from, good, 'the version it left is written down first');
  const bad = p.to;

  // Shuttle Control's trial: the new version crashes twice right away.
  let t = 0;
  const trial = rollback.createProbation({ dataDir, now: () => t });
  trial.started();
  assert.equal(trial.crashed(), null, 'one crash can be bad luck');
  trial.started(); // started again after the crash: still the same trial
  const why = trial.crashed();
  assert.match(why, /stopped 2 times/);
  let installs = 0;
  const rec = await rollback.undo({ root: server, dataDir, reason: why, installPackages: async () => { installs++; } });
  assert.equal(rec.bad, bad); assert.equal(rec.good, good);
  assert.equal(git(server, 'rev-parse', 'HEAD'), good, 'the old version is back');
  assert.equal(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'v1');
  assert.equal(installs, 0, 'no package changes, so no npm install');
  assert.equal(rollback.pending(dataDir), null);

  // The updater won't put the broken version back on, and says why.
  assert.equal(await u.check(), 'error');
  assert.match(u.state.lastError, /undone automatically because the new version stopped 2 times/);
  assert.equal(git(server, 'rev-parse', 'HEAD'), good);

  // A fixed version installs as usual, and passes its trial once it stays healthy.
  push('app.txt', 'fixed');
  assert.equal(await u.check(), 'updated');
  assert.equal(fs.readFileSync(path.join(server, 'app.txt'), 'utf8'), 'fixed');
  const trial2 = rollback.createProbation({ dataDir, now: () => t, keepAfterMs: 90000 });
  trial2.started();
  t = 10000; assert.equal(trial2.healthy(true), null);
  t = 20000; assert.equal(trial2.healthy(true), null);
  t = 95000; assert.equal(trial2.healthy(true), 'keep');
  assert.equal(rollback.pending(dataDir), null, 'kept: nothing left to undo');

  // One that never comes up is undone after the wait.
  const trial3 = rollback.createProbation({ dataDir, now: () => t, giveUpAfterMs: 1000 });
  rollback.markPending(dataDir, { from: good, to: git(server, 'rev-parse', 'HEAD') });
  t = 0; trial3.started();
  t = 500; assert.equal(trial3.healthy(false), null);
  t = 1500; assert.match(trial3.healthy(false), /didn't come up/);
  fs.rmSync(dir, { recursive: true, force: true });
});
