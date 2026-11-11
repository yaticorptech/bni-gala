// Memory Match — 8 pairs on a 4×4 grid, 2-minute limit. Fewer moves + less time = more points.
// Back-to-back matches build a streak; finishing earns a celebration (and a PERFECT for ≤10 moves).
import { timers, vibrate, abortError, confetti } from '../common.js';

const ICONS = ['🤝', '💼', '📈', '🏆', '💡', '🎯', '☕', '🚀'];
const LIMIT = 120000;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default {
  play(stage, { hud, sfx, signal, live }) {
    const deck = shuffle([...ICONS, ...ICONS]);
    stage.innerHTML = `
      <div class="memory">
        <div class="mem-grid">${deck
          .map(
            (icon, i) => `
          <button class="mem-card" data-i="${i}" type="button" aria-label="card">
            <span class="mem-inner"><span class="mem-face mem-back">★</span><span class="mem-face mem-front">${icon}</span></span>
          </button>`,
          )
          .join('')}</div>
        <p class="fine center" id="mem-hint">Fewer moves + faster time = more points</p>
      </div>`;
    const root = stage.querySelector('.memory');
    const cards = [...stage.querySelectorAll('.mem-card')];
    const hint = stage.querySelector('#mem-hint');
    const T = timers();
    const t0 = performance.now();
    let open = [];
    let pairs = 0;
    let moves = 0;
    let streak = 0;
    let lock = false;
    let raf = 0;
    hud.scoreLabel('Moves');
    hud.score(0);
    hud.time(clock(LIMIT));

    return new Promise((resolve, reject) => {
      function finish(endAt) {
        cleanup();
        resolve({ pairs, moves, timeMs: Math.round(endAt - t0) });
      }

      function popText(text) {
        const el = document.createElement('div');
        el.className = 'mem-pop';
        el.textContent = text;
        root.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      function onTap(e) {
        e.preventDefault();
        const card = e.currentTarget;
        if (lock || card.classList.contains('open') || card.classList.contains('matched')) return;
        card.classList.add('open');
        sfx.flip();
        open.push(card);
        if (open.length < 2) return;

        moves++;
        hud.score(moves);
        const [a, b] = open;
        open = [];
        if (deck[a.dataset.i] === deck[b.dataset.i]) {
          a.classList.add('matched');
          b.classList.add('matched');
          pairs++;
          streak++;
          // Mirror the server's scoring for the running total: 15 a pair until the last one lands.
          live(pairs === ICONS.length
            ? Math.max(150, Math.min(1000, Math.round(1000 - Math.max(0, moves - 8) * 20 - Math.max(0, (performance.now() - t0) / 1000 - 20) * 5)))
            : pairs * 15);
          streak >= 2 ? sfx.combo(streak + 4) : sfx.good();
          vibrate(15);
          if (streak >= 2) popText(`🔥 ${streak} in a row!`);
          if (pairs === ICONS.length - 1) hint.textContent = 'One more pair — you’ve got this!';
          if (pairs === ICONS.length) {
            const endAt = performance.now();
            cancelAnimationFrame(raf);
            lock = true;
            const secs = Math.round((endAt - t0) / 1000);
            const title = moves <= 10 ? '🏆 PERFECT MEMORY!' : moves <= 14 ? '🧠 Sharp as a tack!' : '✅ All matched!';
            root.insertAdjacentHTML('beforeend', `<div class="mem-done">${title}<small>${moves} moves · ${secs} seconds</small></div>`);
            sfx.win();
            vibrate([40, 40, 80]);
            confetti({ duration: 2200, count: moves <= 10 ? 220 : 140 });
            T.after(() => finish(endAt), 1500);
          }
        } else {
          streak = 0;
          lock = true;
          T.after(() => {
            a.classList.remove('open');
            b.classList.remove('open');
            lock = false;
          }, 700);
        }
      }

      function tick() {
        const left = LIMIT - (performance.now() - t0);
        hud.time(clock(left));
        if (left <= 0) return finish(t0 + LIMIT);
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        T.clear();
        cards.forEach((c) => c.removeEventListener('pointerdown', onTap));
      }

      cards.forEach((c) => c.addEventListener('pointerdown', onTap));
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      tick();
    });
  },
};
