// Quick Maths — easy sums, four answers, 30 seconds. +35 right, −15 wrong (mirrors the
// server formula in server/games.js). Starts with single-digit adds and grows a little.
import { vibrate, abortError } from '../common.js';

const DURATION = 30000;
const WRONG_LINES = ['Carry the one! ✏️', 'Close, but no 🙈', 'Maths is hard 😅', 'Check again! 🔢'];
const STREAK_LINES = { 5: '🔥 Calculator brain!', 10: '⚡ Human abacus!', 15: '🧠 Mathemagician!' };

const rand = (n) => Math.floor(Math.random() * n);
const pick = (list) => list[rand(list.length)];

/** A sum that gets gently harder: adds → subtractions → small times tables. */
function makeQuestion(solved) {
  const lvl = Math.min(3, Math.floor(solved / 5));
  let a, b, op, answer;
  if (lvl === 0) { a = 2 + rand(8); b = 2 + rand(8); op = '+'; answer = a + b; }
  else if (lvl === 1) { a = 6 + rand(14); b = 2 + rand(a - 2); op = pick(['+', '−']); answer = op === '+' ? a + b : a - b; }
  else if (lvl === 2) { a = 2 + rand(8); b = 2 + rand(8); op = '×'; answer = a * b; }
  else { a = 11 + rand(29); b = 6 + rand(24); op = pick(['+', '−']); if (op === '−' && b > a) [a, b] = [b, a]; answer = op === '+' ? a + b : a - b; }
  // Three lookalike wrong answers near the right one, all different and non-negative.
  const options = new Set([answer]);
  while (options.size < 4) {
    const off = pick([1, 2, 10, op === '×' ? a : 3, op === '×' ? b : 4]) * pick([-1, 1]);
    if (answer + off >= 0) options.add(answer + off);
  }
  return { text: `${a} ${op} ${b}`, answer, options: [...options].sort(() => Math.random() - 0.5) };
}

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="qm">
        <p class="qm-hint" id="qm-hint">Tap the right answer!</p>
        <div class="qm-sum-wrap"><div class="qm-sum" id="qm-sum"></div></div>
        <div class="qm-btns" id="qm-btns"></div>
      </div>`;
    const hint = stage.querySelector('#qm-hint');
    const wrap = stage.querySelector('.qm-sum-wrap');
    const sum = stage.querySelector('#qm-sum');
    const btnsEl = stage.querySelector('#qm-btns');
    const t0 = performance.now();
    let q = null;
    let correct = 0;
    let wrong = 0;
    let streak = 0;
    let final = false;
    let raf = 0;
    let flashTimer = 0;
    let hintTimer = 0;
    hud.time(30);
    hud.score(0);

    return new Promise((resolve, reject) => {
      function next() {
        q = makeQuestion(correct);
        sum.textContent = `${q.text} = ?`;
        sum.classList.remove('pop');
        void sum.offsetWidth;
        sum.classList.add('pop');
        btnsEl.innerHTML = q.options.map((o) => `<button class="qm-btn" type="button" data-v="${o}">${o}</button>`).join('');
      }

      function flash(cls) {
        wrap.classList.remove('ok', 'no');
        wrap.classList.add(cls);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => wrap.classList.remove(cls), 160);
      }

      function setHint(text, ms = 1200) {
        hint.textContent = text;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.textContent = streak >= 3 ? `🔥 Streak ×${streak}` : 'Tap the right answer!'), ms);
      }

      function popText(text) {
        const el = document.createElement('div');
        el.className = 'qm-pop';
        el.textContent = text;
        wrap.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      function onTap(e) {
        const b = e.target.closest('.qm-btn');
        if (!b || !q) return;
        e.preventDefault();
        if (Number(b.dataset.v) === q.answer) {
          correct++;
          streak++;
          streak >= 3 ? sfx.combo(streak) : sfx.good();
          vibrate(10);
          flash('ok');
          if (STREAK_LINES[streak]) {
            popText(STREAK_LINES[streak]);
            sfx.sparkle(0.05);
            vibrate([30, 30, 30]);
            setHint(STREAK_LINES[streak]);
          } else if (streak >= 3) hint.textContent = `🔥 Streak ×${streak}`;
        } else {
          wrong++;
          streak = 0;
          sfx.bad();
          vibrate(60);
          flash('no');
          b.classList.add('shake-no');
          setHint(pick(WRONG_LINES));
        }
        const pts = Math.max(0, Math.min(1000, correct * 35 - wrong * 15));
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
        btnsEl.removeEventListener('pointerdown', onTap);
      }

      btnsEl.addEventListener('pointerdown', onTap);
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      next();
      tick();
    });
  },
};
