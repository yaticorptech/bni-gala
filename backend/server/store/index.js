const config = require('../config');

/** MongoDB when MONGODB_URI is set, otherwise a local JSON file. */
module.exports = async function createStore() {
  const store = config.mongoUri
    ? require('./mongoStore')(config.mongoUri, config.mongoDb)
    : require('./fileStore')(config.dataFile);
  await store.init();
  return store;
};
