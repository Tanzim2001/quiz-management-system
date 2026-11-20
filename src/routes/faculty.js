'use strict';
const express = require('express');
const { parse: parseCsv } = require('csv-parse/sync');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { toInt, randomCode, quizStatus, parseLocalDateTime, round } = require('../lib/util');
const { fmtDate, fmtDuration } = require('../lib/viewHelpers');
const svc = require('../lib/quizService');
const { notifyClassroom } = require('../lib/notify');
const { buildResultsWorkbook, buildResultsCsv } = require('../lib/exporter');

const router = express.Router();
router.use(requireRole('faculty'));

const MAX_OPTIONS = 6;

function notFound(res, what = 'page') {
  return res.status(404).render('error', { title: 'Not found', status: 404, message: `That ${what} doesn't exist or isn't yours.` });
}

function ownClassroom(id, facultyId) {
  return db.prepare('SELECT * FROM classrooms WHERE id = ? AND faculty_id = ?').get(toInt(id), facultyId);
}

function ownQuiz(id, facultyId) {
  return db.prepare(`SELECT qz.*, c.name AS classroom_name, c.faculty_id FROM quizzes qz
    JOIN classrooms c ON c.id = qz.classroom_id WHERE qz.id = ? AND c.faculty_id = ?`).get(toInt(id), facultyId);
}

function uniqueCode() {
  for (;;) {
    const code = randomCode(6);
    if (!db.prepare('SELECT 1 FROM classrooms WHERE code = ?').get(code)) return code;
  }
}

function attemptCount(quizId) {
  return db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE quiz_id = ?').get(quizId).n;
}

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  svc.finalizeExpired();
  const fid = req.user.id;
  const classrooms = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM enrollments WHERE classroom_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM quizzes WHERE classroom_id = c.id) AS quiz_count
    FROM classrooms c WHERE faculty_id = ? ORDER BY created_at DESC`).all(fid);
  const quizzes = db.prepare(`
    SELECT qz.*, c.name AS classroom_name,
      (SELECT COUNT(*) FROM enrollments WHERE classroom_id = qz.classroom_id) AS enrolled,
      (SELECT COUNT(*) FROM attempts WHERE quiz_id = qz.id) AS attended,
      (SELECT AVG(score * 100.0 / NULLIF(max_score, 0)) FROM attempts WHERE quiz_id = qz.id AND status != 'in_progress') AS avg_percent
    FROM quizzes qz JOIN classrooms c ON c.id = qz.classroom_id
    WHERE c.faculty_id = ? ORDER BY qz.start_at DESC`).all(fid);
  const now = Date.now();
  for (const q of quizzes) q.status = quizStatus(q, now);
  const totals = {
    classrooms: classrooms.length,
    students: db.prepare(`SELECT COUNT(DISTINCT e.student_id) AS n FROM enrollments e
      JOIN classrooms c ON c.id = e.classroom_id WHERE c.faculty_id = ?`).get(fid).n,
    quizzes: quizzes.length,
    attempts: quizzes.reduce((s, q) => s + q.attended, 0),
  };
  const recent = quizzes.filter((q) => q.status === 'closed').slice(0, 6).reverse();
  res.render('faculty/dashboard', {
    title: 'Dashboard',
    classrooms,
    totals,
    active: quizzes.filter((q) => q.status === 'live' || q.status === 'upcoming').sort((a, b) => a.start_at - b.start_at),
    drafts: quizzes.filter((q) => q.status === 'draft'),
    recent: quizzes.filter((q) => q.status === 'closed').slice(0, 5),
    chartData: {
      recent: recent.map((q) => ({
        label: q.title,
        avg: q.avg_percent === null ? null : round(q.avg_percent, 1),
        attendance: q.enrolled ? round((q.attended / q.enrolled) * 100, 1) : 0,
      })),
    },
  });
});

// ---------- Classrooms ----------

function classroomValues(body) {
  return {
    name: String(body.name || '').trim(),
    subject: String(body.subject || '').trim(),
    description: String(body.description || '').trim(),
    leaderboard_enabled: body.leaderboard_enabled ? 1 : 0,
  };
}

function classroomErrors(v) {
  const errors = {};
  if (v.name.length < 2 || v.name.length > 100) errors.name = 'Give the classroom a name (2–100 characters).';
  if (v.subject.length > 100) errors.subject = 'Too long.';
  if (v.description.length > 2000) errors.description = 'Too long.';
  return errors;
}

router.get('/classrooms/new', (req, res) => {
  res.render('faculty/classroom-new', { title: 'New classroom', values: { leaderboard_enabled: 1 }, errors: {} });
});

router.post('/classrooms', (req, res) => {
  const values = classroomValues(req.body);
  const errors = classroomErrors(values);
  if (Object.keys(errors).length) return res.status(422).render('faculty/classroom-new', { title: 'New classroom', values, errors });
  const info = db.prepare(`INSERT INTO classrooms (faculty_id, name, subject, description, code, leaderboard_enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, values.name, values.subject || null, values.description || null,
    uniqueCode(), values.leaderboard_enabled, Date.now());
  req.flash('success', 'Classroom created. Share the join code with your students.');
  res.redirect(`/faculty/classrooms/${info.lastInsertRowid}`);
});

router.get('/classrooms/:id', (req, res) => {
  svc.finalizeExpired();
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const quizzes = db.prepare(`
    SELECT qz.*,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = qz.id) AS question_count,
      (SELECT COUNT(*) FROM attempts WHERE quiz_id = qz.id) AS attended,
      (SELECT AVG(score * 100.0 / NULLIF(max_score, 0)) FROM attempts WHERE quiz_id = qz.id AND status != 'in_progress') AS avg_percent
    FROM quizzes qz WHERE classroom_id = ? ORDER BY start_at DESC`).all(classroom.id);
  const now = Date.now();
  for (const q of quizzes) q.status = quizStatus(q, now);
  const students = db.prepare(`
    SELECT u.id, u.name, u.email, u.institution_id, e.joined_at,
      (SELECT COUNT(*) FROM attempts a JOIN quizzes qz ON qz.id = a.quiz_id
        WHERE a.student_id = u.id AND qz.classroom_id = @cid AND a.status != 'in_progress') AS taken,
      (SELECT AVG(a.score * 100.0 / NULLIF(a.max_score, 0)) FROM attempts a JOIN quizzes qz ON qz.id = a.quiz_id
        WHERE a.student_id = u.id AND qz.classroom_id = @cid AND a.status != 'in_progress') AS avg_percent
    FROM enrollments e JOIN users u ON u.id = e.student_id
    WHERE e.classroom_id = @cid ORDER BY u.name COLLATE NOCASE`).all({ cid: classroom.id });
  const announcements = db.prepare('SELECT * FROM announcements WHERE classroom_id = ? ORDER BY created_at DESC').all(classroom.id);
  const tabs = ['quizzes', 'students', 'announcements', 'leaderboard', 'settings'];
  res.render('faculty/classroom', {
    title: classroom.name,
    classroom,
    quizzes,
    students,
    announcements,
    leaderboard: svc.classroomLeaderboard(classroom.id),
    tab: tabs.includes(req.query.tab) ? req.query.tab : 'quizzes',
    errors: {},
  });
});

router.post('/classrooms/:id/edit', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const values = classroomValues(req.body);
  const errors = classroomErrors(values);
  if (Object.keys(errors).length) {
    req.flash('error', Object.values(errors)[0]);
  } else {
    db.prepare('UPDATE classrooms SET name = ?, subject = ?, description = ?, leaderboard_enabled = ? WHERE id = ?')
      .run(values.name, values.subject || null, values.description || null, values.leaderboard_enabled, classroom.id);
    req.flash('success', 'Classroom settings saved.');
  }
  res.redirect(`/faculty/classrooms/${classroom.id}?tab=settings`);
});

router.post('/classrooms/:id/regenerate-code', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  db.prepare('UPDATE classrooms SET code = ? WHERE id = ?').run(uniqueCode(), classroom.id);
  req.flash('success', 'New join code created. The old code no longer works.');
  res.redirect(`/faculty/classrooms/${classroom.id}?tab=settings`);
});

router.post('/classrooms/:id/delete', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  if (req.body.confirm_name !== classroom.name) {
    req.flash('error', 'Type the classroom name exactly to confirm deletion.');
    return res.redirect(`/faculty/classrooms/${classroom.id}?tab=settings`);
  }
  db.prepare('DELETE FROM classrooms WHERE id = ?').run(classroom.id);
  req.flash('success', `Deleted ${classroom.name}.`);
  res.redirect('/faculty');
});

router.post('/classrooms/:id/students/:sid/remove', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  db.prepare('DELETE FROM enrollments WHERE classroom_id = ? AND student_id = ?').run(classroom.id, toInt(req.params.sid));
  req.flash('success', 'Student removed from the classroom. Their past results are kept.');
  res.redirect(`/faculty/classrooms/${classroom.id}?tab=students`);
});

router.post('/classrooms/:id/announcements', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();
  if (!title || !body || title.length > 150 || body.length > 5000) {
    req.flash('error', 'An announcement needs a title (up to 150 characters) and a message.');
  } else {
    db.prepare('INSERT INTO announcements (classroom_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(classroom.id, req.user.id, title, body, Date.now());
    notifyClassroom(classroom.id, `📢 ${classroom.name}: ${title}`, `/student/classrooms/${classroom.id}?tab=announcements`);
    req.flash('success', 'Announcement posted and students notified.');
  }
  res.redirect(`/faculty/classrooms/${classroom.id}?tab=announcements`);
});

router.post('/classrooms/:id/announcements/:aid/delete', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  db.prepare('DELETE FROM announcements WHERE id = ? AND classroom_id = ?').run(toInt(req.params.aid), classroom.id);
  req.flash('success', 'Announcement deleted.');
  res.redirect(`/faculty/classrooms/${classroom.id}?tab=announcements`);
});

// ---------- Quiz settings ----------

function quizValues(body) {
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    duration_minutes: toInt(body.duration_minutes),
    start_at: parseLocalDateTime(body.start_at, body.tz_offset),
    end_at: parseLocalDateTime(body.end_at, body.tz_offset),
    shuffle_questions: body.shuffle_questions ? 1 : 0,
    shuffle_options: body.shuffle_options ? 1 : 0,
    negative_marking: Math.min(1, Math.max(0, Number(body.negative_marking) || 0)),
    review_policy: ['after_submit', 'after_close', 'never'].includes(body.review_policy) ? body.review_policy : 'after_close',
    pass_percent: Math.min(100, Math.max(0, toInt(body.pass_percent) ?? 40)),
  };
}

function quizErrors(v) {
  const errors = {};
  if (v.title.length < 2 || v.title.length > 150) errors.title = 'Give the quiz a title (2–150 characters).';
  if (v.description.length > 3000) errors.description = 'Too long.';
  if (!v.duration_minutes || v.duration_minutes < 1 || v.duration_minutes > 600) errors.duration_minutes = 'Duration must be 1–600 minutes.';
  if (!v.start_at) errors.start_at = 'Pick when the quiz opens.';
  if (!v.end_at) errors.end_at = 'Pick when the quiz closes.';
  else if (v.start_at && v.end_at <= v.start_at) errors.end_at = 'The closing time must be after the opening time.';
  return errors;
}

router.get('/classrooms/:id/quizzes/new', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const start = new Date(Date.now() + 24 * 3600 * 1000);
  start.setMinutes(0, 0, 0);
  res.render('faculty/quiz-new', {
    title: 'New quiz',
    classroom,
    values: {
      duration_minutes: 20, start_at: start.getTime(), end_at: start.getTime() + 2 * 3600 * 1000,
      shuffle_questions: 1, shuffle_options: 1, negative_marking: 0, review_policy: 'after_close', pass_percent: 40,
    },
    errors: {},
  });
});

router.post('/classrooms/:id/quizzes', (req, res) => {
  const classroom = ownClassroom(req.params.id, req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const values = quizValues(req.body);
  const errors = quizErrors(values);
  if (Object.keys(errors).length) return res.status(422).render('faculty/quiz-new', { title: 'New quiz', classroom, values, errors });
  const info = db.prepare(`INSERT INTO quizzes (classroom_id, title, description, duration_minutes, start_at, end_at,
    shuffle_questions, shuffle_options, negative_marking, review_policy, pass_percent, published, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(classroom.id, values.title, values.description || null,
    values.duration_minutes, values.start_at, values.end_at, values.shuffle_questions, values.shuffle_options,
    values.negative_marking, values.review_policy, values.pass_percent, Date.now());
  req.flash('success', 'Quiz created as a draft. Add questions, then publish it.');
  res.redirect(`/faculty/quizzes/${info.lastInsertRowid}`);
});

router.get('/quizzes/:id', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const questions = [...svc.loadQuizContent(quiz.id).values()];
  res.render('faculty/quiz-edit', {
    title: quiz.title,
    quiz,
    questions,
    status: quizStatus(quiz),
    locked: attemptCount(quiz.id) > 0,
    totalMarks: round(questions.reduce((s, q) => s + q.marks, 0)),
    errors: {},
    MAX_OPTIONS,
  });
});

router.post('/quizzes/:id/settings', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const values = quizValues(req.body);
  const errors = quizErrors(values);
  if (Object.keys(errors).length) {
    req.flash('error', Object.values(errors)[0]);
    return res.redirect(`/faculty/quizzes/${quiz.id}#settings`);
  }
  if (attemptCount(quiz.id) > 0) {
    // Scoring rules are frozen once someone has started; schedule and display options stay editable.
    values.shuffle_questions = quiz.shuffle_questions;
    values.shuffle_options = quiz.shuffle_options;
    values.negative_marking = quiz.negative_marking;
  }
  db.prepare(`UPDATE quizzes SET title = ?, description = ?, duration_minutes = ?, start_at = ?, end_at = ?,
    shuffle_questions = ?, shuffle_options = ?, negative_marking = ?, review_policy = ?, pass_percent = ? WHERE id = ?`)
    .run(values.title, values.description || null, values.duration_minutes, values.start_at, values.end_at,
      values.shuffle_questions, values.shuffle_options, values.negative_marking, values.review_policy, values.pass_percent, quiz.id);
  if (quiz.published && (values.start_at !== quiz.start_at || values.end_at !== quiz.end_at)) {
    notifyClassroom(quiz.classroom_id, `🗓️ "${values.title}" was rescheduled: opens ${fmtDate(values.start_at)}.`, `/student/quizzes/${quiz.id}`);
  }
  req.flash('success', 'Quiz settings saved.');
  res.redirect(`/faculty/quizzes/${quiz.id}`);
});

function publishProblems(quizId) {
  const questions = [...svc.loadQuizContent(quizId).values()];
  if (!questions.length) return ['Add at least one question.'];
  const problems = [];
  questions.forEach((q, i) => {
    if (q.options.length < 2) problems.push(`Question ${i + 1} needs at least two options.`);
    if (q.options.filter((o) => o.is_correct).length !== 1) problems.push(`Question ${i + 1} needs exactly one correct answer.`);
  });
  return problems;
}

router.post('/quizzes/:id/publish', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const problems = publishProblems(quiz.id);
  if (quiz.end_at <= Date.now()) problems.push('The closing time is in the past. Update the schedule first.');
  if (problems.length) {
    req.flash('error', `Can't publish yet: ${problems.join(' ')}`);
    return res.redirect(`/faculty/quizzes/${quiz.id}`);
  }
  db.prepare('UPDATE quizzes SET published = 1 WHERE id = ?').run(quiz.id);
  notifyClassroom(quiz.classroom_id, `📝 New quiz in ${quiz.classroom_name}: "${quiz.title}" opens ${fmtDate(quiz.start_at)}.`, `/student/quizzes/${quiz.id}`);
  req.flash('success', 'Quiz published. Students have been notified of the schedule.');
  res.redirect(`/faculty/quizzes/${quiz.id}`);
});

router.post('/quizzes/:id/unpublish', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  if (attemptCount(quiz.id) > 0) {
    req.flash('error', 'Students have already taken this quiz, so it can no longer be unpublished.');
  } else {
    db.prepare('UPDATE quizzes SET published = 0 WHERE id = ?').run(quiz.id);
    req.flash('success', 'Quiz moved back to draft. Students can no longer see it.');
  }
  res.redirect(`/faculty/quizzes/${quiz.id}`);
});

router.post('/quizzes/:id/close-now', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const now = Date.now();
  db.prepare('UPDATE quizzes SET end_at = ?, start_at = MIN(start_at, ?) WHERE id = ?').run(now, now, quiz.id);
  db.prepare("UPDATE attempts SET deadline_at = MIN(deadline_at, ?) WHERE quiz_id = ? AND status = 'in_progress'").run(now, quiz.id);
  svc.finalizeExpired(now + svc.GRACE_MS);
  req.flash('success', 'Quiz closed. Any in-progress attempts were submitted automatically.');
  res.redirect(`/faculty/quizzes/${quiz.id}/results`);
});

router.post('/quizzes/:id/delete', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
  req.flash('success', `Deleted "${quiz.title}" and its results.`);
  res.redirect(`/faculty/classrooms/${quiz.classroom_id}`);
});

router.post('/quizzes/:id/duplicate', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const target = ownClassroom(req.body.classroom_id || quiz.classroom_id, req.user.id);
  if (!target) return notFound(res, 'classroom');
  const now = Date.now();
  const newId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO quizzes (classroom_id, title, description, duration_minutes, start_at, end_at,
      shuffle_questions, shuffle_options, negative_marking, review_policy, pass_percent, published, created_at)
      SELECT ?, title || ' (copy)', description, duration_minutes, ?, ?, shuffle_questions, shuffle_options,
      negative_marking, review_policy, pass_percent, 0, ? FROM quizzes WHERE id = ?`)
      .run(target.id, now + 24 * 3600 * 1000, now + 26 * 3600 * 1000, now, quiz.id);
    const id = info.lastInsertRowid;
    for (const q of svc.loadQuizContent(quiz.id).values()) {
      const qi = db.prepare('INSERT INTO questions (quiz_id, text, explanation, marks, position) VALUES (?, ?, ?, ?, ?)')
        .run(id, q.text, q.explanation, q.marks, q.position);
      for (const o of q.options) {
        db.prepare('INSERT INTO options (question_id, text, is_correct, position) VALUES (?, ?, ?, ?)')
          .run(qi.lastInsertRowid, o.text, o.is_correct, o.position);
      }
    }
    return id;
  })();
  req.flash('success', 'Quiz duplicated as a draft. Set its schedule and publish when ready.');
  res.redirect(`/faculty/quizzes/${newId}`);
});

// ---------- Questions ----------

function questionValues(body) {
  const texts = [].concat(body.options || []).map((t) => String(t).trim());
  const correct = toInt(body.correct);
  const options = [];
  texts.forEach((text, i) => { if (text) options.push({ text, is_correct: i === correct ? 1 : 0 }); });
  return {
    text: String(body.text || '').trim(),
    explanation: String(body.explanation || '').trim(),
    marks: Number(body.marks) > 0 ? round(Number(body.marks)) : 1,
    options,
  };
}

function questionErrors(v) {
  if (!v.text || v.text.length > 2000) return 'Write the question (up to 2000 characters).';
  if (v.options.length < 2) return 'Add at least two answer options.';
  if (v.options.length > MAX_OPTIONS) return `Use at most ${MAX_OPTIONS} options.`;
  if (v.options.filter((o) => o.is_correct).length !== 1) return 'Mark exactly one option as the correct answer.';
  if (v.options.some((o) => o.text.length > 500)) return 'Options can be up to 500 characters.';
  if (v.marks > 100) return 'Marks per question can be at most 100.';
  if (v.explanation.length > 2000) return 'The explanation is too long.';
  return null;
}

function editableQuiz(req, res) {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) { notFound(res, 'quiz'); return null; }
  if (attemptCount(quiz.id) > 0) {
    req.flash('error', 'Questions are locked because students have already started this quiz.');
    res.redirect(`/faculty/quizzes/${quiz.id}`);
    return null;
  }
  return quiz;
}

function insertQuestion(quizId, v) {
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM questions WHERE quiz_id = ?').get(quizId).p;
  const qi = db.prepare('INSERT INTO questions (quiz_id, text, explanation, marks, position) VALUES (?, ?, ?, ?, ?)')
    .run(quizId, v.text, v.explanation || null, v.marks, pos);
  v.options.forEach((o, i) => db.prepare('INSERT INTO options (question_id, text, is_correct, position) VALUES (?, ?, ?, ?)')
    .run(qi.lastInsertRowid, o.text, o.is_correct, i));
}

router.post('/quizzes/:id/questions', (req, res) => {
  const quiz = editableQuiz(req, res);
  if (!quiz) return;
  const v = questionValues(req.body);
  const error = questionErrors(v);
  if (error) {
    req.flash('error', error);
    return res.redirect(`/faculty/quizzes/${quiz.id}#add-question`);
  }
  db.transaction(() => insertQuestion(quiz.id, v))();
  req.flash('success', 'Question added.');
  res.redirect(`/faculty/quizzes/${quiz.id}#add-question`);
});

router.post('/quizzes/:id/questions/:qid', (req, res) => {
  const quiz = editableQuiz(req, res);
  if (!quiz) return;
  const qid = toInt(req.params.qid);
  if (!db.prepare('SELECT 1 FROM questions WHERE id = ? AND quiz_id = ?').get(qid, quiz.id)) return notFound(res, 'question');
  const v = questionValues(req.body);
  const error = questionErrors(v);
  if (error) {
    req.flash('error', error);
    return res.redirect(`/faculty/quizzes/${quiz.id}#q-${qid}`);
  }
  db.transaction(() => {
    db.prepare('UPDATE questions SET text = ?, explanation = ?, marks = ? WHERE id = ?').run(v.text, v.explanation || null, v.marks, qid);
    db.prepare('DELETE FROM options WHERE question_id = ?').run(qid);
    v.options.forEach((o, i) => db.prepare('INSERT INTO options (question_id, text, is_correct, position) VALUES (?, ?, ?, ?)')
      .run(qid, o.text, o.is_correct, i));
  })();
  req.flash('success', 'Question updated.');
  res.redirect(`/faculty/quizzes/${quiz.id}#q-${qid}`);
});

router.post('/quizzes/:id/questions/:qid/delete', (req, res) => {
  const quiz = editableQuiz(req, res);
  if (!quiz) return;
  db.prepare('DELETE FROM questions WHERE id = ? AND quiz_id = ?').run(toInt(req.params.qid), quiz.id);
  req.flash('success', 'Question deleted.');
  res.redirect(`/faculty/quizzes/${quiz.id}#questions`);
});

router.post('/quizzes/:id/questions/:qid/move', (req, res) => {
  const quiz = editableQuiz(req, res);
  if (!quiz) return;
  const ids = db.prepare('SELECT id FROM questions WHERE quiz_id = ? ORDER BY position, id').all(quiz.id).map((r) => r.id);
  const i = ids.indexOf(toInt(req.params.qid));
  const j = req.body.direction === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    db.transaction(() => ids.forEach((id, pos) => db.prepare('UPDATE questions SET position = ? WHERE id = ?').run(pos + 1, id)))();
  }
  res.redirect(`/faculty/quizzes/${quiz.id}#q-${req.params.qid}`);
});

router.get('/import-template.csv', (req, res) => {
  res.attachment('quizhub-questions-template.csv');
  res.type('text/csv').send([
    'question,option_a,option_b,option_c,option_d,correct,marks,explanation',
    '"What is 2 + 2?",3,4,5,22,B,1,"2 + 2 = 4"',
    '"Which planet is known as the Red Planet?",Venus,Mars,Jupiter,Saturn,B,1,"Iron oxide on its surface makes Mars look red."',
    '"HTTP status code for Not Found?",200,301,404,500,C,2,',
  ].join('\n') + '\n');
});

// CSV columns: question, option_a … option_f, correct (letter A–F or the option's exact text), marks, explanation.
function parseQuestionCsv(text) {
  const records = parseCsv(text, { columns: (h) => h.map((c) => c.trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
  const questions = [];
  const errors = [];
  records.forEach((r, i) => {
    const line = i + 2;
    const optionTexts = 'abcdef'.split('').map((l) => r[`option_${l}`]).map((t) => (t == null ? '' : String(t).trim()));
    const correctRaw = String(r.correct || r.answer || '').trim();
    let correctIdx = -1;
    if (/^[a-f]$/i.test(correctRaw)) correctIdx = correctRaw.toLowerCase().charCodeAt(0) - 97;
    else correctIdx = optionTexts.findIndex((t) => t && t.toLowerCase() === correctRaw.toLowerCase());
    if (correctIdx >= 0 && !optionTexts[correctIdx]) correctIdx = -1;
    const options = [];
    optionTexts.forEach((t, idx) => { if (t) options.push({ text: t, is_correct: idx === correctIdx ? 1 : 0 }); });
    const v = {
      text: String(r.question || '').trim(),
      explanation: String(r.explanation || '').trim(),
      marks: Number(r.marks) > 0 ? round(Number(r.marks)) : 1,
      options,
    };
    const err = questionErrors(v);
    if (err) errors.push(`Row ${line}: ${err}`);
    else questions.push(v);
  });
  return { questions, errors };
}

router.post('/quizzes/:id/import', (req, res) => {
  const quiz = editableQuiz(req, res);
  if (!quiz) return;
  const text = String(req.body.csv || '');
  if (!text.trim()) {
    req.flash('error', 'Choose a CSV file or paste CSV text first.');
    return res.redirect(`/faculty/quizzes/${quiz.id}#import`);
  }
  let parsed;
  try {
    parsed = parseQuestionCsv(text);
  } catch (err) {
    req.flash('error', `Couldn't read that CSV: ${err.message}`);
    return res.redirect(`/faculty/quizzes/${quiz.id}#import`);
  }
  if (parsed.errors.length) {
    req.flash('error', `Nothing imported. Fix these rows and try again: ${parsed.errors.slice(0, 5).join(' · ')}${parsed.errors.length > 5 ? ` (+${parsed.errors.length - 5} more)` : ''}`);
    return res.redirect(`/faculty/quizzes/${quiz.id}#import`);
  }
  if (!parsed.questions.length) {
    req.flash('error', 'No questions found. Make sure the first row is the header row from the template.');
    return res.redirect(`/faculty/quizzes/${quiz.id}#import`);
  }
  db.transaction(() => parsed.questions.forEach((v) => insertQuestion(quiz.id, v)))();
  req.flash('success', `Imported ${parsed.questions.length} question${parsed.questions.length === 1 ? '' : 's'}.`);
  res.redirect(`/faculty/quizzes/${quiz.id}#questions`);
});

// ---------- Results ----------

router.get('/quizzes/:id/results', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const report = svc.quizReport(quiz.id);
  res.render('faculty/results', {
    title: `Results · ${quiz.title}`,
    ...report,
    quiz,
    status: quizStatus(quiz),
    chartData: {
      distribution: report.stats.distribution,
      questions: report.questionStats.map((q) => ({ label: `Q${q.number}`, correct: q.correctPercent })),
      attendance: { submitted: report.stats.submitted, inProgress: report.stats.inProgress, absent: report.stats.absent },
    },
  });
});

function exportName(quiz, ext) {
  const slug = quiz.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'quiz';
  return `${slug}-results.${ext}`;
}

router.get('/quizzes/:id/results.xlsx', async (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const report = svc.quizReport(quiz.id);
  const workbook = buildResultsWorkbook({ ...report, classroomName: quiz.classroom_name, fmtDate, fmtDuration });
  res.attachment(exportName(quiz, 'xlsx'));
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
});

router.get('/quizzes/:id/results.csv', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const report = svc.quizReport(quiz.id);
  res.attachment(exportName(quiz, 'csv'));
  res.type('text/csv').send(buildResultsCsv({ ...report, fmtDate, fmtDuration }));
});

router.get('/quizzes/:id/attempts/:aid', (req, res) => {
  const quiz = ownQuiz(req.params.id, req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  svc.finalizeExpired();
  const attempt = db.prepare(`SELECT a.*, u.name, u.email, u.institution_id FROM attempts a JOIN users u ON u.id = a.student_id
    WHERE a.id = ? AND a.quiz_id = ?`).get(toInt(req.params.aid), quiz.id);
  if (!attempt) return notFound(res, 'attempt');
  res.render('faculty/attempt-view', {
    title: `${attempt.name} · ${quiz.title}`,
    quiz,
    attempt,
    paper: svc.attemptPaper(attempt),
  });
});

module.exports = router;
