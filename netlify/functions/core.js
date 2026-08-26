const FICHES = require('./fiches.json');
const REGION = 'IDF';
const { getStore } = require('@netlify/blobs');

const store = () => getStore('tracker');
const today = () => new Date().toISOString().slice(0, 10);
const to = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function getJSON(k, d) { try { const v = await store().get(k, { type: 'json' }); return (v === null || v === undefined) ? d : v } catch (e) { return d } }
async function setJSON(k, v) { await store().setJSON(k, v) }

const normName = s => (s || '').toLowerCase()
  .replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'")
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[.\-]/g, ' ')
  .replace(/\bsaint\b/g, 'st')
  .replace(/\s+/g, ' ').trim();


function pickMatch(list, getName, t) {
  let exact = null, incl = null, exactIdx = -1, inclIdx = -1;
  list.forEach((r, i) => {
    const n = normName(getName(r) || '');
    if (!n) return;
    if (exact === null && n === t) { exact = r; exactIdx = i; }
    if (incl === null && n.includes(t)) { incl = r; inclIdx = i; }
  });
  return exact ? { hit: exact, idx: exactIdx } : (incl ? { hit: incl, idx: inclIdx } : null);
}

async function resolveIds() {
  const K = process.env.PLACES_API_KEY;
  const ids = await getJSON('ids', {});
  await Promise.all(FICHES.map(async f => {
    if (ids[f.name]) return;
    const t = normName(f.target);
    const queries = [f.q + ' ' + (f.region || REGION), f.q, f.name];
    for (const q of queries) {
      try {
        const u = 'https://maps.googleapis.com/maps/api/place/textsearch/json?query=' + encodeURIComponent(q) + '&location=' + f.ll + '&radius=15000&key=' + K;
        const j = await to(fetch(u).then(r => r.json()), 6500);
        const results = (j && j.results) || [];
        const m = pickMatch(results, r => r.name, t);
        if (m && m.hit.place_id) { ids[f.name] = m.hit.place_id; break; }
      } catch (e) {}
    }
    if (!ids[f.name]) {
      for (const q of [f.name, f.q]) {
        try {
          const u = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' + encodeURIComponent(q) + '&inputtype=textquery&fields=place_id,name&locationbias=' + encodeURIComponent('circle:25000@' + f.ll) + '&key=' + K;
          const j = await to(fetch(u).then(r => r.json()), 6500);
          const cands = (j && j.candidates) || [];
          const m = pickMatch(cands, r => r.name, t);
          if (m && m.hit.place_id) { ids[f.name] = m.hit.place_id; break; }
        } catch (e) {}
      }
    }
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
  const base = await getJSON('base', {});
  let newBase = false;
  for (const [name, v] of Object.entries(snap)) {
    if (base[name] == null && v && typeof v.n === 'number') { base[name] = v.n; newBase = true; }
  }
  if (newBase) await setJSON('base', base);
  return hist[today()];
}

const COOLDOWN_H = 48;
async function rankCooldown() {
  const meta = await getJSON('rankMeta', {});
  if (!meta.last) return 0;
  const left = COOLDOWN_H * 3600000 - (Date.now() - new Date(meta.last).getTime());
  return left > 0 ? left : 0;
}

const WAVE = 10;
async function snapRank(start, baseUrl) {
  const K = process.env.SERPAPI_KEY;
  start = start || 0;
  const wave = FICHES.slice(start, start + WAVE);
  const snap = {};
  const ids = await getJSON('ids', {});
  let idsChanged = false;
  await Promise.all(wave.map(async f => {
    try {
      const u = 'https://serpapi.com/search.json?engine=google_maps&q=' + encodeURIComponent(f.kw) + '&ll=' + encodeURIComponent('@' + f.ll + ',14z') + '&hl=fr&api_key=' + K;
      const j = await to(fetch(u).then(r => r.json()), 8500);
      const rs = (j && j.local_results) || [];
      const t = normName(f.target); let pos = null;
      const m = pickMatch(rs, r => r.title, t);
      if (m) {
        pos = m.idx + 1;
        if (!ids[f.name] && m.hit.place_id) { ids[f.name] = m.hit.place_id; idsChanged = true; }
      }
      snap[f.name] = pos;
    } catch (e) {}
  }));
  if (idsChanged) await setJSON('ids', ids);
  await setJSON('rankbatch/' + today() + '/' + start, snap);
  if (start === 0) await setJSON('rankMeta', { last: new Date().toISOString() });
}

async function rankHist() {
  const base = await getJSON('rank', {});
  try {
    const { blobs } = await store().list({ prefix: 'rankbatch/' });
    for (const b of blobs) {
      const parts = b.key.split('/');
      const date = parts[1];
      const w = await getJSON(b.key, {});
      base[date] = Object.assign(base[date] || {}, w);
    }
  } catch (e) {}
  return base;
}

async function relink() {
  await setJSON('ids', {});
  return resolveIds();
}

async function allData() {
  const [avis, rank, ids, meta, base] = await Promise.all([
    getJSON('avis', {}), rankHist(), getJSON('ids', {}), getJSON('rankMeta', {}), getJSON('base', {})
  ]);
  return { fiches: FICHES, region: REGION, avis, rank, ids, rankMeta: meta, base };
}

module.exports = { snapAvis, snapRank, allData, rankCooldown, relink };
