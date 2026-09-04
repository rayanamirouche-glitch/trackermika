const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('@netlify/blobs');
const core = require('./core');
const FICHES = require('./fiches.json');

exports.handler = async (event) => {
  connectLambda(event);
  const q = event.queryStringParameters || {};
  const baseUrl = process.env.URL || ('https://' + ((event.headers && event.headers.host) || ''));
  try {
    if (q.type === 'purgerank') {
      // Supprime les releves de classement d'une date. Sert a effacer une journee
      // ecrite alors que SerpAPI etait en erreur : toutes les fiches y valent null,
      // ce qui masque les positions reelles des jours precedents.
      if (!q.date || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'date requise, format ?type=purgerank&date=2026-09-01' }) };
      }
      const store = getStore('tracker');
      let supprimes = 0;
      for (let s = 0; s < FICHES.length; s += 10) {
        const k = 'rankbatch/' + q.date + '/' + s;
        const v = await store.get(k, { type: 'json' }).catch(() => null);
        if (v) { await store.delete(k); supprimes++; }
      }
      const rank = (await store.get('rank', { type: 'json' })) || {};
      let dansRank = false;
      if (rank[q.date]) { delete rank[q.date]; await store.setJSON('rank', rank); dansRank = true; }
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, date: q.date, vagues_supprimees: supprimes, retire_du_blob_rank: dansRank }) };
    }
    if (q.type === 'serpapi') {
      const K = process.env.SERPAPI_KEY;
      const j = await fetch('https://serpapi.com/account?api_key=' + K).then(r => r.json()).catch(e => ({ erreur: String(e) }));
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({
        plan: j.plan_name || null,
        recherches_du_mois: j.searches_per_month != null ? j.searches_per_month : null,
        utilisees: j.this_month_usage != null ? j.this_month_usage : null,
        restantes: j.total_searches_left != null ? j.total_searches_left : null,
        reinitialisation: j.account_rate_limit_per_hour != null ? ('limite horaire ' + j.account_rate_limit_per_hour) : null,
        erreur: j.error || j.erreur || null
      }, null, 1) };
    }
    if (q.type === 'rankdiag') {
      const K = process.env.SERPAPI_KEY;
      const i = parseInt(q.i || '0', 10);
      const f = FICHES[i];
      if (!f) return { statusCode: 400, body: JSON.stringify({ error: 'index hors bornes', total: FICHES.length }) };
      const u = 'https://serpapi.com/search.json?engine=google_maps&q=' + encodeURIComponent(f.kw) + '&ll=' + encodeURIComponent('@' + f.ll + ',14z') + '&hl=fr&api_key=' + K;
      const j = await fetch(u).then(r => r.json()).catch(e => ({ fetch_error: String(e) }));
      const rs = (j && j.local_results) || [];
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({
        fiche: f.name, index: i, kw: f.kw, ll: f.ll,
        cle_serpapi_presente: !!K,
        erreur: j.error || j.fetch_error || null,
        statut: (j.search_metadata && j.search_metadata.status) || null,
        nb_resultats: rs.length,
        target: f.target,
        position_trouvee: (() => {
          const norm = s => (s || '').toLowerCase().replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'").normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.\-]/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\s+/g, ' ').trim();
          const t = norm(f.target);
          for (let i = 0; i < rs.length; i++) { const n = norm(rs[i].title); if (n === t || n.includes(t)) return i + 1; }
          return null;
        })(),
        tous_les_titres: rs.map((r, i) => (i + 1) + '. ' + r.title)
      }, null, 1) };
    }
    if (q.type === 'audit') {
      const K = process.env.PLACES_API_KEY;
      const store = getStore('tracker');
      const ids = (await store.get('ids', { type: 'json' })) || {};
      const out = [];
      const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      for (const f of FICHES) {
        const pid = ids[f.name];
        if (!pid) { out.push({ fiche: f.name, id: null, etat: 'NON_LIE' }); continue; }
        try {
          const u = 'https://places.googleapis.com/v1/places/' + pid + '?fields=displayName,formattedAddress&key=' + K;
          const j = await fetch(u).then(r => r.json());
          const gname = (j.displayName && j.displayName.text) || null;
          const a = norm(f.name), b = norm(gname);
          // Google porte souvent des fautes de frappe dans le nom de la fiche
          // (Koninglso/Koningslo, Ottignes/Ottignies). Un simple include() classait
          // ces fiches correctes en MAUVAISE_FICHE. On mesure donc le recouvrement
          // des mots, plus la presence de la ville dans l'adresse.
          const toks = s => s.split(' ').filter(w => w.length > 2);
          const ta = toks(a), tb = toks(b);
          const inter = ta.filter(w => tb.some(v => v === w || (w.length > 4 && v.length > 4 && (v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5))))));
          const ratio = (ta.length && tb.length) ? inter.length / Math.min(ta.length, tb.length) : 0;
          const strict = !!gname && (a === b || a.includes(b) || b.includes(a));
          const villeOk = !!(f.city && j.formattedAddress && norm(j.formattedAddress).includes(norm(f.city).split(' ')[0]));
          let etat;
          if (strict) etat = 'OK';
          else if (ratio >= 0.5 || (ratio >= 0.34 && villeOk)) etat = 'OK_VARIANTE';
          else etat = 'MAUVAISE_FICHE';
          out.push({ fiche: f.name, id: pid, google: gname, adresse: j.formattedAddress || null, recouvrement: Math.round(ratio * 100) / 100, etat });
        } catch (e) { out.push({ fiche: f.name, id: pid, etat: 'ERREUR', err: String(e) }); }
      }
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out, null, 1) };
    }
    if (q.type === 'lookup') {
      const K = process.env.PLACES_API_KEY;
      const f = FICHES.find(x => x.name === q.name);
      if (!f) return { statusCode: 400, body: JSON.stringify({ error: 'fiche inconnue', name: q.name }) };
      const ll = f.ll.split(',').map(Number);
      const j = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': K, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress' },
        body: JSON.stringify({ textQuery: f.name, locationBias: { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 5000 } } })
      }).then(r => r.json());
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ fiche: f.name, results: (j.places || []).slice(0, 8) }, null, 1) };
    }
    if (q.type === 'setids') {
      // Ecriture batch : un seul read-modify-write, sinon les appels concurrents
      // s'ecrasent (le blob store est eventuellement coherent).
      const store = getStore('tracker');
      let payload;
      try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'body JSON invalide' }) }; }
      const ids = (await store.get('ids', { type: 'json' })) || {};
      const base = (await store.get('base', { type: 'json' })) || {};
      const set = payload.set || {};
      const clear = payload.clear || [];
      for (const n of clear) { delete ids[n]; delete base[n]; }
      for (const [n, v] of Object.entries(set)) { ids[n] = v; }
      const setBase = payload.base || {};
      for (const [n, v] of Object.entries(setBase)) { base[n] = v; }
      await store.setJSON('ids', ids);
      if (clear.length || Object.keys(setBase).length) await store.setJSON('base', base);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, set: Object.keys(set).length, base: Object.keys(payload.base || {}).length, clear: clear.length, total_ids: Object.keys(ids).length }) };
    }
    if (q.type === 'diag') {
      const store = getStore('tracker');
      const ids = (await store.get('ids', { type: 'json' })) || {};
      const avis = (await store.get('avis', { type: 'json' })) || {};
      const today = new Date().toISOString().slice(0, 10);
      const snapToday = avis[today] || {};
      const linked = Object.keys(ids).length;
      const firstLinked = FICHES.find(f => ids[f.name]);
      let google = null;
      if (firstLinked) {
        const K = process.env.PLACES_API_KEY;
        const u = 'https://places.googleapis.com/v1/places/' + ids[firstLinked.name] + '?fields=rating,userRatingCount&key=' + K;
        const j = await fetch(u).then(r => r.json()).catch(e => ({ fetch_error: String(e) }));
        google = {
          fiche: firstLinked.name,
          status: j.error ? 'ERROR' : (j.fetch_error ? 'FETCH_ERROR' : 'OK'),
          error_message: j.error ? (j.error.message || null) : null,
          fetch_error: j.fetch_error || null,
          n: typeof j.userRatingCount === 'number' ? j.userRatingCount : ((j.error || j.fetch_error) ? null : 0)
        };
      }
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          code_version: 'v2-vagues',
          fiches: FICHES.length,
          ids_lies: linked,
          snapshot_du_jour: Object.keys(snapToday).length + ' fiches relevées',
          cle_places_presente: !!process.env.PLACES_API_KEY,
          test_google: google
        }, null, 1)
      };
    }
    if (q.type === 'purge') {
      if (!q.date || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'date requise, format ?type=purge&date=2026-08-26' }) };
      }
      const store = getStore('tracker');
      const avis = (await store.get('avis', { type: 'json' })) || {};
      if (!avis[q.date]) {
        return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, note: 'aucun snapshot à cette date, rien à purger' }) };
      }
      const nb = Object.keys(avis[q.date]).length;
      delete avis[q.date];
      await store.setJSON('avis', avis);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, purge: q.date, fiches_supprimees_du_snapshot: nb }) };
    }
    if (q.type === 'diag2') {
      const store = getStore('tracker');
      const avis = (await store.get('avis', { type: 'json' })) || {};
      const today = new Date().toISOString().slice(0, 10);
      const snapToday = avis[today] || {};
      const sum = Object.values(snapToday).reduce((s, v) => s + (v && v.n ? v.n : 0), 0);
      const sample = {};
      Object.keys(snapToday).slice(0, 6).forEach(k => { sample[k] = snapToday[k]; });
      let dataSide = null;
      try {
        const all = await core.allData();
        const dToday = (all.avis && all.avis[today]) || {};
        dataSide = {
          nb_fiches_dans_data: Object.keys(dToday).length,
          somme_dans_data: Object.values(dToday).reduce((s, v) => s + (v && v.n ? v.n : 0), 0),
          dates_connues: Object.keys(all.avis || {}).sort()
        };
      } catch (e) { dataSide = { erreur: String(e) }; }
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          blob_direct: { nb_fiches: Object.keys(snapToday).length, somme: sum, echantillon: sample },
          via_fonction_data: dataSide
        }, null, 1)
      };
    }
    if (q.type === 'avis1') {
      const idx = FICHES.findIndex(f => f.name === q.name);
      if (idx < 0) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: false, motif: 'fiche inconnue' }) };
      const r1 = await core.snapAvisOne(idx);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(r1) };
    }
    if (q.type === 'avis') {
      const start = (q.start !== undefined) ? parseInt(q.start, 10) : null;
      const av = await core.snapAvis(start);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ releves: av.releves, total: av.total }) };
    } else if (q.type === 'relink') {
      await core.relink();
      await core.snapAvis(null);
    } else if (q.type === 'rank') {
      if (q.force !== '1') {
        const left = await core.rankCooldown();
        if (left > 0) {
          const h = Math.ceil(left / 3600000);
          return { statusCode: 429, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ cooldown: h }) };
        }
      }
      const rk = await core.snapRank(parseInt(q.start || '0', 10), baseUrl);
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(rk) };
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'type avis|rank|relink|diag requis' }) };
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
