// Odd One Out — a grid of look-alike emojis with one that's different. 30 seconds; grids grow and get sneakier.
import { vibrate, abortError } from '../common.js';

const DURATION = 30000;
const PAIRS = [
  ['😀', '😃'], ['🙂', '🙃'], ['😎', '🤓'], ['🐶', '🐕'], ['🐱', '🐈'], ['🍎', '🍏'], ['⭐', '🌟'],
  ['🤝', '👏'], ['💼', '👜'], ['📈', '📉'], ['🏆', '🏅'], ['☕', '🍵'], ['💡', '🔦'], ['🌝', '🌚'],
  ['🔒', '🔓'], ['📱', '📲'], ['🚗', '🚙'], ['🍩', '🥯'], ['🐢', '🐊'], ['🌲', '🌳'], ['🦁', '🐯'],
  ['🎩', '🧢'], ['✈️', '🛩️'], ['🍺', '🍻'], ['👍', '👎'], ['🔑', '🗝️'], ['⌚', '⏰'], ['💰', '💵'],
];
const SIZES = [3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6]; // grid side per round, then 6 forever
const FONT = { 3: '2.6rem', 4: '2rem', 5: '1.55rem', 6: '1.3rem' };
const STREAK_LINES = { 5: '🔥 Eagle eyes!', 10: '⚡ Nothing gets past you!', 15: '🦅 Hawk mode!', 20: '👑 Spot-on legend!' };

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="odd">
        <p class="odd-hint" id="odd-hint">Find the one that’s different</p>
        <div class="odd-grid" id="odd-grid"></div>
      </div>`;
    const grid = stage.querySelector('#odd-grid');
    const hint = stage.querySelector('#odd-hint');
    const t0 = performance.now();
    let round = 0;
    let correct = 0;
    let wrong = 0;
    let streak = 0;
    let oddIndex = -1;
    let lastPair = null;
    let locked = false;
    let final = false;
    let raf = 0;
    let hintTimer = 0;
    hud.time(30);
    hud.score(0);
    const score = () => Math.max(0, Math.min(1000, correct * 35 - wrong * 15));

    return new Promise((resolve, reject) => {
      function next() {
        const size = SIZES[Math.min(round, SIZES.length - 1)];
        const pair = PAIRS.filter((p) => p !== lastPair)[Math.floor(Math.random() * (PAIRS.length - 1))];
        lastPair = pair;
        const [base, odd] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
        const n = size * size;
        oddIndex = Math.floor(Math.random() * n);
        grid.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
        grid.style.setProperty('--fs', FONT[size]);
        grid.innerHTML = Array.from({ length: n }, (_, i) => `<button class="odd-cell" type="button" data-i="${i}">${i === oddIndex ? odd : base}</button>`).join('');
        locked = false;
        round++;
      }

      function setHint(text, ms = 1100) {
        hint.textContent = text;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.textContent = streak >= 3 ? `🔥 Streak ×${streak}` : 'Find the one that’s different'), ms);
      }

      function onTap(e) {
        e.preventDefault();
        const cell = e.target.closest('.odd-cell');
        if (!cell || locked) return;
        const i = Number(cell.dataset.i);
        if (i === oddIndex) {
          locked = true;
          correct++;
          streak++;
          cell.classList.add('hit');
          streak >= 3 ? sfx.combo(streak) : sfx.good();
          vibrate(10);
          if (STREAK_LINES[streak]) {
            setHint(STREAK_LINES[streak]);
            vibrate([30, 30, 30]);
          } else if (streak >= 3) hint.textContent = `🔥 Streak ×${streak}`;
          hud.score(score());
          live(score());
          setTimeout(next, 180);
        } else {
          wrong++;
          streak = 0;
          cell.classList.add('miss');
          sfx.bad();
          vibrate(60);
          setHint('Not that one! −15');
          stage.classList.remove('shake');
          void stage.offsetWidth;
          stage.classList.add('shake');
          hud.score(score());
          live(score());
        }
      }

      function tick() {
        const left = DURATION - (performance.now() - t0);
        hud.time(Math.max(0, Math.ceil(left / 1000)));
        if (!final && left <= 5000) {
          final = true;
          sfx.alarm();
        }
        if (left <= 0) {
          cleanup();
          resolve({ correct, wrong });
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(hintTimer);
        grid.removeEventListener('pointerdown', onTap);
        stage.classList.remove('shake');
      }

      grid.addEventListener('pointerdown', onTap);
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      next();
      tick();
    });
  },
};
