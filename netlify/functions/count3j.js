// Compteur J-2 / J-1 / J — lit les avis réels (SerpApi, dates ISO) via les place_id déjà liés
const FICHES = require('./fiches.json');
const { getStore, connectLambda } = require('@netlify/blobs');
const store = () => getStore('tracker');
async function getJSON(k, d) { try { const v = await store().get(k, { type: 'json' }); return (v === null || v === undefined) ? d : v } catch (e) { return d } }

const SERP_KEY = process.env.SERPAPI_KEY;
const parisDate = d => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function countRecent(placeId, buckets, cutoff) {
  let token = null, pages = 0, stop = false;
  // Une seule page (20 avis les plus recents) : suffisant pour J-2/J-1/J,
  // et 4x moins de recherches SerpAPI qu'avant.
  while (!stop && pages < 1) {
    let url = `https://serpapi.com/search.json?engine=google_maps_reviews&place_id=${placeId}&sort_by=newestFirst&hl=fr&api_key=${SERP_KEY}`;
    if (token) url += `&next_page_token=${encodeURIComponent(token)}&num=20`;
    const r = await fetch(url); const j = await r.json();
    if (j.error) return { error: j.error };
    const revs = j.reviews || [];
    if (!revs.length) break;
    for (const rev of revs) {
      const iso = rev.iso_date || rev.iso_date_of_last_edit;
      if (!iso) continue;
      const day = parisDate(new Date(iso));
      if (day in buckets) buckets[day]++;
      else if (day < cutoff) { stop = true; break; }
    }
    token = j.serpapi_pagination && j.serpapi_pagination.next_page_token;
    if (!token) break;
    pages++;
  }
  return {};
}

exports.handler = async (event) => {
  connectLambda(event);
  const p = event.queryStringParameters || {};
  const start = parseInt(p.start || '0', 10);
  const n = parseInt(p.n || '3', 10);
  const slice = FICHES.slice(start, start + n);
  const ids = await getJSON('ids', {});

  const now = new Date();
  const days = [0, 1, 2].map(k => parisDate(new Date(now.getTime() - k * 86400000)));

  const out = {};
  for (const f of slice) {
    const pid = ids[f.name];
    if (!pid) { out[f.name] = { err: 'non liée' }; continue; }
    const buckets = {}; buckets[days[0]] = 0; buckets[days[1]] = 0; buckets[days[2]] = 0;
    try {
      const res = await countRecent(pid, buckets, days[2]);
      out[f.name] = res.error ? { err: String(res.error).slice(0, 80) }
        : { j0: buckets[days[0]], j1: buckets[days[1]], j2: buckets[days[2]] };
    } catch (e) { out[f.name] = { err: String(e).slice(0, 80) }; }
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify({ days: { j0: days[0], j1: days[1], j2: days[2] }, count: FICHES.length, results: out })
  };
};
