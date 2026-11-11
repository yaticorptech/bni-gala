// Handshake Sequence — Simon says: four pads light up in a growing sequence, tap it back. One slip ends the run.
import { timers, vibrate, abortError } from '../common.js';

const PADS = [
  { c: '#e3263a', f: 392 },
  { c: '#3b82f6', f: 494 },
  { c: '#22c55e', f: 587 },
  { c: '#f7c548', f: 784 },
];
const MAX_LEVEL = 20;
const INPUT_TIMEOUT = 8000; // ms allowed between taps before it counts as a slip
// Mirrors the server formula (server/games.js): level 10 = 1000.
const points = (level) => Math.min(1000, level <= 5 ? level * 80 : 400 + (level - 5) * 120);
const CHEERS = ['Nice!', 'Smooth 🤝', 'Keep going!', 'You’ve got this', 'Impressive!', '🔥 On a roll', 'Unreal!', '🧠 Elephant memory!'];

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="simon">
        <div class="simon-status" id="simon-status">Watch the pattern…</div>
        <div class="simon-grid locked" id="simon-grid">${PADS.map((p, i) => `<button class="simon-pad" type="button" data-i="${i}" style="--c:${p.c}" aria-label="pad ${i + 1}"></button>`).join('')}</div>
        <p class="fine center">Repeat the sequence · each level adds one more</p>
      </div>`;
    const grid = stage.querySelector('#simon-grid');
    const status = stage.querySelector('#simon-status');
    const pads = [...stage.querySelectorAll('.simon-pad')];
    const T = timers();
    const seq = [];
    let done = 0; // levels completed
    let input = 0;
    let phase = 'show'; // show | input | over
    let inputTimer = null;
    hud.timeLabel('Level');
    hud.time(1);
    hud.score(0);

    return new Promise((resolve, reject) => {
      function light(i, ms) {
        pads[i].classList.add('lit');
        sfx.note(PADS[i].f, ms / 1000);
        T.after(() => pads[i].classList.remove('lit'), ms);
      }

      function showSequence() {
        phase = 'show';
        grid.classList.add('locked');
        const level = seq.length;
        const step = Math.max(260, 520 - level * 22); // speeds up as it grows
        status.innerHTML = `Watch the pattern…<small>Level ${level} · ${level} step${level === 1 ? '' : 's'}</small>`;
        seq.forEach((i, k) => T.after(() => light(i, step * 0.65), 600 + k * step));
        T.after(() => {
          phase = 'input';
          input = 0;
          grid.classList.remove('locked');
          status.innerHTML = `Your turn!<small>Tap the ${level} pad${level === 1 ? '' : 's'} in order</small>`;
          armTimeout();
        }, 600 + level * step + 150);
      }

      function armTimeout() {
        if (inputTimer) T.cancel(inputTimer);
        inputTimer = T.after(() => gameOver('⏰ Too slow!'), INPUT_TIMEOUT);
      }

      function nextLevel() {
        seq.push(Math.floor(Math.random() * 4));
        hud.time(seq.length);
        showSequence();
      }

      function gameOver(why) {
        phase = 'over';
        if (inputTimer) T.cancel(inputTimer);
        grid.classList.add('locked');
        sfx.bad();
        vibrate([80, 40, 120]);
        stage.classList.remove('shake');
        void stage.offsetWidth;
        stage.classList.add('shake');
        status.innerHTML = `${why}<small>You completed a sequence of ${done}</small>`;
        T.after(() => { cleanup(); resolve({ level: done }); }, 1500);
      }

      function onTap(e) {
        e.preventDefault();
        if (phase !== 'input') return;
        const i = Number(e.currentTarget.dataset.i);
        if (i !== seq[input]) {
          pads[i].classList.add('wrong');
          return gameOver('✋ Wrong pad!');
        }
        light(i, 220);
        vibrate(10);
        input++;
        armTimeout();
        if (input < seq.length) return;
        // Level complete.
        done = seq.length;
        phase = 'show';
        if (inputTimer) T.cancel(inputTimer);
        hud.score(points(done));
        live(points(done));
        status.innerHTML = `${CHEERS[Math.min(CHEERS.length - 1, Math.floor(done / 2))]}<small>Level ${done} done · ${points(done)} points</small>`;
        done >= 5 ? sfx.combo(done) : sfx.good();
        if (done >= MAX_LEVEL) {
          status.innerHTML = `🏆 MAXED OUT!<small>A perfect ${MAX_LEVEL}-step sequence</small>`;
          T.after(() => { cleanup(); resolve({ level: done }); }, 1500);
          return;
        }
        T.after(nextLevel, 900);
      }

      function cleanup() {
        T.clear();
        pads.forEach((p) => p.removeEventListener('pointerdown', onTap));
        stage.classList.remove('shake');
      }

      pads.forEach((p) => p.addEventListener('pointerdown', onTap));
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      T.after(nextLevel, 400);
    });
  },
};
