'use strict';
const ExcelJS = require('exceljs');

const STATUS_TEXT = { submitted: 'Submitted', auto_submitted: 'Auto-submitted (time up)', in_progress: 'In progress' };

function rowValues(r, fmtDate, fmtDuration) {
  return {
    rank: r.rank ?? '',
    name: r.name,
    email: r.email,
    institution_id: r.institution_id || '',
    status: r.status ? STATUS_TEXT[r.status] : 'Absent',
    score: r.percent !== null ? r.score : '',
    max_score: r.percent !== null ? r.max_score : '',
    percent: r.percent !== null ? r.percent / 100 : '',
    result: r.passed === null ? '' : r.passed ? 'Pass' : 'Fail',
    correct: r.correct_count ?? '',
    wrong: r.wrong_count ?? '',
    unanswered: r.unanswered_count ?? '',
    time_taken: r.time_taken_ms != null ? fmtDuration(r.time_taken_ms) : '',
    tab_switches: r.status ? r.tab_switches : '',
    started_at: r.started_at ? fmtDate(r.started_at) : '',
    submitted_at: r.submitted_at ? fmtDate(r.submitted_at) : '',
  };
}

const COLUMNS = [
  { header: 'Rank', key: 'rank', width: 7 },
  { header: 'Student', key: 'name', width: 24 },
  { header: 'Email', key: 'email', width: 28 },
  { header: 'Student ID', key: 'institution_id', width: 14 },
  { header: 'Status', key: 'status', width: 24 },
  { header: 'Score', key: 'score', width: 9 },
  { header: 'Out of', key: 'max_score', width: 9 },
  { header: 'Percent', key: 'percent', width: 10, style: { numFmt: '0.0%' } },
  { header: 'Result', key: 'result', width: 9 },
  { header: 'Correct', key: 'correct', width: 9 },
  { header: 'Wrong', key: 'wrong', width: 9 },
  { header: 'Unanswered', key: 'unanswered', width: 12 },
  { header: 'Time taken', key: 'time_taken', width: 12 },
  { header: 'Tab switches', key: 'tab_switches', width: 13 },
  { header: 'Started', key: 'started_at', width: 22 },
  { header: 'Submitted', key: 'submitted_at', width: 22 },
];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
const FILLS = {
  Pass: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } },
  Fail: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } },
  Absent: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } },
};

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

function buildResultsWorkbook({ quiz, rows, stats, questionStats, classroomName, fmtDate, fmtDuration }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QuizHub';
  wb.created = new Date();

  // Sheet 1: summary
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 26 }, { width: 40 }];
  summary.addRow([quiz.title]).font = { bold: true, size: 16 };
  summary.addRow([]);
  const info = [
    ['Classroom', classroomName],
    ['Opens', fmtDate(quiz.start_at)],
    ['Closes', fmtDate(quiz.end_at)],
    ['Duration', `${quiz.duration_minutes} minutes`],
    ['Total marks', stats.maxScore],
    ['Negative marking', quiz.negative_marking ? `${quiz.negative_marking * 100}% of question marks` : 'None'],
    ['Pass mark', `${quiz.pass_percent}%`],
    [],
    ['Students (enrolled + attempted)', stats.enrolled],
    ['Attended', stats.attended],
    ['Submitted', stats.submitted],
    ['Absent', stats.absent],
    ['Attendance rate', stats.enrolled ? stats.attended / stats.enrolled : 0],
    ['Passed', stats.passed],
    ['Average score', stats.average !== null ? stats.average / 100 : 'n/a'],
    ['Median score', stats.median !== null ? stats.median / 100 : 'n/a'],
    ['Highest score', stats.highest !== null ? stats.highest / 100 : 'n/a'],
    ['Lowest score', stats.lowest !== null ? stats.lowest / 100 : 'n/a'],
    ['Exported', fmtDate(Date.now())],
  ];
  for (const r of info) {
    const row = summary.addRow(r);
    row.getCell(1).font = { bold: true };
    if (typeof r[1] === 'number' && r[1] <= 1 && /rate|score/i.test(r[0])) row.getCell(2).numFmt = '0.0%';
    row.getCell(2).alignment = { horizontal: 'left' };
  }

  // Sheet 2: one row per student
  const sheet = wb.addWorksheet('Student results', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS;
  styleHeader(sheet.getRow(1));
  const sorted = rows.slice().sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  for (const r of sorted) {
    const v = rowValues(r, fmtDate, fmtDuration);
    const row = sheet.addRow(v);
    const fill = FILLS[v.result] || (v.status === 'Absent' ? FILLS.Absent : null);
    if (fill) row.getCell('result').fill = fill;
    if (v.status === 'Absent') row.getCell('status').fill = FILLS.Absent;
    if (r.tab_switches >= 3) row.getCell('tab_switches').font = { color: { argb: 'FFB91C1C' }, bold: true };
  }
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  // Sheet 3: per-question analysis
  const qs = wb.addWorksheet('Question analysis', { views: [{ state: 'frozen', ySplit: 1 }] });
  const maxOpts = Math.max(2, ...questionStats.map((q) => q.options.length));
  qs.columns = [
    { header: '#', key: 'n', width: 5 },
    { header: 'Question', key: 'text', width: 50 },
    { header: 'Marks', key: 'marks', width: 8 },
    { header: 'Correct', key: 'correct', width: 9 },
    { header: 'Skipped', key: 'skipped', width: 9 },
    { header: '% correct', key: 'pct', width: 11, style: { numFmt: '0.0%' } },
    ...Array.from({ length: maxOpts }, (_, i) => ({ header: `Option ${String.fromCharCode(65 + i)} (picks)`, key: `o${i}`, width: 24 })),
  ];
  styleHeader(qs.getRow(1));
  for (const q of questionStats) {
    const values = { n: q.number, text: q.text, marks: q.marks, correct: q.correct, skipped: q.skipped, pct: q.correctPercent !== null ? q.correctPercent / 100 : '' };
    q.options.forEach((o, i) => { values[`o${i}`] = `${o.is_correct ? '✔ ' : ''}${o.text} (${o.count})`; });
    const row = qs.addRow(values);
    row.getCell('text').alignment = { wrapText: true, vertical: 'top' };
    q.options.forEach((o, i) => { if (o.is_correct) row.getCell(`o${i}`).fill = FILLS.Pass; });
  }
  return wb;
}

function csvCell(v) {
  const s = String(v ?? '');
  // Prefix cells that a spreadsheet would treat as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function buildResultsCsv({ rows, fmtDate, fmtDuration }) {
  const lines = [COLUMNS.map((c) => c.header).map(csvCell).join(',')];
  const sorted = rows.slice().sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
  for (const r of sorted) {
    const v = rowValues(r, fmtDate, fmtDuration);
    if (v.percent !== '') v.percent = `${(v.percent * 100).toFixed(1)}%`;
    lines.push(COLUMNS.map((c) => csvCell(v[c.key])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { buildResultsWorkbook, buildResultsCsv };
