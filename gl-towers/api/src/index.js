// GL Towers server: REST API + MQTT bridge + WebSocket push + web application
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const realtime = require('./realtime');
const bridge = require('./mqttBridge');

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use('/api', routes);

// The web application is served from the same origin, so it finds the API automatically
if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
  app.use(express.static(config.webDir));
} else {
  console.warn('[web] no index.html found in', config.webDir);
}

const server = http.createServer(app);
realtime.attach(server);
bridge.start();

server.listen(config.port, () => console.log(`[api] GL Towers listening on http://localhost:${config.port}`));

function shutdown() { bridge.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

module.exports = { app, server };
