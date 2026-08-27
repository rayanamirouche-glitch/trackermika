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

const AVIS_WAVE = 12;

// Relevé d'une vague de fiches (start → start+AVIS_WAVE), fusionné dans le snapshot du jour.
// IMPORTANT : ne fait AUCUNE résolution (c'est le job de relink) — lecture des ids seulement.
async function snapAvisWave(start) {
  const K = process.env.PLACES_API_KEY;
  const ids = await getJSON('ids', {});
  const hist = await getJSON('avis', {});
  const histDates = Object.keys(hist).sort();
  // Derniere valeur connue d'une fiche, quel que soit le jour.
  const lastKnown = name => {
    for (let i = histDates.length - 1; i >= 0; i--) {
      const v = hist[histDates[i]] && hist[histDates[i]][name];
      if (v && typeof v.n === 'number') return v;
    }
    return null;
  };
  const wave = FICHES.slice(start, start + AVIS_WAVE);
  const snap = {};
  await Promise.all(wave.map(async f => {
    const pid = ids[f.name]; if (!pid) return;
    const u = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + pid + '&fields=user_ratings_total,rating&key=' + K;
    for (const ms of [7000, 9000]) {
      try {
        const j = await to(fetch(u).then(r => r.json()), ms);
        // Google omet user_ratings_total quand la fiche n'a aucun avis : c'est 0, pas une absence.
        if (j && j.status === 'OK' && j.result) {
          const res = j.result;
          snap[f.name] = { n: typeof res.user_ratings_total === 'number' ? res.user_ratings_total : 0, r: res.rating || null };
          return;
        }
      } catch (e) {}
    }
    // Google n'a pas repondu : on reconduit la derniere valeur connue, marquee "stale",
    // pour ne pas creuser un trou dans le releve du jour et fausser le total.
    const prev = lastKnown(f.name);
    if (prev) snap[f.name] = { n: prev.n, r: prev.r || null, stale: true };
  }));
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

// Relevé complet : enchaîne les vagues (utilisé par le snapshot nocturne et le bouton).
// Sans résolution, 25 fiches ≈ 3 vague(s) × ~2 s, ça tient dans le budget.
async function snapAvis(start) {
  if (start !== null && start !== undefined && !isNaN(start)) {
    return snapAvisWave(start);
  }
  let last = {};
  for (let s = 0; s < FICHES.length; s += AVIS_WAVE) {
    last = await snapAvisWave(s);
  }
  return last;
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
  // Une fiche retiree de fiches.json laisse son historique derriere elle. On l'ecarte
  // a la lecture, sinon elle continue de gonfler les totaux et les courbes.
  const noms = new Set(FICHES.map(f => f.name));
  const prune = h => {
    const out = {};
    for (const [date, snap] of Object.entries(h || {})) {
      const s = {};
      for (const [n, v] of Object.entries(snap || {})) if (noms.has(n)) s[n] = v;
      out[date] = s;
    }
    return out;
  };
  return { fiches: FICHES, region: REGION, avis: prune(avis), rank: prune(rank), ids, rankMeta: meta, base };
}

module.exports = { snapAvis, snapRank, allData, rankCooldown, relink };
