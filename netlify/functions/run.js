const { connectLambda } = require('@netlify/blobs');
const { getStore } = require('@netlify/blobs');
const core = require('./core');
const FICHES = require('./fiches.json');

exports.handler = async (event) => {
  connectLambda(event);
  const q = event.queryStringParameters || {};
  const baseUrl = process.env.URL || ('https://' + ((event.headers && event.headers.host) || ''));
  try {
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
        const u = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + ids[firstLinked.name] + '&fields=user_ratings_total,rating&key=' + K;
        const j = await fetch(u).then(r => r.json()).catch(e => ({ fetch_error: String(e) }));
        google = {
          fiche: firstLinked.name,
          status: j.status || null,
          error_message: j.error_message || null,
          fetch_error: j.fetch_error || null,
          n: j.result ? j.result.user_ratings_total : null
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
    if (q.type === 'avis') {
      const start = (q.start !== undefined) ? parseInt(q.start, 10) : null;
      await core.snapAvis(start);
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
      await core.snapRank(parseInt(q.start || '0', 10), baseUrl);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'type avis|rank|relink|diag requis' }) };
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
