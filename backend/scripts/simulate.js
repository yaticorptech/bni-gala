#!/usr/bin/env node
/**
 * Rehearsal: fake players register with phone numbers, form teams, and play every solo and
 * team game through the real API, at real speed — watch the big screen and test everything
 * before the event.
 *
 *   npm run simulate                      # 20 players against http://localhost:8150
 *   npm run simulate -- --players 40 --url http://192.168.1.5:8150
 *
 * Afterwards clear the fake data from /admin → "Reset" (the bots are fake players, so use
 * the full reset, not just "Reset scores").
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = String(arg('url', process.env.URL || `http://localhost:${process.env.PORT || 8150}`)).replace(/\/$/, '');
const PLAYERS = Number(arg('players', 20));

const FIRST = ['Priya', 'Rahul', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Rohan', 'Meera', 'Aditya', 'Divya', 'Karan', 'Pooja', 'Suresh', 'Neha', 'Manish', 'Lakshmi', 'Imran', 'Farah', 'Deepak', 'Anil', 'Shreya', 'Gaurav', 'Nisha'];
const LAST = ['Sharma', 'Rao', 'Iyer', 'Reddy', 'Patel', 'Nair', 'Gupta', 'Menon', 'Shetty', 'Khan', 'Joshi', 'Kulkarni', 'Hegde', 'Bhat'];
const BIZ = ['Interior Designer', 'Chartered Accountant', 'Real Estate', 'Digital Marketing', 'Insurance Advisor', 'Event Planner', 'Architect', 'Photographer', 'IT Services', 'Caterer', 'Lawyer', 'Printing', 'Travel Agent', 'Dentist', 'Fitness Coach'];
const CHAPTERS = ['BNI Titans', 'BNI Achievers', 'BNI Visionaries', 'BNI Pioneers'];
const TEAM_NAMES = ['Power Networkers', 'The Closers', 'Referral Kings', 'Deal Makers', 'Momentum', 'Synergy Squad', 'Growth Gurus', 'Titans United', 'Net Worth', 'Chapter Champs', 'Givers Gang', 'The Connectors'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const int = (lo, hi) => Math.round(rand(lo, hi));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${path}: ${data.error || res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Roughly what the server will score `result` — only for the running-score stream. */
function estimate(gameId, r) {
  const clamp = (n) => Math.max(0, Math.min(1000, Math.round(n)));
  switch (gameId) {
    case 'rush': return clamp(r.good * 20 + r.golden * 50 - r.ghost * 15);
    case 'reflex': return clamp(r.times.reduce((s, t) => s + Math.max(0, Math.min(200, (650 - t) / 2.5)), 0) - r.falseStarts * 25);
    case 'colors': return clamp(r.correct * 30 - r.wrong * 15);
    case 'frenzy': return clamp(r.taps * 7);
    case 'math': return clamp(r.correct * 35 - r.wrong * 15);
    case 'timing': return clamp(r.times.reduce((s, t) => s + Math.max(0, 334 - Math.ceil(Math.abs(t - 5000) / 2)), 0));
    case 'hunt': return r.found < 20 ? r.found * 10 : clamp(Math.max(150, 1000 - Math.max(0, r.timeMs / 1000 - 18) * 35 - r.wrong * 15));
    case 'balloons': return clamp(r.popped * 20 + r.golden * 50);
    case 'bullseye': return clamp(r.offsets.reduce((s, o) => s + (o <= 3 ? 100 : Math.max(0, Math.min(95, Math.round(100 - o * 2.5)))), 0));
    default: return 0;
  }
}

/** Plausible stats for a player with skill 0..1, plus how long the "game" takes. */
function fake(gameId, skill) {
  switch (gameId) {
    case 'rush':
      return { wait: 33500, result: { good: int(14 + 20 * skill, 20 + 22 * skill), golden: int(0, 1 + 3 * skill), ghost: int(0, 6 * (1.1 - skill)) } };
    case 'reflex':
      return { wait: int(11000, 16000), result: { times: Array.from({ length: 5 }, () => int(440 - 190 * skill, 520 - 180 * skill)), falseStarts: Math.random() < 0.2 ? 1 : 0 } };
    case 'colors':
      return { wait: 33500, result: { correct: int(12 + 18 * skill, 16 + 20 * skill), wrong: int(0, 5 * (1.2 - skill)) } };
    case 'frenzy':
      return { wait: 11500, result: { taps: int(55 + 55 * skill, 80 + 60 * skill) } };
    case 'math':
      return { wait: 33500, result: { correct: int(8 + 13 * skill, 12 + 15 * skill), wrong: int(0, 5 * (1.2 - skill)) } };
    case 'timing':
      return { wait: int(20000, 24000), result: { times: Array.from({ length: 3 }, () => 5000 + int(-900 + 700 * skill, 900 - 700 * skill)) } };
    case 'hunt': {
      const timeMs = int(48000 - 26000 * skill, 58000 - 28000 * skill);
      return { wait: timeMs + 3500, result: { found: 20, wrong: int(0, 6 * (1.1 - skill)), timeMs } };
    }
    case 'balloons':
      return { wait: 33500, result: { popped: int(22 + 26 * skill, 32 + 28 * skill), golden: int(1, 3 + 5 * skill) } };
    case 'bullseye':
      return { wait: int(16000, 24000), result: { offsets: Array.from({ length: 10 }, () => int(0, 30 - 24 * skill)) } };
    default:
      throw new Error(`no fake for ${gameId}`);
  }
}

async function play(p, gameId, mode = 'solo') {
  const start = await call(`/api/games/${gameId}/start`, { method: 'POST', token: p.token, body: { mode } });
  const finish = (result) => call(`/api/attempts/${start.attemptId}/finish`, { method: 'POST', token: p.token, body: { result } });
  if (steppedGames.has(gameId)) {
    // Quiz-style games are played question by question against the server.
    await sleep(3000);
    for (;;) {
      const q = await call(`/api/attempts/${start.attemptId}/quiz/next`, { method: 'POST', token: p.token });
      if (q.done) break;
      await sleep(rand(1200, 6000));
      // The sim cannot see the answers (they never leave the server), so it guesses.
      const a = await call(`/api/attempts/${start.attemptId}/quiz/answer`, { method: 'POST', token: p.token, body: { index: q.index, choice: int(0, q.options.length - 1) } });
      await sleep(1400);
      if (a.done) break;
    }
    return finish({});
  }
  const { wait, result } = fake(gameId, p.skill);
  // Stream a rising running score meanwhile, like a phone does, so the big screen moves during the game.
  const target = estimate(gameId, result);
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    await sleep(Math.min(1500, wait - (Date.now() - t0)));
    const frac = Math.min(1, (Date.now() - t0) / wait);
    await call(`/api/attempts/${start.attemptId}/progress`, { method: 'POST', token: p.token, body: { score: Math.round(target * frac) } }).catch(() => {});
  }
  return finish(result);
}

let settings = {}; // from /api/state
const steppedGames = new Set(); // games played question by question (quiz, pictionary)
const teamCodes = []; // codes of teams the bots created, so later bots can join them
const teamSeats = new Map(); // code → members the sim has placed there
const connectCodes = []; // Power Connections codes of bots already in the room

// Hosted moments: one poller watches for a running Team Tap Battle round and an open Live
// Quiz question; every bot then taps at a human pace, or answers (a guess) after a pause.
let roundRunning = false;
let openQuestion = null;
async function watchHosted() {
  for (;;) {
    try {
      roundRunning = (await call('/api/round')).status === 'running';
      const q = await call('/api/livequiz');
      openQuestion = q.status === 'open' ? q : null;
    } catch {
      roundRunning = false;
      openQuestion = null;
    }
    await sleep(400);
  }
}
async function tapLoop(p) {
  let answeredNo = 0;
  for (;;) {
    if (openQuestion && openQuestion.no !== answeredNo) {
      const q = openQuestion;
      answeredNo = q.no;
      setTimeout(() => call('/api/livequiz/answer', { method: 'POST', token: p.token, body: { choice: int(0, q.options.length - 1) } }).catch(() => {}), int(800, Math.min(q.limitMs, 9000)));
    }
    if (roundRunning) {
      await call('/api/tap', { method: 'POST', token: p.token, body: { n: int(1, 3) } }).catch(() => {});
      await sleep(int(200, 320));
    } else await sleep(400);
  }
}

/** Create a team or join one a previous bot made (respecting the size limit). */
async function pickTeam(p, i) {
  const max = settings.maxTeamSize || 5;
  const open = teamCodes.filter((c) => (teamSeats.get(c) || 0) < max);
  const shouldCreate = !open.length || i % 4 === 0;
  try {
    if (shouldCreate) {
      const name = `${TEAM_NAMES[teamCodes.length % TEAM_NAMES.length]}${teamCodes.length >= TEAM_NAMES.length ? ` ${Math.floor(teamCodes.length / TEAM_NAMES.length) + 1}` : ''}`;
      const me = await call('/api/teams', { method: 'POST', token: p.token, body: { name } });
      const code = me.teamDetail.code;
      teamCodes.push(code);
      teamSeats.set(code, 1);
      console.log(`  ${p.name} created Team ${me.teamDetail.name} (code ${code.toUpperCase()})`);
    } else {
      const code = pick(open);
      const me = await call('/api/teams/join', { method: 'POST', token: p.token, body: { code } });
      teamSeats.set(code, (teamSeats.get(code) || 0) + 1);
      console.log(`  ${p.name} joined Team ${me.teamDetail.name}`);
    }
  } catch (err) {
    console.log(`  ${p.name}: team setup — ${err.message}`);
  }
}

async function guest(i) {
  await sleep(i * rand(1200, 3000)); // people trickle in
  const chapter = pick(settings.chapters);
  const body = {
    name: `${pick(FIRST)} ${pick(LAST)}`,
    phone: `9${800000000 + i}`, // unique, valid-looking 10-digit number per bot
    business: pick(BIZ),
    chapter,
  };
  const { token, player } = await call('/api/join', { method: 'POST', body });
  const p = { name: player.name, token, skill: Math.random() };
  console.log(`+ ${p.name} registered · ${chapter} (skill ${p.skill.toFixed(2)})`);
  tapLoop(p);
  try {
    const spin = await call('/api/spin', { method: 'POST', token: p.token }); // the welcome spin
    console.log(`  ${p.name} spun the wheel → +${spin.prize}`);
  } catch (err) {
    console.log(`  ${p.name}: spin — ${err.message}`);
  }
  try {
    // Power Connections: "meet" a couple of bots who arrived earlier.
    const cx = await call('/api/connections', { token: p.token });
    const meet = connectCodes.slice().sort(() => Math.random() - 0.5).slice(0, int(1, 3));
    connectCodes.push(cx.code);
    for (const code of meet) await call('/api/connect', { method: 'POST', token: p.token, body: { code } });
    if (meet.length) console.log(`  ${p.name} connected with ${meet.length} member${meet.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.log(`  ${p.name}: connect — ${err.message}`);
  }
  await sleep(rand(500, 2000));
  await pickTeam(p, i);
  const { games } = await call('/api/state');
  games.filter((g) => g.stepped).forEach((g) => steppedGames.add(g.id));
  const solo = games.filter((g) => !g.hosted && !g.bonus && !g.social).map((g) => ({ id: g.id, mode: 'solo' }));
  const team = (settings.teamGames || []).map((id) => ({ id, mode: 'team' }));
  const order = [...solo, ...team].sort(() => Math.random() - 0.5);
  if (Math.random() < 0.5) order.push(pick(order)); // some retry a game
  for (const { id: gameId, mode } of order) {
    try {
      const r = await play(p, gameId, mode);
      console.log(`  ${p.name.padEnd(18)} ${(mode === 'team' ? '👥' : '  ')} ${gameId.padEnd(10)} ${String(r.score).padStart(4)}  → ${mode === 'team' ? `team total ${r.total}${r.rank ? ` (#${r.rank})` : ''}` : `total ${r.total}${r.rank ? `  #${r.rank}` : ''}`}`);
    } catch (err) {
      console.log(`  ${p.name}: ${gameId} — ${err.message}`);
    }
    await sleep(rand(1000, 5000));
  }
}

(async () => {
  try {
    ({ settings } = await call('/api/state'));
  } catch {
    console.error(`Can't reach ${BASE} — is the server running (npm start)?`);
    process.exit(1);
  }
  if (!settings.chapters?.length) {
    console.error(`No chapters configured — registration needs the dropdown list.\nAdd some in ${BASE}/admin → Chapters (e.g. ${CHAPTERS.join(', ')}), then rerun.`);
    process.exit(1);
  }
  console.log(`Simulating ${PLAYERS} players against ${BASE} — watch ${BASE}/screen\n`);
  watchHosted();
  await Promise.all(Array.from({ length: PLAYERS }, (_, i) => guest(i)));
  console.log('\nDone playing. The bots keep tapping in any Team Tap Battle round and guessing in any Live Quiz question you start — press Ctrl+C to stop them.');
  console.log('Remember: these are fake players — use /admin → "Remove everyone too" before real guests arrive.');
})();
