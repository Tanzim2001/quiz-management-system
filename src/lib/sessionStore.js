'use strict';
const session = require('express-session');

// Minimal express-session store backed by the app's SQLite database.
class SQLiteStore extends session.Store {
  constructor(db, { ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    const timer = setInterval(() => this.q.prune.run(Date.now()), 15 * 60 * 1000);
    timer.unref();
  }
  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }
  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (err) { cb && cb(err); }
  }
  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb && cb(null); } catch (err) { cb && cb(err); }
  }
  touch(sid, sess, cb) {
    try { this.q.touch.run(this.expiry(sess), sid); cb && cb(null); } catch (err) { cb && cb(err); }
  }
}

module.exports = SQLiteStore;
