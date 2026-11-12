/* Shared helpers for every page. */
const App = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 401 && !opts.allow401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

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
      <nav>${nav}<button id="pwBtn" title="Change password">Password</button><button id="logoutBtn">Sign out</button></nav>
      <span class="who">${esc(user.name)} · ${esc(user.role)}</span>`;
    $('#logoutBtn').onclick = async () => { await api('/api/logout', { body: {} }); location.href = '/login'; };
    $('#pwBtn').onclick = changePassword;
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
    return L.marker([Number(s.dealer_lat), Number(s.dealer_lng)], { icon: pinIcon('dealer', 'T'), zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(s.dealer_name)}</b><br>${esc(s.dealer_address)}`).addTo(map);
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

  function poll(fn, ms) {
    fn();
    let id = setInterval(fn, ms);
    document.addEventListener('visibilitychange', () => {
      clearInterval(id);
      if (!document.hidden) { fn(); id = setInterval(fn, ms); }
    });
  }

  return {
    esc, $, $$, api, requireUser, modal, flash, fmtTime, relTime, statusBadge, typeBadge, toLocalInput,
    directionsUrl, telLink, cancelRide, cancelNote, makeMap, pinIcon, carIcon, dealerMarker, ridesLayer, addressPicker, share, rideMessage, poll,
    STATUS_LABEL, TYPE_LABEL,
  };
})();
