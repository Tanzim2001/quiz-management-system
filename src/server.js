'use strict';
const app = require('./app');
const config = require('./config');
const { finalizeExpired } = require('./lib/quizService');

// Auto-submit attempts whose time ran out even if nobody is looking at them.
setInterval(() => finalizeExpired(), 15 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  ${config.appName} is running → http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`);
  if (config.host === '0.0.0.0') console.log('  Listening on all interfaces (open it from your phone using this computer\'s LAN IP).\n');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
