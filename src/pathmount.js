// Runs a whole shuttle app under a path, like turaslubtha.com/pinevalley, instead of at the
// root of its own address. The app itself still thinks it lives at "/": this strips the
// "/pinevalley" off each request and puts it back on everything that goes out:
//   - redirects (Location) and sign-in cookies (Path=/pinevalley, so each business keeps its own)
//   - links and pictures in pages, styles and scripts (href="/…", src="/…", url(/…))
//   - the app manifest (start page, icons)
// and a small script at the top of each page fixes the addresses that pages make up as they
// run (fetch, live updates, links added later, the background script).
const PREFIXED = /^(?:text\/html|text\/css|application\/javascript|text\/javascript|application\/manifest\+json)/i;

function prefixer(base) {
  return (u) => (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u !== base && !u.startsWith(`${base}/`) && !u.startsWith(`${base}?`) ? base + u : u);
}

// Runs first on every page: makes the page's own requests and links go under the base.
function shim(base) {
  const b = JSON.stringify(base);
  return `<script>(function(){var B=${b};function F(u){return typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u!==B&&u.indexOf(B+'/')!==0&&u.indexOf(B+'?')!==0?B+u:u}window.__tlBase=B;window.__tlFix=F;`
    + 'var f=window.fetch;if(f)window.fetch=function(i,o){return f.call(this,typeof i==="string"?F(i):i,o)};'
    + 'var E=window.EventSource;if(E){var N=function(u,o){return new E(F(u),o)};N.prototype=E.prototype;window.EventSource=N}'
    + 'var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=F(u);return X.apply(this,arguments)};'
    + 'if(navigator.sendBeacon){var S=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return S(F(u),d)}}'
    + 'if(navigator.serviceWorker){var R=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=function(u,o){o=Object.assign({},o||{});o.scope=F(o.scope||"/");return R(F(u),o)}}'
    + 'var A={a:"href",img:"src",form:"action",link:"href",iframe:"src",source:"src",image:"href"};'
    + 'function G(e){var a=e.tagName&&A[e.tagName.toLowerCase()];if(!a)return;var v=e.getAttribute(a),n=F(v);if(v&&n!==v)e.setAttribute(a,n)}'
    + 'new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="attributes")G(m.target);else m.addedNodes.forEach(function(n){if(n.nodeType===1){G(n);if(n.querySelectorAll)n.querySelectorAll("a,img,form,link,iframe,source").forEach(G)}})})})'
    + '.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["href","src","action"]});'
    + '})();</script>';
}

function rewrite(text, base, type) {
  const fix = prefixer(base);
  let out = text
    .replace(/(\b(?:href|src|action|poster)=)(["'])(\/(?!\/)[^"']*)\2/g, (m, a, q, u) => `${a}${q}${fix(u)}${q}`)
    .replace(/url\((["']?)(\/(?!\/)[^)"']*)\1\)/g, (m, q, u) => `url(${q}${fix(u)}${q})`);
  if (/manifest/i.test(type)) out = out.replace(/("(?:start_url|scope|src)"\s*:\s*")(\/[^"]*)"/g, (m, k, u) => `${k}${fix(u)}"`);
  if (/html/i.test(type)) out = out.replace(/<head(\s[^>]*)?>/i, (m) => m + shim(base));
  return out;
}

// handler(req, res) for an app (an Express app or any (req, res) function) living at base.
function mountAt(base, app) {
  const fix = prefixer(base);
  return (req, res) => {
    const rest = req.url.slice(base.length);
    if (rest === '' || rest.startsWith('?')) { // /pinevalley → /pinevalley/
      res.statusCode = 301; res.setHeader('Location', `${base}/${rest}`); return res.end();
    }
    req.url = rest;
    req.tlBase = base;
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      const k = String(name).toLowerCase();
      if (k === 'location') value = fix(String(value));
      else if (k === 'set-cookie') value = [].concat(value).map((c) => String(c).replace(/;\s*Path=\/(?=;|$)/i, `; Path=${base}`));
      return setHeader(name, value);
    };
    // Pages, styles, scripts and the manifest are collected, rewritten, then sent.
    const writeHead = res.writeHead.bind(res); const write = res.write.bind(res); const end = res.end.bind(res);
    let mode = null; let headArgs = null; const chunks = [];
    const decide = () => {
      if (mode) return mode;
      mode = req.method !== 'HEAD' && res.statusCode !== 304 && res.statusCode !== 204 && PREFIXED.test(String(res.getHeader('content-type') || '')) ? 'rewrite' : 'pass';
      return mode;
    };
    res.writeHead = (...args) => {
      // writeHead(status, headers) can carry headers too; apply them first so the type is known.
      const hdrs = args.find((a) => a && typeof a === 'object');
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
      const clean = args.filter((a) => !(a && typeof a === 'object'));
      if (decide() === 'rewrite') { headArgs = clean; return res; }
      return writeHead(...clean);
    };
    res.write = (chunk, enc, cb) => {
      if (decide() !== 'rewrite') return write(chunk, enc, cb);
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = (chunk, enc, cb) => {
      if (decide() !== 'rewrite') return end(chunk, enc, cb);
      if (chunk != null && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      const body = Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8'), base, String(res.getHeader('content-type') || '')), 'utf8');
      res.removeHeader('content-length');
      res.removeHeader('etag'); // the same file differs per business now
      setHeader('Content-Length', body.length);
      writeHead(...(headArgs || [res.statusCode]));
      return end(body, typeof enc === 'function' ? enc : cb);
    };
    return app(req, res);
  };
}

module.exports = { mountAt, rewrite, prefixer, shim };
