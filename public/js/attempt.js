/* QuizHub — taking a quiz: countdown timer, autosave, navigation, tab-switch detection, auto-submit */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const data = JSON.parse($('#attempt-data').textContent);
  const csrf = $('meta[name="csrf-token"]').content;
  const base = `/student/attempts/${data.attemptId}`;
  const store = `quizhub-attempt-${data.attemptId}`;

  // The server's clock is the source of truth; correct for any drift in the student's device clock.
  let offset = data.serverNow - Date.now();
  const now = () => Date.now() + offset;

  const cards = $$('.question-card');
  const paletteBtns = $$('.palette button');
  const timerEl = $('#timer');
  const timeBar = $('#time-progress');
  const saveEl = $('#save-state');
  const totalMs = Math.max(1, data.deadline - data.serverNow);
  let current = 0;
  let submitting = false;
  let flagged = new Set();
  const pending = new Map(); // questionId -> optionId|null still to be saved

  try {
    const saved = JSON.parse(localStorage.getItem(store) || '{}');
    if (Number.isInteger(saved.current) && saved.current < cards.length) current = saved.current;
    flagged = new Set(saved.flagged || []);
  } catch (e) { /* ignore */ }
  const persist = () => { try { localStorage.setItem(store, JSON.stringify({ current, flagged: [...flagged] })); } catch (e) { /* ignore */ } };

  function toast(msg, kind) {
    const zone = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    zone.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function post(path, body) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    let json = {};
    try { json = await res.json(); } catch (e) { /* ignore */ }
    if (json.serverNow) offset = json.serverNow - Date.now();
    return { ok: res.ok, status: res.status, json };
  }

  // ---------- Navigation ----------
  function answeredCount() { return cards.filter((c) => c.querySelector('input:checked')).length; }

  function refreshPalette() {
    paletteBtns.forEach((b, i) => {
      const qid = Number(cards[i].dataset.qid);
      b.classList.toggle('answered', !!cards[i].querySelector('input:checked'));
      b.classList.toggle('flagged', flagged.has(qid));
      b.classList.toggle('current', i === current);
      b.setAttribute('aria-current', i === current ? 'step' : 'false');
    });
    const n = answeredCount();
    $('#answered-count').textContent = `${n}/${cards.length}`;
    $('#answered-bar').style.width = `${(n / cards.length) * 100}%`;
  }

  function show(i, focus) {
    current = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, idx) => { c.hidden = idx !== current; });
    $('#prev-btn').disabled = current === 0;
    $('#next-btn').classList.toggle('hidden', current === cards.length - 1);
    $('#finish-btn').classList.toggle('hidden', current !== cards.length - 1);
    const flagBtn = $('#flag-btn');
    const qid = Number(cards[current].dataset.qid);
    flagBtn.setAttribute('aria-pressed', String(flagged.has(qid)));
    flagBtn.textContent = flagged.has(qid) ? '⚑ Flagged' : '⚐ Flag for review';
    refreshPalette();
    persist();
    if (focus) cards[current].querySelector('.q-text').focus({ preventScroll: true });
    if (window.innerWidth < 900) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('#prev-btn').addEventListener('click', () => show(current - 1, true));
  $('#next-btn').addEventListener('click', () => show(current + 1, true));
  paletteBtns.forEach((b, i) => b.addEventListener('click', () => show(i, true)));
  $('#flag-btn').addEventListener('click', () => {
    const qid = Number(cards[current].dataset.qid);
    if (flagged.has(qid)) flagged.delete(qid); else flagged.add(qid);
    show(current);
  });

  // ---------- Answering + autosave ----------
  function setSave(state, text) {
    saveEl.className = 'save-state' + (state === 'err' ? ' err' : '');
    saveEl.textContent = text;
  }

  let flushing = false;
  async function flush() {
    if (flushing || !pending.size) return;
    flushing = true;
    setSave('', 'Saving…');
    try {
      while (pending.size) {
        const [qid, oid] = pending.entries().next().value;
        const r = await post('/answer', { questionId: qid, optionId: oid });
        if (r.status === 409 && r.json.closed) { pending.clear(); flushing = false; return finish(true); }
        if (!r.ok && r.status !== 409) throw new Error(r.json.error || 'Save failed');
        if (pending.get(qid) === oid) pending.delete(qid);
      }
      setSave('', 'All changes saved ✓');
    } catch (e) {
      setSave('err', 'Offline – retrying…');
      setTimeout(() => { flushing = false; flush(); }, 2500);
      return;
    }
    flushing = false;
  }

  cards.forEach((card) => {
    const qid = Number(card.dataset.qid);
    $$('input[type="radio"]', card).forEach((input) => input.addEventListener('change', () => {
      $$('.choice', card).forEach((c) => c.classList.toggle('selected', c.contains(input)));
      pending.set(qid, Number(input.value));
      refreshPalette();
      flush();
    }));
    const clear = $('[data-clear]', card);
    if (clear) clear.addEventListener('click', () => {
      $$('input[type="radio"]', card).forEach((i) => { i.checked = false; });
      $$('.choice', card).forEach((c) => c.classList.remove('selected'));
      pending.set(qid, null);
      refreshPalette();
      flush();
    });
  });

  // Keyboard: A–F / 1–6 choose an option, ←/→ move between questions.
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="text"], textarea') || e.metaKey || e.ctrlKey || e.altKey || $('dialog[open]')) return;
    const k = e.key.toLowerCase();
    const inputs = $$('input[type="radio"]', cards[current]);
    let idx = -1;
    if (/^[1-6]$/.test(k)) idx = Number(k) - 1;
    else if (/^[a-f]$/.test(k)) idx = k.charCodeAt(0) - 97;
    if (idx >= 0 && inputs[idx]) { inputs[idx].checked = true; inputs[idx].dispatchEvent(new Event('change')); e.preventDefault(); }
    else if (e.key === 'ArrowRight') show(current + 1, true);
    else if (e.key === 'ArrowLeft') show(current - 1, true);
  });

  // ---------- Timer ----------
  let warnedFive = false, warnedOne = false;
  function tick() {
    const left = data.deadline - now();
    timerEl.querySelector('span').textContent = window.QuizHub.fmtRemaining(left);
    timerEl.classList.toggle('warn', left <= 5 * 60000 && left > 60000);
    timerEl.classList.toggle('danger', left <= 60000);
    timeBar.style.width = `${Math.max(0, Math.min(100, (left / totalMs) * 100))}%`;
    if (!warnedFive && left <= 5 * 60000 && left > 60000 && totalMs > 6 * 60000) { warnedFive = true; toast('⏰ 5 minutes left.', 'warn'); }
    if (!warnedOne && left <= 60000 && left > 0) { warnedOne = true; toast('⏰ 1 minute left — your answers will be submitted automatically.', 'warn'); }
    if (left <= 0) finish(true);
  }
  tick();
  const timerId = setInterval(tick, 250);

  // ---------- Tab switching (anti-cheat) ----------
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (submitting) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      post('/event', { type: 'tab_switch' }).catch(() => {});
    } else if (hiddenAt) {
      hiddenAt = 0;
      const r = await post('/event', { type: 'noop' }).catch(() => null);
      const n = r && r.json.tabSwitches;
      toast(`⚠️ You left the quiz tab${n ? ` (${n} time${n === 1 ? '' : 's'})` : ''}. Your teacher can see this.`, 'warn');
      tick();
    }
  });
  // Discourage copying question text.
  $('.quiz-shell').addEventListener('copy', (e) => { e.preventDefault(); toast('Copying is disabled during the quiz.'); });
  $('.quiz-shell').addEventListener('contextmenu', (e) => e.preventDefault());

  function beforeUnload(e) { if (!submitting) { e.preventDefault(); e.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);

  // ---------- Submitting ----------
  async function finish(auto) {
    if (submitting) return;
    submitting = true;
    clearInterval(timerId);
    window.removeEventListener('beforeunload', beforeUnload);
    $('#submitting-overlay').classList.remove('hidden');
    $('#submitting-text').textContent = auto ? "Time's up! Submitting your answers…" : 'Submitting your answers…';
    // Give in-flight saves a moment to land.
    for (let i = 0; i < 20 && (pending.size || flushing); i++) {
      if (!flushing) await flush(); else await new Promise((r) => setTimeout(r, 150));
    }
    for (let tries = 0; tries < 5; tries++) {
      try {
        const r = await post('/submit', { auto: auto ? '1' : '0' });
        try { localStorage.removeItem(store); } catch (e) { /* ignore */ }
        location.href = (r.json && r.json.redirect) || `${base}/result`;
        return;
      } catch (e) {
        $('#submitting-text').textContent = 'Connection problem — retrying…';
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    location.href = `${base}/result`;
  }

  const dlg = $('#submit-dialog');
  $$('[data-open-submit]').forEach((b) => b.addEventListener('click', () => {
    const unanswered = cards.length - answeredCount();
    const flags = cards.filter((c) => flagged.has(Number(c.dataset.qid))).length;
    const parts = [];
    parts.push(unanswered ? `You have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}.` : 'You answered every question.');
    if (flags) parts.push(`${flags} question${flags === 1 ? ' is' : 's are'} flagged for review.`);
    parts.push("You can't change your answers after submitting.");
    $('#submit-summary').textContent = parts.join(' ');
    dlg.showModal();
  }));
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'submit') finish(false); });

  show(current);
})();
