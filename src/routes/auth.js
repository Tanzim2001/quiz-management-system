'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (req, res) => res.status(429).render('error', {
    title: 'Too many attempts', status: 429, message: 'Too many sign-in attempts. Wait a few minutes and try again.',
  }),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function home(user) {
  return user.role === 'faculty' ? '/faculty' : '/student';
}

router.get('/', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('landing', { title: 'Online quizzes for classrooms' });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/register', {
    title: 'Create account', values: { role: req.query.role === 'faculty' ? 'faculty' : 'student' }, errors: {},
    needsInvite: !!process.env.FACULTY_INVITE_CODE,
  });
});

router.post('/register', authLimiter, (req, res, next) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    role: req.body.role === 'faculty' ? 'faculty' : 'student',
    institution_id: String(req.body.institution_id || '').trim(),
  };
  const password = String(req.body.password || '');
  const errors = {};
  if (values.name.length < 2 || values.name.length > 80) errors.name = 'Enter your full name.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) errors.email = 'An account with this email already exists.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  if (password !== req.body.confirm_password) errors.confirm_password = 'Passwords do not match.';
  if (values.institution_id.length > 40) errors.institution_id = 'Too long.';
  const invite = process.env.FACULTY_INVITE_CODE;
  if (values.role === 'faculty' && invite && req.body.invite_code !== invite) {
    errors.invite_code = 'Faculty sign-up needs the invite code from your administrator.';
  }

  if (Object.keys(errors).length) {
    return res.status(422).render('auth/register', { title: 'Create account', values, errors, needsInvite: !!invite });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users (name, email, password_hash, role, institution_id, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)`)
    .run(values.name, values.email, hash, values.role, values.institution_id || null, Date.now());

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = Number(info.lastInsertRowid);
    req.session.flash = [{ type: 'success', message: `Welcome to QuizHub, ${values.name.split(' ')[0]}!` }];
    res.redirect(values.role === 'faculty' ? '/faculty' : '/student');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('auth/login', { title: 'Sign in', email: '', error: null });
});

router.post('/login', authLimiter, (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('auth/login', { title: 'Sign in', email, error: 'Incorrect email or password.' });
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    const safeReturn = typeof returnTo === 'string' && returnTo.startsWith(`/${user.role}`) ? returnTo : null;
    res.redirect(safeReturn || home(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('quizhub.sid');
    res.redirect('/');
  });
});

module.exports = router;
