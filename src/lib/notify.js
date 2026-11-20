'use strict';
const db = require('../db');

const insert = db.prepare('INSERT INTO notifications (user_id, message, link, created_at) VALUES (?, ?, ?, ?)');

function notifyUsers(userIds, message, link = null) {
  const now = Date.now();
  db.transaction(() => userIds.forEach((id) => insert.run(id, message, link, now)))();
}

function notifyClassroom(classroomId, message, link = null) {
  const ids = db.prepare('SELECT student_id FROM enrollments WHERE classroom_id = ?').all(classroomId).map((r) => r.student_id);
  notifyUsers(ids, message, link);
}

module.exports = { notifyUsers, notifyClassroom };
