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
    const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=rating,userRatingCount,nationalPhoneNumber,websiteUri&key=' + K;
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
// Depuis le 14/09/2026 les recherches sont SOUMISES en asynchrone (async=true) : SerpAPI repond
// tout de suite avec un identifiant, et le resultat se lit ensuite dans son archive (gratuit).
// Avant, la fonction attendait 4 a 9 s par recherche et Netlify la tuait a 10 s : la moitie des
// fiches ressortait en « timeout » et gardait une position perimee.
function serpUrl(f, kw, K) {
  const [lat, lon] = String(f.ll || '').split(',');
  const gl = paysDe(f);
  return 'https://serpapi.com/search.json?engine=google&q=' + encodeURIComponent(kw) + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon)
    // no_cache est indispensable meme en async : sans lui, SerpAPI ressert pendant 1 h le resultat
    // d'une recherche qui a echoue (« We couldn't get valid results… ») et refuse la fiche a chaque essai.
    + '&device=mobile&hl=fr&gl=' + gl + '&google_domain=google.' + gl + '&no_cache=true&async=true&api_key=' + K;
}
function posDe(f, j) {
  const brut = (j && j.local_results) ? (Array.isArray(j.local_results) ? j.local_results : j.local_results.places) : null;
  const rs = (brut || []).filter(x => !(x.sponsored || x.is_paid || x.type === 'ad'));
  if (!rs.length) return undefined;   // aucun bloc local dans la page rendue : on ne sait pas, ce n'est pas « absent »
  const m = pickMatch(rs, r => r.title, normName(f.target));
  return m ? m.idx + 1 : null;
}
const ATTENTE_MAX_MS = 180000;   // au-dela (3 min ; Google mobile repond en 30-60 s), la recherche est comptee en echec et resoumise
// Soumet toutes les recherches (fiche x mot-cle) d'une liste de fiches, sans attendre Google.
// cle = vague d'ecriture ('0', '10', … ou 'sel') : le resultat ira dans rankbatch/<jour>/<cle>.
// La file des recherches n'est PAS stockee dans un blob (lecture « eventuelle » : une file ecrite par
// une fonction etait relue vide par la suivante) : elle est rendue a la page, qui la renvoie a rankfetch.
async function soumettre(list, K, cle) {
  const over = await kwOverrides();
  const taches = [];
  list.forEach(f => { kwsOf(f, over).forEach((kw, i) => { taches.push({ f: f, kw: kw, i: i }); }); });
  const jobs = []; let erreurs = 0, message = null;
  // Soumission par petits paquets : 30 recherches lancees d'un coup, SerpAPI en refusait la moitie
  // (« We couldn't get valid results… try again later »). Un refus est retente deux fois.
  for (let k = 0; k < taches.length; k += 5) {
    await Promise.all(taches.slice(k, k + 5).map(async t => {
      let j = null;
      for (let essai = 0; essai < 3; essai++) {
        if (essai) await new Promise(r => setTimeout(r, 1500));
        try { j = await to(fetch(serpUrl(t.f, t.kw, K)).then(r => r.json()), 5000); } catch (e) { j = { error: String(e && e.message ? e.message : e) }; }
        if (j && !j.error) break;
      }
      if (!j || j.error) { erreurs++; message = (j && j.error) || 'reponse vide'; return; }
      const st = j.search_metadata || {};
      const job = { name: t.f.name, kw: t.kw, i: t.i, id: st.id, cle: cle, t: Date.now() };
      if (j.local_results || /success/i.test(st.status || '')) { const p = posDe(t.f, j); job.fait = true; if (p === undefined) job.err = 'bloc local vide'; else job.pos = p; }
      jobs.push(job);
    }));
  }
  return { jobs: jobs, erreurs: erreurs, message: message };
}
// Lit dans l'archive SerpAPI les recherches encore en cours, puis ecrit chaque vague dont TOUTES les
// fiches sont pretes dans rankbatch/rankkw du jour (une seule ecriture par vague, jamais de
// relecture-fusion sur une lecture eventuelle). Rend la file mise a jour a la page.
async function recolter(K, jobs) {
  await chargerFiches();
  const parNom = {}; FICHES.forEach(f => { parNom[f.name] = f; });
  jobs = Array.isArray(jobs) ? jobs : [];
  let erreurs = 0, message = null;
  await Promise.all(jobs.filter(j => !j.fait).map(async j => {
    try {
      const r = await to(fetch('https://serpapi.com/searches/' + j.id + '.json?api_key=' + K).then(x => x.json()), 8000);
      const st = String((r && r.search_metadata && r.search_metadata.status) || '');
      j.st = st || (r && r.error ? 'err:' + String(r.error).slice(0, 60) : 'vide');   // diagnostic visible dans la file
      if (r && r.error && !/processing|queued/i.test(String(r.error))) { j.fait = true; j.err = r.error; return; }
      if (!r || !r.search_metadata || /processing|queued/i.test(st)) {
        if (Date.now() - (j.t || 0) > ATTENTE_MAX_MS) { j.fait = true; j.err = 'timeout'; }
        return;
      }
      if (/error/i.test(st)) { j.fait = true; j.err = (r.search_metadata.error || st); return; }
      const p = parNom[j.name] ? posDe(parNom[j.name], r) : null;
      // Page rendue sans bloc local (ca arrive sur mobile) : erreur a retenter, pas une absence.
      if (p === undefined) { j.fait = true; j.err = 'bloc local vide'; return; }
      j.fait = true; j.pos = p;
      if (j.pos === null) j.titres = ((r.local_results && r.local_results.places) || []).slice(0, 6).map(x => x.title);   // diagnostic
    } catch (e) { if (Date.now() - (j.t || 0) > ATTENTE_MAX_MS) { j.fait = true; j.err = 'timeout'; } }
  }));
  const parCle = {};
  jobs.forEach(j => { (parCle[j.cle] = parCle[j.cle] || []).push(j); });
  const positions = {}, parMotCle = {}; let releves = 0;
  for (const [cle, L] of Object.entries(parCle)) {
    // Une fiche est prete quand tous ses mots-cles sont revenus. Des qu'une vague a du nouveau,
    // on REECRIT sa cle avec tout ce qui est pret (la page detient l'etat complet) : pas de
    // relecture-fusion sur un blob eventuel. Les cochees ('sel') s'accumulent dans la journee.
    const parFiche = {};
    L.forEach(j => { (parFiche[j.name] = parFiche[j.name] || []).push(j); });
    const snap = {}, snapkw = {}; let nouveau = false;
    for (const [name, J] of Object.entries(parFiche)) {
      if (!J.every(j => j.fait)) continue;
      const ok = J.filter(j => !j.err);
      if (!J.every(j => j.ecrit)) { nouveau = true; J.forEach(j => { if (j.err && !j.ecrit) { erreurs++; message = j.err; } }); }
      if (!ok.length) continue;
      snapkw[name] = {}; ok.forEach(j => { snapkw[name][j.kw] = (j.pos === undefined ? null : j.pos); });
      const p = ok.find(j => j.i === 0) || ok[0];
      snap[name] = (p.pos === undefined ? null : p.pos);
    }
    if (!nouveau) continue;
    if (Object.keys(snap).length) {
      if (cle === 'sel') {
        for (const [k, v] of [['rankbatch/' + today() + '/sel', snap], ['rankkw/' + today() + '/sel', snapkw]]) {
          const cur = await getJSON(k, {}); await setJSON(k, Object.assign(cur, v));
        }
      } else {
        await setJSON('rankbatch/' + today() + '/' + cle, snap);
        await setJSON('rankkw/' + today() + '/' + cle, snapkw);
      }
    }
    for (const [name, J] of Object.entries(parFiche)) {
      if (!J.every(j => j.fait) || J.every(j => j.ecrit)) continue;
      J.forEach(j => { j.ecrit = true; });
      if (snap[name] !== undefined) { positions[name] = snap[name]; parMotCle[name] = snapkw[name]; releves++; }
    }
  }
  const attente = new Set(jobs.filter(j => !j.fait).map(j => j.name)).size;
  return { jobs: jobs, releves: releves, en_attente: attente, erreurs: erreurs, message: message, positions: positions, parMotCle: parMotCle };
}

async function snapRank(start, baseUrl) {
  await chargerFiches();
  await chargerFiches();
  const K = process.env.SERPAPI_KEY;
  start = start || 0;
  // La page envoie des vagues de 5 fiches (15 recherches max par appel) ; la cle d'ecriture reste
  // alignee sur WAVE (10) pour que rankHist retrouve les blobs : deux demi-vagues partagent une cle.
  const wave = FICHES.slice(start, start + 5);
  const r = await soumettre(wave, K, String(Math.floor(start / WAVE) * WAVE));
  if (start === 0 && r.jobs.length) await setJSON('rankMeta', { last: new Date().toISOString() });
  return { jobs: r.jobs, soumis: r.jobs.length, total: wave.length, erreurs: r.erreurs, message: r.message, en_attente: new Set(r.jobs.map(j => j.name)).size, releves: 0 };
}

// Classement a la demande des seules fiches cochees (POST {names}). Soumission immediate, resultats
// ecrits dans 'rankbatch/<jour>/sel' et 'rankkw/<jour>/sel' par rankfetch, sans toucher au cooldown.
async function snapRankSel(names) {
  await chargerFiches();
  await chargerFiches();
  const K = process.env.SERPAPI_KEY;
  const voulu = new Set(names || []);
  const sel = FICHES.filter(f => voulu.has(f.name)).slice(0, 40);
  const r = await soumettre(sel, K, 'sel');
  return { jobs: r.jobs, soumis: r.jobs.length, total: sel.length, erreurs: r.erreurs, message: r.message, en_attente: new Set(r.jobs.map(j => j.name)).size, releves: 0 };
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
  return { ok: true, n: v.n, r: v.r, tel: j.nationalPhoneNumber || null, web: j.websiteUri || null };
}

module.exports = { snapAvis, snapAvisOne, snapRank, snapRankSel, recolter, allData, rankCooldown, relink, chargerFiches, fiches: () => FICHES, getJSON, setJSON, normName, pickMatch, paysDe };
