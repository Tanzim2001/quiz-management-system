'use strict';
const { quizStatus, pct } = require('./util');

// Server-side fallback; public/js/app.js re-renders <time data-ts> in the viewer's own timezone.
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Value for <input type="datetime-local">; JS replaces it with the browser's local time.
function toInputValue(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_LABEL = { draft: 'Draft', upcoming: 'Upcoming', live: 'Live now', closed: 'Closed' };

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function scoreClass(percent) {
  if (percent == null) return '';
  if (percent >= 75) return 'good';
  if (percent >= 40) return 'ok';
  return 'bad';
}

module.exports = { fmtDate, fmtDuration, toInputValue, quizStatus, STATUS_LABEL, initials, scoreClass, pct };
