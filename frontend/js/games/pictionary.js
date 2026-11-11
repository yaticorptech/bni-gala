// Emoji Pictionary — guess the profession from two emojis. 10 puzzles, 8 s each; the puzzles,
// answers and timing all live on the server (same machinery as the quiz).
import { api, withRetry, esc, sleep, abortError } from '../common.js';

export default {
  async play(stage, { attempt, hud, sfx, signal, live }) {
    const id = attempt.attemptId;
    const call = (step, body) => withRetry(() => api(`/api/attempts/${id}/quiz/${step}`, { method: 'POST', body }), signal);
    hud.timeLabel('Puzzle');
    hud.scoreLabel('Points');
    hud.score(0);

    for (;;) {
      if (signal.aborted) throw abortError();
      const q = await call('next');
      if (q.done) break;
      hud.time(`${q.index + 1}/${q.total}`);
      stage.innerHTML = `
        <div class="quiz">
          <div class="quiz-timer"><i></i></div>
          <p class="pict-hint">Which profession is this?</p>
          <div class="pict-emoji">${esc(q.question)}</div>
          <div class="quiz-opts">${q.options
            .map((o, i) => `<button class="quiz-opt" type="button" data-i="${i}"><span class="quiz-letter">${'ABCDEF'[i]}</span><span>${esc(o)}</span></button>`)
            .join('')}</div>
          <div class="quiz-feedback"></div>
        </div>`;
      const bar = stage.querySelector('.quiz-timer i');
      const btns = [...stage.querySelectorAll('.quiz-opt')];
      const feedback = stage.querySelector('.quiz-feedback');

      bar.style.width = `${(q.remainingMs / q.timeLimitMs) * 100}%`;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          bar.style.transition = `width ${q.remainingMs}ms linear`;
          bar.style.width = '0%';
        }),
      );

      const choice = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(-1), q.remainingMs + 250);
        function done(c) {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          btns.forEach((b) => (b.disabled = true));
          resolve(c);
        }
        function onAbort() {
          clearTimeout(timer);
          reject(abortError());
        }
        signal.addEventListener('abort', onAbort, { once: true });
        btns.forEach((b) =>
          b.addEventListener('click', () => {
            b.classList.add('picked');
            done(Number(b.dataset.i));
          }, { once: true }),
        );
      });

      const width = getComputedStyle(bar).width;
      bar.style.transition = 'none';
      bar.style.width = width;

      const fb = await call('answer', { index: q.index, choice });
      btns[fb.answer]?.classList.add('right');
      if (choice >= 0 && !fb.correct) btns[choice].classList.add('wrong');
      const answer = q.options[fb.answer] || '';
      feedback.textContent = fb.correct ? `✅ +${fb.points}` : choice < 0 ? `⏰ Time’s up — ${answer}` : `❌ It was ${answer}`;
      fb.correct ? sfx.good() : sfx.bad();
      hud.score(fb.totalPoints);
      live(fb.totalPoints);
      await sleep(1300, signal);
      if (fb.done) break;
    }
    return {};
  },
};
