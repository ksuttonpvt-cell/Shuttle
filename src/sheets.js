// Reads the first sheet of an Excel (.xlsx) file or a CSV into rows, with no extra packages.
// An .xlsx file is a zip of XML files; this reads just the parts needed for cell values.
const zlib = require('node:zlib');

function unzip(buf) {
  // Find the "end of central directory" record, then walk the central directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That file isn't a valid .xlsx spreadsheet.");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The spreadsheet looks damaged.');
    const method = buf.readUInt16LE(p + 10); const size = buf.readUInt32LE(p + 20); const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32); const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (size > 20 * 1024 * 1024) throw new Error('That spreadsheet is too big.');
    files[name] = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8') : method === 0 ? data.toString('utf8') : null;
  }
  return files;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  for (const si of (files['xl/sharedStrings.xml'] || '').match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push(unescape([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  // The first sheet listed in the workbook.
  let sheet = 'xl/worksheets/sheet1.xml';
  const wb = files['xl/workbook.xml'] || ''; const rels = files['xl/_rels/workbook.xml.rels'] || '';
  const firstId = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const target = firstId && new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  if (target) sheet = `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`;
  const xml = files[sheet];
  if (!xml) throw new Error("Couldn't find a sheet in that file.");
  const rows = [];
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const out = [];
    for (const c of row.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c)?.[1]; const type = /\bt="([^"]+)"/.exec(c)?.[1];
      let v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(c)?.[1];
      if (type === 'inlineStr') v = [...c.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
      if (v == null) continue;
      v = type === 's' ? shared[Number(v)] : unescape(v);
      if (type !== 's' && type !== 'str' && type !== 'inlineStr' && v !== '' && !Number.isNaN(Number(v))) v = Number(v);
      out[ref ? colIndex(ref) : out.length] = v;
    }
    rows.push(Array.from(out, (x) => (x === undefined ? null : x)));
  }
  return rows;
}

function readCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

function readSheet(buf, filename = '') {
  if (buf.length > 10 * 1024 * 1024) throw new Error('That file is too big (10 MB max).');
  if (buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (/\.xlsx$/i.test(filename)) throw new Error("That file isn't a valid .xlsx spreadsheet.");
  return readCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

module.exports = { readSheet, readXlsx, readCsv };
