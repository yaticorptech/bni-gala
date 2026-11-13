import { api, apiUrl, withRetry, connectSocket, getToken, setToken, clearToken, toast, sfx, esc, fmt, countUp, sleep, confetti, abortError, vibrate, photoUrl, initials, hue } from './common.js';
import rush from './games/rush.js';
import reflex from './games/reflex.js';
import colors from './games/colors.js';
import pictionary from './games/pictionary.js';
import frenzy from './games/frenzy.js';
import math from './games/math.js';
import timing from './games/timing.js';
import hunt from './games/hunt.js';
import balloons from './games/balloons.js';
import bullseye from './games/bullseye.js';

const MODULES = { rush, reflex, colors, pictionary, frenzy, math, timing, hunt, balloons, bullseye };
const VIEWS = ['boot', 'join', 'hub', 'game', 'result', 'tap', 'quiz', 'spin', 'connect', 'profile'];
const $ = (sel, root = document) => root.querySelector(sel);

const S = {
  settings: null,
  games: [],
  me: null, // { player, games, teamDetail, total, rank, ranked, hidden, top, team, above }
  view: 'boot',
  joinTab: 'register', // which door the join view shows — new players first
  prefillPhone: '', // carried from a failed login into the register form
  round: null, // Team Tap Battle round state from the server
  roundAt: 0, // performance.now() when `round` arrived — timers run from there
  live: null, // Live Quiz question on the big screen
  liveAt: 0,
  connect: null, // my Power Connections detail (code, points, members met)
  pendingConnect: '', // a code that arrived via /#c=… before login finished
};
let socket = null;

// ------------------------------------------------------------------ helpers

function show(view) {
  S.view = view;
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('hidden', v !== view);
  window.scrollTo(0, 0);
}

const gameById = (id) => S.games.find((g) => g.id === id);

function accentFg(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 160 ? '#1d1503' : '#fff';
}

function applyTitle() {
  document.title = `${S.settings.eventTitle} · Games`;
}

async function refreshMe() {
  S.me = await api('/api/me');
  return S.me;
}

function signedOut(msg) {
  clearToken();
  S.me = null;
  connect();
  renderJoin();
  show('join');
  if (msg) toast(msg);
}

/**
 * Yes/no dialog. Resolves false on cancel; on OK it resolves an object of the values of any
 * named inputs/selects in `html` (an empty object when there are none) — always truthy.
 */
function modal({ title, html, ok = 'OK', cancel = 'Cancel' }) {
  const el = $('#modal');
  el.innerHTML = `
    <div class="modal-box">
      <h3>${title}</h3>
      ${html}
      <div class="modal-actions">
        ${cancel === false ? '' : `<button class="btn btn-ghost" data-act="no">${esc(cancel)}</button>`}
        <button class="btn btn-primary" data-act="yes">${esc(ok)}</button>
      </div>
    </div>`;
  el.classList.remove('hidden');
  el.querySelector('input, select')?.focus();
  return new Promise((resolve) => {
    const close = (yes) => {
      const values = yes ? Object.fromEntries([...el.querySelectorAll('input[name], select[name]')].map((i) => [i.name, i.value])) : false;
      el.classList.add('hidden');
      el.innerHTML = '';
      el.onclick = null;
      resolve(values);
    };
    el.onclick = (e) => {
      if (e.target === el) return close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) close(act === 'yes');
    };
  });
}

// ------------------------------------------------------------------ join (login / register)

function chapterFieldHtml() {
  const s = S.settings;
  if (s.chapters.length) {
    return `<label class="field"><span>Your BNI chapter *</span>
      <select name="chapter" required><option value="">Select your chapter</option>${s.chapters.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>`;
  }
  // Chapters are always picked from a dropdown — no list yet means registration waits.
  return `<label class="field"><span>Your BNI chapter *</span>
    <select name="chapter" required disabled><option value="">Chapter list coming soon…</option></select></label>`;
}

function renderJoin() {
  const s = S.settings;
  const login = S.joinTab === 'login'; // "New player" is the default tab — most guests are registering
  const canSubmit = login || s.chapters.length > 0; // registering needs the chapter dropdown filled in
  const phoneField = `<label class="field"><span>Your mobile number *</span>
        <input name="phone" type="tel" inputmode="numeric" autocomplete="tel" required maxlength="10" pattern="[0-9]{10}" placeholder="10-digit number" value="${esc(S.prefillPhone)}"></label>`;
  const fields = login
    ? phoneField
    : `${chapterFieldHtml()}
      <label class="field"><span>Your name *</span>
        <input name="name" required minlength="2" maxlength="40" placeholder="e.g. Priya Sharma" autocomplete="name"></label>
      ${phoneField}
      <label class="field"><span>Business / category *</span>
        <input name="business" required maxlength="60" placeholder="e.g. Interior Designer" autocomplete="organization"></label>`;
  $('#view-join').innerHTML = `
    <div class="hero">
      <div class="hero-badge">🏆</div>
      <h1>${esc(s.eventTitle)}</h1>
      <p class="hero-sub">${esc(s.tagline)}</p>
      <div class="hero-games">${S.games.map((g) => `<span title="${esc(g.name)}">${g.emoji}</span>`).join('')}</div>
    </div>
    <div class="card form">
      <div class="seg join-tabs">
        <button type="button" data-tab="login" class="${login ? 'on' : ''}">Log in</button>
        <button type="button" data-tab="register" class="${login ? '' : 'on'}">New player</button>
      </div>
      <form id="join-form" autocomplete="on" novalidate>
        ${fields}
        <button class="btn btn-primary btn-lg" type="submit" ${canSubmit ? '' : 'disabled'}>${login ? 'Log in →' : 'Let’s play →'}</button>
        <p class="fine center">${login ? 'Use the mobile number you registered with' : canSubmit ? `${S.games.filter((g) => !g.hosted && !g.bonus).length} quick games · solo and team play · watch the big screen!` : 'Registration opens once the organiser adds the chapter list — hang tight!'}</p>
      </form>
    </div>
    ${sponsorsHtml()}`;

  $('#view-join').querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      S.joinTab = b.dataset.tab;
      S.prefillPhone = $('#join-form input[name=phone]')?.value || S.prefillPhone;
      renderJoin();
    }),
  );

  // Digits only in the phone box, 10 at most — whatever gets typed or pasted.
  const phoneInput = $('#join-form input[name=phone]');
  phoneInput.addEventListener('input', () => {
    const digits = phoneInput.value.replace(/\D/g, '').slice(0, 10);
    if (phoneInput.value !== digits) phoneInput.value = digits;
  });

  const form = $('#join-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (!/^\d{10}$/.test(String(body.phone || ''))) return toast('Please enter your 10-digit mobile number');
    if (!login && String(body.name || '').trim().length < 2) return toast('Please enter your name');
    if (!login && String(body.chapter || '').trim().length < 2) return toast('Please select your BNI chapter');
    if (!login && !String(body.business || '').trim()) return toast('Please enter your business / category');
    if (login) body.loginOnly = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    sfx.unlock();
    try {
      const res = await api('/api/join', { method: 'POST', body });
      setToken(res.token);
      S.prefillPhone = '';
      connect();
      await refreshMe();
      landHome();
      toast(`Welcome${login ? ' back' : ''}, ${res.player.name.split(' ')[0]}! 👋`);
      if (S.pendingConnect) {
        submitConnect(S.pendingConnect); // they scanned a member's QR before logging in
        S.pendingConnect = '';
      }
    } catch (err) {
      if (err.code === 'NOT_REGISTERED') {
        S.joinTab = 'register';
        S.prefillPhone = body.phone;
        renderJoin();
        toast('That number isn’t registered yet — sign up below 👇');
      } else {
        toast(err.message);
        btn.disabled = false;
      }
    }
  });
}

// ------------------------------------------------------------------ hub

function rankHtml() {
  const me = S.me;
  if (me.hidden) return `<div class="label">Rank</div><div class="rank-num">🤫</div><div class="rank-of">hidden for the reveal</div>`;
  if (!me.rank) return `<div class="label">Rank</div><div class="rank-num">—</div><div class="rank-of">play to get ranked</div>`;
  return `<div class="label">Rank</div><div class="rank-num">#${me.rank}</div><div class="rank-of">of ${fmt(me.ranked)} players</div>`;
}

function miniBoardHtml() {
  const me = S.me;
  if (me.hidden) {
    return `<h3>🤫 Leaderboard hidden</h3><p class="fine">The organisers are saving the results for the grand reveal — eyes on the big screen! 👀</p>`;
  }
  if (!me.top?.length) return `<h3><span class="live-dot"></span> Live top 5</h3><p class="fine">No scores yet — be the first on the board!</p>`;
  const rows = me.top
    .map(
      (r) => `
      <div class="mini-row ${r.id === me.player.id ? 'me' : ''}">
        <div class="mini-rank">${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank}</div>
        <div class="mini-av"><img src="${photoUrl(r.name)}" alt="" onerror="this.remove()"><span>${esc(initials(r.name))}</span></div>
        <div class="mini-name">${esc(r.name)}${r.chapter ? `<small>${esc(r.chapter)}</small>` : ''}</div>
        <div class="mini-total">${fmt(r.total)}</div>
      </div>`,
    )
    .join('');
  return `<h3><span class="live-dot"></span> Live top 5</h3>${rows}`;
}

/** The sponsor logo for a prize label, e.g. "Hangyo" → its strip logo. Null when we have none. */
function prizeLogo(prize) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const p = norm(prize);
  if (!p) return null;
  const hit = (S.sponsors || []).find((x) => {
    if (!x.img) return false;
    const n = norm(x.name);
    return n === p || n.startsWith(p) || p.startsWith(n);
  });
  return hit ? hit.img : null;
}

/** The sponsor strip: logos (or styled names) gliding by on a seamless loop. */
function sponsorsHtml() {
  const list = S.sponsors || [];
  if (!list.length) return '';
  const items = list
    .map((s) => `<span class="sp-item">${s.img ? `<img src="${esc(s.img)}" alt="${esc(s.name)}" onerror="this.remove()">` : ''}<b>${esc(s.name)}</b></span>`)
    .join('');
  return `<div class="sponsors">
    <div class="sp-cap">✨ Proudly supported by</div>
    <div class="sp-mask"><div class="sp-track" style="--dur:${Math.max(14, list.length * 3)}s">${items}${items}</div></div>
  </div>`;
}

function gameCardHtml(g, mode = 'solo') {
  const s = S.settings;
  const team = mode === 'team';
  const info = team ? S.me.teamDetail?.games[g.id] : S.me.games[g.id];
  if (!info) return '';
  const open = s.playOpen && (team ? s.teamGames : s.enabledGames).includes(g.id) && (!g.social || s.networkOpen !== false);
  const done = !g.social && info.left === 0; // connections have no try limit
  const tries = g.social ? 'counts, not points' : info.left === null ? 'unlimited tries' : `${info.left} ${info.left === 1 ? 'try' : 'tries'} left`;
  const status = team
    ? info.points != null ? `<b>${fmt(info.points)}</b> team pts${info.myBest != null ? ` · my best ${fmt(info.myBest)}` : ''}` : 'No team points yet'
    : g.social
    ? S.me.connections ? `<b>${fmt(S.me.connections)}</b> connection${S.me.connections === 1 ? '' : 's'} built` : 'No connections yet'
    : info.points != null ? `<b>${fmt(info.points)}</b> pts from ${info.used} ${info.used === 1 ? 'try' : 'tries'}` : 'Not played yet';
  const cta = !open ? 'Closed' : done ? 'Done ✓' : g.social ? '🔗 Open' : info.used ? 'Again' : 'Play';
  const cls = !open ? 'is-off' : done ? 'is-done' : '';
  return `
    <button class="game-card ${cls} ${team ? 'is-team' : ''}" data-game="${g.id}" data-mode="${mode}" ${!open || done ? 'disabled' : ''}
      style="--accent:${g.color};--accent-fg:${accentFg(g.color)}">
      <div class="gc-emoji">${g.emoji}</div>
      <div>
        <div class="gc-name">${esc(g.name)}</div>
        <div class="gc-tag">${esc(g.tagline)}</div>
        <div class="gc-meta"><span>${status}</span><span class="chip">${tries}</span><span class="chip">${esc(g.duration)}</span></div>
      </div>
      <div class="gc-cta">${cta}</div>
    </button>`;
}

const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const roundActive = () => Boolean(S.round && (S.round.status === 'countdown' || S.round.status === 'running'));

/** The team home card — shown only to members already in one (the create/join pitch is off for this event). */
function teamCardHtml() {
  const brief = S.me.team;
  const det = S.me.teamDetail;
  if (!brief || !det) return '';
  const members = det.members
    .map((m) => `<span class="member-chip ${m.id === S.me.player.id ? 'me' : ''}">${esc(m.name.split(' ')[0])}${det.isCaptain && m.id === S.me.player.id ? ' ⭐' : ''}</span>`)
    .join('');
  const battle = roundActive()
    ? '<button class="btn btn-gold" id="team-join">⚡ Tap Battle is ON — Join in →</button>'
    : '';
  return `
    <section class="card team-card has-team" id="team-card" style="--accent:${brief.color}">
      <div class="team-top">
        <div>
          <div class="eyebrow">👥 Your team</div>
          <h3>${brief.emoji} ${esc(brief.name)}</h3>
        </div>
        <div class="team-standing">
          <div class="label">Team rank</div>
          <div class="rank-num">${brief.rank ? `#${brief.rank}` : '—'}</div>
          <div class="rank-of">of ${fmt(brief.teams)} team${brief.teams === 1 ? '' : 's'} · ${fmt(brief.total)} pts</div>
        </div>
      </div>
      <div class="team-members">${members}</div>
      <div class="team-foot">
        <span class="team-code">Code <b>${esc(det.code.toUpperCase())}</b></span>
        <button class="btn btn-sm" id="team-share">📤 Invite</button>
        <button class="btn btn-sm btn-ghost" id="team-browse">Standings</button>
        <button class="btn btn-sm btn-ghost" id="team-leave">Leave</button>
      </div>
      ${battle}
    </section>`;
}

function renderHub() {
  const { settings: s, me } = S;
  const first = me.player.name.split(' ')[0];
  const teamGames = S.games.filter((g) => !g.hosted && s.teamGames.includes(g.id));
  $('#view-hub').innerHTML = `
    <header class="hub-head">
      <button class="hub-id" id="profile-btn" type="button" aria-label="My profile">
        <div class="hub-photo"><img src="${photoUrl(me.player.name)}" alt="" onerror="this.parentElement.remove()"></div>
        <div><div class="eyebrow">${esc(s.eventTitle)}</div><h2>Hi, ${esc(first)} 👋</h2>
        <div class="fine">${me.player.chapter ? `🏛️ ${esc(me.player.chapter)} · ` : ''}👤 My profile ›</div></div>
      </button>
      <button class="icon-btn" id="mute-btn" aria-label="Toggle sound">${sfx.muted ? '🔇' : '🔊'}</button>
    </header>
    <section class="score-card">
      <div><div class="label">My score</div><div class="big" id="hub-total" data-value="${me.total}">${fmt(me.total)}</div></div>
      <div class="rank-box" id="hub-rank">${rankHtml()}</div>
    </section>
    ${teamCardHtml()}
    ${s.playOpen ? '' : '<div class="notice">⏸ Games are closed right now — stay tuned for the results!</div>'}
    <h3 class="sec-title">🎯 Solo games <small>every point counts for you</small></h3>
    <section class="games">${S.games.filter((g) => !g.hosted && !g.bonus).map((g) => gameCardHtml(g, 'solo')).join('')}</section>
    ${me.teamDetail && teamGames.length ? `
      <h3 class="sec-title" style="--accent:${me.team?.color || '#64748b'}">👥 Team games <small>every point counts for ${esc(me.teamDetail.name)}</small></h3>
      <section class="games" id="team-games">${teamGames.map((g) => gameCardHtml(g, 'team')).join('')}</section>` : ''}
    <section class="card mini-board" id="mini-board">${miniBoardHtml()}</section>
    ${sponsorsHtml()}
    <footer class="hub-foot">Playing as <b>${esc(me.player.name)}</b>${me.player.chapter ? ` · ${esc(me.player.chapter)}` : ''}<br>
      <button class="link" id="switch-btn">Not you? Switch player</button></footer>`;

  $('#view-hub').querySelectorAll('.game-card').forEach((el) => el.addEventListener('click', () => openGame(el.dataset.game, el.dataset.mode)));
  $('#profile-btn').onclick = () => enterProfile();
  $('#mute-btn').onclick = (e) => {
    sfx.muted = !sfx.muted;
    e.currentTarget.textContent = sfx.muted ? '🔇' : '🔊';
  };
  $('#switch-btn').onclick = async () => {
    const ok = await modal({
      title: 'Switch player?',
      html: '<p class="fine">Your scores stay saved under your number — log back in any time. Only switch if this phone belongs to someone else.</p>',
      ok: 'Switch',
    });
    if (ok) signedOut();
  };

}

// ------------------------------------------------------------------ profile

/** My profile: who I am, my Spin & Win prize, my numbers and my best games. */
async function enterProfile() {
  sfx.unlock();
  sfx.tap();
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
  }
  renderProfile();
  show('profile');
}

function renderProfile() {
  const me = S.me;
  const p = me.player;
  const bests = S.games
    .filter((g) => !g.hosted && !g.bonus && !g.social && me.games[g.id]?.best != null)
    .map((g) => ({ g, best: me.games[g.id].best, used: me.games[g.id].used }))
    .sort((a, b) => b.best - a.best)
    .slice(0, 6);
  const tries = Object.values(me.games).reduce((sum, i) => sum + (i.used || 0), 0);
  $('#view-profile').innerHTML = `
    <header class="hub-head">
      <div><div class="eyebrow">👤 My profile</div><h2>${esc(p.name)}</h2></div>
      <button class="icon-btn" id="pf-back" aria-label="Back to games">✕</button>
    </header>
    <section class="card pf-id">
      <div class="pf-photo" style="--h:${hue(p.name)}"><span>${esc(initials(p.name))}</span><img src="${photoUrl(p.name)}" alt="" onerror="this.remove()"></div>
      <div class="pf-who">
        <b>${esc(p.name)}</b>
        ${p.business ? `<div>💼 ${esc(p.business)}</div>` : ''}
        ${p.chapter ? `<div>🏛️ ${esc(p.chapter)}</div>` : ''}
        ${me.teamDetail ? `<div>👥 Team ${esc(me.teamDetail.name)}</div>` : ''}
      </div>
    </section>
    <section class="prize-ticket ${me.spin?.claimed ? 'claimed' : ''}">
      ${me.spin?.claimed ? '<span class="claim-stamp">CLAIMED ✓</span>' : ''}
      <div class="eyebrow">🎡 My Spin &amp; Win prize</div>
      ${me.spin?.spun
        ? /^\d+$/.test(String(me.spin.prize))
          ? `<div class="pf-prize">+${fmt(me.spin.prize)}</div>
             <p class="fine center">points, won on your welcome spin — already on your score 🎉</p>`
          : `${prizeLogo(me.spin.prize) ? `<img class="pf-prize-logo" src="${esc(prizeLogo(me.spin.prize))}" alt="" onerror="this.remove()">` : ''}
             <div class="pf-prize text">🎁 ${esc(String(me.spin.prize))}</div>
             ${me.spin.claimed
               ? '<p class="fine center">✅ Collected at the prize desk — enjoy!</p>'
               : `<p class="fine center">Show this ticket at the prize desk to collect it.</p>
                  <button class="btn btn-gold" id="pf-claim">✅ Claim gift</button>`}`
        : `<p class="fine center">You haven't had your welcome spin yet — one free spin, guaranteed prize!</p>
           <button class="btn btn-gold" id="pf-spin">🎡 Spin now</button>`}
    </section>
    <section class="pf-stats">
      <div class="card pf-stat"><span>Rank</span><b>${me.hidden ? '🤫' : me.rank ? `#${me.rank}` : '—'}</b></div>
      <div class="card pf-stat"><span>Points</span><b>${fmt(me.total)}</b></div>
      <div class="card pf-stat"><span>Games tried</span><b>${fmt(tries)}</b></div>
      <div class="card pf-stat"><span>Connections</span><b>🔗 ${fmt(me.connections || 0)}</b></div>
    </section>
    ${bests.length
      ? `<section class="card">
          <h3>🏅 My best games</h3>
          <div class="pf-bests">${bests
            .map(({ g, best, used }) => `<div class="pf-best"><span>${g.emoji} ${esc(g.name)}</span><small>${used} ${used === 1 ? 'try' : 'tries'}</small><b>${fmt(best)}</b></div>`)
            .join('')}</div>
        </section>`
      : '<p class="fine center">Play some games and your best scores will show here!</p>'}`;
  $('#pf-back').onclick = backToHub;
  const spin = $('#pf-spin');
  if (spin) spin.onclick = () => renderSpin();
  const claim = $('#pf-claim');
  if (claim) {
    claim.onclick = async () => {
      sfx.unlock();
      // One-way: only the prize desk should tap this, while handing over the gift.
      const sure = await modal({
        title: '🎁 Claim this gift?',
        html: '<p class="fine">Tap <b>Yes</b> only at the prize desk, while collecting your gift — the coupon is marked USED and cannot be claimed again.</p>',
        ok: 'Yes, claim it',
        cancel: 'Not yet',
      });
      if (!sure) return;
      try {
        await api('/api/spin/claim', { method: 'POST' });
      } catch (err) {
        if (err.status === 401) return signedOut('Please log in again');
        return toast(err.message);
      }
      sfx.win();
      confetti({ duration: 1200, count: 70 });
      enterProfile(); // re-render with the CLAIMED stamp
    };
  }
}

/** Live update from the socket without re-rendering the whole hub. */
function patchHubLive() {
  const total = $('#hub-total');
  if (total) countUp(total, S.me.total);
  const rank = $('#hub-rank');
  if (rank) rank.innerHTML = rankHtml();
  const board = $('#mini-board');
  if (board) board.innerHTML = miniBoardHtml();
  const card = $('#team-card');
  if (card) card.outerHTML = teamCardHtml();
}

// ------------------------------------------------------------------ teams (create / join / leave)

async function createTeamFlow() {
  const v = await modal({
    title: '＋ Create a team',
    html: `<label class="field"><span>Team name</span><input name="name" maxlength="30" placeholder="e.g. The Closers"></label>
      <p class="fine">You'll get a code to share — friends join with it (max ${S.settings.maxTeamSize} per team).</p>`,
    ok: 'Create',
  });
  if (!v) return;
  try {
    S.me = await api('/api/teams', { method: 'POST', body: { name: v.name } });
    renderHub();
    sfx.win();
    confetti({ duration: 1800, count: 120 });
    toast(`🎉 Team ${S.me.teamDetail.name} created! Share code ${S.me.teamDetail.code.toUpperCase()}`, 6000);
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    toast(err.message);
  }
}

async function joinTeamFlow() {
  const v = await modal({
    title: '👥 Join a team',
    html: `<label class="field"><span>Team code</span><input name="code" maxlength="10" autocapitalize="characters" autocomplete="off" placeholder="e.g. K7M2P"></label>
      <p class="fine">Ask your team's captain for the 5-letter code.</p>`,
    ok: 'Join',
  });
  if (!v) return;
  try {
    S.me = await api('/api/teams/join', { method: 'POST', body: { code: v.code } });
    renderHub();
    sfx.bonus();
    toast(`👥 You're in Team ${S.me.teamDetail.name}!`);
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    toast(err.message);
  }
}

async function leaveTeamFlow() {
  const name = S.me.teamDetail?.name || 'your team';
  const ok = await modal({
    title: 'Leave the team?',
    html: `<p class="fine">The points you've already scored stay with Team ${esc(name)}. You can join another team after leaving.</p>`,
    ok: 'Leave',
  });
  if (!ok) return;
  try {
    S.me = await api('/api/teams/leave', { method: 'POST' });
    renderHub();
    toast('You left the team');
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    toast(err.message);
  }
}

async function shareTeam() {
  const det = S.me.teamDetail;
  if (!det) return;
  const text = `Join my team "${det.name}" in ${S.settings.eventTitle}! Open ${location.origin} and join with code ${det.code.toUpperCase()}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      toast('Invite copied — paste it to your team!');
    }
  } catch { /* user cancelled the share sheet */ }
}

async function browseTeams() {
  let list;
  try {
    ({ teams: list } = await api('/api/teams'));
  } catch (err) {
    return toast(err.message);
  }
  const mine = S.me.teamDetail?.id;
  const rows = list.length
    ? list
        .map(
          (t) => `<div class="mini-row ${t.id === mine ? 'me' : ''}">
          <div class="mini-rank">${['🥇', '🥈', '🥉'][t.rank - 1] || t.rank}</div>
          <div class="mini-name">${t.emoji} ${esc(t.name)}<small>${t.members} member${t.members === 1 ? '' : 's'}${t.chapter ? ` · ${esc(t.chapter)}` : ''}</small></div>
          <div class="mini-total">${fmt(t.total)}</div>
        </div>`,
        )
        .join('')
    : '<p class="fine">No teams yet — create the first one!</p>';
  await modal({
    title: '👥 Team standings',
    html: `<div class="team-list">${rows}</div>${mine ? '' : '<p class="fine">To join one, ask its captain for the team code.</p>'}`,
    ok: 'Close',
    cancel: 'Back',
  });
}

// ------------------------------------------------------------------ welcome spin

const SPIN_FALLBACK = ['Digital Planet', 'Frameit', 'Modicare', 'Nandi Oil', 'Presto', 'DayToday', 'Abhekhya Twam', 'Yaticorp', 'Hangyo']; // mirror of the server's wheel

/** Land after login/boot: via the welcome spin if this player hasn't had theirs yet. */
function landHome() {
  renderHub();
  if (S.me.spin && !S.me.spin.spun) renderSpin();
  else show('hub');
}

/**
 * The prize wheel, carnival style: a gold rim ringed with twinkling bulbs, bright pie
 * wedges, and each prize written along its wedge from the centre out — so gift names fit.
 * Wedge 0 starts at the top and they run clockwise, matching the server's list.
 */
function spinWheelSvg(wedges) {
  const n = wedges.length;
  const step = 360 / n;
  const pt = (r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  };
  const PAL = ['#e3263a', '#7c3aed', '#0ea5e9', '#f59e0b', '#16a34a', '#ec4899', '#f97316'];
  const color = (i) => PAL[(i === n - 1 && (n - 1) % PAL.length === 0 && n > 1 ? 1 : i) % PAL.length]; // the last wedge never matches the first
  const R = 85; // wedge radius inside the rim
  const slice = (i) =>
    `<path d="M100 100 L${pt(R, i * step)} A${R} ${R} 0 ${step > 180 ? 1 : 0} 1 ${pt(R, (i + 1) * step)} Z" fill="${color(i)}" stroke="#fff" stroke-width="1.1"/>`;
  // The label sits centred along its wedge, clear of the hub and the rim. Multi-word names
  // stack on two lines so each line stays short and the type can stay BIG and readable.
  const label = (w, i) => {
    const words = String(w).split(' ');
    const two = words.length > 1;
    const cut = Math.ceil(words.length / 2);
    const lines = two ? [words.slice(0, cut).join(' '), words.slice(cut).join(' ')] : [String(w)];
    const longest = Math.max(...lines.map((l) => l.length));
    const tang = 56 * Math.sin((Math.PI * step) / 360); // half the wedge's width at the text's radius
    const fs = Math.max(5.5, Math.min(12, 52 / (0.62 * Math.max(3, longest)), two ? tang * 0.8 : tang * 1.5));
    const tspans = lines
      .map((l, k) => `<tspan x="156" dy="${k === 0 ? (two ? '-0.32em' : '0') : '1.08em'}">${esc(l)}</tspan>`)
      .join('');
    return `<text transform="rotate(${i * step + step / 2 - 90} 100 100)" x="156" y="100" dominant-baseline="middle" text-anchor="middle" style="font-size:${fs.toFixed(1)}px">${tspans}</text>`;
  };
  const bulbs = Array.from({ length: 16 }, (_, i) => {
    const [cx, cy] = pt(92.5, i * 22.5).split(' ');
    return `<circle class="bulb" cx="${cx}" cy="${cy}" r="2.6" fill="#ffe9a8" style="animation-delay:${(i % 2) * 0.55}s"/>`;
  }).join('');
  return `<svg viewBox="0 0 200 200" id="spin-wheel" aria-hidden="true">
    <defs>
      <linearGradient id="sw-rim" x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" stop-color="#ffe9a8"/><stop offset="0.45" stop-color="#e8b83a"/><stop offset="1" stop-color="#8f650f"/>
      </linearGradient>
      <radialGradient id="sw-depth" gradientUnits="userSpaceOnUse" cx="100" cy="100" r="100">
        <stop offset="0.55" stop-color="rgba(255,255,255,0)"/><stop offset="0.8" stop-color="rgba(0,0,0,0.12)"/><stop offset="0.85" stop-color="rgba(0,0,0,0.3)"/>
      </radialGradient>
      <radialGradient id="sw-hub" cx="35%" cy="30%" r="85%">
        <stop offset="0" stop-color="#fff0c0"/><stop offset="0.55" stop-color="#e8b83a"/><stop offset="1" stop-color="#8f650f"/>
      </radialGradient>
      <clipPath id="sw-clip"><circle cx="100" cy="100" r="99"/></clipPath>
    </defs>
    <circle cx="100" cy="100" r="99" fill="url(#sw-rim)" stroke="#6e4d09" stroke-width="1.4"/>
    <circle cx="100" cy="100" r="86.5" fill="#1a1230" stroke="rgba(0,0,0,0.35)" stroke-width="1.6"/>
    ${wedges.map((w, i) => slice(i)).join('')}
    <circle cx="100" cy="100" r="${R}" fill="url(#sw-depth)" pointer-events="none"/>
    ${wedges.map((w, i) => label(w, i)).join('')}
    ${bulbs}
    <circle cx="100" cy="100" r="15" fill="url(#sw-hub)" stroke="#8f650f" stroke-width="1"/>
    <text x="100" y="105.5" text-anchor="middle" class="hub-star" style="font-size:13px">★</text>
    <g clip-path="url(#sw-clip)"><ellipse cx="74" cy="52" rx="82" ry="50" fill="#fff" opacity="0.07" transform="rotate(-18 74 52)"/></g>
  </svg>`;
}

function renderSpin() {
  const wedges = S.settings?.spinWedges || gameById('spin')?.wedges || SPIN_FALLBACK;
  const first = S.me.player.name.split(' ')[0];
  $('#view-spin').innerHTML = `
    <div class="spin-stage">
      <div>
        <div class="eyebrow">Welcome, ${esc(first)}! 🎉</div>
        <h2>Spin &amp; Win</h2>
        <p class="fine">One free spin on the house — whatever the wheel lands on is yours!</p>
      </div>
      <div class="spin-box"><div class="spin-pointer">▼</div>${spinWheelSvg(wedges)}</div>
      <div class="spin-result" id="spin-result"></div>
      <button class="btn btn-gold btn-lg" id="spin-btn">🎡 SPIN!</button>
    </div>`;
  show('spin');
  $('#spin-btn').onclick = () => doSpin().catch(() => {});
}

/** The server picks the prize; this only turns the wheel to the wedge it names. */
async function doSpin() {
  const btn = $('#spin-btn');
  btn.disabled = true;
  sfx.unlock();
  let res;
  try {
    res = await api('/api/spin', { method: 'POST' });
  } catch (err) {
    btn.disabled = false;
    if (err.status === 401) return signedOut('Please log in again');
    return toast(err.message);
  }
  S.me.spin = { spun: true, prize: res.prize };
  if (res.already) return backToHub(); // spun on another device — the prize is already on the score
  sfx.whoosh(); // the wheel takes off
  vibrate(20);
  const wedges = res.wedges || SPIN_FALLBACK;
  // Six full turns over 6 seconds (the CSS transition), stopping with the winning wedge's
  // centre under the pointer.
  $('#spin-wheel').style.transform = `rotate(${360 * 6 - (res.index + 0.5) * (360 / wedges.length)}deg)`;
  // The flapper clicks along with the wheel — a burst of fast ticks that slows as it does.
  const t0 = performance.now();
  let gap = 45;
  while (performance.now() - t0 < 4500) {
    sfx.tick();
    if (gap > 160) vibrate(5); // feel the last few clicks
    await sleep(gap);
    gap = Math.min(400, gap * 1.09);
  }
  sfx.drumroll(1.3); // suspense as it creeps onto the winning wedge
  await sleep(1500);
  const isPts = /^\d+$/.test(String(res.prize));
  if (!isPts || Number(res.prize) >= 250) sfx.fanfare(); // gifts and big wedges get the brass
  else sfx.win();
  sfx.sparkle(0.45);
  vibrate([40, 60, 120]);
  confetti({ duration: 2400, count: 150 });
  $('#spin-result').innerHTML = `<span class="spin-prize">${isPts ? `+${fmt(res.prize)} points!` : `🎁 ${esc(res.prize)}!`}</span>`;
  btn.outerHTML = '<button class="btn btn-primary btn-lg" id="spin-go">Let’s play →</button>';
  $('#spin-go').onclick = backToHub;
  // The big moment gets a pop-up of its own: what they won, front and centre.
  await sleep(500);
  const logo = isPts ? null : prizeLogo(res.prize);
  const first = S.me.player.name.split(' ')[0];
  await modal({
    title: `🎉 Congratulations, ${esc(first)}!`,
    html: `<div class="win-pop">
        ${logo ? `<img class="win-pop-logo" src="${esc(logo)}" alt="" onerror="this.outerHTML='<div class=win-pop-emoji>🎁</div>'">` : `<div class="win-pop-emoji">${isPts ? '🪙' : '🎁'}</div>`}
        <div class="win-pop-prize">${isPts ? `+${fmt(res.prize)} points` : esc(res.prize)}</div>
        <p class="fine center">${isPts
          ? `You won <b>+${fmt(res.prize)} points</b> — straight onto your score!`
          : `You won a <b>${esc(res.prize)} gift voucher</b>! It's saved on your profile ticket — show it at the prize desk to collect.`}</p>
      </div>`,
    ok: 'Let’s play →',
    cancel: false,
  });
  backToHub();
}

// ------------------------------------------------------------------ power connections (networking)

/** A code however it arrives: typed, or the whole URL a camera app read from a member's QR. */
function parseConnectCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/[#?&]c=([a-z0-9]+)/i) || s.match(/^([a-z0-9]{4,12})$/i);
  return m ? m[1].toLowerCase() : '';
}

async function enterConnect() {
  show('connect');
  $('#view-connect').innerHTML = '<div class="boot"><div class="spinner"></div></div>';
  try {
    S.connect = await api('/api/connections');
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    toast(err.message);
    return backToHub();
  }
  renderConnect();
}

function renderConnect() {
  const d = S.connect;
  const g = gameById('network');
  const canCam = Boolean(navigator.mediaDevices?.getUserMedia);
  $('#view-connect').innerHTML = `
    <header class="hub-head">
      <div><div class="eyebrow">${g ? `${g.emoji} ${esc(g.name)}` : '🔗 Connections'}</div>
      <h2>🔗 ${d.met.length} connection${d.met.length === 1 ? '' : 's'}</h2></div>
      <button class="icon-btn" id="cx-back" aria-label="Back to games">✕</button>
    </header>
    <section class="card cx-qr">
      <div class="cx-qr-img"><img src="${apiUrl(`/api/connect-qr/${encodeURIComponent(d.code)}`)}" alt="My member QR"></div>
      <div class="cx-code">${esc(d.code.toUpperCase())}</div>
      <p class="fine center">This is <b>your</b> QR — show it to members you meet. They scan it with any camera app (or type the code) and it counts as a connection for you <b>both</b>.</p>
      ${S.settings.networkOpen === false ? '<p class="fine center">⏸ Power Connections hasn’t started — scans will count once the organiser starts it.</p>' : ''}
    </section>
    <section class="card cx-actions">
      <h3>🤝 Met someone? Connect!</h3>
      ${canCam ? '<button class="btn btn-gold btn-lg" id="cx-scan">📷 Scan their QR</button>' : ''}
      <form id="cx-form" class="cx-row">
        <input class="txt" id="cx-input" maxlength="24" placeholder="…or type their code" autocapitalize="none" autocomplete="off" spellcheck="false">
        <button class="btn" type="submit">Connect</button>
      </form>
      ${canCam ? '' : '<p class="fine">No in-app camera on this phone — point your phone’s own camera app at their QR instead: it opens this game and connects by itself.</p>'}
    </section>
    <section class="card">
      <h3>Members met${d.met.length ? ` · ${d.met.length}` : ''}</h3>
      ${d.met.length
        ? `<div class="cx-met-list">${d.met
            .map(
              (m) => `<div class="cx-met-row">
                <span class="cx-met-who">${m.emoji || '🤝'} <b>${esc(m.name)}</b><small>${esc([m.business, m.chapter].filter(Boolean).join(' · '))}</small></span>
              </div>`,
            )
            .join('')}</div>`
        : '<p class="fine">Nobody yet — go say hi! Every member you meet counts for you both.</p>'}
    </section>`;
  $('#cx-back').onclick = backToHub;
  $('#cx-form').onsubmit = (e) => {
    e.preventDefault();
    submitConnect($('#cx-input').value);
  };
  const scan = $('#cx-scan');
  if (scan) scan.onclick = () => scanFlow().catch(() => {});
}

async function submitConnect(raw) {
  const code = parseConnectCode(raw);
  if (!code) return toast('Scan a member’s QR or type their code');
  sfx.unlock();
  let r;
  try {
    r = await api('/api/connect', { method: 'POST', body: { code } });
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    sfx.bad();
    vibrate(80);
    return toast(err.message);
  }
  const first = r.other.name.split(' ')[0];
  if (r.already) {
    sfx.flip();
    toast(`You and ${first} are already connected ✓`);
  } else {
    sfx.win();
    sfx.sparkle(0.45);
    vibrate([30, 40, 80]);
    confetti({ duration: 1600, count: 100 });
    toast(`🔗 Connected with ${r.other.name}! That's ${r.met} connection${r.met === 1 ? '' : 's'} for you`, 4000);
  }
  if (S.view === 'connect') {
    try {
      S.connect = await api('/api/connections');
      renderConnect();
    } catch { /* the next open refreshes */ }
  }
}

/** In-app scanner: BarcodeDetector where the browser has it, else the bundled jsQR over a canvas. */
async function scanFlow() {
  sfx.unlock();
  sfx.tap();
  const wrap = document.createElement('div');
  wrap.className = 'scan-overlay';
  wrap.innerHTML = `<video playsinline muted></video><div class="scan-frame"></div>
    <p class="fine">Point at the member’s QR</p><button class="btn" id="scan-cancel">Cancel</button>`;
  document.body.appendChild(wrap);
  const video = wrap.querySelector('video');
  let stream = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    wrap.remove();
  };
  wrap.querySelector('#scan-cancel').onclick = stop;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    stop();
    return toast('Camera not available here — type their code, or scan with your camera app');
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  let detect;
  if ('BarcodeDetector' in window) {
    const bd = new window.BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await bd.detect(video))[0]?.rawValue;
  } else {
    if (!(await loadJsQr())) {
      stop();
      return toast('Scanning isn’t supported on this phone — type their code instead');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    detect = () => {
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return window.jsQR(img.data, img.width, img.height)?.data;
    };
  }
  while (!stopped) {
    try {
      const code = parseConnectCode(await detect());
      if (code) {
        stop();
        sfx.good();
        vibrate(25); // the "got it" buzz the moment the QR locks
        return submitConnect(code);
      }
    } catch { /* a frame that can't be read — keep looking */ }
    await sleep(250);
  }
}

function loadJsQr() {
  return new Promise((resolve) => {
    if (window.jsQR) return resolve(true);
    const s = document.createElement('script');
    s.src = '/js/vendor/jsqr.min.js';
    s.onload = () => resolve(Boolean(window.jsQR));
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// ------------------------------------------------------------------ team tap battle

/** Countdown / time left right now: the server's figures minus the time since they arrived. */
function roundClock() {
  const r = S.round;
  const dt = performance.now() - S.roundAt;
  return { countdown: Math.max(0, (r?.countdownMs || 0) - dt), remaining: Math.max(0, (r?.remainingMs || 0) - dt) };
}

let tapUi = null; // per-round state of the tap view

function onRound(r) {
  S.round = r;
  S.roundAt = performance.now();
  if (S.view === 'tap') return updateTap();
  if (!S.me) return;
  if (roundActive() && (S.view === 'hub' || S.view === 'result')) {
    if (S.me.team) enterTap();
    else if (r.status === 'countdown') toast('⚡ A Team Tap Battle is starting — join a team to play the next one!', 6000);
  } else if (S.view === 'hub') {
    patchHubLive();
  } else if (S.view === 'game' && r.status === 'countdown') {
    toast('👥 Team Tap Battle is starting — finish up and join in!');
  }
}

function enterTap() {
  show('tap');
  renderTap();
}

function renderTap() {
  const r = S.round;
  const team = S.me?.team;
  if (!r || r.status === 'idle' || !team) return backToHub();
  if (!tapUi || tapUi.no !== r.no) {
    tapUi = { no: r.no, mine: 0, pending: 0, flushTimer: null, done: false };
    $('#view-tap').innerHTML = `
      <div class="hud" style="--accent:${team.color}">
        <button class="icon-btn" id="tap-quit" aria-label="Back to games">✕</button>
        <div class="hud-name">${team.emoji} Team ${esc(team.name)} · Round ${r.no}</div>
        <div class="hud-stats">
          <div class="hud-stat"><span>Time</span><b id="tap-time">–</b></div>
          <div class="hud-stat"><span>My taps</span><b id="tap-mine">0</b></div>
        </div>
      </div>
      <div class="stage tap-stage">
        <div class="tap-standing" id="tap-standing"></div>
        <button class="tap-btn" id="tap-btn" style="--accent:${team.color}">
          <span class="tap-big" id="tap-big"></span><span class="tap-sub" id="tap-sub"></span>
        </button>
        <div class="tap-teams" id="tap-teams"></div>
        <div id="tap-actions"></div>
      </div>`;
    const btn = $('#tap-btn');
    btn.addEventListener('pointerdown', onTapPress);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    $('#tap-quit').onclick = () => {
      flushTaps();
      backToHub();
    };
    requestAnimationFrame(tapClockLoop);
  }
  updateTap();
}

function onTapPress(e) {
  e.preventDefault();
  if (!S.round || S.round.status !== 'running' || roundClock().remaining <= 0) return;
  tapUi.mine++;
  tapUi.pending++;
  $('#tap-mine').textContent = fmt(tapUi.mine);
  const btn = $('#tap-btn');
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
  vibrate(8);
  sfx.tap();
  if (!tapUi.flushTimer) tapUi.flushTimer = setTimeout(flushTaps, 200);
}

/** Taps go out in small batches (5/s) over the live connection, or the API if that's down. */
function flushTaps() {
  if (!tapUi) return;
  clearTimeout(tapUi.flushTimer);
  tapUi.flushTimer = null;
  const n = tapUi.pending;
  if (!n) return;
  tapUi.pending = 0;
  if (socket?.connected) socket.emit('tap', n);
  else api('/api/tap', { method: 'POST', body: { n } }).catch(() => {});
}

/** Smooth countdown and timer between server updates. */
function tapClockLoop() {
  if (S.view !== 'tap' || !tapUi) return;
  const r = S.round;
  const { countdown, remaining } = roundClock();
  if (r.status === 'countdown') $('#tap-big').textContent = countdown > 400 ? Math.ceil(countdown / 1000) : 'GO!';
  else if (r.status === 'running') $('#tap-time').textContent = `${Math.ceil(remaining / 1000)}s`;
  requestAnimationFrame(tapClockLoop);
}

function updateTap() {
  const r = S.round;
  const team = S.me?.team;
  if (!r || !team || !tapUi) return;
  if (tapUi.no !== r.no) return renderTap(); // a new round began while we were here
  const teams = r.teams || [];
  const taps = (t) => (r.taps?.[t.id] || 0) + (t.id === team.id ? tapUi.pending : 0);
  const order = [...teams].sort((a, b) => taps(b) - taps(a));
  const max = Math.max(1, ...order.map(taps));
  const pos = order.findIndex((t) => t.id === team.id) + 1;
  const second = order[1];
  const big = $('#tap-big');
  const sub = $('#tap-sub');
  const standing = $('#tap-standing');
  const btn = $('#tap-btn');

  if (r.status === 'countdown') {
    big.textContent = Math.ceil(roundClock().countdown / 1000) || 'GO!';
    sub.textContent = 'Get ready to tap…';
    $('#tap-time').textContent = '–';
    standing.textContent = `You’re on Team ${team.name} — tap like crazy when it says GO!`;
    btn.classList.remove('live', 'over');
  } else if (r.status === 'running') {
    big.textContent = 'TAP!';
    sub.textContent = 'as fast as you can';
    standing.textContent = pos === 1
      ? (second && taps(second) === taps(order[0]) ? '🤝 Tied for the lead!' : `🥇 Your team is leading${second ? ` by ${fmt(taps(order[0]) - taps(second))}` : ''}!`)
      : pos > 0 ? `${pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`} Your team is ${ordinal(pos)} — ${fmt(taps(order[0]) - taps(order[pos - 1]))} behind` : 'Tap for your team!';
    btn.classList.add('live');
    btn.classList.remove('over');
  } else if (r.status === 'ended') {
    const ranking = r.ranking || order.map((t) => t.id);
    const winner = teams.find((t) => t.id === ranking[0]);
    const myPos = ranking.indexOf(team.id) + 1;
    big.textContent = r.tie ? 'IT’S A TIE!' : myPos === 1 ? 'YOU WON! 🎉' : myPos > 0 ? `${ordinal(myPos).toUpperCase()} PLACE` : 'ROUND OVER';
    sub.textContent = r.tie ? 'Dead heat at the top' : `Team ${winner?.name || '?'} wins round ${r.no}`;
    $('#tap-time').textContent = '0s';
    standing.textContent = `You tapped ${fmt(tapUi.mine)} times for Team ${team.name}`;
    btn.classList.remove('live');
    btn.classList.add('over');
    if (!tapUi.done) {
      tapUi.done = true;
      flushTaps();
      if (myPos === 1 && !r.tie) {
        sfx.win();
        confetti();
      } else sfx.good();
      $('#tap-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="tap-back">Back to games →</button>';
      $('#tap-back').onclick = backToHub;
    }
  }
  $('#tap-teams').innerHTML = order
    .map((t) => `<div class="tap-team ${t.id === team.id ? 'me' : ''}"><span>${t.emoji} ${esc(t.name)}</span><i><b style="width:${(taps(t) / max) * 100}%;background:${t.color}"></b></i><em>${fmt(taps(t))}</em></div>`)
    .join('');
}

// ------------------------------------------------------------------ live quiz (hosted on the big screen)

let quizUi = null; // per-question state of the quiz view
const liveOpen = () => S.live?.status === 'open';

function onLiveQuestion(q) {
  S.live = q;
  S.liveAt = performance.now();
  if (S.view === 'quiz') return updateQuiz();
  if (!S.me) return;
  if (q.status === 'open' && ['hub', 'result', 'tap'].includes(S.view)) enterQuiz();
  else if (q.status === 'open' && S.view === 'game') toast('📺 A Live Quiz question is up — finish and join in!');
}

function enterQuiz() {
  show('quiz');
  renderQuiz();
}

function renderQuiz() {
  const q = S.live;
  if (!q || q.status === 'idle') return backToHub();
  if (!quizUi || quizUi.no !== q.no) {
    quizUi = { no: q.no, choice: null, ms: null, locked: false, done: false };
    const vote = q.kind === 'vote';
    $('#view-quiz').innerHTML = `
      <div class="hud" style="--accent:${vote ? '#a855f7' : '#f97316'}">
        <button class="icon-btn" id="lq-quit" aria-label="Back to games">✕</button>
        <div class="hud-name">${vote ? '📊 Live Vote' : '📺 Live Quiz'} · Question ${q.no}</div>
        <div class="hud-stats"><div class="hud-stat"><span>Time</span><b id="lq-time">–</b></div></div>
      </div>
      <div class="stage quiz">
        <div class="quiz-timer"><i id="lq-bar"></i></div>
        <h3 class="quiz-q">${esc(q.q)}</h3>
        <div class="quiz-opts" id="lq-opts">${q.options
          .map((o, i) => `<button class="quiz-opt" type="button" data-i="${i}"><span class="quiz-letter">${'ABCDEF'[i]}</span><span>${esc(o)}</span></button>`)
          .join('')}</div>
        <div class="quiz-feedback" id="lq-fb">${vote ? 'Tap to cast your vote!' : 'Tap your answer — faster is worth more!'}</div>
        <div id="lq-actions"></div>
      </div>`;
    $('#lq-quit').onclick = backToHub;
    $('#lq-opts').addEventListener('click', (e) => {
      const b = e.target.closest('.quiz-opt');
      if (b) answerLive(Number(b.dataset.i));
    });
    requestAnimationFrame(quizClockLoop);
  }
  updateQuiz();
}

async function answerLive(i) {
  if (!quizUi || quizUi.locked || !liveOpen()) return;
  quizUi.locked = true;
  quizUi.choice = i;
  const btns = [...document.querySelectorAll('#lq-opts .quiz-opt')];
  btns.forEach((b) => (b.disabled = true));
  btns[i].classList.add('picked');
  sfx.tick();
  vibrate(15);
  $('#lq-fb').textContent = 'Sending…';
  try {
    const r = await withRetry(() => api('/api/livequiz/answer', { method: 'POST', body: { choice: i } }));
    quizUi.ms = r.ms ?? null;
    $('#lq-fb').textContent = r.locked ? 'Already answered on another device' : S.live?.kind === 'vote' ? '🗳️ Vote in — watch the big screen!' : '✅ Answer in — eyes on the big screen!';
  } catch (err) {
    quizUi.locked = false;
    btns.forEach((b) => (b.disabled = false));
    btns[i].classList.remove('picked');
    $('#lq-fb').textContent = err.code === 'TOO_LATE' ? '⏰ Too late!' : err.message;
  }
}

function quizClockLoop() {
  if (S.view !== 'quiz' || !quizUi) return;
  const q = S.live;
  if (q?.status === 'open') {
    const left = Math.max(0, q.remainingMs - (performance.now() - S.liveAt));
    const t = $('#lq-time');
    t.textContent = `${Math.ceil(left / 1000)}s`;
    t.parentElement.classList.toggle('urgent', left < 5500);
    $('#lq-bar').style.width = `${(left / q.limitMs) * 100}%`;
  }
  requestAnimationFrame(quizClockLoop);
}

function updateQuiz() {
  const q = S.live;
  if (!q || !quizUi) return;
  if (q.status === 'idle') return backToHub();
  if (quizUi.no !== q.no) return renderQuiz();
  if (q.status !== 'closed' || quizUi.done) return;
  quizUi.done = true;
  const btns = [...document.querySelectorAll('#lq-opts .quiz-opt')];
  btns.forEach((b) => (b.disabled = true));
  if (q.kind === 'vote') {
    // A poll: show how the room voted, no points.
    const counts = q.result?.counts || [];
    const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
    const top = Math.max(0, ...counts);
    const winners = q.options.filter((_, i) => counts[i] === top && top > 0);
    btns.forEach((b, i) => { if (counts[i] === top && top > 0) b.classList.add('right'); });
    $('#lq-fb').textContent = winners.length ? `📊 The room says: ${winners.join(' & ')} (${Math.round((top / total) * 100)}%)` : '📊 No votes came in';
    $('#lq-time').textContent = '0s';
    $('#lq-time').parentElement.classList.remove('urgent');
    $('#lq-bar').style.width = '0%';
    sfx.good();
    $('#lq-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="lq-back">Back to games →</button>';
    $('#lq-back').onclick = backToHub;
    return;
  }
  btns[q.answer]?.classList.add('right');
  const mine = quizUi.choice;
  const correct = mine === q.answer && quizUi.ms != null;
  if (mine != null && mine !== q.answer) btns[mine].classList.add('wrong');
  const pts = correct ? 50 + Math.round(50 * Math.max(0, 1 - Math.min(quizUi.ms, q.limitMs) / q.limitMs)) : 0;
  const myPos = correct ? (q.result?.fastest || []).findIndex((f) => f.ms === quizUi.ms && f.name === S.me.player.name) + 1 : 0;
  $('#lq-fb').textContent = correct
    ? `✅ Correct! +${pts} points${myPos ? ` · ⚡ ${ordinal(myPos)} fastest in the room!` : ''}`
    : mine == null ? `⏰ No answer — it was ${'ABCDEF'[q.answer]}` : `❌ Not this time — it was ${'ABCDEF'[q.answer]}`;
  $('#lq-time').textContent = '0s';
  $('#lq-time').parentElement.classList.remove('urgent');
  $('#lq-bar').style.width = '0%';
  if (correct) {
    sfx.win();
    if (myPos && myPos <= 3) confetti({ duration: 2500, count: 140 });
  } else sfx.bad();
  $('#lq-actions').innerHTML = '<button class="btn btn-primary btn-lg" id="lq-back">Back to games →</button>';
  $('#lq-back').onclick = backToHub;
}

// ------------------------------------------------------------------ lucky draw & nudges

/** The big screen spins for ~7 s — phones celebrate when the wheel stops, not before. */
function onLuckyDraw(d) {
  if (!S.me) return;
  setTimeout(() => {
    if (d.winner.id === S.me.player.id) {
      sfx.win();
      confetti({ duration: 8000, count: 300 });
      vibrate([120, 60, 120, 60, 400]);
      modal({
        title: '🎉 YOU WON THE LUCKY DRAW!',
        html: `<div class="win-photo"><img src="${photoUrl(S.me.player.name)}" alt="" onerror="this.parentElement.remove()"></div><p class="fine">Look at the big screen, ${esc(S.me.player.name.split(' ')[0])} — and go collect your prize!</p>`,
        ok: 'Woohoo! 🙌',
        cancel: 'Close',
      });
    } else {
      toast(`🎡 Lucky draw: ${d.winner.name} wins a prize!`, 8000);
    }
  }, 7200);
}

/** Rank moved since the last live update: a little rivalry goes a long way — in small doses. */
let lastNudgeAt = 0;
function nudge(before) {
  const me = S.me;
  if (S.view === 'game' || me.hidden || !before.rank || !me.rank || me.rank === before.rank) return;
  // Don't nag (busy boards reshuffle every few seconds), and never talk over another message.
  if (performance.now() - lastNudgeAt < 20000 || $('#toast')?.classList.contains('show')) return;
  lastNudgeAt = performance.now();
  if (me.rank > before.rank && me.above) {
    toast(`📉 ${me.above.name} just overtook you — you’re #${me.rank} now. Play again to climb back!`, 6000);
  } else if (me.rank < before.rank && me.rank <= 3) {
    toast(me.rank === 1 ? '👑 You’re leading the night!' : `🚀 You climbed to #${me.rank} — top 3!`, 5000);
    sfx.bonus();
  }
}

// ------------------------------------------------------------------ playing

async function openGame(gameId, mode = 'solo') {
  const g = gameById(gameId);
  const team = mode === 'team';
  const info = team ? S.me.teamDetail?.games[gameId] : S.me.games[gameId];
  if (!g || !info) return;
  if (g.social) return enterConnect(); // Power Connections: the QR + scanner view, no attempt to start
  const triesLine = team
    ? (info.left === null
        ? `Unlimited team tries — every point goes to Team ${esc(S.me.teamDetail.name)}.`
        : `This uses 1 of your ${info.left} team ${info.left === 1 ? 'try' : 'tries'}. Every point goes to Team ${esc(S.me.teamDetail.name)}.`)
    : (info.left === null
        ? 'Unlimited tries — every score adds to your total.'
        : `This uses 1 of your ${info.left} remaining ${info.left === 1 ? 'try' : 'tries'}. Every score adds to your total.`);
  const ok = await modal({
    title: `${g.emoji} ${esc(g.name)}${team ? ` · 👥 for ${esc(S.me.teamDetail.name)}` : ''}`,
    html: `<ul class="howto">${g.howTo.map((h) => `<li>${esc(h)}</li>`).join('')}</ul><p class="fine">${triesLine}</p>`,
    ok: 'Start ▶',
    cancel: 'Back',
  });
  if (!ok) return;
  sfx.unlock();
  let start;
  try {
    start = await api(`/api/games/${gameId}/start`, { method: 'POST', body: { mode } });
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
    toast(err.message);
    refreshMe().then(renderHub).catch(() => {});
    return;
  }
  await runGame(g, start);
}

async function countdown(stage, signal) {
  stage.innerHTML = `<div class="countdown"><div class="cd-num" id="cd"></div><p>Get ready…</p></div>`;
  const el = $('#cd', stage);
  for (const n of ['3', '2', '1', 'GO!']) {
    if (signal.aborted) throw abortError();
    el.textContent = n;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    n === 'GO!' ? sfx.go() : sfx.tick();
    await sleep(n === 'GO!' ? 450 : 750, signal);
  }
}

async function backToHub() {
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) return signedOut('Please log in again');
  }
  renderHub();
  show('hub');
}

/**
 * Streams a game's running score to the big screen (at most ~1.5 times a second, plus a
 * heartbeat every 15 s so a quiet game stays on the board). The final score still comes from
 * the server; this only moves the leaderboard while the game is on.
 */
function liveReporter(attemptId) {
  let last = null;
  let pending = 0;
  let timer = null;
  const post = (score) => {
    if (socket?.connected) socket.emit('progress', { attemptId, score });
    else api(`/api/attempts/${attemptId}/progress`, { method: 'POST', body: { score } }).catch(() => {});
  };
  const send = () => {
    timer = null;
    if (pending === last) return;
    last = pending;
    post(pending);
  };
  const beat = setInterval(() => post(last ?? pending), 15000);
  const report = (pts) => {
    if (typeof pts !== 'number' || !Number.isFinite(pts)) return;
    pending = Math.round(pts);
    if (!timer) timer = setTimeout(send, 700);
  };
  report.stop = (quit = false) => {
    clearTimeout(timer);
    clearInterval(beat);
    timer = null;
    if (quit) post(null); // off the board straight away
  };
  return report;
}

async function runGame(g, start) {
  const team = start.mode === 'team' ? S.me.teamDetail : null;
  const view = $('#view-game');
  view.innerHTML = `
    <div class="hud" style="--accent:${g.color}">
      <button class="icon-btn" id="quit-btn" aria-label="Quit game">✕</button>
      <div class="hud-name">${g.emoji} ${esc(g.name)}${team ? ` · 👥 ${esc(team.name)}` : ''}</div>
      <div class="hud-stats">
        <div class="hud-stat"><span id="hud-time-label">Time</span><b id="hud-time">–</b></div>
        <div class="hud-stat"><span id="hud-score-label">Score</span><b id="hud-score">0</b></div>
      </div>
    </div>
    <div class="stage" id="stage"></div>`;
  show('game');

  const ac = new AbortController();
  $('#quit-btn').onclick = async () => {
    const quit = await modal({ title: 'Quit this game?', html: '<p class="fine">This try will still count as used.</p>', ok: 'Quit', cancel: 'Keep playing' });
    if (quit) ac.abort();
  };
  const hud = {
    time: (v) => {
      const el = $('#hud-time');
      el.textContent = v;
      el.parentElement.classList.toggle('urgent', typeof v === 'number' && v > 0 && v <= 5); // final seconds glow red
    },
    score: (v) => ($('#hud-score').textContent = typeof v === 'number' ? fmt(v) : v),
    timeLabel: (t) => ($('#hud-time-label').textContent = t),
    scoreLabel: (t) => ($('#hud-score-label').textContent = t),
  };
  const stage = $('#stage');

  const live = liveReporter(start.attemptId);
  let result;
  try {
    await countdown(stage, ac.signal);
    live(0); // on the big screen's "Playing right now" from the first second
    result = await MODULES[g.id].play(stage, { attempt: start, hud, sfx, signal: ac.signal, live });
  } catch (err) {
    live.stop(true);
    $('#modal').classList.add('hidden');
    if (err.name !== 'AbortError') {
      if (err.status === 401) return signedOut('Please log in again');
      toast(err.message || 'Something went wrong');
    }
    return backToHub();
  }
  live.stop();
  $('#modal').classList.add('hidden');
  $('#quit-btn').disabled = true;
  stage.innerHTML = `<div class="saving"><div class="spinner"></div><p>Saving your score…</p></div>`;

  let res;
  for (let i = 0; ; i++) {
    try {
      res = await api(`/api/attempts/${start.attemptId}/finish`, { method: 'POST', body: { result } });
      break;
    } catch (err) {
      if (err.status === 401) return signedOut('Please log in again');
      if (!err.network || i >= 4) {
        toast(err.message);
        return backToHub();
      }
      await sleep(1000 * (i + 1));
    }
  }
  showResult(g, res);
}

function metaLine(gameId, m) {
  if (!m) return '';
  switch (gameId) {
    case 'rush': return `🤝 ${m.good} referrals · ⭐ ${m.golden} golden · 👻 ${m.ghost} ghosts`;
    case 'reflex': return `Average ${m.avgMs} ms · Best ${m.bestMs} ms${m.falseStarts ? ` · ${m.falseStarts} early tap${m.falseStarts > 1 ? 's' : ''}` : ''}`;
    case 'colors': return `${m.correct} right · ${m.wrong} wrong`;
    case 'pictionary': return `${m.correct} of ${m.total} professions guessed`;
    case 'frenzy': return `${m.taps} taps · ${m.perSec} a second`;
    case 'math': return `${m.correct} right · ${m.wrong} wrong`;
    case 'timing': return `Average ${m.avgOffMs} ms off target · best ${m.bestOffMs} ms`;
    case 'hunt': return m.completed ? `All 20 found in ${(m.timeMs / 1000).toFixed(1)} seconds${m.wrong ? ` · ${m.wrong} wrong tap${m.wrong > 1 ? 's' : ''}` : ''}` : `${m.found}/20 before time ran out`;
    case 'balloons': return `🎈 ${m.popped} popped · ⭐ ${m.golden} golden`;
    case 'bullseye': return `🎯 ${m.bulls} bullseye${m.bulls === 1 ? '' : 's'} · average ${m.avgOff} off centre`;
    default: return '';
  }
}

function showResult(g, r) {
  const s = S.settings;
  const team = r.mode === 'team';
  const canReplay = r.attemptsLeft !== 0 && s.playOpen && (team ? s.teamGames : s.enabledGames).includes(g.id);
  const leftText = r.attemptsLeft === null ? '' : ` (${r.attemptsLeft} left)`;
  $('#view-result').innerHTML = `
    <div class="card result" ${team && r.team ? `style="--accent:${r.team.color}"` : ''}>
      <div class="result-emoji">${g.emoji}</div>
      <div class="eyebrow">${esc(g.name)}${team && r.team ? ` · 👥 Team ${esc(r.team.name)}` : ''}</div>
      <div class="result-score" id="res-score" data-value="0">0</div>
      <div class="result-sub">points${team && r.team ? ` for Team ${esc(r.team.name)}` : ''}</div>
      ${r.isBest && r.tries > 1 ? '<div class="badge-best">🎉 New personal best!</div>' : ''}
      <p class="fine">${team ? `Added to the team's total · ${esc(g.name)}: <b>${fmt(r.gameTotal)}</b> team pts` : `Added to your total · ${esc(g.name)}: <b>${fmt(r.gameTotal)}</b> pts${r.tries > 1 ? ` from ${r.tries} tries` : ''}`}</p>
      <p class="result-meta">${esc(metaLine(g.id, r.meta))}</p>
      <div class="result-stats">
        <div><span>${team ? 'Team total' : 'Total score'}</span><b>${fmt(r.total)}</b></div>
        <div><span>${team ? 'Team rank' : 'Rank'}</span><b>${r.rank ? `#${r.rank}` : '🤫'}</b></div>
      </div>
      <div class="result-actions">
        <button class="btn btn-primary btn-lg" id="hub-btn">Back to games</button>
        ${canReplay ? `<button class="btn btn-ghost" id="again-btn">↻ Play again${leftText}</button>` : ''}
      </div>
    </div>`;
  show('result');
  countUp($('#res-score'), r.score, 1100, 0);
  if (r.isBest && r.score > 0) {
    setTimeout(() => {
      sfx.win();
      confetti({ duration: 1800, count: 120 });
    }, 900);
  }
  const refreshed = refreshMe().catch(() => {});
  $('#hub-btn').onclick = async () => {
    await refreshed;
    if (!S.me) return;
    renderHub();
    show('hub');
  };
  const again = $('#again-btn');
  if (again) {
    again.onclick = async () => {
      await refreshed;
      renderHub();
      show('hub');
      openGame(g.id, r.mode);
    };
  }
}

// ------------------------------------------------------------------ realtime

/** The team changed under us (someone joined, admin disbanded it…): re-read the full detail once, soon. */
let detailTimer = null;
function scheduleDetailRefresh() {
  if (detailTimer) return;
  detailTimer = setTimeout(async () => {
    detailTimer = null;
    try {
      await refreshMe();
      if (S.view === 'hub') renderHub();
    } catch { /* next update will try again */ }
  }, 600);
}

function connect() {
  if (socket) socket.disconnect();
  socket = connectSocket({ token: getToken() });

  // A reconnect usually means the server was redeployed: pick up a changed game list or order.
  let connects = 0;
  socket.on('connect', async () => {
    if (connects++ === 0) return;
    try {
      const st = await api('/api/state');
      const changed = JSON.stringify(st.games.map((g) => g.id)) !== JSON.stringify(S.games.map((g) => g.id));
      S.games = st.games;
      S.settings = st.settings;
      if (changed && S.view === 'hub' && S.me) renderHub();
    } catch { /* keep what we have */ }
  });

  socket.on('settings', (settings) => {
    if (JSON.stringify(settings) === JSON.stringify(S.settings)) return;
    const closedNow = S.settings && S.settings.playOpen && !settings.playOpen;
    // A game that just unlocked (its big-screen intro finished): tell the player to go.
    const fresh = S.settings && settings.enabledGames.find((id) => !S.settings.enabledGames.includes(id));
    // Power Connections flipped on or off (the admin's Start/Stop buttons).
    const netFlip = S.settings && (S.settings.networkOpen !== false) !== (settings.networkOpen !== false) ? settings.networkOpen !== false : null;
    S.settings = settings;
    applyTitle();
    if (S.view === 'join') renderJoin(); // chapter list may have changed
    if (S.view === 'hub' && S.me) {
      // Settings like hidden-mode change rank visibility too.
      refreshMe().then(renderHub).catch(() => renderHub());
    }
    if (closedNow && S.view !== 'game') toast('⏸ Games are now closed');
    else if (fresh && S.view === 'hub') {
      const g = gameById(fresh);
      if (g) {
        toast(`${g.emoji} ${g.name} is OPEN — go go go!`, 5000);
        sfx.bonus();
        vibrate([30, 30, 60]);
      }
    } else if (netFlip === true) {
      toast('🔗 Power Connections has STARTED — go meet members!', 5000);
      sfx.bonus();
      vibrate([30, 30, 60]);
    } else if (netFlip === false && S.view !== 'game') {
      toast('⏹ Power Connections has ended — thanks for networking!', 5000);
    }
    if (S.view === 'connect') enterConnect(); // the QR view reflects start/stop straight away
  });

  socket.on('gameintro', (gi) => {
    if (S.view === 'hub') toast(`${gi.emoji} ${gi.name} opens in a few seconds — watch the big screen!`, 6000);
  });

  socket.on('me', (live) => {
    if (!S.me) return;
    const before = { rank: S.me.rank };
    Object.assign(S.me, live);
    nudge(before);
    // Our membership or the member list changed server-side → re-read the full team detail.
    const t = S.me.team;
    const det = S.me.teamDetail;
    if (Boolean(t) !== Boolean(det) || (t && det && (t.id !== det.id || t.members !== det.members.length))) scheduleDetailRefresh();
    if (S.view === 'hub') patchHubLive();
    else if (S.view === 'tap') updateTap();
    // A round is on and we (now) have a team → straight in.
    if (S.me.team && roundActive() && (S.view === 'hub' || S.view === 'result')) enterTap();
  });

  socket.on('round', onRound);
  socket.on('livequiz', onLiveQuestion);
  socket.on('luckydraw', onLuckyDraw);

  socket.on('reset', () => {
    if (getToken()) signedOut('The event was reset — please register again');
  });

  socket.on('scoresReset', () => {
    if (!S.me) return;
    toast('↺ Scores were reset — fresh start for everyone!', 5000);
    if (S.view !== 'game') backToHub(); // a game in progress just finishes and lands on the hub
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  // A member QR scanned with the phone's own camera app lands here as /#c=<code>.
  try {
    S.pendingConnect = parseConnectCode(location.hash);
    if (S.pendingConnect) history.replaceState(null, '', location.pathname + location.search);
  } catch { /* no page hash here (tests) */ }
  try {
    const st = await api('/api/state');
    S.settings = st.settings;
    S.games = st.games;
    // Sponsor logos/names for the scrolling strip — optional, silently absent if the file isn't there.
    fetch('/sponsors.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        S.sponsors = Array.isArray(list) ? list.filter((x) => x && x.name) : [];
        if (S.sponsors.length && S.view === 'hub') renderHub();
        else if (S.sponsors.length && S.view === 'join') renderJoin();
      })
      .catch(() => {});
  } catch {
    $('#boot-msg').innerHTML = 'Can’t reach the game server.<br><br><button class="btn btn-primary" onclick="location.reload()">Try again</button>';
    $('#view-boot .spinner').remove();
    return;
  }
  applyTitle();
  if (getToken()) {
    try {
      await refreshMe();
      landHome();
      if (S.pendingConnect) {
        submitConnect(S.pendingConnect); // the scanned member connects as soon as we're in
        S.pendingConnect = '';
      }
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        renderJoin();
        show('join');
      } else {
        $('#boot-msg').textContent = err.message;
        return;
      }
    }
  } else {
    renderJoin();
    show('join');
  }
  connect();
}

// The hub's team card is re-rendered live, so its buttons are handled here rather than wired each time.
$('#view-hub').addEventListener('click', (e) => {
  if (e.target.closest('#team-join')) return enterTap();
  if (e.target.closest('#team-create')) return createTeamFlow();
  if (e.target.closest('#team-joincode')) return joinTeamFlow();
  if (e.target.closest('#team-leave')) return leaveTeamFlow();
  if (e.target.closest('#team-share')) return shareTeam();
  if (e.target.closest('#team-browse')) return browseTeams();
});

// Touch ripple on buttons and game cards — pure cosmetics, never in the way of the real handler.
document.addEventListener('pointerdown', (e) => {
  const host = e.target.closest('.btn, .icon-btn, .game-card');
  if (!host || host.disabled) return;
  const r = host.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.width = s.style.height = `${d}px`;
  s.style.left = `${(e.clientX || r.left + r.width / 2) - r.left - d / 2}px`;
  s.style.top = `${(e.clientY || r.top + r.height / 2) - r.top - d / 2}px`;
  host.appendChild(s);
  setTimeout(() => s.remove(), 650);
});

boot();
