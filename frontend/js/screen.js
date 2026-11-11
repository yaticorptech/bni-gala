// Big-screen live leaderboard: live board with animated re-ranking, hidden mode, the grand
// reveal — and the hosted moments (team tap battle, live quiz, lucky draw) as overlays on top,
// so the screen never leaves the live board.
import { api, apiUrl, connectSocket, esc, fmt, initials, hue, countUp, sfx, confetti, sleep, photoUrl } from './common.js';

const $ = (sel) => document.querySelector(sel);
const MEDALS = ['🥇', '🥈', '🥉'];
const LETTERS = 'ABCDEF';
const OPTION_COLORS = ['#e3263a', '#3b82f6', '#f7c548', '#22c55e', '#a855f7', '#f97316'];

let games = [];
const rows = new Map(); // playerId → { el, total, rank, deltaTimer }
let revealing = false;
let shownRevealAt = null;
let feedSeeded = false;
let bannerQueue = Promise.resolve();
// Sidebar panels that currently have something to show; they take turns every 12 s. While
// anyone is mid-game, "Playing right now" holds the slot two turns out of three: for most
// guests it's the only place they see themselves on the big screen while they play.
const panels = { playing: false, champions: true, chapters: false, teams: false };
let panelIndex = 0;
// Team Tap Battle
let battleTeams = []; // [{ id, name, color, emoji, members, total, wins }] best first (taps)
let teamsBoard = []; // the group-games points standings for the sidebar panel
let battleRound = null; // latest round payload
let lastLeadSfx = 0; // when the lead-change riser last played
let battleBeepSec = null; // last second we beeped in a round's final countdown
let liveBeepSec = null; // same for a live-quiz question
let battleAt = 0; // performance.now() when it arrived
let battleDrawnNo = null; // round whose bars are on screen
let announcedNo = null; // round whose winner banner has been shown
let battleHideTimer = 0;
// Live Quiz
let live = null;
let liveAt = 0;
let liveDrawnNo = null;
let liveHideTimer = 0;
// Lucky draw
let drawing = false;

const gameById = (id) => games.find((g) => g.id === id);
// Columns on the board: the games people play on their phones. Hosted moments (Live Quiz) still count in totals, but get no chip.
const chipGames = () => games.filter((g) => !g.hosted);
const setMode = (mode) => (document.body.dataset.mode = mode);
const avatar = (e) => initials(e.name); // behind the photo; seen only when a guest has none
const withEmoji = (e) => esc(e.name);

function setHeader(p) {
  if (p.title || p.eventTitle) {
    $('#title').textContent = p.title || p.eventTitle;
    document.title = `${p.title || p.eventTitle} · Live Leaderboard`;
  }
  if ('tagline' in p) $('#tagline').textContent = p.tagline || '';
  if ('players' in p) $('#stat-players').textContent = fmt(p.players);
  if ('plays' in p) $('#stat-plays').textContent = fmt(p.plays);
  if ('playing' in p) {
    const n = (p.playing || []).length;
    $('#stat-playing').textContent = fmt(n);
    $('#playing-pill').classList.toggle('on', n > 0);
  }
  if ('playOpen' in p) $('#secret-qr').classList.toggle('hidden', !p.playOpen);
}

// ------------------------------------------------------------------ live board

function makeRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `
    <i class="race"></i>
    <div class="rk"></div>
    <div class="av"></div>
    <div class="who"><div class="nm"></div><div class="sb"></div></div>
    <div class="chips"></div>
    <div class="delta"></div>
    <div class="tt">0</div>`;
  return { el, total: null, rank: null, deltaTimer: 0, name: null, emoji: null };
}

function updateRow(r, e) {
  const el = r.el;
  el.classList.remove('r1', 'r2', 'r3');
  if (e.rank <= 3) el.classList.add(`r${e.rank}`);
  el.querySelector('.rk').textContent = MEDALS[e.rank - 1] || e.rank;
  if (r.name !== e.name || r.emoji !== e.emoji) {
    // Photo when the guest has one, else emoji or initials (the img removes itself if there's no file).
    const av = el.querySelector('.av');
    av.innerHTML = `<img src="${photoUrl(e.name)}" alt="" onerror="this.remove()"><span>${esc(avatar(e))}</span>`;
    av.style.setProperty('--h', hue(e.name));
    r.name = e.name;
    r.emoji = e.emoji;
  }
  el.querySelector('.nm').textContent = e.name;
  // Mid-game: a pulsing "playing" tag, and that game's chip shows the running score in green.
  const liveGame = e.live && gameById(e.live.gameId);
  const sub = [e.business, e.chapter].filter(Boolean).join(' · ');
  el.querySelector('.sb').innerHTML = liveGame
    ? `<span class="now"><i></i>${liveGame.emoji} playing · ${fmt(e.live.score)}</span>${sub ? ` · ${esc(sub)}` : ''}`
    : esc(sub);
  el.classList.toggle('playing', Boolean(liveGame));
  const chips = el.querySelector('.chips');
  const cols = chipGames();
  chips.classList.toggle('many', cols.length > 6);
  chips.innerHTML = cols
    .map((g) => {
      const v = e.scores[g.id];
      const isLive = Boolean(e.live && e.live.gameId === g.id);
      const shown = isLive ? (v ?? 0) + e.live.score : v; // this game's points so far, plus the running try
      return `<span class="gchip ${shown == null ? 'off' : ''} ${isLive ? 'live' : ''}">${g.emoji}<b>${shown == null ? '–' : shown}</b></span>`;
    })
    .join('');

  if (r.total !== e.total) {
    countUp(el.querySelector('.tt'), e.total, 1000); // continues from whatever is showing: never ticks backwards
    if (r.total != null && !e.live) { // flash when a final score lands (live rows tick instead, so the board doesn't strobe)
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }
  if (r.rank != null && r.rank !== e.rank) {
    const d = el.querySelector('.delta');
    const up = e.rank < r.rank;
    if (up && e.rank <= 3 && r.rank > 3) sfx.rise(); // climbed into the top 3
    d.textContent = `${up ? '▲' : '▼'}${Math.abs(r.rank - e.rank)}`;
    d.className = `delta ${up ? 'up' : 'down'}`;
    clearTimeout(r.deltaTimer);
    r.deltaTimer = setTimeout(() => {
      d.textContent = '';
      d.className = 'delta';
    }, 8000);
  }
  r.total = e.total;
  r.rank = e.rank;
}

/** Shrinks a long name just enough to fit its column, instead of cutting it to "Soujan…". */
function fitName(r) {
  const nm = r.el.querySelector('.nm');
  const key = `${r.name}|${nm.clientWidth}|${r.rank <= 3}`;
  if (r.fitKey === key) return;
  r.fitKey = key;
  nm.style.fontSize = '';
  if (nm.scrollWidth <= nm.clientWidth) return;
  const px = parseFloat(getComputedStyle(nm).fontSize);
  nm.style.fontSize = `${Math.max(px * 0.6, px * (nm.clientWidth / nm.scrollWidth) * 0.98)}px`;
}

/** Re-render the top list, animating moved rows from their old position (FLIP). */
function renderBoard(entries) {
  const board = $('#board');
  const visible = board.offsetParent !== null;
  const before = new Map();
  if (visible) for (const [id, r] of rows) before.set(id, r.el.getBoundingClientRect().top);

  const seen = new Set();
  const lead = Math.max(1, entries[0]?.total || 0);
  for (const e of entries) {
    seen.add(e.id);
    let r = rows.get(e.id);
    if (!r) {
      r = makeRow();
      rows.set(e.id, r);
    }
    updateRow(r, e);
    r.el.style.setProperty('--race', `${Math.round((100 * e.total) / lead)}%`); // the race bar: how close to the leader
    board.appendChild(r.el); // appending in order = reordering
  }
  for (const [id, r] of rows) {
    if (!seen.has(id)) {
      r.el.remove();
      rows.delete(id);
    }
  }
  $('#empty').classList.toggle('hidden', entries.length > 0);
  if (!visible) return;
  for (const e of entries) fitName(rows.get(e.id));

  for (const e of entries) {
    const r = rows.get(e.id);
    const top = r.el.getBoundingClientRect().top;
    if (!before.has(e.id)) {
      r.el.animate([{ opacity: 0, transform: 'translateX(-3rem)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: 'ease-out' });
    } else {
      const dy = before.get(e.id) - top;
      if (Math.abs(dy) > 1) {
        r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
  }
}

function renderChampions(leaders) {
  $('#champions').innerHTML = leaders
    .map((l) => {
      const g = gameById(l.gameId);
      if (!g) return '';
      return `<li><span class="ce">${g.emoji}</span>
        <span class="cn"><b>${l.name ? esc(l.name) : '—'}</b><small>${esc(g.name)}</small></span>
        <span class="cs">${l.score != null ? fmt(l.score) : ''}</span></li>`;
    })
    .join('');
}

function renderChapters(chapters) {
  panels.chapters = chapters.length >= 2;
  $('#chapters').innerHTML = chapters
    .slice(0, 6)
    .map((c, i) => `<li><span class="crk">${MEDALS[i] || i + 1}</span>
      <span class="cn"><b>${esc(c.name)}</b><small>${c.members} player${c.members === 1 ? '' : 's'}</small></span>
      <span class="cs">${fmt(c.total)}</span></li>`)
    .join('');
  syncPanels();
}

function renderStandings() {
  panels.teams = teamsBoard.length > 0;
  $('#standings').innerHTML = teamsBoard
    .slice(0, 6)
    .map((t) => `<li><span class="crk">${t.total ? MEDALS[t.rank - 1] || t.rank : '·'}</span>
      <span class="cn"><b>${t.emoji} ${esc(t.name)}</b><small>${t.members} member${t.members === 1 ? '' : 's'}${t.chapter ? ` · ${esc(t.chapter)}` : ''}</small></span>
      <span class="cs">${fmt(t.total)}</span></li>`)
    .join('');
  syncPanels();
}

/** One sidebar panel at a time; the ones with content take turns. */
function syncPanels(advance = false) {
  const others = Object.keys(panels).filter((k) => k !== 'playing' && panels[k]);
  if (advance) panelIndex++;
  let show;
  if (panels.playing) show = panelIndex % 3 === 2 && others.length ? others[Math.floor(panelIndex / 3) % others.length] : 'playing';
  else show = others[panelIndex % others.length] || 'champions';
  for (const k of Object.keys(panels)) $(`#${k}-panel`).classList.toggle('hidden', k !== show);
}
setInterval(() => syncPanels(true), 12000);

/** Sidebar list of everyone mid-game right now, with their running score. Takes the panel slot while anyone is playing. */
function renderPlaying(list) {
  if (!panels.playing && list.length) panelIndex = 0; // someone just started: show them straight away
  panels.playing = list.length > 0;
  syncPanels();
  if (!list.length) return;
  $('#playing').innerHTML = list
    .slice(0, 5)
    .map((x) => {
      const g = gameById(x.gameId);
      return `<li>
        <span class="pav"><img src="${photoUrl(x.name)}" alt="" onerror="this.remove()"><span>${esc(initials(x.name))}</span></span>
        <span class="pn"><b>${esc(x.name)}</b><small>${g?.emoji || '🎮'} ${esc(g?.name || '')}</small><i style="width:${Math.min(100, x.score / 10)}%"></i></span>
        <span class="ps">${fmt(x.score)}</span></li>`;
    })
    .join('');
}

function feedItem(a) {
  const g = gameById(a.gameId);
  const li = document.createElement('li');
  li.innerHTML = a.fastest
    ? `<span class="fe">⚡</span><span class="ft"><b>${esc(a.name)}</b> was fastest on the Live Quiz · <b>+${fmt(a.score)}</b></span>`
    : a.with
    ? `<span class="fe">🔗</span><span class="ft"><b>${esc(a.name)}</b> connected with <b>${esc(a.with)}</b> · <b>+${fmt(a.score)}</b> each</span>`
    : `<span class="fe">${g?.emoji || '🎮'}</span>
    <span class="ft"><b>${esc(a.name)}</b> scored <b>${fmt(a.score)}</b> in ${esc(g?.name || '')}${a.team ? ` for ${a.team.emoji} ${esc(a.team.name)}` : ''}</span>
    ${a.improved ? '<em>NEW BEST</em>' : ''}`;
  return li;
}

function addActivity(a, animate = true) {
  const ul = $('#feed');
  ul.querySelector('.empty-feed')?.remove();
  const li = feedItem(a);
  if (animate) {
    // Every finished game gets a chime (higher score, higher note); a new best or fastest finger sparkles.
    if (a.fastest) sfx.sparkle();
    else if (a.with) {
      sfx.bonus(); // two members just connected — a cheerful double note of its own
      sfx.sparkle(0.2);
    } else {
      const d = sfx.ding((a.score || 0) / 1000);
      if (a.improved) sfx.sparkle(d + 0.12);
    }
  }
  ul.prepend(li);
  if (animate) li.animate([{ opacity: 0, transform: 'translateY(-1rem)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
  while (ul.children.length > 8) ul.lastElementChild.remove();
}

function showLeader(top) {
  bannerQueue = bannerQueue.then(async () => {
    if (document.body.dataset.mode !== 'live') return;
    const banner = $('#banner');
    banner.innerHTML = `<div class="banner-inner"><span class="crown">👑</span><img class="banner-photo" src="${photoUrl(top.name)}" alt="" onerror="this.remove()">
      <div><small>New leader!</small><b>${withEmoji(top)}</b></div>
      <span class="banner-score">${fmt(top.total)}</span></div>`;
    banner.classList.add('show');
    sfx.whoosh();
    sfx.cheer(2.6, 0.15);
    confetti({ duration: 2200, count: 150 });
    await sleep(4200);
    banner.classList.remove('show');
    await sleep(700);
  });
}

// ------------------------------------------------------------------ reveal

const podSlot = (rank) => `<div class="pod p${rank}"><div class="slot" data-rank="${rank}"><span class="q">?</span></div><div class="pod-block">${rank}</div></div>`;

function revealSkeleton(entries) {
  const n = entries.length;
  const podium = [2, 1, 3].filter((rank) => rank <= n).map(podSlot).join('');
  const rest = [];
  for (let rank = 4; rank <= n; rank++) rest.push(`<div class="slot" data-rank="${rank}"><span class="q">${rank}</span></div>`);
  const cols = rest.length > 8 ? 3 : 2;
  const rowsPerCol = Math.ceil(rest.length / cols) || 1;
  return `
    <h1 class="rv-title">🏆 ${n > 3 ? `Top ${n}` : 'The Winners'}</h1>
    <div class="podium">${podium}</div>
    ${rest.length ? `<div class="rv-list" style="grid-template-columns:repeat(${cols}, 1fr);grid-template-rows:repeat(${rowsPerCol}, auto)">${rest.join('')}</div>` : ''}`;
}

function fillSlot(slot, e) {
  if (e.rank <= 3) {
    slot.innerHTML = `<div><div class="pod-medal">${MEDALS[e.rank - 1]}</div>
      <div class="pod-photo"><img src="${photoUrl(e.name)}" alt="" onerror="this.parentElement.remove()"></div>
      <div class="pod-name">${withEmoji(e)}</div>
      <div class="pod-sub">${esc([e.business, e.chapter].filter(Boolean).join(' · '))}</div>
      <div class="pod-total">${fmt(e.total)} pts</div></div>`;
  } else {
    slot.innerHTML = `<span class="rv-rank">#${e.rank}</span>
      <span class="rv-name">${withEmoji(e)}${e.business ? `<small>${esc(e.business)}</small>` : ''}</span>
      <span class="rv-total">${fmt(e.total)}</span>`;
  }
  slot.classList.remove('drum');
  slot.classList.add('revealed');
}

function renderRevealFinal(reveal) {
  shownRevealAt = reveal.at;
  const root = $('#reveal');
  root.innerHTML = revealSkeleton(reveal.entries);
  for (const e of reveal.entries) fillSlot(root.querySelector(`.slot[data-rank="${e.rank}"]`), e);
  root.querySelectorAll('.slot').forEach((s) => (s.style.animation = 'none'));
}

async function runReveal(reveal) {
  if (revealing) return;
  revealing = true;
  shownRevealAt = reveal.at;
  setMode('reveal');
  const root = $('#reveal');
  try {
    root.innerHTML = `<div class="rv-intro"><div class="rv-trophy">🏆</div><h1>And the winners are…</h1></div>`;
    sfx.drumroll(3.3);
    sfx.crash(3.35);
    await sleep(3800);
    root.innerHTML = revealSkeleton(reveal.entries);
    await sleep(1200);
    for (const e of [...reveal.entries].reverse()) {
      const slot = root.querySelector(`.slot[data-rank="${e.rank}"]`);
      if (e.rank <= 3) {
        slot.classList.add('drum');
        const roll = e.rank === 1 ? 4.0 : 2.6;
        sfx.drumroll(roll);
        sfx.crash(roll + 0.05);
        await sleep(e.rank === 1 ? 4200 : 2800);
      }
      fillSlot(slot, e);
      if (e.rank === 1) {
        sfx.cheer(6.5);
        confetti({ duration: 7000, count: 260 });
      } else if (e.rank <= 3) {
        sfx.fanfare();
        sfx.applause(2.2, 0.4);
      } else {
        sfx.whoosh();
        sfx.ding(0.7);
      }
      await sleep(e.rank <= 3 ? 2200 : 1300);
    }
  } finally {
    revealing = false;
  }
}

// ------------------------------------------------------------------ team tap battle (overlay)

function onRound(r) {
  const prev = battleRound;
  battleRound = r;
  battleAt = performance.now();
  clearTimeout(battleHideTimer);
  const overlay = $('#battle-overlay');
  if (r.status === 'countdown' || r.status === 'running') {
    if (r.status === 'countdown' && live?.status === 'closed') {
      clearTimeout(liveHideTimer); // a lingering quiz result would sit on top of the battle
      $('#quiz-overlay').classList.add('hidden');
    }
    overlay.classList.remove('hidden');
    renderBattle();
    // The lead changes hands mid-round: a riser (at most one every 1.5 s in a tight race).
    const lead = r.ranking?.[0];
    if (r.status === 'running' && prev?.status === 'running' && lead && prev.ranking?.[0] && lead !== prev.ranking[0] && !r.tie && performance.now() - lastLeadSfx > 1500) {
      lastLeadSfx = performance.now();
      sfx.rise();
    }
  } else if (r.status === 'ended' && prev && prev.no === r.no) {
    renderBattle();
    if (prev.status === 'running' && announcedNo !== r.no) {
      announcedNo = r.no;
      sfx.buzz(); // the final horn
      announceWinner(r);
    }
    battleHideTimer = setTimeout(() => overlay.classList.add('hidden'), 12000); // linger on the result, then give the board back
  } else {
    overlay.classList.add('hidden');
  }
}

function renderBattle() {
  const r = battleRound || { status: 'idle' };
  const teams = battleTeams;
  const bars = $('#bars');
  const count = $('#battle-count');
  if (!teams.length) {
    bars.innerHTML = '<div class="battle-empty"><div class="empty-icon">👥</div><h2>Teams coming up…</h2></div>';
    return;
  }
  $('#battle-title').textContent = `👥 Team Tap Battle · Round ${r.no}`;
  const taps = (t) => r.taps?.[t.id] || 0;
  const max = Math.max(1, ...teams.map(taps));
  const lead = Math.max(...teams.map(taps));
  // Bars keep a fixed order (the leader glows instead of jumping around).
  if (battleDrawnNo !== r.no || bars.children.length !== teams.length) {
    battleDrawnNo = r.no;
    bars.innerHTML = [...teams]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => `
        <div class="bar-row" data-team="${t.id}" style="--c:${t.color}">
          <div class="bar-team">${t.emoji} ${esc(t.name)}<small>${t.members} player${t.members === 1 ? '' : 's'}</small></div>
          <div class="bar-track"><div class="bar-fill"></div></div>
          <div class="bar-count">0</div>
        </div>`)
      .join('');
  }
  for (const row of bars.children) {
    const t = teams.find((x) => x.id === row.dataset.team);
    const n = taps(t);
    row.querySelector('.bar-fill').style.width = `${(n / max) * 100}%`;
    row.querySelector('.bar-count').textContent = fmt(n);
    row.classList.toggle('lead', n > 0 && n === lead);
  }
  count.classList.toggle('hidden', r.status !== 'countdown');
  const winner = r.ranking && teams.find((t) => t.id === r.ranking[0]);
  $('#battle-foot').textContent = {
    countdown: 'Get ready… tap when it says GO!',
    running: 'TAP TAP TAP! Every tap counts for your team',
    ended: r.tie ? `Round ${r.no}: it’s a tie!` : `Round ${r.no}: Team ${winner?.name || '?'} wins! 🎉`,
  }[r.status] || '';
  tickBattleClock();
}

/** Countdown digits and the timer, smooth between server updates. */
function tickBattleClock() {
  if (!battleRound || $('#battle-overlay').classList.contains('hidden')) return;
  const r = battleRound;
  const dt = performance.now() - battleAt;
  const clock = $('#battle-clock');
  if (r.status === 'countdown') {
    const left = Math.max(0, r.countdownMs - dt);
    const n = left > 400 ? String(Math.ceil(left / 1000)) : 'GO!';
    const el = $('#battle-count');
    if (el.textContent !== n) {
      el.textContent = n;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      n === 'GO!' ? sfx.go() : sfx.tick();
    }
    clock.textContent = `${Math.ceil(r.durationMs / 1000)}s`;
    clock.classList.remove('urgent');
  } else if (r.status === 'running') {
    const left = Math.max(0, r.remainingMs - dt);
    const sec = Math.ceil(left / 1000);
    clock.textContent = `${sec}s`;
    clock.classList.toggle('urgent', left < 5500);
    if (left > 0 && sec <= 3 && sec !== battleBeepSec) {
      battleBeepSec = sec;
      sfx.tick();
    }
  } else {
    clock.textContent = r.status === 'ended' ? '0s' : '';
    clock.classList.remove('urgent');
  }
}
setInterval(tickBattleClock, 100);

function announceWinner(r) {
  const w = battleTeams.find((t) => t.id === r.ranking[0]);
  bannerQueue = bannerQueue.then(async () => {
    const banner = $('#banner');
    banner.innerHTML = r.tie
      ? `<div class="banner-inner"><span class="crown">🤝</span><div><small>Round ${r.no}</small><b>It’s a tie!</b></div></div>`
      : `<div class="banner-inner"><span class="crown">${w?.emoji || '🏆'}</span>
          <div><small>Round ${r.no} winner</small><b>Team ${esc(w?.name || '?')}</b></div>
          <span class="banner-score">${fmt(r.taps[r.ranking[0]] || 0)} taps</span></div>`;
    banner.classList.add('show');
    if (r.tie) sfx.good();
    else sfx.cheer(3.5, 0.4);
    confetti({ duration: 4000, count: 220 });
    await sleep(5000);
    banner.classList.remove('show');
    await sleep(700);
  });
}

// ------------------------------------------------------------------ live quiz (overlay)

function onLive(q) {
  const prev = live;
  live = q;
  liveAt = performance.now();
  clearTimeout(liveHideTimer);
  const overlay = $('#quiz-overlay');
  if (q.status === 'idle') {
    overlay.classList.add('hidden');
    liveDrawnNo = null;
    return;
  }
  if (q.status === 'open' && battleRound?.status === 'ended') {
    clearTimeout(battleHideTimer); // a lingering battle result would hide the question
    $('#battle-overlay').classList.add('hidden');
  }
  overlay.classList.remove('hidden');
  renderLive();
  if (q.status === 'open' && prev?.no !== q.no) {
    liveBeepSec = null;
    sfx.whoosh();
    sfx.go();
  }
  if (q.status === 'closed' && prev?.status === 'open' && prev.no === q.no) {
    sfx.buzz(); // time's up…
    if (q.kind === 'vote' ? q.answered > 0 : q.result?.correctCount) {
      sfx.fanfare(0.5); // …and the answer
      sfx.applause(2.5, 0.8);
      confetti({ duration: 2500, count: 160 });
    } else setTimeout(() => sfx.bad(), 500);
  }
  // The answer stays up a while, then the board comes back unless the host asks the next one.
  if (q.status === 'closed') liveHideTimer = setTimeout(() => overlay.classList.add('hidden'), prev ? 25000 : 8000);
}

function renderLive() {
  const q = live;
  if (!q || q.status === 'idle') return;
  const root = $('#quiz-overlay');
  if (liveDrawnNo !== q.no) {
    liveDrawnNo = q.no;
    root.innerHTML = `
      <div class="lq-head"><h2>${q.kind === 'vote' ? '📊 Live Vote' : '📺 Live Quiz'} · Question ${q.no}</h2><div class="lq-clock" id="lq-clock"></div></div>
      <div class="lq-timer"><i id="lq-bar"></i></div>
      <h1 class="lq-q">${esc(q.q)}</h1>
      <div class="lq-opts ${q.options.length > 4 ? 'six' : ''}" id="lq-opts">${q.options
        .map((o, i) => `<div class="lq-opt" data-i="${i}" style="--c:${OPTION_COLORS[i]}"><span class="lq-letter">${LETTERS[i]}</span><span class="lq-text">${esc(o)}</span><span class="lq-count"></span></div>`)
        .join('')}</div>
      <div class="lq-foot" id="lq-foot"></div>
      <div class="lq-fastest hidden" id="lq-fastest"></div>`;
  }
  const opts = [...root.querySelectorAll('.lq-opt')];
  const vote = q.kind === 'vote';
  if (q.status === 'open') {
    $('#lq-foot').textContent = `${fmt(q.answered)} of ${fmt(q.players)} ${vote ? 'have voted' : 'answered'}…`;
  } else {
    const counts = q.result.counts;
    const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
    const top = Math.max(0, ...counts);
    opts.forEach((o, i) => {
      const share = Math.round((counts[i] / total) * 100);
      o.style.setProperty('--share', `${share}%`);
      o.classList.toggle('voted', vote);
      o.classList.toggle('lead', vote && top > 0 && counts[i] === top);
      o.classList.toggle('correct', !vote && i === q.answer);
      o.classList.toggle('dim', vote ? top > 0 && counts[i] < top : i !== q.answer);
      o.querySelector('.lq-count').textContent = `${counts[i]} · ${share}%`;
    });
    const f = $('#lq-fastest');
    f.classList.remove('hidden');
    if (vote) {
      const winners = q.options.filter((_, i) => top > 0 && counts[i] === top);
      $('#lq-foot').textContent = `${fmt(q.answered)} vote${q.answered === 1 ? '' : 's'}`;
      f.innerHTML = winners.length
        ? `<span class="lq-fl">📊 The room has spoken</span><span class="lq-fp">${winners.map(esc).join(' & ')} <small>${Math.round((top / total) * 100)}%</small></span>`
        : '<span class="lq-fl">No votes came in</span>';
    } else {
      $('#lq-foot').textContent = `${q.result.correctCount} of ${fmt(q.answered)} got it right`;
      f.innerHTML = q.result.fastest.length
        ? `<span class="lq-fl">⚡ Fastest</span>${q.result.fastest
            .map((p, i) => `<span class="lq-fp">${MEDALS[i] || i + 1} ${withEmoji(p)} <small>${(p.ms / 1000).toFixed(1)}s · +${p.points}</small></span>`)
            .join('')}`
        : '<span class="lq-fl">Nobody got it — tough one!</span>';
    }
  }
  tickLiveClock();
}

function tickLiveClock() {
  if (!live || live.status === 'idle') return;
  const clock = $('#lq-clock');
  const bar = $('#lq-bar');
  if (!clock) return;
  if (live.status === 'closed') {
    clock.textContent = 'Time’s up';
    clock.classList.remove('urgent');
    bar.style.width = '0%';
    return;
  }
  const left = Math.max(0, live.remainingMs - (performance.now() - liveAt));
  const sec = Math.ceil(left / 1000);
  clock.textContent = `${sec}s`;
  clock.classList.toggle('urgent', left < 5500);
  if (left > 0 && sec <= 5 && sec !== liveBeepSec) {
    liveBeepSec = sec;
    sfx.tick();
  }
  bar.style.width = `${(left / live.limitMs) * 100}%`;
}
setInterval(tickLiveClock, 100);

// ------------------------------------------------------------------ lucky draw (overlay)

async function runDraw(d) {
  if (drawing) return;
  drawing = true;
  const root = $('#draw-overlay');
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="draw">
      <h2>🎡 Lucky Draw${d.no > 1 ? ` · #${d.no}` : ''}</h2>
      <div class="wheel-wrap"><div class="wheel-pointer">▼</div><canvas id="wheel" width="1000" height="1000"></canvas><div class="wheel-center" id="wheel-center">🎡</div></div>
      <div class="draw-winner" id="draw-winner"><small>${fmt(d.pool)} in the draw…</small></div>
    </div>`;
  const names = d.names.length ? d.names : [d.winner];
  const wi = Math.max(0, names.findIndex((n) => n.id === d.winner.id));
  const n = names.length;
  const seg = (Math.PI * 2) / n;
  const canvas = $('#wheel');
  const ctx = canvas.getContext('2d');
  const R = 480, cx = 500, cy = 500;
  const label = (p) => (n > 30 ? initials(p.name) : p.name.split(' ')[0]);
  function draw(theta) {
    ctx.clearRect(0, 0, 1000, 1000);
    for (let i = 0; i < n; i++) {
      const a0 = theta + i * seg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = `hsl(${(i * 360) / n} 70% ${i % 2 ? 40 : 50}%)`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${n > 30 ? 30 : n > 16 ? 32 : 42}px system-ui, sans-serif`;
      ctx.fillText(label(names[i]), R - 26, 0, R * 0.6);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 72, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f1a';
    ctx.fill();
    ctx.strokeStyle = '#f7c548';
    ctx.lineWidth = 8;
    ctx.stroke();
  }
  // Pointer is at 12 o'clock (angle −π/2). Which segment sits under it for a given rotation?
  const underPointer = (theta) => Math.floor(((((-Math.PI / 2 - theta) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / seg) % n;
  const target = -Math.PI / 2 - (wi + 0.5) * seg - Math.PI * 2 * 6; // six full turns, then the winner lands under the pointer
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const T = reduced ? 400 : 7000;
  const t0 = performance.now();
  let lastIdx = -1;
  let spinning = true;
  sfx.drumroll(1.6);
  // Frames via rAF, but the reveal runs on a timer so a throttled tab can't leave the wheel spinning forever.
  (function frame(now) {
    if (!spinning) return;
    const p = Math.min(1, (now - t0) / T);
    const theta = target * (1 - Math.pow(1 - p, 3));
    draw(theta);
    const idx = underPointer(theta);
    if (idx !== lastIdx) {
      lastIdx = idx;
      $('#wheel-center').textContent = initials(names[idx].name);
      if (p < 0.97) sfx.tick();
    }
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
  await sleep(T + 60);
  spinning = false;
  draw(target);
  $('#wheel-center').textContent = '🎉';
  sfx.crash();
  sfx.cheer(4, 0.2);
  $('#draw-winner').innerHTML = `<small>And the winner is…</small><div class="draw-photo"><img src="${photoUrl(d.winner.name)}" alt="" onerror="this.parentElement.remove()"></div><b>${withEmoji(d.winner)}</b>${d.winner.business ? `<span>${esc(d.winner.business)}</span>` : ''}`;
  sfx.win();
  confetti({ duration: 6000, count: 260 });
  await sleep(14000);
  root.classList.add('hidden');
  drawing = false;
}

// ------------------------------------------------------------------ socket

function onBoard(p) {
  setHeader(p);
  battleTeams = p.teamBattle?.teams || [];
  if ('teamsBoard' in p) teamsBoard = p.teamsBoard || [];
  renderStandings();
  if (p.live && !live) onLive(p.live); // first load while a question is up
  if (p.mode === 'hidden') return setMode('hidden');
  if (p.mode === 'reveal') {
    if (!revealing && p.reveal && p.reveal.at !== shownRevealAt) renderRevealFinal(p.reveal);
    if (!revealing) setMode('reveal');
    return;
  }
  if (revealing) return;
  setMode('live');
  renderBoard(p.top || []);
  renderPlaying(p.playing || []);
  renderChampions(p.leaders || []);
  renderChapters(p.chapters || []);
  if (!feedSeeded) {
    feedSeeded = true;
    const feed = $('#feed');
    feed.innerHTML = '';
    if (p.recent?.length) [...p.recent].reverse().forEach((a) => addActivity(a, false));
    else feed.innerHTML = '<li class="empty-feed">Scores will appear here as people play…</li>';
  }
}

function renderGamesHead() {
  $('#games-head').innerHTML = chipGames().map((g) => `<span title="${esc(g.name)}">${g.emoji}</span>`).join('');
  $('#games-head').classList.toggle('many', chipGames().length > 6);
}

/** Re-read the game list and settings — the server was redeployed or we reconnected, and the order or titles may have changed. */
async function refreshGames() {
  try {
    const st = await api('/api/state');
    games = st.games;
    setHeader(st.settings);
    renderGamesHead(); // rows pick up the new column order on the next board update, which follows a connect
  } catch { /* keep what we have */ }
}

async function boot() {
  const st = await api('/api/state');
  games = st.games;
  setHeader(st.settings);
  const qr = apiUrl(`/api/qr.svg?t=${Date.now()}`);
  document.querySelectorAll('img.qr').forEach((img) => (img.src = qr));
  renderGamesHead();

  const socket = connectSocket({ role: 'screen' });
  let connects = 0;
  socket.on('connect', () => {
    $('#live-pill').classList.remove('off');
    $('#live-text').textContent = 'LIVE';
    if (connects++ > 0) refreshGames(); // a reconnect usually means a redeploy: never show a stale game order
  });
  socket.on('disconnect', () => {
    $('#live-pill').classList.add('off');
    $('#live-text').textContent = 'RECONNECTING';
  });
  socket.on('board', onBoard);
  socket.on('settings', (s) => setHeader(s));
  socket.on('activity', (a) => addActivity(a));
  socket.on('leader', showLeader);
  socket.on('reveal', runReveal);
  socket.on('round', onRound);
  socket.on('livequiz', onLive);
  socket.on('luckydraw', runDraw);
  const clearBoard = () => {
    for (const r of rows.values()) r.el.remove();
    rows.clear();
    feedSeeded = false;
    shownRevealAt = null;
    battleTeams = [];
    teamsBoard = [];
    battleRound = null;
    live = null;
    for (const id of ['battle-overlay', 'quiz-overlay']) $(`#${id}`).classList.add('hidden');
    renderStandings();
    renderPlaying([]);
  };
  socket.on('reset', clearBoard);
  socket.on('scoresReset', clearBoard); // the next board update repopulates teams and standings
}

// Browsers only allow sound after a click or key press. M mutes/unmutes, F toggles fullscreen.
function soundHint() {
  const el = $('#sound-hint');
  if (el) el.textContent = sfx.muted ? '🔇 Sound off · press M to unmute · F for fullscreen' : '🔊 Sound on · press M to mute · F for fullscreen';
}
document.addEventListener('click', () => {
  sfx.unlock();
  soundHint();
}, { once: true });
$('#sound-hint').addEventListener('click', () => {
  sfx.unlock();
  sfx.muted = false;
  soundHint();
  sfx.good();
});
document.addEventListener('keydown', (e) => {
  sfx.unlock();
  const k = e.key.toLowerCase();
  if (k === 'm') {
    sfx.muted = !sfx.muted;
    soundHint();
    if (!sfx.muted) sfx.good();
  }
  if (k !== 'f') return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

boot();
