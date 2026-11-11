/**
 * MongoDB persistence (e.g. Atlas). The server still keeps everything in memory for speed;
 * Mongo is the durable copy, loaded once at startup and written on every change.
 */
const { MongoClient } = require('mongodb');

const toDoc = ({ id, ...rest }) => ({ _id: id, ...rest });
const fromDoc = ({ _id, ...rest }) => ({ id: _id, ...rest });

module.exports = function mongoStore(uri, dbName) {
  let client, players, teams, attempts, meta;

  return {
    describe: () => `MongoDB (database "${dbName}")`,
    async init() {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      const db = client.db(dbName);
      players = db.collection('players');
      teams = db.collection('teams');
      attempts = db.collection('attempts');
      meta = db.collection('meta');
      await attempts.createIndex({ playerId: 1 });
    },
    attach() {},
    async load() {
      const [p, t, a, s] = await Promise.all([
        players.find().toArray(),
        teams.find().toArray(),
        attempts.find().toArray(),
        meta.findOne({ _id: 'settings' }),
      ]);
      if (!p.length && !t.length && !a.length && !s) return null;
      const { _id, ...settings } = s || {};
      return { settings, players: p.map(fromDoc), teams: t.map(fromDoc), attempts: a.map(fromDoc) };
    },
    savePlayer: (p) => players.replaceOne({ _id: p.id }, toDoc(p), { upsert: true }),
    deletePlayer: (id) => Promise.all([players.deleteOne({ _id: id }), attempts.deleteMany({ playerId: id })]),
    saveTeam: (t) => teams.replaceOne({ _id: t.id }, toDoc(t), { upsert: true }),
    deleteTeam: (id) => teams.deleteOne({ _id: id }),
    saveAttempt: (a) => attempts.replaceOne({ _id: a.id }, toDoc(a), { upsert: true }),
    deleteAttempt: (id) => attempts.deleteOne({ _id: id }),
    saveSettings: (s) => meta.replaceOne({ _id: 'settings' }, { _id: 'settings', ...s }, { upsert: true }),
    resetAttempts: () => attempts.deleteMany({}),
    reset: () => Promise.all([players.deleteMany({}), teams.deleteMany({}), attempts.deleteMany({})]),
    async close() {
      await client?.close();
    },
  };
};
