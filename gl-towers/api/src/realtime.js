// WebSocket server: pushes readings, alerts and state changes to every open browser.
const { WebSocketServer } = require('ws');

let wss = null;

function attach(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'hello', time: new Date().toISOString() }));
  });
  // Drop dead connections every 30 s
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(timer));
  return wss;
}

function broadcast(event) {
  if (!wss) return;
  const msg = JSON.stringify(event);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

module.exports = { attach, broadcast };
