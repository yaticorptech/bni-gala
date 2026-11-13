/**
 * All event state lives in memory (fast, and plenty for a few hundred players) and is
 * persisted through the store. Emits:
 *   'change'   – scores/players/teams changed → realtime layer re-broadcasts the leaderboard
 *   'settings' – public settings changed
 *   'activity' – a game was finished (for the big-screen feed)
 *   'reveal'   – admin started the grand reveal
 *   'reset'    – event wiped
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const { GAMES, GAME_MAP, publicGames, quizRuntime, MAX } = require('./games');
const { HttpError, id, token, clean, csvCell, shuffle } = require('./util');

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
const SCREEN_TOP = 10;
const LIVE_TOP = 5;
const REVEAL_SIZES = [3, 5, 10, 15];
const LIVE_STALE_MS = 60000; // a game in progress that has gone quiet this long (phones re-send every 15 s) drops off the board
const INTRO_MS = 18000; // how long the big screen shows a game's intro + live demo before the game unlocks

// Player-created teams: whoever creates one gets the next colour/emoji from these.
const TEAM_COLORS = ['#e3263a', '#3b82f6', '#22c55e', '#f7c548', '#a855f7', '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f43f5e', '#8b5cf6'];
const TEAM_EMOJIS = ['🦁', '🐯', '🚀', '⚡', '🔥', '🏆', '💎', '🦄', '🐺', '🦅', '🐉', '🌟'];
const MAX_TEAMS = 200;

// Team Tap Battle: the player-made teams battle in rounds of frantic tapping.
const TAP_COUNTDOWN_MS = 3500; // 3-2-1-GO on every phone before taps count
const TAP_DURATIONS = [15000, 30000, 45000, 60000];
const TAP_MAX_PER_SEC = 15; // two thumbs manage ~12/s; anything faster is an auto-clicker
const TAP_TICK_MS = 200; // live update rate while a round runs

// Live Quiz: the host asks a question on the big screen, everyone answers on their phone.
const LIVE_LIMITS = [10000, 15000, 20000, 30000];
const LIVE_GRACE_MS = 1500; // network allowance after the timer hits zero

// Avatars players can pick for the big screen.
const EMOJIS = ['🦁', '🐯', '🦊', '🐼', '🐨', '🦄', '🐸', '🐙', '🦋', '🌟', '🔥', '⚡', '🚀', '🎯', '🏆', '💎', '🍕', '☕', '🎸', '🎲', '🧠', '💼', '🤝', '😎'];
const validEmoji = (e) => (EMOJIS.includes(e) ? e : '');

const DEFAULT_TEAM_GAMES = ['frenzy', 'rush', 'colors', 'odd'];

const defaultSettings = () => ({
  eventTitle: config.defaultTitle,
  tagline: 'Play solo · Play for your team · Win the night!',
  playOpen: true,
  screenMode: 'live', // live | hidden | reveal
  revealCount: 10,
  attemptsPerGame: 3, // 0 = unlimited; every try adds to the total
  teamAttemptsPerGame: 2, // tries per member per team game (0 = unlimited)
  maxTeamSize: 5,
  enabledGames: GAMES.map((g) => g.id),
  teamGames: [...DEFAULT_TEAM_GAMES], // games that can be played "for the team"
  spinWedges: GAME_MAP.spin.wedges.map(normWedge), // welcome-spin prizes { label, stock } — stock null = unlimited
  networkOpen: true, // Power Connections runs only while this is on (the admin's Start/Stop buttons)
  chapters: [], // join-form dropdown — players must pick one; empty list pauses registration
  teamScores: {}, // teamId → taps across all Tap Battle rounds
  teamRounds: [], // finished rounds [{ no, at, durationMs, taps: {teamId: n}, ranking, tie, tappers }]
  knownGames: GAMES.map((g) => g.id), // so games added later can be switched on automatically
  liveQuiz: [], // host's questions [{ q, options, answer (null = vote), askedAt }]
  liveAsked: [], // indexes of questions asked so far, in order
  luckyDraws: [], // [{ no, playerId, name, emoji, at }]
  reveal: null, // { at, entries } snapshot taken when the reveal starts
});

const publicPlayer = ({ id, name, emoji, business, chapter, teamId }) => ({ id, name, emoji: emoji || '', business, chapter, teamId: teamId || null });

/** A spin prize however it was written: "Mug x25" (25 in stock), "Mug" or 250 (unlimited). */
const normWedge = (w) => {
  if (w && typeof w === 'object') {
    return { label: clean(String(w.label ?? ''), 14), stock: Number.isInteger(w.stock) && w.stock > 0 ? Math.min(9999, w.stock) : null };
  }
  const s = clean(String(w ?? ''), 24);
  const m = s.match(/^(.*?)\s*[x×*]\s*(\d{1,4})$/i);
  return m ? { label: clean(m[1], 14), stock: Math.max(1, Number(m[2])) } : { label: clean(s, 14), stock: null };
};
const publicRow = ({ rank, id, name, emoji, business, chapter, total, scores, live, connections }) => ({ rank, id, name, emoji: emoji || '', business, chapter, total, scores, live: live || null, connections: connections || 0 });
const publicTeam = ({ id, name, emoji, color, chapter }) => ({ id, name, emoji, color, chapter: chapter || '' });

/** A 10-digit Indian mobile number however it was typed (+91, spaces, dashes, a leading 0), else null. */
function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/**
 * Parse the host's live-quiz questions: blocks separated by a blank line, first line the
 * question, then 2–6 options (bullets or A) B) letters optional), the correct one marked
 * with a trailing *. A block with no * is a vote ("Who's most likely to…"):
 *
 *   What is BNI's core philosophy?
 *   - Givers Gain *
 *   - Winner takes all
 */
function parseLiveQuiz(text) {
  const questions = [];
  const skipped = [];
  const blocks = String(text ?? '').split(/\n\s*\n/).map((b) => b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  blocks.forEach((lines, i) => {
    const skip = (reason) => skipped.push({ block: i + 1, text: lines[0].slice(0, 60), reason });
    const q = clean(lines[0].replace(/^(?:Q\s*\d*\s*[.:)]|\d+\s*[.)])\s*/i, ''), 200);
    const options = [];
    let answer = -1;
    for (let line of lines.slice(1)) {
      line = line.replace(/^(?:[-•]|[A-Fa-f]\s*[.):]|\d+\s*[.)])\s*/, '');
      let correct = false;
      if (/^\*\s*/.test(line)) { correct = true; line = line.replace(/^\*\s*/, ''); }
      if (/\s*(?:\*|✓|\(correct\))\s*$/i.test(line)) { correct = true; line = line.replace(/\s*(?:\*|✓|\(correct\))\s*$/i, ''); }
      const opt = clean(line, 80);
      if (!opt) continue;
      if (correct) answer = options.length;
      options.push(opt);
    }
    if (!q || options.length < 2) return skip('needs a question line and at least 2 options');
    if (options.length > 6) return skip('more than 6 options');
    questions.push({ q, options, answer: answer < 0 ? null : answer }); // no * → a vote: no right answer, no points
  });
  return { questions, skipped };
}

class GameState extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.settings = defaultSettings();
    this.players = new Map();
    this.byToken = new Map();
    this.teams = new Map(); // teamId → { id, code, name, emoji, color, chapter, captainId, createdAt }
    this.attempts = new Map();
    this.runtimes = new Map(); // attemptId → in-memory game state (quiz questions etc.)
    this.recent = []; // last activity items for a freshly loaded big screen
    this.cache = null;
    this.pending = new Set(); // store writes still in flight (see flush)
    this.liveScores = new Map(); // attemptId → { playerId, teamId, gameId, score, at }: running scores of games in progress
    this.cacheConfirmed = null;
    this.cacheTeams = null;
    this.round = null; // Team Tap Battle round in progress (in memory only; see startRound)
    this.roundTimers = [];
    this.live = null; // Live Quiz question on the big screen right now (see askLive)
    this.liveTimers = [];
    store.attach(() => this.snapshot());
    setInterval(() => this.sweep(), 60 * 1000).unref();
    setInterval(() => this.sweepLive(), 5 * 1000).unref();
  }

  async load() {
    const data = await this.store.load();
    if (!data) return;
    this.settings = { ...defaultSettings(), ...(data.settings || {}) };
    const s = this.settings;
    s.enabledGames = s.enabledGames.filter((g) => GAME_MAP[g]);
    // Hosted moments, bonuses and the networking game are always on — a stale admin tab
    // saving its toggle list must never strand them.
    for (const g of GAMES) {
      if ((g.hosted || g.bonus || g.social) && !s.enabledGames.includes(g.id)) s.enabledGames.push(g.id);
    }
    s.teamGames = (Array.isArray(s.teamGames) ? s.teamGames : [...DEFAULT_TEAM_GAMES]).filter((g) => GAME_MAP[g] && !GAME_MAP[g].hosted && !GAME_MAP[g].bonus && !GAME_MAP[g].social);
    if (s.screenMode === 'reveal' && !s.reveal) s.screenMode = 'hidden';
    if (!['live', 'hidden', 'reveal'].includes(s.screenMode)) s.screenMode = 'live';
    s.chapters = (Array.isArray(s.chapters) ? s.chapters : []).map((c) => clean(c, 40)).filter(Boolean);
    s.teamScores = s.teamScores && typeof s.teamScores === 'object' ? s.teamScores : {};
    s.teamRounds = Array.isArray(s.teamRounds) ? s.teamRounds : [];
    if (!Number.isInteger(s.maxTeamSize) || s.maxTeamSize < 2 || s.maxTeamSize > 50) s.maxTeamSize = 5;
    if (!Number.isInteger(s.teamAttemptsPerGame) || s.teamAttemptsPerGame < 0 || s.teamAttemptsPerGame > 50) s.teamAttemptsPerGame = 2;
    s.liveQuiz = (Array.isArray(s.liveQuiz) ? s.liveQuiz : []).filter((q) => q && typeof q.q === 'string' && Array.isArray(q.options) && (Number.isInteger(q.answer) || q.answer === null));
    s.spinWedges = defaultSettings().spinWedges; // locked to the list in server/games.js, whatever an old database says
    // Games added in an update start enabled, without undoing games the admin switched off.
    const saved = data.settings || {};
    const known = new Set(Array.isArray(saved.knownGames) ? saved.knownGames : GAMES.map((g) => g.id));
    let added = false;
    for (const g of GAMES) {
      if (known.has(g.id)) continue;
      known.add(g.id);
      if (!s.enabledGames.includes(g.id)) s.enabledGames.push(g.id);
      added = true;
    }
    s.knownGames = [...known];
    if (added) this.persist('saveSettings', s);
    s.liveAsked = (Array.isArray(s.liveAsked) ? s.liveAsked : []).filter((i) => Number.isInteger(i) && s.liveQuiz[i]);
    s.luckyDraws = Array.isArray(s.luckyDraws) ? s.luckyDraws : [];
    for (const t of data.teams || []) {
      if (t && t.id && t.name && t.code) this.teams.set(t.id, t);
    }
    for (const p of data.players || []) {
      p.emoji = validEmoji(p.emoji);
      if (p.teamId && !this.teams.has(p.teamId)) p.teamId = null; // team since deleted
      this.players.set(p.id, p);
      this.byToken.set(p.token, p);
    }
    for (const a of data.attempts || []) if (this.players.has(a.playerId)) this.attempts.set(a.id, a);
    // Players from before Power Connections get their personal QR code now.
    for (const p of this.players.values()) {
      if (!p.connectCode) {
        p.connectCode = this.uniqueConnectCode();
        this.persist('savePlayer', p);
      }
    }
  }

  snapshot() {
    return { version: 2, settings: this.settings, players: [...this.players.values()], teams: [...this.teams.values()], attempts: [...this.attempts.values()] };
  }

  persist(op, ...args) {
    const p = Promise.resolve()
      .then(() => this.store[op](...args))
      .catch((err) => console.error(`[store] ${op} failed:`, err.message))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves once every write issued so far has landed — used at shutdown. */
  flush() {
    return Promise.allSettled([...this.pending]);
  }

  changed() {
    this.cache = null;
    this.cacheConfirmed = null;
    this.cacheTeams = null;
    this.emit('change');
  }

  /** Drop in-memory runtimes of abandoned games. */
  sweep() {
    const cutoff = Date.now() - ATTEMPT_TTL_MS;
    for (const attemptId of this.runtimes.keys()) {
      const a = this.attempts.get(attemptId);
      if (!a || a.startedAt < cutoff) this.runtimes.delete(attemptId);
    }
  }

  /** Drop running scores that went quiet (phone died or was pocketed mid-game), so the row stops showing "playing". */
  sweepLive() {
    const stale = Date.now() - LIVE_STALE_MS;
    let dropped = false;
    for (const [attemptId, l] of this.liveScores) {
      if (l.at < stale || !this.attempts.has(attemptId)) {
        this.liveScores.delete(attemptId);
        dropped = true;
      }
    }
    if (dropped) this.changed();
  }

  // ------------------------------------------------------------- settings

  publicSettings() {
    const { eventTitle, tagline, playOpen, screenMode, attemptsPerGame, teamAttemptsPerGame, maxTeamSize, enabledGames, teamGames, chapters, spinWedges, networkOpen } = this.settings;
    return { eventTitle, tagline, playOpen, screenMode, attemptsPerGame, teamAttemptsPerGame, maxTeamSize, enabledGames, teamGames, chapters, spinWedges: spinWedges.map((w) => w.label), networkOpen: networkOpen !== false, emojis: EMOJIS };
  }

  /** The static game list, with the admin-set spin wheel patched in. */
  gamesPayload() {
    return publicGames().map((g) => (g.id === 'spin' ? { ...g, wedges: this.settings.spinWedges.map((w) => w.label) } : g));
  }

  /** Ranks are secret while the board is hidden or being revealed — the team battle view is not a secret. */
  get hidden() {
    return this.settings.screenMode === 'hidden' || this.settings.screenMode === 'reveal';
  }

  updateSettings(patch = {}) {
    const s = this.settings;
    if ('eventTitle' in patch) s.eventTitle = clean(patch.eventTitle, 80) || s.eventTitle;
    if ('tagline' in patch) s.tagline = clean(patch.tagline, 100);
    if ('playOpen' in patch) s.playOpen = Boolean(patch.playOpen);
    if ('attemptsPerGame' in patch) {
      const n = Number(patch.attemptsPerGame);
      if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpError(400, 'Attempts must be 0 (unlimited) to 50');
      s.attemptsPerGame = n;
    }
    if ('teamAttemptsPerGame' in patch) {
      const n = Number(patch.teamAttemptsPerGame);
      if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpError(400, 'Team tries must be 0 (unlimited) to 50');
      s.teamAttemptsPerGame = n;
    }
    if ('maxTeamSize' in patch) {
      const n = Number(patch.maxTeamSize);
      if (!Number.isInteger(n) || n < 2 || n > 50) throw new HttpError(400, 'Team size must be 2 to 50');
      s.maxTeamSize = n;
    }
    if ('enabledGames' in patch) {
      if (!Array.isArray(patch.enabledGames)) throw new HttpError(400, 'enabledGames must be a list');
      // Hosted games (Live Quiz), bonuses (the welcome spin) and the networking game aren't
      // on the switch list and stay on.
      s.enabledGames = GAMES.filter((g) => g.hosted || g.bonus || g.social || patch.enabledGames.includes(g.id)).map((g) => g.id);
    }
    if ('teamGames' in patch) {
      if (!Array.isArray(patch.teamGames)) throw new HttpError(400, 'teamGames must be a list');
      s.teamGames = GAMES.filter((g) => !g.hosted && !g.bonus && !g.social && patch.teamGames.includes(g.id)).map((g) => g.id);
    }
    if ('chapters' in patch) {
      if (!Array.isArray(patch.chapters)) throw new HttpError(400, 'chapters must be a list');
      s.chapters = [...new Set(patch.chapters.map((c) => clean(c, 40)).filter(Boolean))].slice(0, 100);
    }
    if ('screenMode' in patch) {
      if (!['live', 'hidden'].includes(patch.screenMode)) throw new HttpError(400, 'Screen mode must be live or hidden');
      s.screenMode = patch.screenMode;
    }
    if ('networkOpen' in patch) s.networkOpen = Boolean(patch.networkOpen);
    if ('spinWedges' in patch) {
      // The event's gift wheel is LOCKED: it lives in server/games.js and nothing at runtime
      // — not even the admin — can change it. Guarantees the 250 physical gifts stay honest.
      throw new HttpError(400, 'The gift wheel is locked for this event — it can only be changed in the code');
    }
    this.persist('saveSettings', s);
    this.emit('settings', this.publicSettings());
    this.changed();
    return s;
  }

  startReveal(count) {
    const n = REVEAL_SIZES.includes(Number(count)) ? Number(count) : 10;
    const board = this.board(false); // confirmed scores only — nothing provisional in the reveal
    if (!board.ranked.length) throw new HttpError(400, 'Nobody has scored yet — nothing to reveal');
    Object.assign(this.settings, {
      screenMode: 'reveal',
      revealCount: n,
      reveal: { at: Date.now(), entries: board.ranked.slice(0, n).map(publicRow) },
    });
    this.persist('saveSettings', this.settings);
    this.emit('reveal', this.settings.reveal);
    this.emit('settings', this.publicSettings());
    this.changed();
    return this.settings.reveal;
  }

  // ------------------------------------------------------------- players

  playerByToken(t) {
    return (t && this.byToken.get(t)) || null;
  }

  playerByPhone(phone) {
    for (const p of this.players.values()) if (p.phone === phone) return p;
    return null;
  }

  /**
   * One endpoint for both doors. The mobile number is the identity: a known number logs
   * straight in (any device, cleared browser — scores carry on); a new number registers
   * with a name and a chapter. `loginOnly` lets the login form say "not registered yet"
   * instead of silently creating someone.
   */
  join(body = {}) {
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Please enter your 10-digit mobile number');
    const emoji = validEmoji(body.emoji);
    const existing = this.playerByPhone(phone);
    if (existing) {
      if (emoji && existing.emoji !== emoji) {
        existing.emoji = emoji;
        this.persist('savePlayer', existing);
        this.changed();
      }
      return existing;
    }
    if (body.loginOnly) throw new HttpError(404, 'This number isn’t registered yet — sign up first', 'NOT_REGISTERED');
    const name = clean(body.name, 40);
    if (name.length < 2) throw new HttpError(400, 'Please enter your name');
    const chapter = clean(body.chapter, 40);
    if (!this.settings.chapters.length) throw new HttpError(400, 'Registration isn’t open yet — the organiser hasn’t added the chapter list');
    if (!this.settings.chapters.includes(chapter)) throw new HttpError(400, 'Please pick your chapter from the list');
    return this.addPlayer({ name, business: clean(body.business, 60), chapter, phone, emoji });
  }

  setEmoji(player, emoji) {
    player.emoji = validEmoji(emoji);
    this.persist('savePlayer', player);
    this.changed(); // the board shows avatars
  }

  addPlayer({ name, business, chapter, phone = '', emoji = '' }) {
    const p = { id: id(), token: token(), name, emoji, business, chapter, phone, teamId: null, connectCode: this.uniqueConnectCode(), createdAt: Date.now() };
    this.players.set(p.id, p);
    this.byToken.set(p.token, p);
    this.persist('savePlayer', p);
    this.changed();
    return p;
  }

  deletePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) throw new HttpError(404, 'Player not found');
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    for (const [aid, a] of this.attempts) {
      if (a.playerId === p.id) {
        this.attempts.delete(aid);
        this.runtimes.delete(aid);
        this.liveScores.delete(aid);
      }
    }
    this.recent = this.recent.filter((r) => r.playerId !== p.id);
    if (p.teamId) this.afterMemberLeft(p.teamId, p.id);
    this.persist('deletePlayer', p.id);
    this.changed();
  }

  /**
   * Fresh scoreboard, same people and teams: every score, team round, lucky-draw winner and
   * quiz progress goes; players stay logged in. For after a rehearsal.
   */
  resetScores() {
    this.attempts.clear();
    this.runtimes.clear();
    this.liveScores.clear();
    this.recent = [];
    Object.assign(this.settings, { screenMode: 'live', reveal: null, playOpen: true, teamScores: {}, teamRounds: [], liveAsked: [], luckyDraws: [] });
    for (const q of this.settings.liveQuiz) delete q.askedAt;
    this.endRoundTimers();
    this.round = null;
    this.emit('round', this.roundPayload());
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
    this.persist('resetAttempts');
    this.persist('saveSettings', this.settings);
    this.emit('scoresReset');
    this.emit('settings', this.publicSettings());
    this.changed();
  }

  /** Wipe the event: players and teams too. Settings and quiz questions stay. */
  reset() {
    this.players.clear();
    this.byToken.clear();
    this.teams.clear();
    this.attempts.clear();
    this.runtimes.clear();
    this.liveScores.clear();
    this.recent = [];
    Object.assign(this.settings, { screenMode: 'live', reveal: null, playOpen: true, teamScores: {}, teamRounds: [], liveAsked: [], luckyDraws: [] });
    for (const q of this.settings.liveQuiz) delete q.askedAt; // keep the questions, let them be asked again
    this.endRoundTimers();
    this.round = null;
    this.emit('round', this.roundPayload());
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
    this.persist('reset');
    this.persist('saveSettings', this.settings);
    this.emit('reset');
    this.emit('settings', this.publicSettings());
    this.changed();
  }

  /** Tries used per game, counted separately for solo play and team play. */
  usedAttempts(playerId, team = false) {
    const used = Object.fromEntries(GAMES.map((g) => [g.id, 0]));
    for (const a of this.attempts.values()) {
      if (a.playerId === playerId && Boolean(a.teamId) === team) used[a.gameId]++;
    }
    return used;
  }

  attemptsLeft(used, team = false) {
    const limit = team ? this.settings.teamAttemptsPerGame : this.settings.attemptsPerGame;
    return limit > 0 ? Math.max(0, limit - used) : null;
  }

  /** A player's best single finished try in a game (per mode), or null. */
  bestScore(playerId, gameId, team = false) {
    let best = null;
    for (const a of this.attempts.values()) {
      if (a.playerId === playerId && a.gameId === gameId && Boolean(a.teamId) === team && a.score != null && (best == null || a.score > best)) best = a.score;
    }
    return best;
  }

  me(player) {
    const row = this.board().rankById.get(player.id);
    const used = this.usedAttempts(player.id);
    const games = {};
    for (const g of GAMES) {
      games[g.id] = { points: row?.scores[g.id] ?? null, best: this.bestScore(player.id, g.id), used: used[g.id], left: this.attemptsLeft(used[g.id]) };
    }
    const spun = this.spinAttempt(player.id);
    const connections = this.networkAttempt(player.id)?.meta.met.length ?? 0; // a count, never points
    return { player: publicPlayer(player), games, connections, spin: { spun: Boolean(spun), prize: spun ? spun.meta?.label ?? spun.score : null }, teamDetail: this.teamDetail(player), ...this.livePayload(player.id) };
  }

  // ------------------------------------------------------------- power connections (networking)

  /** A short, typeable personal code (the QR holds it too). The alphabet has no confusable letters. */
  uniqueConnectCode() {
    let c = id(6);
    while (this.playerByConnectCode(c)) c = id(6);
    return c;
  }

  playerByConnectCode(code) {
    const c = clean(code, 20).toLowerCase();
    if (!c) return null;
    for (const p of this.players.values()) if (p.connectCode === c) return p;
    return null;
  }

  /** The player's one accumulating 'network' attempt; meta.met = ids of members already connected. */
  networkAttempt(playerId, create = false) {
    for (const a of this.attempts.values()) {
      if (a.playerId === playerId && a.gameId === 'network' && !a.teamId) {
        if (!a.meta || !Array.isArray(a.meta.met)) a.meta = { met: [] };
        return a;
      }
    }
    if (!create) return null;
    const now = Date.now();
    const a = { id: id(12), playerId, gameId: 'network', teamId: null, startedAt: now, finishedAt: now, score: 0, meta: { met: [] }, pb: false };
    this.attempts.set(a.id, a);
    return a;
  }

  /** What the networking view shows: my code and the members I've met — a count, not points. */
  connections(player) {
    const att = this.networkAttempt(player.id);
    const met = (att?.meta.met || [])
      .map((pid) => this.players.get(pid))
      .filter(Boolean)
      .map(({ name, emoji, business, chapter }) => ({ name, emoji: emoji || '', business, chapter }));
    return { code: player.connectCode, met };
  }

  connect(player, rawCode) {
    if (!this.settings.playOpen || !this.settings.enabledGames.includes('network')) {
      throw new HttpError(403, 'This game is closed right now', 'CLOSED');
    }
    if (!this.settings.networkOpen) {
      throw new HttpError(403, '🔗 Power Connections hasn’t started — watch for the announcement!', 'CLOSED');
    }
    const other = this.playerByConnectCode(rawCode);
    if (!other) throw new HttpError(404, 'No member found for that code — check it and try again');
    if (other.id === player.id) throw new HttpError(400, 'That’s your own code — go meet another member! 😄', 'SELF');
    // No points — networking is a COUNT. The pair connects once, ever, and it counts for both.
    const mine = this.networkAttempt(player.id, true);
    if (mine.meta.met.includes(other.id)) {
      return { already: true, met: mine.meta.met.length, other: publicPlayer(other) };
    }
    const theirs = this.networkAttempt(other.id, true);
    const now = Date.now();
    mine.meta.met.push(other.id);
    mine.finishedAt = now;
    if (!theirs.meta.met.includes(player.id)) {
      theirs.meta.met.push(player.id);
      theirs.finishedAt = now;
    }
    this.persist('saveAttempt', mine);
    this.persist('saveAttempt', theirs);
    this.changed();
    const item = { playerId: player.id, name: player.name, gameId: 'network', with: other.name, count: mine.meta.met.length, at: now };
    this.recent.unshift(item);
    this.recent.length = Math.min(this.recent.length, 12);
    this.emit('activity', item);
    return { already: false, met: mine.meta.met.length, other: publicPlayer(other) };
  }

  // ------------------------------------------------------------- welcome spin

  /** The player's one welcome-spin attempt, if they've had it (per scoreboard — a score reset gives it back). */
  spinAttempt(playerId) {
    for (const a of this.attempts.values()) if (a.playerId === playerId && a.gameId === 'spin') return a;
    return null;
  }

  /**
   * Spin & Win: one guaranteed prize per player, picked here with crypto randomness — the
   * phone only animates the wheel to the wedge the server names. Idempotent: spinning again
   * returns the original prize.
   */
  /** How many of each spin prize have been won so far (by label). */
  spinWon() {
    const won = {};
    for (const a of this.attempts.values()) {
      if (a.gameId !== 'spin') continue;
      const label = a.meta?.label ?? String(a.score);
      won[label] = (won[label] || 0) + 1;
    }
    return won;
  }

  spin(player) {
    const wedges = this.settings.spinWedges;
    const labels = wedges.map((w) => w.label);
    const prev = this.spinAttempt(player.id);
    if (prev) {
      // the wheel may have been reconfigured since — land on the wedge that still shows their prize
      const label = prev.meta?.label ?? String(prev.score);
      let index = prev.meta?.index ?? 0;
      if (labels[index] !== label) index = Math.max(0, labels.indexOf(label));
      return { already: true, prize: label, index, wedges: labels };
    }
    // The draw is weighted by REMAINING stock, like pulling a random gift from the pile: a
    // "x5" gift can never be won a sixth time, and the big pile carries the odds. Unlimited
    // wedges (plain points) weigh in at the stocked wedges' average so they stay in play.
    const won = this.spinWon();
    const left = wedges.map((w) => (w.stock == null ? null : Math.max(0, w.stock - (won[w.label] || 0))));
    const stocked = left.filter((l) => l != null);
    let index;
    if (!stocked.length) {
      index = crypto.randomInt(wedges.length); // a pure points wheel: every wedge is equally likely
    } else {
      const mean = Math.max(1, Math.round(stocked.reduce((a, b) => a + b, 0) / stocked.length));
      const weights = left.map((l) => (l == null ? mean : l));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) {
        // Every stocked gift is handed out and there are no points wedges: land on the wedge
        // that had the deepest pile — the least painful place to be one gift over.
        index = wedges.reduce((best, w, i) => ((w.stock || 0) > (wedges[best].stock || 0) ? i : best), 0);
      } else {
        let r = crypto.randomInt(total);
        index = weights.findIndex((w) => (r -= w) < 0);
      }
    }
    const prize = labels[index];
    const points = /^\d+$/.test(prize) ? Math.min(MAX, Number(prize)) : 0; // a number is points; anything else is a gift
    const now = Date.now();
    const a = { id: id(12), playerId: player.id, gameId: 'spin', teamId: null, startedAt: now, finishedAt: now, score: points, meta: { index, label: prize }, pb: true };
    this.attempts.set(a.id, a);
    this.persist('saveAttempt', a);
    this.changed();
    const item = { playerId: player.id, name: player.name, gameId: 'spin', score: points, prize, improved: false, at: now };
    this.recent.unshift(item);
    this.recent.length = Math.min(this.recent.length, 12);
    this.emit('activity', item);
    return { already: false, prize, points, index, wedges: labels };
  }

  /** The full team view for its member: join code, member list, per-game team points and tries. */
  teamDetail(player) {
    const team = this.teamOf(player);
    if (!team) return null;
    const row = this.teamBoard().rankById.get(team.id);
    const tUsed = this.usedAttempts(player.id, true);
    const games = {};
    for (const gid of this.settings.teamGames) {
      if (!GAME_MAP[gid]) continue;
      games[gid] = { points: row?.scores[gid] ?? null, myBest: this.bestScore(player.id, gid, true), used: tUsed[gid], left: this.attemptsLeft(tUsed[gid], true) };
    }
    return {
      ...publicTeam(team),
      code: team.code,
      isCaptain: team.captainId === player.id,
      members: this.teamMembers(team.id).map(publicPlayer),
      total: row?.total ?? 0,
      rank: row?.rank ?? null,
      teams: this.teams.size,
      plays: row?.plays ?? 0,
      games,
    };
  }

  /** The small per-player live update pushed to phones. */
  livePayload(playerId) {
    const board = this.board();
    const row = board.rankById.get(playerId);
    const player = this.players.get(playerId);
    const team = this.teamOf(player);
    let teamBrief = null;
    if (team) {
      const t = this.teamBoard().rankById.get(team.id);
      teamBrief = { ...publicTeam(team), members: t?.members ?? 0, total: t?.total ?? 0, rank: t?.rank ?? null, teams: this.teams.size };
    }
    return {
      total: row?.total ?? 0,
      rank: this.hidden ? null : row?.rank ?? null,
      ranked: board.ranked.length,
      hidden: this.hidden,
      top: this.hidden ? [] : board.ranked.slice(0, LIVE_TOP).map(publicRow),
      team: teamBrief,
      // The player one place above — phones use it for "Priya just overtook you" nudges.
      above: !this.hidden && row && row.rank > 1 ? (({ name, emoji, total }) => ({ name, emoji, total }))(board.ranked[row.rank - 2]) : null,
    };
  }

  // ------------------------------------------------------------- teams (player-created)

  teamOf(player) {
    return (player && player.teamId && this.teams.get(player.teamId)) || null;
  }

  teamMembers(teamId) {
    return [...this.players.values()].filter((p) => p.teamId === teamId).sort((a, b) => a.createdAt - b.createdAt);
  }

  teamSizes() {
    const sizes = Object.fromEntries([...this.teams.keys()].map((id) => [id, 0]));
    for (const p of this.players.values()) if (p.teamId in sizes) sizes[p.teamId]++;
    return sizes;
  }

  teamByCode(code) {
    const c = clean(code, 10).toLowerCase();
    if (!c) return null;
    for (const t of this.teams.values()) if (t.code === c) return t;
    return null;
  }

  createTeam(player, body = {}) {
    if (this.teamOf(player)) throw new HttpError(409, 'You’re already in a team — leave it first', 'IN_TEAM');
    if (this.teams.size >= MAX_TEAMS) throw new HttpError(503, 'Team limit reached — ask the organiser');
    const name = clean(body.name, 30);
    if (name.length < 3) throw new HttpError(400, 'Give your team a name (at least 3 letters)');
    for (const t of this.teams.values()) {
      if (t.name.toLowerCase() === name.toLowerCase()) throw new HttpError(409, 'A team with that name already exists — pick another');
    }
    let code = id(5);
    while (this.teamByCode(code)) code = id(5);
    const n = this.teams.size;
    const team = {
      id: id(),
      code,
      name,
      emoji: TEAM_EMOJIS[n % TEAM_EMOJIS.length],
      color: TEAM_COLORS[n % TEAM_COLORS.length],
      chapter: player.chapter || '',
      captainId: player.id,
      createdAt: Date.now(),
    };
    this.teams.set(team.id, team);
    player.teamId = team.id;
    this.persist('saveTeam', team);
    this.persist('savePlayer', player);
    this.changed();
    return team;
  }

  joinTeam(player, code) {
    const team = this.teamByCode(code);
    if (!team) throw new HttpError(404, 'No team found with that code — check it with your captain');
    if (player.teamId === team.id) return team; // already in: idempotent
    if (this.teamOf(player)) throw new HttpError(409, 'You’re already in a team — leave it first', 'IN_TEAM');
    const size = this.teamMembers(team.id).length;
    if (size >= this.settings.maxTeamSize) throw new HttpError(403, `Team ${team.name} is full (max ${this.settings.maxTeamSize})`, 'TEAM_FULL');
    player.teamId = team.id;
    this.persist('savePlayer', player);
    this.changed();
    return team;
  }

  leaveTeam(player) {
    const team = this.teamOf(player);
    if (!team) throw new HttpError(400, 'You’re not in a team');
    if (this.roundActive()) throw new HttpError(409, 'A Tap Battle round is running — leave after it ends');
    player.teamId = null;
    this.persist('savePlayer', player);
    this.afterMemberLeft(team.id, player.id);
    this.changed();
    return team;
  }

  /** An empty team dissolves; otherwise the captaincy passes to the longest-standing member. */
  afterMemberLeft(teamId, leftPlayerId) {
    const team = this.teams.get(teamId);
    if (!team) return;
    const members = this.teamMembers(teamId);
    if (!members.length) {
      this.teams.delete(teamId);
      delete this.settings.teamScores[teamId];
      this.persist('deleteTeam', teamId);
      this.persist('saveSettings', this.settings);
      return;
    }
    if (team.captainId === leftPlayerId) {
      team.captainId = members[0].id;
      this.persist('saveTeam', team);
    }
  }

  /** Admin: disband a team. Members stay logged in, just teamless; the team's scores go with it. */
  deleteTeam(teamId) {
    const team = this.teams.get(teamId);
    if (!team) throw new HttpError(404, 'Team not found');
    if (this.roundActive()) throw new HttpError(409, 'A round is running — wait for it to finish');
    for (const p of this.players.values()) {
      if (p.teamId === teamId) {
        p.teamId = null;
        this.persist('savePlayer', p);
      }
    }
    this.teams.delete(teamId);
    delete this.settings.teamScores[teamId];
    this.persist('deleteTeam', teamId);
    this.persist('saveSettings', this.settings);
    this.changed();
  }

  /** Public browse list: every team, points-ranked — codes stay with their members. */
  publicTeams() {
    return this.teamBoard().ranked.map(({ id, name, emoji, color, chapter, members, total, plays, rank }) => ({ id, name, emoji, color, chapter, members, total, plays, rank }));
  }

  /**
   * The team leaderboard for the group games: every finished team try counts toward its
   * team's total (same rule as the individual board, so "get everyone playing" wins).
   */
  teamBoard() {
    if (this.cacheTeams) return this.cacheTeams;
    const finished = [...this.attempts.values()]
      .filter((a) => a.teamId && this.teams.has(a.teamId) && a.score != null && GAME_MAP[a.gameId])
      .sort((a, b) => a.finishedAt - b.finishedAt);
    const rows = new Map();
    const row = (t) => {
      let r = rows.get(t.id);
      if (!r) {
        r = { ...publicTeam(t), total: 0, scores: {}, plays: 0, reachedAt: Number.MAX_SAFE_INTEGER };
        rows.set(t.id, r);
      }
      return r;
    };
    for (const a of finished) {
      const r = row(this.teams.get(a.teamId));
      r.plays++;
      r.total += a.score;
      r.scores[a.gameId] = (r.scores[a.gameId] || 0) + a.score;
      r.reachedAt = a.finishedAt;
    }
    for (const t of this.teams.values()) row(t); // teams yet to score still show, at the bottom
    const sizes = this.teamSizes();
    const ranked = [...rows.values()];
    for (const r of ranked) r.members = sizes[r.id] || 0;
    ranked.sort((x, y) => y.total - x.total || x.reachedAt - y.reachedAt);
    ranked.forEach((r, i) => (r.rank = i + 1));
    this.cacheTeams = { ranked, rankById: new Map(ranked.map((r) => [r.id, r])) };
    return this.cacheTeams;
  }

  // ------------------------------------------------------------- playing

  ownAttempt(player, attemptId) {
    const a = this.attempts.get(attemptId);
    if (!a || a.playerId !== player.id) throw new HttpError(404, 'Game not found');
    return a;
  }

  /** `mode` 'solo' (default) or 'team': a team try is a separate pool of attempts and scores for the team board. */
  startAttempt(player, gameId, mode = 'solo') {
    const game = GAME_MAP[gameId];
    if (!game) throw new HttpError(404, 'Unknown game');
    if (game.hosted) throw new HttpError(403, 'This one is hosted on the big screen — join in when the organiser starts it', 'HOSTED');
    if (game.bonus) throw new HttpError(403, 'This bonus is credited automatically', 'BONUS');
    if (game.social) throw new HttpError(403, 'Connections are scored when you scan a member', 'SOCIAL');
    if (!this.settings.playOpen) throw new HttpError(403, 'Games are closed right now', 'CLOSED');
    const forTeam = mode === 'team';
    let team = null;
    if (forTeam) {
      team = this.teamOf(player);
      if (!team) throw new HttpError(403, 'Join a team first to play the team games', 'NO_TEAM');
      if (!this.settings.teamGames.includes(gameId)) throw new HttpError(403, 'This game isn’t a team game right now', 'CLOSED');
    } else if (!this.settings.enabledGames.includes(gameId)) {
      throw new HttpError(403, 'This game is closed right now', 'CLOSED');
    }
    const used = this.usedAttempts(player.id, forTeam)[gameId];
    const left = this.attemptsLeft(used, forTeam);
    if (left === 0) throw new HttpError(403, forTeam ? 'No team tries left for this game' : 'No tries left for this game', 'NO_ATTEMPTS');

    // Question games avoid puzzles this player has already seen in earlier tries (either mode, finished or abandoned).
    const seen = new Set();
    for (const x of this.attempts.values()) {
      if (x.playerId !== player.id || x.gameId !== gameId) continue;
      for (const q of x.meta?.served || []) seen.add(q);
      const rt = this.runtimes.get(x.id);
      if (rt?.qs) for (const q of rt.qs) seen.add(q.q);
    }
    const { runtime, payload } = game.start ? game.start({ seen }) : {};
    const a = { id: id(12), playerId: player.id, gameId, teamId: team?.id || null, startedAt: Date.now(), finishedAt: null, score: null, meta: null, pb: false };
    this.attempts.set(a.id, a);
    if (runtime) this.runtimes.set(a.id, runtime);
    this.persist('saveAttempt', a);
    return { attemptId: a.id, gameId, mode: forTeam ? 'team' : 'solo', attemptsLeft: left === null ? null : left - 1, payload: payload || null };
  }

  /** One step of a server-run question game (quiz, pictionary): 'next' serves a question, 'answer' grades one. */
  quizStep(player, attemptId, step, body) {
    const a = this.ownAttempt(player, attemptId);
    const game = GAME_MAP[a.gameId];
    if (!game?.steps || a.score != null) throw new HttpError(409, 'This game is already finished');
    const rt = this.runtimes.get(a.id);
    if (!rt) {
      // Server restarted mid-game: give the try back instead of burning it.
      this.attempts.delete(a.id);
      this.persist('deleteAttempt', a.id);
      quizRuntime(rt); // throws "expired"
    }
    return game.steps[step](rt, body);
  }

  finishAttempt(player, attemptId, result) {
    const a = this.ownAttempt(player, attemptId);
    if (a.score != null) return this.summary(player, a); // retry after a dropped response
    const elapsedMs = Date.now() - a.startedAt;
    if (elapsedMs > ATTEMPT_TTL_MS) throw new HttpError(410, 'This game session expired', 'EXPIRED');
    const game = GAME_MAP[a.gameId];
    if (elapsedMs < game.minMs) throw new HttpError(400, 'That finished suspiciously fast', 'BAD_RESULT');
    if (game.start && !this.runtimes.has(a.id)) {
      this.attempts.delete(a.id); // server restarted mid-game: refund the try
      this.persist('deleteAttempt', a.id);
      throw new HttpError(410, 'This game session expired — please start again', 'EXPIRED');
    }

    const { score, meta } = game.score(result && typeof result === 'object' ? result : {}, {
      elapsedMs,
      runtime: this.runtimes.get(a.id),
    });
    const forTeam = Boolean(a.teamId);
    const prevBest = this.bestScore(player.id, a.gameId, forTeam); // best single try so far, for the "new best" badge
    Object.assign(a, { score: Math.round(score), meta, finishedAt: Date.now(), pb: prevBest == null || score > prevBest });
    this.runtimes.delete(a.id);
    this.liveScores.delete(a.id); // the confirmed score takes over from the running one
    this.persist('saveAttempt', a);
    this.changed();

    const team = forTeam ? this.teams.get(a.teamId) : null;
    const item = {
      playerId: player.id,
      name: player.name,
      gameId: a.gameId,
      score: a.score,
      team: team ? { name: team.name, emoji: team.emoji } : null,
      improved: prevBest != null && a.score > prevBest,
      at: a.finishedAt,
    };
    this.recent.unshift(item);
    this.recent.length = Math.min(this.recent.length, 12);
    this.emit('activity', item);
    return this.summary(player, a);
  }

  /**
   * A phone reports the running score of a game in progress. Purely provisional — it moves
   * the big screen while people play; the real score is computed in finishAttempt.
   */
  progress(playerId, attemptId, score) {
    const a = this.attempts.get(attemptId);
    if (!a || a.playerId !== playerId || a.score != null) return;
    if (score === null) {
      // The player quit: take the provisional score off the board straight away.
      if (this.liveScores.delete(attemptId)) this.changed();
      return;
    }
    const game = GAME_MAP[a.gameId];
    const s = Number(score);
    if (!game || game.hosted || !Number.isFinite(s)) return;
    const value = Math.max(0, Math.min(MAX, Math.round(s)));
    const prev = this.liveScores.get(attemptId);
    if (prev && prev.score === value) {
      prev.at = Date.now(); // heartbeat: still playing, nothing new to show
      return;
    }
    this.liveScores.set(attemptId, { playerId, teamId: a.teamId || null, gameId: a.gameId, score: value, at: Date.now() });
    this.changed();
  }

  summary(player, a) {
    const used = this.usedAttempts(player.id, Boolean(a.teamId))[a.gameId];
    if (a.teamId) {
      const team = this.teams.get(a.teamId);
      const row = team && this.teamBoard().rankById.get(team.id);
      return {
        gameId: a.gameId,
        mode: 'team',
        score: a.score,
        meta: a.meta,
        isBest: a.pb,
        team: team ? { name: team.name, emoji: team.emoji, color: team.color } : null,
        gameTotal: row?.scores[a.gameId] ?? a.score, // the team's points in this game, all members' tries added up
        tries: used,
        total: row?.total ?? a.score, // team total
        rank: row?.rank ?? null, // team rank (never hidden — the team race is public)
        ranked: this.teamBoard().ranked.length,
        attemptsLeft: this.attemptsLeft(used, true),
      };
    }
    const row = this.board().rankById.get(player.id);
    return {
      gameId: a.gameId,
      mode: 'solo',
      score: a.score,
      meta: a.meta,
      isBest: a.pb,
      gameTotal: row?.scores[a.gameId] ?? a.score, // this game's tries added up
      tries: used,
      total: row?.total ?? 0,
      rank: this.hidden ? null : row?.rank ?? null,
      ranked: this.board().ranked.length,
      attemptsLeft: this.attemptsLeft(used),
    };
  }

  // ------------------------------------------------------------- team tap battle

  roundActive() {
    return Boolean(this.round && this.round.status !== 'ended');
  }

  roundPayload() {
    const r = this.round;
    const now = Date.now();
    if (!r) return { status: 'idle', serverNow: now };
    return {
      status: r.status,
      no: r.no,
      durationMs: r.durationMs,
      countdownMs: Math.max(0, r.startsAt - now),
      remainingMs: Math.max(0, r.endsAt - now),
      taps: r.taps,
      ranking: r.ranking || null,
      tie: Boolean(r.tie),
      tappers: r.status === 'ended' ? r.byPlayer.size : undefined,
      // Who's battling: phones draw the bars from this (teams are player-made, not in settings).
      teams: [...this.teams.values()].filter((t) => t.id in r.taps).map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
      serverNow: now,
    };
  }

  /** Admin starts a round: a 3½ s countdown on every phone, then `durationMs` of tapping. The big screen shows the battle over the live board. */
  startRound(durationMs) {
    const dur = TAP_DURATIONS.includes(Number(durationMs)) ? Number(durationMs) : 30000;
    if (this.teams.size < 2) throw new HttpError(400, 'Needs at least 2 teams — players create them in the app');
    if (this.roundActive()) throw new HttpError(409, 'A round is already running');
    this.endRoundTimers();
    const now = Date.now();
    this.round = {
      status: 'countdown',
      no: this.settings.teamRounds.length + 1,
      durationMs: dur,
      startsAt: now + TAP_COUNTDOWN_MS,
      endsAt: now + TAP_COUNTDOWN_MS + dur,
      taps: Object.fromEntries([...this.teams.keys()].map((id) => [id, 0])),
      byPlayer: new Map(),
      dirty: false,
    };
    this.changed();
    this.emit('round', this.roundPayload());
    this.roundTimers.push(setTimeout(() => this.roundRunning(), TAP_COUNTDOWN_MS));
    this.roundTimers.push(setTimeout(() => this.finishRound(), TAP_COUNTDOWN_MS + dur));
    this.roundTimers.push(setInterval(() => {
      if (this.round && this.round.dirty) {
        this.round.dirty = false;
        this.emit('round', this.roundPayload());
      }
    }, TAP_TICK_MS));
    return this.roundPayload();
  }

  roundRunning() {
    if (!this.round || this.round.status !== 'countdown') return;
    this.round.status = 'running';
    this.emit('round', this.roundPayload());
  }

  endRoundTimers() {
    for (const t of this.roundTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.roundTimers = [];
  }

  finishRound() {
    const r = this.round;
    if (!r || r.status === 'ended') return;
    this.endRoundTimers();
    r.status = 'ended';
    r.ranking = Object.keys(r.taps).sort((a, b) => r.taps[b] - r.taps[a]);
    r.tie = r.ranking.length > 1 && r.taps[r.ranking[0]] === r.taps[r.ranking[1]];
    for (const [teamId, n] of Object.entries(r.taps)) this.settings.teamScores[teamId] = (this.settings.teamScores[teamId] || 0) + n;
    this.settings.teamRounds.push({ no: r.no, at: Date.now(), durationMs: r.durationMs, taps: { ...r.taps }, ranking: r.ranking, tie: r.tie, tappers: r.byPlayer.size });
    this.persist('saveSettings', this.settings);
    this.emit('round', this.roundPayload());
    this.changed(); // the screen payload carries the standings
  }

  /** Taps batched from a phone. Counted only while the round runs, only for team members, and capped at a human rate. */
  tap(playerId, n) {
    const r = this.round;
    const count = Number(n);
    if (!r || r.status !== 'running' || !Number.isInteger(count) || count < 1) return;
    const team = this.teamOf(this.players.get(playerId));
    if (!team || !(team.id in r.taps)) return; // teams made mid-round join the next one
    const now = Date.now();
    if (now > r.endsAt + 500) return;
    const allowed = Math.ceil((now - r.startsAt) / 1000 + 1) * TAP_MAX_PER_SEC;
    const have = r.byPlayer.get(playerId) || 0;
    const add = Math.min(count, 40, Math.max(0, allowed - have));
    if (!add) return;
    r.byPlayer.set(playerId, have + add);
    r.taps[team.id] += add;
    r.dirty = true;
  }

  resetTeamScores() {
    if (this.roundActive()) throw new HttpError(409, 'A round is running — wait for it to finish');
    this.round = null;
    Object.assign(this.settings, { teamScores: {}, teamRounds: [] });
    this.persist('saveSettings', this.settings);
    this.emit('round', this.roundPayload());
    this.changed();
  }

  /** Teams with sizes, tap totals and round wins (best first), recent rounds, and the current round — the Tap Battle view. */
  teamSummary() {
    const s = this.settings;
    const sizes = this.teamSizes();
    const wins = {};
    for (const rd of s.teamRounds) if (!rd.tie && rd.ranking[0]) wins[rd.ranking[0]] = (wins[rd.ranking[0]] || 0) + 1;
    const teams = [...this.teams.values()]
      .map((t) => ({ ...publicTeam(t), members: sizes[t.id] || 0, total: s.teamScores[t.id] || 0, wins: wins[t.id] || 0 }))
      .sort((a, b) => b.total - a.total || b.wins - a.wins);
    return { teams, rounds: s.teamRounds.slice(-8), round: this.roundPayload() };
  }

  // ------------------------------------------------------------- live quiz (hosted on the big screen)

  /** Replace the host's question list from pasted text (see parseLiveQuiz). */
  saveLiveQuiz(text) {
    if (typeof text !== 'string') throw new HttpError(400, 'Send the questions as text');
    if (this.live && this.live.status === 'open') throw new HttpError(409, 'A question is open — close it first');
    const { questions, skipped } = parseLiveQuiz(text);
    if (questions.length > 100) throw new HttpError(400, 'Up to 100 questions');
    this.settings.liveQuiz = questions;
    this.settings.liveAsked = [];
    this.persist('saveSettings', this.settings);
    return { count: questions.length, skipped };
  }

  /** What everyone sees about the current question. The answer is included only once it's closed (or for the admin). */
  liveQuizPayload(forAdmin = false) {
    const l = this.live;
    if (!l) return { status: 'idle' };
    const now = Date.now();
    const p = {
      status: l.status,
      kind: l.answer == null ? 'vote' : 'quiz',
      index: l.index,
      no: l.no,
      q: l.q,
      options: l.options,
      limitMs: l.limitMs,
      remainingMs: Math.max(0, l.closesAt - now),
      answered: l.answers.size,
      players: this.players.size,
      serverNow: now,
    };
    if (l.status === 'closed' || forAdmin) Object.assign(p, { answer: l.answer, result: l.result });
    return p;
  }

  /** Host puts question `index` on the big screen for `limitMs`. Phones get the options; nobody gets the answer. */
  askLive(index, limitMs) {
    const i = Number(index);
    const q = this.settings.liveQuiz[i];
    if (!Number.isInteger(i) || !q) throw new HttpError(400, 'Pick a question from the list');
    if (this.live && this.live.status === 'open') throw new HttpError(409, 'A question is already open — close it first');
    const limit = LIVE_LIMITS.includes(Number(limitMs)) ? Number(limitMs) : 15000;
    this.endLiveTimers();
    const now = Date.now();
    q.askedAt = now;
    this.settings.liveAsked.push(i);
    this.live = { status: 'open', index: i, no: this.settings.liveAsked.length, q: q.q, options: q.options, answer: q.answer, askedAt: now, closesAt: now + limit, limitMs: limit, answers: new Map(), result: null, dirty: false };
    this.persist('saveSettings', this.settings);
    this.emit('livequiz', this.liveQuizPayload());
    this.liveTimers.push(setTimeout(() => this.closeLive(), limit + LIVE_GRACE_MS));
    this.liveTimers.push(setInterval(() => {
      if (this.live && this.live.dirty) {
        this.live.dirty = false;
        this.emit('livequiz', this.liveQuizPayload()); // "34 answered" ticking up on the screen
      }
    }, 500));
    return this.liveQuizPayload(true);
  }

  answerLive(playerId, choice) {
    const l = this.live;
    const player = this.players.get(playerId);
    if (!l || l.status !== 'open' || !player) throw new HttpError(409, 'No question is open right now', 'NO_QUESTION');
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= l.options.length) throw new HttpError(400, 'Pick one of the options');
    if (l.answers.has(playerId)) return { ok: true, locked: true, answered: l.answers.size };
    const ms = Date.now() - l.askedAt;
    if (ms > l.limitMs + LIVE_GRACE_MS) throw new HttpError(410, 'Time’s up for this question', 'TOO_LATE');
    l.answers.set(playerId, { choice: c, ms });
    l.dirty = true;
    return { ok: true, answered: l.answers.size, ms };
  }

  endLiveTimers() {
    for (const t of this.liveTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.liveTimers = [];
  }

  /**
   * Time's up: reveal the answer, rank the correct answers by speed and credit points.
   * Points: 50 for a correct answer + up to 50 for speed, accumulated in one running
   * 'live' attempt per player (capped at 1000) so they count on the leaderboard.
   */
  closeLive() {
    const l = this.live;
    if (!l || l.status !== 'open') return;
    this.endLiveTimers();
    l.status = 'closed';
    const vote = l.answer == null; // a poll: bars only, no points
    const counts = l.options.map(() => 0);
    const correct = [];
    for (const [pid, a] of l.answers) {
      counts[a.choice]++;
      const p = this.players.get(pid);
      if (p && a.choice === l.answer) {
        const points = 50 + Math.round(50 * Math.max(0, 1 - Math.min(a.ms, l.limitMs) / l.limitMs));
        correct.push({ pid, name: p.name, emoji: p.emoji || '', ms: a.ms, points });
      }
    }
    correct.sort((a, b) => a.ms - b.ms);
    const now = Date.now();
    for (const pid of vote ? [] : l.answers.keys()) {
      if (!this.players.has(pid)) continue;
      let att = [...this.attempts.values()].find((x) => x.playerId === pid && x.gameId === 'live');
      if (!att) {
        att = { id: id(12), playerId: pid, gameId: 'live', teamId: null, startedAt: now, finishedAt: now, score: 0, meta: { correct: 0, answered: 0 }, pb: false };
        this.attempts.set(att.id, att);
      }
      const won = correct.find((c) => c.pid === pid);
      att.meta.answered++;
      if (won) {
        att.meta.correct++;
        att.score = Math.min(MAX, att.score + won.points);
        att.finishedAt = now; // reaching a total later loses ties, as everywhere else
      }
      this.persist('saveAttempt', att);
    }
    l.result = { counts, vote, correctCount: vote ? null : correct.length, fastest: correct.slice(0, 5).map(({ pid, ...c }) => c) };
    this.changed();
    this.emit('livequiz', this.liveQuizPayload());
    if (correct.length) {
      const item = { playerId: correct[0].pid, name: correct[0].name, gameId: 'live', score: correct[0].points, improved: false, fastest: true, at: now };
      this.recent.unshift(item);
      this.recent.length = Math.min(this.recent.length, 12);
      this.emit('activity', item);
    }
  }

  /** Take the question off the big screen (closing it first if it's still open). */
  hideLive() {
    if (this.live && this.live.status === 'open') this.closeLive();
    this.endLiveTimers();
    this.live = null;
    this.emit('livequiz', this.liveQuizPayload());
  }

  // ------------------------------------------------------------- lucky draw

  /** Pick a random guest for a spot prize. The big screen spins a wheel; the winner's phone celebrates. */
  luckyDraw({ onlyPlayed = false, excludeWinners = true } = {}) {
    const board = this.board(false); // "has played" means a finished game
    const previous = new Set(this.settings.luckyDraws.map((d) => d.playerId));
    const pool = [...this.players.values()].filter((p) => (!onlyPlayed || board.rankById.has(p.id)) && (!excludeWinners || !previous.has(p.id)));
    if (!pool.length) throw new HttpError(400, 'Nobody is eligible for the draw');
    const winner = pool[crypto.randomInt(pool.length)];
    const draw = { no: this.settings.luckyDraws.length + 1, playerId: winner.id, name: winner.name, emoji: winner.emoji || '', at: Date.now() };
    this.settings.luckyDraws.push(draw);
    this.persist('saveSettings', this.settings);
    // The wheel shows up to 80 names, the winner always among them.
    const others = shuffle(pool.filter((p) => p !== winner)).slice(0, 79);
    this.emit('luckydraw', { ...draw, winner: publicPlayer(winner), names: shuffle([winner, ...others]).map(publicPlayer), pool: pool.length });
    return draw;
  }

  /**
   * Admin opened a game: first its intro plays on the big screen — what it is and how to
   * play — with a countdown, and only then does the game unlock on phones. That way the
   * whole room starts together and nobody gets a head start on the per-game championship.
   */
  openGame(gameId) {
    const game = GAME_MAP[gameId];
    if (!game || game.hosted || game.bonus || game.social) throw new HttpError(400, 'This game cannot be opened this way');
    if (this.settings.enabledGames.includes(gameId)) throw new HttpError(400, `${game.name} is already open`);
    if (this.introTimer) clearTimeout(this.introTimer); // a new intro replaces a pending one
    const opensAt = Date.now() + INTRO_MS;
    this.pendingIntro = { gameId, opensAt };
    this.introTimer = setTimeout(() => {
      this.pendingIntro = null;
      this.introTimer = null;
      if (!this.settings.enabledGames.includes(gameId)) {
        this.settings.enabledGames.push(gameId);
        this.persist('saveSettings', this.settings);
        this.emit('settings', this.publicSettings());
        this.changed();
      }
    }, INTRO_MS);
    const { name, emoji, color, tagline, howTo, duration } = game;
    this.emit('gameintro', { gameId, name, emoji, color, tagline, howTo, duration, opensAt });
    return { gameId, opensAt };
  }

  /**
   * "This game is over": close it for new tries and crown its champion on the big screen —
   * the best single solo try, with a podium of the top three. Tries already in progress may
   * still finish, but the moment is announced with the scores as they stand. The admin can
   * reopen the game any time with its checkbox.
   */
  endGame(gameId) {
    const game = GAME_MAP[gameId];
    if (!game || game.hosted || game.bonus || game.social) throw new HttpError(400, 'This game cannot be ended');
    const best = new Map(); // playerId → their best single solo try
    for (const a of this.attempts.values()) {
      if (a.gameId !== gameId || a.teamId || a.score == null) continue;
      const prev = best.get(a.playerId);
      if (!prev || a.score > prev.score || (a.score === prev.score && a.finishedAt < prev.finishedAt)) best.set(a.playerId, a);
    }
    const podium = [...best.values()]
      .sort((x, y) => y.score - x.score || x.finishedAt - y.finishedAt)
      .map((a) => {
        const p = this.players.get(a.playerId);
        return p ? { ...publicPlayer(p), score: a.score } : null;
      })
      .filter(Boolean)
      .slice(0, 3);
    if (!podium.length) throw new HttpError(400, `Nobody has played ${game.name} yet`);
    this.settings.enabledGames = this.settings.enabledGames.filter((id) => id !== gameId);
    this.persist('saveSettings', this.settings);
    this.emit('settings', this.publicSettings());
    this.changed();
    const payload = { gameId, name: game.name, emoji: game.emoji, color: game.color, podium, at: Date.now() };
    this.emit('gamewinner', payload);
    return payload;
  }

  // ------------------------------------------------------------- leaderboard

  /**
   * The individual board: every finished solo try counts — a player's total (and their
   * points per game) is all their solo scores added up; team tries count on the team board
   * instead. Ties go to whoever reached the total first. With `includeLive` (the default)
   * games in progress count provisionally, so the big screen moves while people play; the
   * reveal, Admin and the CSV use confirmed scores only. Cached until the next change.
   */
  board(includeLive = true) {
    const cached = includeLive ? this.cache : this.cacheConfirmed;
    if (cached) return cached;
    // Power Connections never scores points: it's kept out of the totals and tracked as a count.
    const finished = [...this.attempts.values()].filter((a) => !a.teamId && a.score != null && a.gameId !== 'network' && GAME_MAP[a.gameId]).sort((a, b) => a.finishedAt - b.finishedAt); // games since removed don't count
    const rows = new Map();
    const leaders = {};
    const connections = new Map(); // playerId → members connected with; its "champion" is the biggest networker
    for (const a of this.attempts.values()) {
      if (a.gameId !== 'network' || a.teamId) continue;
      const n = a.meta?.met?.length || 0;
      if (!n) continue;
      connections.set(a.playerId, n);
      const p = this.players.get(a.playerId);
      if (p && (!leaders.network || n > leaders.network.score)) leaders.network = { id: p.id, name: p.name, score: n };
    }
    for (const a of finished) {
      const p = this.players.get(a.playerId);
      if (!p) continue;
      let row = rows.get(p.id);
      if (!row) {
        row = { ...publicPlayer(p), total: 0, scores: {}, plays: 0, reachedAt: 0 };
        rows.set(p.id, row);
      }
      row.plays++;
      row.total += a.score;
      row.scores[a.gameId] = (row.scores[a.gameId] || 0) + a.score;
      row.reachedAt = a.finishedAt;
      // The game champion is still the best single try.
      if (!leaders[a.gameId] || a.score > leaders[a.gameId].score) leaders[a.gameId] = { id: p.id, name: p.name, score: a.score };
    }
    if (includeLive) {
      const now = Date.now();
      for (const [attemptId, l] of this.liveScores) {
        if (l.teamId) continue; // a team try in progress moves the team board, not this one
        if (now - l.at > LIVE_STALE_MS || !this.attempts.has(attemptId)) continue;
        const p = this.players.get(l.playerId);
        if (!p) continue;
        let row = rows.get(p.id);
        if (!row) {
          row = { ...publicPlayer(p), total: 0, scores: {}, plays: 0, reachedAt: now };
          rows.set(p.id, row);
        }
        row.total += l.score;
        row.reachedAt = now;
        row.live = { gameId: l.gameId, score: l.score };
      }
    }
    const ranked = [...rows.values()].sort((x, y) => y.total - x.total || x.reachedAt - y.reachedAt);
    ranked.forEach((r, i) => {
      r.rank = i + 1;
      r.connections = connections.get(r.id) || 0;
    });

    const chapterMap = new Map();
    for (const r of ranked) {
      if (!r.chapter) continue;
      const c = chapterMap.get(r.chapter.toLowerCase()) || { name: r.chapter, total: 0, members: 0 };
      c.total += r.total;
      c.members++;
      chapterMap.set(r.chapter.toLowerCase(), c);
    }

    const result = {
      ranked,
      rankById: new Map(ranked.map((r) => [r.id, r])),
      leaders: GAMES.filter((g) => !g.bonus).map((g) => ({ gameId: g.id, ...(leaders[g.id] || {}) })), // no "champion" of a luck bonus
      chapters: [...chapterMap.values()].sort((x, y) => y.total - x.total),
      plays: finished.length,
    };
    if (includeLive) this.cache = result;
    else this.cacheConfirmed = result;
    return result;
  }

  /** What the public big screen gets. Nothing score-related leaks while hidden. */
  screenPayload() {
    const s = this.settings;
    const board = this.board();
    const base = { mode: s.screenMode, title: s.eventTitle, tagline: s.tagline, playOpen: s.playOpen, players: this.players.size, plays: board.plays };
    // The team battle, live quiz and lucky draw ride on top of whichever view is showing.
    const overlays = { teamBattle: this.teams.size ? this.teamSummary() : null, live: this.liveQuizPayload() };
    if (s.screenMode === 'hidden') return { ...base, ...overlays };
    if (s.screenMode === 'reveal') return { ...base, reveal: s.reveal };
    const confirmed = this.board(false);
    // Game-by-game nights: while only SOME of the switchable games are open, the main board
    // becomes the live race for those open games — only their points count and rank here.
    // Overall totals still decide the reveal, the champions panel, the admin and the CSV.
    const switchable = GAMES.filter((g) => !g.hosted && !g.bonus && !g.social);
    const race = switchable.filter((g) => s.enabledGames.includes(g.id));
    const raceMode = race.length > 0 && race.length < switchable.length;
    const raceIds = new Set(race.map((g) => g.id));
    const raceRank = (rows) =>
      rows
        .map((r) => ({ ...r, total: race.reduce((sum, g) => sum + (r.scores[g.id] || 0), 0) + (r.live && raceIds.has(r.live.gameId) ? r.live.score : 0) }))
        .filter((r) => r.total > 0 || (r.live && raceIds.has(r.live.gameId)))
        .sort((x, y) => y.total - x.total || x.reachedAt - y.reachedAt)
        .map((r, i) => ({ ...r, rank: i + 1 }));
    const top = raceMode ? raceRank(board.ranked) : board.ranked;
    const confirmedTop = raceMode ? raceRank(confirmed.ranked)[0] : confirmed.ranked[0];
    return {
      ...base,
      ...overlays,
      top: top.slice(0, SCREEN_TOP).map(publicRow),
      race: raceMode ? race.map((g) => g.id) : null,
      leaders: board.leaders,
      chapters: board.chapters.slice(0, 8),
      // The group-games race: top teams by points from the team games.
      teamsBoard: this.teamBoard().ranked.slice(0, 8).map(({ rank, id, name, emoji, color, chapter, members, total, plays }) => ({ rank, id, name, emoji, color, chapter, members, total, plays })),
      recent: this.recent.slice(0, 8),
      // Who is mid-game right now, with their running score (for the "Playing right now" panel).
      playing: board.ranked
        .filter((r) => r.live)
        .sort((a, b) => b.live.score - a.live.score)
        .slice(0, 8)
        .map((r) => ({ id: r.id, name: r.name, rank: r.rank, gameId: r.live.gameId, score: r.live.score })),
      // The "New leader" banner follows confirmed scores, so provisional ones don't make it
      // flicker — and in a game-by-game race, it celebrates the race leader.
      confirmedLeader: confirmedTop ? publicRow(confirmedTop) : null,
    };
  }

  // ------------------------------------------------------------- admin

  adminOverview() {
    const board = this.board(false);
    const players = [...this.players.values()].map((p) => {
      const row = board.rankById.get(p.id);
      const used = this.usedAttempts(p.id);
      const usedTeam = this.usedAttempts(p.id, true);
      return {
        ...publicPlayer(p),
        phone: p.phone || '',
        team: this.teamOf(p)?.name || '',
        createdAt: p.createdAt,
        rank: row?.rank ?? null,
        total: row?.total ?? 0,
        scores: row?.scores ?? {},
        connections: this.networkAttempt(p.id)?.meta.met.length ?? 0,
        spinPrize: (() => { const sp = this.spinAttempt(p.id); return sp ? String(sp.meta?.label ?? sp.score) : ''; })(),
        tries: Object.values(used).reduce((a, b) => a + b, 0),
        teamTries: Object.values(usedTeam).reduce((a, b) => a + b, 0),
      };
    });
    players.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.createdAt - b.createdAt);
    const teams = this.teamBoard().ranked.map((r) => {
      const t = this.teams.get(r.id);
      return { ...r, code: t.code, captain: this.players.get(t.captainId)?.name || '—', taps: this.settings.teamScores[t.id] || 0, createdAt: t.createdAt };
    });
    const { reveal, ...settings } = this.settings;
    const won = this.spinWon();
    return {
      settings: { ...settings, revealedAt: reveal?.at ?? null },
      // The prize desk's live stock: how many of each limited spin gift are still unwon.
      spinStock: this.settings.spinWedges.filter((w) => w.stock != null).map((w) => ({ label: w.label, stock: w.stock, left: Math.max(0, w.stock - (won[w.label] || 0)) })),
      pendingIntro: this.pendingIntro || null, // a game mid-intro on the big screen, about to unlock
      games: this.gamesPayload(),
      players,
      teams,
      stats: { players: this.players.size, teams: this.teams.size, ranked: board.ranked.length, plays: board.plays, started: this.attempts.size, playing: this.liveScores.size },
      teamBattle: this.teamSummary(),
      liveQuiz: {
        questions: this.settings.liveQuiz.map((q, i) => ({ i, q: q.q, options: q.options, answer: q.answer, asked: Boolean(q.askedAt) })),
        current: this.liveQuizPayload(true),
      },
      luckyDraws: this.settings.luckyDraws,
    };
  }

  exportCsv() {
    const { players } = this.adminOverview();
    const header = ['Rank', 'Name', 'Business', 'Chapter', 'Phone', 'Team', ...GAMES.map((g) => (g.id === 'network' ? 'Connections' : g.name)), 'Total', 'Tries', 'Team tries', 'Joined'];
    const lines = players.map((p) => [
      p.rank ?? '',
      p.name,
      p.business,
      p.chapter,
      p.phone,
      p.team,
      ...GAMES.map((g) => (g.id === 'network' ? p.connections || '' : g.id === 'spin' ? p.spinPrize : p.scores[g.id] ?? '')),
      p.total,
      p.tries,
      p.teamTries,
      new Date(p.createdAt).toISOString(),
    ]);
    return [header, ...lines].map((cols) => cols.map(csvCell).join(',')).join('\n');
  }
}

module.exports = GameState;
