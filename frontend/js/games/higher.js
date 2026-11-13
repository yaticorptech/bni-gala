// Higher or Lower — a card shows; call whether the next is higher or lower. 30 seconds,
// +60 right / −20 wrong (mirrors the server formula in server/games.js). Aces low, kings
// high; streaks climb in pitch and pop lines; smart players play the odds on edge cards.
import { vibrate, abortError } from '../common.js';

const DURATION = 30000;
const FACES = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUITS = [
  { s: '♠', red: false }, { s: '♥', red: true }, { s: '♦', red: true }, { s: '♣', red: false },
];
const STREAK_LINES = { 5: '🔥 Hot hand!', 10: '⚡ Card shark!', 15: '🃏 House legend!' };
const WRONG_LINES = ['Unlucky! 🙃', 'The deck bites 😬', 'Ouch! 🫣', 'House wins that one 🏦'];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (list) => list[rand(list.length)];
const face = (v) => FACES[v] || String(v);

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="hl">
        <p class="hl-hint" id="hl-hint">Will the next card be higher or lower?</p>
        <div class="hl-card-wrap" id="hl-wrap"><div class="hl-card" id="hl-card"></div></div>
        <div class="hl-btns">
          <button class="hl-btn hi" type="button" data-dir="1">⬆ HIGHER</button>
          <button class="hl-btn lo" type="button" data-dir="-1">⬇ LOWER</button>
        </div>
      </div>`;
    const hint = stage.querySelector('#hl-hint');
    const wrap = stage.querySelector('#hl-wrap');
    const card = stage.querySelector('#hl-card');
    const btns = [...stage.querySelectorAll('.hl-btn')];
    const t0 = performance.now();
    let value = 0;
    let correct = 0;
    let wrong = 0;
    let streak = 0;
    let best = 0;
    let locked = false;
    let final = false;
    let raf = 0;
    let lockTimer = 0;
    let hintTimer = 0;
    hud.time(30);
    hud.score(0);

    function show(v) {
      value = v;
      const suit = pick(SUITS);
      card.innerHTML = `<b>${face(v)}</b><span>${suit.s}</span>`;
      card.classList.toggle('red', suit.red);
      card.classList.remove('pop');
      void card.offsetWidth;
      card.classList.add('pop');
    }

    return new Promise((resolve, reject) => {
      function popText(text) {
        const el = document.createElement('div');
        el.className = 'hl-pop';
        el.textContent = text;
        wrap.appendChild(el);
        setTimeout(() => el.remove(), 900);
      }

      function setHint(text, ms = 1200) {
        hint.textContent = text;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => (hint.textContent = streak >= 3 ? `🔥 Streak ×${streak}` : 'Will the next card be higher or lower?'), ms);
      }

      function onTap(e) {
        e.preventDefault();
        if (locked || correct + wrong >= 40) return;
        locked = true;
        lockTimer = setTimeout(() => (locked = false), 280); // one call per card
        const dir = Number(e.currentTarget.dataset.dir);
        let next = 1 + rand(13);
        while (next === value) next = 1 + rand(13);
        const right = (next - value) * dir > 0;
        show(next);
        if (right) {
          correct++;
          streak++;
          best = Math.max(best, streak);
          streak >= 3 ? sfx.combo(streak) : sfx.good();
          vibrate(10);
          wrap.classList.remove('ok', 'no');
          void wrap.offsetWidth;
          wrap.classList.add('ok');
          if (STREAK_LINES[streak]) {
            popText(STREAK_LINES[streak]);
            sfx.sparkle(0.05);
            vibrate([30, 30, 30]);
          }
          if (streak >= 3) hint.textContent = `🔥 Streak ×${streak}`;
        } else {
          wrong++;
          streak = 0;
          sfx.bad();
          vibrate(60);
          wrap.classList.remove('ok', 'no');
          void wrap.offsetWidth;
          wrap.classList.add('no');
          setHint(pick(WRONG_LINES));
        }
        const pts = Math.max(0, Math.min(1000, correct * 60 - wrong * 20));
        hud.score(pts);
        live(pts);
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
          resolve({ correct, wrong, streak: best });
          return;
        }
        raf = requestAnimationFrame(tick);
      }

      function cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(lockTimer);
        clearTimeout(hintTimer);
        btns.forEach((b) => b.removeEventListener('pointerdown', onTap));
      }

      btns.forEach((b) => b.addEventListener('pointerdown', onTap));
      signal.addEventListener('abort', () => { cleanup(); reject(abortError()); }, { once: true });
      show(1 + rand(13));
      tick();
    });
  },
};
