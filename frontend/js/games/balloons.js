// Balloon Burst — balloons drift up the screen, pop them with a tap (+20). Golden ⭐
// balloons pay +50. No penalties; the last 5 seconds are a balloon rush. Every pop bursts
// into flying scraps with a rising pop sound; streaks climb in pitch.
import { timers, vibrate, abortError } from '../common.js';

const DURATION = 30000;
const RUSH_AT = 5000; // ms left when the balloon rush starts
const COLORS = ['#f43f5e', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];
const STREAK_LINES = { 5: '🔥 Pop star!', 10: '⚡ Unpoppable!', 15: '🎪 Balloon machine!', 20: '👑 LEGEND!' };

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="bal">
        <div class="bal-banner" id="bal-banner"></div>
        <div class="bal-sky" id="bal-sky"></div>
        <div class="legend"><span>🎈 +20</span><span>⭐ +50</span><span class="streak" id="bal-streak"></span></div>
      </div>`;
    const sky = stage.querySelector('#bal-sky');
    const bannerEl = stage.querySelector('#bal-banner');
    const streakEl = stage.querySelector('#bal-streak');
    const T = timers();
    const t0 = performance.now();
    let popped = 0;
    let golden = 0;
    let streak = 0;
    let rush = false;
    let raf = 0;
    let bannerTimer = null;
    const left = () => DURATION - (performance.now() - t0);
    const progress = () => Math.min(1, 1 - left() / DURATION);
    const score = () => Math.min(1000, popped * 20 + golden * 50);
    hud.time(30);
    hud.score(0);

    return new Promise((resolve, reject) => {
      function banner(text, cls, ms = 1000) {
        bannerEl.textContent = text;
        bannerEl.className = `bal-banner show ${cls}`;
        if (bannerTimer) T.cancel(bannerTimer);
        bannerTimer = T.after(() => bannerEl.classList.remove('show'), ms);
      }

      /** The pop: flying scraps of the balloon's colour plus a floating +points. */
      function burst(x, y, color, pts) {
        for (let i = 0; i < 8; i++) {
          const s = document.createElement('i');
          s.className = 'bal-scrap';
          s.style.left = `${x}px`;
          s.style.top = `${y}px`;
          s.style.background = color;
          s.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 130)}px`);
          s.style.setProperty('--dy', `${Math.round(-20 - Math.random() * 110)}px`);
          sky.appendChild(s);
          setTimeout(() => s.remove(), 600);
        }
        const plus = document.createElement('span');
        plus.className = 'bal-plus';
        plus.textContent = `+${pts}`;
        plus.style.left = `${x}px`;
        plus.style.top = `${y}px`;
        if (pts >= 50) plus.classList.add('gold');
        sky.appendChild(plus);
        setTimeout(() => plus.remove(), 750);
      }

      function pop(b, e) {
        if (b.dataset.done) return;
        b.dataset.done = '1';
        const r = sky.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const x = (e?.clientX || br.left + br.width / 2) - r.left;
        const y = (e?.clientY || br.top + br.height / 2) - r.top;
        const gold = b.classList.contains('gold');
        gold ? golden++ : popped++;
        streak++;
        burst(x, y, gold ? '#f7c548' : b.style.getPropertyValue('--c'), gold ? 50 : 20);
        if (gold) {
          sfx.bonus();
          sfx.sparkle(0.05);
          vibrate([20, 30, 20]);
          banner('⭐ GOLDEN! +50 ⭐', 'gold');
        } else {
          streak >= 3 ? sfx.combo(streak) : sfx.good();
          vibrate(10);
        }
        streakEl.textContent = streak >= 3 ? `🔥 ×${streak}` : '';
        if (STREAK_LINES[streak]) {
          banner(STREAK_LINES[streak], 'hot', 1100);
          vibrate([30, 30, 30]);
        }
        hud.score(score());
        live(score());
        b.remove();
      }

      function spawn() {
        if (left() <= 400) return; // nothing new in the last moments
        const b = document.createElement('button');
        b.type = 'button';
        const gold = Math.random() < (rush ? 0.3 : 0.13);
        b.className = `bal-b${gold ? ' gold' : ''}`;
        b.style.setProperty('--c', COLORS[Math.floor(Math.random() * COLORS.length)]);
        b.style.left = `${6 + Math.random() * 78}%`;
        b.style.setProperty('--sway', `${Math.round((Math.random() - 0.5) * 50)}px`);
        const rise = (4400 - 1300 * progress()) * (rush ? 0.8 : 1) * (0.85 + Math.random() * 0.3);
        b.style.setProperty('--rise', `-${sky.clientHeight + 170}px`);
        b.style.setProperty('--dur', `${Math.round(rise)}ms`);
        if (gold) b.textContent = '⭐';
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); pop(b, e); });
        b.addEventListener('animationend', () => {
          if (!b.dataset.done) streak = 0; // one slipped away — the streak deflates with it
          streakEl.textContent = streak >= 3 ? `🔥 ×${streak}` : '';
          b.remove();
        });
        sky.appendChild(b);
        // Spawn pace tuned so a perfect popper lands ~60 balloons in 30 s (the server caps at 70).
        T.after(spawn, (620 - 160 * progress()) * (rush ? 0.55 : 1) * (0.8 + Math.random() * 0.5));
      }

      function tick() {
        const l = left();
        hud.time(Math.max(0, Math.ceil(l / 1000)));
        if (!rush && l <= RUSH_AT) {
          rush = true;
          banner('🎈 BALLOON RUSH! 🎈', 'gold', 1600);
          sfx.alarm();
          vibrate([40, 40, 40]);
        }
        if (l <= 0) {
          cleanup();
          sky.classList.add('done');
          sfx.buzz();
          vibrate([60, 40, 100]);
          T.clear();
          setTimeout(() => resolve({ popped, golden }), 900);
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        T.clear();
      }

      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      spawn();
      tick();
    });
  },
};
