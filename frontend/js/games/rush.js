// Referral Rush — whack-a-mole: tap 🤝 / ⭐, avoid 👻. 30 seconds, speeds up as it goes;
// streaks climb in pitch, and the last 5 seconds are BONUS TIME with golden referrals everywhere.
import { timers, vibrate, abortError } from '../common.js';

const DURATION = 30000;
const BONUS_AT = 5000; // ms left when bonus time kicks in
const TYPES = {
  good: { icon: '🤝', pts: 20 },
  golden: { icon: '⭐', pts: 50 },
  ghost: { icon: '👻', pts: -15 },
};
const GHOST_LINES = ['👻 Ghost client!', '👻 That lead went cold', '👻 Not a real referral!', '👻 Timewaster alert'];
const STREAK_LINES = { 5: '🔥 ON FIRE!', 10: '⚡ UNSTOPPABLE!', 15: '🚀 REFERRAL MACHINE!', 20: '👑 LEGEND!', 30: '🏆 HALL OF FAME!' };

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="rush">
        <div class="rush-banner" id="rush-banner"></div>
        <div class="rush-grid">${Array.from({ length: 9 }, (_, i) => `<div class="hole" data-i="${i}"><div class="mole"></div></div>`).join('')}</div>
        <div class="legend"><span>🤝 +20</span><span>⭐ +50</span><span>👻 −15</span><span class="streak" id="rush-streak"></span></div>
      </div>`;
    const holes = [...stage.querySelectorAll('.hole')];
    const bannerEl = stage.querySelector('#rush-banner');
    const streakEl = stage.querySelector('#rush-streak');
    const counts = { good: 0, golden: 0, ghost: 0 };
    const active = new Map(); // hole index → { type, timer }
    const T = timers();
    const t0 = performance.now();
    let raf = 0;
    let streak = 0;
    let bonus = false;
    let bannerTimer = null;
    const left = () => DURATION - (performance.now() - t0);
    const progress = () => Math.min(1, 1 - left() / DURATION);
    const score = () => Math.max(0, Math.min(1000, counts.good * 20 + counts.golden * 50 - counts.ghost * 15));
    hud.time(30);
    hud.score(0);

    return new Promise((resolve, reject) => {
      function banner(text, cls, ms = 900) {
        bannerEl.textContent = text;
        bannerEl.className = `rush-banner show ${cls}`;
        if (bannerTimer) T.cancel(bannerTimer);
        bannerTimer = T.after(() => bannerEl.classList.remove('show'), ms);
      }

      function spawn() {
        const free = holes.map((_, i) => i).filter((i) => !active.has(i));
        if (free.length) {
          const i = free[Math.floor(Math.random() * free.length)];
          const r = Math.random();
          const type = bonus
            ? r < 0.6 ? 'golden' : r < 0.8 ? 'ghost' : 'good'
            : r < 0.08 ? 'golden' : r < 0.3 ? 'ghost' : 'good';
          const life = ((type === 'golden' ? 850 : 1200) - 450 * progress()) * (bonus ? 0.85 : 1);
          const mole = holes[i].firstElementChild;
          mole.textContent = TYPES[type].icon;
          mole.className = `mole up ${type}`;
          active.set(i, { type, timer: T.after(() => hide(i, false), life) });
        }
        T.after(spawn, (700 - 280 * progress()) * (0.7 + Math.random() * 0.6) * (bonus ? 0.6 : 1));
      }

      function hide(i, wasHit) {
        const a = active.get(i);
        if (!a) return;
        T.cancel(a.timer);
        active.delete(i);
        const mole = holes[i].firstElementChild;
        mole.className = wasHit ? `mole hit ${a.type}` : 'mole';
        if (wasHit) T.after(() => { if (!active.has(i)) mole.className = 'mole'; }, 180);
      }

      function floatText(hole, text, type) {
        const el = document.createElement('div');
        el.className = `float ${type}`;
        el.textContent = text;
        hole.appendChild(el);
        setTimeout(() => el.remove(), 700);
      }

      function onTap(e) {
        e.preventDefault();
        const hole = e.currentTarget;
        const a = active.get(Number(hole.dataset.i));
        if (!a) return;
        counts[a.type]++;
        const pts = TYPES[a.type].pts;
        floatText(hole, pts > 0 ? `+${pts}` : `−${-pts}`, a.type);
        if (a.type === 'ghost') {
          streak = 0;
          streakEl.textContent = '';
          banner(GHOST_LINES[Math.floor(Math.random() * GHOST_LINES.length)], 'bad');
          sfx.bad();
          vibrate(80);
          stage.classList.remove('shake');
          void stage.offsetWidth;
          stage.classList.add('shake');
        } else {
          streak++;
          if (a.type === 'golden') sfx.bonus();
          else if (streak >= 3) sfx.combo(streak);
          else sfx.good();
          vibrate(a.type === 'golden' ? 25 : 12);
          streakEl.textContent = streak >= 3 ? `🔥 ×${streak}` : '';
          if (STREAK_LINES[streak]) {
            banner(STREAK_LINES[streak], 'hot', 1100);
            vibrate([30, 30, 30]);
          }
        }
        hide(Number(hole.dataset.i), true);
        hud.score(score());
        live(score());
      }

      function tick() {
        const l = left();
        hud.time(Math.max(0, Math.ceil(l / 1000)));
        if (!bonus && l <= BONUS_AT) {
          bonus = true;
          banner('⭐ BONUS TIME! ⭐', 'gold', 1600);
          sfx.alarm();
          vibrate([40, 40, 40]);
        }
        if (l <= 0) {
          cleanup();
          resolve({ ...counts });
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        T.clear();
        holes.forEach((h) => h.removeEventListener('pointerdown', onTap));
        stage.classList.remove('shake');
      }

      holes.forEach((h) => h.addEventListener('pointerdown', onTap));
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      spawn();
      tick();
    });
  },
};
