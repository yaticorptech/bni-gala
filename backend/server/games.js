/**
 * Game registry. Every game is worth 0–1000 points; a player's leaderboard total is the
 * sum of their best score in each game.
 *
 * Scores are always computed HERE from the raw stats a game reports (hits, reaction
 * times, moves…), never trusted from the browser. Stats are range-checked and the time
 * between "start" and "finish" is measured on the server. The quiz is fully
 * server-authoritative: answers never leave the server and every answer is timed here.
 */
const fs = require('fs');
const config = require('./config');
const { HttpError, shuffle } = require('./util');

const MAX = 1000;
const QUIZ_GRACE_MS = 1500; // network latency allowance on top of the 15s
const PICT_LIMIT_MS = 8000;
const PICT_PUZZLES = 10;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const invalid = (what) => new HttpError(400, `Invalid game result (${what})`, 'BAD_RESULT');

function count(value, max, what) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw invalid(what);
  return value;
}

function millis(value, max, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw invalid(what);
  return Math.round(value);
}

const quizRuntime = (runtime) => {
  if (!runtime) throw new HttpError(410, 'This quiz session expired — please start again', 'EXPIRED');
  return runtime;
};

/**
 * A server-run multiple-choice game: questions, answers and timing all live here and the phone
 * only ever sees options. `pick()` returns the round's questions as { q, options, answer }.
 */
function quizLike({ pick, limitMs, empty }) {
  return {
    start(ctx = {}) {
      const picked = pick(ctx);
      if (!picked.length) throw new HttpError(503, empty);
      return {
        runtime: { qs: picked, i: 0, servedAt: null, points: [], correct: 0, last: null, limitMs },
        payload: { total: picked.length, timeLimitMs: limitMs },
      };
    },
    steps: {
      /** Serve the current question. Idempotent: re-asking returns the same question with the clock still running. */
      next(rt) {
        if (rt.i >= rt.qs.length) return { done: true };
        if (rt.servedAt == null) rt.servedAt = Date.now();
        const q = rt.qs[rt.i];
        return {
          done: false,
          index: rt.i,
          total: rt.qs.length,
          question: q.q,
          options: q.options,
          timeLimitMs: rt.limitMs,
          remainingMs: Math.max(0, rt.limitMs - (Date.now() - rt.servedAt)),
        };
      },
      /** Grade an answer using the server's own clock. Idempotent for the question just answered (safe to retry). */
      answer(rt, body) {
        const index = Number(body?.index);
        if (rt.last && index === rt.last.index) return rt.last;
        if (index !== rt.i || rt.servedAt == null) throw new HttpError(409, 'Out of sync — please start again', 'QUIZ_SYNC');
        const q = rt.qs[rt.i];
        const elapsed = Date.now() - rt.servedAt;
        const choice = Number.isInteger(body?.choice) ? body.choice : -1;
        const correct = choice === q.answer && elapsed <= rt.limitMs + QUIZ_GRACE_MS;
        const points = correct ? 50 + Math.round(50 * Math.max(0, 1 - elapsed / rt.limitMs)) : 0;
        rt.points.push(points);
        if (correct) rt.correct++;
        rt.i++;
        rt.servedAt = null;
        rt.last = {
          index,
          correct,
          answer: q.answer,
          points,
          totalPoints: rt.points.reduce((a, b) => a + b, 0),
          done: rt.i >= rt.qs.length,
        };
        return rt.last;
      },
    },
    score(_r, { runtime }) {
      const rt = quizRuntime(runtime);
      // `served` remembers which questions this try used, so the player's next try gets fresh ones.
      return { score: clamp(rt.points.reduce((a, b) => a + b, 0), 0, MAX), meta: { correct: rt.correct, total: rt.qs.length, served: rt.qs.map((q) => q.q) } };
    },
  };
}

/** Shuffle a question's options per player so "the answer is B" can't be passed around the room. */
function shuffled(q) {
  const order = shuffle(q.options.map((_, i) => i));
  return { q: q.q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
}

// ---------------------------------------------------------------- emoji pictionary bank

let pictCache = { mtime: 0, puzzles: [] };

/** config/pictionary.json: [{ emoji, answer }] — professions drawn in emoji. Re-read whenever it changes. */
function pictBank() {
  try {
    const { mtimeMs } = fs.statSync(config.pictionaryFile);
    if (mtimeMs !== pictCache.mtime) {
      const raw = JSON.parse(fs.readFileSync(config.pictionaryFile, 'utf8'));
      const puzzles = (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p.emoji === 'string' && typeof p.answer === 'string' && p.emoji.trim() && p.answer.trim());
      if (puzzles.length >= 4) pictCache = { mtime: mtimeMs, puzzles };
      else console.warn('[pictionary] need at least 4 puzzles in', config.pictionaryFile);
    }
  } catch (err) {
    console.error('[pictionary] could not read', config.pictionaryFile, '-', err.message);
  }
  return pictCache.puzzles;
}

const pictionary = quizLike({
  limitMs: PICT_LIMIT_MS,
  empty: 'Pictionary puzzles are not set up yet',
  pick: ({ seen = new Set() } = {}) => {
    const bank = pictBank();
    const answers = [...new Set(bank.map((p) => p.answer))];
    // Puzzles this player hasn't seen in earlier tries come first; already-seen ones only top up a short bank.
    const fresh = shuffle(bank.filter((p) => !seen.has(p.emoji)));
    const again = shuffle(bank.filter((p) => seen.has(p.emoji)));
    return [...fresh, ...again].slice(0, PICT_PUZZLES).map((p) => {
      // The right profession plus three others from the bank, in random order.
      const others = shuffle(answers.filter((x) => x !== p.answer)).slice(0, 3);
      return shuffled({ q: p.emoji, options: [p.answer, ...others], answer: 0 });
    });
  },
});

// ---------------------------------------------------------------- games

const GAMES = [
  {
    // Social: played in the room, not on the screen — every member has a personal QR (and a
    // short code) in the app; scanning another member's QR connects the pair once and pays
    // both sides. Scored in state.connect, never through startAttempt. First in the list so
    // the networking game sits at the top of every phone's hub.
    id: 'network',
    name: 'Power Connections',
    emoji: '🔗',
    color: '#0ea5e9',
    tagline: 'Meet members, scan their QR — build your connections!',
    duration: 'all night',
    howTo: ['Open your QR and show it to members you meet', 'Scan theirs with the in-app scanner or any camera app — or type their code', 'Every new member you connect with counts for you BOTH', 'No points here — just the count. Build the biggest network in the room!'],
    social: true,
    minMs: 0,
    score() {
      throw new HttpError(403, 'Connections are scored when you scan a member', 'SOCIAL');
    },
  },
  {
    id: 'frenzy',
    name: 'Tap Frenzy',
    emoji: '👆',
    color: '#ec4899',
    tagline: 'Tap like crazy for 10 seconds!',
    duration: '10 sec',
    howTo: ['One big button — tap it as fast as you can', '10 seconds on the clock', '7 points a tap · 143 taps is a perfect 1000'],
    minMs: 9500,
    score(r, { elapsedMs }) {
      // 143 taps already scores 1000; the caps only rule out autoclickers (two thumbs manage ~16 a second).
      const taps = count(r.taps, 200, 'taps');
      if (taps > 18 * Math.max(10, elapsedMs / 1000)) throw invalid('too many taps');
      return { score: clamp(taps * 7, 0, MAX), meta: { taps, perSec: taps / 10 } };
    },
  },
  {
    id: 'rush',
    name: 'Referral Rush',
    emoji: '🤝',
    color: '#e3263a',
    tagline: 'Tap the referrals, dodge the ghost clients!',
    duration: '30 sec',
    howTo: ['Tap 🤝 referrals as they pop up (+20)', 'Golden ⭐ big referrals are worth +50', 'Don’t tap 👻 ghost clients (−15)'],
    minMs: 28000,
    score(r) {
      const good = count(r.good, 80, 'good');
      const golden = count(r.golden, 20, 'golden');
      const ghost = count(r.ghost, 80, 'ghost');
      return { score: clamp(good * 20 + golden * 50 - ghost * 15, 0, MAX), meta: { good, golden, ghost } };
    },
  },
  {
    id: 'reflex',
    name: 'Lightning Reflex',
    emoji: '⚡',
    color: '#f7c548',
    tagline: 'Wait for green… then TAP!',
    duration: '5 rounds',
    howTo: ['The pad turns GREEN after a random delay', 'Tap it as fast as you can', 'Tapping too early costs 25 points'],
    minMs: 7000,
    score(r) {
      if (!Array.isArray(r.times) || r.times.length !== 5) throw invalid('times');
      const times = r.times.map((t) => millis(t, 10000, 'time'));
      const falseStarts = count(r.falseStarts, 50, 'falseStarts');
      // 150ms → 200 pts per round, 650ms+ → 0. Under 100ms is not humanly possible → 0.
      const points = times.reduce((sum, t) => sum + (t < 100 ? 0 : clamp(Math.round((650 - t) / 2.5), 0, 200)), 0);
      const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      return { score: clamp(points - falseStarts * 25, 0, MAX), meta: { avgMs, bestMs: Math.min(...times), falseStarts } };
    },
  },
  {
    id: 'memory',
    name: 'Memory Match',
    emoji: '🧠',
    color: '#a855f7',
    tagline: 'Find all 8 pairs — fast, with few moves.',
    duration: '2 min max',
    howTo: ['Flip two cards at a time', 'Match all 8 pairs before time runs out', 'Fewer moves + faster time = more points'],
    minMs: 5000,
    score(r, { elapsedMs }) {
      const pairs = count(r.pairs, 8, 'pairs');
      const moves = count(r.moves, 500, 'moves');
      const timeMs = millis(r.timeMs, 125000, 'timeMs');
      if (moves < pairs || timeMs > elapsedMs + 2000) throw invalid('timing');
      if (pairs < 8) return { score: pairs * 15, meta: { pairs, moves, timeMs, completed: false } };
      if (moves < 8 || timeMs < 4000) throw invalid('too fast');
      const raw = 1000 - Math.max(0, moves - 8) * 20 - Math.max(0, timeMs / 1000 - 20) * 5;
      return { score: clamp(Math.round(raw), 150, MAX), meta: { pairs, moves, timeMs, completed: true } };
    },
  },
  {
    id: 'colors',
    name: 'Colour Clash',
    emoji: '🎨',
    color: '#3b82f6',
    tagline: 'Tap the INK colour — not the word!',
    duration: '30 sec',
    howTo: ['A colour word appears in a different ink colour', 'Tap the button matching the INK colour', 'Right +30 · Wrong −15'],
    minMs: 28000,
    score(r) {
      const correct = count(r.correct, 120, 'correct');
      const wrong = count(r.wrong, 120, 'wrong');
      if (correct + wrong > 120) throw invalid('too many answers');
      return { score: clamp(correct * 30 - wrong * 15, 0, MAX), meta: { correct, wrong } };
    },
  },
  {
    id: 'simon',
    name: 'Handshake Sequence',
    emoji: '🎵',
    color: '#06b6d4',
    tagline: 'Watch the pattern, repeat it — how far can you go?',
    duration: 'until you slip',
    howTo: ['Four pads light up in a sequence', 'Tap them back in the same order', 'Each level adds one more — one slip and the run ends'],
    minMs: 1500,
    score(r, { elapsedMs }) {
      const level = count(r.level, 30, 'level');
      // Every level replays the whole sequence, so a run to level L has a hard minimum length.
      if (elapsedMs + 1000 < level * 700 + 120 * level * (level + 1)) throw invalid('too fast');
      const pts = level <= 5 ? level * 80 : 400 + (level - 5) * 120; // level 10 = 1000
      return { score: clamp(pts, 0, MAX), meta: { level } };
    },
  },
  {
    id: 'pictionary',
    name: 'Emoji Pictionary',
    emoji: '🎭',
    color: '#ec4899',
    tagline: 'Guess the profession from the emojis!',
    duration: '10 puzzles',
    howTo: ['Two emojis describe a profession — 🦷🪥 is a dentist', 'Tap the right one within 8 seconds', 'Correct = 50 points + up to 50 for speed'],
    minMs: 0,
    start: pictionary.start,
    steps: pictionary.steps,
    score: pictionary.score,
  },
  {
    id: 'math',
    name: 'Quick Maths',
    emoji: '🧮',
    color: '#10b981',
    tagline: 'Easy sums — tap the right answer, fast!',
    duration: '30 sec',
    howTo: ['A simple sum appears with four answers', 'Tap the right one (+35) · wrong −15', 'They start easy and grow a little as you go'],
    minMs: 28000,
    score(r) {
      const correct = count(r.correct, 80, 'correct');
      const wrong = count(r.wrong, 80, 'wrong');
      if (correct + wrong > 80) throw invalid('too many answers');
      return { score: clamp(correct * 35 - wrong * 15, 0, MAX), meta: { correct, wrong } };
    },
  },
  {
    id: 'timing',
    name: 'Perfect Timing',
    emoji: '⏱️',
    color: '#f59e0b',
    tagline: 'Stop the clock on exactly 5.00 seconds!',
    duration: '3 rounds',
    howTo: ['Tap to start the clock — it hides after 2 seconds', 'Keep counting in your head and tap again on exactly 5.00', 'The closer you stop it, the more points — 3 rounds'],
    minMs: 3000,
    score(r, { elapsedMs }) {
      if (!Array.isArray(r.times) || r.times.length !== 3) throw invalid('times');
      const times = r.times.map((t) => millis(t, 30000, 'time'));
      if (times.reduce((a, b) => a + b, 0) > elapsedMs + 2000) throw invalid('timing');
      const offs = times.map((t) => Math.abs(t - 5000));
      const pts = offs.reduce((s, o) => s + Math.max(0, 334 - Math.ceil(o / 2)), 0); // 334 a round, −1 per 2ms off
      return { score: clamp(pts, 0, MAX), meta: { avgOffMs: Math.round(offs.reduce((a, b) => a + b, 0) / offs.length), bestOffMs: Math.min(...offs) } };
    },
  },
  {
    id: 'hunt',
    name: 'Number Hunt',
    emoji: '🔢',
    color: '#8b5cf6',
    tagline: 'Find 1 to 20 in order — beat the clock!',
    duration: '60 sec max',
    howTo: ['Numbers 1 to 20 are scattered on the grid', 'Tap them in order, starting from 1', 'Faster = more points · wrong taps cost a little'],
    minMs: 5000,
    score(r, { elapsedMs }) {
      const found = count(r.found, 20, 'found');
      const wrong = count(r.wrong, 200, 'wrong');
      const timeMs = millis(r.timeMs, 65000, 'timeMs');
      if (timeMs > elapsedMs + 2000) throw invalid('timing');
      if (found < 20) return { score: found * 10, meta: { found, wrong, timeMs, completed: false } };
      if (timeMs < 5000) throw invalid('too fast');
      const raw = 1000 - Math.max(0, timeMs / 1000 - 18) * 35 - wrong * 15;
      return { score: clamp(Math.round(raw), 150, MAX), meta: { found, wrong, timeMs, completed: true } };
    },
  },
  {
    id: 'balloons',
    name: 'Balloon Burst',
    emoji: '🎈',
    color: '#f43f5e',
    tagline: 'Pop the balloons before they float away!',
    duration: '30 sec',
    howTo: ['Balloons drift up the screen — pop them with a tap (+20)', 'Golden ⭐ balloons are worth +50', 'No penalties — pop everything you can!'],
    minMs: 28000,
    score(r) {
      const popped = count(r.popped, 70, 'popped');
      const golden = count(r.golden, 15, 'golden');
      return { score: clamp(popped * 20 + golden * 50, 0, MAX), meta: { popped, golden } };
    },
  },
  {
    id: 'bullseye',
    name: 'Bullseye',
    emoji: '🎯',
    color: '#d946ef',
    tagline: 'Stop the slider dead centre!',
    duration: '10 rounds',
    howTo: ['A marker sweeps across the bar — tap to stop it', 'Dead centre = 100 · the gold zone still pays well', 'It sweeps faster every round — 10 rounds'],
    minMs: 8000,
    score(r) {
      if (!Array.isArray(r.offsets) || r.offsets.length !== 10) throw invalid('offsets');
      const offsets = r.offsets.map((o) => count(o, 50, 'offset')); // distance from centre, 0–50
      const pts = offsets.reduce((s, o) => s + (o <= 3 ? 100 : clamp(Math.round(100 - o * 2.5), 0, 95)), 0);
      return { score: clamp(pts, 0, MAX), meta: { bulls: offsets.filter((o) => o <= 3).length, avgOff: Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length) } };
    },
  },
  {
    // Bonus: every player gets one free spin of the wheel when they first arrive. The prize
    // is picked server-side (state.spin) — never started through startAttempt, never a game card.
    id: 'spin',
    name: 'Spin & Win',
    emoji: '🎡',
    color: '#f7c548',
    tagline: 'One free spin — welcome points for everyone!',
    duration: 'one spin',
    howTo: ['Every player gets one spin of the wheel on arrival', 'Whatever it lands on is yours', 'The points count on your solo score'],
    bonus: true,
    // The event's wheel — 250 gifts for 250 guests. Also the default for a fresh database,
    // so a redeploy or reset can never fall back to anything else. Editable live in /admin.
    wedges: ['Digital Planet x25', 'Frameit x5', 'Modicare x20', 'Nandi Oil x10', 'Presto x10', 'DayToday x20', 'Abhekhya Twam x10', 'Yaticorp x10', 'Hangyo x140'],
    minMs: 0,
    score() {
      throw new HttpError(403, 'The welcome spin is credited by the server', 'BONUS');
    },
  },
  {
    // Hosted: the organiser asks questions on the big screen (see state.js askLive); phones
    // can't start it themselves. Points are credited by closeLive, never through finishAttempt.
    id: 'live',
    name: 'Live Quiz',
    emoji: '📺',
    color: '#f97316',
    tagline: 'Hosted on the big screen — answer fast on your phone!',
    duration: 'hosted',
    howTo: ['The organiser puts a question on the big screen', 'Tap your answer on your phone within the time', 'Correct = 50 points + up to 50 for speed'],
    hosted: true,
    minMs: 0,
    score() {
      throw new HttpError(403, 'The Live Quiz is scored by the host', 'HOSTED');
    },
  },
];

const GAME_MAP = Object.fromEntries(GAMES.map((g) => [g.id, g]));

const publicGames = () =>
  GAMES.map(({ id, name, emoji, color, tagline, duration, howTo, hosted, steps, bonus, wedges, social }) => ({
    id, name, emoji, color, tagline, duration, howTo,
    hosted: Boolean(hosted), stepped: Boolean(steps), bonus: Boolean(bonus), social: Boolean(social), wedges: wedges || null, maxScore: MAX,
  }));

module.exports = { GAMES, GAME_MAP, publicGames, quizRuntime, MAX };
