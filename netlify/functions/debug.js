const { connectLambda } = require('@netlify/blobs');
const FICHES = require('./fiches.json');

exports.handler = async (event) => {
  connectLambda(event);
  const q = event.queryStringParameters || {};
  const i = parseInt(q.i || '0', 10) || 0;
  const f = FICHES[i];
  const K = process.env.SERPAPI_KEY;
  const url = 'https://serpapi.com/search.json?engine=google_maps&q=' + encodeURIComponent(f.kw) + '&ll=' + encodeURIComponent('@' + f.ll + ',14z') + '&hl=fr&api_key=' + K;
  const t0 = Date.now();
  try {
    const r = await fetch(url);
    const j = await r.json();
    const results = (j.local_results || []).slice(0, 8).map((x, n) => (n + 1) + '. ' + x.title);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fiche: f.name,
        kw: f.kw,
        ll: f.ll,
        duree_ms: Date.now() - t0,
        http_status: r.status,
        serpapi_status: j.search_metadata ? j.search_metadata.status : null,
        erreur: j.error || null,
        nb_resultats: (j.local_results || []).length,
        premiers_resultats: results
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ fiche: f.name, duree_ms: Date.now() - t0, exception: String(e) }) };
  }
};
