/* Shared helpers for every page. */
const App = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Talks to the server. Gives up after 20 s, and turns network trouble into plain words.
  // A banner appears while the server can't be reached and goes away when it's back.
  const OFFLINE = "Can't reach the shuttle server. Check your internet connection and try again.";
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
    } catch {
      connection(false);
      throw new Error(OFFLINE);
    }
    let data = {};
    try { data = await res.json(); } catch { /* not json (e.g. a Cloudflare error page) */ }
    // 502/503/504/530 come from Cloudflare when the shuttle server itself is off or unreachable.
    if ([502, 503, 504, 520, 521, 522, 523, 524, 530].includes(res.status)) { connection(false); throw new Error("The shuttle server isn't responding right now. It may be restarting. Try again in a minute."); }
    connection(true);
    if (res.status === 401 && !opts.allow401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}). Please try again.`);
    return data;
  }
  let offlineSince = null;
  function connection(ok) {
    if (ok) {
      offlineSince = null;
      const el = document.getElementById('netBanner'); if (el) el.remove();
      return;
    }
    offlineSince = offlineSince || Date.now();
    if (document.getElementById('netBanner') || !document.body) return;
    const el = document.createElement('div');
    el.id = 'netBanner'; el.className = 'net-banner'; el.setAttribute('role', 'status');
    el.textContent = "⚠️ Can't reach the shuttle server — showing the last information. Retrying…";
    document.body.appendChild(el);
  }
  window.addEventListener('online', () => { /* the next refresh clears the banner */ });
  window.addEventListener('offline', () => connection(false));

  // Ensures the visitor is signed in with one of the given roles (admin always allowed).
  async function requireUser(...roles) {
    const { user, settings, base_url } = await api('/api/me');
    App.baseUrl = base_url;
    if (!user) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('redirect'); }
    if (roles.length && !roles.includes(user.role) && user.role !== 'admin') { location.href = '/' + user.role; throw new Error('redirect'); }
    App.user = user; App.settings = settings;
    renderTopbar(user, settings);
    return user;
  }

  function renderTopbar(user, settings) {
    const el = $('#topbar'); if (!el) return;
    const links = [];
    if (user.role === 'admin') links.push(['/admin', 'Admin'], ['/advisor', 'Advisor'], ['/driver', 'Driver']);
    const nav = links.map(([href, label]) => `<a href="${href}" class="${location.pathname === href ? 'active' : ''}">${label}</a>`).join('');
    el.className = 'topbar';
    el.innerHTML = `
      <a class="brand" href="/"><span class="logo">🚐</span><span>Shuttle<small>${esc(settings.dealer_name)}</small></span></a>
      <nav>${nav}<button id="themeBtn" title="Light or dark screen"></button><button id="pwBtn" title="Change password">Password</button><button id="logoutBtn">Sign out</button></nav>
      <span class="who">${esc(user.name)} · ${esc(user.role)}</span>`;
    $('#logoutBtn').onclick = async () => { await api('/api/logout', { body: {} }); location.href = '/login'; };
    $('#pwBtn').onclick = changePassword;
    const paintTheme = () => { $('#themeBtn').textContent = { auto: '🌓 Auto', dark: '🌙 Dark', light: '☀️ Light' }[getTheme()]; };
    paintTheme();
    $('#themeBtn').onclick = () => { setTheme({ auto: 'dark', dark: 'light', light: 'auto' }[getTheme()]); paintTheme(); };
  }

  // Light / dark screen: 'auto' follows the device setting. Saved on this device only.
  function getTheme() {
    try { const t = localStorage.getItem('shuttle.theme'); return t === 'dark' || t === 'light' ? t : 'auto'; } catch { return 'auto'; }
  }
  function setTheme(t) {
    try { if (t === 'auto') localStorage.removeItem('shuttle.theme'); else localStorage.setItem('shuttle.theme', t); } catch { /* storage blocked */ }
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  }

  function changePassword() {
    const m = modal(`
      <h2>Change password</h2>
      <form id="pwForm">
        <label>Current password</label><input type="password" name="current" required autocomplete="current-password">
        <label>New password (8+ characters)</label><input type="password" name="next" required minlength="8" autocomplete="new-password">
        <div class="msg"></div>
        <div class="actions"><button>Save</button><button type="button" class="btn-ghost" data-close>Cancel</button></div>
      </form>`);
    $('#pwForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('/api/me/password', { body: f }); flash($('.msg', m), 'Password changed.', true); setTimeout(() => m.remove(), 900); }
      catch (err) { flash($('.msg', m), err.message); }
    };
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) back.remove(); });
    document.body.appendChild(back);
    return back;
  }

  function flash(el, msg, ok = false) {
    if (!el) return alert(msg);
    el.innerHTML = msg ? `<div class="alert ${ok ? 'alert-ok' : 'alert-err'}">${esc(msg)}</div>` : '';
  }

  // ---------- formatting ----------
  const STATUS_LABEL = { requested: 'Waiting', assigned: 'Assigned', en_route: 'Driver en route', onboard: 'On board', completed: 'Completed', cancelled: 'Cancelled' };
  const TYPE_LABEL = { pickup: 'Pick up', dropoff: 'Drop off' };
  function fmtTime(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return today ? t : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
  }
  function relTime(iso) {
    const m = Math.round((new Date(iso) - Date.now()) / 60000);
    if (Math.abs(m) < 1) return 'now';
    if (m < 0) return `<span class="late">${-m} min late</span>`;
    if (m < 90) return `in ${m} min`;
    return `in ${Math.round(m / 60)} hr`;
  }
  const statusBadge = (s) => `<span class="badge s-${s}">${STATUS_LABEL[s] || s}</span>`;
  const typeBadge = (t) => `<span class="badge b-${t}">${TYPE_LABEL[t] || t}</span>`;
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function directionsUrl(ride) {
    const dest = ride.lat != null ? `${ride.lat},${ride.lng}` : ride.address;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  }
  function telLink(phone) { return phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null; }

  // ---------- maps (Leaflet + OpenStreetMap) ----------
  function makeMap(el, center, zoom = 12) {
    const map = L.map(el, { scrollWheelZoom: true }).setView([center.lat, center.lng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    return map;
  }
  function pinIcon(kind, label = '') {
    return L.divIcon({ className: '', html: `<div class="pin pin-${kind}"><span>${esc(label)}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24] });
  }
  const carIcon = () => L.divIcon({ className: '', html: '<div class="car">🚐</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
  function dealerMarker(map, s) {
    // Dashed circle = the shuttle's service area (when a limit is set).
    const radius = Number(s.service_radius_mi) || 0;
    if (radius > 0) {
      L.circle([Number(s.dealer_lat), Number(s.dealer_lng)], {
        radius: radius * 1609.344, color: '#eb0a1e', weight: 2, dashArray: '6 6', fillOpacity: 0.04, interactive: false,
      }).addTo(map);
    }
    return L.marker([Number(s.dealer_lat), Number(s.dealer_lng)], { icon: pinIcon('dealer', 'T'), zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(s.dealer_name)}</b><br>${esc(s.dealer_address)}`).addTo(map);
  }

  // Miles from the dealership, and a short note for under an address box.
  function milesFromDealer(lat, lng, s = App.settings) {
    const toRad = (d) => (d * Math.PI) / 180;
    const aLat = Number(s.dealer_lat); const aLng = Number(s.dealer_lng);
    const h = Math.sin(toRad(lat - aLat) / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(lat)) * Math.sin(toRad(lng - aLng) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h)) * 0.621371;
  }
  function distanceNote(lat, lng, s = App.settings) {
    const mi = milesFromDealer(lat, lng, s); const max = Number(s.service_radius_mi) || 0;
    if (max > 0 && mi > max) {
      const admin = App.user && App.user.role === 'admin';
      return { ok: false, text: `⚠️ ${mi.toFixed(1)} miles from the dealership. That's outside the ${max}-mile shuttle area.${admin ? ' As an admin you can still book it.' : ''}` };
    }
    return { ok: true, text: `📍 Spot marked · ${mi.toFixed(1)} miles from the dealership` };
  }

  // Shows open rides + on-duty drivers on a map layer. Returns a function to refresh.
  function ridesLayer(map) {
    const layer = L.layerGroup().addTo(map);
    let fitted = false;
    return (rides, drivers = [], { fit = true } = {}) => {
      layer.clearLayers();
      const pts = [];
      for (const r of rides) {
        if (r.lat == null) continue;
        const kind = r.rank === 1 ? 'first' : r.type;
        L.marker([r.lat, r.lng], { icon: pinIcon(kind, r.rank || '') })
          .bindPopup(`<b>${esc(r.customer_name)}</b><br>${TYPE_LABEL[r.type]} · ${fmtTime(r.scheduled_at)}<br>${esc(r.address)}<br>${STATUS_LABEL[r.status]}${r.driver_name ? ' · ' + esc(r.driver_name) : ''}`)
          .addTo(layer);
        pts.push([r.lat, r.lng]);
      }
      for (const d of drivers) {
        if (d.last_lat == null || !d.on_duty) continue;
        L.marker([d.last_lat, d.last_lng], { icon: carIcon(), zIndexOffset: 500 })
          .bindPopup(`<b>${esc(d.name)}</b><br>${esc(d.vehicle_name || '')}<br><span class="small">seen ${fmtTime(d.last_loc_at)}</span>`).addTo(layer);
        pts.push([d.last_lat, d.last_lng]);
      }
      if (fit && !fitted && pts.length) {
        pts.push([Number(App.settings.dealer_lat), Number(App.settings.dealer_lng)]);
        map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 });
        fitted = true;
      }
    };
  }

  // Address box with search + "drop a pin on the map" fallback.
  function addressPicker({ input, results, map, onPick, geocodePath = '/api/geocode' }) {
    let marker = null; let timer = null;
    function place(lat, lng, label) {
      if (marker) marker.setLatLng([lat, lng]);
      else marker = L.marker([lat, lng], { icon: pinIcon('new', '★'), draggable: true }).addTo(map)
        .on('dragend', () => { const p = marker.getLatLng(); onPick({ lat: p.lat, lng: p.lng }); });
      map.setView([lat, lng], Math.max(map.getZoom(), 14));
      onPick({ lat, lng, label });
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const qv = input.value.trim();
      if (qv.length < 4) { results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const { results: list, error } = await api(`${geocodePath}?q=${encodeURIComponent(qv)}`);
          results.innerHTML = error ? `<div class="small muted">${esc(error)}</div>` : list.map((r, i) =>
            `<button type="button" class="btn-ghost btn-sm btn-block" style="justify-content:flex-start;white-space:normal;text-align:left;margin-top:.25rem" data-i="${i}">${esc(r.label)}</button>`).join('');
          $$('button', results).forEach((b) => b.onclick = () => {
            const r = list[b.dataset.i];
            input.value = r.label.split(', ').slice(0, 4).join(', ');
            results.innerHTML = '';
            place(r.lat, r.lng, r.label);
          });
        } catch { /* ignore */ }
      }, 450);
    });
    map.on('click', (e) => place(e.latlng.lat, e.latlng.lng));
    return {
      reset() { if (marker) { marker.remove(); marker = null; } results.innerHTML = ''; },
      set(lat, lng) { if (lat != null) place(lat, lng); },
    };
  }

  // ---------- share links + QR ----------
  function share({ title, url, phone, email, message }) {
    const text = message || `${title}: ${url}`;
    const sms = phone ? `sms:${phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}` : `sms:?&body=${encodeURIComponent(text)}`;
    const mail = `mailto:${email || ''}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
    const qr = `/api/qr?size=480&text=${encodeURIComponent(url)}`;
    const m = modal(`
      <h2>${esc(title)}</h2>
      <p class="muted small">Send this link by text or email, or let the customer scan the QR code.</p>
      <img class="qr" src="${qr}" alt="QR code">
      <div class="linkbox"><input readonly value="${esc(url)}"><button class="btn-dark btn-sm" data-copy>Copy</button></div>
      <div class="actions">
        <a class="btn btn-blue" href="${sms}">💬 Text${phone ? ' ' + esc(phone) : ''}</a>
        <a class="btn btn-ghost" href="${mail}">✉️ Email</a>
        <a class="btn btn-ghost" href="${qr}" download="shuttle-qr.png">⬇ QR</a>
        ${navigator.share ? '<button class="btn-ghost" data-native>Share…</button>' : ''}
        <button class="btn-ghost" data-close>Close</button>
      </div>`);
    $('[data-copy]', m).onclick = async (e) => {
      try { await navigator.clipboard.writeText(url); } catch { $('input', m).select(); document.execCommand('copy'); }
      e.target.textContent = 'Copied!';
    };
    const nat = $('[data-native]', m);
    if (nat) nat.onclick = () => navigator.share({ title, text: message || title, url }).catch(() => {});
  }

  // Asks for a cancel reason, then cancels the ride. Resolves true if it was cancelled.
  const CANCEL_REASONS = ['Customer no-show', 'Customer cancelled', 'Customer found another ride',
    "Can't find the address / customer", 'Shuttle or vehicle problem', 'Duplicate ride', 'Other'];
  function cancelRide(ride) {
    return new Promise((resolve) => {
      const m = modal(`
        <h2>Cancel ride for ${esc(ride.customer_name)}?</h2>
        <p class="muted small">${TYPE_LABEL[ride.type]} · ${fmtTime(ride.scheduled_at)} · ${esc(ride.address)}</p>
        <form>
          <label>Reason *</label>
          <div class="reasons">${CANCEL_REASONS.map((r, i) => `<label class="check"><input type="radio" name="pick" value="${esc(r)}" ${i === 0 ? 'required' : ''}> ${esc(r)}</label>`).join('')}</div>
          <label>Details <span class="muted">(required for “Other”)</span></label>
          <textarea name="details" maxlength="400" placeholder="e.g. Waited 10 min, called twice, no answer"></textarea>
          <div class="msg"></div>
          <div class="actions"><button class="btn-dark">Cancel ride</button><button type="button" class="btn-ghost" data-close>Keep ride</button></div>
        </form>`);
      const form = $('form', m);
      const done = (v) => { m.remove(); resolve(v); };
      m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) resolve(false); });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const pick = form.elements.pick.value;
        const details = form.elements.details.value.trim();
        if (pick === 'Other' && details.length < 3) return flash($('.msg', m), 'Please describe the reason.');
        const reason = details ? (pick === 'Other' ? details : `${pick}: ${details}`) : pick;
        try { await api(`/api/rides/${ride.id}`, { method: 'PATCH', body: { status: 'cancelled', cancel_reason: reason } }); done(true); }
        catch (err) { flash($('.msg', m), err.message); }
      };
    });
  }

  function cancelNote(r) {
    if (r.status !== 'cancelled' || !r.cancel_reason) return '';
    return `<div class="cancel-note">❌ Cancelled${r.cancelled_by_name ? ' by ' + esc(r.cancelled_by_name) : ''}${r.cancelled_at ? ' at ' + fmtTime(r.cancelled_at) : ''}: ${esc(r.cancel_reason)}</div>`;
  }

  function rideMessage(ride) {
    const dealer = App.settings?.dealer_name || 'the dealership';
    const what = ride.type === 'pickup' ? 'shuttle pick up' : 'shuttle ride';
    return `Hi ${ride.customer_name.split(' ')[0]}, your ${dealer} ${what} is scheduled for ${fmtTime(ride.scheduled_at)}. Track your driver here: ${ride.track_url}`;
  }

  // "Show: All / Pick ups / Drop offs" buttons. Remembers the choice on this device.
  // apply(list) updates the counts and returns the rides to show.
  function typeChips(el, storageKey, onChange) {
    let value = 'all';
    try { value = localStorage.getItem(storageKey) || 'all'; } catch { /* storage blocked */ }
    if (!['all', 'pickup', 'dropoff'].includes(value)) value = 'all';
    el.classList.add('chips'); el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Show ride type');
    el.innerHTML = '<span class="small muted">Show:</span>' + [['all', 'All'], ['pickup', '⬆ Pick ups'], ['dropoff', '⬇ Drop offs']]
      .map(([k, l]) => `<button type="button" data-type="${k}">${l} <span data-count="${k}"></span></button>`).join('');
    const paint = () => $$('[data-type]', el).forEach((b) => b.classList.toggle('active', b.dataset.type === value));
    paint();
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]'); if (!b) return;
      value = b.dataset.type; paint();
      try { localStorage.setItem(storageKey, value); } catch { /* storage blocked */ }
      onChange(value);
    });
    return {
      get value() { return value; },
      apply(list) {
        for (const t of ['all', 'pickup', 'dropoff']) $(`[data-count="${t}"]`, el).textContent = `(${list.filter((x) => t === 'all' || x.type === t).length})`;
        return value === 'all' ? list : list.filter((x) => x.type === value);
      },
    };
  }

  // ---------- live driver map ----------
  // Van icon with the driver's name and an arrow for the direction they're heading.
  // Greyed out when the phone hasn't reported in for 2 minutes.
  const ROUTE_COLORS = ['#1a73e8', '#9c27b0', '#00897b', '#f4511e', '#6d4c41', '#3949ab'];
  function vanIcon(d, stale) {
    const arrow = d.heading != null && (d.speed == null || d.speed > 0.8)
      ? `<span class="van-arrow" style="transform:rotate(${Math.round(d.heading)}deg)">▲</span>` : '';
    return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -14],
      html: `<div class="van ${stale ? 'van-stale' : ''}">${arrow}<span class="car">🚐</span><span class="van-name">${esc((d.name || '').split(' ')[0])}</span></div>` });
  }
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : fmtTime(iso);
  };
  // Glide a marker to its new spot instead of jumping.
  function glide(marker, to, ms = 1200) {
    const from = marker.getLatLng(); const t0 = performance.now();
    if (marker._glide) cancelAnimationFrame(marker._glide);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      marker.setLatLng([from.lat + (to[0] - from.lat) * k, from.lng + (to[1] - from.lng) * k]);
      if (k < 1) marker._glide = requestAnimationFrame(step);
    };
    marker._glide = requestAnimationFrame(step);
  }
  // Keeps on-duty drivers (and their planned routes) up to date on a map, every few seconds.
  function liveDrivers(map, { exclude = null, routes = true, every = 5000, onUpdate = null } = {}) {
    const markers = new Map(); const lines = new Map(); let latest = [];
    async function tick() {
      const { drivers } = await api('/api/drivers/live');
      latest = drivers;
      const seen = new Set();
      drivers.forEach((d, i) => {
        if (d.id === exclude) return;
        if (d.lat != null) {
          seen.add(d.id);
          const stale = !d.at || Date.now() - new Date(d.at) > 120000;
          const popup = `<b>${esc(d.name)}</b>${d.vehicle_name ? `<br>${esc(d.vehicle_name)}` : ''}<br><span class="small">${stale ? '⚠️ ' : ''}location ${d.at ? ago(d.at) : 'unknown'}${d.speed != null && !stale ? ` · ${Math.round(d.speed * 2.237)} mph` : ''}</span>${d.route ? `<br><span class="small">${d.route.stops.filter((x) => x.ride_id).length} stop(s) planned · back about ${fmtTime(d.route.finish_at)}</span>` : ''}`;
          let m = markers.get(d.id);
          if (!m) { m = L.marker([d.lat, d.lng], { icon: vanIcon(d, stale), zIndexOffset: 600 }).bindPopup(popup).addTo(map); markers.set(d.id, m); }
          else { m.setIcon(vanIcon(d, stale)); m.setPopupContent(popup); glide(m, [d.lat, d.lng]); }
        }
        const old = lines.get(d.id);
        if (old) { old.remove(); lines.delete(d.id); }
        if (routes && d.route && d.route.path && d.route.path.length > 1) {
          const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
          lines.set(d.id, L.polyline(d.route.path, { color, weight: 4, opacity: 0.55, dashArray: d.route.source === 'roads' ? null : '6 8' })
            .bindPopup(`<b>${esc(d.name)}'s route</b><br>${d.route.stops.map((x, n) => `${n + 1}. ${esc(x.label)} · ${fmtTime(x.eta)}`).join('<br>')}`).addTo(map));
        }
      });
      for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
      for (const [id, l] of lines) if (!drivers.some((d) => d.id === id && d.route)) { l.remove(); lines.delete(id); }
      if (onUpdate) onUpdate(drivers);
    }
    poll(tick, every);
    return { get drivers() { return latest; }, points: () => [...markers.values()].map((m) => m.getLatLng()) };
  }

  // Google Maps directions through several stops (it takes up to 10 points from a phone).
  function routeUrl(stops) {
    const pts = stops.slice(0, 10).map((x) => `${x.lat},${x.lng}`);
    const dest = pts.pop();
    return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(dest)}${pts.length ? `&waypoints=${encodeURIComponent(pts.join('|'))}` : ''}`;
  }

  // Runs fn now and every ms. Pauses while the page is hidden unless background is true.
  function poll(fn, ms, { background = false } = {}) {
    const run = () => Promise.resolve().then(fn).catch(() => { /* try again next time */ });
    run();
    let id = setInterval(run, ms);
    document.addEventListener('visibilitychange', () => {
      if (background) { if (!document.hidden) run(); return; }
      clearInterval(id);
      if (!document.hidden) { run(); id = setInterval(run, ms); }
    });
  }

  return {
    esc, $, $$, api, requireUser, modal, flash, fmtTime, relTime, statusBadge, typeBadge, toLocalInput,
    directionsUrl, telLink, cancelRide, cancelNote, makeMap, pinIcon, carIcon, dealerMarker, ridesLayer, addressPicker, share, rideMessage, poll, liveDrivers, routeUrl, glide, vanIcon, typeChips, milesFromDealer, distanceNote,
    STATUS_LABEL, TYPE_LABEL,
  };
})();
