process.removeAllListeners('warning');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { readSheet } = require('../src/sheets');
const { guessFuel, mapStatus } = require('../src/fleet');

// Builds a small .xlsx (a zip of XML files) shaped like the dealership's vehicle list export.
function makeXlsx(rows) {
  const cell = (v, ref) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="str"><v xml:space="preserve">${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</v></c>`);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v == null ? '' : cell(v, String.fromCharCode(65 + j) + (i + 1)))).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = { 'xl/workbook.xml': '<workbook><sheets><sheet name="Vehicle List" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': sheet };
  const parts = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text); const comp = zlib.deflateRawSync(data); const n = Buffer.from(name); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, n, comp); central.push(cen, n); offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const HEADER = ['Status', 'Vehicle ID', 'VIN', 'Plate', 'Make', 'Model', 'Year', 'Odometer', 'Fuel Level', 'In Service Date', 'Current', 'Telemetry'];
const LIST = [HEADER,
  ['Loaned', 'TACMU1  ', '3TMLB5JNXTM000001', 'TEST01', 'TOYOTA', 'TACOMA', 2026, 4977, 83, '06-02-2026', '', ''],
  ['Available', 'SIEHY2  ', '5TDXSKFC0TS000002', 'TEST02', 'TOYOTA', 'SIENNA HYBRD', 2026, 1200, 100, '', '', ''],
  ['Body Shop', 'BZWP3  ', 'JTMBDAFB1TA000003', 'TEST03', 'TOYOTA', 'BZ WOODLAND', 2026, 7922, 59, '', '', ''],
  ['Service', 'SIE9  ', '5TDXSKFC0TS000009', 'TEST09', 'TOYOTA', 'SIENNA HYBRD', 2026, 50, 100, '', '', ''],
  ['On Hold', 'RAV4P4  ', 'JTMFB3FV0TD000004', 'TEST04', 'TOYOTA', 'RAV4 PHEV', 2026, 300, 90, '', '', ''],
  ['Retired', 'CHR5  ', 'JTDACACU0T3000005', 'TEST05', 'TOYOTA', 'C-HR', 2026, 9000, 40, '', '', ''],
  ['Loaned', 'X', 'not-a-vin', 'NOPE', 'TOYOTA', 'COROLLA', 2026, 1, 1, '', '', '']];

test('fuel types and statuses from the vehicle list', () => {
  assert.equal(guessFuel('BZ WOODLAND'), 'electric');
  assert.equal(guessFuel('RAV4 PHEV'), 'plugin');
  assert.equal(guessFuel('4RUNNER H'), 'hybrid');
  assert.equal(guessFuel('COROLLA HYBR'), 'hybrid');
  assert.equal(guessFuel('TACOMA'), 'gas');
  assert.equal(guessFuel('C-HR', null, 2026), 'electric');
  for (const s of ['Loaned', 'Available', 'On Hold', 'Service']) assert.equal(mapStatus(s), 'available', `${s} stays active`);
  assert.equal(mapStatus('Body Shop'), 'maintenance');
  assert.equal(mapStatus('Out of Service'), 'maintenance');
  assert.equal(mapStatus('Retired'), 'retired');
  const rows = readSheet(makeXlsx(LIST), 'list.xlsx');
  assert.equal(rows.length, 8);
  assert.equal(rows[1][1], 'TACMU1  ', 'cells with xml:space are read');
});

let server; let base;
before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, { email: 'admin@test.local', password: 'adminpass1', name: 'Admin' });
  const app = createApp(db, { noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
function client() {
  let cookie = '';
  return async (p, { method, body } = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
const asData = (buf) => `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString('base64')}`;

test('import the vehicle list: preview, add as loaners, update by VIN, shuttles only for drivers', async () => {
  const admin = client();
  await admin('/api/login', { body: { email: 'admin@test.local', password: 'adminpass1' } });
  // An existing shuttle that's also on the list (same VIN): it keeps being a shuttle.
  const sienna = (await admin('/api/vehicles', { body: { name: 'Shuttle 1', vin: '5TDXSKFC0TS000002', seats: 7, fuel: 'hybrid' } })).data.vehicle;
  assert.equal(sienna.use, 'shuttle');

  const file = asData(makeXlsx(LIST));
  let r = await admin('/api/vehicles/import', { body: { data: file, filename: 'Vehicle_List.xlsx', preview: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.summary, { found: 6, add: 5, update: 1, same: 0, skipped: 1 });
  assert.equal((await admin('/api/vehicles')).data.vehicles.length, 1, 'preview changes nothing');

  r = await admin('/api/vehicles/import', { body: { data: file, filename: 'Vehicle_List.xlsx' } });
  assert.deepEqual([r.data.summary.add, r.data.summary.update], [5, 1]);
  const svc = (await admin('/api/vehicles')).data.vehicles.find((x) => x.vin === '5TDXSKFC0TS000009');
  assert.deepEqual([svc.use, svc.status, svc.seats], ['shuttle', 'available', 7], 'service-department vehicle comes in as an active shuttle');
  let list = (await admin('/api/vehicles')).data.vehicles;
  const byVin = (v) => list.find((x) => x.vin === v);
  const tacoma = byVin('3TMLB5JNXTM000001');
  assert.deepEqual([tacoma.name, tacoma.make_model, tacoma.fuel, tacoma.use, tacoma.status, tacoma.fleet_status, tacoma.mileage, tacoma.seats],
    ['Tacoma TEST01', 'Toyota Tacoma', 'gas', 'loaner', 'available', 'Loaned', 4977, 4]);
  assert.deepEqual([byVin('JTMBDAFB1TA000003').fuel, byVin('JTMBDAFB1TA000003').status], ['electric', 'maintenance']);
  assert.equal(byVin('JTMFB3FV0TD000004').status, 'available', 'On Hold stays active');
  assert.equal(byVin('JTDACACU0T3000005').status, 'retired');
  const shuttle = byVin('5TDXSKFC0TS000002');
  assert.deepEqual([shuttle.name, shuttle.use, shuttle.seats, shuttle.mileage], ['Shuttle 1', 'shuttle', 7, 1200], 'name, use and seats kept; mileage updated');

  // Importing the same list again changes nothing.
  r = await admin('/api/vehicles/import', { body: { data: file, filename: 'Vehicle_List.xlsx', preview: true } });
  assert.deepEqual([r.data.summary.add, r.data.summary.update, r.data.summary.same], [0, 0, 6]);

  // Drivers can only start a shift in a shuttle.
  await admin('/api/users', { body: { name: 'Dana', email: 'dana@t.l', role: 'driver', password: 'driverpw1' } });
  const dana = client();
  await dana('/api/login', { body: { email: 'dana@t.l', password: 'driverpw1' } });
  r = await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: tacoma.id } });
  assert.equal(r.status, 400); assert.match(r.data.error, /loaner/);
  await admin(`/api/vehicles/${tacoma.id}`, { method: 'PATCH', body: { use: 'shuttle' } });
  assert.equal((await dana('/api/driver/shift', { body: { on_duty: true, vehicle_id: tacoma.id } })).status, 200);

  // CSV works too; bad files are refused clearly.
  const csv = 'Status,VIN,Plate,Model,Year,Odometer\nLoaned,4T1DAACK0TU000006,CSV01,CAMRY HYBRID,2026,50\n';
  r = await admin('/api/vehicles/import', { body: { data: `data:text/csv;base64,${Buffer.from(csv).toString('base64')}`, filename: 'list.csv' } });
  assert.equal(r.data.summary.add, 1);
  list = (await admin('/api/vehicles')).data.vehicles;
  assert.equal(list.find((x) => x.vin === '4T1DAACK0TU000006').fuel, 'hybrid');
  assert.equal((await admin('/api/vehicles/import', { body: { data: 'data:text/csv;base64,' + Buffer.from('a,b\n1,2').toString('base64'), filename: 'x.csv' } })).status, 400);
  assert.equal((await admin('/api/vehicles/import', { body: { data: 'data:x;base64,' + Buffer.from('PK\x03\x04junk').toString('base64'), filename: 'x.xlsx' } })).status, 400);
  assert.equal((await dana('/api/vehicles/import', { body: { data: file } })).status, 403, 'admins only');
  assert.equal((await admin('/api/vehicles', { method: 'POST', body: { name: 'X', fuel: 'diesel' } })).status, 400);
});
