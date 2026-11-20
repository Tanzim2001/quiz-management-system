'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Quizzes starting within the next 24 hours (or live now) for the bell page.
function upcomingFor(user) {
  const now = Date.now();
  const soon = now + 24 * 3600 * 1000;
  if (user.role === 'student') {
    return db.prepare(`
      SELECT qz.id, qz.title, qz.start_at, qz.end_at, c.name AS classroom_name FROM quizzes qz
      JOIN classrooms c ON c.id = qz.classroom_id
      JOIN enrollments e ON e.classroom_id = qz.classroom_id AND e.student_id = ?
      WHERE qz.published = 1 AND qz.start_at <= ? AND qz.end_at > ?
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.quiz_id = qz.id AND a.student_id = ? AND a.status != 'in_progress')
      ORDER BY qz.start_at`).all(user.id, soon, now, user.id);
  }
  return db.prepare(`
    SELECT qz.id, qz.title, qz.start_at, qz.end_at, c.name AS classroom_name FROM quizzes qz
    JOIN classrooms c ON c.id = qz.classroom_id
    WHERE c.faculty_id = ? AND qz.published = 1 AND qz.start_at <= ? AND qz.end_at > ?
    ORDER BY qz.start_at`).all(user.id, soon, now);
}

router.get('/notifications', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  const upcoming = upcomingFor(req.user);
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
  res.locals.unread = 0;
  res.render('notifications', { title: 'Notifications', items, upcoming });
});

router.post('/notifications/clear', requireAuth, (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
  res.redirect('/notifications');
});

router.get('/account', requireAuth, (req, res) => {
  res.render('account', { title: 'My account', errors: {} });
});

router.post('/account', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const institutionId = String(req.body.institution_id || '').trim();
  const errors = {};
  if (name.length < 2 || name.length > 80) errors.name = 'Enter your full name.';
  if (institutionId.length > 40) errors.institution_id = 'Too long.';
  if (req.body.new_password) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(req.body.current_password || ''), row.password_hash)) errors.current_password = 'Current password is wrong.';
    if (String(req.body.new_password).length < 8) errors.new_password = 'Use at least 8 characters.';
  }
  if (Object.keys(errors).length) return res.status(422).render('account', { title: 'My account', errors });
  db.prepare('UPDATE users SET name = ?, institution_id = ? WHERE id = ?').run(name, institutionId || null, req.user.id);
  if (req.body.new_password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(req.body.new_password), 10), req.user.id);
  }
  req.flash('success', 'Account updated.');
  res.redirect('/account');
});

module.exports = router;
