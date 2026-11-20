'use strict';
/* Fills the database with demo data. Usage: npm run seed   (or npm run reset to wipe first) */
const fs = require('fs');
const config = require('../src/config');

if (process.argv.includes('--reset')) {
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log('Database wiped.');
}

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const svc = require('../src/lib/quizService');
const { randomCode } = require('../src/lib/util');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('The database already has data. Run `npm run reset` to wipe it and seed again.');
  process.exit(0);
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const hash = bcrypt.hashSync('password123', 10);

// Deterministic pseudo-random numbers so every seed looks the same.
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function user(name, email, role, institutionId) {
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role, institution_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, email, hash, role, institutionId, now - 40 * DAY);
  return Number(info.lastInsertRowid);
}

function classroom(facultyId, name, subject, description) {
  const info = db.prepare(`INSERT INTO classrooms (faculty_id, name, subject, description, code, leaderboard_enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`).run(facultyId, name, subject, description, randomCode(6), now - 35 * DAY);
  return Number(info.lastInsertRowid);
}

function quiz(classroomId, title, { start, hours = 3, duration = 15, published = 1, negative = 0, review = 'after_close', description = null }, questions) {
  const info = db.prepare(`INSERT INTO quizzes (classroom_id, title, description, duration_minutes, start_at, end_at, shuffle_questions,
    shuffle_options, negative_marking, review_policy, pass_percent, published, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 40, ?, ?)`)
    .run(classroomId, title, description, duration, start, start + hours * HOUR, negative, review, published, start - 3 * DAY);
  const quizId = Number(info.lastInsertRowid);
  questions.forEach(([text, options, correct, explanation, marks = 1], i) => {
    const qi = db.prepare('INSERT INTO questions (quiz_id, text, explanation, marks, position) VALUES (?, ?, ?, ?, ?)')
      .run(quizId, text, explanation || null, marks, i + 1);
    options.forEach((o, j) => db.prepare('INSERT INTO options (question_id, text, is_correct, position) VALUES (?, ?, ?, ?)')
      .run(qi.lastInsertRowid, o, j === correct ? 1 : 0, j));
  });
  return db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
}

// Simulate a student taking a quiz: `skill` is the chance of answering each question correctly.
function simulate(q, studentId, skill, { tabSwitches = 0, finish = true, startAt: fixedStart } = {}) {
  const startAt = fixedStart || q.start_at + Math.floor(rand() * Math.min(60 * 60000, q.end_at - q.start_at - q.duration_minutes * 60000));
  const attempt = svc.startAttempt(q, studentId, startAt);
  const content = svc.loadQuizContent(q.id);
  let t = startAt;
  for (const qid of JSON.parse(attempt.question_order)) {
    t += 15000 + Math.floor(rand() * 50000);
    if (t > attempt.deadline_at) break;
    if (rand() < 0.07) continue; // skipped
    const question = content.get(qid);
    const correct = question.options.find((o) => o.is_correct);
    const wrong = question.options.filter((o) => !o.is_correct);
    const pick = rand() < skill ? correct : wrong[Math.floor(rand() * wrong.length)];
    svc.saveAnswer(attempt, qid, pick.id, t);
  }
  if (tabSwitches) db.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(tabSwitches, attempt.id);
  if (finish) {
    const ranOut = rand() < 0.12;
    svc.finalizeAttempt(attempt.id, ranOut ? 'auto_submitted' : 'submitted', ranOut ? attempt.deadline_at : Math.min(t + 20000, attempt.deadline_at));
  }
  return attempt;
}

const QUESTIONS = {
  ds1: [
    ['Which data structure works on a First-In-First-Out (FIFO) basis?', ['Stack', 'Queue', 'Binary tree', 'Hash table'], 1, 'A queue removes items in the order they were added.'],
    ['What is the time complexity of accessing an element by index in an array?', ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], 0, 'Arrays store elements contiguously, so the address is computed directly.'],
    ['Which operation adds an element to the top of a stack?', ['Enqueue', 'Push', 'Pop', 'Peek'], 1],
    ['In a singly linked list, each node stores data and…', ['a pointer to the previous node', 'a pointer to the next node', 'pointers to both neighbours', 'its index'], 1],
    ['Which structure is best for checking balanced parentheses?', ['Queue', 'Stack', 'Heap', 'Graph'], 1, 'Push on "(", pop on ")"; the stack must be empty at the end.'],
    ['What does "LIFO" stand for?', ['Last In, First Out', 'Last In, Final Out', 'Least In, First Out', 'Linear In, First Out'], 0],
    ['Worst-case time to search an unsorted linked list of n nodes?', ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], 2],
    ['Which of these is NOT a linear data structure?', ['Array', 'Queue', 'Tree', 'Linked list'], 2],
  ],
  ds2: [
    ['What is the maximum number of children a node in a binary tree can have?', ['1', '2', '3', 'Unlimited'], 1],
    ['Which traversal of a BST visits keys in sorted order?', ['Pre-order', 'In-order', 'Post-order', 'Level-order'], 1, 'In-order visits left subtree, node, right subtree.'],
    ['Average time to search a balanced binary search tree?', ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], 1],
    ['A complete binary tree with n nodes has height approximately…', ['n', 'n/2', 'log₂ n', '√n'], 2],
    ['Which data structure is typically used to implement a priority queue?', ['Stack', 'Heap', 'Linked list', 'Trie'], 1, 'A binary heap gives O(log n) insert and extract-min.'],
    ['In a max-heap, the largest element is at…', ['the last leaf', 'the root', 'the leftmost leaf', 'any position'], 1],
    ['Breadth-first search on a graph uses which helper structure?', ['Stack', 'Queue', 'Heap', 'Set only'], 1],
    ['What is a leaf node?', ['The root', 'A node with no children', 'A node with one child', 'A node with two children'], 1],
    ['Inserting into a BST that is already a sorted chain takes worst-case…', ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], 2],
    ['Which traversal is used to delete a tree safely (children before parent)?', ['Pre-order', 'In-order', 'Post-order', 'Level-order'], 2],
  ],
  ds3: [
    ['What is the average-case time complexity of quicksort?', ['O(n)', 'O(n log n)', 'O(n²)', 'O(log n)'], 1],
    ['Which sorting algorithm is stable by default?', ['Quicksort', 'Heapsort', 'Merge sort', 'Selection sort'], 2, 'Merge sort keeps equal elements in their original order.'],
    ['Binary search requires the input to be…', ['a linked list', 'sorted', 'unique values', 'a power of two in length'], 1],
    ['A good hash function should…', ['always return 0', 'spread keys uniformly', 'be slow to compute', 'depend on insertion order'], 1],
    ['Worst-case time complexity of bubble sort?', ['O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)'], 2],
    ['Collision resolution where each bucket holds a linked list is called…', ['Open addressing', 'Chaining', 'Rehashing', 'Probing'], 1],
  ],
  ds4: [
    ['Dijkstra\'s algorithm finds…', ['minimum spanning trees', 'shortest paths from a source', 'strongly connected components', 'topological order'], 1],
    ['Which algorithm finds a minimum spanning tree?', ['Kruskal', 'Floyd–Warshall', 'Bellman–Ford', 'KMP'], 0],
    ['Topological sort applies to which graphs?', ['Undirected graphs', 'Directed acyclic graphs', 'Complete graphs', 'Any graph with cycles'], 1],
    ['Adjacency matrix space for V vertices?', ['O(V)', 'O(E)', 'O(V²)', 'O(V + E)'], 2],
    ['DFS on a graph is naturally implemented with…', ['a queue', 'recursion / a stack', 'a heap', 'a hash map only'], 1],
  ],
  live: [
    ['Which of these is a self-balancing binary search tree?', ['AVL tree', 'Binary heap', 'Trie', 'B-list'], 0, 'AVL trees rebalance with rotations after inserts and deletes.'],
    ['What is the time complexity of inserting into a hash table on average?', ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], 0],
    ['Which data structure would you use for an "undo" feature?', ['Queue', 'Stack', 'Graph', 'Array of sets'], 1],
    ['A circular queue solves which problem of a simple array queue?', ['Overflow of the stack', 'Wasted space after dequeues', 'Sorting the elements', 'Duplicate keys'], 1],
    ['Which traversal visits the root first?', ['In-order', 'Post-order', 'Pre-order', 'Reverse in-order'], 2],
    ['How many edges does a tree with n nodes have?', ['n', 'n − 1', 'n + 1', '2n'], 1],
  ],
  phy1: [
    ['What is the SI unit of force?', ['Joule', 'Newton', 'Watt', 'Pascal'], 1],
    ['Acceleration due to gravity near Earth\'s surface is about…', ['9.8 m/s²', '98 m/s²', '1.6 m/s²', '3 × 10⁸ m/s'], 0],
    ['Newton\'s second law states F = …', ['mv', 'ma', 'm/a', 'mgh'], 1],
    ['Kinetic energy of a mass m moving at speed v is…', ['mv', '½mv²', 'mgh', 'm²v'], 1, 'KE = ½mv².'],
    ['Which quantity is a vector?', ['Speed', 'Mass', 'Velocity', 'Temperature'], 2],
    ['The rate of change of momentum equals…', ['power', 'net force', 'work', 'impulse per mass'], 1],
    ['Work done is zero when force and displacement are…', ['parallel', 'perpendicular', 'opposite', 'equal in magnitude'], 1],
  ],
  phy2: [
    ['Ohm\'s law relates voltage, current and…', ['power', 'resistance', 'charge', 'capacitance'], 1],
    ['The unit of electric charge is the…', ['Ampere', 'Volt', 'Coulomb', 'Ohm'], 2],
    ['Resistors in series: the total resistance is…', ['the sum', 'the product', 'smaller than the smallest', 'the average'], 0],
    ['Electric power P equals…', ['V/I', 'VI', 'I/R', 'V/R²'], 1],
  ],
};

const tx = db.transaction(() => {
  const ayesha = user('Dr. Ayesha Rahman', 'faculty@quizhub.test', 'faculty', 'FAC-1021');
  const karim = user('Prof. Karim Hossain', 'karim@quizhub.test', 'faculty', 'FAC-0877');

  const studentNames = [
    ['Nadia Islam', 'student@quizhub.test', 0.78], ['Rafi Ahmed', 'rafi@quizhub.test', 0.9], ['Sadia Chowdhury', 'sadia@quizhub.test', 0.66],
    ['Imran Kabir', 'imran@quizhub.test', 0.52], ['Farhana Akter', 'farhana@quizhub.test', 0.84], ['Tahmid Hasan', 'tahmid@quizhub.test', 0.45],
    ['Mehnaz Sultana', 'mehnaz@quizhub.test', 0.72], ['Arif Mahmud', 'arif@quizhub.test', 0.6], ['Nusrat Jahan', 'nusrat@quizhub.test', 0.88],
    ['Sakib Rahman', 'sakib@quizhub.test', 0.38], ['Lamia Haque', 'lamia@quizhub.test', 0.7], ['Zarif Karim', 'zarif@quizhub.test', 0.56],
    ['Priya Das', 'priya@quizhub.test', 0.8], ['Omar Faruk', 'omar@quizhub.test', 0.62],
  ];
  const students = studentNames.map(([n, e, skill], i) => ({ id: user(n, e, 'student', `2023-1-60-${String(101 + i).padStart(3, '0')}`), skill }));
  const demo = students[0];

  const cse = classroom(ayesha, 'CSE 220 – Data Structures', 'Computer Science', 'Section 2 · Sun/Tue 10:00–11:30.\nQuizzes are announced at least two days in advance.');
  const phy = classroom(karim, 'PHY 101 – Physics I', 'Physics', 'Mechanics and an introduction to electricity.');
  students.forEach((s, i) => {
    db.prepare('INSERT INTO enrollments (classroom_id, student_id, joined_at) VALUES (?, ?, ?)').run(cse, s.id, now - 30 * DAY + i * HOUR);
    if (i % 3 !== 2 || i === 0) db.prepare('INSERT INTO enrollments (classroom_id, student_id, joined_at) VALUES (?, ?, ?)').run(phy, s.id, now - 29 * DAY + i * HOUR);
  });

  // Closed quizzes with results.
  const closed = [
    quiz(cse, 'Quiz 1 · Arrays, Stacks & Queues', { start: now - 21 * DAY, duration: 12, review: 'after_close' }, QUESTIONS.ds1),
    quiz(cse, 'Quiz 2 · Trees & Heaps', { start: now - 14 * DAY, duration: 15, negative: 0.25, review: 'after_close' }, QUESTIONS.ds2),
    quiz(cse, 'Quiz 3 · Sorting & Hashing', { start: now - 7 * DAY, duration: 10, review: 'after_submit' }, QUESTIONS.ds3),
    quiz(phy, 'Quiz 1 · Newtonian Mechanics', { start: now - 10 * DAY, duration: 12, review: 'after_close' }, QUESTIONS.phy1),
  ];
  closed.forEach((q, qi) => {
    const enrolled = db.prepare('SELECT student_id FROM enrollments WHERE classroom_id = ?').all(q.classroom_id).map((r) => r.student_id);
    students.filter((s) => enrolled.includes(s.id)).forEach((s, i) => {
      if (s !== demo && rand() < 0.14) return; // absent
      const drift = (qi - 1) * 0.04; // most students improve over time
      simulate(q, s.id, Math.min(0.97, s.skill + drift), { tabSwitches: rand() < 0.15 ? 1 + Math.floor(rand() * 4) : 0 });
      void i;
    });
  });

  // Live quiz: open now, a few students already in progress or done; the demo student can take it.
  const live = quiz(cse, 'Quiz 4 · Mixed Revision', { start: now - 2 * HOUR, hours: 50, duration: 10, review: 'after_submit', description: 'Covers everything so far. 10 minutes, one attempt. Good luck!' }, QUESTIONS.live);
  students.slice(1, 6).forEach((s) => simulate(live, s.id, s.skill));
  simulate(live, students[6].id, students[6].skill, { finish: false, startAt: now - 2 * 60000 });

  // Upcoming + draft.
  quiz(cse, 'Quiz 5 · Graphs', { start: now + 2 * DAY + 3 * HOUR, hours: 2, duration: 15, negative: 0.25 }, QUESTIONS.ds4);
  quiz(cse, 'Final revision (draft)', { start: now + 9 * DAY, hours: 3, duration: 30, published: 0 }, QUESTIONS.ds1.slice(0, 3));
  quiz(phy, 'Quiz 2 · Electricity Basics', { start: now + 26 * HOUR, hours: 3, duration: 8 }, QUESTIONS.phy2);

  const ann = db.prepare('INSERT INTO announcements (classroom_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)');
  ann.run(cse, ayesha, 'Welcome to CSE 220!', 'Welcome everyone. All quizzes will be on QuizHub. Make sure you join with the class code and check the schedule regularly.', now - 29 * DAY);
  ann.run(cse, ayesha, 'Quiz 4 is open', 'Quiz 4 (mixed revision) is open for the next two days. You have 10 minutes once you start, so find a quiet place first.', now - 2 * HOUR);
  ann.run(phy, karim, 'Lab schedule', 'Lab sessions start next week. Bring your lab notebook.', now - 5 * DAY);

  const note = db.prepare('INSERT INTO notifications (user_id, message, link, is_read, created_at) VALUES (?, ?, ?, ?, ?)');
  note.run(demo.id, '📝 New quiz in CSE 220 – Data Structures: "Quiz 4 · Mixed Revision" is open now.', `/student/quizzes/${live.id}`, 0, now - 2 * HOUR);
  note.run(demo.id, '📢 CSE 220 – Data Structures: Quiz 4 is open', `/student/classrooms/${cse}?tab=announcements`, 0, now - 2 * HOUR);
  note.run(ayesha, `${studentNames[13][0]} joined CSE 220 – Data Structures.`, `/faculty/classrooms/${cse}?tab=students`, 0, now - 29 * DAY);
});
tx();

const codes = db.prepare('SELECT name, code FROM classrooms').all();
console.log('\nDemo data created.\n');
console.log('  Faculty:  faculty@quizhub.test  /  password123');
console.log('  Student:  student@quizhub.test  /  password123   (13 more students: rafi@, sadia@, imran@ … all password123)\n');
codes.forEach((c) => console.log(`  Join code for ${c.name}: ${c.code}`));
console.log('');
