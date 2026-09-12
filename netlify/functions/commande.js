// Commande passée par le client depuis son tracker (bouton « Commander »).
// POST JSON { client, fiche, ville, lien, total, parJour, photosNb, photosParCom, prix, tranche, debut, note }
// → enregistrée dans Firebase commandes_v1/<id> (lue par la console de Rayan),
// → WhatsApp à Rayan via CallMeBot si CALLMEBOT_PHONE et CALLMEBOT_KEY sont définies sur le site.
const FB = 'https://avis-tracker-default-rtdb.europe-west1.firebasedatabase.app/commandes_v1/';
const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'POST attendu' }) };
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'JSON invalide' }) }; }
  const total = parseInt(b.total, 10), parJour = parseInt(b.parJour, 10), photosNb = parseInt(b.photosNb || 0, 10), photosParCom = parseInt(b.photosParCom || 1, 10);
  if (!b.fiche || !b.lien || !(total > 0) || !(parJour >= 1 && parJour <= 3)) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'fiche, lien, total et par jour (1 à 3) requis' }) };
  if (!/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|www\.google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\//.test(b.lien)) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'lien Maps invalide' }) };
  const ph = Math.min(Math.max(photosNb, 0), total), ppc = Math.min(Math.max(photosParCom, 1), 3);
  const prix = (total - ph) * 4 + ph * (5 + ppc);
  const tranches = Math.ceil(total / 20), premiere = Math.round(prix * Math.min(20, total) / total);
  const site = (process.env.URL || ('https://' + ((event.headers && event.headers.host) || ''))).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const id = 'k' + Date.now();
  const cmd = { id, site, client: String(b.client || '').slice(0, 60), fiche: String(b.fiche).slice(0, 120), ville: String(b.ville || '').slice(0, 60), lien: b.lien,
    total, parJour, photosNb: ph, photosParCom: ppc, prix, tranches, premiere, debut: (b.debut || new Date().toISOString().slice(0, 10)).slice(0, 10),
    note: String(b.note || '').slice(0, 300), statut: 'nouvelle', date: new Date().toISOString(), postes: 0, payees: 0 };
  const r = await fetch(FB + id + '.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: 'enregistrement impossible (' + r.status + ')' }) };
  // Notification WhatsApp : relais unique sur le site ménage (les clés n'existent que là).
  let notif = false;
  const txt = `Nouvelle commande — ${cmd.client || site}\n${cmd.fiche} (${cmd.ville})\n${total} com · ${parJour}/j` + (ph ? ` · ${ph} avec ${ppc} photo${ppc > 1 ? 's' : ''}` : '') +
    `\n${prix} € · ${tranches} tranche${tranches > 1 ? 's' : ''} de 20 · 1re ${premiere} €\ndébut ${cmd.debut}` + (cmd.note ? `\n« ${cmd.note} »` : '');
  try {
    const n = await fetch('https://menageinformatique.netlify.app/.netlify/functions/notif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: txt }) });
    const nj = await n.json().catch(() => ({})); notif = !!nj.envoye;
  } catch (e) { notif = false; }
  return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, id, prix, tranches, premiere, notif }) };
};
