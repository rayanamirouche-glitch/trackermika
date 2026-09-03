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
        const ll = f.ll.split(',').map(Number);
        const j = await to(fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': K, 'X-Goog-FieldMask': 'places.id,places.displayName' },
          body: JSON.stringify({ textQuery: q, locationBias: { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 6000 } } })
        }).then(r => r.json()), 6500);
        const results = (j && j.places) || [];
        const m = pickMatch(results, r => r.displayName && r.displayName.text, t);
        if (m && m.hit.id) { ids[f.name] = m.hit.id; break; }
      } catch (e) {}
    }
    if (!ids[f.name]) {
      for (const q of [f.name, f.q]) {
        try {
          const ll = f.ll.split(',').map(Number);
          const j = await to(fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': K, 'X-Goog-FieldMask': 'places.id,places.displayName' },
            body: JSON.stringify({ textQuery: q, locationBias: { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 25000 } } })
          }).then(r => r.json()), 6500);
          const cands = (j && j.places) || [];
          const m = pickMatch(cands, r => r.displayName && r.displayName.text, t);
          if (m && m.hit.id) { ids[f.name] = m.hit.id; break; }
        } catch (e) {}
      }
    }
  }));
  await setJSON('ids', ids);
  return ids;
}

async function avisHist() {
  const base = await getJSON('avis', {});
  try {
    const { blobs } = await store().list({ prefix: 'avisbatch/' });
    for (const b of blobs) {
      const date = b.key.split('/')[1];
      const w = await getJSON(b.key, {});
      base[date] = Object.assign(base[date] || {}, w);
    }
  } catch (e) {}
  // list() est eventuellement coherent : une vague ecrite il y a quelques secondes
  // peut en etre absente. Les cles du jour sont donc relues directement.
  const t = today();
  for (let s = 0; s < FICHES.length; s += AVIS_WAVE) {
    const w = await getJSON('avisbatch/' + t + '/' + s, null);
    if (w) base[t] = Object.assign(base[t] || {}, w);
  }
  return base;
}

const AVIS_WAVE = 12;

// Relevé d'une vague de fiches (start → start+AVIS_WAVE), fusionné dans le snapshot du jour.
// IMPORTANT : ne fait AUCUNE résolution (c'est le job de relink) — lecture des ids seulement.
async function snapAvisWave(start) {
  const K = process.env.PLACES_API_KEY;
  const ids = await getJSON('ids', {});
  const hist = await avisHist();
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
    const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=rating,userRatingCount&key=' + K;
    for (const ms of [7000, 9000]) {
      try {
        const j = await to(fetch(u).then(r => r.ok ? r.json() : null), ms);
        // API New : une fiche sans avis renvoie {} — userRatingCount absent = 0, pas une absence.
        if (j && !j.error) {
          snap[f.name] = { n: typeof j.userRatingCount === 'number' ? j.userRatingCount : 0, r: j.rating || null };
          return;
        }
      } catch (e) {}
    }
    // Google n'a pas repondu : on reconduit la derniere valeur connue, marquee "stale",
    // pour ne pas creuser un trou dans le releve du jour et fausser le total.
    const prev = lastKnown(f.name);
    if (prev) snap[f.name] = { n: prev.n, r: prev.r || null, stale: true };
  }));
  // Ecriture dans une cle propre a la vague. Deux releves lances en meme temps ne
  // peuvent plus s'ecraser : avec un blob unique relu-modifie-reecrit, le dernier
  // ecrivain effacait les fiches de l'autre, d'ou des totaux qui alternaient.
  await setJSON('avisbatch/' + today() + '/' + start, snap);
  return { snap: snap, releves: Object.keys(snap).length, total: wave.length };
}

// Relevé complet : enchaîne les vagues (utilisé par le snapshot nocturne et le bouton).
// Sans résolution, 25 fiches ≈ 3 vague(s) × ~2 s, ça tient dans le budget.
async function snapAvis(start) {
  if (start !== null && start !== undefined && !isNaN(start)) {
    return snapAvisWave(start);
  }
  let releves = 0, total = 0;
  for (let s = 0; s < FICHES.length; s += AVIS_WAVE) {
    const r = await snapAvisWave(s);
    releves += r.releves; total += r.total;
  }
  return { releves: releves, total: total };
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
  let erreurs = 0, message = null;
  await Promise.all(wave.map(async f => {
    try {
      const u = 'https://serpapi.com/search.json?engine=google_maps&q=' + encodeURIComponent(f.kw) + '&ll=' + encodeURIComponent('@' + f.ll + ',14z') + '&hl=fr&api_key=' + K;
      const j = await to(fetch(u).then(r => r.json()), 8500);
      // SerpAPI en erreur (quota epuise, cle invalide) renvoie {error}. Sans ce test,
      // local_results est vide, pos vaut null, et on enregistrait "hors top 20" pour
      // une fiche qu'on n'a simplement pas pu mesurer : la position connue etait perdue.
      if (j && j.error) { erreurs++; message = j.error; return; }
      const rs = (j && j.local_results) || [];
      const t = normName(f.target); let pos = null;
      const m = pickMatch(rs, r => r.title, t);
      if (m) {
        pos = m.idx + 1;
        if (!ids[f.name] && m.hit.place_id) { ids[f.name] = m.hit.place_id; idsChanged = true; }
      }
      snap[f.name] = pos;
    } catch (e) { erreurs++; message = String(e && e.message ? e.message : e); }
  }));
  if (idsChanged) await setJSON('ids', ids);
  // Ne rien ecrire si la vague entiere a echoue : sinon on ecrase le releve du jour
  // par une cle vide et le tableau se vide.
  if (Object.keys(snap).length) {
    await setJSON('rankbatch/' + today() + '/' + start, snap);
    if (start === 0) await setJSON('rankMeta', { last: new Date().toISOString() });
  }
  return { releves: Object.keys(snap).length, total: wave.length, erreurs: erreurs, message: message };
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
  // list() est eventuellement coherent : une vague ecrite il y a quelques minutes
  // peut en etre absente. Les cles du jour sont donc relues directement.
  const t = today();
  for (let s = 0; s < FICHES.length; s += WAVE) {
    const w = await getJSON('rankbatch/' + t + '/' + s, null);
    if (w) base[t] = Object.assign(base[t] || {}, w);
  }
  return base;
}

async function relink() {
  await setJSON('ids', {});
  return resolveIds();
}

async function allData() {
  const [avis, rank, ids, meta, base] = await Promise.all([
    avisHist(), rankHist(), getJSON('ids', {}), getJSON('rankMeta', {}), getJSON('base', {})
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

// Releve d'une seule fiche, fusionne dans la cle de sa vague du jour.
// Un seul appel Google (SKU Enterprise, ~0,02 $) : c'est le moyen de suivre
// quelques fiches plusieurs fois par jour sans relever tout le parc.
async function snapAvisOne(idx) {
  const K = process.env.PLACES_API_KEY;
  const f = FICHES[idx];
  if (!f) return { ok: false, motif: 'fiche inconnue' };
  const ids = await getJSON('ids', {});
  const pid = ids[f.name];
  if (!pid) return { ok: false, motif: 'fiche non liée' };
  const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=rating,userRatingCount&key=' + K;
  let j = null;
  for (const ms of [7000, 9000]) {
    try { j = await to(fetch(u).then(r => r.ok ? r.json() : null), ms); if (j && !j.error) break; } catch (e) { j = null; }
  }
  if (!j || j.error) return { ok: false, motif: "Google n'a pas répondu" };
  const v = { n: typeof j.userRatingCount === 'number' ? j.userRatingCount : 0, r: j.rating || null };
  const start = Math.floor(idx / AVIS_WAVE) * AVIS_WAVE;
  const key = 'avisbatch/' + today() + '/' + start;
  const w = await getJSON(key, {});
  w[f.name] = v;
  await setJSON(key, w);
  return { ok: true, n: v.n, r: v.r };
}

module.exports = { snapAvis, snapAvisOne, snapRank, allData, rankCooldown, relink };
