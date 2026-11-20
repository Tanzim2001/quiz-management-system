'use strict';
try { process.loadEnvFile(require('path').resolve(__dirname, '..', '.env')); } catch { /* no .env file: use defaults */ }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');

// Use SESSION_SECRET if given; otherwise generate one once and keep it in data/
// so logins survive restarts without any setup.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

module.exports = {
  root,
  dataDir,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || 'localhost',
  dbPath: process.env.DB_PATH ? path.resolve(root, process.env.DB_PATH) : path.join(dataDir, 'quizhub.db'),
  sessionSecret: sessionSecret(),
  isProduction: process.env.NODE_ENV === 'production',
  appName: 'QuizHub',
};
