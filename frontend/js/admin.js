// Admin panel: event controls, big-screen modes + grand reveal, players table, export, reset.
import { api, apiUrl, connectSocket, esc, fmt, toast, photoUrl } from './common.js';

const KEY = 'bni_games_admin_key';
const $ = (sel) => document.querySelector(sel);

let key = sessionStorage.getItem(KEY) || '';
let data = null;
let controlsDrawn = false;
let refreshTimer = null;

const call = (path, opts = {}) => api(path, { ...opts, adminKey: key });

function signOut(msg) {
  key = '';
  sessionStorage.removeItem(KEY);
  $('#dash').classList.add('hidden');
  $('#login').classList.remove('hidden');
  if (msg) toast(msg);
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await refresh();
  } catch (err) {
    if (err.status === 401) return signOut('Please sign in again');
    toast(err.message);
  }
}

const saveSettings = (patch, msg = 'Saved ✓') => act(() => call('/api/admin/settings', { method: 'PUT', body: patch }), msg);

// ------------------------------------------------------------------ render

function renderStats() {
  const { stats, settings, connections, storage = '' } = data;
  const durable = /MongoDB/.test(storage);
  $('#stats').innerHTML = `
    <div class="stat ${settings.playOpen ? 'open' : 'closed'}"><span class="label">Games</span><b>${settings.playOpen ? 'Open' : 'Closed'}</b></div>
    <div class="stat"><span class="label">Big screen</span><b>${{ live: '🟢 Live', hidden: '🤫 Hidden', reveal: '🏆 Reveal' }[settings.screenMode]}</b></div>
    <div class="stat"><span class="label">Players joined</span><b>${fmt(stats.players)}</b></div>
    <div class="stat"><span class="label">Teams</span><b>${fmt(stats.teams || 0)}</b></div>
    <div class="stat"><span class="label">On leaderboard</span><b>${fmt(stats.ranked)}</b></div>
    <div class="stat"><span class="label">Games played</span><b>${fmt(stats.plays)}</b></div>
    <div class="stat"><span class="label">Playing right now</span><b>${fmt(stats.playing || 0)}</b></div>
    <div class="stat"><span class="label">Devices connected</span><b>${fmt(connections)}</b></div>
    <div class="stat ${durable ? '' : 'closed'}" title="${esc(storage)}"><span class="label">Storage</span><b class="text">${durable ? '☁️ MongoDB' : '⚠️ Local file'}</b></div>`;
  $('#ad-title').textContent = settings.eventTitle;
}

function renderControls() {
  const s = data.settings;
  const triesOpts = [1, 2, 3, 5, 10, 0]
    .map((n) => `<option value="${n}" ${s.attemptsPerGame === n ? 'selected' : ''}>${n === 0 ? 'Unlimited' : n}</option>`)
    .join('');
  const revealOpts = [3, 5, 10, 15].map((n) => `<option value="${n}" ${s.revealCount === n ? 'selected' : ''}>Top ${n}</option>`).join('');
  $('#controls').innerHTML = `
    <div class="ctl">
      <div class="ctl-label">Game play<small>Stop new games when it’s time for results</small></div>
      <div class="ctl-body">
        <div class="seg">
          <button data-play="1" class="${s.playOpen ? 'on' : ''}">▶ Open</button>
          <button data-play="0" class="${!s.playOpen ? 'on red' : ''}">⏸ Closed</button>
        </div>
        <p class="fine">Games already in progress can still finish after closing.</p>
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Big screen<small>Hide scores for suspense, then reveal</small></div>
      <div class="ctl-body">
        <div class="seg">
          <button data-mode="live" class="${s.screenMode === 'live' ? 'on' : ''}">🟢 Live</button>
          <button data-mode="hidden" class="${s.screenMode === 'hidden' ? 'on' : ''}">🤫 Hidden</button>
        </div>
        <select id="reveal-count">${revealOpts}</select>
        <button class="btn btn-gold" id="reveal-btn">🏆 Start grand reveal</button>
        <p class="fine">Hidden also hides ranks on phones. The reveal counts down from #${s.revealCount} to #1 with drumrolls and confetti — tip: close games first.</p>
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Tries per game<small>Every try adds to the total</small></div>
      <div class="ctl-body"><select id="tries">${triesOpts}</select></div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Spin &amp; Win wheel<small>2 to 12 prizes, comma separated. A plain number is points; a gift name goes on the winner's profile ticket; add stock like "Mug x25" — the draw is weighted by what's left and a gift can never run out of stock.</small></div>
      <div class="ctl-body">
        <input class="txt" id="spin-wedges" value="${esc((s.spinWedges || []).map((w) => (typeof w === 'object' ? (w.stock ? `${w.label} x${w.stock}` : w.label) : w)).join(', '))}" placeholder="Mug x25, T-shirt x10, 100">
        <button class="btn" id="spin-wedges-btn">Save wheel</button>
        ${data.spinStock?.length ? `<p class="fine">🎁 Left to win: ${data.spinStock.map((x) => `<b>${esc(x.label)}</b> ${x.left}/${x.stock}`).join(' · ')}</p>` : ''}
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Power Connections<small>Start and stop the networking game — scans only count while it's running</small></div>
      <div class="ctl-body">
        <div class="seg">
          <button data-net="1" class="${s.networkOpen !== false ? 'on' : ''}">▶ Start</button>
          <button data-net="0" class="${s.networkOpen === false ? 'on red' : ''}">⏹ Stop</button>
        </div>
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Solo games<small>Open games one by one, or run them all at once. 🏆 End closes a game and announces its champion (best single try) on the big screen.</small></div>
      <div class="ctl-body">
        <button class="btn" id="games-all-on">▶ Open all</button>
        <button class="btn" id="games-all-off">⏸ Close all</button>
        ${data.games
          .filter((g) => !g.hosted && !g.bonus && !g.social) // Live Quiz, welcome spin and Power Connections are always on
          .map((g) => {
            const opening = data.pendingIntro?.gameId === g.id; // its intro is on the big screen right now
            return `<span class="game-row"><label class="check"><input type="checkbox" data-game="${g.id}" ${s.enabledGames.includes(g.id) || opening ? 'checked' : ''} ${opening ? 'disabled' : ''}> ${g.emoji} ${esc(g.name)}${opening ? ' <small>🎬 opening…</small>' : ''}</label>
              <button class="btn end-btn" data-end="${g.id}" data-name="${esc(g.name)}" title="Close ${esc(g.name)} and announce its champion on the big screen">🏆 End</button></span>`;
          })
          .join('')}
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Team games<small>Played "for the team" — points go to the team board</small></div>
      <div class="ctl-body">${data.games
        .filter((g) => !g.hosted && !g.bonus && !g.social) // connections are personal, not a team try
        .map((g) => `<label class="check"><input type="checkbox" data-teamgame="${g.id}" ${s.teamGames.includes(g.id) ? 'checked' : ''}> ${g.emoji} ${esc(g.name)}</label>`)
        .join('')}</div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Team play<small>Tries per member per team game, and how big a team can get</small></div>
      <div class="ctl-body">
        <select id="team-tries">${[1, 2, 3, 5, 0].map((n) => `<option value="${n}" ${s.teamAttemptsPerGame === n ? 'selected' : ''}>${n === 0 ? 'Unlimited tries' : `${n} ${n === 1 ? 'try' : 'tries'} each`}</option>`).join('')}</select>
        <select id="team-size">${[2, 3, 4, 5, 6, 8, 10, 15, 20].map((n) => `<option value="${n}" ${s.maxTeamSize === n ? 'selected' : ''}>Max ${n} members</option>`).join('')}</select>
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Event title</div>
      <div class="ctl-body">
        <input class="txt" id="title" maxlength="80" value="${esc(s.eventTitle)}" placeholder="Event title">
        <input class="txt" id="tagline" maxlength="100" value="${esc(s.tagline)}" placeholder="Tagline">
        <button class="btn" id="title-btn">Save</button>
      </div>
    </div>
    <div class="ctl">
      <div class="ctl-label">Chapters<small>One per line — players pick their chapter from this dropdown when they register (no chapters = registration paused). Chapter standings show on the big screen.</small></div>
      <div class="ctl-body">
        <textarea id="chapters" placeholder="BNI Titans&#10;BNI Achievers">${esc(s.chapters.join('\n'))}</textarea>
        <button class="btn" id="chapters-btn">Save chapters</button>
      </div>
    </div>`;

  const c = $('#controls');
  c.querySelectorAll('[data-play]').forEach((b) =>
    b.addEventListener('click', () => saveSettings({ playOpen: b.dataset.play === '1' }, b.dataset.play === '1' ? 'Games opened' : 'Games closed')),
  );
  c.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => saveSettings({ screenMode: b.dataset.mode }, b.dataset.mode === 'live' ? 'Big screen is live' : 'Leaderboard hidden')),
  );
  $('#reveal-btn').onclick = () => {
    const n = Number($('#reveal-count').value);
    if (!confirm(`Start the grand reveal of the top ${n} on the big screen now?`)) return;
    act(() => call('/api/admin/reveal', { method: 'POST', body: { count: n } }), '🏆 Reveal started on the big screen');
  };
  $('#tries').onchange = (e) => saveSettings({ attemptsPerGame: Number(e.target.value) });
  $('#spin-wedges-btn').onclick = () => saveSettings({ spinWedges: $('#spin-wedges').value.split(',').map((x) => x.trim()).filter(Boolean) }, '🎡 Wheel saved');
  c.querySelectorAll('[data-net]').forEach((b) =>
    b.addEventListener('click', () => saveSettings({ networkOpen: b.dataset.net === '1' }, b.dataset.net === '1' ? '🔗 Power Connections is ON' : '⏹ Power Connections stopped')),
  );
  $('#team-tries').onchange = (e) => saveSettings({ teamAttemptsPerGame: Number(e.target.value) });
  $('#team-size').onchange = (e) => saveSettings({ maxTeamSize: Number(e.target.value) });
  c.querySelectorAll('[data-game]').forEach((box) =>
    box.addEventListener('change', () => {
      if (box.checked) {
        // Opening plays the game's intro on the big screen first; it unlocks when the countdown ends.
        act(() => call(`/api/admin/games/${box.dataset.game}/open`, { method: 'POST' }), '🎬 Intro is on the big screen — the game opens right after');
      } else {
        const enabledGames = [...c.querySelectorAll('[data-game]:checked')].map((x) => x.dataset.game);
        saveSettings({ enabledGames });
      }
    }),
  );
  $('#games-all-on').onclick = () => saveSettings({ enabledGames: [...c.querySelectorAll('[data-game]')].map((x) => x.dataset.game) }, '▶ All games opened');
  $('#games-all-off').onclick = () => saveSettings({ enabledGames: [] }, '⏸ All games closed');
  c.querySelectorAll('[data-end]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`End ${b.dataset.name}? New tries close and its champion is announced on the big screen.`)) return;
      act(() => call(`/api/admin/games/${b.dataset.end}/end`, { method: 'POST' }), `🏆 ${b.dataset.name} champion is on the big screen`);
    }),
  );
  c.querySelectorAll('[data-teamgame]').forEach((box) =>
    box.addEventListener('change', () => {
      const teamGames = [...c.querySelectorAll('[data-teamgame]:checked')].map((x) => x.dataset.teamgame);
      saveSettings({ teamGames });
    }),
  );
  $('#title-btn').onclick = () => saveSettings({ eventTitle: $('#title').value, tagline: $('#tagline').value });
  $('#chapters-btn').onclick = () => saveSettings({ chapters: $('#chapters').value.split('\n') });
  controlsDrawn = true;
}

function renderJoinCard() {
  $('#join-card').innerHTML = `
    <h3>Players join here</h3>
    <img src="${apiUrl(`/api/qr.svg?t=${Date.now()}`)}" alt="QR code">
    <div class="join-url">${esc(data.joinUrl)}</div>
    <div class="ctl-body" style="justify-content:center">
      <button class="btn" id="copy-btn">Copy link</button>
      <a class="btn" href="${apiUrl('/api/qr.svg')}" target="_blank" rel="noopener">Open QR to print</a>
    </div>`;
  $('#copy-btn').onclick = () => navigator.clipboard?.writeText(data.joinUrl).then(() => toast('Link copied'), () => toast(data.joinUrl));
}

// ------------------------------------------------------------------ teams & tap battle

let liveRound = null; // latest 'round' event from the server
let liveRoundAt = 0;

function teamStatusText() {
  const tb = data.teamBattle;
  const r = liveRound || tb.round;
  if (!tb.teams.length) return 'No teams yet';
  if (!r || r.status === 'idle') return `${tb.teams.length} teams · no round yet`;
  if (r.status === 'countdown') return `Round ${r.no} starting…`;
  if (r.status === 'running') return `Round ${r.no} running · ${Math.ceil(Math.max(0, r.remainingMs - (performance.now() - liveRoundAt)) / 1000)} s left`;
  const w = tb.teams.find((t) => t.id === r.ranking?.[0]);
  return `Round ${r.no} finished · ${r.tie ? 'a tie' : `${w?.emoji || ''} Team ${w?.name || '?'} won`}`;
}

function updateTeamStatus() {
  const el = $('#team-status');
  if (el && data) el.textContent = teamStatusText();
}
setInterval(updateTeamStatus, 500);

// Drawn once (selects keep their values); the status, buttons and table update on every refresh.
function renderTeamCard() {
  const tb = data.teamBattle;
  const card = $('#team-card');
  if (!card.innerHTML) {
    card.innerHTML = `
      <div class="tbl-head">
        <h3>👥 Teams & Tap Battle</h3>
        <div class="tbl-tools"><span class="fine" id="team-status"></span></div>
      </div>
      <p class="fine">Players create their own teams in the app and share the join code. Team-game points rank the teams on the big screen.
        <b>Tap Battle:</b> start a round and phones count down 3-2-1, then every tap adds to the team's tap total — needs at least 2 teams. Taps never affect individual or team-game scores.</p>
      <div class="ctl-body" style="margin-top:12px">
        <select id="round-dur">${[15, 30, 45, 60].map((n) => `<option value="${n * 1000}" ${n === 30 ? 'selected' : ''}>${n} seconds</option>`).join('')}</select>
        <button class="btn btn-gold" id="round-start">▶ Start Tap Battle round</button>
        <button class="btn" id="round-end">⏹ End now</button>
        <button class="btn" id="team-reset">Reset tap scores</button>
      </div>
      <div class="tbl-wrap" style="margin-top:12px"><table id="teams-table"></table></div>`;
    $('#round-start').onclick = () =>
      act(() => call('/api/admin/tap-round', { method: 'POST', body: { durationMs: Number($('#round-dur').value) } }), '▶ Round started — the big screen shows the battle');
    $('#round-end').onclick = () => act(() => call('/api/admin/tap-round/end', { method: 'POST' }), 'Round ended');
    $('#team-reset').onclick = () => {
      if (!confirm('Clear all tap-battle scores and round history? The teams and their game points stay.')) return;
      act(() => call('/api/admin/team-scores/reset', { method: 'POST' }), 'Tap scores cleared');
    };
    $('#teams-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-delteam]');
      if (!btn) return;
      if (!confirm(`Disband team ${btn.dataset.name}? Its members stay logged in (teamless) and its team points are removed.`)) return;
      act(() => call(`/api/admin/teams/${btn.dataset.delteam}`, { method: 'DELETE' }), 'Team disbanded');
    });
  }
  const teams = data.teams || [];
  const r = liveRound || tb.round;
  const active = r && (r.status === 'countdown' || r.status === 'running');
  $('#round-start').disabled = active || teams.length < 2;
  $('#round-end').disabled = !active;
  $('#team-reset').disabled = active || !tb.rounds.length;
  const wins = Object.fromEntries((tb.teams || []).map((t) => [t.id, t.wins]));
  const medals = teams.some((t) => t.total) ? ['🥇', '🥈', '🥉'] : [];
  const head = '<tr><th>Team</th><th>Code</th><th>Captain</th><th>Chapter</th><th class="num">Members</th><th class="num">Game pts</th><th class="num">This round</th><th class="num">Taps</th><th class="num">Rounds won</th><th></th></tr>';
  const body = teams.length
    ? teams
        .map((t) => `<tr><td><b>${medals[t.rank - 1] || ''} ${t.emoji} ${esc(t.name)}</b></td>
          <td><code>${esc(t.code.toUpperCase())}</code></td>
          <td>${esc(t.captain)}</td>
          <td>${esc(t.chapter) || '<span class="muted">–</span>'}</td>
          <td class="num">${t.members}</td>
          <td class="num total">${fmt(t.total)}</td>
          <td class="num">${fmt(r?.taps?.[t.id] || 0)}</td>
          <td class="num">${fmt(t.taps)}</td>
          <td class="num">${wins[t.id] || 0}</td>
          <td><button class="del" data-delteam="${t.id}" data-name="${esc(t.name)}" title="Disband team">🗑</button></td></tr>`)
        .join('')
    : '<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">No teams yet — players create them from their phones (👥 Create a team).</td></tr>';
  $('#teams-table').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  updateTeamStatus();
}

// ------------------------------------------------------------------ live quiz (hosted)

let liveQ = null; // latest 'livequiz' event from the server
let liveQAt = 0;
const quizText = (qs) => qs.map((q) => [q.q, ...q.options.map((o, i) => `- ${o}${i === q.answer ? ' *' : ''}`)].join('\n')).join('\n\n');

function liveStatusText() {
  const lq = data.liveQuiz;
  const q = liveQ || lq.current;
  const asked = lq.questions.filter((x) => x.asked).length;
  if (!q || q.status === 'idle') return `${lq.questions.length} question${lq.questions.length === 1 ? '' : 's'} · ${asked} asked`;
  if (q.status === 'open') return `Question ${q.no} open · ${Math.ceil(Math.max(0, q.remainingMs - (performance.now() - liveQAt)) / 1000)} s · ${q.answered}/${q.players} answered`;
  if (q.kind === 'vote') return `Vote ${q.no} closed · ${q.answered} vote${q.answered === 1 ? '' : 's'}`;
  const fastest = q.result?.fastest?.[0];
  return `Question ${q.no} closed · ${q.result?.correctCount ?? 0} of ${q.answered} correct${fastest ? ` · fastest ${fastest.name}` : ''}`;
}

function updateLiveStatus() {
  const el = $('#lq-status');
  if (el && data) el.textContent = liveStatusText();
}
setInterval(updateLiveStatus, 500);

// Drawn once (the editor keeps its text); status, buttons and the question list update on refresh.
function renderLiveQuizCard() {
  const lq = data.liveQuiz;
  const card = $('#livequiz-card');
  if (!card.innerHTML) {
    card.innerHTML = `
      <div class="tbl-head">
        <h3>📺 Live Quiz</h3>
        <div class="tbl-tools"><span class="fine" id="lq-status"></span></div>
      </div>
      <p class="fine">You host it: press <b>Ask</b> and the question fills the big screen while every phone shows the options. When time runs out the screen reveals the answer, how the room voted and the fastest guests.
        Correct = 50 points + up to 50 for speed, counted on the leaderboard as the 📺 Live Quiz game. Inside jokes about the members work best!</p>
      <details class="lq-edit">
        <summary>Edit questions</summary>
        <p class="fine">One question per block with a blank line between blocks: the question on the first line, then 2–6 options. Put <b>*</b> at the end of the correct one —
          or leave the * out to make it a <b>vote</b> ("Who's most likely to…" with names as options): no right answer, no points, just the bars.</p>
        <textarea id="lq-text" spellcheck="false" placeholder="Who is always first at the breakfast buffet?&#10;- Rahul *&#10;- Priya&#10;- Suresh&#10;&#10;What does TYFCB stand for?&#10;- Thank You For Closed Business *&#10;- Take Your Friends Clubbing, Buddy"></textarea>
        <div class="ctl-body" style="margin-top:8px"><button class="btn btn-primary" id="lq-save">Save questions</button><button class="btn" id="lq-undo">Discard changes</button></div>
      </details>
      <div class="ctl-body" style="margin-top:12px">
        <select id="lq-limit">${[10, 15, 20, 30].map((n) => `<option value="${n * 1000}" ${n === 15 ? 'selected' : ''}>${n} seconds to answer</option>`).join('')}</select>
        <button class="btn" id="lq-close">⏹ Close now</button>
        <button class="btn" id="lq-hide">Back to the leaderboard</button>
      </div>
      <ol class="lq-list" id="lq-list"></ol>`;
    $('#lq-text').value = quizText(lq.questions);
    $('#lq-save').onclick = saveLiveQuiz;
    $('#lq-undo').onclick = () => ($('#lq-text').value = quizText(data.liveQuiz.questions));
    $('#lq-close').onclick = () => act(() => call('/api/admin/livequiz/close', { method: 'POST' }), 'Closed — the answer is on the big screen');
    $('#lq-hide').onclick = () => act(() => call('/api/admin/livequiz/hide', { method: 'POST' }), 'Big screen is back on the leaderboard');
    $('#lq-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ask]');
      if (!b) return;
      act(() => call('/api/admin/livequiz/ask', { method: 'POST', body: { index: Number(b.dataset.ask), limitMs: Number($('#lq-limit').value) } }), '📺 Question is on the big screen');
    });
  }
  const q = liveQ || lq.current;
  const open = Boolean(q && q.status === 'open');
  $('#lq-close').disabled = !open;
  $('#lq-hide').disabled = !q || q.status === 'idle';
  $('#lq-list').innerHTML = lq.questions.length
    ? lq.questions
        .map((x) => `<li class="${x.asked ? 'asked' : ''} ${q && q.status !== 'idle' && q.index === x.i ? 'now' : ''}">
          <button class="btn btn-gold" data-ask="${x.i}" ${open ? 'disabled' : ''}>${x.asked ? 'Ask again' : 'Ask'}</button>
          <div><b>${x.answer == null ? '📊 ' : ''}${esc(x.q)}</b><small>${x.answer == null ? 'vote · ' : ''}${x.options.map((o, i) => `${i === x.answer ? '✅ ' : ''}${esc(o)}`).join(' · ')}</small></div>
          <span class="fine">${x.asked ? 'asked ✓' : ''}</span></li>`)
        .join('')
    : '<li class="muted" style="padding:14px 0">No questions yet — open “Edit questions” above and paste some.</li>';
  updateLiveStatus();
}

async function saveLiveQuiz() {
  try {
    const r = await call('/api/admin/livequiz', { method: 'PUT', body: { text: $('#lq-text').value } });
    const skipped = r.skipped.length ? ` · skipped ${r.skipped.length}: ${r.skipped.map((s) => `“${s.text}” (${s.reason})`).join('; ')}` : '';
    toast(`Saved ${r.count} question${r.count === 1 ? '' : 's'}${skipped}`, skipped ? 10000 : 3200);
    await refresh();
    $('#lq-text').value = quizText(data.liveQuiz.questions);
  } catch (err) {
    if (err.status === 401) return signOut('Please sign in again');
    toast(err.message);
  }
}

// ------------------------------------------------------------------ lucky draw

function renderDrawCard() {
  const card = $('#draw-card');
  if (!card.innerHTML) {
    card.innerHTML = `
      <div class="tbl-head">
        <h3>🎡 Lucky Draw</h3>
        <div class="tbl-tools"><span class="fine" id="draw-count"></span></div>
      </div>
      <p class="fine">Spot prizes: the big screen spins a wheel of everyone who has logged in and lands on a random guest — drumroll, confetti, and the winner's phone lights up too.</p>
      <div class="ctl-body" style="margin-top:12px">
        <label class="check"><input type="checkbox" id="draw-played"> Only guests who have played a game</label>
        <label class="check"><input type="checkbox" id="draw-exclude" checked> Skip previous winners</label>
        <button class="btn btn-gold" id="draw-spin">🎡 Spin the wheel</button>
      </div>
      <ol class="draw-list" id="draw-list"></ol>`;
    $('#draw-spin').onclick = () => {
      if (!confirm('Spin the lucky draw wheel on the big screen now?')) return;
      act(() => call('/api/admin/lucky-draw', { method: 'POST', body: { onlyPlayed: $('#draw-played').checked, excludeWinners: $('#draw-exclude').checked } }), '🎡 Spinning on the big screen…');
    };
  }
  const list = data.luckyDraws || [];
  $('#draw-count').textContent = list.length ? `${list.length} winner${list.length === 1 ? '' : 's'} so far` : 'No draws yet';
  $('#draw-list').innerHTML = [...list]
    .reverse()
    .map((d) => `<li>#${d.no} · <b>${esc(d.name)}</b> <span class="muted">${new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></li>`)
    .join('');
}

function renderPlayers() {
  const q = $('#search').value.trim().toLowerCase();
  const showPhone = true; // the mobile number is the login identity
  const showTeam = (data.teams || []).length > 0;
  const list = data.players.filter((p) => !q || `${p.name} ${p.business} ${p.chapter} ${p.phone} ${p.team}`.toLowerCase().includes(q));
  const head = `<tr><th class="num">#</th><th>Name</th><th>Business</th><th>Chapter</th>${showPhone ? '<th>Phone</th>' : ''}${showTeam ? '<th>Team</th>' : ''}
    ${data.games.map((g) => `<th class="num" title="${esc(g.name)}">${g.emoji}</th>`).join('')}
    <th class="num">Total</th><th class="num">Tries</th><th>Joined</th><th></th></tr>`;
  const body = list.length
    ? list
        .map(
          (p) => `<tr>
        <td class="num">${p.rank ?? '<span class="muted">–</span>'}</td>
        <td><span class="pthumb"><img src="${photoUrl(p.name)}" alt="" onerror="this.parentElement.remove()"></span><b>${esc(p.name)}</b></td>
        <td>${esc(p.business) || '<span class="muted">–</span>'}</td>
        <td>${esc(p.chapter) || '<span class="muted">–</span>'}</td>
        ${showPhone ? `<td>${esc(p.phone) || '<span class="muted">–</span>'}</td>` : ''}
        ${showTeam ? `<td>${esc(p.team) || '<span class="muted">–</span>'}</td>` : ''}
        ${data.games.map((g) => `<td class="num">${esc(String((g.id === 'network' ? p.connections : g.id === 'spin' ? p.spinPrize : p.scores[g.id]) || '')) || '<span class="muted">–</span>'}</td>`).join('')}
        <td class="num total">${fmt(p.total)}</td>
        <td class="num">${p.tries}</td>
        <td><span class="muted">${new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td>
        <td><button class="del" data-del="${p.id}" data-name="${esc(p.name)}" title="Remove player">🗑</button></td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="${9 + (showPhone ? 1 : 0) + (showTeam ? 1 : 0) + data.games.length}" class="muted" style="text-align:center;padding:24px">${q ? 'No matches' : 'No players yet — share the QR code!'}</td></tr>`;
  $('#players').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

async function refresh() {
  try {
    data = await call('/api/admin/overview');
  } catch (err) {
    if (err.status === 401) return signOut(key ? 'Please sign in again' : '');
    return toast(err.message);
  }
  renderStats();
  // Don't redraw controls under someone's cursor.
  if (!controlsDrawn || !$('#controls').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') renderControls();
  if (!$('#join-card').innerHTML) renderJoinCard();
  renderTeamCard();
  renderLiveQuizCard();
  renderDrawCard();
  renderPlayers();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

// ------------------------------------------------------------------ wiring

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = new FormData(e.target).get('password');
  try {
    await api('/api/admin/login', { method: 'POST', adminKey: pw });
    key = pw;
    sessionStorage.setItem(KEY, key);
    start();
  } catch (err) {
    toast(err.message);
  }
});

$('#logout-btn').onclick = () => signOut();
$('#search').addEventListener('input', () => data && renderPlayers());

$('#players').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  if (!confirm(`Remove ${btn.dataset.name} and all their scores?`)) return;
  act(() => call(`/api/admin/players/${btn.dataset.del}`, { method: 'DELETE' }), 'Player removed');
});

$('#export-btn').onclick = async () => {
  try {
    const res = await fetch(apiUrl('/api/admin/export.csv'), { headers: { 'x-admin-key': key } });
    if (!res.ok) throw new Error('Export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast(err.message);
  }
};

$('#reset-scores-btn').onclick = () => {
  if (!confirm('Reset all scores, team rounds, lucky-draw winners and quiz progress? Everyone stays logged in.')) return;
  act(() => call('/api/admin/reset-scores', { method: 'POST' }), '↺ Scores reset — everyone is still logged in');
};
$('#reset-btn').onclick = () => {
  const typed = prompt('This deletes ALL players as well as every score. Type RESET to confirm.');
  if (typed !== 'RESET') return typed != null && toast('Not reset — you must type RESET');
  act(() => call('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' } }), 'Event reset — players removed');
};

let socket = null;
function start() {
  $('#login').classList.add('hidden');
  $('#dash').classList.remove('hidden');
  refresh();
  if (!socket) {
    socket = connectSocket({ role: 'admin' });
    socket.on('connect', scheduleRefresh); // a reconnect usually means the server restarted: re-pull, never sit stale
    socket.on('changed', scheduleRefresh);
    socket.on('settings', scheduleRefresh);
    socket.on('round', (r) => {
      liveRound = r;
      liveRoundAt = performance.now();
      if (data) renderTeamCard(); // live tap counts in the table
      if (r.status === 'ended' || r.status === 'idle') scheduleRefresh(); // totals and history
    });
    socket.on('livequiz', (q) => {
      liveQ = q;
      liveQAt = performance.now();
      if (data) renderLiveQuizCard();
      if (q.status !== 'open') scheduleRefresh(); // results and the asked ✓ marks
    });
    socket.on('luckydraw', scheduleRefresh);
  }
}

if (key) start();
else $('#login').classList.remove('hidden');
