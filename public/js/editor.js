/* QuizHub — faculty question editor and CSV import */
(function () {
  'use strict';
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const MAX = 6;

  function relabel(list) {
    $$('.option-row', list).forEach((row, i) => {
      row.querySelector('.letter').textContent = String.fromCharCode(65 + i);
      row.querySelector('input[type="radio"]').value = String(i);
      row.querySelector('input[type="text"]').placeholder = `Option ${String.fromCharCode(65 + i)}`;
      row.querySelector('input[type="text"]').setAttribute('aria-label', `Option ${String.fromCharCode(65 + i)}`);
    });
    const form = list.closest('form');
    const addBtn = form.querySelector('[data-add-option]');
    if (addBtn) addBtn.disabled = $$('.option-row', list).length >= MAX;
    $$('[data-remove-option]', list).forEach((b) => { b.disabled = $$('.option-row', list).length <= 2; });
  }

  function wire(form) {
    const list = form.querySelector('[data-options]');
    if (!list) return;
    const addBtn = form.querySelector('[data-add-option]');
    if (addBtn) addBtn.addEventListener('click', () => {
      const rows = $$('.option-row', list);
      if (rows.length >= MAX) return;
      const clone = rows[rows.length - 1].cloneNode(true);
      clone.querySelector('input[type="text"]').value = '';
      clone.querySelector('input[type="radio"]').checked = false;
      list.appendChild(clone);
      relabel(list);
      clone.querySelector('input[type="text"]').focus();
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-option]');
      if (!btn) return;
      if ($$('.option-row', list).length <= 2) return;
      btn.closest('.option-row').remove();
      relabel(list);
    });
    form.addEventListener('submit', (e) => {
      const filled = $$('.option-row', list).filter((r) => r.querySelector('input[type="text"]').value.trim());
      const checked = list.querySelector('input[type="radio"]:checked');
      let msg = '';
      if (filled.length < 2) msg = 'Add at least two answer options.';
      else if (!checked) msg = 'Select the correct answer (the radio button next to it).';
      else if (!checked.closest('.option-row').querySelector('input[type="text"]').value.trim()) msg = 'The option marked correct is empty.';
      if (msg) {
        e.preventDefault();
        const box = form.querySelector('[data-form-error]');
        if (box) { box.textContent = msg; box.classList.remove('hidden'); } else alert(msg);
      }
    });
    relabel(list);
  }
  $$('form[data-question-form]').forEach(wire);

  // CSV: read the chosen file into the textarea so it's submitted as text.
  const file = document.querySelector('[data-csv-file]');
  const area = document.querySelector('[data-csv-text]');
  if (file && area) file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 1.5 * 1024 * 1024) { alert('That file is too large (max 1.5 MB).'); file.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      area.value = String(reader.result);
      const n = area.value.trim().split(/\r?\n/).length - 1;
      const info = document.querySelector('[data-csv-info]');
      if (info) info.textContent = `${f.name} loaded · about ${n} question row${n === 1 ? '' : 's'}`;
    };
    reader.readAsText(f);
  });

  // Open the question that the URL points at (after save/move).
  if (location.hash.startsWith('#q-')) {
    const el = document.querySelector(location.hash);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
})();
