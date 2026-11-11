#!/usr/bin/env node
/**
 * Local dev server for the frontend: serves these files and forwards /api and /socket.io
 * (WebSockets included) to the backend, so nothing else needs configuring.
 *
 *   npm run dev                  # http://localhost:5160 → backend at http://localhost:8150
 *   npm run dev -- --host        # also reachable from phones on the same Wi-Fi
 *   npm run dev -- --port 3000   # another port; BACKEND=http://localhost:9000 for another backend
 *
 * Only for local use: Vercel serves the files directly (see .vercelignore).
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const exposed = args.includes('--host');
const portAt = args.indexOf('--port');
const PORT = Number(portAt >= 0 ? args[portAt + 1] : process.env.PORT) || 5160;
const BACKEND = new URL(process.env.BACKEND || 'http://localhost:8150');
const BACKEND_PORT = Number(BACKEND.port) || 80;
const ROOT = __dirname;
const FORWARDED = /^\/(api|socket\.io)(\/|\?|$)/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function serveFile(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }
  // Same-origin here (requests are forwarded), whatever config.js says for Vercel.
  if (urlPath === '/js/config.js') return send(res, 200, TYPES['.js'], "export const API_URL = '';\n");

  // Like Vercel's cleanUrls: / → index.html, /screen → screen.html
  const candidates = urlPath.endsWith('/') ? [`${urlPath}index.html`] : [urlPath, `${urlPath}.html`];
  for (const candidate of candidates) {
    const file = path.join(ROOT, path.normalize(candidate));
    if (!file.startsWith(ROOT + path.sep)) break;
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  send(res, 404, 'text/plain', 'Not found');
}

const backendDown = () =>
  JSON.stringify({ error: `Backend not reachable at ${BACKEND.origin} — start it: cd backend && npm run dev` });

function forward(req, res) {
  const upstream = http.request(
    { host: BACKEND.hostname, port: BACKEND_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    send(res, 502, 'application/json', backendDown());
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => (FORWARDED.test(req.url) ? forward(req, res) : serveFile(req, res)));

// Socket.IO upgrades to a WebSocket: replay the handshake to the backend, then pipe raw bytes both ways.
server.on('upgrade', (req, socket, head) => {
  if (!FORWARDED.test(req.url)) return socket.destroy();
  const upstream = net.connect(BACKEND_PORT, BACKEND.hostname, () => {
    let handshake = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) handshake += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(`${handshake}\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use — stop the other server or run: npm run dev -- --port ${PORT + 1}\n`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, exposed ? '0.0.0.0' : 'localhost', () => {
  const ip = exposed && lanIp();
  console.log('\n🎮 Frontend dev server');
  console.log(`   Local:    http://localhost:${PORT}/   (big screen /screen · admin /admin)`);
  console.log(ip ? `   Network:  http://${ip}:${PORT}/` : '   Network:  use --host to open it from phones');
  http
    .get(`${BACKEND.origin}/api/state`, (r) => {
      r.resume();
      console.log(`   Backend:  ${BACKEND.origin} ✓\n`);
    })
    .on('error', () => console.log(`   Backend:  ${BACKEND.origin} ⚠️  not running — start it: cd backend && npm run dev\n`));
});
