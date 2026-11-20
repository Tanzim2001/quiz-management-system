'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const db = require('./db');
const SQLiteStore = require('./lib/sessionStore');
const helpers = require('./lib/viewHelpers');
const { loadUser, csrf, flash } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(config.root, 'views'));
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      // Plain-HTTP localhost/LAN use: don't force https.
      'upgrade-insecure-requests': null,
    },
  },
  strictTransportSecurity: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
}));

app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
// Chart.js is served from node_modules so the app works fully offline.
const chartJsFile = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
app.get('/static/vendor/chart.umd.min.js', (req, res) => res.sendFile(chartJsFile, { maxAge: config.isProduction ? '7d' : 0 }));

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '100kb' }));

app.use(session({
  name: 'quizhub.sid',
  secret: config.sessionSecret,
  store: new SQLiteStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use((req, res, next) => {
  Object.assign(res.locals, helpers, { appName: config.appName, path: req.path, title: '', flash: [], user: null, unread: 0, csrfToken: '' });
  next();
});
app.use(flash);
app.use(loadUser);
app.use(csrf);

app.use(require('./routes/auth'));
app.use(require('./routes/common'));
app.use('/student', require('./routes/student'));
app.use('/faculty', require('./routes/faculty'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', status: 404, message: "We couldn't find that page." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  if (req.accepts(['html', 'json']) === 'json') return res.status(status).json({ error: 'Something went wrong.' });
  res.status(status).render('error', { title: 'Error', status, message: status === 500 ? 'Something went wrong on our side.' : err.message });
});

module.exports = app;
