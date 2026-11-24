// The shared sign-in ("front door") and the address router.
//
// Sign in once, with your email and password, at app.turaslubtha.com (or the website's Sign in
// page). The password is checked in each business's own database; when it matches, a one-time
// hand-off (60 seconds, used once) takes you to your business's own address, already signed in.
// It never says whether an email exists or which businesses there are: a wrong email and a
// wrong password get the same answer.
const path = require('node:path');
const express = require('express');
const { verifyPasswordAsync } = require('./auth');

const FRONT_NAMES = ['app']; // app.<domain> is the shared sign-in

function hostOf(req) { return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, ''); }
function portOf(req) { const m = String(req.headers.host || '').match(/:(\d+)$/); return m ? m[1] : ''; }

// Which part of the system an address belongs to:
//   { front: true }            app.turaslubtha.com (and app.localhost on this PC)
//   { slug: 'pinevalley' }     pinevalley.turaslubtha.com (and pinevalley.localhost)
//   { home: true }             anything else: the PC's own shuttle and the website, as before
// domain can be a list: businesses also work under the home shuttle's own address while
// testing (pinevalley.corwinshuttleservice.com as well as pinevalley.turaslubtha.com).
function routeOf(host, domain) {
  for (const d of [...[].concat(domain || []), 'localhost']) {
    if (!d || !host.endsWith(`.${d}`)) continue;
    const sub = host.slice(0, -(d.length + 1));
    if (!sub || sub.includes('.')) return { home: true };
    if (sub === 'www' || sub === 'website') return { home: true }; // the website, served by the home app
    if (FRONT_NAMES.includes(sub)) return { front: true };
    return { slug: sub };
  }
  return { home: true };
}

// Which of the business domains an address is under (the first one when it's none of them).
function domainFor(host, domains) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  return domains.find((d) => h === d || h.endsWith(`.${d}`)) || domains[0];
}
// The home shuttle's own address (from Settings → Web address), without "www.".
function hostOfUrl(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }

function createFrontDoor({ businesses, homeDb, domain, domains: domainsOf, siteDir = path.join(__dirname, '..', 'site'), homeUrl = () => '' }) {
  const domains = domainsOf || (() => [domain]);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // Wrong passwords: 10 per 15 minutes for one email from one address, 30 for one email overall.
  const fails = new Map();
  const WINDOW = 15 * 60000;
  const count = (k) => { const a = (fails.get(k) || []).filter((t) => t > Date.now() - WINDOW); if (a.length) fails.set(k, a); else fails.delete(k); return a.length; };
  const fail = (k) => { fails.set(k, [...(fails.get(k) || []), Date.now()]); if (fails.size > 20000) fails.clear(); };
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    return (local && req.get('cf-connecting-ip')) || req.ip || peer;
  };

  // The website's address: https://turaslubtha.com (http://website.localhost:3000 on this PC).
  const siteBase = (req) => {
    const host = hostOf(req);
    return host === 'localhost' || host.endsWith('.localhost') ? `http://website.localhost${portOf(req) ? `:${portOf(req)}` : ''}` : `https://${domains()[0]}`;
  };
  // Where a business lives, as a full address the browser can go to.
  function baseFor(req, slug) {
    const host = hostOf(req);
    if (!slug) {
      // This PC's own shuttle: at turaslubtha.com/<its name>, or its own address if it has none.
      const hs = businesses.getMeta('home_slug');
      if (hs) return `${siteBase(req)}/${hs}`;
      const hh = businesses.getMeta('home_host');
      return (homeUrl() || (hh ? `https://${hh}` : '')).replace(/\/+$/, '');
    }
    return `${siteBase(req)}/${slug}`;
  }
  const nameOf = (db, fallback) => {
    try { return (db.prepare("SELECT value FROM settings WHERE key = 'dealer_name'").get() || {}).value || fallback; } catch { return fallback; }
  };

  app.post('/api/frontdoor/signin', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200);
    const password = String((req.body && req.body.password) || '').slice(0, 200);
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    const ipKey = `${clientIp(req)}|${email.toLowerCase()}`; const anyKey = `any|${email.toLowerCase()}`;
    if (count(ipKey) >= 10 || count(anyKey) >= 30) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

    // Every place this email has an account: the home shuttle and each business.
    const places = [{ slug: '', db: homeDb, name: nameOf(homeDb, 'Your shuttle'), paused: false }];
    for (const b of businesses.list()) {
      try { const e = businesses.load(b.slug); places.push({ slug: b.slug, db: e.db, name: nameOf(e.db, b.name), paused: b.paused }); } catch { /* skip a broken one */ }
    }
    const matches = [];
    let checked = 0;
    for (const p of places) {
      let u = null;
      try { u = p.db.prepare('SELECT id, password_hash, active, signup_at FROM users WHERE email = ?').get(email); } catch { /* no table yet */ }
      if (!u) continue;
      checked++;
      if (await verifyPasswordAsync(password, u.password_hash)) matches.push({ ...p, user: u });
    }
    if (!checked) await verifyPasswordAsync(password, undefined); // same time whether or not the email exists
    const usable = matches.filter((m) => m.user.active);
    if (!usable.length) {
      if (matches.some((m) => m.user.signup_at)) return res.status(403).json({ error: 'Your account is waiting for a shuttle manager to approve it. You can sign in as soon as they do.' });
      fail(ipKey); fail(anyKey);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const open = usable.filter((m) => !m.paused);
    if (!open.length) return res.status(403).json({ error: 'This business is paused right now. Contact Turas Lúbtha to turn it back on.' });
    const choices = [];
    for (const m of open) {
      const base = baseFor(req, m.slug);
      if (!base) continue; // the home shuttle's address isn't known (no Website address set)
      choices.push({ name: m.name, url: `${base}/auth/handoff?t=${encodeURIComponent(businesses.makeHandoff(m.slug, m.user.id))}` });
    }
    if (!choices.length) return res.status(409).json({ error: 'Sign in at your shuttle’s own address for now.' });
    fails.delete(ipKey);
    res.json(choices.length === 1 ? { go: choices[0].url } : { choose: choices });
  });

  // app.turaslubtha.com shows the website's Sign in page (and its styles and pictures).
  const site = express.static(siteDir, { maxAge: '10m', extensions: ['html'], index: false });
  // Its links to the rest of the website ("./#pricing") go to the website itself.
  const fs = require('node:fs');
  const signinPage = (req, res) => {
    const host = hostOf(req);
    const d = domainFor(host, domains());
    const web = host === 'localhost' || host.endsWith('.localhost') ? `http://website.localhost${portOf(req) ? `:${portOf(req)}` : ''}/`
      : d === domains()[0] ? `https://${d}/` : `https://${d}/website/`; // under the shuttle's address, the website is at /website/
    fs.readFile(path.join(siteDir, 'signin.html'), 'utf8', (err, html) => {
      if (err) return res.status(500).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html.replace(/href="\.\/(#[^"]*)?"/g, (m, hash) => `href="${web}${hash || ''}"`).replace(/href="(privacy|terms|index)\.html"/g, (m, f) => `href="${web}${f}"`));
    });
  };
  app.get(['/', '/signin', '/signin.html'], signinPage);
  app.use((req, res, next) => { if (!['GET', 'HEAD'].includes(req.method)) return next(); res.setHeader('X-Content-Type-Options', 'nosniff'); site(req, res, next); });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((req, res) => res.status(404).sendFile(path.join(siteDir, '404.html'), (err) => { if (err) res.end(); }));
  return app;
}

// A small page for an address with no business behind it, or a paused one.
function notice(res, status, title, text, signin) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.5 system-ui,sans-serif;background:#0b1020;color:#e4e7eb;padding:16px}main{max-width:460px}h1{font-size:26px;margin:0 0 8px}a{color:#39ff88}</style></head>
<body><main><h1>${title}</h1><p>${text}</p><p><a href="${signin}">Go to Turas Lúbtha sign-in</a></p></main></body></html>`);
}

// The one request handler for the whole PC: picks the shared sign-in, a business, or the home app.
// The website's own addresses: turaslubtha.com, www.turaslubtha.com (and website.localhost on
// this PC). There, the first part of the path picks a business: turaslubtha.com/pinevalley.
function websiteHostsFor(domain) {
  const set = new Set(['website.localhost', domain, `www.${domain}`]);
  for (const h of String(process.env.WEBSITE_HOSTS || '').split(',')) {
    const host = h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host) { set.add(host); set.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`); }
  }
  return set;
}

function createRouter({ businesses, frontDoor, homeApp, domain, domains: domainsOf }) {
  const domains = domainsOf || (() => [domain]);
  const { mountAt } = require('./pathmount');
  const websiteHosts = websiteHostsFor(domain);
  const mounts = new Map(); // "/name" + app → handler
  const mounted = (base, app) => {
    const m = mounts.get(base);
    if (m && m.app === app) return m.handler;
    const handler = mountAt(base, app);
    mounts.set(base, { app, handler });
    return handler;
  };
  return (req, res) => {
    const host = hostOf(req);
    const url = String(req.url || '');
    delete req.tlBase;
    // The shared sign-in's form works from any address (the website's Sign in page, its preview).
    if (url.startsWith('/api/frontdoor/')) return frontDoor(req, res);
    // turaslubtha.com/<name>/…: a business, or this PC's own shuttle, under its own path.
    if (websiteHosts.has(host)) {
      const m = url.match(/^\/([a-z0-9-]{2,32})(?=\/|\?|$)/i);
      const name = m && m[1].toLowerCase();
      if (name && m[1] !== name && (businesses.row(name) || name === businesses.getMeta('home_slug'))) { // /PineValley → /pinevalley
        res.statusCode = 301; res.setHeader('Location', `/${name}${url.slice(name.length + 1)}`); return res.end();
      }
      if (name && name === businesses.getMeta('home_slug')) return mounted(`/${name}`, homeApp)(req, res);
      const b = name && businesses.row(name);
      if (b) {
        const signin = `/signin`;
        if (b.paused) return notice(res, 503, 'Paused', 'This business’s shuttle is paused right now. Contact Turas Lúbtha to turn it back on.', signin);
        let entry;
        try { entry = businesses.load(name); } catch (e) { console.error(`Opening ${name} failed:`, e.message); return notice(res, 500, 'Something went wrong', 'This shuttle couldn’t be opened. Try again in a minute.', signin); }
        return mounted(`/${name}`, entry.app)(req, res);
      }
      return homeApp(req, res); // the website itself
    }
    const r = routeOf(host, domains());
    if (r.front) return frontDoor(req, res);
    // This PC's own shuttle under its Turas Lúbtha name (Server → Businesses → This shuttle).
    if (r.slug && r.slug === businesses.getMeta('home_slug')) return homeApp(req, res);
    if (r.slug) {
      const signin = host.endsWith('.localhost') ? `http://app.localhost${portOf(req) ? `:${portOf(req)}` : ''}/` : `https://app.${domainFor(host, domains())}/`;
      const b = businesses.row(r.slug);
      if (!b) return notice(res, 404, 'No shuttle here', 'There’s no business at this address. Check the spelling, or sign in and we’ll take you to yours.', signin);
      if (b.paused) return notice(res, 503, 'Paused', 'This business’s shuttle is paused right now. Contact Turas Lúbtha to turn it back on.', signin);
      let entry;
      try { entry = businesses.load(r.slug); } catch (e) { console.error(`Opening ${r.slug} failed:`, e.message); return notice(res, 500, 'Something went wrong', 'This shuttle couldn’t be opened. Try again in a minute.', signin); }
      return entry.app(req, res);
    }
    return homeApp(req, res);
  };
}

// Everything the PC serves, wired together: the home shuttle, every hosted business (each with
// its own database and private messages) and the shared sign-in. server.js and the tests use this.
function createSite({ db, dataDir, domain, bus, openDb, createApp, homeOpts = {}, businessOpts = () => ({}), homeUrl, homeName = process.env.HOME_NAME || 'shuttle', log = () => {} }) {
  const { createBusinesses, scopedBus, checkName } = require('./businesses');
  const businesses = createBusinesses({
    dataDir, openDb, log,
    makeApp: (slug, bdb, file) => createApp(bdb, {
      ...businessOpts(slug, bdb, file),
      business: slug, superEmail: null, dbFile: file, bus: scopedBus(bus, slug),
      redeemHandoff: (t) => businesses.redeemHandoff(slug, t),
    }),
  });
  // This PC's own shuttle always has a Turas Lúbtha name (shuttle.turaslubtha.com unless one
  // was picked on Server → Businesses), so it can be reached there with no other address set up.
  if (!businesses.getMeta('home_slug') && homeName) {
    const c = checkName(homeName);
    if (!c.error && !businesses.row(c.slug)) businesses.setMeta('home_slug', c.slug);
  }
  if (bus.jobs) {
    businesses.loadAll(); // keep every business's background jobs running
    bus.on('businesses-changed', () => businesses.loadAll());
  }
  const urlOfHome = homeUrl || (() => {
    try { return (db.prepare("SELECT value FROM settings WHERE key = 'site_url'").get() || {}).value || process.env.PUBLIC_URL || ''; } catch { return ''; }
  });
  // Businesses live under the Turas Lúbtha domain, and also under the home shuttle's own
  // address (Settings → Web address), so they can be tried before that domain is set up.
  // The shuttle's own address comes from Settings → Web address, or else is remembered from
  // where a super admin opens Server → Businesses (businesses.rememberHome below).
  const usable = (h) => !!h && h !== domain && !h.endsWith(`.${domain}`) && h !== 'localhost' && !h.endsWith('.localhost')
    && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^[0-9.]+$/.test(h);
  const domains = () => {
    const out = [domain];
    for (const h of [hostOfUrl(urlOfHome()), businesses.getMeta('home_host')]) if (usable(h) && !out.includes(h)) out.push(h);
    return out;
  };
  const rememberHome = (host) => {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (usable(h) && businesses.getMeta('home_host') !== h) businesses.setMeta('home_host', h);
  };
  const homeApp = createApp(db, { ...homeOpts, bus, businesses, businessDomain: domain, businessDomains: domains, rememberHome, redeemHandoff: (t) => businesses.redeemHandoff('', t) });
  const frontDoor = createFrontDoor({ businesses, homeDb: db, domain, domains, homeUrl: urlOfHome });
  return { handler: createRouter({ businesses, frontDoor, homeApp, domain, domains }), businesses, homeApp, frontDoor, domains };
}

module.exports = { createFrontDoor, createRouter, createSite, routeOf, domainFor, websiteHostsFor, FRONT_NAMES };
