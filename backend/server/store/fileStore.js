/**
 * JSON-file persistence. The whole in-memory state is written (debounced, atomically via
 * rename) after any change, so there is nothing to install or configure.
 */
const fs = require('fs');
const path = require('path');

module.exports = function fileStore(file) {
  let getSnapshot = null;
  let timer = null;

  function writeNow() {
    clearTimeout(timer);
    timer = null;
    if (!getSnapshot) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(getSnapshot()));
    fs.renameSync(tmp, file);
  }

  function touch() {
    if (timer) return;
    timer = setTimeout(() => {
      try {
        writeNow();
      } catch (err) {
        console.error('[store] could not write', file, '-', err.message);
      }
    }, 400);
  }

  return {
    describe: () => `JSON file (${path.relative(process.cwd(), file) || file})`,
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    },
    attach(snapshotFn) {
      getSnapshot = snapshotFn;
    },
    async load() {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    },
    savePlayer: touch,
    deletePlayer: touch,
    saveTeam: touch,
    deleteTeam: touch,
    saveAttempt: touch,
    deleteAttempt: touch,
    saveSettings: touch,
    resetAttempts: touch,
    reset: touch,
    async close() {
      writeNow();
    },
  };
};
