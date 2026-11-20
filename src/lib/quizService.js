'use strict';
const db = require('../db');
const { shuffle, round, pct, median } = require('./util');

// Answers that arrive this long after the deadline (network latency) are still accepted.
const GRACE_MS = 5000;

const q = {
  quiz: db.prepare('SELECT * FROM quizzes WHERE id = ?'),
  questions: db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id'),
  optionsForQuiz: db.prepare(`SELECT o.* FROM options o JOIN questions qu ON qu.id = o.question_id
                              WHERE qu.quiz_id = ? ORDER BY o.position, o.id`),
  attempt: db.prepare('SELECT * FROM attempts WHERE id = ?'),
  attemptFor: db.prepare('SELECT * FROM attempts WHERE quiz_id = ? AND student_id = ?'),
  insertAttempt: db.prepare(`INSERT INTO attempts (quiz_id, student_id, started_at, deadline_at, question_order, option_order)
                             VALUES (?, ?, ?, ?, ?, ?)`),
  answers: db.prepare('SELECT * FROM answers WHERE attempt_id = ?'),
  upsertAnswer: db.prepare(`INSERT INTO answers (attempt_id, question_id, option_id, answered_at) VALUES (?, ?, ?, ?)
                            ON CONFLICT(attempt_id, question_id) DO UPDATE SET option_id = excluded.option_id,
                            answered_at = excluded.answered_at`),
  deleteAnswer: db.prepare('DELETE FROM answers WHERE attempt_id = ? AND question_id = ?'),
  finalize: db.prepare(`UPDATE attempts SET status = ?, submitted_at = ?, score = ?, max_score = ?, correct_count = ?,
                        wrong_count = ?, unanswered_count = ? WHERE id = ? AND status = 'in_progress'`),
  expired: db.prepare(`SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at <= ?`),
  tabSwitch: db.prepare(`UPDATE attempts SET tab_switches = tab_switches + 1 WHERE id = ? AND status = 'in_progress'`),
};

function loadQuizContent(quizId) {
  const questions = q.questions.all(quizId);
  const options = q.optionsForQuiz.all(quizId);
  const byQ = new Map(questions.map((qu) => [qu.id, { ...qu, options: [] }]));
  for (const o of options) byQ.get(o.question_id)?.options.push(o);
  return byQ; // Map<questionId, question with options>
}

function startAttempt(quiz, studentId, now = Date.now()) {
  const existing = q.attemptFor.get(quiz.id, studentId);
  if (existing) return existing;

  const content = loadQuizContent(quiz.id);
  let questionIds = [...content.keys()];
  if (quiz.shuffle_questions) questionIds = shuffle(questionIds);
  const optionOrder = {};
  for (const [qid, qu] of content) {
    const ids = qu.options.map((o) => o.id);
    optionOrder[qid] = quiz.shuffle_options ? shuffle(ids) : ids;
  }
  const deadline = Math.min(now + quiz.duration_minutes * 60000, quiz.end_at);
  try {
    const info = q.insertAttempt.run(quiz.id, studentId, now, deadline, JSON.stringify(questionIds), JSON.stringify(optionOrder));
    return q.attempt.get(info.lastInsertRowid);
  } catch (err) {
    // Two "start" clicks racing each other: the UNIQUE constraint keeps one attempt.
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return q.attemptFor.get(quiz.id, studentId);
    throw err;
  }
}

// Questions in this student's order, with options in this student's order.
function attemptPaper(attempt) {
  const content = loadQuizContent(attempt.quiz_id);
  const order = JSON.parse(attempt.question_order);
  const optOrder = JSON.parse(attempt.option_order);
  const answers = new Map(q.answers.all(attempt.id).map((a) => [a.question_id, a.option_id]));
  return order
    .filter((qid) => content.has(qid))
    .map((qid) => {
      const qu = content.get(qid);
      const byId = new Map(qu.options.map((o) => [o.id, o]));
      const ids = (optOrder[qid] || []).filter((id) => byId.has(id));
      for (const o of qu.options) if (!ids.includes(o.id)) ids.push(o.id);
      return { ...qu, options: ids.map((id) => byId.get(id)), selected: answers.get(qid) ?? null };
    });
}

function isOpenForAnswers(attempt, now = Date.now()) {
  return attempt.status === 'in_progress' && now <= attempt.deadline_at + GRACE_MS;
}

function saveAnswer(attempt, questionId, optionId, now = Date.now()) {
  if (!isOpenForAnswers(attempt, now)) return { ok: false, error: 'This attempt is closed.' };
  const order = JSON.parse(attempt.question_order);
  if (!order.includes(questionId)) return { ok: false, error: 'Question is not part of this quiz.' };
  if (optionId === null) {
    q.deleteAnswer.run(attempt.id, questionId);
    return { ok: true };
  }
  const opt = db.prepare('SELECT id FROM options WHERE id = ? AND question_id = ?').get(optionId, questionId);
  if (!opt) return { ok: false, error: 'Invalid option.' };
  q.upsertAnswer.run(attempt.id, questionId, optionId, now);
  return { ok: true };
}

function scoreAttempt(attempt) {
  const quiz = q.quiz.get(attempt.quiz_id);
  const content = loadQuizContent(attempt.quiz_id);
  const answers = new Map(q.answers.all(attempt.id).map((a) => [a.question_id, a.option_id]));
  let score = 0, max = 0, correct = 0, wrong = 0, unanswered = 0;
  for (const qid of JSON.parse(attempt.question_order)) {
    const qu = content.get(qid);
    if (!qu) continue;
    max += qu.marks;
    const chosen = answers.get(qid);
    if (chosen == null) { unanswered++; continue; }
    const opt = qu.options.find((o) => o.id === chosen);
    if (opt && opt.is_correct) { correct++; score += qu.marks; }
    else { wrong++; score -= qu.marks * (quiz.negative_marking || 0); }
  }
  return { score: round(Math.max(0, score)), max: round(max), correct, wrong, unanswered };
}

function finalizeAttempt(attemptId, status = 'submitted', now = Date.now()) {
  const attempt = q.attempt.get(attemptId);
  if (!attempt || attempt.status !== 'in_progress') return attempt;
  const s = scoreAttempt(attempt);
  const submittedAt = status === 'auto_submitted' ? Math.min(now, attempt.deadline_at) : now;
  q.finalize.run(status, submittedAt, s.score, s.max, s.correct, s.wrong, s.unanswered, attemptId);
  return q.attempt.get(attemptId);
}

// Auto-submit every attempt whose timer has run out (students who closed the tab, lost power, etc.).
function finalizeExpired(now = Date.now()) {
  const rows = q.expired.all(now - GRACE_MS);
  const tx = db.transaction(() => rows.forEach((r) => finalizeAttempt(r.id, 'auto_submitted', now)));
  tx();
  return rows.length;
}

function recordTabSwitch(attempt) {
  if (attempt.status === 'in_progress') q.tabSwitch.run(attempt.id);
}

function canReview(quiz, attempt, now = Date.now()) {
  if (!attempt || attempt.status === 'in_progress') return false;
  if (quiz.review_policy === 'after_submit') return true;
  if (quiz.review_policy === 'after_close') return now >= quiz.end_at;
  return false;
}

// ---------- Faculty report ----------

function quizReport(quizId) {
  finalizeExpired();
  const quiz = q.quiz.get(quizId);
  const content = loadQuizContent(quizId);
  const maxScore = round([...content.values()].reduce((s, qu) => s + qu.marks, 0));

  const rows = db.prepare(`
    SELECT u.id AS student_id, u.name, u.email, u.institution_id, a.id AS attempt_id, a.status, a.score, a.max_score,
           a.correct_count, a.wrong_count, a.unanswered_count, a.tab_switches, a.started_at, a.submitted_at
    FROM users u
    LEFT JOIN attempts a ON a.student_id = u.id AND a.quiz_id = @quiz
    WHERE u.id IN (SELECT student_id FROM enrollments WHERE classroom_id = @classroom)
       OR u.id IN (SELECT student_id FROM attempts WHERE quiz_id = @quiz)
    ORDER BY u.name COLLATE NOCASE`).all({ quiz: quizId, classroom: quiz.classroom_id });

  const finished = rows.filter((r) => r.status && r.status !== 'in_progress');
  for (const r of rows) {
    r.percent = r.status && r.status !== 'in_progress' ? pct(r.score, r.max_score) : null;
    r.time_taken_ms = r.submitted_at ? r.submitted_at - r.started_at : null;
    r.passed = r.percent !== null ? r.percent >= quiz.pass_percent : null;
  }
  // Rank by score desc, then by time taken asc.
  finished
    .slice()
    .sort((a, b) => b.score - a.score || a.time_taken_ms - b.time_taken_ms)
    .forEach((r, i) => { r.rank = i + 1; });

  const percents = finished.map((r) => r.percent);
  const stats = {
    enrolled: rows.length,
    attended: rows.filter((r) => r.status).length,
    submitted: finished.length,
    inProgress: rows.filter((r) => r.status === 'in_progress').length,
    absent: rows.filter((r) => !r.status).length,
    average: percents.length ? round(percents.reduce((a, b) => a + b, 0) / percents.length, 1) : null,
    highest: percents.length ? Math.max(...percents) : null,
    lowest: percents.length ? Math.min(...percents) : null,
    median: percents.length ? round(median(percents), 1) : null,
    passed: finished.filter((r) => r.passed).length,
    maxScore,
    distribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 0-9, 10-19, ... 90-100
  };
  for (const p of percents) stats.distribution[Math.min(9, Math.floor(p / 10))]++;

  // Item analysis: how each question performed.
  const answerRows = db.prepare(`
    SELECT an.question_id, an.option_id FROM answers an
    JOIN attempts a ON a.id = an.attempt_id
    WHERE a.quiz_id = ? AND a.status != 'in_progress'`).all(quizId);
  const questionStats = [...content.values()].map((qu, i) => {
    const chosen = answerRows.filter((a) => a.question_id === qu.id);
    const correctIds = new Set(qu.options.filter((o) => o.is_correct).map((o) => o.id));
    const correctCount = chosen.filter((a) => correctIds.has(a.option_id)).length;
    return {
      number: i + 1,
      id: qu.id,
      text: qu.text,
      marks: qu.marks,
      answered: chosen.length,
      correct: correctCount,
      skipped: finished.length - chosen.length,
      correctPercent: finished.length ? pct(correctCount, finished.length) : null,
      options: qu.options.map((o) => ({
        text: o.text,
        is_correct: !!o.is_correct,
        count: chosen.filter((a) => a.option_id === o.id).length,
      })),
    };
  });

  return { quiz, rows, stats, questionStats };
}

// ---------- Student analytics ----------

function studentAnalytics(studentId) {
  finalizeExpired();
  const attempts = db.prepare(`
    SELECT a.*, qz.title, qz.end_at, qz.pass_percent, qz.review_policy, c.name AS classroom_name, c.id AS classroom_id,
      (SELECT AVG(a2.score * 100.0 / NULLIF(a2.max_score, 0)) FROM attempts a2
        WHERE a2.quiz_id = a.quiz_id AND a2.status != 'in_progress') AS class_avg,
      (SELECT COUNT(*) + 1 FROM attempts a3 WHERE a3.quiz_id = a.quiz_id AND a3.status != 'in_progress'
        AND a3.score > a.score) AS rank,
      (SELECT COUNT(*) FROM attempts a4 WHERE a4.quiz_id = a.quiz_id AND a4.status != 'in_progress') AS participants
    FROM attempts a
    JOIN quizzes qz ON qz.id = a.quiz_id
    JOIN classrooms c ON c.id = qz.classroom_id
    WHERE a.student_id = ? AND a.status != 'in_progress'
    ORDER BY a.submitted_at`).all(studentId);

  for (const a of attempts) {
    a.percent = pct(a.score, a.max_score);
    a.class_avg = a.class_avg === null ? null : round(a.class_avg, 1);
    a.passed = a.percent >= a.pass_percent;
  }
  const percents = attempts.map((a) => a.percent);
  const totalCorrect = attempts.reduce((s, a) => s + a.correct_count, 0);
  const totalAnswered = attempts.reduce((s, a) => s + a.correct_count + a.wrong_count, 0);

  const byClassroom = new Map();
  for (const a of attempts) {
    const c = byClassroom.get(a.classroom_id) || { name: a.classroom_name, percents: [] };
    c.percents.push(a.percent);
    byClassroom.set(a.classroom_id, c);
  }

  const missed = db.prepare(`
    SELECT COUNT(*) AS n FROM quizzes qz
    JOIN enrollments e ON e.classroom_id = qz.classroom_id AND e.student_id = ?
    WHERE qz.published = 1 AND qz.end_at < ? AND e.joined_at < qz.end_at
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.quiz_id = qz.id AND a.student_id = e.student_id)`)
    .get(studentId, Date.now()).n;

  return {
    attempts,
    summary: {
      taken: attempts.length,
      average: percents.length ? round(percents.reduce((x, y) => x + y, 0) / percents.length, 1) : null,
      best: percents.length ? Math.max(...percents) : null,
      passed: attempts.filter((a) => a.passed).length,
      accuracy: totalAnswered ? pct(totalCorrect, totalAnswered) : null,
      missed,
    },
    byClassroom: [...byClassroom.values()].map((c) => ({
      name: c.name,
      average: round(c.percents.reduce((x, y) => x + y, 0) / c.percents.length, 1),
      count: c.percents.length,
    })),
  };
}

// ---------- Leaderboards ----------

function classroomLeaderboard(classroomId, limit = 50) {
  finalizeExpired();
  return db.prepare(`
    SELECT u.id AS student_id, u.name,
      COUNT(a.id) AS quizzes,
      ROUND(COALESCE(SUM(a.score), 0), 2) AS total_score,
      ROUND(AVG(a.score * 100.0 / NULLIF(a.max_score, 0)), 1) AS avg_percent
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN attempts a ON a.student_id = u.id AND a.status != 'in_progress'
      AND a.quiz_id IN (SELECT id FROM quizzes WHERE classroom_id = e.classroom_id AND published = 1 AND end_at <= @now)
    WHERE e.classroom_id = @classroom
    GROUP BY u.id
    ORDER BY total_score DESC, avg_percent DESC, u.name COLLATE NOCASE
    LIMIT @limit`).all({ classroom: classroomId, now: Date.now(), limit });
}

function quizLeaderboard(quizId, limit = 10) {
  return db.prepare(`
    SELECT u.name, a.score, a.max_score, a.submitted_at - a.started_at AS time_ms,
      ROUND(a.score * 100.0 / NULLIF(a.max_score, 0), 1) AS percent
    FROM attempts a JOIN users u ON u.id = a.student_id
    WHERE a.quiz_id = ? AND a.status != 'in_progress'
    ORDER BY a.score DESC, time_ms ASC LIMIT ?`).all(quizId, limit);
}

module.exports = {
  GRACE_MS,
  loadQuizContent,
  startAttempt,
  attemptPaper,
  isOpenForAnswers,
  saveAnswer,
  scoreAttempt,
  finalizeAttempt,
  finalizeExpired,
  recordTabSwitch,
  canReview,
  quizReport,
  studentAnalytics,
  classroomLeaderboard,
  quizLeaderboard,
};
