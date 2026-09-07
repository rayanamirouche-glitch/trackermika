// Recale la base objectif : base[fiche] = dernier total avis - delta (avis déjà postés)
const { getStore, connectLambda } = require('@netlify/blobs');
const store = () => getStore('tracker');
async function getJSON(k, d) { try { const v = await store().get(k, { type: 'json' }); return (v === null || v === undefined) ? d : v } catch (e) { return d } }
async function setJSON(k, v) { await store().setJSON(k, v) }

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let deltas = {};
  try { deltas = (JSON.parse(event.body || '{}')).deltas || {}; } catch (e) {}
  const avis = await getJSON('avis', {});
  const ds = Object.keys(avis).sort();
  const now = avis[ds[ds.length - 1]] || {};
  const base = await getJSON('base', {});
  const out = {};
  for (const name in deltas) {
    const d = parseInt(deltas[name], 10);
    if (!d || d <= 0) continue;
    const cur = now[name] && now[name].n != null ? now[name].n
      : (base[name] != null ? base[name] : null);
    if (cur == null) { out[name] = 'pas de total connu'; continue; }
    base[name] = Math.max(0, cur - d);
    out[name] = `base ${cur} → ${base[name]} (-${d})`;
  }
  await setJSON('base', base);
  return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, changes: out }) };
};
