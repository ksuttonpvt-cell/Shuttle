// Turns a dealership vehicle list (the loaner-fleet export: Status, Vehicle ID, VIN, Plate,
// Make, Model, Year, Odometer, ...) into vehicles for the shuttle site.

const FUELS = ['gas', 'hybrid', 'plugin', 'electric'];

// Fuel type from the model name, e.g. "BZ WOODLAND" -> electric, "RAV4 PHEV" -> plug-in,
// "4RUNNER H" / "COROLLA HYBR" / "SIENNA HYBRD" -> hybrid.
function guessFuel(model, fuelColumn, year) {
  const f = String(fuelColumn || '').toLowerCase();
  if (/electric|\bev\b|bev/.test(f)) return 'electric';
  if (/plug|phev/.test(f)) return 'plugin';
  if (/hybrid/.test(f)) return 'hybrid';
  if (/gas|petrol|diesel/.test(f)) return 'gas';
  const m = ` ${String(model || '').toUpperCase()} `;
  if (/\b(BZ|BZ4X|MIRAI)\b/.test(m) || /\bEV\b/.test(m)) return 'electric';
  if (/\bC-?HR\b/.test(m) && Number(year) >= 2026) return 'electric'; // the 2026 C-HR is all-electric in the US
  if (/PHEV|PRIME|PLUG/.test(m)) return 'plugin';
  if (/HYB|HYBR|HYBRD|HYBRID|\sH\s|PRIUS|SIENNA|VENZA|CROWN/.test(m)) return 'hybrid';
  return 'gas';
}

// Passenger seats (not counting the driver) for common Toyota models.
function guessSeats(model) {
  const m = String(model || '').toUpperCase();
  if (/SIENNA/.test(m)) return 7;
  if (/HIGHLANDER|SEQUOIA|GRAND HIGH/.test(m)) return 7;
  return 4;
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z0-9]/g, (c) => c.toUpperCase())
  .replace(/\b4runner\b/gi, '4Runner').replace(/\bRav4\b/g, 'RAV4').replace(/\bBz\b/g, 'bZ').replace(/\bC-Hr\b/g, 'C-HR').replace(/\bPhev\b/g, 'PHEV')
  .replace(/\bHybr\b|\bHybrd\b/g, 'Hybrid').replace(/ H$/, ' Hybrid').replace(/\bCros\b/g, 'Cross');

// Active vehicles stay active: "Loaned", "Available", "On Hold" and "Service" (the service
// department's own vehicles, like shuttle vans). Body shop / out of service can't be driven
// right now; "Retired" is retired.
function mapStatus(s) {
  const t = String(s || '').toLowerCase();
  if (/retired|sold|disposed/.test(t)) return 'retired';
  if (/body shop|out of service|repair|maintenance|damage/.test(t)) return 'maintenance';
  return 'available';
}

const pick = (header, names) => header.findIndex((h) => names.some((n) => h === n || h.replace(/[^a-z]/g, '') === n.replace(/[^a-z]/g, '')));

function parseFleet(rows) {
  const at = rows.findIndex((r) => r.some((c) => /^vin$/i.test(String(c || '').trim())));
  if (at < 0) throw new Error('Couldn\'t find a "VIN" column. Use the vehicle list export with VIN, Plate, Model and Year.');
  const header = rows[at].map((h) => String(h || '').trim().toLowerCase());
  const col = {
    status: pick(header, ['status']), id: pick(header, ['vehicle id', 'stock', 'stock #', 'unit']), vin: pick(header, ['vin']),
    plate: pick(header, ['plate', 'license plate', 'tag']), make: pick(header, ['make']), model: pick(header, ['model']),
    year: pick(header, ['year']), miles: pick(header, ['odometer', 'mileage', 'miles']), color: pick(header, ['color', 'colour']),
    fuel: pick(header, ['fuel type', 'fuel', 'powertrain']), seats: pick(header, ['seats', 'passengers']),
  };
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] : null);
  const out = []; const seen = new Set(); let skipped = 0;
  for (const r of rows.slice(at + 1)) {
    const vin = String(get(r, 'vin') || '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin) || seen.has(vin)) { if (r.some((c) => String(c ?? '').trim())) skipped++; continue; }
    seen.add(vin);
    const make = titleCase(get(r, 'make') || 'Toyota');
    const model = titleCase(get(r, 'model'));
    const plate = String(get(r, 'plate') || '').trim().toUpperCase() || null;
    const year = Number(get(r, 'year')) || null;
    const miles = Number(String(get(r, 'miles') ?? '').replace(/[^\d.]/g, '')) || null;
    const fleetStatus = String(get(r, 'status') || '').trim() || null;
    const fuelCol = get(r, 'fuel');
    out.push({
      vin, plate, year, fleet_id: String(get(r, 'id') || '').trim() || null, fleet_status: fleetStatus,
      make_model: [make, model].filter(Boolean).join(' '), color: get(r, 'color') ? titleCase(get(r, 'color')) : null,
      mileage: miles != null ? Math.round(miles) : null, status: mapStatus(fleetStatus),
      fuel: guessFuel(get(r, 'model'), typeof fuelCol === 'string' && !/^\d+$/.test(fuelCol.trim()) ? fuelCol : null, year),
      seats: Number(get(r, 'seats')) || guessSeats(get(r, 'model')),
      name: [model || make, plate || vin.slice(-6)].filter(Boolean).join(' '),
      // Service-department vehicles (status "Service") are most likely the shuttles.
      use: /^service( vehicle)?$/i.test(fleetStatus || '') ? 'shuttle' : 'loaner',
    });
  }
  return { vehicles: out, skipped };
}

module.exports = { parseFleet, guessFuel, guessSeats, mapStatus, FUELS };
