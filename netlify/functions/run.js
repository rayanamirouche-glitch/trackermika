const { connectLambda } = require('@netlify/blobs');
const core = require('./core');
exports.handler = async (event) => {
  connectLambda(event);
  try { await core.rememberBase('https://' + (event.headers && (event.headers.host || event.headers.Host))); } catch (e) {}
  const q = event.queryStringParameters || {};
  try {
    if (q.type === 'avis') {
      await core.snapAvis();
    } else if (q.type === 'rank') {
      const start = parseInt(q.i || '0', 10) || 0;
      if (start === 0 && q.force !== '1') {
        const left = await core.rankCooldown();
        if (left > 0) {
          const h = Math.ceil(left / 3600000);
          return { statusCode: 429, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ cooldown: h }) };
        }
      }
      await core.snapRank(start);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'type avis|rank requis' }) };
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
