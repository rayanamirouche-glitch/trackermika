(function () {
  'use strict';

  var orders = [];
  var currentType = 'avis';

  function byId(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function iconRefresh() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  window.showPortalView = function (view) {
    var tracking = byId('trackingView');
    var ordering = byId('ordersView');
    if (!tracking || !ordering) return;
    var isOrders = view === 'commandes';
    tracking.hidden = isOrders;
    ordering.hidden = !isOrders;
    document.querySelectorAll('.portal-tab').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === view);
      button.setAttribute('aria-selected', button.dataset.view === view ? 'true' : 'false');
    });
    history.replaceState(null, '', isOrders ? '#commandes' : location.pathname + location.search);
    if (isOrders) loadOrders();
    iconRefresh();
  };

  function setOrderType(type) {
    currentType = type === 'fiche' ? 'fiche' : 'avis';
    byId('orderType').value = currentType;
    document.querySelectorAll('.order-type').forEach(function (button) {
      var active = button.dataset.type === currentType;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    var existing = byId('existingListingField');
    if (existing) existing.hidden = currentType === 'fiche';
    updateSummary();
  }

  function numberValue(id, fallback) {
    var value = parseInt((byId(id) || {}).value, 10);
    return Number.isFinite(value) ? value : fallback;
  }

  function updateSummary() {
    var summary = byId('orderSummary');
    if (!summary) return;
    var city = (byId('orderCity').value || 'ville à préciser').trim();
    var activity = (byId('orderActivity').value || 'activité à préciser').trim();
    var listingCount = numberValue('orderListingCount', 1);
    var comments = numberValue('orderComments', 0);
    var photos = numberValue('orderPhotos', 0);
    var label = currentType === 'fiche' ? 'Création' : 'Avis Google';
    summary.textContent = label + ' · ' + listingCount + ' fiche(s) · ' + activity + ' · ' + city + ' · ' + comments + ' avis · ' + photos + ' photos';
  }

  function syncSiteField() {
    var wrap = byId('siteUrlField');
    if (wrap) wrap.hidden = !byId('orderHasSite').checked;
    updateSummary();
  }

  function populateListings(data) {
    var select = byId('orderListing');
    if (!select || !data || !Array.isArray(data.fiches)) return;
    var previous = select.value;
    select.innerHTML = '<option value="">Choisir une fiche</option><option value="Plusieurs fiches (voir précisions)">Plusieurs fiches · à préciser</option>' + data.fiches.map(function (fiche) {
      return '<option value="' + esc(fiche.name) + '">' + esc(fiche.name) + ' · ' + esc(fiche.city || '') + '</option>';
    }).join('');
    if (previous) select.value = previous;
  }

  function statusLabel(status) {
    if (status === 'terminee') return 'Terminée';
    if (status === 'en_cours') return 'En cours';
    return 'Reçue';
  }

  function renderOrders() {
    var list = byId('orderList');
    var badge = byId('orderBadge');
    if (!list) return;
    if (badge) {
      badge.textContent = orders.length;
      badge.hidden = orders.length === 0;
    }
    if (!orders.length) {
      list.innerHTML = '<div class="order-empty">Aucune demande pour le moment.</div>';
      return;
    }
    list.innerHTML = orders.slice(0, 20).map(function (order) {
      var kind = order.type === 'fiche' ? 'Nouvelle fiche Google' : 'Avis Google';
      var date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
      var statusClass = order.status === 'terminee' ? ' done' : order.status === 'en_cours' ? ' processing' : '';
      var detail = (order.listingCount || 1) + ' fiche(s) · ' + (order.comments || 0) + ' avis · ' + (order.photos || 0) + ' photos';
      return '<article class="order-item">' +
        '<div class="order-item-head"><div><div class="order-item-title">' + esc(kind) + '</div><div class="order-item-meta">' + esc(date) + ' · ' + esc(order.city) + '</div></div>' +
        '<span class="order-status' + statusClass + '">' + statusLabel(order.status) + '</span></div>' +
        '<div class="order-item-detail">' + esc(order.activity) + '<br>' + esc(detail) + '</div></article>';
    }).join('');
  }

  async function loadOrders() {
    var list = byId('orderList');
    if (!list) return;
    try {
      var response = await fetch('/.netlify/functions/orders', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('chargement impossible');
      var payload = await response.json();
      orders = Array.isArray(payload.orders) ? payload.orders : [];
      renderOrders();
    } catch (error) {
      list.innerHTML = '<div class="order-empty">Les demandes seront disponibles après la mise en ligne.</div>';
    }
  }

  async function submitOrder(event) {
    event.preventDefault();
    var button = byId('orderSubmit');
    var feedback = byId('orderFeedback');
    var listing = byId('orderListing').value;
    if (currentType === 'avis' && !listing) {
      feedback.className = 'order-feedback error';
      feedback.textContent = 'Choisis la fiche concernée.';
      byId('orderListing').focus();
      return;
    }

    var payload = {
      type: currentType,
      city: byId('orderCity').value.trim(),
      activity: byId('orderActivity').value.trim(),
      listingName: listing,
      hasSite: byId('orderHasSite').checked,
      siteUrl: byId('orderSiteUrl').value.trim(),
      photos: numberValue('orderPhotos', 0),
      comments: numberValue('orderComments', 0),
      listingCount: numberValue('orderListingCount', 1),
      notes: byId('orderNotes').value.trim(),
      website: byId('orderWebsite').value
    };

    button.disabled = true;
    feedback.className = 'order-feedback';
    feedback.textContent = 'Envoi en cours…';
    try {
      var response = await fetch('/.netlify/functions/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      var result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'La demande n’a pas été envoyée.');
      feedback.className = 'order-feedback success';
      feedback.textContent = 'Demande reçue. Référence ' + result.id + '.';
      byId('orderNotes').value = '';
      if (result.order) {
        orders = [result.order].concat(orders.filter(function (order) { return order.id !== result.order.id; }));
        renderOrders();
      } else {
        await loadOrders();
      }
    } catch (error) {
      feedback.className = 'order-feedback error';
      feedback.textContent = error.message || 'La demande n’a pas été envoyée.';
    } finally {
      button.disabled = false;
    }
  }

  window.portalAfterData = function (data) {
    populateListings(data);
    iconRefresh();
  };

  function init() {
    document.body.classList.add(window.TRACKER_ADMIN ? 'admin-mode' : 'client-mode');
    document.querySelectorAll('.order-type').forEach(function (button) {
      button.addEventListener('click', function () { setOrderType(button.dataset.type); });
    });
    ['orderCity', 'orderActivity', 'orderPhotos', 'orderComments', 'orderListingCount'].forEach(function (id) {
      var field = byId(id);
      if (field) field.addEventListener('input', updateSummary);
    });
    byId('orderHasSite').addEventListener('change', syncSiteField);
    byId('orderForm').addEventListener('submit', submitOrder);
    setOrderType('avis');
    syncSiteField();
    loadOrders();
    if (location.hash === '#commandes') window.showPortalView('commandes');
    iconRefresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
