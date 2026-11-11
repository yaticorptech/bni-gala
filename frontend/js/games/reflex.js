// Lightning Reflex — 5 rounds: wait for green, tap. Early taps cost 25 points.
import { timers, vibrate, abortError } from '../common.js';

const ROUNDS = 5;
// Mirrors the server formula (server/games.js) so the HUD shows the real score.
const roundPoints = (ms) => (ms < 100 ? 0 : Math.max(0, Math.min(200, Math.round((650 - ms) / 2.5))));

function rating(ms) {
  if (ms < 100) return '🤔 Too quick to be true…';
  if (ms < 220) return '⚡ Superhuman!';
  if (ms < 280) return '🔥 Lightning fast!';
  if (ms < 350) return '👍 Great reflexes';
  if (ms < 450) return '🙂 Not bad';
  if (ms < 600) return '🐢 Wake up!';
  return '😴 Did you doze off?';
}
const EARLY_LINES = ['Too soon! ✋', 'Jumped the gun! 🔫', 'Patience, grasshopper 🦗', 'Itchy fingers! 👆'];

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="reflex">
        <button class="reflex-pad" type="button"><span class="reflex-big"></span><span class="reflex-sub"></span></button>
        <div class="reflex-dots">${'<i></i>'.repeat(ROUNDS)}</div>
      </div>`;
    const pad = stage.querySelector('.reflex-pad');
    const big = stage.querySelector('.reflex-big');
    const sub = stage.querySelector('.reflex-sub');
    const dots = [...stage.querySelectorAll('.reflex-dots i')];
    const times = [];
    const T = timers();
    let falseStarts = 0;
    let phase = 'idle';
    let goAt = 0;
    let goTimer = null;
    const total = () => Math.max(0, times.reduce((s, t) => s + roundPoints(t), 0) - falseStarts * 25);
    hud.timeLabel('Round');
    hud.score(0);

    return new Promise((resolve, reject) => {
      function set(cls, bigText, subText) {
        pad.className = `reflex-pad ${cls}`;
        big.textContent = bigText;
        sub.textContent = subText;
      }

      function round() {
        phase = 'wait';
        hud.time(`${times.length + 1}/${ROUNDS}`);
        set('wait', 'Wait…', times.length === ROUNDS - 1 ? '🏁 Last one — make it count!' : 'Tap the moment it turns GREEN');
        goTimer = T.after(() => {
          phase = 'go';
          set('go', 'TAP!', '');
          goAt = performance.now();
          requestAnimationFrame((ts) => { goAt = Math.max(goAt, ts); }); // ≈ when green is painted
          sfx.go();
        }, 1300 + Math.random() * 2400);
      }

      function onDown(e) {
        e.preventDefault();
        if (phase === 'wait') {
          T.cancel(goTimer);
          falseStarts++;
          phase = 'pause';
          set('early', EARLY_LINES[Math.floor(Math.random() * EARLY_LINES.length)], '−25 points · wait for green');
          sfx.bad();
          vibrate(100);
          hud.score(total());
          live(total());
          T.after(round, 1400);
        } else if (phase === 'go') {
          // Event timestamps share performance.now()'s clock in modern browsers; fall back if not.
          const ts = e.timeStamp > goAt && e.timeStamp < goAt + 60000 ? e.timeStamp : performance.now();
          const ms = Math.max(0, Math.round(ts - goAt));
          times.push(ms);
          phase = 'pause';
          dots[times.length - 1].classList.add('done');
          set('result', `${ms} ms`, rating(ms));
          ms < 280 ? sfx.bonus() : sfx.good();
          vibrate(ms < 220 ? [20, 30, 20] : 15);
          hud.score(total());
          live(total());
          if (times.length >= ROUNDS) {
            T.after(() => { cleanup(); resolve({ times, falseStarts }); }, 1300);
          } else {
            T.after(round, 1300);
          }
        }
      }

      function cleanup() {
        T.clear();
        pad.removeEventListener('pointerdown', onDown);
      }

      pad.addEventListener('pointerdown', onDown);
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      round();
    });
  },
};
