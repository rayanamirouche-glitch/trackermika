const FICHES_JSON = require('./fiches.json');
let FICHES = FICHES_JSON.slice();
// Fiches ajoutees depuis le tracker (bouton + Fiche, blob 'ajouts'). Une fiche ajoutee dont le lien
// figure deja dans fiches.json (passee par le menage entre-temps) est ignoree : pas de doublon.
const cleLien = l => { const m = /goo\.gl\/([A-Za-z0-9]+)/.exec(l || '') || /place_id[:=]([A-Za-z0-9_\-]+)/.exec(l || ''); return m ? m[1] : (l || ''); };
async function chargerFiches() {
  const aj = await getJSON('ajouts', {});
  const connus = new Set(FICHES_JSON.map(f => cleLien(f.link)));
  const noms = new Set(FICHES_JSON.map(f => f.name));
  const extra = Object.keys(aj).sort().map(id => Object.assign({}, aj[id], { ajout: { id: id, date: aj[id].date || '' } }))
    .filter(f => !connus.has(cleLien(f.link)) && !noms.has(f.name));
  FICHES = FICHES_JSON.concat(extra);
  return FICHES;
}
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
  // Une base declaree dans fiches.json (champ "base", valeur pre-commande) prime sur le blob :
  // la jauge ne compte que les avis postes depuis la commande.
  const baseDecl = await getJSON('base', {});
  let newBase = false;
  for (const f of wave) {
    if (typeof f.base === 'number' && baseDecl[f.name] !== f.base) { baseDecl[f.name] = f.base; newBase = true; }
  }
  if (newBase) await setJSON('base', baseDecl);
  const snap = {};
  await Promise.all(wave.map(async f => {
    const pid = ids[f.name]; if (!pid) return;
    const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=rating,userRatingCount&key=' + K;
    for (const ms of [8500]) {
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
// Sans résolution, 17 fiches ≈ 2 vague(s) × ~2 s, ça tient dans le budget.
async function snapAvis(start) {
  await chargerFiches();
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
// Mots-cles de classement effectifs : ceux choisis dans le tableau (blob 'kw', « kw1 | kw2 »)
// priment sur fiches.json. Trois mots-cles maximum par fiche, le premier est le principal.
async function kwOverrides() { return getJSON('kw', {}); }
function kwsOf(f, over) {
  const brut = (over && over[f.name]) ? over[f.name] : (f.kw || '');
  const l = String(brut).split(/\s*[|;]\s*/).map(x => x.trim()).filter(Boolean).slice(0, 3);
  return l.length ? l : [f.kw];
}

// Une recherche SerpAPI pour une fiche et un mot-cle : position dans le pack local, ou {error}.
// Pays de la recherche : d'abord le libelle de region, sinon la longitude (Suisse a l'est de 6,8).
function paysDe(f) {
  const r = String(f.region || f.city || '');
  if (/belg|brux|brabant|bxl|li[eè]ge|wallon|flandre|vlaan/i.test(r)) return 'be';
  if (/suisse|schweiz|gen[eè]ve|vaud|valais|bern|oberland|meiringen|ch/i.test(r)) return 'ch';
  const [lat, lon] = String(f.ll || '').split(',').map(Number);
  if (lat > 45.8 && lat < 47.9 && lon > 6.8) return 'ch';
  return 'fr';
}
// Position dans le bloc local de GOOGLE RECHERCHE (mobile), vu depuis la ville de la fiche :
// c'est ce qu'un client voit quand il tape « couvreur nice ». (Avant le 12/09/2026 : Google Maps.)
async function serpPos(f, kw, K) {
  const [lat, lon] = String(f.ll || '').split(',');
  const gl = paysDe(f);
  const u = 'https://serpapi.com/search.json?engine=google&q=' + encodeURIComponent(kw) + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon)
    + '&device=mobile&hl=fr&gl=' + gl + '&google_domain=google.' + gl + '&no_cache=true&api_key=' + K;
  const j = await to(fetch(u).then(r => r.json()), 8500);
  // SerpAPI en erreur (quota epuise, cle invalide) renvoie {error}. Sans ce test on enregistrait
  // « absent » pour une fiche qu'on n'a simplement pas pu mesurer.
  if (j && j.error) return { error: j.error };
  const rs = ((j && j.local_results && j.local_results.places) || []).filter(x => !(x.sponsored || x.is_paid || x.type === 'ad'));
  const m = pickMatch(rs, r => r.title, normName(f.target));
  // place_id ici est un CID numerique, pas un identifiant Places : on ne l'ecrit jamais dans ids.
  return { pos: m ? m.idx + 1 : null, place_id: null };
}

// Classement d'une liste de fiches, tous mots-cles confondus.
// → snap : position sur le mot-cle principal (historique 'rankbatch', filtres, fleches)
// → snapkw : position par mot-cle (historique 'rankkw', affichage sous la position)
async function rankFiches(list, K) {
  const [ids, over] = await Promise.all([getJSON('ids', {}), kwOverrides()]);
  let idsChanged = false, erreurs = 0, message = null;
  const snap = {}, snapkw = {};
  await Promise.all(list.map(async f => {
    const kws = kwsOf(f, over);
    const res = await Promise.all(kws.map(async kw => { try { return await serpPos(f, kw, K); } catch (e) { return { error: String(e && e.message ? e.message : e) }; } }));
    kws.forEach((kw, i) => {
      const r = res[i];
      if (r.error) { erreurs++; message = r.error; return; }
      snapkw[f.name] = snapkw[f.name] || {}; snapkw[f.name][kw] = r.pos;
      if (i === 0) snap[f.name] = r.pos;
      if (r.pos !== null && !ids[f.name] && r.place_id) { ids[f.name] = r.place_id; idsChanged = true; }
    });
    // le principal a echoue mais un secondaire a repondu : on garde une position plutot que rien
    if (snap[f.name] === undefined && snapkw[f.name]) snap[f.name] = Object.values(snapkw[f.name])[0];
  }));
  if (idsChanged) await setJSON('ids', ids);
  return { snap, snapkw, erreurs, message };
}

async function snapRank(start, baseUrl) {
  await chargerFiches();
  const K = process.env.SERPAPI_KEY;
  start = start || 0;
  const wave = FICHES.slice(start, start + WAVE);
  const r = await rankFiches(wave, K);
  // Ne rien ecrire si la vague entiere a echoue : sinon on ecrase le releve du jour par une cle vide.
  if (Object.keys(r.snap).length) {
    await setJSON('rankbatch/' + today() + '/' + start, r.snap);
    await setJSON('rankkw/' + today() + '/' + start, r.snapkw);
    if (start === 0) await setJSON('rankMeta', { last: new Date().toISOString() });
  }
  return { releves: Object.keys(r.snap).length, total: wave.length, erreurs: r.erreurs, message: r.message, positions: r.snap, parMotCle: r.snapkw };
}

// Classement a la demande des seules fiches cochees (10 max par appel : limite de 10 s de Netlify).
// Ecrit dans 'rankbatch/<jour>/sel' et 'rankkw/<jour>/sel', fusionnes avec les releves manuels du jour,
// sans toucher au cooldown du releve complet.
async function snapRankSel(names) {
  await chargerFiches();
  const K = process.env.SERPAPI_KEY;
  const voulu = new Set(names || []);
  const sel = FICHES.filter(f => voulu.has(f.name)).slice(0, WAVE);
  const r = await rankFiches(sel, K);
  if (Object.keys(r.snap).length) {
    for (const [k, v] of [['rankbatch/' + today() + '/sel', r.snap], ['rankkw/' + today() + '/sel', r.snapkw]]) {
      const cur = await getJSON(k, {});
      await setJSON(k, Object.assign(cur, v));
    }
  }
  return { releves: Object.keys(r.snap).length, total: sel.length, erreurs: r.erreurs, message: r.message, positions: r.snap, parMotCle: r.snapkw };
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
  // Releves a la demande du jour (fiches cochees) : lus en dernier, ils sont les plus recents.
  const sel = await getJSON('rankbatch/' + t + '/sel', null);
  if (sel) base[t] = Object.assign(base[t] || {}, sel);
  return base;
}

// Derniere position connue de chaque fiche pour CHAQUE mot-cle : { fiche: { kw: { pos, date } } }.
async function rankKwHist() {
  const cles = {};
  try {
    const { blobs } = await store().list({ prefix: 'rankkw/' });
    for (const b of blobs) { const d = b.key.split('/')[1]; (cles[d] = cles[d] || new Set()).add(b.key); }
  } catch (e) {}
  const t = today();
  cles[t] = cles[t] || new Set();
  for (let s = 0; s < FICHES.length; s += WAVE) cles[t].add('rankkw/' + t + '/' + s);
  cles[t].add('rankkw/' + t + '/sel');
  const out = {};
  for (const d of Object.keys(cles).sort()) {
    for (const k of cles[d]) {
      const w = await getJSON(k, null);
      if (!w) continue;
      for (const [n, m] of Object.entries(w)) {
        out[n] = out[n] || {};
        for (const [kw, pos] of Object.entries(m || {})) out[n][kw] = { pos: pos, date: d };
      }
    }
  }
  return out;
}

async function relink() {
  await chargerFiches();
  await setJSON('ids', {});
  return resolveIds();
}

async function allData() {
  await chargerFiches();
  const [avis, rank, ids, meta, base, kwover, objover, livover, rankKw] = await Promise.all([
    avisHist(), rankHist(), getJSON('ids', {}), getJSON('rankMeta', {}), getJSON('base', {}), kwOverrides(), getJSON('obj', {}), getJSON('livres', {}), rankKwHist()
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
  return { fiches: FICHES, region: REGION, avis: prune(avis), rank: prune(rank), ids, rankMeta: meta, base, kwover, objover, livover, rankKw, ajouts: FICHES.filter(f => f.ajout).length };
}

// Releve d'une seule fiche, fusionne dans la cle de sa vague du jour.
// Un seul appel Google (SKU Enterprise, ~0,02 $) : c'est le moyen de suivre
// quelques fiches plusieurs fois par jour sans relever tout le parc.
async function snapAvisOne(idx) {
  await chargerFiches();
  const K = process.env.PLACES_API_KEY;
  const f = FICHES[idx];
  if (!f) return { ok: false, motif: 'fiche inconnue' };
  const ids = await getJSON('ids', {});
  const pid = ids[f.name];
  if (!pid) return { ok: false, motif: 'fiche non liée' };
  const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=rating,userRatingCount&key=' + K;
  let j = null;
  for (const ms of [8500]) {
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

module.exports = { snapAvis, snapAvisOne, snapRank, snapRankSel, allData, rankCooldown, relink, chargerFiches, fiches: () => FICHES, getJSON, setJSON, normName, pickMatch, paysDe };
