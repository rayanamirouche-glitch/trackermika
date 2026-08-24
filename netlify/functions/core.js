const { getStore } = require('@netlify/blobs');
const FICHES = require('./fiches.json');
const REGION = require('./region.json').region;

const store = () => getStore('tracker');
const today = () => new Date().toISOString().slice(0, 10);
const to = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

async function getJSON(k, d) { try { const v = await store().get(k, { type: 'json' }); return v ?? d } catch (e) { return d } }
async function setJSON(k, v) { await store().setJSON(k, v) }

async function rememberBase(base) {
  if (!base) return;
  try { const m = await getJSON('siteBase', {}); if (m.base !== base) await setJSON('siteBase', { base }); } catch (e) {}
}
async function baseUrl() {
  const m = await getJSON('siteBase', {});
  return m.base || process.env.URL || process.env.DEPLOY_PRIME_URL || '';
}

async function resolveIds() {
  const K = process.env.PLACES_API_KEY;
  const ids = await getJSON('ids', {});
  await Promise.all(FICHES.map(async f => {
    if (ids[f.name]) return;
    try {
      const u = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' + encodeURIComponent(f.q + ' ' + REGION) + '&inputtype=textquery&fields=place_id&locationbias=' + encodeURIComponent('circle:6000@' + f.ll) + '&key=' + K;
      const j = await to(fetch(u).then(r => r.json()), 6000);
      const c = j && j.candidates && j.candidates[0];
      if (c && c.place_id) ids[f.name] = c.place_id;
    } catch (e) {}
  }));
  await setJSON('ids', ids);
  return ids;
}

async function snapAvis() {
  const K = process.env.PLACES_API_KEY;
  const ids = await resolveIds();
  const snap = {};
  await Promise.all(FICHES.map(async f => {
    const pid = ids[f.name]; if (!pid) return;
    try {
      const u = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + pid + '&fields=user_ratings_total,rating&key=' + K;
      const j = await to(fetch(u).then(r => r.json()), 6000);
      const res = j && j.result;
      if (res && typeof res.user_ratings_total === 'number') snap[f.name] = { n: res.user_ratings_total, r: res.rating || null };
    } catch (e) {}
  }));
  const hist = await getJSON('avis', {});
  hist[today()] = Object.assign(hist[today()] || {}, snap);
  await setJSON('avis', hist);
  return hist[today()];
}

const COOLDOWN_H = 48;
async function rankCooldown() {
  const meta = await getJSON('rankMeta', {});
  if (!meta.last) return 0;
  const left = COOLDOWN_H * 3600000 - (Date.now() - new Date(meta.last).getTime());
  return left > 0 ? left : 0;
}
async function snapRank(start = 0) {
  const B = 10;
  const K = process.env.SERPAPI_KEY;
  const norm = s => (s || '').toLowerCase().replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'").normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (start === 0) await setJSON('rankMeta', { last: new Date().toISOString() });
  const slice = FICHES.slice(start, start + B);
  const snap = {};
  await Promise.all(slice.map(async f => {
    try {
      const u = 'https://serpapi.com/search.json?engine=google_maps&q=' + encodeURIComponent(f.kw) + '&ll=' + encodeURIComponent('@' + f.ll + ',14z') + '&hl=fr&api_key=' + K;
      const j = await to(fetch(u).then(r => r.json()), 8000);
      const rs = (j && j.local_results) || [];
      const t = norm(f.target); let pos = null;
      rs.forEach((r, i) => { if (pos === null && r.title && norm(r.title).includes(t)) pos = i + 1 });
      snap[f.name] = pos;
    } catch (e) { snap[f.name] = null }
  }));
  await setJSON('rankbatch/' + today() + '/' + start, snap);
  if (start + B < FICHES.length) {
    const base = await baseUrl();
    if (base) {
      const next = base + '/.netlify/functions/run?type=rank&force=1&i=' + (start + B);
      await Promise.race([fetch(next).catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    }
  }
  return snap;
}

async function rankHistory() {
  const hist = await getJSON('rank', {});   // ancien format conservé
  try {
    const { blobs } = await store().list({ prefix: 'rankbatch/' });
    for (const b of (blobs || [])) {
      const parts = b.key.split('/');       // rankbatch/DATE/START
      const date = parts[1];
      const snap = await getJSON(b.key, {});
      hist[date] = hist[date] || {};
      for (const k in snap) { if (snap[k] != null || hist[date][k] == null) hist[date][k] = snap[k] }
    }
  } catch (e) {}
  return hist;
}

async function relink() {
  await setJSON('ids', {});
  return resolveIds();
}

async function allData() {
  return { ids: await getJSON('ids', {}), avis: await getJSON('avis', {}), rank: await rankHistory() };
}

module.exports = { snapAvis, snapRank, allData, rankCooldown, rememberBase, relink };
