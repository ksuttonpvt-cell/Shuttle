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
      <label class="check"><input type="checkbox" name="priority" value="urgent" ${r.priority === 'urgent' ? 'checked' : ''}> Urgent — move to the front of the line</label>
      <div data-urgent-wrap ${r.priority === 'urgent' ? '' : 'hidden'}><label>Why is it urgent? *</label><input name="urgent_reason" maxlength="300" value="${esc(r.urgent_reason)}" placeholder="e.g. Customer has a flight at 2 PM"></div>`;
  }

  // "Which service advisor is this customer with?" (BDC books rides for advisors).
  function advisorPick(advisors, current = '', required = true) {
    if (!advisors || !advisors.length) return '';
    return `<label>Service advisor${required ? ' *' : ''}</label>
      <select name="advisor_id" ${required ? 'required' : ''}>
        <option value="">— Pick the customer's advisor —</option>
        ${advisors.map((a) => `<option value="${a.id}" ${a.id === Number(current) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select>
      <div class="small muted">They get a notification that this ride is theirs.</div>`;
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
    // Urgent needs a reason: show the box and make it required only when urgent is picked.
    const syncUrgent = (focus = true) => {
      const pr = form.elements.priority;
      const urgent = pr instanceof RadioNodeList ? pr.value === 'urgent' : pr.checked;
      const wrap = $('[data-urgent-wrap]', form);
      wrap.hidden = !urgent; form.elements.urgent_reason.required = urgent;
      if (focus && urgent && !form.elements.urgent_reason.value) setTimeout(() => form.elements.urgent_reason.focus(), 30);
    };
    form.addEventListener('change', (e) => { if (e.target.name === 'priority') syncUrgent(); });
    syncUrgent(false); // a ride that's already urgent needs its reason kept
    setTimeout(() => map.invalidateSize(), 200);
    return { map, syncUrgent, reset() { picker.reset(); $('[data-pinmsg]', form).textContent = 'Tip: tap the map to drop an exact pin.'; } };
  }

  // New-ride form for advisors, one question at a time:
  // ride type -> customer -> location -> time & people -> urgent or regular (+ notes, review).
  function stepFormHtml({ advisors = null } = {}) {
    const when = new Date(Date.now() + 30 * 60000);
    return `
      <div class="progress" data-progress></div>
      <section data-step="type" data-title="Ride" data-auto>
        <h3 class="step-q">Is this a pick up or a drop off?</h3>
        <div class="seg" hidden>
          <input type="radio" name="type" value="pickup" id="t-pu-n" checked><label for="t-pu-n">Pick up</label>
          <input type="radio" name="type" value="dropoff" id="t-do-n"><label for="t-do-n">Drop off</label>
        </div>
        <div class="choice-grid">
          <button type="button" class="choice" data-choose="pickup" data-next-on-click><span class="choice-icon">⬆</span><b>Pick up</b><span>Bring the customer to the dealership</span></button>
          <button type="button" class="choice" data-choose="dropoff" data-next-on-click><span class="choice-icon">⬇</span><b>Drop off</b><span>Take the customer from the dealership</span></button>
        </div>
      </section>
      <section data-step="customer" data-title="Customer" hidden>
        <h3 class="step-q">Customer name and phone</h3>
        <label>Customer name *</label><input name="customer_name" required autocomplete="off">
        <label>Mobile phone</label><input name="customer_phone" type="tel" autocomplete="off" placeholder="For the tracking link and texts">
        <label>Email</label><input name="customer_email" type="email" autocomplete="off">
        ${advisorPick(advisors)}
      </section>
      <section data-step="where" data-title="Location" hidden>
        <h3 class="step-q" data-addr-label>Where are we picking them up?</h3>
        <input name="address" required autocomplete="off" placeholder="Start typing an address, or tap the map">
        <div data-results></div>
        <input type="hidden" name="lat"><input type="hidden" name="lng">
        <div class="map map-sm" data-map style="margin-top:.5rem"></div>
        <div class="small muted" data-pinmsg>Tip: tap the map to drop an exact pin.</div>
      </section>
      <section data-step="when" data-title="Time &amp; people" hidden>
        <div class="chips" style="margin:0 0 .3rem">
          <button type="button" data-in="0">Now</button><button type="button" data-in="15">In 15 min</button>
          <button type="button" data-in="30">In 30 min</button><button type="button" data-in="60">In 1 hour</button>
        </div>
        <div class="row">
          <div><label>Date &amp; time *</label><input name="scheduled_at" type="datetime-local" required value="${toLocalInput(when)}"></div>
          <div><label>People riding</label><input name="passengers" type="number" min="1" max="15" value="1" inputmode="numeric"></div>
        </div>
        <div class="alert alert-warn small" data-wait-note hidden></div>
      </section>
      <section data-step="priority" data-title="Urgent?" hidden>
        <h3 class="step-q">Is it urgent, or do they just need a ride?</h3>
        <div class="choice-grid">
          <label class="choice choice-radio"><input type="radio" name="priority" value="normal" checked><span class="choice-icon">🙂</span><b>Just needs a ride</b><span>Goes in line by time</span></label>
          <label class="choice choice-radio"><input type="radio" name="priority" value="urgent"><span class="choice-icon">🚨</span><b>Urgent</b><span>Move to the front of the line</span></label>
        </div>
        <div data-urgent-wrap hidden><label>Why is it urgent? *</label><input name="urgent_reason" maxlength="300" placeholder="e.g. Customer has a flight at 2 PM"></div>
        <label>Notes for the driver</label><textarea name="notes" placeholder="Gate code, which door, wheelchair, car seat…"></textarea>
        <div class="review" data-summary></div>
      </section>`;
  }

  function formData(form) {
    const f = Object.fromEntries(new FormData(form));
    const pr = form.elements.priority;
    f.priority = (pr instanceof RadioNodeList ? pr.value === 'urgent' : pr.checked) ? 'urgent' : 'normal';
    f.scheduled_at = new Date(f.scheduled_at).toISOString();
    if (!f.lat) { f.lat = null; f.lng = null; }
    if (f.advisor_id === undefined || f.advisor_id === '') delete f.advisor_id; else f.advisor_id = Number(f.advisor_id);
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
          ${r.customer_phone ? `<div>📞 <a href="${App.telLink(r.customer_phone)}" data-call-ride="${r.id}">${esc(r.customer_phone)}</a>
            · <a href="sms:${r.customer_phone.replace(/[^\d+]/g, '')}" data-text-ride="${r.id}" data-name="${esc(r.customer_name.split(' ')[0])}">Text</a></div>` : ''}
          ${r.priority === 'urgent' && r.urgent_reason ? `<div class="urgent-why">🚨 Urgent: ${esc(r.urgent_reason)}</div>` : ''}
          ${r.notes ? `<div>📝 ${esc(r.notes)}</div>` : ''}
          ${r.arrived_at && ['assigned', 'en_route'].includes(r.status) ? `<div class="arrived-note">📍 Driver is there since ${fmtTime(r.arrived_at)}${r.customer_reply ? ` · ${r.customer_reply === 'coming' ? '👋 customer is coming out' : '⏳ customer needs 5 more min'}` : ''}</div>` : ''}
          <div>👤 Advisor: ${esc(r.advisor_name || (r.source === 'customer' ? 'Customer request' : '—'))}${r.booked_by_name && r.booked_by !== r.advisor_id ? ` <span class="muted">· 📞 booked by ${esc(r.booked_by_name.split(' ')[0])}${r.booked_by_team === 'bdc' ? ' (BDC)' : ''}</span>` : ''}
            ${r.driver_name ? ` · 🚐 ${esc(r.driver_name)}${r.vehicle_name ? ' in ' + esc(r.vehicle_name) : ''}` : ''}${!r.driver_id && r.offered_to ? ` · ⏳ Offered to ${esc(r.offered_to)}, waiting for an answer` : ''}</div>
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
        ${mode === 'bdc' ? `<div class="actions">
          <button class="btn-blue btn-sm" data-share>📱 Send tracking link</button>
          ${open ? '<button class="btn-ghost btn-sm" data-edit>Edit</button><button class="btn-ghost btn-sm" data-cancel>Cancel ride</button>' : ''}
        </div>` : ''}
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

  let advisorList = null; // set by pages that let people pick the advisor (BDC)
  function setAdvisors(list) { advisorList = list; }
  function edit(ride, refresh) {
    const m = App.modal(`<h2>Edit ride</h2><form>${advisorList ? advisorPick(advisorList, ride.advisor_id, false) : ''}${formHtml(ride)}<div class="msg"></div>
      <div class="actions"><button>Save changes</button><button type="button" class="btn-ghost" data-close>Close</button></div></form>`);
    $('.modal', m).style.maxWidth = '560px';
    const form = $('form', m);
    wireForm(form);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await api(`/api/rides/${ride.id}`, { method: 'PATCH', body: formData(form) }); m.close(); refresh(); }
      catch (err) { App.flash($('.msg', m), err.message); }
    };
  }

  // The step-by-step "new ride" form, used on the advisor and BDC pages.
  function newRideForm(form, onAdded = () => {}, { advisors = null } = {}) {
    // New ride form, one step at a time:
    // pick up or drop off -> customer name & phone -> location -> time & people -> urgent or not.
    form.innerHTML = `${Rides.stepFormHtml({ advisors })}
      <div id="formMsg"></div>
      <div class="step-nav">
        <button type="button" class="btn-ghost" data-back>← Back</button>
        <button type="button" class="btn-dark" data-next>Next →</button>
        <button type="submit" class="btn-lg" data-submit>Add to shuttle queue</button>
      </div>`;
    const wired = Rides.wireForm(form);
    const WORDS = {
      pickup: { where: 'Where are we picking them up?', when: 'When should we pick them up, and how many people?' },
      dropoff: { where: 'Where are we taking them?', when: 'When do they leave the dealership, and how many people?' },
    };
    const typeOf = () => form.elements.type.value;
    const WAIT = Number(App.settings.dropoff_wait_min) || 0;
    // In the review, show when a drop off will really leave (the wait applies unless urgent).
    function reviewTime() {
      const el = $('[data-review-time]', form); if (!el) return;
      const f = Rides.formData(form);
      const earliest = Date.now() + WAIT * 60000;
      const waits = f.type === 'dropoff' && f.priority !== 'urgent' && WAIT > 0 && new Date(f.scheduled_at) < earliest - 60000;
      const t = waits ? new Date(earliest).toISOString() : f.scheduled_at;
      el.innerHTML = `🕒 ${App.fmtTime(t)}${waits ? ` <span class="small">(${WAIT}-minute drop-off wait)</span>` : ''} · ${f.passengers || 1} ${Number(f.passengers) === 1 ? 'person' : 'people'}`;
    }
    form.addEventListener('change', (e) => { if (e.target.name === 'priority') reviewTime(); });
    const steps = App.stepper(form, {
      msg: $('#formMsg'),
      check: {
        where: () => (form.elements.lat.value ? null : (confirm('No map pin was set for this address. The driver will only see the typed address. Continue anyway?') ? null : 'Pick an address from the list, or tap the map to set the spot.')),
      },
      onShow: (step) => {
        if (step === 'where') { $('[data-addr-label]', form).textContent = WORDS[typeOf()].where; setTimeout(() => wired.map.invalidateSize(), 50); }
        if (step === 'when') {
          // Drop offs wait a set time unless urgent (marked in the next step).
          const note = $('[data-wait-note]', form);
          note.hidden = !(typeOf() === 'dropoff' && WAIT > 0);
          note.innerHTML = `⏳ Drop offs leave at least <b>${WAIT} minutes</b> after booking (earliest about ${App.fmtTime(new Date(Date.now() + WAIT * 60000).toISOString())}). Need it sooner? Choose <b>Urgent</b> in the next step and give a reason.`;
        }
        if (step === 'priority') {
          const f = Rides.formData(form);
          const adv = advisors && advisors.find((a) => a.id === f.advisor_id);
          $('[data-summary]', form).innerHTML = `<b>Review</b>
            <div>${f.type === 'pickup' ? '⬆ Pick up' : '⬇ Drop off'} · <b>${esc(f.customer_name)}</b>${f.customer_phone ? ` · ${esc(f.customer_phone)}` : ''}</div>
            ${adv ? `<div>👤 Advisor: <b>${esc(adv.name)}</b></div>` : ''}
            <div>📍 ${esc(f.address)}${f.lat ? '' : ' <span class="late">(no map pin)</span>'}</div>
            <div data-review-time>🕒 ${App.fmtTime(f.scheduled_at)} · ${f.passengers || 1} ${Number(f.passengers) === 1 ? 'person' : 'people'}</div>`;
          reviewTime();
        }
      },
    });
    form.querySelectorAll('[data-choose]').forEach((b) => b.addEventListener('click', () => {
      form.querySelector(`[name=type][value=${b.dataset.choose}]`).checked = true;
      form.querySelectorAll('[data-choose]').forEach((x) => x.classList.toggle('picked', x === b));
    }));
    form.querySelectorAll('[data-in]').forEach((b) => b.onclick = () => {
      form.elements.scheduled_at.value = App.toLocalInput(new Date(Date.now() + Number(b.dataset.in) * 60000));
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { ride, adjusted_to: moved, wait_min: waitMin } = await api('/api/rides', { body: Rides.formData(form) });
        form.reset(); wired.reset(); wired.syncUrgent();
        form.elements.scheduled_at.value = App.toLocalInput(new Date(Date.now() + 30 * 60000));
        form.querySelectorAll('[data-choose]').forEach((x) => x.classList.remove('picked'));
        steps.reset(); // ready for the next ride
        const forWho = ride.advisor_name && advisors ? ` ${ride.advisor_name.split(' ')[0]} has been told.` : '';
        App.flash($('#formMsg'), (moved ? `Added ${ride.customer_name}. Drop off set for ${App.fmtTime(moved)} (${waitMin}-minute wait).` : `Added ${ride.customer_name}.`) + forWho, true);
        onAdded(ride);
        App.share({ title: `Shuttle tracking for ${ride.customer_name}`, url: ride.track_url, phone: ride.customer_phone, email: ride.customer_email, message: App.rideMessage(ride) });
      } catch (err) { App.flash($('#formMsg'), err.message); }
    };
  }

  return { formHtml, stepFormHtml, wireForm, formData, card, bind, edit, newRideForm, setAdvisors };
})();
