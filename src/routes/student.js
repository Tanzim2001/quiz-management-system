'use strict';
const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { toInt, quizStatus, pct } = require('../lib/util');
const svc = require('../lib/quizService');
const { notifyUsers } = require('../lib/notify');

const router = express.Router();
router.use(requireRole('student'));
router.use((req, res, next) => { svc.finalizeExpired(); next(); });

function notFound(res, what = 'page') {
  return res.status(404).render('error', { title: 'Not found', status: 404, message: `That ${what} doesn't exist or you don't have access to it.` });
}

function enrolledClassroom(classroomId, studentId) {
  return db.prepare(`SELECT c.*, u.name AS faculty_name FROM classrooms c
                     JOIN enrollments e ON e.classroom_id = c.id AND e.student_id = ?
                     JOIN users u ON u.id = c.faculty_id WHERE c.id = ?`).get(studentId, classroomId);
}

// Every published quiz in the student's classrooms, with this student's attempt (if any).
function quizzesForStudent(studentId, classroomId = null) {
  const rows = db.prepare(`
    SELECT qz.*, c.name AS classroom_name,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = qz.id) AS question_count,
      (SELECT COALESCE(SUM(marks), 0) FROM questions WHERE quiz_id = qz.id) AS total_marks,
      a.id AS attempt_id, a.status AS attempt_status, a.score, a.max_score
    FROM quizzes qz
    JOIN classrooms c ON c.id = qz.classroom_id
    JOIN enrollments e ON e.classroom_id = qz.classroom_id AND e.student_id = @sid
    LEFT JOIN attempts a ON a.quiz_id = qz.id AND a.student_id = @sid
    WHERE qz.published = 1 AND (@cid IS NULL OR qz.classroom_id = @cid)
    ORDER BY qz.start_at`).all({ sid: studentId, cid: classroomId });
  const now = Date.now();
  for (const r of rows) {
    r.status = quizStatus(r, now);
    r.percent = r.attempt_status && r.attempt_status !== 'in_progress' ? pct(r.score, r.max_score) : null;
    if (r.attempt_status && r.attempt_status !== 'in_progress') r.bucket = 'completed';
    else if (r.status === 'live') r.bucket = 'live';
    else if (r.status === 'upcoming') r.bucket = 'upcoming';
    else r.bucket = 'missed';
  }
  return rows;
}

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  const analytics = svc.studentAnalytics(req.user.id);
  const quizzes = quizzesForStudent(req.user.id);
  const classrooms = db.prepare(`SELECT c.id, c.name, c.subject, u.name AS faculty_name FROM classrooms c
    JOIN enrollments e ON e.classroom_id = c.id JOIN users u ON u.id = c.faculty_id
    WHERE e.student_id = ? ORDER BY c.name`).all(req.user.id);
  const announcements = db.prepare(`SELECT an.*, c.name AS classroom_name FROM announcements an
    JOIN enrollments e ON e.classroom_id = an.classroom_id AND e.student_id = ?
    JOIN classrooms c ON c.id = an.classroom_id ORDER BY an.created_at DESC LIMIT 3`).all(req.user.id);
  res.render('student/dashboard', {
    title: 'Dashboard',
    analytics,
    live: quizzes.filter((q) => q.bucket === 'live'),
    upcoming: quizzes.filter((q) => q.bucket === 'upcoming').slice(0, 5),
    classrooms,
    announcements,
    chartData: {
      timeline: analytics.attempts.map((a) => ({ label: a.title, you: a.percent, classAvg: a.class_avg })),
      byClassroom: analytics.byClassroom,
      outcome: analytics.attempts.reduce((acc, a) => {
        acc.correct += a.correct_count; acc.wrong += a.wrong_count; acc.unanswered += a.unanswered_count; return acc;
      }, { correct: 0, wrong: 0, unanswered: 0 }),
    },
  });
});

// ---------- Classrooms ----------

router.get('/classrooms', (req, res) => {
  const classrooms = db.prepare(`
    SELECT c.*, u.name AS faculty_name,
      (SELECT COUNT(*) FROM enrollments WHERE classroom_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM quizzes WHERE classroom_id = c.id AND published = 1) AS quiz_count
    FROM classrooms c JOIN enrollments e ON e.classroom_id = c.id AND e.student_id = ?
    JOIN users u ON u.id = c.faculty_id ORDER BY e.joined_at DESC`).all(req.user.id);
  res.render('student/classrooms', { title: 'My classrooms', classrooms, code: req.query.code || '' });
});

router.post('/classrooms/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const classroom = db.prepare('SELECT * FROM classrooms WHERE code = ?').get(code);
  if (!classroom) {
    req.flash('error', `No classroom found with code "${code}". Check the code with your teacher.`);
    return res.redirect('/student/classrooms');
  }
  const info = db.prepare('INSERT OR IGNORE INTO enrollments (classroom_id, student_id, joined_at) VALUES (?, ?, ?)')
    .run(classroom.id, req.user.id, Date.now());
  if (info.changes) {
    notifyUsers([classroom.faculty_id], `${req.user.name} joined ${classroom.name}.`, `/faculty/classrooms/${classroom.id}?tab=students`);
    req.flash('success', `You joined ${classroom.name}.`);
  } else {
    req.flash('info', `You're already in ${classroom.name}.`);
  }
  res.redirect(`/student/classrooms/${classroom.id}`);
});

router.get('/classrooms/:id', (req, res) => {
  const classroom = enrolledClassroom(toInt(req.params.id), req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  const quizzes = quizzesForStudent(req.user.id, classroom.id);
  const announcements = db.prepare(`SELECT an.*, u.name AS author FROM announcements an JOIN users u ON u.id = an.author_id
    WHERE classroom_id = ? ORDER BY created_at DESC`).all(classroom.id);
  const leaderboard = classroom.leaderboard_enabled ? svc.classroomLeaderboard(classroom.id, 10) : null;
  res.render('student/classroom', { title: classroom.name, classroom, quizzes, announcements, leaderboard, tab: req.query.tab || 'quizzes' });
});

router.post('/classrooms/:id/leave', (req, res) => {
  const classroom = enrolledClassroom(toInt(req.params.id), req.user.id);
  if (!classroom) return notFound(res, 'classroom');
  db.prepare('DELETE FROM enrollments WHERE classroom_id = ? AND student_id = ?').run(classroom.id, req.user.id);
  req.flash('info', `You left ${classroom.name}.`);
  res.redirect('/student/classrooms');
});

// ---------- Quizzes ----------

router.get('/quizzes', (req, res) => {
  const quizzes = quizzesForStudent(req.user.id);
  const tabs = ['live', 'upcoming', 'completed', 'missed'];
  const counts = Object.fromEntries(tabs.map((t) => [t, quizzes.filter((q) => q.bucket === t).length]));
  let tab = tabs.includes(req.query.tab) ? req.query.tab : null;
  if (!tab) tab = counts.live ? 'live' : counts.upcoming ? 'upcoming' : 'completed';
  const list = quizzes.filter((q) => q.bucket === tab);
  if (tab === 'completed' || tab === 'missed') list.reverse();
  res.render('student/quizzes', { title: 'Quizzes', quizzes: list, counts, tab });
});

function loadQuizForStudent(quizId, studentId) {
  return db.prepare(`
    SELECT qz.*, c.name AS classroom_name, c.leaderboard_enabled, u.name AS faculty_name,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = qz.id) AS question_count,
      (SELECT COALESCE(SUM(marks), 0) FROM questions WHERE quiz_id = qz.id) AS total_marks
    FROM quizzes qz JOIN classrooms c ON c.id = qz.classroom_id
    JOIN users u ON u.id = c.faculty_id
    JOIN enrollments e ON e.classroom_id = c.id AND e.student_id = ?
    WHERE qz.id = ? AND qz.published = 1`).get(studentId, quizId);
}

router.get('/quizzes/:id', (req, res) => {
  const quiz = loadQuizForStudent(toInt(req.params.id), req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const attempt = db.prepare('SELECT * FROM attempts WHERE quiz_id = ? AND student_id = ?').get(quiz.id, req.user.id);
  if (attempt && attempt.status !== 'in_progress') return res.redirect(`/student/attempts/${attempt.id}/result`);
  res.render('student/quiz-lobby', { title: quiz.title, quiz, attempt, status: quizStatus(quiz), serverNow: Date.now() });
});

router.post('/quizzes/:id/start', (req, res) => {
  const quiz = loadQuizForStudent(toInt(req.params.id), req.user.id);
  if (!quiz) return notFound(res, 'quiz');
  const status = quizStatus(quiz);
  const existing = db.prepare('SELECT * FROM attempts WHERE quiz_id = ? AND student_id = ?').get(quiz.id, req.user.id);
  if (!existing && status !== 'live') {
    req.flash('error', status === 'upcoming' ? 'This quiz has not started yet.' : 'This quiz is closed.');
    return res.redirect(`/student/quizzes/${quiz.id}`);
  }
  if (!existing && !quiz.question_count) {
    req.flash('error', 'This quiz has no questions yet.');
    return res.redirect(`/student/quizzes/${quiz.id}`);
  }
  const attempt = existing || svc.startAttempt(quiz, req.user.id);
  res.redirect(`/student/attempts/${attempt.id}`);
});

// ---------- Attempts ----------

function ownAttempt(req) {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ? AND student_id = ?').get(toInt(req.params.id), req.user.id);
  return a || null;
}

router.get('/attempts/:id', (req, res) => {
  const attempt = ownAttempt(req);
  if (!attempt) return notFound(res, 'attempt');
  if (attempt.status !== 'in_progress' || !svc.isOpenForAnswers(attempt)) {
    if (attempt.status === 'in_progress') svc.finalizeAttempt(attempt.id, 'auto_submitted');
    return res.redirect(`/student/attempts/${attempt.id}/result`);
  }
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(attempt.quiz_id);
  const paper = svc.attemptPaper(attempt).map((qu) => ({
    id: qu.id, text: qu.text, marks: qu.marks, selected: qu.selected,
    options: qu.options.map((o) => ({ id: o.id, text: o.text })), // never send is_correct to the browser
  }));
  res.render('student/attempt', {
    title: quiz.title,
    quiz,
    attempt,
    paper,
    clientData: { attemptId: attempt.id, deadline: attempt.deadline_at, serverNow: Date.now(), tabSwitches: attempt.tab_switches },
  });
});

router.post('/attempts/:id/answer', (req, res) => {
  const attempt = ownAttempt(req);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  const questionId = toInt(req.body.questionId);
  const optionId = req.body.optionId === null ? null : toInt(req.body.optionId);
  const result = svc.saveAnswer(attempt, questionId, optionId);
  if (!result.ok) return res.status(409).json({ error: result.error, closed: !svc.isOpenForAnswers(attempt) });
  res.json({ ok: true, serverNow: Date.now() });
});

router.post('/attempts/:id/event', (req, res) => {
  const attempt = ownAttempt(req);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  if (req.body.type === 'tab_switch') svc.recordTabSwitch(attempt);
  const updated = db.prepare('SELECT tab_switches FROM attempts WHERE id = ?').get(attempt.id);
  res.json({ ok: true, tabSwitches: updated.tab_switches, serverNow: Date.now() });
});

router.post('/attempts/:id/submit', (req, res) => {
  const attempt = ownAttempt(req);
  if (!attempt) return notFound(res, 'attempt');
  if (attempt.status === 'in_progress') {
    const finished = svc.finalizeAttempt(attempt.id, req.body.auto === '1' || !svc.isOpenForAnswers(attempt) ? 'auto_submitted' : 'submitted');
    const quiz = db.prepare('SELECT title FROM quizzes WHERE id = ?').get(attempt.quiz_id);
    notifyUsers([req.user.id], `You scored ${finished.score}/${finished.max_score} on "${quiz.title}".`, `/student/attempts/${attempt.id}/result`);
  }
  if (req.is('json')) return res.json({ ok: true, redirect: `/student/attempts/${attempt.id}/result` });
  res.redirect(`/student/attempts/${attempt.id}/result`);
});

router.get('/attempts/:id/result', (req, res) => {
  let attempt = ownAttempt(req);
  if (!attempt) return notFound(res, 'attempt');
  if (attempt.status === 'in_progress') {
    if (svc.isOpenForAnswers(attempt)) return res.redirect(`/student/attempts/${attempt.id}`);
    attempt = svc.finalizeAttempt(attempt.id, 'auto_submitted');
  }
  const quiz = db.prepare(`SELECT qz.*, c.name AS classroom_name, c.leaderboard_enabled FROM quizzes qz
    JOIN classrooms c ON c.id = qz.classroom_id WHERE qz.id = ?`).get(attempt.quiz_id);
  const review = svc.canReview(quiz, attempt) ? svc.attemptPaper(attempt) : null;
  const closed = Date.now() >= quiz.end_at;
  const leaderboard = quiz.leaderboard_enabled && closed ? svc.quizLeaderboard(quiz.id, 10) : null;
  const stats = db.prepare(`SELECT COUNT(*) AS n, AVG(score * 100.0 / NULLIF(max_score, 0)) AS avg,
    SUM(CASE WHEN score > ? THEN 1 ELSE 0 END) + 1 AS rank
    FROM attempts WHERE quiz_id = ? AND status != 'in_progress'`).get(attempt.score, quiz.id);
  res.render('student/result', {
    title: `Result · ${quiz.title}`,
    quiz,
    attempt,
    percent: pct(attempt.score, attempt.max_score),
    review,
    closed,
    leaderboard,
    stats,
  });
});

module.exports = router;
