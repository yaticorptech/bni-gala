/**
 * Socket.IO rooms:
 *   screen  – big-screen leaderboard (full board, activity feed, leader + reveal events)
 *   players – phones; each gets a small personalised payload (own rank + top 5)
 *   admin   – just told "something changed" so it can refetch
 * Board broadcasts are throttled so a burst of finishing games costs one update.
 */
const { Server } = require('socket.io');
const config = require('./config');

const BROADCAST_EVERY_MS = 1000;

module.exports = function attachRealtime(httpServer, state) {
  const io = new Server(httpServer, {
    pingInterval: 20000,
    pingTimeout: 25000,
    cors: { origin: config.corsOrigins }, // a frontend hosted on another domain (e.g. Vercel)
  });

  io.on('connection', (socket) => {
    const auth = socket.handshake.auth || {};
    if (auth.role === 'screen') {
      socket.join('screen');
      socket.emit('board', state.screenPayload());
    } else if (auth.role === 'admin') {
      socket.join('admin');
    } else {
      const player = state.playerByToken(auth.token);
      if (player) {
        socket.data.playerId = player.id;
        socket.join('players');
        socket.emit('me', state.livePayload(player.id));
      }
    }
    socket.emit('settings', state.publicSettings());
    socket.emit('round', state.roundPayload());
    socket.emit('livequiz', state.liveQuizPayload());
    // Team Tap Battle: phones send their taps in small batches over this connection.
    socket.on('tap', (n) => {
      if (socket.data.playerId) state.tap(socket.data.playerId, n);
    });
    // Running score of a game in progress, so the big screen moves while people play.
    socket.on('progress', (m) => {
      if (socket.data.playerId && m && typeof m === 'object') state.progress(socket.data.playerId, String(m.attemptId || ''), m.score === null ? null : m.score);
    });
  });

  let timer = null;
  let lastSent = 0;
  let leaderId = state.board(false).ranked[0]?.id ?? null;

  function broadcast() {
    timer = null;
    lastSent = Date.now();
    const payload = state.screenPayload();
    io.to('screen').emit('board', payload);

    if (payload.mode === 'live') {
      const top = payload.confirmedLeader; // confirmed scores only, so games in progress can't flicker the banner
      if (top && top.id !== leaderId) io.to('screen').emit('leader', top);
      leaderId = top?.id ?? null;
    }

    for (const socket of io.of('/').sockets.values()) {
      const playerId = socket.data.playerId;
      if (!playerId) continue;
      if (state.players.has(playerId)) socket.emit('me', state.livePayload(playerId));
      else socket.data.playerId = null;
    }
    io.to('admin').emit('changed');
  }

  state.on('change', () => {
    if (!timer) timer = setTimeout(broadcast, Math.max(50, BROADCAST_EVERY_MS - (Date.now() - lastSent)));
  });
  state.on('settings', (s) => io.emit('settings', s));
  state.on('activity', (item) => {
    if (state.settings.screenMode === 'live') io.to('screen').emit('activity', item);
  });
  state.on('reveal', (reveal) => io.to('screen').emit('reveal', reveal));
  state.on('round', (round) => io.emit('round', round)); // screen, phones and admin all follow the battle
  state.on('livequiz', (q) => io.emit('livequiz', q));
  state.on('luckydraw', (draw) => io.emit('luckydraw', draw));
  state.on('reset', () => {
    leaderId = null;
    io.emit('reset');
  });
  state.on('scoresReset', () => {
    leaderId = null;
    io.emit('scoresReset'); // phones stay logged in, just refresh
  });

  return io;
};
