// Perfect Timing — tap to start the clock, tap again on exactly 5.00 s. The numbers hide
// after 2 s, so the last 3 seconds are counted in your head. 3 rounds; each is worth up to
// 334 points, −1 per 2 ms off target (mirrors the server formula in server/games.js).
import { timers, vibrate, abortError, confetti } from '../common.js';

const ROUNDS = 3;
const TARGET = 5000;
const HIDE_AT = 2000;
const roundPoints = (off) => Math.max(0, 334 - Math.ceil(off / 2));

function rating(off) {
  if (off <= 50) return '🎯 BULLSEYE!';
  if (off <= 120) return '⚡ Incredible!';
  if (off <= 250) return '🔥 Sharp!';
  if (off <= 450) return '👍 Not bad';
  if (off <= 700) return '🙂 Close-ish';
  return '😅 Way off!';
}

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="pt">
        <button class="pt-pad" type="button">
          <span class="pt-clock"></span>
          <span class="pt-sub"></span>
        </button>
        <div class="pt-dots">${'<i></i>'.repeat(ROUNDS)}</div>
      </div>`;
    const pad = stage.querySelector('.pt-pad');
    const clock = stage.querySelector('.pt-clock');
    const sub = stage.querySelector('.pt-sub');
    const dots = [...stage.querySelectorAll('.pt-dots i')];
    const times = [];
    const T = timers();
    let phase = 'idle'; // idle → running → pause
    let startAt = 0;
    let raf = 0;
    const total = () => Math.min(1000, times.reduce((s, t) => s + roundPoints(Math.abs(t - TARGET)), 0));
    hud.timeLabel('Round');
    hud.score(0);

    return new Promise((resolve, reject) => {
      function set(cls, big, small) {
        pad.className = `pt-pad ${cls}`;
        clock.textContent = big;
        sub.textContent = small;
      }

      function round() {
        phase = 'idle';
        hud.time(`${times.length + 1}/${ROUNDS}`);
        set('idle', '5.00', times.length === ROUNDS - 1 ? '🏁 Last round — tap to start' : 'Tap to start · stop on exactly 5.00');
      }

      function run() {
        const ms = performance.now() - startAt;
        if (ms < HIDE_AT) {
          clock.textContent = (ms / 1000).toFixed(2);
        } else {
          pad.classList.add('blind');
          clock.textContent = '🙈';
          sub.textContent = 'Keep counting… tap on 5.00!';
        }
        raf = requestAnimationFrame(run);
      }

      function onDown(e) {
        e.preventDefault();
        if (phase === 'idle') {
          phase = 'running';
          startAt = performance.now();
          set('running', '0.00', 'Stop it on 5.00…');
          sfx.go();
          vibrate(10);
          raf = requestAnimationFrame(run);
        } else if (phase === 'running') {
          cancelAnimationFrame(raf);
          const ms = Math.min(30000, Math.max(0, Math.round(performance.now() - startAt))); // the server rejects times past 30 s
          times.push(ms);
          phase = 'pause';
          dots[times.length - 1].classList.add('done');
          const off = Math.abs(ms - TARGET);
          set(off <= 250 ? 'great' : 'result', `${(ms / 1000).toFixed(2)}`, `${rating(off)} · ${off} ms ${ms < TARGET ? 'early' : 'late'} · +${roundPoints(off)}`);
          if (off <= 50) { sfx.win(); sfx.sparkle(0.2); vibrate([30, 40, 80]); confetti({ duration: 1200, count: 70 }); }
          else if (off <= 120) { sfx.bonus(); vibrate([20, 30, 20]); }
          else if (off <= 450) { sfx.good(); vibrate(15); }
          else { sfx.bad(); vibrate(50); }
          hud.score(total());
          live(total());
          if (times.length >= ROUNDS) {
            T.after(() => { cleanup(); resolve({ times }); }, 1500);
          } else {
            T.after(round, 1500);
          }
        }
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
