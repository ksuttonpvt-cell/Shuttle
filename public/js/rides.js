/* Ride form + ride cards used by the advisor and admin pages. */
const Rides = (() => {
  const { esc, $, $$, api, fmtTime, relTime, statusBadge, typeBadge, toLocalInput } = App;

  function formHtml(r = {}) {
    const when = r.scheduled_at ? new Date(r.scheduled_at) : new Date(Date.now() + 30 * 60000);
    const type = r.type || 'pickup';
    return `
      <div class="seg">
        <input type="radio" name="type" value="pickup" id="t-pu-${r.id || 'n'}" ${type === 'pickup' ? 'checked' : ''}><label for="t-pu-${r.id || 'n'}">⬆ Pick up<br><span class="small">customer → dealership</span></label>
        <input type="radio" name="type" value="dropoff" id="t-do-${r.id || 'n'}" ${type === 'dropoff' ? 'checked' : ''}><label for="t-do-${r.id || 'n'}">⬇ Drop off<br><span class="small">dealership → customer</span></label>
      </div>
      <div class="row">
        <div><label>Customer name *</label><input name="customer_name" required value="${esc(r.customer_name)}"></div>
        <div><label>Mobile phone</label><input name="customer_phone" type="tel" value="${esc(r.customer_phone)}"></div>
      </div>
      <label>Email</label><input name="customer_email" type="email" value="${esc(r.customer_email)}">
      <label data-addr-label>Address *</label>
      <input name="address" required autocomplete="off" placeholder="Start typing, or tap the map" value="${esc(r.address)}">
      <div data-results></div>
      <input type="hidden" name="lat" value="${r.lat ?? ''}"><input type="hidden" name="lng" value="${r.lng ?? ''}">
      <div class="map map-sm" data-map style="margin-top:.5rem"></div>
      <div class="small muted" data-pinmsg>${r.lat != null ? '📍 Location set' : 'Tip: tap the map to drop an exact pin.'}</div>
      <div class="row">
        <div><label>Date &amp; time *</label><input name="scheduled_at" type="datetime-local" required value="${toLocalInput(when)}"></div>
        <div><label>Passengers</label><input name="passengers" type="number" min="1" max="15" value="${r.passengers || 1}"></div>
      </div>
      <label>Notes for the driver</label><textarea name="notes" placeholder="Gate code, which door, wheelchair, car seat…">${esc(r.notes)}</textarea>
      <label class="check"><input type="checkbox" name="priority" value="urgent" ${r.priority === 'urgent' ? 'checked' : ''}> Urgent — move to the front of the line</label>`;
  }

  // Wires up map + address search inside a form. Returns a reset function.
  function wireForm(form) {
    const map = App.makeMap($('[data-map]', form), { lat: Number(App.settings.dealer_lat), lng: Number(App.settings.dealer_lng) }, 12);
    App.dealerMarker(map, App.settings);
    const picker = App.addressPicker({
      input: form.elements.address, results: $('[data-results]', form), map,
      onPick: ({ lat, lng }) => {
        form.elements.lat.value = lat.toFixed(6); form.elements.lng.value = lng.toFixed(6);
        const note = App.distanceNote(lat, lng);
        const el = $('[data-pinmsg]', form);
        el.textContent = note.text; el.classList.toggle('late', !note.ok);
      },
    });
    if (form.elements.lat.value) picker.set(Number(form.elements.lat.value), Number(form.elements.lng.value));
    // Typing a new address clears the old pin, so a stale location is never saved.
    form.elements.address.addEventListener('input', () => {
      form.elements.lat.value = ''; form.elements.lng.value = '';
      $('[data-pinmsg]', form).textContent = 'Pick a search result or tap the map to set the exact spot.';
    });
    setTimeout(() => map.invalidateSize(), 200);
    return { map, reset() { picker.reset(); $('[data-pinmsg]', form).textContent = 'Tip: tap the map to drop an exact pin.'; } };
  }

  function formData(form) {
    const f = Object.fromEntries(new FormData(form));
    f.priority = form.elements.priority.checked ? 'urgent' : 'normal';
    f.scheduled_at = new Date(f.scheduled_at).toISOString();
    if (!f.lat) { f.lat = null; f.lng = null; }
    return f;
  }

  function card(r, { drivers = [], mode = 'staff' } = {}) {
    const open = !['completed', 'cancelled'].includes(r.status);
    const driverOpts = drivers.map((d) => `<option value="${d.id}" ${d.id === r.driver_id ? 'selected' : ''}>${esc(d.name)}${d.on_duty ? ' (on duty' + (d.vehicle_name ? ', ' + esc(d.vehicle_name) : '') + ')' : ' (off duty)'}</option>`).join('');
    return `
      <div class="ride ${r.rank === 1 ? 'first' : ''}" data-id="${r.id}">
        <div class="ride-top">
          <div>
            ${r.rank ? `<span class="rank" title="Queue position">${r.rank}</span>` : ''}
            <span class="ride-name">${esc(r.customer_name)}</span>
            ${r.priority === 'urgent' ? '<span class="badge b-urgent">Urgent</span>' : ''}
          </div>
          <div>${typeBadge(r.type)} ${statusBadge(r.status)}</div>
        </div>
        <div class="ride-meta">
          <div>🕒 ${fmtTime(r.scheduled_at)} ${open ? '· ' + relTime(r.scheduled_at) : ''} · ${r.passengers} pax</div>
          <div>📍 ${esc(r.address)}${r.distance_mi != null ? ` · ${r.distance_mi} mi` : ''}${r.lat == null ? ' <span class="late">(no map pin)</span>' : ''}</div>
          ${r.customer_phone ? `<div>📞 <a href="${App.telLink(r.customer_phone)}">${esc(r.customer_phone)}</a></div>` : ''}
          ${r.notes ? `<div>📝 ${esc(r.notes)}</div>` : ''}
          <div>👤 Advisor: ${esc(r.advisor_name || (r.source === 'customer' ? 'Customer request' : '—'))}
            ${r.driver_name ? ` · 🚐 ${esc(r.driver_name)}${r.vehicle_name ? ' in ' + esc(r.vehicle_name) : ''}` : ''}</div>
        </div>
        ${App.cancelNote(r)}
        ${open && mode === 'staff' ? `
        <div class="actions">
          <select data-assign style="width:auto;flex:1;min-width:150px"><option value="">— Assign driver —</option>${driverOpts}</select>
          <button class="btn-blue btn-sm" data-share>Send link / QR</button>
          <button class="btn-ghost btn-sm" data-edit>Edit</button>
          <button class="btn-ghost btn-sm" data-cancel>Cancel ride</button>
        </div>` : ''}
        ${!open && mode === 'staff' ? `<div class="actions"><button class="btn-ghost btn-sm" data-share>Link / QR</button></div>` : ''}
      </div>`;
  }

  // Attach handlers for the staff action buttons inside a container.
  function bind(container, getRide, refresh) {
    container.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-assign]'); if (!sel) return;
      const id = Number(sel.closest('[data-id]').dataset.id);
      try { await api(`/api/rides/${id}`, { method: 'PATCH', body: { driver_id: sel.value ? Number(sel.value) : null } }); refresh(); }
      catch (err) { alert(err.message); refresh(); }
    });
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const host = btn.closest('[data-id]'); if (!host) return;
      const ride = getRide(Number(host.dataset.id)); if (!ride) return;
      if (btn.hasAttribute('data-share')) {
        App.share({ title: `Shuttle tracking for ${ride.customer_name}`, url: ride.track_url, phone: ride.customer_phone, email: ride.customer_email, message: App.rideMessage(ride) });
      } else if (btn.hasAttribute('data-cancel')) {
        if (await App.cancelRide(ride)) refresh();
      } else if (btn.hasAttribute('data-edit')) {
        edit(ride, refresh);
      }
    });
  }

  function edit(ride, refresh) {
    const m = App.modal(`<h2>Edit ride</h2><form>${formHtml(ride)}<div class="msg"></div>
      <div class="actions"><button>Save changes</button><button type="button" class="btn-ghost" data-close>Close</button></div></form>`);
    $('.modal', m).style.maxWidth = '560px';
    const form = $('form', m);
    wireForm(form);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/rides/${ride.id}`, { method: 'PATCH', body: formData(form) }); m.remove(); refresh(); }
      catch (err) { App.flash($('.msg', m), err.message); }
    };
  }

  return { formHtml, wireForm, formData, card, bind, edit };
})();
