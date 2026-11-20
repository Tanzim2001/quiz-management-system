'use strict';
const crypto = require('crypto');
const db = require('../db');

const getUser = db.prepare('SELECT id, name, email, role, institution_id, created_at FROM users WHERE id = ?');
const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0');

function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.unread = 0;
  if (req.session.userId) {
    const user = getUser.get(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
      res.locals.unread = unreadCount.get(user.id).n;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts(['html', 'json']) === 'json') return res.status(401).json({ error: 'Not signed in' });
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return [requireAuth, (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).render('error', { title: 'Not allowed', status: 403, message: `This page is only for ${role} accounts.` });
    }
    next();
  }];
}

// Double-submit protection: every state-changing request must carry the session's token.
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const ok = typeof sent === 'string' && sent.length === req.session.csrfToken.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrfToken));
  if (!ok) {
    if (req.is('json') || req.get('x-csrf-token') !== undefined) return res.status(403).json({ error: 'Your session expired. Reload the page.' });
    return res.status(403).render('error', { title: 'Session expired', status: 403, message: 'Your form expired. Go back, reload the page and try again.' });
  }
  next();
}

// One-shot messages shown on the next page render.
function flash(req, res, next) {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  next();
}

module.exports = { loadUser, requireAuth, requireRole, csrf, flash };
