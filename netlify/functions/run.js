const { connectLambda } = require('@netlify/blobs');
const core = require('./core');
exports.handler = async (event) => {
  connectLambda(event);
  const q = event.queryStringParameters || {};
  const baseUrl = process.env.URL || ('https://' + ((event.headers && event.headers.host) || ''));
  try {
    if (q.type === 'avis') {
      await core.snapAvis();
    } else if (q.type === 'relink') {
      await core.relink();
      await core.snapAvis();
    } else if (q.type === 'rank') {
      if (q.force !== '1') {
        const left = await core.rankCooldown();
        if (left > 0) {
          const h = Math.ceil(left / 3600000);
          return { statusCode: 429, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ cooldown: h }) };
        }
      }
      await core.snapRank(parseInt(q.start || '0', 10), baseUrl);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'type avis|rank|relink requis' }) };
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
