const { connectLambda } = require('@netlify/blobs');
const core = require('./core');
exports.handler = async (event) => {
  connectLambda(event);
  try { await core.rememberBase('https://' + (event.headers && (event.headers.host || event.headers.Host))); } catch (e) {}
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify(await core.allData())
  };
};
