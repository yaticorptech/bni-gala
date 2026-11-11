const crypto = require('crypto');
const os = require('os');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function id(length = 10) {
  let out = '';
  for (const byte of crypto.randomBytes(length)) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

const token = () => crypto.randomBytes(24).toString('base64url');

/** Collapse whitespace, trim and cap length — for all user-entered text. */
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** This machine's Wi-Fi/LAN IPv4, preferring private ranges, so phones can reach a laptop server. */
function lanIp() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) candidates.push(a.address);
    }
  }
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) || candidates[0] || null;
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { HttpError, id, token, clean, shuffle, safeEqual, lanIp, csvCell };
