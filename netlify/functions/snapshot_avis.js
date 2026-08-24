const { connectLambda } = require('@netlify/blobs');
const core = require('./core');
exports.handler = async (event) => {
  connectLambda(event);
  await core.snapAvis();
  return { statusCode: 200 };
};
