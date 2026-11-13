// Bullseye — a marker sweeps across the bar; tap anywhere to stop it as close to centre as
// you can. 10 rounds, faster every round. Dead centre pops confetti; scoring mirrors the
// server (server/games.js): ≤3 off centre = 100, otherwise 100 − 2.5 a point, floor 0.
import { timers, vibrate, abortError, confetti } from '../common.js';

const ROUNDS = 10;
const AUTO_MS = 8000; // nobody taps? the round takes whatever the marker shows
const roundPoints = (o) => (o <= 3 ? 100 : Math.max(0, Math.min(95, Math.round(100 - o * 2.5))));

function rating(o) {
  if (o <= 3) return '🎯 BULLSEYE!';
  if (o <= 10) return '🔥 In the gold!';
  if (o <= 18) return '👍 Close!';
  if (o <= 30) return '🙂 Edging it';
  return '😅 Way off!';
}

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="be">
        <p class="be-hint" id="be-hint">Tap anywhere to stop the marker in the middle!</p>
        <div class="be-pad" id="be-pad">
          <div class="be-result" id="be-result"></div>
          <div class="be-bar"><div class="be-marker" id="be-marker"></div></div>
        </div>
        <div class="be-dots">${'<i></i>'.repeat(ROUNDS)}</div>
      </div>`;
    const pad = stage.querySelector('#be-pad');
    const marker = stage.querySelector('#be-marker');
    const resultEl = stage.querySelector('#be-result');
    const hint = stage.querySelector('#be-hint');
    const dots = [...stage.querySelectorAll('.be-dots i')];
    const offsets = [];
    const T = timers();
    let sweeping = false;
    let t0 = 0;
    let phase = 0;
    let period = 1700;
    let pos = 50;
    let raf = 0;
    let autoTimer = null;
    const total = () => Math.min(1000, offsets.reduce((s, o) => s + roundPoints(o), 0));
    hud.timeLabel('Round');
    hud.score(0);

    return new Promise((resolve, reject) => {
      function sweep() {
        pos = 50 + 50 * Math.sin(((performance.now() - t0) / period) * 2 * Math.PI + phase);
        marker.style.left = `${pos}%`;
        raf = requestAnimationFrame(sweep);
      }

      function round() {
        hud.time(`${offsets.length + 1}/${ROUNDS}`);
        resultEl.textContent = '';
        resultEl.className = 'be-result';
        period = 1700 - offsets.length * 95; // ~1.7 s a sweep down to ~0.85 s
        phase = Math.random() * 2 * Math.PI;
        t0 = performance.now();
        sweeping = true;
        marker.classList.remove('stopped');
        raf = requestAnimationFrame(sweep);
        autoTimer = T.after(() => stop(), AUTO_MS); // the round can't wait forever
      }

      function stop() {
        if (!sweeping) return;
        sweeping = false;
        cancelAnimationFrame(raf);
        T.cancel(autoTimer);
        marker.classList.add('stopped');
        const off = Math.round(Math.abs(pos - 50));
        offsets.push(off);
        dots[offsets.length - 1].classList.add('done');
        const pts = roundPoints(off);
        resultEl.textContent = `${rating(off)} +${pts}`;
        resultEl.className = `be-result show ${off <= 3 ? 'bull' : off <= 10 ? 'gold' : ''}`;
        if (off <= 3) {
          sfx.win();
          sfx.sparkle(0.15);
          vibrate([30, 40, 60]);
          confetti({ duration: 1000, count: 60 });
        } else if (off <= 10) {
          sfx.bonus();
          vibrate([15, 20, 15]);
        } else if (off <= 18) {
          sfx.good();
          vibrate(12);
        } else {
          sfx.bad();
          vibrate(50);
        }
        hud.score(total());
        live(total());
        if (offsets.length >= ROUNDS) {
          hint.textContent = `🏁 Done! ${offsets.filter((o) => o <= 3).length} bullseyes`;
          if (total() >= 800) sfx.sparkle(0.6);
          T.after(() => { cleanup(); resolve({ offsets }); }, 1400);
        } else {
          if (offsets.length === ROUNDS - 1) hint.textContent = '🏁 Last round — it’s quick now!';
          T.after(round, 1000);
        }
      }

      function onDown(e) {
        e.preventDefault();
        stop();
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        T.clear();
        pad.removeEventListener('pointerdown', onDown);
      }

      pad.addEventListener('pointerdown', onDown);
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      round();
    });
  },
};
