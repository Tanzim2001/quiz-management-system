'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All timestamps are stored as Unix epoch milliseconds (INTEGER).
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('student', 'faculty')),
  institution_id TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS classrooms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  faculty_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  subject             TEXT,
  description         TEXT,
  code                TEXT NOT NULL UNIQUE,
  leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (classroom_id, student_id)
);

CREATE TABLE IF NOT EXISTS quizzes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  classroom_id      INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  duration_minutes  INTEGER NOT NULL,
  start_at          INTEGER NOT NULL,
  end_at            INTEGER NOT NULL,
  shuffle_questions INTEGER NOT NULL DEFAULT 1,
  shuffle_options   INTEGER NOT NULL DEFAULT 1,
  negative_marking  REAL NOT NULL DEFAULT 0,      -- fraction of a question's marks deducted per wrong answer
  review_policy     TEXT NOT NULL DEFAULT 'after_close'
                    CHECK (review_policy IN ('after_submit', 'after_close', 'never')),
  pass_percent      INTEGER NOT NULL DEFAULT 40,
  published         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  explanation TEXT,
  marks       REAL NOT NULL DEFAULT 1,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id          INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  deadline_at      INTEGER NOT NULL,
  submitted_at     INTEGER,
  status           TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'submitted', 'auto_submitted')),
  score            REAL,
  max_score        REAL,
  correct_count    INTEGER,
  wrong_count      INTEGER,
  unanswered_count INTEGER,
  tab_switches     INTEGER NOT NULL DEFAULT 0,
  question_order   TEXT NOT NULL,   -- JSON array of question ids
  option_order     TEXT NOT NULL,   -- JSON object { questionId: [optionIds] }
  UNIQUE (quiz_id, student_id)
);

CREATE TABLE IF NOT EXISTS answers (
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_id   INTEGER REFERENCES options(id) ON DELETE SET NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classrooms_faculty ON classrooms(faculty_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_classroom ON quizzes(classroom_id);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_options_question ON options(question_id);
CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_announcements_classroom ON announcements(classroom_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

module.exports = db;
