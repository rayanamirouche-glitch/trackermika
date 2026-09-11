const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function integer(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

async function listOrders(store) {
  const listed = await store.list({ prefix: 'orders/' });
  const keys = (listed.blobs || []).map(blob => blob.key).sort().reverse().slice(0, 100);
  const values = await Promise.all(keys.map(key => store.get(key, { type: 'json' }).catch(() => null)));
  return values.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const store = getStore('tracker');

  if (event.httpMethod === 'GET') {
    try {
      return json(200, { orders: await listOrders(store) });
    } catch (error) {
      return json(500, { error: 'Impossible de charger les demandes.' });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const requestOrigin = clean(event.headers && event.headers.origin, 300);
  const requestHost = clean(event.headers && event.headers.host, 160);
  if (requestOrigin) {
    try {
      if (new URL(requestOrigin).host !== requestHost) return json(403, { error: 'Origine non autorisée.' });
    } catch (error) {
      return json(403, { error: 'Origine non autorisée.' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Demande invalide.' });
  }

  if (payload.website) return json(200, { ok: true, id: 'RC-OK' });

  const type = payload.type === 'fiche' ? 'fiche' : payload.type === 'avis' ? 'avis' : null;
  const city = clean(payload.city, 120);
  const activity = clean(payload.activity, 100);
  const listingName = clean(payload.listingName, 180);
  const siteUrl = clean(payload.siteUrl, 300);
  const notes = clean(payload.notes, 1200);
  const photos = integer(payload.photos, 0, 200);
  const comments = integer(payload.comments, 0, 500);
  const listingCount = integer(payload.listingCount, 1, 100);

  if (!type || city.length < 2 || activity.length < 2) {
    return json(400, { error: 'La ville et le domaine d’activité sont obligatoires.' });
  }
  if (type === 'avis' && !listingName) {
    return json(400, { error: 'Choisis la fiche concernée.' });
  }
  if (photos === null || comments === null || listingCount === null) {
    return json(400, { error: 'Vérifie les quantités demandées.' });
  }

  const now = new Date();
  const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase();
  const id = 'RC-' + shortId;
  const order = {
    id,
    type,
    city,
    activity,
    listingName,
    hasSite: Boolean(payload.hasSite),
    siteUrl,
    photos,
    comments,
    listingCount,
    notes,
    status: 'nouvelle',
    createdAt: now.toISOString(),
    source: requestHost
  };

  try {
    const key = 'orders/' + now.toISOString().replace(/[:.]/g, '-') + '-' + shortId;
    await store.setJSON(key, order);
    return json(201, { ok: true, id, order });
  } catch (error) {
    return json(500, { error: 'La demande n’a pas pu être enregistrée. Réessaie dans un instant.' });
  }
};
