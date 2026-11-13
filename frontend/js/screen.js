// Big-screen live leaderboard: live board with animated re-ranking, hidden mode, the grand
// reveal — and the hosted moments (team tap battle, live quiz, lucky draw) as overlays on top,
// so the screen never leaves the live board.
import { api, apiUrl, connectSocket, esc, fmt, initials, hue, countUp, sfx, confetti, sleep, photoUrl, timers } from './common.js';

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
let raceIds = null; // game ids of the current "race" (only some games open), or null for the overall board
const chipGames = () => games.filter((g) => !g.hosted && (!raceIds || raceIds.includes(g.id)));
// Per-game columns fit up to ~9 games; beyond that they'd push the sidebar off any screen,
// so the board shows rank/name/total only and the per-game detail stays in Game champions.
const chipCols = () => {
  const cols = chipGames();
  return cols.length <= 9 ? cols : [];
};
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
  const cols = chipCols();
  chips.classList.toggle('many', cols.length > 6);
  chips.innerHTML = cols
    .map((g) => {
      const v = g.id === 'network' ? e.connections || null : e.scores[g.id]; // connections are a count, not points
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
/** The "only these games are open" banner over the board; the board then shows their points only. */
function syncRace(race) {
  const next = race && race.length ? race : null;
  if (JSON.stringify(next) !== JSON.stringify(raceIds)) {
    raceIds = next;
    renderGamesHead();
  }
  const el = $('#race-pill');
  if (!raceIds) return el.classList.add('hidden');
  const open = raceIds.map((id) => gameById(id)).filter(Boolean);
  el.innerHTML = `<i></i><span>NOW PLAYING: <b>${open.map((g) => `${g.emoji} ${esc(g.name)}`).join(' · ')}</b> — this board counts ${open.length === 1 ? 'this game' : 'these games'} only</span>`;
  el.classList.remove('hidden');
}

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
  // Only games someone has actually played — 16 placeholder rows would crowd out the feed.
  const crowned = leaders.filter((l) => l.name && gameById(l.gameId));
  $('#champions').innerHTML = crowned.length
    ? crowned
        .map((l) => {
          const g = gameById(l.gameId);
          return `<li><span class="ce">${g.emoji}</span>
            <span class="cn"><b>${esc(l.name)}</b><small>${esc(g.name)}</small></span>
            <span class="cs">${fmt(l.score)}${l.gameId === 'network' ? ' 🤝' : ''}</span></li>`;
        })
        .join('')
    : '<li class="champ-empty">Champions appear as games are played…</li>';
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
    ? `<span class="fe">🔗</span><span class="ft"><b>${esc(a.name)}</b> connected with <b>${esc(a.with)}</b> 🤝${a.count ? ` · <b>${fmt(a.count)}</b> built` : ''}</span>`
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

// ------------------------------------------------------------------ game demos (the intro's "watch it being played")
// A phone mockup with a ghost finger 👆 that plays a scripted round of the game, on loop,
// so the room SEES how to play before the game unlocks. One little demo per game.

let demoT = null; // timers of the demo currently running

const drand = (n) => Math.floor(Math.random() * n);

/** Glide the finger onto `target` and tap it, then call `done`. */
function demoTap(finger, target, T, done, travel = 450) {
  if (!target || !target.isConnected) return;
  const p = finger.parentElement.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  finger.classList.remove('hidden');
  finger.style.left = `${r.left - p.left + r.width / 2}px`;
  finger.style.top = `${r.top - p.top + r.height / 2}px`;
  T.after(() => {
    finger.classList.add('tap');
    if (target.isConnected) target.classList.add('demo-hit');
    T.after(() => {
      finger.classList.remove('tap');
      target.classList.remove('demo-hit');
      done?.();
    }, 260);
  }, travel);
}

/** A floating "+20"-style pop at the target. */
function demoFloat(screen, target, text, gold = false) {
  if (!target.isConnected) return;
  const h = screen.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const f = document.createElement('span');
  f.className = `demo-float${gold ? ' gold' : ''}`;
  f.textContent = text;
  f.style.left = `${r.left - h.left + r.width / 2}px`;
  f.style.top = `${r.top - h.top}px`;
  screen.appendChild(f);
  setTimeout(() => f.remove(), 800);
}

/** Prompt + options, finger taps the right one, repeat — covers all the quiz-style games. */
function quizDemo(d, makeRound) {
  const round = () => {
    const q = makeRound();
    d.screen.innerHTML = `${q.cap ? `<div class="dq-cap">${q.cap}</div>` : ''}
      ${q.prompt ? `<div class="dq-prompt ${q.cls || ''}">${q.prompt}</div>` : ''}
      <div class="dq-opts ${q.grid ? 'grid' : ''}">${q.options
        .map((o, i) => `<button class="dq-opt" ${q.styles?.[i] ? `style="background:${q.styles[i]}"` : ''} data-i="${i}">${o}</button>`)
        .join('')}</div>`;
    const t = d.screen.querySelector(`[data-i="${q.correct}"]`);
    d.T.after(() => demoTap(d.finger, t, d.T, () => {
      t.classList.add('good');
      demoFloat(d.screen, t, q.pts || '+35');
      d.T.after(round, 1000);
    }), 650);
  };
  round();
}

const DEMOS = {
  frenzy(d) {
    d.screen.innerHTML = `<div class="dq-cap">Tap as fast as you can!</div><div class="dfz"><button class="dfz-btn"><b>0</b><small>taps</small></button></div>`;
    const btn = d.screen.querySelector('.dfz-btn');
    const b = btn.querySelector('b');
    let n = 0;
    const go = () => demoTap(d.finger, btn, d.T, () => {
      b.textContent = ++n;
      demoFloat(d.screen, btn, '+7');
      d.T.after(go, 90);
    }, n ? 40 : 450);
    go();
  },
  rush(d) {
    d.screen.innerHTML = `<div class="dq-cap">Tap 🤝⭐ · dodge 👻</div><div class="dru">${'<div class="dru-h"></div>'.repeat(9)}</div>`;
    const holes = [...d.screen.querySelectorAll('.dru-h')];
    const script = [
      { i: 1, e: '🤝', pts: '+20', tap: 1 },
      { i: 5, e: '👻', tap: 0 },
      { i: 3, e: '⭐', pts: '+50', tap: 1, gold: 1 },
      { i: 7, e: '🤝', pts: '+20', tap: 1 },
    ];
    let k = 0;
    const step = () => {
      const s = script[k++ % script.length];
      const h = holes[s.i];
      h.textContent = s.e;
      h.classList.add('up');
      if (s.tap) {
        demoTap(d.finger, h, d.T, () => {
          demoFloat(d.screen, h, s.pts, s.gold);
          h.classList.remove('up');
          h.textContent = '';
          d.T.after(step, 450);
        });
      } else {
        demoFloat(d.screen, h, 'leave it!', false);
        d.T.after(() => { h.classList.remove('up'); h.textContent = ''; step(); }, 1100);
      }
    };
    step();
  },
  reflex(d) {
    d.screen.innerHTML = `<div class="drx wait"><b>Wait…</b><small>tap the moment it turns GREEN</small></div>`;
    const pad = d.screen.firstElementChild;
    const loop = () => {
      pad.className = 'drx wait';
      pad.innerHTML = '<b>Wait…</b><small>tap the moment it turns GREEN</small>';
      d.T.after(() => {
        pad.className = 'drx go';
        pad.innerHTML = '<b>TAP!</b>';
        demoTap(d.finger, pad, d.T, () => {
          pad.className = 'drx res';
          pad.innerHTML = '<b>238 ms</b><small>⚡ Lightning fast!</small>';
          d.T.after(loop, 1400);
        }, 300);
      }, 1400);
    };
    loop();
  },
  memory(d) {
    d.screen.innerHTML = `<div class="dq-cap">Find the pairs!</div><div class="dmem">${['🤝', '⭐', '⭐', '🤝']
      .map((e) => `<button class="dmem-c" data-e="${e}">❓</button>`)
      .join('')}</div>`;
    const c = [...d.screen.querySelectorAll('.dmem-c')];
    const flip = (x) => { x.textContent = x.dataset.e; x.classList.add('open'); };
    const loop = () => {
      c.forEach((x) => { x.textContent = '❓'; x.classList.remove('open', 'won'); });
      d.T.after(() => demoTap(d.finger, c[0], d.T, () => {
        flip(c[0]);
        demoTap(d.finger, c[3], d.T, () => {
          flip(c[3]);
          c[0].classList.add('won');
          c[3].classList.add('won');
          demoFloat(d.screen, c[3], 'Pair! ✓');
          demoTap(d.finger, c[1], d.T, () => {
            flip(c[1]);
            demoTap(d.finger, c[2], d.T, () => {
              flip(c[2]);
              c[1].classList.add('won');
              c[2].classList.add('won');
              demoFloat(d.screen, c[2], 'Pair! ✓');
              d.T.after(loop, 1300);
            });
          });
        });
      }), 500);
    };
    loop();
  },
  colors(d) {
    const C = [['RED', '#ef4444'], ['BLUE', '#3b82f6'], ['GREEN', '#22c55e'], ['YELLOW', '#facc15']];
    quizDemo(d, () => {
      const w = drand(4);
      let ink = drand(4);
      if (ink === w) ink = (ink + 1) % 4;
      return { cap: 'Tap the INK colour — not the word!', prompt: `<span style="color:${C[ink][1]}">${C[w][0]}</span>`, cls: 'big', options: C.map((x) => x[0]), styles: C.map((x) => x[1]), correct: ink, pts: '+30' };
    });
  },
  simon(d) {
    d.screen.innerHTML = `<div class="dq-cap">Watch the pattern, repeat it!</div><div class="dsim">${['#e3263a', '#3b82f6', '#22c55e', '#facc15']
      .map((c) => `<button class="dsim-p" style="--c:${c}"></button>`)
      .join('')}</div>`;
    const pads = [...d.screen.querySelectorAll('.dsim-p')];
    const seq = [0, 2, 1];
    const flash = (i, done) => {
      pads[i].classList.add('lit');
      d.T.after(() => { pads[i].classList.remove('lit'); d.T.after(done, 170); }, 380);
    };
    const loop = () => {
      let k = 0;
      const show = () => (k < seq.length ? flash(seq[k++], show) : repeat(0));
      const repeat = (j) =>
        j < seq.length
          ? demoTap(d.finger, pads[seq[j]], d.T, () => {
              pads[seq[j]].classList.add('lit');
              d.T.after(() => { pads[seq[j]].classList.remove('lit'); repeat(j + 1); }, 240);
            })
          : (demoFloat(d.screen, pads[2], 'Level up! ✓'), d.T.after(loop, 1200));
      show();
    };
    loop();
  },
  odd(d) {
    quizDemo(d, () => {
      const pair = [['😀', '😎'], ['🐶', '🐱'], ['🍏', '🍐']][drand(3)];
      const ci = drand(8);
      return { cap: 'One is different — tap it!', options: Array.from({ length: 8 }, (_, i) => (i === ci ? pair[1] : pair[0])), correct: ci, grid: true };
    });
  },
  pictionary(d) {
    const P = [['🦷🪥', 'Dentist'], ['📸💒', 'Photographer'], ['🏠📐', 'Architect'], ['⚖️👔', 'Lawyer']];
    quizDemo(d, () => {
      const [emoji, who] = P[drand(P.length)];
      const others = P.filter((x) => x[1] !== who).map((x) => x[1]);
      const correct = drand(4);
      const options = [...others];
      options.splice(correct, 0, who);
      return { cap: 'Guess the profession!', prompt: emoji, cls: 'big', options, correct, pts: '+90' };
    });
  },
  math(d) {
    quizDemo(d, () => {
      const a = 3 + drand(9);
      const b = 2 + drand(8);
      const ans = a + b;
      const correct = drand(4);
      const options = [ans - 2, ans + 1, ans + 3].slice(0, 3);
      options.splice(correct, 0, ans);
      return { cap: 'Tap the right answer!', prompt: `${a} + ${b} = ?`, cls: 'big', options, correct };
    });
  },
  timing(d) {
    d.screen.innerHTML = `<div class="drx idle"><b>0.00</b><small>Stop it on exactly 5.00!</small></div>`;
    const pad = d.screen.firstElementChild;
    const b = pad.querySelector('b');
    const sm = pad.querySelector('small');
    const loop = () => {
      pad.className = 'drx idle';
      sm.textContent = 'Stop it on exactly 5.00!';
      let s = 0;
      const tick = () => {
        s += 0.17;
        if (s < 2) {
          b.textContent = s.toFixed(2);
          d.T.after(tick, 60);
        } else {
          b.textContent = '🙈';
          sm.textContent = 'Keep counting in your head…';
          d.T.after(() => demoTap(d.finger, pad, d.T, () => {
            pad.className = 'drx res';
            b.textContent = '4.93';
            sm.textContent = '70 ms early · 🔥 Sharp!';
            d.T.after(loop, 1500);
          }), 1200);
        }
      };
      b.textContent = '0.00';
      tick();
    };
    loop();
  },
  hunt(d) {
    d.screen.innerHTML = `<div class="dq-cap">Tap 1, 2, 3… in order — fast!</div><div class="dhunt">${[3, 1, 4, 2, 6, 5, 8, 7]
      .map((n) => `<button class="dhunt-c" data-n="${n}">${n}</button>`)
      .join('')}</div>`;
    const cell = (n) => d.screen.querySelector(`[data-n="${n}"]`);
    const loop = (n) => {
      if (n > 4) {
        d.T.after(() => {
          d.screen.querySelectorAll('.dhunt-c').forEach((x) => x.classList.remove('found'));
          loop(1);
        }, 1100);
        return;
      }
      demoTap(d.finger, cell(n), d.T, () => { cell(n).classList.add('found'); loop(n + 1); });
    };
    loop(1);
  },
  balloons(d) {
    d.screen.innerHTML = `<div class="dq-cap">Pop everything you can!</div><div class="dbal-sky"></div>`;
    const sky = d.screen.querySelector('.dbal-sky');
    const colors = ['#f43f5e', '#3b82f6', '#22c55e', '#a855f7'];
    const spawn = (x, tap) => {
      const b = document.createElement('div');
      b.className = 'dbal';
      b.style.left = `${x}%`;
      b.style.setProperty('--c', colors[drand(4)]);
      sky.appendChild(b);
      setTimeout(() => b.remove(), 3600);
      if (tap) d.T.after(() => demoTap(d.finger, b, d.T, () => { demoFloat(sky, b, '+20'); b.remove(); }, 250), 1100);
    };
    const loop = () => {
      spawn(15 + drand(25), false);
      d.T.after(() => spawn(55 + drand(25), true), 400);
      d.T.after(loop, 1700);
    };
    loop();
  },
  bullseye(d) {
    d.screen.innerHTML = `<div class="dq-cap">Stop the marker in the middle!</div><div class="dbe"><div class="dbe-bar"><div class="dbe-m"></div></div><div class="dbe-res"></div></div>`;
    const m = d.screen.querySelector('.dbe-m');
    const res = d.screen.querySelector('.dbe-res');
    const loop = () => {
      m.classList.remove('stop');
      res.textContent = '';
      d.T.after(() => demoTap(d.finger, m.parentElement, d.T, () => {
        m.classList.add('stop');
        res.textContent = '🎯 BULLSEYE +100';
        d.T.after(loop, 1500);
      }, 300), 1700);
    };
    loop();
  },
  cups(d) {
    d.screen.innerHTML = `<div class="dq-cap">Keep your eye on the 💰!</div><div class="dcup"><div class="dcup-m" style="--s:1">💰</div>${[0, 1, 2]
      .map((i) => `<div class="dcup-c" style="--s:${i}">💼</div>`)
      .join('')}</div>`;
    const cs = [...d.screen.querySelectorAll('.dcup-c')];
    const money = d.screen.querySelector('.dcup-m');
    const win = cs[1]; // this case hides the money, wherever it slides to
    const slot = (c) => Number(c.style.getPropertyValue('--s'));
    const swap = (a, b, done) => {
      const sa = slot(a);
      a.style.setProperty('--s', slot(b));
      b.style.setProperty('--s', sa);
      d.T.after(done, 520);
    };
    const loop = () => {
      cs.forEach((c) => c.classList.remove('up'));
      money.style.setProperty('--s', slot(win));
      money.classList.add('show');
      win.classList.add('up');
      d.T.after(() => {
        win.classList.remove('up');
        money.classList.remove('show');
        d.T.after(() => swap(win, cs[0], () => swap(win, cs[2], () => {
          d.T.after(() => demoTap(d.finger, win, d.T, () => {
            money.style.setProperty('--s', slot(win));
            money.classList.add('show');
            win.classList.add('up');
            demoFloat(d.screen, win, '+200', true);
            d.T.after(loop, 1600);
          }), 400);
        })), 350);
      }, 1000);
    };
    loop();
  },
  higher(d) {
    const face = (v) => (v === 1 ? 'A' : v === 11 ? 'J' : v === 12 ? 'Q' : v === 13 ? 'K' : v);
    d.screen.innerHTML = `<div class="dq-cap">Higher or lower?</div><div class="dhl"><b>8</b><span>♠</span></div>
      <div class="dq-opts"><button class="dq-opt hi">⬆ HIGHER</button><button class="dq-opt lo">⬇ LOWER</button></div>`;
    const card = d.screen.querySelector('.dhl');
    let v = 8;
    const loop = () => {
      const goHi = v <= 7;
      const btn = d.screen.querySelector(goHi ? '.hi' : '.lo');
      d.T.after(() => demoTap(d.finger, btn, d.T, () => {
        v = goHi ? v + 1 + drand(13 - v) : 1 + drand(v - 1);
        const red = Math.random() < 0.5;
        card.innerHTML = `<b>${face(v)}</b><span>${red ? '♥' : '♠'}</span>`;
        card.classList.toggle('red', red);
        demoFloat(d.screen, card, '+60');
        d.T.after(loop, 900);
      }), 650);
    };
    loop();
  },
};

function startDemo(gi) {
  stopDemo();
  demoT = timers();
  const screen = $('#demo-screen');
  const finger = $('#demo-finger');
  finger.classList.add('hidden');
  const demo = DEMOS[gi.gameId];
  if (demo) demo({ screen, finger, T: demoT });
  else screen.innerHTML = `<div class="demo-fallback">${gi.emoji}</div>`;
}

function stopDemo() {
  if (demoT) demoT.clear();
  demoT = null;
}

// ------------------------------------------------------------------ game intro (overlay)

let introTimer = null;
let introHideTimer = null;

/** The admin opened a game: show it being played on a phone mockup, count down, then "GO!". */
function showIntro(gi) {
  clearTimeout(introHideTimer); // a new intro cancels the previous one's fade-out
  for (const id of ['battle-overlay', 'quiz-overlay']) $(`#${id}`).classList.add('hidden');
  const root = $('#intro-overlay');
  root.innerHTML = `
    <div class="gintro" style="--accent:${gi.color}">
      <div class="gintro-info">
        <p class="gintro-up">🎮 Next game</p>
        <h2>${gi.emoji} ${esc(gi.name)}</h2>
        <p class="gintro-tag">${esc(gi.tagline)}</p>
        <ul class="gintro-how">${gi.howTo.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
        <div class="gintro-count" id="gintro-count"></div>
      </div>
      <div class="demo-phone"><i class="demo-notch"></i><div class="demo-screen" id="demo-screen"></div><span class="demo-finger hidden" id="demo-finger">👆</span></div>
    </div>`;
  root.classList.remove('hidden');
  startDemo(gi); // the phone mockup plays the game on loop while the room reads along
  sfx.rise();
  clearInterval(introTimer);
  let last = null;
  introTimer = setInterval(() => {
    const left = Math.ceil((gi.opensAt - Date.now()) / 1000);
    if (left > 0) {
      if (left !== last) {
        last = left;
        $('#gintro-count').innerHTML = `Opens on your phones in <b>${left}</b>…`;
        if (left <= 5) sfx.tick();
      }
      return;
    }
    clearInterval(introTimer);
    introTimer = null;
    $('#gintro-count').innerHTML = `<b class="go">GO — play on your phones! 📱</b>`;
    sfx.go();
    sfx.whoosh(0.1);
    confetti({ duration: 1500, count: 90 });
    introHideTimer = setTimeout(() => {
      root.classList.add('hidden');
      stopDemo();
    }, 3500);
  }, 150);
}

// ------------------------------------------------------------------ game champion (overlay)

let crowning = false;

/** The admin ended a game: a drumroll, then its champion (best single try) with a podium. */
async function crownGame(w) {
  if (crowning) return;
  crowning = true;
  for (const id of ['battle-overlay', 'quiz-overlay']) $(`#${id}`).classList.add('hidden');
  const root = $('#winner-overlay');
  const [first, second, third] = w.podium;
  root.innerHTML = `
    <div class="crown" style="--accent:${w.color}">
      <h2><span class="crown-game">${w.emoji} ${esc(w.name)}</span> · FINAL</h2>
      <div class="crown-drum" id="crown-drum">And the champion is…</div>
      <div class="crown-winner hidden" id="crown-winner">
        <small>🏆 Champion</small>
        <div class="draw-photo"><img src="${photoUrl(first.name)}" alt="" onerror="this.parentElement.remove()"></div>
        <b>${withEmoji(first)}</b>
        ${first.business ? `<span>${esc(first.business)}</span>` : ''}
        <div class="crown-score">${fmt(first.score)} pts</div>
      </div>
      <ul class="crown-podium hidden" id="crown-podium">
        ${second ? `<li>🥈 ${withEmoji(second)} · ${fmt(second.score)}</li>` : ''}
        ${third ? `<li>🥉 ${withEmoji(third)} · ${fmt(third.score)}</li>` : ''}
      </ul>
    </div>`;
  root.classList.remove('hidden');
  sfx.drumroll(2.2);
  await sleep(2500);
  $('#crown-drum').classList.add('hidden');
  $('#crown-winner').classList.remove('hidden');
  $('#crown-podium').classList.remove('hidden');
  sfx.crash();
  sfx.cheer(4, 0.2);
  confetti({ duration: 6000, count: 240 });
  await sleep(13000);
  root.classList.add('hidden');
  crowning = false;
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
  syncRace(p.race);
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
  const cols = chipCols();
  $('#games-head').innerHTML = cols.map((g) => `<span title="${esc(g.name)}">${g.emoji}</span>`).join('');
  $('#games-head').classList.toggle('many', cols.length > 6);
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
  socket.on('gamewinner', crownGame);
  socket.on('gameintro', showIntro);
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
