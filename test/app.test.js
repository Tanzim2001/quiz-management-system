'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quizhub-test-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const svc = require('../src/lib/quizService');

after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// An agent that keeps cookies and knows the current CSRF token.
async function agentFor() {
  const agent = request.agent(app);
  agent.csrf = async () => {
    const res = await agent.get('/login').redirects(1);
    const m = res.text.match(/name="csrf-token" content="([^"]+)"/);
    return m[1];
  };
  agent.form = async (url, data = {}) => {
    const _csrf = await agent.csrf(); // fetch first: cookies are attached when a request is created
    return agent.post(url).type('form').send({ _csrf, ...data });
  };
  return agent;
}

async function register(role, email) {
  const agent = await agentFor();
  const res = await agent.form('/register', { name: `${role} ${email}`, email, password: 'secret123', confirm_password: 'secret123', role });
  assert.equal(res.status, 302, `register ${email}`);
  return agent;
}

const ctx = {};

before(async () => {
  ctx.faculty = await register('faculty', 'prof@test.dev');
  ctx.otherFaculty = await register('faculty', 'other@test.dev');
  ctx.alice = await register('student', 'alice@test.dev');
  ctx.bob = await register('student', 'bob@test.dev');
});

test('rejects bad registration and wrong passwords', async () => {
  const a = await agentFor();
  const dup = await a.form('/register', { name: 'X Y', email: 'alice@test.dev', password: 'secret123', confirm_password: 'secret123', role: 'student' });
  assert.equal(dup.status, 422);
  assert.match(dup.text, /already exists/);
  const bad = await a.form('/login', { email: 'alice@test.dev', password: 'nope' });
  assert.equal(bad.status, 401);
});

test('POST without a CSRF token is refused', async () => {
  const res = await ctx.faculty.post('/faculty/classrooms').type('form').send({ name: 'No token' });
  assert.equal(res.status, 403);
});

test('students cannot open faculty pages', async () => {
  const res = await ctx.alice.get('/faculty');
  assert.equal(res.status, 403);
});

test('full quiz lifecycle', async (t) => {
  const f = ctx.faculty;

  await t.test('faculty creates a classroom and students join by code', async () => {
    const res = await f.form('/faculty/classrooms', { name: 'Algorithms 101', subject: 'CS', leaderboard_enabled: '1' });
    assert.equal(res.status, 302);
    ctx.classroom = db.prepare("SELECT * FROM classrooms WHERE name = 'Algorithms 101'").get();
    assert.match(ctx.classroom.code, /^[A-Z2-9]{6}$/);
    for (const s of [ctx.alice, ctx.bob]) {
      const j = await s.form('/student/classrooms/join', { code: ctx.classroom.code.toLowerCase() });
      assert.equal(j.status, 302);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE classroom_id = ?').get(ctx.classroom.id).n, 2);
    const bad = await ctx.alice.form('/student/classrooms/join', { code: 'ZZZZZZ' });
    assert.equal(bad.headers.location, '/student/classrooms');
  });

  await t.test('another faculty member cannot see the classroom', async () => {
    const res = await ctx.otherFaculty.get(`/faculty/classrooms/${ctx.classroom.id}`);
    assert.equal(res.status, 404);
  });

  await t.test('faculty creates a quiz with questions and CSV import', async () => {
    const now = Date.now();
    const iso = (ts) => new Date(ts).toISOString().slice(0, 16);
    const res = await f.form(`/faculty/classrooms/${ctx.classroom.id}/quizzes`, {
      title: 'Big-O quiz', duration_minutes: '10', start_at: iso(now - 60000), end_at: iso(now + 3600000), tz_offset: '0',
      negative_marking: '0.5', review_policy: 'after_submit', pass_percent: '50',
    });
    assert.equal(res.status, 302);
    ctx.quiz = db.prepare("SELECT * FROM quizzes WHERE title = 'Big-O quiz'").get();
    assert.equal(ctx.quiz.published, 0);
    assert.equal(ctx.quiz.negative_marking, 0.5);

    const q1 = await f.form(`/faculty/quizzes/${ctx.quiz.id}/questions`, { text: 'Binary search is', 'options': ['O(n)', 'O(log n)', 'O(1)'], correct: '1', marks: '2' });
    assert.equal(q1.status, 302);
    // Publishing an empty-answer question must fail validation.
    await f.form(`/faculty/quizzes/${ctx.quiz.id}/questions`, { text: 'Missing correct', options: ['a', 'b'] });
    const csv = 'question,option_a,option_b,option_c,correct,marks,explanation\n"Hash lookup avg",O(1),O(n),O(n log n),A,1,Constant time\n"Merge sort",O(n),O(n log n),O(n^2),O(n log n),1,\n';
    const imp = await f.form(`/faculty/quizzes/${ctx.quiz.id}/import`, { csv });
    assert.equal(imp.status, 302);
    const qs = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position').all(ctx.quiz.id);
    assert.equal(qs.length, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM options WHERE question_id = ? AND is_correct = 1').get(qs[2].id).n, 1);

    const badCsv = await f.form(`/faculty/quizzes/${ctx.quiz.id}/import`, { csv: 'question,option_a,option_b,correct\n"x",a,b,Z\n' });
    assert.equal(badCsv.status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?').get(ctx.quiz.id).n, 3);
  });

  await t.test('students cannot see a draft; publishing notifies them', async () => {
    assert.equal((await ctx.alice.get(`/student/quizzes/${ctx.quiz.id}`)).status, 404);
    const res = await f.form(`/faculty/quizzes/${ctx.quiz.id}/publish`);
    assert.equal(res.status, 302);
    assert.equal(db.prepare('SELECT published FROM quizzes WHERE id = ?').get(ctx.quiz.id).published, 1);
    const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE message LIKE '%Big-O quiz%'").get().n;
    assert.equal(n, 2);
    assert.equal((await ctx.alice.get(`/student/quizzes/${ctx.quiz.id}`)).status, 200);
  });

  await t.test('alice takes the quiz: autosave, tab switch, submit, scoring with negative marking', async () => {
    const a = ctx.alice;
    const start = await a.form(`/student/quizzes/${ctx.quiz.id}/start`);
    assert.equal(start.status, 302);
    const attempt = db.prepare('SELECT * FROM attempts WHERE quiz_id = ? AND student_id = (SELECT id FROM users WHERE email = ?)').get(ctx.quiz.id, 'alice@test.dev');
    ctx.aliceAttempt = attempt;
    assert.equal(attempt.status, 'in_progress');
    assert.ok(attempt.deadline_at - attempt.started_at <= 10 * 60000 + 5);

    const page = await a.get(`/student/attempts/${attempt.id}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /is_correct/);
    const token = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];

    const content = svc.loadQuizContent(ctx.quiz.id);
    const [q1, q2] = [...content.values()];
    const right = q1.options.find((o) => o.is_correct);   // +2
    const wrong = q2.options.find((o) => !o.is_correct);   // -0.5
    for (const [qid, oid] of [[q1.id, right.id], [q2.id, wrong.id]]) {
      const r = await a.post(`/student/attempts/${attempt.id}/answer`).set('X-CSRF-Token', token).send({ questionId: qid, optionId: oid });
      assert.equal(r.status, 200);
    }
    const foreign = await a.post(`/student/attempts/${attempt.id}/answer`).set('X-CSRF-Token', token).send({ questionId: q1.id, optionId: wrong.id });
    assert.equal(foreign.status, 409, 'option from another question is rejected');

    await a.post(`/student/attempts/${attempt.id}/event`).set('X-CSRF-Token', token).send({ type: 'tab_switch' });
    // Bob cannot touch Alice's attempt.
    const bobPage = await ctx.bob.get(`/student/attempts/${attempt.id}`);
    assert.equal(bobPage.status, 404);

    const sub = await a.post(`/student/attempts/${attempt.id}/submit`).set('X-CSRF-Token', token).send({});
    assert.equal(sub.status, 200);
    const done = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt.id);
    assert.equal(done.status, 'submitted');
    assert.equal(done.score, 1.5);
    assert.equal(done.max_score, 4);
    assert.deepEqual([done.correct_count, done.wrong_count, done.unanswered_count], [1, 1, 1]);
    assert.equal(done.tab_switches, 1);

    const late = await a.post(`/student/attempts/${attempt.id}/answer`).set('X-CSRF-Token', token).send({ questionId: q1.id, optionId: right.id });
    assert.equal(late.status, 409);

    const result = await a.get(`/student/attempts/${attempt.id}/result`);
    assert.equal(result.status, 200);
    assert.match(result.text, /Answer review/);
    assert.match(result.text, /Constant time|✓ Correct/);
  });

  await t.test('questions lock once someone has started', async () => {
    const q = db.prepare('SELECT id FROM questions WHERE quiz_id = ? LIMIT 1').get(ctx.quiz.id);
    await f.form(`/faculty/quizzes/${ctx.quiz.id}/questions/${q.id}/delete`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE quiz_id = ?').get(ctx.quiz.id).n, 3);
  });

  await t.test('an expired attempt is auto-submitted', async () => {
    await ctx.bob.form(`/student/quizzes/${ctx.quiz.id}/start`);
    const bobAttempt = db.prepare("SELECT * FROM attempts WHERE quiz_id = ? AND student_id = (SELECT id FROM users WHERE email = 'bob@test.dev')").get(ctx.quiz.id);
    db.prepare('UPDATE attempts SET deadline_at = ? WHERE id = ?').run(Date.now() - 60000, bobAttempt.id);
    assert.equal(svc.finalizeExpired(), 1);
    const done = db.prepare('SELECT * FROM attempts WHERE id = ?').get(bobAttempt.id);
    assert.equal(done.status, 'auto_submitted');
    assert.equal(done.score, 0);
  });

  await t.test('faculty results, spreadsheet export and student dashboard', async () => {
    const page = await f.get(`/faculty/quizzes/${ctx.quiz.id}/results`);
    assert.equal(page.status, 200);
    assert.match(page.text, /alice@test\.dev/);

    const report = svc.quizReport(ctx.quiz.id);
    assert.equal(report.stats.enrolled, 2);
    assert.equal(report.stats.attended, 2);
    assert.equal(report.stats.average, 18.8); // (37.5 + 0) / 2

    const xlsx = await f.get(`/faculty/quizzes/${ctx.quiz.id}/results.xlsx`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.slice(0, 2).toString(), 'PK');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Student results', 'Question analysis']);
    assert.equal(wb.getWorksheet('Student results').rowCount, 3);

    const csv = await f.get(`/faculty/quizzes/${ctx.quiz.id}/results.csv`);
    assert.match(csv.text, /Rank,Student,Email/);
    assert.equal((await ctx.otherFaculty.get(`/faculty/quizzes/${ctx.quiz.id}/results.xlsx`)).status, 404);

    const dash = await ctx.alice.get('/student');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Big-O quiz/);
    const analytics = svc.studentAnalytics(db.prepare("SELECT id FROM users WHERE email = 'alice@test.dev'").get().id);
    assert.equal(analytics.summary.taken, 1);
    assert.equal(analytics.attempts[0].percent, 37.5);
  });

  await t.test('announcements notify students', async () => {
    await f.form(`/faculty/classrooms/${ctx.classroom.id}/announcements`, { title: 'Exam moved', body: 'Now on Friday.' });
    const res = await ctx.bob.get('/notifications');
    assert.match(res.text, /Exam moved/);
  });
});

test('quiz that has not opened yet cannot be started', async () => {
  const now = Date.now();
  const info = db.prepare(`INSERT INTO quizzes (classroom_id, title, duration_minutes, start_at, end_at, published, created_at)
    VALUES (?, 'Future quiz', 5, ?, ?, 1, ?)`).run(ctx.classroom.id, now + 3600000, now + 7200000, now);
  db.prepare("INSERT INTO questions (quiz_id, text, marks, position) VALUES (?, 'q', 1, 1)").run(info.lastInsertRowid);
  const res = await ctx.alice.form(`/student/quizzes/${info.lastInsertRowid}/start`);
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE quiz_id = ?').get(info.lastInsertRowid).n, 0);
});
