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
    id: 'odd',
    name: 'Odd One Out',
    emoji: '🔍',
    color: '#84cc16',
    tagline: 'One emoji is different — spot it!',
    duration: '30 sec',
    howTo: ['A grid of look-alike emojis — one is different', 'Tap the odd one out (+35)', 'Wrong taps cost 15 · the grids get bigger and sneakier'],
    minMs: 28000,
    score(r) {
      // 29 right already scores 1000; the cap only rules out machine-speed tapping.
      const correct = count(r.correct, 100, 'correct');
      const wrong = count(r.wrong, 100, 'wrong');
      if (correct + wrong > 100) throw invalid('too many answers');
      return { score: clamp(correct * 35 - wrong * 15, 0, MAX), meta: { correct, wrong } };
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
  GAMES.map(({ id, name, emoji, color, tagline, duration, howTo, hosted, steps }) => ({ id, name, emoji, color, tagline, duration, howTo, hosted: Boolean(hosted), stepped: Boolean(steps), maxScore: MAX }));

module.exports = { GAMES, GAME_MAP, publicGames, quizRuntime, MAX };
