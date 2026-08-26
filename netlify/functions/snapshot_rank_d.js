const { connectLambda } = require('@netlify/blobs');
const core = require('./core');
exports.handler = async (event) => {
  connectLambda(event);
  await core.snapRank(30, process.env.URL);
  return { statusCode: 200 };
};
