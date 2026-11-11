// Tap Frenzy — one big button, 10 seconds, tap as fast as you can. Every tap is 7 points
// (143 taps = a perfect 1000). Taps anywhere in the play area count, so thumbs can go wild.
// Pace tiers (taps in the last second) heat the button up to FEVER mode; milestones pop; a
// ring counts the time down; every tap sparks a +7 and a ripple where the finger landed.
import { vibrate, abortError } from '../common.js';

const DURATION = 10000;
const POINTS = 7; // mirrors the server formula (server/games.js)
const RING = 2 * Math.PI * 47; // circumference of the countdown ring (r=47 in a 100×100 viewBox)
const MILESTONES = { 25: '🔥 Warming up!', 50: '⚡ Fast fingers!', 75: '🚀 Unstoppable!', 100: '🏆 Century!', 125: '👑 Legendary!' };
const TIERS = [
  { min: 0, label: 'Warm up…' },
  { min: 5, label: '👍 Good pace' },
  { min: 8, label: '🔥 On fire!' },
  { min: 11, label: '⚡ FEVER MODE!' },
];

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="frenzy" data-tier="0">
        <p class="frenzy-hint" id="frenzy-hint">Tap anywhere — as fast as you can!</p>
        <div class="frenzy-wrap">
          <svg class="frenzy-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="track" cx="50" cy="50" r="47"></circle>
            <circle class="left" cx="50" cy="50" r="47" stroke-dasharray="${RING}" stroke-dashoffset="0"></circle>
          </svg>
          <button class="frenzy-btn" type="button" aria-label="Tap!">
            <span class="frenzy-count" id="frenzy-count">0</span>
            <span class="frenzy-sub">taps</span>
          </button>
        </div>
        <div class="frenzy-tier" id="frenzy-rate">Warm up…</div>
      </div>`;
    const root = stage.querySelector('.frenzy');
    const wrap = stage.querySelector('.frenzy-wrap');
    const btn = stage.querySelector('.frenzy-btn');
    const ring = stage.querySelector('.frenzy-ring .left');
    const count = stage.querySelector('#frenzy-count');
    const tierEl = stage.querySelector('#frenzy-rate');
    const hint = stage.querySelector('#frenzy-hint');
    const t0 = performance.now();
    const recent = []; // tap times within the last second: the pace
    let taps = 0;
    let tier = 0;
    let bestPace = 0;
    let lastBeep = null;
    let raf = 0;
    let endTimer = 0;
    hud.time(10);
    hud.scoreLabel('Points');
    hud.score(0);

    return new Promise((resolve, reject) => {
      function popText(text) {
        const el = document.createElement('div');
        el.className = 'frenzy-pop';
        el.textContent = text;
        root.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      /** A "+7" that floats away and a ripple ring, both from where the finger landed. */
      function spark(x, y) {
        const plus = document.createElement('span');
        plus.className = 'frenzy-plus';
        plus.textContent = `+${POINTS}`;
        plus.style.left = `${x}px`;
        plus.style.top = `${y}px`;
        plus.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 70)}px`);
        const ripple = document.createElement('i');
        ripple.className = 'frenzy-ripple';
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        root.append(plus, ripple);
        setTimeout(() => { plus.remove(); ripple.remove(); }, 650);
      }

      function onTap(e) {
        e.preventDefault();
        const now = performance.now();
        if (now - t0 >= DURATION) return;
        taps++;
        recent.push(now);
        count.textContent = taps;
        hud.score(taps * POINTS);
        live(taps * POINTS);
        btn.classList.remove('hit');
        void btn.offsetWidth;
        btn.classList.add('hit');
        // Where did the finger land? (synthetic events have no coordinates: use the button's centre)
        const r = root.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const x = e.clientX || e.clientY ? e.clientX - r.left : b.left - r.left + b.width / 2;
        const y = e.clientX || e.clientY ? e.clientY - r.top : b.top - r.top + b.height / 2;
        spark(x, y);
        sfx.tapAt(recent.length);
        vibrate(5);
        if (MILESTONES[taps]) {
          popText(MILESTONES[taps]);
          sfx.combo(Math.round(taps / 10));
          vibrate([20, 20, 20]);
          stage.classList.remove('shake');
          void stage.offsetWidth;
          stage.classList.add('shake');
        }
      }

      function setTier(next, pace) {
        if (next !== tier) {
          if (next > tier) next === 3 ? sfx.fever() : sfx.rise();
          if (next === 3) vibrate([30, 30, 60]);
          tier = next;
          root.dataset.tier = String(tier);
        }
        tierEl.textContent = pace ? `${TIERS[tier].label} · ${pace} taps/s` : TIERS[tier].label;
      }

      function tick() {
        const now = performance.now();
        const left = DURATION - (now - t0);
        const sec = Math.max(0, Math.ceil(left / 1000));
        hud.time(sec);
        ring.setAttribute('stroke-dashoffset', String(RING * (1 - Math.max(0, left) / DURATION)));
        while (recent.length && now - recent[0] > 1000) recent.shift();
        const pace = recent.length;
        bestPace = Math.max(bestPace, pace);
        root.style.setProperty('--heat', Math.min(1, pace / 11));
        setTier(TIERS.reduce((t, x, i) => (pace >= x.min ? i : t), 0), pace);
        if (left > 0 && left <= 3000 && sec !== lastBeep) {
          lastBeep = sec;
          sfx.tick();
          hint.textContent = `⏰ ${sec}… go go go!`;
        }
        if (left <= 0) {
          cancelAnimationFrame(raf);
          root.removeEventListener('pointerdown', onTap);
          root.classList.add('final');
          root.style.setProperty('--heat', 0);
          hint.textContent = `⏱️ Time! ${taps} taps · ${taps * POINTS} points · best pace ${bestPace}/s`;
          tierEl.textContent = taps >= 125 ? '👑 Legendary!' : taps >= 100 ? '🏆 Century club!' : taps >= 75 ? '🚀 Serious speed!' : taps >= 50 ? '⚡ Nice fingers!' : '👍 Good effort!';
          sfx.buzz();
          vibrate([60, 40, 100]);
          endTimer = setTimeout(() => { cleanup(); resolve({ taps }); }, 1400);
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(endTimer);
        root.removeEventListener('pointerdown', onTap);
        stage.classList.remove('shake');
      }

      root.addEventListener('pointerdown', onTap);
      wrap.addEventListener('contextmenu', (e) => e.preventDefault());
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      tick();
    });
  },
};
