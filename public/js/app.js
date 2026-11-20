/* QuizHub — shared UI behaviour */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // ---- Theme toggle ----
  $$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('quizhub-theme', next); } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('themechange'));
  }));

  // ---- Menus ----
  const menuBtn = $('[data-menu-toggle]');
  const mobileNav = $('#mobile-nav');
  if (menuBtn && mobileNav) menuBtn.addEventListener('click', () => {
    const open = mobileNav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  $$('[data-dropdown]').forEach((btn) => {
    const menu = document.getElementById(btn.getAttribute('data-dropdown'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('open'); });
  });

  // ---- Flash messages ----
  $$('.alert .close').forEach((b) => b.addEventListener('click', () => b.closest('.alert').remove()));

  // ---- Time formatting in the viewer's timezone ----
  const dtFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function relative(ts) {
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const units = [['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
    for (const [u, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), u);
    return diff >= 0 ? 'in a moment' : 'just now';
  }
  function renderTimes() {
    $$('time[data-ts]').forEach((el) => {
      const ts = Number(el.getAttribute('data-ts'));
      if (!ts) return;
      const f = el.getAttribute('data-format') || 'datetime';
      el.textContent = f === 'relative' ? relative(ts) : f === 'date' ? dFmt.format(ts) : dtFmt.format(ts);
      el.setAttribute('datetime', new Date(ts).toISOString());
      if (f === 'relative') el.title = dtFmt.format(ts);
    });
  }
  renderTimes();
  setInterval(renderTimes, 30000);

  // ---- Countdowns to a timestamp (quiz lobby, dashboards) ----
  function fmtRemaining(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return d ? `${d}d ${p(h)}h ${p(m)}m` : h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }
  const countdowns = $$('[data-countdown]');
  if (countdowns.length) {
    const serverNow = Number(document.body.getAttribute('data-server-now')) || Date.now();
    const offset = serverNow - Date.now();
    const tick = () => countdowns.forEach((el) => {
      const left = Number(el.getAttribute('data-countdown')) - (Date.now() + offset);
      el.textContent = fmtRemaining(left);
      if (left <= 0 && el.hasAttribute('data-reload') && !el.dataset.reloaded) {
        el.dataset.reloaded = '1';
        setTimeout(() => location.reload(), 800);
      }
    });
    tick();
    setInterval(tick, 1000);
  }

  // ---- Copy to clipboard ----
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const text = btn.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    const old = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = old; }, 1500);
  }));

  // ---- Confirm dialogs for destructive forms ----
  let dialog;
  function confirmDialog(message, okLabel, danger) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.innerHTML = '<form method="dialog"><div class="dialog-body"><h3>Are you sure?</h3><p class="msg muted"></p></div>' +
        '<div class="dialog-actions"><button class="btn btn-outline" value="cancel">Cancel</button><button class="btn ok" value="ok"></button></div></form>';
      document.body.appendChild(dialog);
    }
    $('.msg', dialog).textContent = message;
    const ok = $('.ok', dialog);
    ok.textContent = okLabel || 'Confirm';
    ok.className = 'btn ok ' + (danger ? 'btn-danger' : 'btn-primary');
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.showModal();
    });
  }
  window.QuizHub = Object.assign(window.QuizHub || {}, { confirmDialog, fmtRemaining });
  $$('form[data-confirm]').forEach((form) => form.addEventListener('submit', async (e) => {
    if (form.dataset.confirmed) return;
    e.preventDefault();
    const ok = await confirmDialog(form.getAttribute('data-confirm'), form.getAttribute('data-confirm-label'), form.hasAttribute('data-danger'));
    if (ok) { form.dataset.confirmed = '1'; form.requestSubmit ? form.requestSubmit() : form.submit(); }
  }));

  // ---- datetime-local inputs in the viewer's timezone ----
  $$('input[type="datetime-local"][data-ts]').forEach((input) => {
    const ts = Number(input.getAttribute('data-ts'));
    if (!ts) return;
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    input.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  $$('form').forEach((form) => {
    if (!$('input[type="datetime-local"]', form)) return;
    form.addEventListener('submit', () => {
      let tz = $('input[name="tz_offset"]', form);
      if (!tz) { tz = document.createElement('input'); tz.type = 'hidden'; tz.name = 'tz_offset'; form.appendChild(tz); }
      const start = $('input[name="start_at"]', form);
      tz.value = String(new Date(start && start.value ? start.value : Date.now()).getTimezoneOffset());
    });
  });

  // ---- Sortable + filterable tables ----
  $$('table[data-sortable]').forEach((table) => {
    const heads = $$('th[data-sort]', table);
    heads.forEach((th, idx) => {
      th.classList.add('sortable');
      th.tabIndex = 0;
      const col = Array.from(th.parentNode.children).indexOf(th);
      const sort = () => {
        const asc = !th.classList.contains('sort-asc');
        heads.forEach((h) => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');
        const type = th.getAttribute('data-sort');
        const body = table.tBodies[0];
        const rows = Array.from(body.rows);
        const val = (r) => {
          const cell = r.cells[col];
          const raw = cell ? (cell.getAttribute('data-value') ?? cell.textContent.trim()) : '';
          if (type === 'number') { const n = parseFloat(raw); return Number.isFinite(n) ? n : -Infinity; }
          return raw.toLowerCase();
        };
        rows.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); });
        rows.forEach((r) => body.appendChild(r));
      };
      th.addEventListener('click', sort);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sort(); });
      void idx;
    });
  });
  $$('[data-filter-table]').forEach((input) => {
    const table = $(input.getAttribute('data-filter-table'));
    const statusSel = $(input.getAttribute('data-status-select') || '#__none');
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      const st = statusSel ? statusSel.value : '';
      Array.from(table.tBodies[0].rows).forEach((r) => {
        const matchQ = !q || r.textContent.toLowerCase().includes(q);
        const matchS = !st || r.getAttribute('data-status') === st || r.getAttribute('data-result') === st;
        r.style.display = matchQ && matchS ? '' : 'none';
      });
    };
    input.addEventListener('input', apply);
    if (statusSel) statusSel.addEventListener('change', apply);
  });

  // ---- Auto-uppercase join code ----
  $$('input[data-uppercase]').forEach((i) => i.addEventListener('input', () => { i.value = i.value.toUpperCase(); }));
})();
