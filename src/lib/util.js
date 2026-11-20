'use strict';
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function randomCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

function pct(score, max) {
  if (!max) return 0;
  return round((score / max) * 100, 1);
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Parse a <input type="datetime-local"> value. The browser also sends the
// client's timezone offset (minutes, as from Date#getTimezoneOffset) so the
// time is stored correctly even if the server runs in another timezone.
function parseLocalDateTime(value, tzOffsetMinutes) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const off = toInt(tzOffsetMinutes);
  if (off === null) {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(value.slice(0, 16) + ':00Z');
  return Number.isFinite(t) ? t + off * 60000 : null;
}

function quizStatus(quiz, now = Date.now()) {
  if (!quiz.published) return 'draft';
  if (now < quiz.start_at) return 'upcoming';
  if (now >= quiz.end_at) return 'closed';
  return 'live';
}

module.exports = { randomCode, shuffle, round, pct, median, toInt, parseLocalDateTime, quizStatus };
