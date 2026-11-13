const fs = require('fs');
const http = require('http');
const express = require('express');
const config = require('./config');
const createStore = require('./store');
const GameState = require('./state');
const attachRealtime = require('./realtime');
const createRoutes = require('./routes');
const { lanIp } = require('./util');

async function main() {
  // Railway wipes the disk on every deploy and restart, so file storage there means losing
  // every score. Refuse to start rather than run an event on it by accident.
  const onRailway = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
  if (onRailway && !config.mongoUri && !process.env.ALLOW_FILE_STORE) {
    console.error('MONGODB_URI is not set. On Railway, scores kept in a file are lost on every restart.');
    console.error('Add MONGODB_URI under Variables (or set ALLOW_FILE_STORE=1 to run without a database anyway).');
    process.exit(1);
  }

  const store = await createStore();
  const state = new GameState(store);
  await state.load();

  const app = express();
  app.set('trust proxy', 1); // correct https/host when hosted behind Render/Railway proxies
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' })); // room for a pasted guest list of ~1000 lines

  const server = http.createServer(app);
  const io = attachRealtime(server, state);

  // The frontend may be hosted elsewhere (e.g. Vercel), so let those sites call the API.
  app.use('/api', (req, res, next) => {
    res.vary('Origin');
    const origin = req.get('origin');
    if (!origin || !config.corsOrigins.includes(origin)) return next();
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'content-type, authorization, x-admin-key',
      'Access-Control-Max-Age': '600',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', createRoutes(state, { connections: () => io.engine.clientsCount, storage: () => store.describe() }));

  const servingFrontend = fs.existsSync(config.frontendDir);
  if (servingFrontend) {
    // Same server, so the pages call it directly whatever frontend/js/config.js points at.
    app.get('/js/config.js', (_req, res) => res.type('js').send("export const API_URL = '';\n"));
    // /screen → screen.html, /admin → admin.html
    app.use(express.static(config.frontendDir, { extensions: ['html'] }));
  } else {
    app.get('/', (_req, res) => res.json({ ok: true, service: 'BNI Gala Awards API' }));
  }
  // Errors raised before the API router (e.g. malformed JSON bodies).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : 'Bad request' });
  });

  server.listen(config.port, () => {
    const ip = lanIp();
    const local = `http://localhost:${config.port}`;
    const lan = ip ? `http://${ip}:${config.port}` : null;
    console.log(`\n🏆 BNI Gala Awards running — storage: ${store.describe()}`);
    if (servingFrontend) {
      console.log(`   Players (phones): ${config.publicUrl || lan || local}/`);
      console.log(`   Big screen:       ${local}/screen`);
      console.log(`   Admin:            ${local}/admin`);
    } else {
      console.log(`   API only (no frontend/ folder) on port ${config.port}`);
      if (config.corsOrigins.length) console.log(`   Frontend allowed: ${config.corsOrigins.join(', ')}`);
      else console.log('   ⚠️  PUBLIC_URL is not set — set it to the frontend address (e.g. your Vercel URL)');
    }
    if (config.usingDefaultPassword) console.log('   ⚠️  Admin password is the default "bni-admin" — set ADMIN_PASSWORD in .env');
    console.log('');
  });

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try {
      // Let in-flight score writes land before closing the store (5 s cap so a hung
      // database never blocks the exit).
      await Promise.race([state.flush(), new Promise((r) => setTimeout(r, 5000))]);
      await store.close();
    } catch (err) {
      console.error('[store] close failed:', err.message);
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
