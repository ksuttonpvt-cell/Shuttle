// Which city a ride is in, for reports. Worked out from the address text first (anywhere in
// the US), then from the map spot (nearest town, for a few towns around Boulder, CO). Saved with the ride, so it stays
// after the nightly customer-info clear (a city alone doesn't identify anyone).
const { distanceKm } = require('./priority');

// Rough town size in km, so a spot in north Boulder counts as Boulder, not the small town nearby.
const SIZE = { Boulder: 5, Longmont: 5, Denver: 10, Broomfield: 4, Westminster: 4, Arvada: 4, Thornton: 4, Lafayette: 2.5, Louisville: 2.5, Erie: 2.5, Gunbarrel: 0.5, Niwot: 0.8 };
const TOWNS = [
  ['Boulder', 40.0150, -105.2705], ['Louisville', 39.9778, -105.1319], ['Lafayette', 39.9936, -105.0897],
  ['Superior', 39.9528, -105.1686], ['Broomfield', 39.9205, -105.0867], ['Longmont', 40.1672, -105.1019],
  ['Erie', 40.0503, -105.0500], ['Niwot', 40.1039, -105.1708], ['Gunbarrel', 40.0633, -105.1714],
  ['Westminster', 39.8367, -105.0372], ['Arvada', 39.8028, -105.0875], ['Nederland', 39.9614, -105.5108],
  ['Lyons', 40.2247, -105.2714], ['Golden', 39.7555, -105.2211], ['Denver', 39.7392, -104.9903],
  ['Thornton', 39.8680, -104.9719], ['Northglenn', 39.8961, -104.9811], ['Federal Heights', 39.8514, -104.9986],
  ['Firestone', 40.1125, -104.9367], ['Frederick', 40.0992, -104.9372], ['Dacono', 40.0847, -104.9394],
  ['Eldorado Springs', 39.9327, -105.2780], ['Jamestown', 40.1155, -105.3883], ['Ward', 40.0725, -105.5094],
].map(([name, lat, lng]) => ({ name, lat, lng, size: SIZE[name] || 1.5 }));
const KNOWN = new Map(TOWNS.map((t) => [t.name.toLowerCase(), t.name]));
const STATES = 'al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|alabama|alaska|arizona|arkansas|california|colorado|colo|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming';
const STATE = new RegExp(`^(${STATES})(\\s+\\d{5}(-\\d{4})?)?$`, 'i');
const ZIP = /^\d{5}(-\d{4})?$/;
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function cityOf(address, lat, lng) {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  // 1. A known town named on its own in the address ("…, Longmont, CO").
  for (const p of parts) { const hit = KNOWN.get(p.toLowerCase()); if (hit) return hit; }
  // 2. Whatever comes just before the state or ZIP code ("…, Castle Rock, CO 80104").
  const i = parts.findIndex((p, n) => n > 0 && (STATE.test(p) || ZIP.test(p)));
  if (i > 0) {
    for (let j = i - 1; j >= 1; j--) {
      const p = parts[j];
      if (/county$/i.test(p) || ZIP.test(p) || /\d/.test(p)) continue;
      return titleCase(p);
    }
  }
  // 3. "123 Main St Longmont CO" with no commas: a known town as a whole word.
  const text = ` ${String(address || '').toLowerCase().replace(/[^a-z ]/g, ' ')} `;
  for (const t of [...TOWNS].sort((a, b) => b.name.length - a.name.length)) {
    if (text.includes(` ${t.name.toLowerCase()} `) && !text.includes(` ${t.name.toLowerCase()} county `)) {
      // "Boulder" also appears in street names; only trust it near the end of the address.
      const at = text.lastIndexOf(` ${t.name.toLowerCase()} `);
      if (at > text.length * 0.4) return t.name;
    }
  }
  // 4. The nearest town to the map spot (within about 6 miles).
  if (lat != null && lng != null) {
    let best = null; let bestKm = Infinity;
    for (const t of TOWNS) { const km = distanceKm({ lat, lng }, t) - t.size; if (km < bestKm) { bestKm = km; best = t; } }
    if (best && bestKm <= 6) return best.name;
  }
  return null;
}

// Round trip dealership ↔ customer, by road (estimated from straight-line distance).
function estimatedRideMiles(dealer, lat, lng) {
  if (lat == null || lng == null) return null;
  return Math.round(distanceKm(dealer, { lat, lng }) * 0.621371 * 1.35 * 2 * 10) / 10;
}

module.exports = { cityOf, estimatedRideMiles, TOWNS };
