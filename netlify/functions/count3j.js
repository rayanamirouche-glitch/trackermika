// Compteur J-2 / J-1 / J : avis publiés ces 3 derniers jours, lus chez DataForSEO (Google Reviews,
// « Plus récents ») via les place_id déjà liés. Depuis le 30/09/2026 (avant : SerpAPI, quota épuisé).
// Asynchrone, comme le classement :
//   GET  ?start=S&n=N  → soumet la lecture des N fiches (réponse immédiate : jobs = [{name, id, t}])
//   POST {jobs}        → relit ces lectures ; rend les résultats prêts et la file restante
const { connectLambda } = require('@netlify/blobs');
const core = require('./core');

const parisDate = d => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const H = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const ATTENTE_MAX_MS = 240000;   // au-delà de 4 min sans réponse, la fiche est comptée en échec

exports.handler = async (event) => {
  connectLambda(event);
  const now = new Date();
  const days = [0, 1, 2].map(k => parisDate(new Date(now.getTime() - k * 86400000)));
  const D = { j0: days[0], j1: days[1], j2: days[2] };
  if (!core.dfsAuth()) return { statusCode: 200, headers: H, body: JSON.stringify({ days: D, results: {}, jobs: [], en_attente: 0, erreur: 'identifiants DataForSEO absents' }) };

  if (event.httpMethod === 'POST') {
    let jobs = [];
    try { jobs = JSON.parse(event.body || '{}').jobs || []; } catch (e) { jobs = []; }
    const out = {};
    // au plus 60 lectures par appel : la fonction reste sous les 10 s de Netlify, la page rappelle toutes les 5 s
    await Promise.all(jobs.filter(j => !j.fait).slice(0, 60).map(async j => {
      try {
        const r = await core.dfs('business_data/google/reviews/task_get/' + j.id, null, 7000);
        if (r && r.status_code && r.status_code !== 20000) { j.fait = true; out[j.name] = { err: String(r.status_message || r.status_code).slice(0, 80) }; return; }
        const t = r && Array.isArray(r.tasks) ? r.tasks[0] : null;
        const sc = t ? t.status_code : null;
        if (!t || sc === 40601 || sc === 40602) {   // tâche transmise ou en file : on relira
          if (Date.now() - (j.t || 0) > ATTENTE_MAX_MS) { j.fait = true; out[j.name] = { err: 'timeout' }; }
          return;
        }
        j.fait = true;
        if (sc !== 20000) { out[j.name] = { err: String(t.status_message || sc).slice(0, 80) }; return; }
        const b = { j0: 0, j1: 0, j2: 0 };
        for (const it of (((t.result || [])[0] || {}).items || [])) {
          const ts = String(it.timestamp || '');   // « 2026-09-29 14:03:22 +00:00 »
          if (!ts) continue;
          const day = parisDate(new Date(ts.replace(' +00:00', 'Z').replace(' ', 'T')));
          if (day === days[0]) b.j0++; else if (day === days[1]) b.j1++; else if (day === days[2]) b.j2++;
        }
        out[j.name] = b;
      } catch (e) { if (Date.now() - (j.t || 0) > ATTENTE_MAX_MS) { j.fait = true; out[j.name] = { err: 'timeout' }; } }
    }));
    const reste = jobs.filter(j => !j.fait);
    return { statusCode: 200, headers: H, body: JSON.stringify({ days: D, results: out, jobs: reste, en_attente: reste.length }) };
  }

  const p = event.queryStringParameters || {};
  const start = parseInt(p.start || '0', 10);
  const n = Math.min(parseInt(p.n || '3', 10), 100);
  const fiches = await core.chargerFiches();
  const slice = fiches.slice(start, start + n);
  const ids = await core.getJSON('ids', {});
  const out = {}, taches = [];
  slice.forEach(f => {
    const pid = ids[f.name];
    if (!pid) { out[f.name] = { err: 'non liée' }; return; }
    // 30 avis les plus récents : de quoi couvrir 3 jours même sur une fiche très active
    taches.push({ name: f.name, corps: { place_id: pid, location_code: 2250, language_code: 'fr', depth: 30, sort_by: 'newest', priority: 2, tag: String(taches.length) } });
  });
  const jobs = [];
  if (taches.length) {
    let r = null;
    try { r = await core.dfs('business_data/google/reviews/task_post', taches.map(t => t.corps), 7000); }
    catch (e) { r = { status_message: String(e && e.message ? e.message : e) }; }
    const tasks = (r && Array.isArray(r.tasks)) ? r.tasks : [];
    taches.forEach((t, k) => {
      const x = tasks.find(y => y && y.data && y.data.tag === String(k));
      if (!x || x.status_code !== 20100) out[t.name] = { err: String((x && x.status_message) || (r && r.status_message) || 'refusé').slice(0, 80) };
      else jobs.push({ name: t.name, id: x.id, t: Date.now() });
    });
  }
  return { statusCode: 200, headers: H, body: JSON.stringify({ days: D, count: fiches.length, results: out, jobs: jobs, en_attente: jobs.length }) };
};
