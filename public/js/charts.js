/* QuizHub — dashboard and results charts (Chart.js, served locally) */
(function () {
  'use strict';
  const dataEl = document.getElementById('chart-data');
  if (!dataEl || !window.Chart) return;
  const data = JSON.parse(dataEl.textContent);
  const charts = [];

  function palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    return {
      text: v('--text'), muted: v('--muted'), grid: v('--border'), primary: v('--primary'),
      accent: v('--accent'), success: v('--success'), danger: v('--danger'), warning: v('--warning'), surface2: v('--surface-2'),
    };
  }

  const pctAxis = (c) => ({ min: 0, max: 100, ticks: { color: c.muted, callback: (v) => v + '%' }, grid: { color: c.grid } });
  const catAxis = (c) => ({ ticks: { color: c.muted, autoSkip: true, maxRotation: 0, callback(v) { const l = this.getLabelForValue(v); return l.length > 14 ? l.slice(0, 13) + '…' : l; } }, grid: { display: false } });
  const base = (c) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: c.text, usePointStyle: true, boxWidth: 8 } }, tooltip: { mode: 'index', intersect: false } },
  });

  const builders = {
    'student-timeline': (c) => ({
      type: 'line',
      data: {
        labels: data.timeline.map((d) => d.label),
        datasets: [
          { label: 'Your score', data: data.timeline.map((d) => d.you), borderColor: c.primary, backgroundColor: c.primary + '33', fill: true, tension: .35, pointRadius: 4 },
          { label: 'Class average', data: data.timeline.map((d) => d.classAvg), borderColor: c.accent, borderDash: [6, 5], tension: .35, pointRadius: 3 },
        ],
      },
      options: { ...base(c), scales: { y: pctAxis(c), x: catAxis(c) } },
    }),
    'student-classroom': (c) => ({
      type: 'bar',
      data: { labels: data.byClassroom.map((d) => d.name), datasets: [{ label: 'Average %', data: data.byClassroom.map((d) => d.average), backgroundColor: c.primary, borderRadius: 8, maxBarThickness: 46 }] },
      options: { ...base(c), plugins: { ...base(c).plugins, legend: { display: false } }, scales: { y: pctAxis(c), x: catAxis(c) } },
    }),
    'student-outcome': (c) => ({
      type: 'doughnut',
      data: { labels: ['Correct', 'Wrong', 'Skipped'], datasets: [{ data: [data.outcome.correct, data.outcome.wrong, data.outcome.unanswered], backgroundColor: [c.success, c.danger, c.surface2], borderWidth: 0 }] },
      options: { ...base(c), cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: c.text, usePointStyle: true, boxWidth: 8 } } } },
    }),
    'faculty-recent': (c) => ({
      type: 'bar',
      data: {
        labels: data.recent.map((d) => d.label),
        datasets: [
          { label: 'Average score', data: data.recent.map((d) => d.avg), backgroundColor: c.primary, borderRadius: 6, maxBarThickness: 34 },
          { label: 'Attendance', data: data.recent.map((d) => d.attendance), backgroundColor: c.accent, borderRadius: 6, maxBarThickness: 34 },
        ],
      },
      options: { ...base(c), scales: { y: pctAxis(c), x: catAxis(c) } },
    }),
    'results-distribution': (c) => ({
      type: 'bar',
      data: {
        labels: ['0–9', '10–19', '20–29', '30–39', '40–49', '50–59', '60–69', '70–79', '80–89', '90–100'],
        datasets: [{ label: 'Students', data: data.distribution, backgroundColor: data.distribution.map((_, i) => (i < 4 ? c.danger : i < 7 ? c.warning : c.success)), borderRadius: 6 }],
      },
      options: { ...base(c), plugins: { ...base(c).plugins, legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: c.muted, precision: 0 }, grid: { color: c.grid } }, x: { ticks: { color: c.muted }, grid: { display: false }, title: { display: true, text: 'Score %', color: c.muted } } } },
    }),
    'results-questions': (c) => ({
      type: 'bar',
      data: { labels: data.questions.map((d) => d.label), datasets: [{ label: '% answered correctly', data: data.questions.map((d) => d.correct), backgroundColor: data.questions.map((d) => (d.correct == null ? c.grid : d.correct < 40 ? c.danger : d.correct < 70 ? c.warning : c.success)), borderRadius: 6, maxBarThickness: 30 }] },
      options: { ...base(c), indexAxis: data.questions.length > 8 ? 'y' : 'x', plugins: { ...base(c).plugins, legend: { display: false } }, scales: data.questions.length > 8 ? { x: pctAxis(c), y: { ticks: { color: c.muted }, grid: { display: false } } } : { y: pctAxis(c), x: catAxis(c) } },
    }),
    'results-attendance': (c) => ({
      type: 'doughnut',
      data: { labels: ['Submitted', 'In progress', 'Absent'], datasets: [{ data: [data.attendance.submitted, data.attendance.inProgress, data.attendance.absent], backgroundColor: [c.success, c.warning, c.surface2], borderWidth: 0 }] },
      options: { ...base(c), cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: c.text, usePointStyle: true, boxWidth: 8 } } } },
    }),
  };

  function render() {
    charts.splice(0).forEach((ch) => ch.destroy());
    const c = palette();
    document.querySelectorAll('canvas[data-chart]').forEach((canvas) => {
      const build = builders[canvas.getAttribute('data-chart')];
      if (build) charts.push(new window.Chart(canvas, build(c)));
    });
  }
  render();
  document.addEventListener('themechange', render);
})();
