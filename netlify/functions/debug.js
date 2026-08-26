const { connectLambda } = require('@netlify/blobs');
exports.handler = async (event) => {
  connectLambda(event);
  const out = { places: null, serpapi: null };
  try {
    const j = await fetch('https://maps.googleapis.com/maps/api/place/textsearch/json?query=test&key=' + process.env.PLACES_API_KEY).then(r => r.json());
    out.places = j.status || 'ok';
  } catch (e) { out.places = String(e) }
  try {
    const j = await fetch('https://serpapi.com/account.json?api_key=' + process.env.SERPAPI_KEY).then(r => r.json());
    out.serpapi = j.error ? j.error : ('ok — ' + (j.total_searches_left != null ? j.total_searches_left + ' recherches restantes' : 'compte actif'));
  } catch (e) { out.serpapi = String(e) }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
