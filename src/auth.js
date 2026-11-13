const crypto = require('node:crypto');
const { promisify } = require('node:util');

// Password hashing is deliberately slow (to resist guessing). The async versions run it on a
// background thread, so a rush of sign-ins doesn't freeze the server for everyone else.
const scryptAsync = promisify(crypto.scrypt);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
// A made-up hash checked when the email doesn't exist, so both cases take the same time
// (otherwise response times would reveal which emails have accounts).
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));
async function verifyPasswordAsync(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual) && !!stored;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore a malformed cookie */ }
    }
  }
  return out;
}

module.exports = { hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync, validatePassword, randomToken, parseCookies };
