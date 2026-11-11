// Colour Clash — Stroop test: tap the INK colour, not the word. 30 seconds; streaks climb in
// pitch and the final 5 seconds pulse red.
import { vibrate, abortError } from '../common.js';

const DURATION = 30000;
const COLORS = [
  { id: 'red', name: 'RED', hex: '#ef4444', fg: '#fff' },
  { id: 'blue', name: 'BLUE', hex: '#3b82f6', fg: '#fff' },
  { id: 'green', name: 'GREEN', hex: '#22c55e', fg: '#06240f' },
  { id: 'yellow', name: 'YELLOW', hex: '#facc15', fg: '#2a2003' },
];
const WRONG_LINES = ['Fooled you! 😜', 'Read the INK, not the word! 🎨', 'Nope! 🙈', 'Your brain just blinked 🤯'];
const STREAK_LINES = { 5: '🔥 Brain not fooled!', 10: '⚡ Laser focus!', 15: '🧠 Mind of steel!', 20: '👑 Unstroopable!' };

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="clash">
        <p class="clash-hint">Tap the <b>INK colour</b> — not the word!</p>
        <div class="clash-word-wrap"><div class="clash-word"></div></div>
        <div class="clash-btns">${COLORS.map((c) => `<button class="clash-btn" type="button" data-c="${c.id}" style="--c:${c.hex};--fg:${c.fg}">${c.name}</button>`).join('')}</div>
      </div>`;
    const hint = stage.querySelector('.clash-hint');
    const wrap = stage.querySelector('.clash-word-wrap');
    const word = stage.querySelector('.clash-word');
    const btns = [...stage.querySelectorAll('.clash-btn')];
    const defaultHint = hint.innerHTML;
    const t0 = performance.now();
    let correct = 0;
    let wrong = 0;
    let streak = 0;
    let final = false;
    let ink = null;
    let lastWord = null;
    let raf = 0;
    let flashTimer = 0;
    let hintTimer = 0;
    hud.time(30);
    hud.score(0);

    return new Promise((resolve, reject) => {
      function next() {
        const w = pick(COLORS.filter((c) => c !== lastWord));
        ink = Math.random() < 0.25 ? w : pick(COLORS.filter((c) => c !== w));
        lastWord = w;
        word.textContent = w.name;
        word.style.color = ink.hex;
        word.classList.remove('pop');
        void word.offsetWidth;
        word.classList.add('pop');
      }

      function flash(cls) {
        wrap.classList.remove('ok', 'no');
        wrap.classList.add(cls);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => wrap.classList.remove(cls), 160);
      }

      function popText(text) {
        const el = document.createElement('div');
        el.className = 'clash-pop';
        el.textContent = text;
        wrap.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      function setHint(html, ms = 1200) {
        hint.innerHTML = html;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.innerHTML = streak >= 3 ? `🔥 Streak <b>×${streak}</b>` : defaultHint), ms);
      }

      function onTap(e) {
        e.preventDefault();
        if (e.currentTarget.dataset.c === ink.id) {
          correct++;
          streak++;
          streak >= 3 ? sfx.combo(streak) : sfx.good();
          vibrate(10);
          flash('ok');
          if (STREAK_LINES[streak]) {
            popText(STREAK_LINES[streak]);
            vibrate([30, 30, 30]);
          }
          if (streak >= 3) hint.innerHTML = `🔥 Streak <b>×${streak}</b>`;
        } else {
          wrong++;
          streak = 0;
          sfx.bad();
          vibrate(60);
          flash('no');
          setHint(pick(WRONG_LINES));
        }
        const pts = Math.max(0, Math.min(1000, correct * 30 - wrong * 15));
        hud.score(pts);
        live(pts);
        next();
      }

      function tick() {
        const left = DURATION - (performance.now() - t0);
        hud.time(Math.max(0, Math.ceil(left / 1000)));
        if (!final && left <= 5000) {
          final = true;
          wrap.classList.add('final');
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
        clearTimeout(flashTimer);
        clearTimeout(hintTimer);
        btns.forEach((b) => b.removeEventListener('pointerdown', onTap));
      }

      btns.forEach((b) => b.addEventListener('pointerdown', onTap));
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      next();
      tick();
    });
  },
};
