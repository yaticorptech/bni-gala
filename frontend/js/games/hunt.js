// Number Hunt — numbers 1 to 20 scattered on a grid, tap them in order, beat the clock.
// Every find pops; streaks of quick finds climb in pitch; finishing fires confetti.
// Scoring mirrors the server (server/games.js): under 18 s with no wrong taps = 1000.
import { vibrate, abortError, confetti } from '../common.js';

const DURATION = 60000;
const COUNT = 20;
const WRONG_LINES = ['Not that one! 🙈', 'Look again! 👀', 'So close! 😅', 'Where is it…? 🔍'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const mirror = (timeMs, wrong) => Math.max(150, Math.min(1000, Math.round(1000 - Math.max(0, timeMs / 1000 - 18) * 35 - wrong * 15)));

export default {
  play(stage, { hud, sfx, signal, live }) {
    const order = Array.from({ length: COUNT }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    stage.innerHTML = `
      <div class="hunt">
        <p class="hunt-hint" id="hunt-hint">Find <b class="hunt-next" id="hunt-next">1</b></p>
        <div class="hunt-grid">${order.map((n) => `<button class="hunt-cell" type="button" data-n="${n}">${n}</button>`).join('')}</div>
      </div>`;
    const hint = stage.querySelector('#hunt-hint');
    const nextEl = stage.querySelector('#hunt-next');
    const grid = stage.querySelector('.hunt-grid');
    const t0 = performance.now();
    let next = 1;
    let wrong = 0;
    let lastFindAt = t0;
    let quickStreak = 0;
    let final = false;
    let raf = 0;
    let hintTimer = 0;
    let endTimer = 0;
    hud.time(60);
    hud.scoreLabel('Found');
    hud.score(`0/${COUNT}`);

    return new Promise((resolve, reject) => {
      function burst(cell) {
        // Little sparks flying out of the found number.
        const r = cell.getBoundingClientRect();
        const g = grid.getBoundingClientRect();
        for (let i = 0; i < 6; i++) {
          const s = document.createElement('i');
          s.className = 'hunt-spark';
          s.style.left = `${r.left - g.left + r.width / 2}px`;
          s.style.top = `${r.top - g.top + r.height / 2}px`;
          s.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
          s.style.setProperty('--dy', `${Math.round((Math.random() - 0.5) * 90)}px`);
          grid.appendChild(s);
          setTimeout(() => s.remove(), 500);
        }
      }

      function setHint(html, ms = 1100) {
        hint.innerHTML = html;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.innerHTML = `Find <b class="hunt-next">${next}</b>`), ms);
      }

      function finish(completed) {
        const timeMs = Math.round(performance.now() - t0);
        cleanup();
        if (completed) {
          grid.classList.add('won');
          hint.innerHTML = `🏁 All ${COUNT} in <b>${(timeMs / 1000).toFixed(1)} s</b>!`;
          sfx.win();
          sfx.sparkle(0.3);
          vibrate([40, 40, 80]);
          confetti({ duration: 1500, count: 90 });
        } else {
          hint.textContent = `⏱️ Time! ${next - 1} of ${COUNT} found`;
          sfx.buzz();
          vibrate(80);
        }
        endTimer = setTimeout(() => resolve({ found: completed ? COUNT : next - 1, wrong, timeMs }), completed ? 1600 : 1200);
      }

      function onTap(e) {
        const cell = e.target.closest('.hunt-cell');
        if (!cell || cell.classList.contains('found')) return;
        e.preventDefault();
        if (Number(cell.dataset.n) === next) {
          const now = performance.now();
          quickStreak = now - lastFindAt < 1600 ? quickStreak + 1 : 1;
          lastFindAt = now;
          cell.classList.add('found');
          burst(cell);
          quickStreak >= 3 ? sfx.combo(quickStreak) : sfx.good();
          vibrate(12);
          if (quickStreak >= 3) setHint(`🔥 On a roll ×${quickStreak}`);
          next++;
          hud.score(`${next - 1}/${COUNT}`);
          live(mirror(now - t0, wrong) * ((next - 1) / COUNT)); // rough running score for the big screen
          if (next > COUNT) return finish(true);
          nextEl.textContent = next;
        } else {
          wrong++;
          quickStreak = 0;
          cell.classList.remove('shake-no');
          void cell.offsetWidth;
          cell.classList.add('shake-no');
          sfx.bad();
          vibrate(60);
          setHint(`${pick(WRONG_LINES)} Find <b class="hunt-next">${next}</b>`);
        }
      }

      function tick() {
        const left = DURATION - (performance.now() - t0);
        hud.time(Math.max(0, Math.ceil(left / 1000)));
        if (!final && left <= 10000) {
          final = true;
          grid.classList.add('final');
          sfx.alarm();
        }
        if (left <= 0) return finish(false);
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(hintTimer);
        grid.removeEventListener('pointerdown', onTap);
      }

      grid.addEventListener('pointerdown', onTap);
      signal.addEventListener('abort', () => { cleanup(); clearTimeout(endTimer); reject(abortError()); }, { once: true });
      tick();
    });
  },
};
