// Follow the Lead — the shell game: a 💰 lead goes under one of three briefcases, they
// shuffle, tap where it ended up. 5 rounds, more and faster swaps each round, +200 a find.
// Finds burst sparks and chime; the final reveal never lies (the case really moves).
import { timers, vibrate, abortError, sleep, confetti } from '../common.js';

const ROUNDS = 5;
const GUESS_MS = 10000; // no tap within this = a miss, so the game always ends

export default {
  play(stage, { hud, sfx, signal, live }) {
    stage.innerHTML = `
      <div class="cup">
        <p class="cup-hint" id="cup-hint">Watch where the 💰 goes…</p>
        <div class="cup-stage" id="cup-stage">
          ${[0, 1, 2].map((i) => `<button class="cup-case" type="button" data-slot="${i}" style="--slot:${i}">💼</button>`).join('')}
          <div class="cup-money" id="cup-money">💰</div>
        </div>
        <div class="cup-dots">${'<i></i>'.repeat(ROUNDS)}</div>
      </div>`;
    const hint = stage.querySelector('#cup-hint');
    const cases = [...stage.querySelectorAll('.cup-case')];
    const money = stage.querySelector('#cup-money');
    const dots = [...stage.querySelectorAll('.cup-dots i')];
    const T = timers();
    let correct = 0;
    let round = 0;
    let winner = null; // the case element hiding the money
    hud.timeLabel('Round');
    hud.score(0);

    const slotOf = (c) => Number(c.style.getPropertyValue('--slot'));
    const setSlot = (c, s) => c.style.setProperty('--slot', s);
    const wait = (ms) => sleep(ms, signal);

    async function swapOnce(dur) {
      const [a, b] = [...cases].sort(() => Math.random() - 0.5);
      const sa = slotOf(a);
      const sb = slotOf(b);
      a.classList.add('over'); // one case arcs over the other
      setSlot(a, sb);
      setSlot(b, sa);
      sfx.flip();
      await wait(dur);
      a.classList.remove('over');
    }

    async function playRound() {
      round++;
      hud.time(`${round}/${ROUNDS}`);
      hint.textContent = 'Watch where the 💰 goes…';
      winner = cases[Math.floor(Math.random() * 3)];
      // Show the money under its case…
      money.style.setProperty('--slot', slotOf(winner));
      money.classList.add('show');
      winner.classList.add('up');
      sfx.tick();
      await wait(1000);
      winner.classList.remove('up');
      await wait(350);
      money.classList.remove('show');
      // …shuffle…
      hint.textContent = '👀 Keep watching…';
      const swaps = 4 + round * 2;
      const dur = Math.max(210, 400 - round * 40);
      for (let i = 0; i < swaps; i++) await swapOnce(dur);
      // …and ask.
      hint.textContent = 'Where did it end up? Tap a briefcase!';
      stage.classList.add('cup-pick');
      const picked = await new Promise((res, rej) => {
        if (signal.aborted) return rej(abortError());
        const timer = T.after(() => res(null), GUESS_MS);
        const onAbort = () => { T.cancel(timer); rej(abortError()); };
        signal.addEventListener('abort', onAbort, { once: true });
        cases.forEach((c) => (c.onpointerdown = (e) => { e.preventDefault(); T.cancel(timer); signal.removeEventListener('abort', onAbort); res(c); }));
      });
      stage.classList.remove('cup-pick');
      cases.forEach((c) => (c.onpointerdown = null));
      money.style.setProperty('--slot', slotOf(winner));
      if (picked === winner) {
        correct++;
        money.classList.add('show');
        winner.classList.add('up', 'won');
        hint.textContent = '💰 Found it! +200';
        sfx.bonus();
        sfx.sparkle(0.1);
        vibrate([20, 30, 40]);
        confetti({ duration: 900, count: 45 });
      } else {
        if (picked) {
          picked.classList.add('up', 'lost');
          sfx.bad();
          vibrate(70);
          hint.textContent = 'Empty! It was over here…';
          await wait(700);
        } else {
          hint.textContent = '⏰ Too slow! It was here…';
          sfx.bad();
        }
        money.classList.add('show');
        winner.classList.add('up');
      }
      dots[round - 1].classList.add('done');
      if (picked !== winner) dots[round - 1].classList.add('miss');
      hud.score(correct * 200);
      live(correct * 200);
      await wait(1300);
      cases.forEach((c) => c.classList.remove('up', 'won', 'lost'));
      money.classList.remove('show');
      await wait(400);
    }

    return (async () => {
      try {
        for (let i = 0; i < ROUNDS; i++) await playRound();
        hint.textContent = `🏁 ${correct} of ${ROUNDS} found!`;
        if (correct >= 4) { sfx.win(); confetti({ duration: 1300, count: 80 }); }
        await wait(1100);
        return { correct };
      } finally {
        T.clear();
        cases.forEach((c) => (c.onpointerdown = null));
      }
    })();
  },
};
