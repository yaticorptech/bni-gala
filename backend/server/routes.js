const express = require('express');
const QRCode = require('qrcode');
const config = require('./config');
const { publicGames } = require('./games');
const { HttpError, safeEqual, lanIp } = require('./util');

/** The address phones should open: PUBLIC_URL, else this laptop's Wi-Fi IP, else the request host. */
function joinUrl(req) {
  if (config.publicUrl) return `${config.publicUrl}/`;
  const host = req.get('host') || `localhost:${config.port}`;
  if (/^(localhost|127\.|\[::1\])/.test(host)) {
    const ip = lanIp();
    if (ip) return `http://${ip}:${config.port}/`;
  }
  return `${req.protocol}://${host}/`;
}

module.exports = function createRoutes(state, { connections, storage }) {
  const r = express.Router();

  function playerAuth(req, _res, next) {
    const header = req.get('authorization') || '';
    const player = state.playerByToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!player) return next(new HttpError(401, 'Please log in again', 'NO_PLAYER'));
    req.player = player;
    next();
  }

  // Slow down password guessing: after 20 wrong tries from one IP within 15 minutes, every
  // further check from that IP waits 2 s before answering. A delay rather than a block,
  // because at a venue every phone on the Wi-Fi shares one public IP with the admin's
  // laptop — a guest poking at /admin must not be able to lock the real admin out.
  const failures = new Map();
  function adminAuth(req, _res, next) {
    const now = Date.now();
    const f = failures.get(req.ip);
    const check = () => {
      if (safeEqual(req.get('x-admin-key') || '', config.adminPassword)) return next();
      failures.set(req.ip, f && f.until > now ? { ...f, count: f.count + 1 } : { count: 1, until: now + 15 * 60 * 1000 });
      next(new HttpError(401, 'Wrong admin password', 'NO_ADMIN'));
    };
    if (f && f.until > now && f.count >= 20) setTimeout(check, 2000);
    else check();
  }

  // ---------------------------------------------------------- public

  r.get('/state', (req, res) => {
    res.json({ settings: state.publicSettings(), games: publicGames(), joinUrl: joinUrl(req) });
  });

  r.get('/qr.svg', async (req, res, next) => {
    try {
      const svg = await QRCode.toString(joinUrl(req), {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0f1a', light: '#ffffff' },
      });
      res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
    } catch (err) {
      next(err);
    }
  });

  r.get('/leaderboard', (_req, res) => res.json(state.screenPayload()));

  // Register (chapter + name + phone) or log back in (phone alone) — see state.join.
  r.post('/join', (req, res) => {
    const p = state.join(req.body);
    res.status(201).json({ token: p.token, player: { id: p.id, name: p.name, business: p.business, chapter: p.chapter } });
  });

  r.get('/me', playerAuth, (req, res) => res.json(state.me(req.player)));

  // The welcome spin: one guaranteed prize per player, decided server-side (see state.spin).
  r.post('/spin', playerAuth, (req, res) => res.json(state.spin(req.player)));

  // Power Connections (networking): my QR code + members met, and connecting by scanned/typed code.
  r.get('/connections', playerAuth, (req, res) => res.json(state.connections(req.player)));
  r.post('/connect', playerAuth, (req, res) => res.json(state.connect(req.player, req.body?.code)));

  // A connected member's contact as a vCard — "save their number to my phone". Only for
  // members the caller has actually connected with (state.contactCard enforces it).
  // ?name=… is what the saver typed; the server prefixes it with "BNI <chapter>".
  r.get('/contact/:code', playerAuth, (req, res) => {
    const { name, vcf } = state.contactCard(req.player, req.params.code, req.query.name);
    res
      .type('text/vcard; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${name.replace(/[^\w .-]/g, '')}.vcf"`)
      .send(vcf);
  });

  // A member's personal QR, shown in their app. It encodes the join URL + #c=<code>, so any
  // phone camera app can scan it: the link opens this app, which connects automatically.
  r.get('/connect-qr/:code', async (req, res, next) => {
    try {
      const player = state.playerByConnectCode(req.params.code);
      if (!player) throw new HttpError(404, 'Unknown code');
      const svg = await QRCode.toString(`${joinUrl(req)}#c=${player.connectCode}`, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0f1a', light: '#ffffff' },
      });
      res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
    } catch (err) {
      next(err);
    }
  });

  // Avatar emoji.
  r.put('/me', playerAuth, (req, res) => {
    state.setEmoji(req.player, req.body?.emoji);
    res.json(state.me(req.player));
  });

  // ---------------------------------------------------------- teams (player-created)

  // Browse: every team, points-ranked. Join codes never appear here.
  r.get('/teams', (_req, res) => res.json({ teams: state.publicTeams(), maxTeamSize: state.settings.maxTeamSize }));

  r.post('/teams', playerAuth, (req, res) => {
    state.createTeam(req.player, req.body || {});
    res.status(201).json(state.me(req.player));
  });

  r.post('/teams/join', playerAuth, (req, res) => {
    state.joinTeam(req.player, req.body?.code);
    res.json(state.me(req.player));
  });

  r.post('/teams/leave', playerAuth, (req, res) => {
    state.leaveTeam(req.player);
    res.json(state.me(req.player));
  });

  // ---------------------------------------------------------- playing

  // body.mode 'team' plays for the player's team (the group games); default is solo.
  r.post('/games/:gameId/start', playerAuth, (req, res) => {
    res.status(201).json(state.startAttempt(req.player, req.params.gameId, req.body?.mode === 'team' ? 'team' : 'solo'));
  });

  // Running score of a game in progress (provisional; the finish below is what counts).
  r.post('/attempts/:id/progress', playerAuth, (req, res) => {
    state.progress(req.player.id, req.params.id, req.body?.score === null ? null : req.body?.score);
    res.json({ ok: true });
  });

  r.post('/attempts/:id/finish', playerAuth, (req, res) => {
    res.json(state.finishAttempt(req.player, req.params.id, req.body?.result));
  });

  r.post('/attempts/:id/quiz/:step(next|answer)', playerAuth, (req, res) => {
    res.json(state.quizStep(req.player, req.params.id, req.params.step, req.body));
  });

  // Team Tap Battle. Phones normally send taps over the live connection; this is the
  // fallback when that is down, and what the rehearsal bots use.
  r.get('/round', (_req, res) => res.json(state.roundPayload()));
  r.post('/tap', playerAuth, (req, res) => {
    state.tap(req.player.id, req.body?.n);
    res.json({ ok: true });
  });

  // Live Quiz: the current question (no answer while open) and a player's one answer to it.
  r.get('/livequiz', (_req, res) => res.json(state.liveQuizPayload()));
  r.post('/livequiz/answer', playerAuth, (req, res) => res.json(state.answerLive(req.player.id, req.body?.choice)));

  // ---------------------------------------------------------- admin

  r.post('/admin/login', adminAuth, (_req, res) => res.json({ ok: true }));

  r.get('/admin/overview', adminAuth, (req, res) => {
    res.json({ ...state.adminOverview(), connections: connections(), storage: storage(), joinUrl: joinUrl(req) });
  });

  r.put('/admin/settings', adminAuth, (req, res) => {
    state.updateSettings(req.body);
    res.json({ ok: true });
  });

  // Disband a team (members stay, just teamless).
  r.delete('/admin/teams/:id', adminAuth, (req, res) => {
    state.deleteTeam(req.params.id);
    res.json({ ok: true });
  });

  // Team Tap Battle
  r.post('/admin/tap-round', adminAuth, (req, res) => res.json({ ok: true, round: state.startRound(req.body?.durationMs) }));
  r.post('/admin/tap-round/end', adminAuth, (_req, res) => {
    state.finishRound();
    res.json({ ok: true });
  });
  r.post('/admin/team-scores/reset', adminAuth, (_req, res) => {
    state.resetTeamScores();
    res.json({ ok: true });
  });

  // Live Quiz (host side)
  r.put('/admin/livequiz', adminAuth, (req, res) => res.json({ ok: true, ...state.saveLiveQuiz(req.body?.text) }));
  r.post('/admin/livequiz/ask', adminAuth, (req, res) => res.json({ ok: true, question: state.askLive(req.body?.index, req.body?.limitMs) }));
  r.post('/admin/livequiz/close', adminAuth, (_req, res) => {
    state.closeLive();
    res.json({ ok: true });
  });
  r.post('/admin/livequiz/hide', adminAuth, (_req, res) => {
    state.hideLive();
    res.json({ ok: true });
  });

  // Lucky draw
  r.post('/admin/lucky-draw', adminAuth, (req, res) => res.json({ ok: true, draw: state.luckyDraw(req.body || {}) }));

  r.post('/admin/reveal', adminAuth, (req, res) => {
    state.startReveal(req.body?.count);
    res.json({ ok: true });
  });

  r.delete('/admin/players/:id', adminAuth, (req, res) => {
    state.deletePlayer(req.params.id);
    res.json({ ok: true });
  });

  // Scores, rounds, draws and quiz progress go; everyone stays logged in, teams stay.
  r.post('/admin/reset-scores', adminAuth, (_req, res) => {
    state.resetScores();
    res.json({ ok: true });
  });

  // Players and teams go too.
  r.post('/admin/reset', adminAuth, (req, res) => {
    if (req.body?.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm');
    state.reset();
    res.json({ ok: true });
  });

  r.get('/admin/export.csv', adminAuth, (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res
      .type('text/csv')
      .set('Content-Disposition', `attachment; filename="leaderboard-${stamp}.csv"`)
      .send('﻿' + state.exportCsv()); // BOM so Excel reads names in UTF-8
  });

  r.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, code: err.code });
  });

  return r;
};
