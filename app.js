/* S crédits : logique de l'application (crédits, versements, alertes, licence, administrateur). */
(function () {
  var KEY = 'carnet-credits-v1';
  var credits = [];
  var col = null;
  var mode = 'pending';
  var loaded = false;
  var loadError = false;
  var slow = false;
  var filter = 'all';
  var query = '';
  var openIds = {};
  var addOpen = {};
  var dupChoice = null;
  var confirmDel = null;
  var alerted = {};
  var lastDay = '';

  function $(s) { return document.querySelector(s); }
  var nfmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
  function nf(n) { return nfmt.format(n); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayIso() { return iso(new Date()); }
  function parseIso(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 86400000); }
  function fmtDate(s) { return parseIso(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function ajoutsSum(c) { return round2((c.ajouts || []).reduce(function (s, a) { return s + a.montant; }, 0)); }
  function initialAmount(c) { return round2(c.total - ajoutsSum(c)); }
  function digitsOnly(t) { return String(t || '').replace(/\D/g, ''); }
  function sameClient(a, b) {
    var ta = digitsOnly(a.tel), tb = digitsOnly(b.tel);
    if (ta.length >= 8 && tb.length >= 8) return ta.slice(-8) === tb.slice(-8);
    return String(a.nom || '').trim().toLowerCase() === String(b.nom || '').trim().toLowerCase() && !!String(a.nom || '').trim();
  }
  function round2(x) { return Math.round(x * 100) / 100; }
  function paid(c) { return round2(c.versements.reduce(function (s, v) { return s + v.montant; }, 0)); }
  function reste(c) { return Math.max(0, round2(c.total - paid(c))); }
  function isDue(c) { return reste(c) > 0 && c.rappel <= todayIso(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function status(c) {
    if (reste(c) <= 0) return { k: 'good', t: 'Soldé' };
    var d = daysBetween(todayIso(), c.rappel);
    if (d < 0) return { k: 'bad', t: 'En retard de ' + (-d) + (d === -1 ? ' jour' : ' jours') };
    if (d === 0) return { k: 'warn', t: "À encaisser aujourd'hui" };
    return { k: 'info', t: 'Rappel dans ' + d + (d === 1 ? ' jour' : ' jours') };
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* Enregistrement */
  function saveLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(credits)); return true; }
    catch (e) { toast("Enregistrement impossible sur cet appareil."); return false; }
  }
  function loadLocal() {
    try { var raw = localStorage.getItem(KEY); credits = raw ? JSON.parse(raw) : []; }
    catch (e) { credits = []; }
  }
  var queue = Promise.resolve();
  function enqueue(fn) {
    queue = queue.then(fn).catch(function () { toast("L'enregistrement a échoué. Vérifiez votre connexion et réessayez."); });
  }
  function commit(c) {
    c.ajouts = Array.isArray(c.ajouts) ? c.ajouts : [];
    var i = credits.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) credits[i] = c; else credits.push(c);
    if (col) { var copy = clone(c); enqueue(function () { return col.doc(copy.id).set(copy); }); }
    else saveLocal();
    render();
    checkDue();
  }
  function drop(id) {
    credits = credits.filter(function (x) { return x.id !== id; });
    if (col) enqueue(function () { return col.doc(id).delete(); });
    else saveLocal();
    render();
  }
  function normalize(c) {
    c.versements = Array.isArray(c.versements) ? c.versements : [];
    c.total = Number(c.total) || 0;
    c.ajouts = Array.isArray(c.ajouts) ? c.ajouts : [];
    c.pieces = c.pieces || { recto: false, verso: false };
    return c;
  }

  /* Rendu */
  function renderSummary() {
    var tot = 0, enc = 0, rst = 0, due = 0;
    credits.forEach(function (c) { tot += c.total; enc += paid(c); rst += reste(c); if (isDue(c)) due++; });
    $('#summary').innerHTML =
      '<div class="sum-main"><span class="lbl">Reste à encaisser</span><span class="big">' + nf(round2(rst)) + '<small>FCFA</small></span></div>' +
      '<dl class="sum-side">' +
      '<div><dt>Total des crédits</dt><dd>' + nf(round2(tot)) + '</dd></div>' +
      '<div><dt>Déjà encaissé</dt><dd>' + nf(round2(enc)) + '</dd></div>' +
      '<div><dt>Clients à relancer</dt><dd class="' + (due ? 'bad' : '') + '">' + due + '</dd></div>' +
      '</dl>';
  }

  function renderAlerts() {
    var box = $('#alerts');
    var dues = credits.filter(isDue).sort(function (a, b) { return a.rappel < b.rappel ? -1 : 1; });
    if (!dues.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<h2>À encaisser maintenant</h2><ul>' + dues.map(function (c) {
      return '<li><span class="txt">Rappel : il faut encaisser <strong>' + esc(c.nom) + '</strong>, qui doit <strong class="num">' + nf(reste(c)) + ' FCFA</strong>.</span>' +
        '<span class="acts"><button class="btn btn-small" type="button" data-act="view" data-id="' + c.id + '">Voir le dossier</button>' +
        '<button class="btn btn-small" type="button" data-act="delay" data-id="' + c.id + '">Reporter de 7 jours</button></span></li>';
    }).join('') + '</ul>';
  }

  /* Pièces d'identité : photos réduites, stockées à part du dossier */
  var pieceCache = {};
  var pieceLoading = {};
  var SIDES = [['recto', 'Recto'], ['verso', 'Verso']];
  function compress(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('type')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 1100 / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        var q = 0.75, out = cv.toDataURL('image/jpeg', q);
        while (out.length > 190000 && q > 0.35) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
        if (out.length > 190000) {
          cv.width = Math.round(w * 0.7); cv.height = Math.round(h * 0.7);
          ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
          out = cv.toDataURL('image/jpeg', 0.6);
        }
        resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('read')); };
      img.src = url;
    });
  }
  function pieceCol(id) { return col.doc(id).collection('pieces'); }
  async function pieceSave(id, side, data) {
    if (col) await pieceCol(id).doc(side).set({ img: data });
    else localStorage.setItem(KEY + '-p-' + id + '-' + side, data);
    pieceCache[id + ':' + side] = data;
  }
  async function pieceLoad(id, side) {
    var k = id + ':' + side;
    if (k in pieceCache) return pieceCache[k];
    var v = null;
    if (col) { var s = await pieceCol(id).doc(side).get(); v = s.exists ? (s.data().img || null) : null; }
    else { try { v = localStorage.getItem(KEY + '-p-' + id + '-' + side); } catch (e) { v = null; } }
    pieceCache[k] = v;
    return v;
  }
  async function pieceDelete(id, side) {
    if (col) await pieceCol(id).doc(side).delete();
    else { try { localStorage.removeItem(KEY + '-p-' + id + '-' + side); } catch (e) {} }
    pieceCache[id + ':' + side] = null;
  }
  function piecesHtml(c) {
    return SIDES.map(function (sd) {
      var side = sd[0], label = sd[1];
      var has = !!(c.pieces && c.pieces[side]);
      var k = c.id + ':' + side;
      var body;
      if (!has) body = '<p class="rappel">Aucune photo.</p>';
      else if (!(k in pieceCache)) body = '<p class="rappel">Chargement de la photo…</p>';
      else if (!pieceCache[k]) body = '<p class="rappel">Photo introuvable.</p>';
      else body = '<img class="piece-img" src="' + pieceCache[k] + '" alt="' + label + " de la pièce d'identité de " + esc(c.nom) + '" data-act="zoom">';
      return '<div class="piece"><h5>' + label + '</h5>' + body + '<div class="piece-acts">' +
        '<label class="btn btn-small file-btn">' + (has ? 'Remplacer' : 'Ajouter une photo') + '<input type="file" accept="image/*" hidden data-file="' + c.id + '|' + side + '"></label>' +
        (has ? '<button class="link link-danger" type="button" data-act="rmpiece" data-id="' + c.id + '" data-side="' + side + '">Retirer</button>' : '') +
        '</div></div>';
    }).join('');
  }
  function refreshPieces(id) {
    var el = document.getElementById('pc-' + id), c = find(id);
    if (el && c) el.innerHTML = piecesHtml(c);
  }
  function hydratePieces() {
    credits.forEach(function (c) {
      if (!openIds[c.id] || !c.pieces) return;
      SIDES.forEach(function (sd) {
        var side = sd[0], k = c.id + ':' + side;
        if (c.pieces[side] && !(k in pieceCache) && !pieceLoading[k]) {
          pieceLoading[k] = true;
          pieceLoad(c.id, side).catch(function () { pieceCache[k] = null; }).then(function () { pieceLoading[k] = false; refreshPieces(c.id); });
        }
      });
    });
  }

  function addCreditHtml(c) {
    var def = c.rappel && c.rappel >= todayIso() ? c.rappel : addDays(todayIso(), 7);
    return '<div class="addbox"><p class="rappel">Le client prend un nouveau crédit : le montant est ajouté à son crédit actuel (total dû : <strong>' + nf(c.total) + ' FCFA</strong>, reste : <strong>' + nf(reste(c)) + ' FCFA</strong>).</p>' +
      '<div class="row-edit"><label>Montant du nouveau crédit (FCFA)<input id="ac-m-' + c.id + '" type="number" inputmode="decimal" min="0" step="any" placeholder="Ex. 25000"></label>' +
      '<label>Pour quoi ? (facultatif)<input id="ac-l-' + c.id + '" type="text" autocomplete="off" placeholder="Ex. Marchandise du 12 novembre"></label>' +
      '<label>Nouvelle date de rappel<input id="ac-d-' + c.id + '" type="date" value="' + def + '"></label></div>' +
      '<div class="pay"><button class="btn btn-primary btn-small" type="button" data-act="addyes" data-id="' + c.id + '">Ajouter au crédit</button>' +
      '<button class="btn btn-small" type="button" data-act="addno" data-id="' + c.id + '">Annuler</button></div></div>';
  }
  function cardHtml(c) {
    var st = status(c), r = reste(c), p = paid(c);
    var pct = c.total > 0 ? Math.min(100, Math.round(p / c.total * 100)) : 0;
    var open = !!openIds[c.id];
    var hasPiece = c.pieces && (c.pieces.recto || c.pieces.verso);
    var sub = [c.tel, c.note].filter(Boolean).map(esc).concat(hasPiece ? ["Pièce d'identité jointe"] : []).join(' · ');
    var hist = c.versements.length
      ? '<ul class="hist">' + c.versements.map(function (v, i) {
          return '<li><span class="d">' + fmtDate(v.date) + (v.label ? ' · ' + esc(v.label) : '') + '</span><span class="num">' + nf(v.montant) + ' FCFA</span>' +
            '<button class="link link-danger" type="button" data-act="rmv" data-id="' + c.id + '" data-i="' + i + '">Retirer</button></li>';
        }).join('') + '</ul>'
      : '<p class="rappel" style="margin-top:6px">Aucun versement pour le moment.</p>';
    var del = confirmDel === c.id
      ? '<span>Supprimer ce crédit définitivement ?</span><button class="btn btn-small btn-danger" type="button" data-act="delyes" data-id="' + c.id + '">Oui, supprimer</button><button class="btn btn-small" type="button" data-act="delno" data-id="' + c.id + '">Annuler</button>'
      : '<button class="link link-danger" type="button" data-act="del" data-id="' + c.id + '">Supprimer ce crédit</button>';
    return '<article class="credit" id="c-' + c.id + '">' +
      '<div class="credit-head"><div><h3>' + esc(c.nom) + '</h3>' + (sub ? '<p class="sub">' + sub + '</p>' : '') + '</div><span class="pill ' + st.k + '">' + st.t + '</span></div>' +
      '<dl class="figures"><div><dt>Total dû</dt><dd>' + nf(c.total) + '</dd></div><div><dt>Versé</dt><dd>' + nf(p) + '</dd></div><div class="rest"><dt>Reste à payer</dt><dd>' + nf(r) + '</dd></div></dl>' +
      '<div class="bar" role="progressbar" aria-label="Part déjà payée" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      (r > 0 ? '<p class="rappel">Rappel de recouvrement : <strong>' + fmtDate(c.rappel) + '</strong></p>' : '') +
      (r > 0 ? '<div class="pay"><input id="p-' + c.id + '" type="number" inputmode="decimal" min="0" step="any" placeholder="Montant reçu" aria-label="Montant du versement de ' + esc(c.nom) + '" data-pay="' + c.id + '">' +
        '<button class="btn btn-primary btn-small" type="button" data-act="pay" data-id="' + c.id + '">Enregistrer le versement</button>' +
        '<button class="btn btn-small" type="button" data-act="settle" data-id="' + c.id + '">Tout solder</button></div>' : '') +
      '<div class="send-row"><button class="btn btn-small btn-wa" type="button" data-act="stmt" data-id="' + c.id + '">Envoyer le point par WhatsApp</button>' +
        '<button class="btn btn-small" type="button" data-act="addcredit" data-id="' + c.id + '" aria-expanded="' + !!addOpen[c.id] + '">Ajouter un crédit</button></div>' +
      (addOpen[c.id] ? addCreditHtml(c) : '') +
      '<button class="link toggle" type="button" data-act="toggle" data-id="' + c.id + '" aria-expanded="' + open + '">' + (open ? 'Masquer les détails' : 'Historique et réglages') + '</button>' +
      '<div class="details"' + (open ? '' : ' hidden') + '>' +
        (c.ajouts.length ? '<div><h4>Crédits</h4><ul class="hist"><li><span class="d">Crédit initial' + (c.createdAt ? ' · ' + fmtDate(c.createdAt) : '') + '</span><span class="num">' + nf(initialAmount(c)) + ' FCFA</span></li>' +
          c.ajouts.map(function (a, i) { return '<li><span class="d">' + fmtDate(a.date) + (a.label ? ' · ' + esc(a.label) : ' · Crédit ajouté') + '</span><span class="num">+ ' + nf(a.montant) + ' FCFA</span><button class="link link-danger" type="button" data-act="rmaj" data-id="' + c.id + '" data-i="' + i + '">Retirer</button></li>'; }).join('') + '</ul></div>' : '') +
        '<div><h4>Versements reçus</h4>' + hist + '</div>' +
        '<div><h4>Pièce d\'identité</h4><div class="pieces" id="pc-' + c.id + '">' + piecesHtml(c) + '</div></div>' +
        '<div class="row-edit"><label>Date de rappel<input id="rd-' + c.id + '" type="date" value="' + c.rappel + '"></label>' +
        '<button class="btn btn-small" type="button" data-act="setdate" data-id="' + c.id + '">Modifier la date</button>' +
        '<button class="btn btn-small" type="button" data-act="delay" data-id="' + c.id + '">Reporter de 7 jours</button></div>' +
        '<div class="danger">' + del + '</div>' +
      '</div></article>';
  }

  function renderList() {
    var box = $('#list');
    if (loadError) { box.innerHTML = '<div class="empty"><h3>Vos crédits sont momentanément inaccessibles</h3><p>Rechargez la page dans un instant. Vos données ne sont pas perdues.</p></div>'; return; }
    if (!loaded) { box.innerHTML = '<div class="empty"><p>Chargement de vos crédits…</p></div>'; return; }
    if (!credits.length) {
      box.innerHTML = '<div class="empty"><h3>Aucun crédit enregistré</h3><p>Ajoutez un client avec le montant dû, l\'avance reçue et la date à laquelle vous voulez être prévenu. Le jour venu, une alerte vous indique qui encaisser et combien.</p>' +
        '<div class="acts"><button class="btn btn-primary" type="button" data-act="newform">Ajouter mon premier crédit</button><button class="btn" type="button" data-act="sample">Voir un exemple</button></div></div>';
      return;
    }
    var q = query.trim().toLowerCase();
    var rows = credits.filter(function (c) {
      if (filter === 'due' && !isDue(c)) return false;
      if (filter === 'paid' && reste(c) > 0) return false;
      if (q && c.nom.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var ra = reste(a) > 0, rb = reste(b) > 0;
      if (ra !== rb) return ra ? -1 : 1;
      if (ra) return a.rappel < b.rappel ? -1 : a.rappel > b.rappel ? 1 : 0;
      return a.nom.localeCompare(b.nom, 'fr');
    });
    if (!rows.length) { box.innerHTML = '<div class="empty"><p>Aucun dossier ne correspond à ce filtre.</p></div>'; return; }
    box.innerHTML = rows.map(cardHtml).join('');
    hydratePieces();
  }

  function renderFoot() {
    var lines = [];
    if (mode === 'cloud') lines.push("Vos données sont enregistrées sur cet appareil, dans ce navigateur.");
    if (window.SCreditsStore && window.SCreditsStore.persistent === false) lines.push("Attention : ce navigateur n'enregistre pas durablement. Vos données seront perdues à la fermeture.");
    else if (mode === 'local') lines.push("Vos données sont enregistrées sur cet appareil seulement.");
    if (slow) lines.push("Connexion lente : les montants affichés peuvent ne pas être à jour.");
    lines.push("Les alertes s'affichent à l'ouverture de l'application et pendant qu'elle reste ouverte.");
    $('#foot').innerHTML = lines.map(function (l) { return '<p>' + l + '</p>'; }).join('');
  }

  function render() { renderSummary(); renderAlerts(); renderList(); renderFoot(); }

  /* Alerte à l'échéance */
  function showOverlay(dues) {
    var ov = $('#overlay');
    $('#dialog').className = 'dialog';
    $('#dialog').innerHTML = '<h2 id="ovTitle">Rappel de recouvrement</h2><ul>' + dues.map(function (c) {
      return '<li>Il faut encaisser <strong>' + esc(c.nom) + '</strong> : il doit <strong class="num">' + nf(reste(c)) + ' FCFA</strong>.</li>';
    }).join('') + '</ul><div class="acts"><button class="btn" type="button" data-act="ovclose">Fermer</button><button class="btn btn-primary" type="button" data-act="ovview" id="ovMain">Voir les dossiers</button></div>';
    ov.hidden = false;
    var b = $('#ovMain'); if (b) b.focus();
  }
  function closeOverlay() { $('#overlay').hidden = true; }
  function checkDue() {
    if (!loaded || loadError || lstate !== 'ok') return;
    var dues = credits.filter(isDue);
    var fresh = dues.filter(function (c) { return !alerted[c.id + '|' + c.rappel]; });
    if (!fresh.length) return;
    dues.forEach(function (c) { alerted[c.id + '|' + c.rappel] = true; });
    showOverlay(dues);
  }

  /* Relevé de compte à envoyer au client (WhatsApp) */
  var stmtId = null;
  var SENDER_KEY = 'scredits.expediteur';
  function getSender() { try { return localStorage.getItem(SENDER_KEY) || ''; } catch (e) { return ''; } }
  function setSender(v) { try { localStorage.setItem(SENDER_KEY, v); } catch (e) { /* ignoré */ } }
  function plain(t) { return String(t).replace(/[\u202f\u00a0]/g, ' '); }
  function money(n) { return plain(nf(n)) + ' FCFA'; }
  function waPhone(tel) {
    var raw = String(tel || '').trim(), d = raw.replace(/\D/g, '');
    if (!d) return '';
    if (raw.charAt(0) === '+') return d;
    if (d.slice(0, 2) === '00') return d.slice(2);
    if (d.length === 10 || d.length === 8) return '225' + d;
    if (d.length >= 11) return d;
    return '';
  }
  function sortedPays(c) {
    return c.versements.map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) {
      return a.v.date < b.v.date ? -1 : a.v.date > b.v.date ? 1 : a.i - b.i;
    }).map(function (x) { return x.v; });
  }
  function statementText(c, sender) {
    var r = reste(c), pays = sortedPays(c), L = [];
    L.push('*RELEVÉ DE COMPTE*');
    L.push('');
    L.push('Bonjour ' + c.nom + ',');
    L.push('Voici le point de votre crédit au ' + fmtDate(todayIso()) + '.');
    L.push('');
    if (c.ajouts && c.ajouts.length) {
      L.push('*Détail des crédits :*');
      L.push('1. ' + (c.createdAt ? fmtDate(c.createdAt) + ' : ' : '') + money(initialAmount(c)) + ' (crédit initial)');
      c.ajouts.forEach(function (a, i) { L.push((i + 2) + '. ' + fmtDate(a.date) + ' : ' + money(a.montant) + (a.label ? ' (' + a.label + ')' : '')); });
      L.push('');
    }
    L.push('*Montant total dû :* ' + money(c.total));
    L.push('');
    if (pays.length) {
      L.push('*Versements reçus :*');
      pays.forEach(function (v, i) { L.push((i + 1) + '. ' + fmtDate(v.date) + ' : ' + money(v.montant) + (v.label ? ' (' + v.label + ')' : '')); });
      L.push('*Total versé :* ' + money(paid(c)));
    } else {
      L.push('Aucun versement reçu pour le moment.');
    }
    L.push('');
    if (r > 0) {
      L.push('*RESTE À PAYER : ' + money(r) + '*');
      if (c.rappel) L.push('Date de règlement prévue : ' + fmtDate(c.rappel));
    } else {
      L.push('*Crédit entièrement soldé. Reste à payer : 0 FCFA*');
    }
    L.push('');
    L.push('Merci de votre confiance.');
    if (sender) L.push('— ' + sender);
    return L.join('\n');
  }
  function fitText(ctx, t, maxW) {
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function drawStatement(cv, c, sender) {
    var W = 720, P = 40, SC = 2, FONT = '"IBM Plex Sans","Segoe UI",system-ui,sans-serif';
    var pays = sortedPays(c), r = reste(c);
    var nAj = (c.ajouts || []).length;
    var H = 524 + 46 * (Math.max(pays.length, 1) + 1) + (nAj ? 46 * (nAj + 1) : 0);
    cv.width = W * SC; cv.height = H * SC;
    var x = cv.getContext('2d');
    x.scale(SC, SC);
    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#0A6A5A'; x.fillRect(0, 0, W, 104);
    x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    x.fillStyle = '#FFFFFF'; x.font = '700 30px ' + FONT; x.fillText('RELEVÉ DE COMPTE', P, 52);
    x.font = '400 17px ' + FONT; x.fillStyle = '#DDF0EB';
    x.fillText(fitText(x, sender || 'Point sur votre crédit', W - 2 * P), P, 80);
    var y = 148;
    x.fillStyle = '#586B66'; x.font = '400 14px ' + FONT; x.fillText('CLIENT', P, y);
    x.textAlign = 'right'; x.fillText('DATE DU RELEVÉ', W - P, y); x.textAlign = 'left';
    y += 32;
    x.fillStyle = '#13201D'; x.font = '700 28px ' + FONT; x.fillText(fitText(x, c.nom, 400), P, y);
    x.textAlign = 'right'; x.font = '600 18px ' + FONT; x.fillText(fmtDate(todayIso()), W - P, y); x.textAlign = 'left';
    y += 28;
    x.fillStyle = '#586B66'; x.font = '400 16px ' + FONT;
    if (c.tel) x.fillText(fitText(x, c.tel, 400), P, y);
    y += 40;
    x.fillStyle = '#F4F7F6'; x.fillRect(P, y, W - 2 * P, 38);
    x.fillStyle = '#586B66'; x.font = '600 14px ' + FONT;
    x.fillText('DATE', P + 12, y + 25); x.fillText('DÉTAIL', P + 270, y + 25);
    x.textAlign = 'right'; x.fillText('MONTANT', W - P - 12, y + 25); x.textAlign = 'left';
    y += 38;
    function row(date, label, amount, bold) {
      x.fillStyle = '#13201D'; x.font = (bold ? '700 ' : '400 ') + '18px ' + FONT;
      x.fillText(date, P + 12, y + 30);
      x.fillText(fitText(x, label, 190), P + 270, y + 30);
      x.textAlign = 'right'; x.fillText(amount, W - P - 12, y + 30); x.textAlign = 'left';
      y += 46;
      x.fillStyle = '#D3DCD9'; x.fillRect(P, y - 1, W - 2 * P, 1);
    }
    if (nAj) {
      row(c.createdAt ? fmtDate(c.createdAt) : '', 'Crédit initial', money(initialAmount(c)), false);
      c.ajouts.forEach(function (a) { row(fmtDate(a.date), a.label || 'Crédit ajouté', '+ ' + money(a.montant), false); });
      row('', 'Montant total dû', money(c.total), true);
    } else row(c.createdAt ? fmtDate(c.createdAt) : '', 'Montant total dû', money(c.total), true);
    pays.forEach(function (v) { row(fmtDate(v.date), v.label || 'Versement reçu', money(v.montant), false); });
    if (!pays.length) {
      x.fillStyle = '#586B66'; x.font = 'italic 400 16px ' + FONT; x.fillText('Aucun versement pour le moment.', P + 12, y + 28); y += 46;
    }
    y += 22;
    x.textAlign = 'right';
    x.fillStyle = '#586B66'; x.font = '400 17px ' + FONT; x.fillText('Total versé', W - P - 260, y);
    x.fillStyle = '#13201D'; x.font = '600 20px ' + FONT; x.fillText(money(paid(c)), W - P, y);
    y += 20;
    var boxCol = r > 0 ? '#FBE4E1' : '#E0F3E6', txtCol = r > 0 ? '#A8231A' : '#1B6F3A';
    x.fillStyle = boxCol; x.fillRect(P, y, W - 2 * P, 78);
    x.textAlign = 'left'; x.fillStyle = txtCol; x.font = '700 18px ' + FONT; x.fillText(r > 0 ? 'RESTE À PAYER' : 'CRÉDIT SOLDÉ', P + 18, y + 46);
    x.textAlign = 'right'; x.font = '700 32px ' + FONT; x.fillText(money(r), W - P - 18, y + 49);
    y += 78 + 34;
    x.textAlign = 'left'; x.fillStyle = '#13201D'; x.font = '400 17px ' + FONT;
    if (r > 0 && c.rappel) x.fillText('Date de règlement prévue : ' + fmtDate(c.rappel), P, y);
    y += 30;
    x.fillStyle = '#586B66'; x.font = 'italic 400 16px ' + FONT; x.fillText('Merci de votre confiance.', P, y);
  }
  function refreshStatement() {
    var c = find(stmtId), cv = document.getElementById('stCanvas');
    if (!c || !cv) return;
    var sender = ($('#stSender') || {}).value || '';
    sender = sender.trim();
    drawStatement(cv, c, sender);
    var num = waPhone(c.tel);
    var a = $('#stWa');
    a.href = 'https://wa.me/' + num + '?text=' + encodeURIComponent(statementText(c, sender));
    $('#stHint').textContent = num ? 'Le message partira vers le +' + num + '.' : 'Aucun numéro valide enregistré pour ce client : WhatsApp vous laissera choisir le contact.';
  }
  function showStatement(c) {
    stmtId = c.id;
    var d = $('#dialog');
    d.className = 'dialog stmt';
    d.innerHTML = '<h2 id="ovTitle">Point à envoyer à ' + esc(c.nom) + '</h2>' +
      '<canvas id="stCanvas" class="st-canvas" role="img" aria-label="Aperçu du relevé de ' + esc(c.nom) + '"></canvas>' +
      '<label class="st-field">Votre nom ou celui de votre boutique (facultatif)<input id="stSender" type="text" maxlength="60" autocomplete="off" value="' + esc(getSender()) + '"></label>' +
      '<p class="hint" id="stHint"></p>' +
      '<div class="acts"><button class="btn" type="button" data-act="ovclose">Fermer</button>' +
      '<button class="btn" type="button" data-act="stcopy" data-id="' + c.id + '">Copier le texte</button>' +
      '<button class="btn" type="button" data-act="stshare" data-id="' + c.id + '">Partager l\'image</button>' +
      '<a class="btn btn-wa" id="stWa" target="_blank" rel="noopener">Envoyer sur WhatsApp</a></div>';
    $('#overlay').hidden = false;
    refreshStatement();
  }
  function copyLegacy(t) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var okc = false; try { okc = document.execCommand('copy'); } catch (e) { okc = false; }
      document.body.removeChild(ta); okc ? resolve() : reject(new Error('copy'));
    });
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(function () { return copyLegacy(t); });
    }
    return copyLegacy(t);
  }
  function waUrl(c, sender) {
    return 'https://wa.me/' + waPhone(c.tel) + '?text=' + encodeURIComponent(statementText(c, sender));
  }
  function openLink(url) {
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function shareImage(c) {
    var cv = document.getElementById('stCanvas'); if (!cv) return;
    var sender = (($('#stSender') || {}).value || '').trim();
    var fname = 'releve-' + c.nom.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.png';
    var cap = window.Capacitor, CP = cap && cap.Plugins;
    var native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    if (native) {
      /* Application Android : image + texte via le partage natif (modules @capacitor/share et @capacitor/filesystem) */
      if (CP && CP.Share && CP.Filesystem) {
        var b64 = cv.toDataURL('image/png').split(',')[1];
        CP.Filesystem.writeFile({ path: fname, data: b64, directory: 'CACHE' }).then(function (r) {
          return CP.Share.share({ title: 'Relevé de compte', text: statementText(c, sender), files: [r.uri], dialogTitle: 'Envoyer le point' });
        }).catch(function (e) {
          var m = String((e && e.message) || e || '');
          if (/cancel/i.test(m)) return;
          toast('Partage impossible : le point est envoyé en texte.');
          openLink(waUrl(c, sender));
        });
      } else {
        toast("Image non disponible dans cette version : le point est envoyé en texte sur WhatsApp.");
        openLink(waUrl(c, sender));
      }
      return;
    }
    cv.toBlob(function (blob) {
      if (!blob) { toast("Impossible de créer l'image."); return; }
      var file = null;
      try { file = new File([blob], fname, { type: 'image/png' }); } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], text: statementText(c, sender) }).catch(function (e) {
          if (!e || e.name !== 'AbortError') toast("Le partage a échoué. Utilisez « Envoyer sur WhatsApp ».");
        });
        return;
      }
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast("Image enregistrée sur l'appareil : joignez-la dans WhatsApp.");
    }, 'image/png');
  }

  /* Actions sur la liste */
  function find(id) { return credits.find(function (x) { return x.id === id; }); }
  function onAction(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.dataset.act, id = b.dataset.id;
    if (act === 'zoom') { b.classList.toggle('big'); return; }
    var orig = id ? find(id) : null;
    var c = orig ? clone(orig) : null;
    if (act === 'newform') { openForm(true); return; }
    if (act === 'sample') {
      commit({ id: newId(), nom: 'Exemple : Awa Traoré', tel: '', note: 'Exemple à supprimer', total: 250000, rappel: todayIso(), createdAt: todayIso(), versements: [{ date: todayIso(), montant: 100000, label: 'Avance' }] });
      return;
    }
    if (act === 'ovclose') { closeOverlay(); return; }
    if (act === 'ovview') { closeOverlay(); var a = $('#alerts'); if (!a.hidden) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (!c) return;
    if (act === 'stmt') { showStatement(c); return; }
    if (act === 'stcopy') {
      var snd = (($('#stSender') || {}).value || '').trim();
      copyText(statementText(c, snd)).then(function () { toast('Texte copié'); }, function () { toast('Copie impossible sur cet appareil.'); });
      return;
    }
    if (act === 'stshare') { shareImage(c); return; }
    if (act === 'view') { openIds[id] = true; render(); var el = document.getElementById('c-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'toggle') { openIds[id] = !openIds[id]; if (!openIds[id]) confirmDel = null; render(); return; }
    if (act === 'pay') {
      var inp = document.getElementById('p-' + id);
      var m = round2(Number(inp && inp.value));
      if (!(m > 0)) { toast('Saisissez le montant reçu.'); return; }
      if (m > reste(c)) { toast('Ce versement dépasse le reste à payer (' + nf(reste(c)) + ' FCFA).'); return; }
      c.versements.push({ date: todayIso(), montant: m });
      commit(c); toast('Versement enregistré'); return;
    }
    if (act === 'settle') {
      c.versements.push({ date: todayIso(), montant: reste(c), label: 'Solde' });
      commit(c); toast('Crédit soldé'); return;
    }
    if (act === 'rmpiece') {
      var side = b.dataset.side;
      pieceDelete(id, side).then(function () {
        c.pieces = c.pieces || {}; c.pieces[side] = false; commit(c); toast('Photo retirée');
      }).catch(function () { toast('Impossible de retirer la photo. Réessayez.'); });
      return;
    }
    if (act === 'addcredit') { addOpen[id] = !addOpen[id]; render(); if (addOpen[id]) { var mi = document.getElementById('ac-m-' + id); if (mi) mi.focus(); } return; }
    if (act === 'addno') { delete addOpen[id]; render(); return; }
    if (act === 'addyes') {
      var am = round2(Number((document.getElementById('ac-m-' + id) || {}).value));
      var al = ((document.getElementById('ac-l-' + id) || {}).value || '').trim();
      var ad = (document.getElementById('ac-d-' + id) || {}).value;
      if (!(am > 0)) { toast('Saisissez le montant du nouveau crédit.'); return; }
      if (!ad) { toast('Choisissez la nouvelle date de rappel.'); return; }
      c.total = round2(c.total + am);
      c.ajouts.push({ date: todayIso(), montant: am, label: al });
      c.rappel = ad;
      delete addOpen[id]; openIds[id] = true;
      commit(c); toast('Crédit ajouté. Nouveau reste à payer : ' + nf(reste(c)) + ' FCFA'); return;
    }
    if (act === 'rmaj') {
      var ai = Number(b.dataset.i), ao = c.ajouts[ai];
      if (!ao) return;
      if (round2(c.total - ao.montant) < paid(c)) { toast('Impossible : les versements reçus dépassent le total une fois ce crédit retiré. Retirez d\'abord un versement.'); return; }
      c.total = round2(c.total - ao.montant); c.ajouts.splice(ai, 1);
      commit(c); toast('Crédit retiré du total'); return;
    }
    if (act === 'rmv') { c.versements.splice(Number(b.dataset.i), 1); commit(c); toast('Versement retiré'); return; }
    if (act === 'delay') { c.rappel = addDays(todayIso(), 7); commit(c); toast('Rappel reporté au ' + fmtDate(c.rappel)); return; }
    if (act === 'setdate') {
      var v = document.getElementById('rd-' + id).value;
      if (!v) { toast('Choisissez une date.'); return; }
      c.rappel = v; commit(c); toast('Date de rappel modifiée'); return;
    }
    if (act === 'del') { confirmDel = id; render(); return; }
    if (act === 'delno') { confirmDel = null; render(); return; }
    if (act === 'delyes') {
      confirmDel = null; delete openIds[id];
      SIDES.forEach(function (sd) { if (c.pieces && c.pieces[sd[0]]) pieceDelete(id, sd[0]).catch(function () {}); });
      drop(id); toast('Crédit supprimé'); return;
    }
  }
  $('#list').addEventListener('click', onAction);
  $('#alerts').addEventListener('click', onAction);
  $('#overlay').addEventListener('click', function (e) { if (e.target.id === 'overlay') closeOverlay(); else onAction(e); });
  $('#list').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.pay) {
      e.preventDefault();
      var btn = document.querySelector('[data-act="pay"][data-id="' + e.target.dataset.pay + '"]');
      if (btn) btn.click();
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#overlay').hidden) closeOverlay(); });
  $('#dialog').addEventListener('input', function (e) {
    if (e.target && e.target.id === 'stSender') { setSender(e.target.value.trim()); refreshStatement(); }
  });

  $('#list').addEventListener('change', async function (e) {
    var t = e.target;
    if (!t.dataset || !t.dataset.file) return;
    var parts = t.dataset.file.split('|'), id = parts[0], side = parts[1];
    var file = t.files && t.files[0];
    var orig = find(id);
    if (!file || !orig) return;
    try {
      var data = await compress(file);
      await pieceSave(id, side, data);
      var c = clone(find(id) || orig);
      c.pieces = c.pieces || {}; c.pieces[side] = true;
      commit(c); toast('Photo enregistrée');
    } catch (err) {
      toast(err && err.message === 'type' ? 'Choisissez une image (photo ou scan).' : "Impossible d'enregistrer cette photo.");
    }
  });

  /* Filtres et recherche */
  $('#filters').addEventListener('click', function (e) {
    var b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    document.querySelectorAll('#filters .chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderList();
  });
  $('#search').addEventListener('input', function (e) { query = e.target.value; renderList(); });

  /* Formulaire */
  function openForm(open) {
    $('#formPanel').hidden = !open;
    $('#btnNew').setAttribute('aria-expanded', String(open));
    if (open) { $('#fNom').focus(); $('#formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  function hideDup() { var d = $('#dupBox'); d.hidden = true; d.innerHTML = ''; }
  function showDup(c) {
    var d = $('#dupBox');
    d.innerHTML = '<p><strong>' + esc(c.nom) + '</strong> a déjà un crédit' + (reste(c) > 0 ? ' en cours : reste <strong>' + nf(reste(c)) + ' FCFA</strong> à payer.' : ' (soldé).') +
      ' Voulez-vous ajouter ce nouveau montant à son crédit pour avoir un seul montant dû global ?</p>' +
      '<div class="pay"><button class="btn btn-primary btn-small" type="button" data-dup="merge">Ajouter à son crédit</button>' +
      '<button class="btn btn-small" type="button" data-dup="separate">Créer un crédit séparé</button>' +
      '<button class="btn btn-small" type="button" data-dup="cancel">Annuler</button></div>';
    d.hidden = false;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('#dupBox').addEventListener('click', function (e) {
    var b = e.target.closest('[data-dup]'); if (!b) return;
    if (b.dataset.dup === 'cancel') { dupChoice = null; hideDup(); return; }
    dupChoice = b.dataset.dup;
    $('#form button[type="submit"]').click();
  });
  $('#fNom').addEventListener('input', function () { dupChoice = null; hideDup(); });
  $('#fTel').addEventListener('input', function () { dupChoice = null; hideDup(); });
  $('#btnNew').addEventListener('click', function () { openForm($('#formPanel').hidden); });
  $('#btnCancel').addEventListener('click', function () { dupChoice = null; hideDup(); $('#form').reset(); updateLive(); $('#formError').textContent = ''; openForm(false); });
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { $('#fRappel').value = addDays(todayIso(), Number(b.dataset.add)); });
  });
  function updateLive() {
    var t = Number($('#fTotal').value) || 0, a = Number($('#fAvance').value) || 0;
    $('#liveReste').textContent = nf(Math.max(0, round2(t - a))) + ' FCFA';
  }
  $('#fTotal').addEventListener('input', updateLive);
  $('#fAvance').addEventListener('input', updateLive);
  $('#form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('#formError');
    var nom = $('#fNom').value.trim();
    var total = round2(Number($('#fTotal').value));
    var avance = round2(Number($('#fAvance').value) || 0);
    var rappel = $('#fRappel').value;
    if (!nom) { err.textContent = 'Indiquez le nom du client.'; $('#fNom').focus(); return; }
    if (!(total > 0)) { err.textContent = 'Indiquez le montant total dû.'; $('#fTotal').focus(); return; }
    if (avance < 0 || avance > total) { err.textContent = "L'avance ne peut pas dépasser le montant total dû."; $('#fAvance').focus(); return; }
    if (!rappel) { err.textContent = 'Choisissez la date de rappel de recouvrement.'; $('#fRappel').focus(); return; }
    err.textContent = '';
    var telVal = $('#fTel').value.trim();
    var dup = credits.filter(function (x) { return sameClient({ nom: nom, tel: telVal }, x); }).sort(function (a, b) { return reste(b) - reste(a); })[0];
    if (dup && !dupChoice) { showDup(dup); return; }
    var choice = dupChoice; dupChoice = null; hideDup();
    var sbtn = $('#form button[type="submit"]');
    sbtn.disabled = true;
    if (choice === 'merge' && dup) {
      var mg = clone(dup);
      mg.total = round2(mg.total + total);
      mg.ajouts.push({ date: todayIso(), montant: total, label: $('#fNote').value.trim() });
      if (avance > 0) mg.versements.push({ date: todayIso(), montant: avance, label: 'Avance' });
      mg.rappel = rappel;
      if (!mg.tel && telVal) mg.tel = telVal;
      mg.pieces = mg.pieces || { recto: false, verso: false };
      var mfiles = { recto: $('#fRecto').files[0], verso: $('#fVerso').files[0] };
      for (var k = 0; k < SIDES.length; k++) {
        var sd = SIDES[k][0];
        if (!mfiles[sd] || mg.pieces[sd]) continue;
        try { await pieceSave(mg.id, sd, await compress(mfiles[sd])); mg.pieces[sd] = true; }
        catch (ex2) { toast("La photo (" + SIDES[k][1].toLowerCase() + ") n'a pas pu être enregistrée."); }
      }
      openIds[mg.id] = true;
      commit(mg);
      sbtn.disabled = false;
      $('#form').reset(); updateLive(); openForm(false);
      toast('Ajouté au crédit de ' + mg.nom + '. Reste à payer : ' + nf(reste(mg)) + ' FCFA');
      return;
    }
    var cid = newId();
    var pieces = { recto: false, verso: false };
    var files = { recto: $('#fRecto').files[0], verso: $('#fVerso').files[0] };
    for (var i = 0; i < SIDES.length; i++) {
      var side = SIDES[i][0];
      if (!files[side]) continue;
      try { await pieceSave(cid, side, await compress(files[side])); pieces[side] = true; }
      catch (ex) { toast("La photo (" + SIDES[i][1].toLowerCase() + ") n'a pas pu être enregistrée. Vous pourrez la rajouter ensuite."); }
    }
    commit({
      id: cid, nom: nom, tel: $('#fTel').value.trim(), note: $('#fNote').value.trim(),
      total: total, rappel: rappel, createdAt: todayIso(), pieces: pieces,
      versements: avance > 0 ? [{ date: todayIso(), montant: avance, label: 'Avance' }] : []
    });
    sbtn.disabled = false;
    $('#form').reset(); updateLive(); openForm(false);
    toast('Crédit enregistré');
  });

  /* Logo : anneau orange, étoile verte et S central */
  var LOGO_PNG = 'icons/logo-ring.png';
  var LOGO_S = 'M42 210H224Q228 171 251.0 150.5Q274 130 311 130Q349 130 371.0 147.5Q393 165 393 196Q393 222 375.5 239.0Q358 256 332.5 267.0Q307 278 260 292Q192 313 149.0 334.0Q106 355 75.0 396.0Q44 437 44 503Q44 601 115.0 656.5Q186 712 300 712Q416 712 487.0 656.5Q558 601 563 502H378Q376 536 353.0 555.5Q330 575 294 575Q263 575 244.0 558.5Q225 542 225 511Q225 477 257.0 458.0Q289 439 357 417Q425 394 467.5 373.0Q510 352 541.0 312.0Q572 272 572 209Q572 149 541.5 100.0Q511 51 453.0 22.0Q395 -7 316 -7Q239 -7 178.0 18.0Q117 43 80.5 92.0Q44 141 42 210Z';
  function logoSvg(size) {
    return '<svg class="logo" xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 400 400" role="img" aria-label="Logo S crédits">' +
      '<image href="' + LOGO_PNG + '" x="0" y="0" width="400" height="400"/>' +
      '<path class="logo-s" transform="translate(124.95 286.05) scale(0.24478 -0.24478)" d="' + LOGO_S + '"/></svg>';
  }

  /* Licence et espace administrateur */
  var DEFAULT_HASH = '95f675058ac079e6a7be4f2129e460f984eb57ce01a9ae5a310dfaf3b6224adc';
  var dbRef = null, isOwner = false;
  var license = null, licenseKnown = false, licFailed = false, lstate = 'loading', prevState = '';
  var adStep = 'code', adFails = 0, adLockUntil = 0;

  function evalLicense() {
    if (!licenseKnown) return licFailed ? 'unverifiable' : 'loading';
    if (!license || !license.expiresAt) return 'none';
    return todayIso() <= license.expiresAt ? 'ok' : 'expired';
  }
  function daysLeft() { return daysBetween(todayIso(), license.expiresAt); }
  function contactTxt() { return license && license.contact ? ' : <strong>' + esc(license.contact) + '</strong>' : ''; }

  function renderLicBar() {
    var el = $('#licBanner');
    if (!license || !license.expiresAt) { el.hidden = true; return; }
    var n = daysLeft();
    if (n > 7) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = 'Votre licence expire le <strong>' + fmtDate(license.expiresAt) + '</strong> (' + (n === 0 ? "aujourd'hui" : 'dans ' + n + (n === 1 ? ' jour' : ' jours')) + "). Pour la prolonger, contactez l'administrateur" + contactTxt() + '.';
  }
  function renderLock() {
    var h;
    if (lstate === 'loading') h = '<p>Vérification de la licence…</p>';
    else if (lstate === 'unverifiable') h = "<h2>Licence non vérifiée</h2><p>Impossible de lire la licence enregistrée sur cet appareil. Rechargez la page. Si le problème continue, contactez l'administrateur.</p>";
    else if (lstate === 'none') h = "<h2>Licence non activée</h2><p>Cette application n'est pas encore activée. Contactez l'administrateur pour obtenir votre accès" + contactTxt() + '.</p>';
    else h = "<h2>Votre licence a expiré</h2><p>Votre durée d'utilisation est arrivée à son terme le <strong>" + fmtDate(license.expiresAt) + "</strong>. Pour continuer à utiliser S crédits, contactez l'administrateur afin de relancer le délai" + contactTxt() + '.</p><p class="muted">Vos crédits et vos pièces d\'identité sont conservés. Ils reviendront dès que la licence sera renouvelée.</p>';
    if (CFG.contact && (lstate === 'none' || lstate === 'expired')) {
      var buy = lstate === 'none' ? 'Acheter' : 'Renouveler';
      var wa = 'https://wa.me/' + digits(CFG.contact) + '?text=' + encodeURIComponent('Bonjour, je souhaite ' + buy.toLowerCase() + ' S crédits (' + money(CFG.prix) + ' pour ' + joursTxt() + ').' + (profile && profile.code ? ' Mon code parrain : ' + profile.code : ''));
      h += '<a class="btn btn-wa" target="_blank" rel="noopener" href="' + wa + '">' + buy + ' pour ' + money(CFG.prix) + ' (WhatsApp)</a>';
    }
    if (CFG.serveur && (lstate === 'none' || lstate === 'expired')) h += raHtml();
    if (syncOn() && (lstate === 'none' || lstate === 'expired')) h += '<button class="btn" type="button" data-sy="open" data-v="login">J\'ai déjà un compte de sauvegarde : me connecter</button>';
    if (isOwner && lstate !== 'loading') h += '<button class="btn" type="button" data-adm="open">Espace administrateur</button>';
    $('#lock').innerHTML = '<div class="lock-card"><div class="lockup lock-brand">' + logoSvg(96) + '<span class="wordmark" aria-hidden="true">crédits</span></div>' + h + '</div>';
  }
  function applyGate() {
    lstate = evalLicense();
    var ok = lstate === 'ok';
    $('#app').hidden = !ok;
    $('#lock').hidden = ok;
    if (!ok) { if (!$('#overlay').hidden) closeOverlay(); renderLock(); }
    else {
      renderLicBar();
      if (prevState !== 'ok' && loaded) { render(); checkDue(); }
    }
    $('#btnAdmin').hidden = !(ok && isOwner);
    $('#btnSync').hidden = !(ok && syncOn());
    $('#btnExport').hidden = !ok;
    if (ok && prevState !== 'ok' && !$('#syncOv').hidden) closeSync();
    renderParrainBtn();
    if (!$('#adminOv').hidden) updateAdStatus();
    prevState = lstate;
  }
  function watchLicense(db) {
    var t = setTimeout(function () { if (!licenseKnown) { licFailed = true; applyGate(); } }, 10000);
    db.doc('license/main').onSnapshot(function (s) {
      if (!s.exists && s.metadata.fromCache) return;
      license = s.exists ? s.data() : null;
      licenseKnown = true; licFailed = false;
      clearTimeout(t);
      applyGate();
      setTimeout(function () { if (typeof syncLicence === 'function') syncLicence(); }, 1500);
    }, function () { licFailed = true; applyGate(); });
  }

  /* SHA-256 de secours pour les pages ouvertes sans HTTPS (ex. test en réseau local) */
  function sha256Fallback(msg) {
    var utf8 = unescape(encodeURIComponent(msg)), bytes = [], i;
    for (i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    var K = [], H = [], primes = [], n = 2;
    while (primes.length < 64) {
      var isP = true;
      for (var q = 0; q < primes.length && primes[q] * primes[q] <= n; q++) { if (n % primes[q] === 0) { isP = false; break; } }
      if (isP) primes.push(n);
      n++;
    }
    for (i = 0; i < 64; i++) K[i] = Math.floor((Math.cbrt(primes[i]) % 1) * 4294967296) >>> 0;
    for (i = 0; i < 8; i++) H[i] = Math.floor((Math.sqrt(primes[i]) % 1) * 4294967296) >>> 0;
    var l = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(l / 4294967296), lo = l >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    function rotr(x, k) { return (x >>> k) | (x << (32 - k)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var w = [];
      for (i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  async function sha(s) {
    if (!(window.crypto && window.crypto.subtle)) return sha256Fallback(s);
    var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  async function verifyCode(code) {
    var pin = null;
    try { var s = await dbRef.doc('admin/pin').get(); if (s.exists) pin = s.data(); } catch (e) { pin = null; }
    if (pin && pin.hash && pin.salt) return (await sha(pin.salt + code)) === pin.hash;
    return (await sha('carnet:' + code)) === DEFAULT_HASH;
  }
  async function writeLicense(patch) {
    var next = Object.assign({}, license || {}, patch, { updatedAt: new Date().toISOString() });
    try {
      await dbRef.doc('license/main').set(next);
      license = next; licenseKnown = true; applyGate();
      toast('Licence mise à jour');
      return true;
    } catch (e) { toast("Modification impossible. Réessayez."); return false; }
  }
  function baseDate() {
    var t = todayIso();
    return license && license.expiresAt && license.expiresAt > t ? license.expiresAt : t;
  }

  /* Vente, parrainage et commissions */
  var CFG = (function () {
    var d = { prix: 5000, commission: 1000, jours: 365, serveur: '', contact: '' };
    var u = window.SCREDITS_CONFIG || {};
    Object.keys(u).forEach(function (k) { d[k] = u[k]; });
    return d;
  })();
  var profile = null, adSale = null, adBusy = false, adminCodeMem = '';
  var parState = { data: null, at: '', erreur: '' };
  var PAR_KEY = 'scredits.parrainage';
  var CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-Z]{3}-[A-HJ-NP-Z2-9]{4}$/;
  var SRV_ERR = {
    non_autorise: "Le serveur refuse le code administrateur : il doit être identique dans le script Google (CODE_ADMIN).",
    parrain_inconnu: "Ce code parrain n'existe pas. Vérifiez-le ou laissez le champ vide.",
    parrain_invalide: "Le code parrain n'est pas valide. Format : ABC-2X7K.",
    code_pris: "Un code identique existe déjà. Réessayez.",
    donnees_invalides: "Vérifiez le nom et le numéro de téléphone du client.",
    client_inconnu: "Ce client n'est pas enregistré sur le serveur : renouvellement impossible.",
    serveur_invalide: "Réponse du serveur illisible : vérifiez le lien du serveur et son déploiement (accès « Tout le monde »).",
    action_inconnue: "Le script Google en ligne est une ancienne version : collez le nouveau Code.gs puis redéployez (Déployer > Gérer les déploiements > Modifier > Nouvelle version).",
    trop_de_demandes: "Trop de demandes en attente pour ce numéro. Payez et attendez la validation, ou contactez l'administrateur.",
    demande_inconnue: "Cette demande est introuvable sur le serveur. Refaites une demande.",
    erreur_serveur: "Erreur du serveur Google. Réessayez dans un instant."
  };
  function joursTxt() { return CFG.jours === 365 ? '1 an' : CFG.jours + ' jours'; }
  function digits(t) { return String(t || '').replace(/\D/g, ''); }
  function normCode(t) {
    var c = String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === 7 ? c.slice(0, 3) + '-' + c.slice(3) : c;
  }
  function genCode(nom) {
    var p = String(nom || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    while (p.length < 3) p += 'X';
    var arr = new Uint8Array(4), s = '', i;
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (i = 0; i < 4; i++) arr[i] = Math.floor(Math.random() * 256);
    for (i = 0; i < 4; i++) s += CODE_ALPHA.charAt(arr[i] % CODE_ALPHA.length);
    return p + '-' + s;
  }
  function timeoutFetch(url, opts, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) { return r.text(); }).then(function (t) { clearTimeout(timer); return t; }, function (e) { clearTimeout(timer); throw e; });
  }
  function parseJson(t) { try { return JSON.parse(t); } catch (e) { return { ok: false, erreur: 'serveur_invalide' }; } }
  function srvPost(body) {
    return timeoutFetch(CFG.serveur, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, 25000).then(parseJson);
  }
  function srvGet(params) {
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return timeoutFetch(CFG.serveur + (CFG.serveur.indexOf('?') < 0 ? '?' : '&') + qs, { method: 'GET' }, 25000).then(parseJson);
  }
  function watchProfile(db) {
    db.doc('license/profil').onSnapshot(function (s) {
      profile = s.exists ? s.data() : null;
      renderParrainBtn();
      setTimeout(syncLicence, 1500);
    }, function () { /* profil illisible : le bouton reste masqué */ });
  }
  /* Date de licence réglée depuis le tableau : l'administrateur impose une date exacte, appliquée une fois */
  var lastSync = 0, syncBusy = false;
  async function syncLicence(force) {
    if (syncBusy || !CFG.serveur || !profile || !profile.code || !licenseKnown) return;
    if (!force && Date.now() - lastSync < 600000) return;
    syncBusy = true;
    try {
      var cur = (license && license.expiresAt) || '';
      var res = await srvPost({ action: 'sync_licence', code: profile.code, expiresAt: cur });
      if (res && res.ok) {
        lastSync = Date.now();
        var imp = res.imposee;
        if (imp && /^\d{4}-\d{2}-\d{2}$/.test(imp) && imp !== cur) {
          if (await writeLicense({ expiresAt: imp })) {
            toast("L'administrateur a réglé votre licence : valable jusqu'au " + fmtDate(imp) + '.');
            try { await srvPost({ action: 'sync_licence', code: profile.code, expiresAt: imp, ack: imp }); } catch (e) { /* confirmé à la prochaine connexion */ }
          }
        }
      }
    } catch (e) { /* hors ligne : réessayé plus tard */ }
    syncBusy = false;
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncLicence(); });
  function renderParrainBtn() { var b = $('#btnParrain'); if (b) b.hidden = !(profile && profile.code && lstate === 'ok'); }

  function welcomeText(s, exp) {
    return 'Bonjour ' + s.client + ', merci pour votre achat de S crédits ! Votre licence est valable jusqu\'au ' + fmtDate(exp) + '.\n\n' +
      'Votre code parrain : *' + s.code + '*\n' +
      'Chaque personne qui achète S crédits (' + money(CFG.prix) + ') en donnant votre code vous rapporte ' + money(CFG.commission) + '. Partagez-le !';
  }
  function inviteText() {
    var L = ['Salut ! Je te recommande *S crédits*, l\'application qui permet de suivre les crédits de tes clients, les versements et le reste à payer, avec une alerte le jour où il faut encaisser.', '',
      'Prix : ' + money(CFG.prix) + ' pour ' + joursTxt() + '.', 'Au moment de l\'achat, donne mon code parrain : *' + profile.code + '*'];
    if (CFG.contact) L.push('Pour l\'acheter, contacte : +' + digits(CFG.contact));
    return L.join('\n');
  }

  function saleHtml() {
    var h = '<div class="adsec adsale"><h3>' + (adSale ? (adSale.sale.type === 'nouveau' ? 'Nouvelle vente' : 'Renouvellement') : (profile ? 'Renouveler' : 'Nouvelle vente')) + ' (' + money(CFG.prix) + ' · ' + joursTxt() + ')</h3>';
    if (adSale) {
      h += '<p class="adstat"><strong>' + (adSale.sale.type === 'nouveau' ? 'Vente enregistrée.' : 'Renouvellement enregistré.') + '</strong> Licence valable jusqu\'au <strong>' + fmtDate(adSale.expiresAt) + '</strong>.</p>' +
        '<div class="code-box"><span>Code parrain du client</span><strong>' + esc(adSale.sale.code) + '</strong></div>';
      if (adSale.commission > 0) h += '<p class="hint">Commission de ' + money(adSale.commission) + ' pour le parrain ' + esc(adSale.sale.parrain) + ' : elle apparaît dans le tableau Google (à payer par Mobile Money).</p>';
      if (adSale.avert) h += '<p class="hint">' + esc(adSale.avert) + '</p>';
      if (!adSale.server) h += '<p class="hint">Serveur non configuré : cette vente n\'a pas été enregistrée en ligne.</p>';
      h += '<div class="chips"><button class="btn btn-small btn-wa" type="button" data-adm="sendcode">Envoyer le code au client (WhatsApp)</button>' +
        '<button class="btn btn-small" type="button" data-adm="newsale">Nouvelle opération</button></div></div>';
      return h;
    }
    if (profile) {
      h += '<p class="hint">Client de cet appareil : <strong>' + esc(profile.nom) + '</strong> · code parrain ' + esc(profile.code) + '</p>';
    } else {
      h += '<div class="row-edit"><label>Nom du client<input id="sNom" type="text" autocomplete="off" placeholder="Ex. Koffi Yao"></label>' +
        '<label>Téléphone (Mobile Money)<input id="sTel" type="tel" autocomplete="off" inputmode="tel" placeholder="Ex. 07 00 00 00 00"></label>' +
        '<label>Code parrain (facultatif)<input id="sParrain" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Ex. KOF-7H2Q"></label></div>';
    }
    h += '<p class="form-error" id="sErr" role="alert"></p>' +
      '<button class="btn btn-primary" type="button" data-adm="sell">' + sellLabel() + '</button>';
    if (!CFG.serveur) h += '<p class="hint">Serveur non configuré : la vente active la licence, mais les commissions ne sont pas suivies.</p>';
    return h + '</div>';
  }
  function sellLabel() { return (profile ? 'Renouveler ' : 'Enregistrer la vente et activer ') + joursTxt(); }

  async function sellLicense() {
    if (adBusy) return;
    var err = $('#sErr'); if (err) err.textContent = '';
    var renew = !!profile, nom, tel, parrain = '';
    if (renew) { nom = profile.nom; tel = profile.tel; }
    else {
      nom = ($('#sNom').value || '').trim(); tel = ($('#sTel').value || '').trim(); parrain = normCode($('#sParrain').value);
      if (nom.length < 2) { err.textContent = 'Saisissez le nom du client.'; return; }
      if (digits(tel).length < 8) { err.textContent = 'Saisissez un numéro de téléphone valide : il sert à payer les commissions.'; return; }
      if (parrain && !CODE_RE.test(parrain)) { err.textContent = SRV_ERR.parrain_invalide; return; }
    }
    adBusy = true;
    var btn = document.querySelector('[data-adm="sell"]'); if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }
    try {
      var sale = { id: newId(), date: new Date().toISOString(), type: renew ? 'renouvellement' : 'nouveau', client: nom, tel: tel, code: renew ? profile.code : genCode(nom), parrain: parrain };
      var res = null;
      if (CFG.serveur) {
        for (var i = 0; i < 5; i++) {
          try { res = await srvPost(Object.assign({ action: 'vente', admin: adminCodeMem }, sale)); }
          catch (e) { err.textContent = "Pas de connexion internet : la vente doit être enregistrée en ligne pour que le parrain soit crédité. Activez les données mobiles, puis réessayez."; return; }
          if (!renew && res && res.erreur === 'code_pris') { sale.code = genCode(nom); continue; }
          break;
        }
        if (!res || !res.ok) { err.textContent = (SRV_ERR[res && res.erreur] || 'Le serveur a refusé la vente.') + (res && res.detail ? ' Détail : ' + res.detail : ''); return; }
      }
      var newExp = addDays(baseDate(), CFG.jours);
      var okL = await writeLicense({ expiresAt: newExp });
      if (!okL) { err.textContent = CFG.serveur ? "Vente enregistrée sur le serveur, mais la licence n'a pas pu être modifiée : ajoutez la durée à la main plus bas." : "La licence n'a pas pu être modifiée."; return; }
      if (!renew) {
        profile = { code: sale.code, nom: nom, tel: tel, parrain: parrain, venteLe: sale.date };
        try { await dbRef.doc('license/profil').set(profile); } catch (e) { toast("Le code parrain n'a pas pu être gardé sur cet appareil."); }
      }
      adSale = { sale: sale, expiresAt: newExp, server: !!CFG.serveur, commission: res ? Number(res.commission) || 0 : 0, avert: (res && res.avertissement) || '' };
      renderAdmin(); renderParrainBtn();
    } finally {
      adBusy = false;
      var b2 = document.querySelector('[data-adm="sell"]'); if (b2) { b2.disabled = false; b2.textContent = sellLabel(); }
    }
  }

  function loadParCache() {
    try { var c = JSON.parse(localStorage.getItem(PAR_KEY) || 'null'); if (c && c.code === (profile && profile.code)) { parState.data = c.data; parState.at = c.at; } } catch (e) { /* ignoré */ }
  }
  function refreshParrain() {
    if (!profile || !CFG.serveur) return;
    var el = $('#parStats'); if (el && !parState.data) el.innerHTML = '<p class="hint">Chargement de vos commissions…</p>';
    srvGet({ action: 'parrain', code: profile.code }).then(function (r) {
      if (r && r.ok) {
        parState = { data: r, at: new Date().toISOString(), erreur: '' };
        try { localStorage.setItem(PAR_KEY, JSON.stringify({ code: profile.code, data: r, at: parState.at })); } catch (e) { /* ignoré */ }
      } else {
        parState.erreur = r && r.erreur === 'code_inconnu' ? "Votre code n'est pas encore enregistré sur le serveur. Contactez l'administrateur." : (SRV_ERR[r && r.erreur] || 'Impossible de lire vos commissions.');
      }
      paintParStats();
    }, function () { parState.erreur = 'Pas de connexion internet.'; paintParStats(); });
  }
  function paintParStats() {
    var el = $('#parStats'); if (!el) return;
    if (!CFG.serveur) { el.innerHTML = '<p class="hint">Le suivi de vos commissions sera disponible dès que le serveur sera configuré.</p>'; return; }
    var d = parState.data, h = '';
    if (d) {
      h = '<h3>Vos commissions</h3><div class="par-grid">' +
        '<div><span>Clients parrainés</span><strong>' + d.filleuls.length + '</strong></div>' +
        '<div><span>Total gagné</span><strong>' + money(d.total) + '</strong></div>' +
        '<div><span>Déjà payé</span><strong>' + money(d.paye) + '</strong></div>' +
        '<div><span>Reste à recevoir</span><strong>' + money(d.aPayer) + '</strong></div></div>';
      if (d.filleuls.length) h += '<ul class="par-list">' + d.filleuls.map(function (f) {
        return '<li><span>' + esc(f.nom) + ' · ' + esc(f.date) + '</span><span>' + money(f.commission) + ' · ' + esc(f.statut) + '</span></li>';
      }).join('') + '</ul>';
      else h += '<p class="hint">Aucun client parrainé pour le moment. Partagez votre code !</p>';
      if (parState.at) h += '<p class="hint">Mis à jour le ' + fmtDate(parState.at.slice(0, 10)) + '.</p>';
    }
    if (parState.erreur) h += '<p class="form-error">' + esc(parState.erreur) + '</p>';
    if (!d && !parState.erreur) h = '<p class="hint">Chargement de vos commissions…</p>';
    h += '<button class="btn btn-small" type="button" data-par="refresh">Actualiser</button>';
    el.innerHTML = h;
  }
  function showParrain() {
    if (!profile) return;
    var d = $('#dialog'); d.className = 'dialog par';
    d.innerHTML = '<h2 id="ovTitle">Parrainage : ' + money(CFG.commission) + ' par client</h2>' +
      '<p>Chaque personne qui achète S crédits (' + money(CFG.prix) + ') en donnant votre code vous rapporte <strong>' + money(CFG.commission) + '</strong>, payés par Mobile Money sur le <strong>' + esc(profile.tel) + '</strong>.</p>' +
      '<div class="code-box"><span>Votre code parrain</span><strong>' + esc(profile.code) + '</strong></div>' +
      '<div class="acts"><button class="btn" type="button" data-act="ovclose">Fermer</button><button class="btn" type="button" data-par="copy">Copier mon code</button>' +
      '<button class="btn btn-wa" type="button" data-par="invite">Inviter par WhatsApp</button></div>' +
      '<div class="adsec" id="parStats"></div>';
    $('#overlay').hidden = false;
    loadParCache(); paintParStats(); refreshParrain();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-par]'); if (!b) return;
    var a = b.dataset.par;
    if (a === 'open') showParrain();
    else if (a === 'refresh') refreshParrain();
    else if (a === 'invite') { if (profile) openLink('https://wa.me/?text=' + encodeURIComponent(inviteText())); }
    else if (a === 'copy') { if (profile) copyText(profile.code).then(function () { toast('Code copié'); }, function () { toast('Copie impossible sur cet appareil.'); }); }
  });

  /* Activation à distance : demande en ligne, validation dans le tableau, vérification */
  var demande = null, ra = { view: 'home', msg: '', busy: false, f: {} };
  async function loadDemande() {
    if (!dbRef) return;
    try { var s = await dbRef.doc('license/demande').get(); demande = s.exists ? s.data() : null; } catch (e) { demande = null; }
    if (lstate !== 'ok') renderLock();
  }
  function raSet(patch) { Object.assign(ra, patch); if (lstate !== 'ok') renderLock(); }
  function raHtml() {
    var h = '<div class="adsec ra">', renew = !!profile;
    if (demande) {
      h += '<h3>Demande d\'activation envoyée</h3><p class="hint">Référence : <strong>' + esc(demande.code) + '</strong>. Payez ' + money(CFG.prix) + ' par Mobile Money' + (CFG.contact ? ' au <strong>+' + esc(digits(CFG.contact)) + '</strong>' : '') + ' en indiquant cette référence. Quand l\'administrateur a validé, appuyez sur « Vérifier mon activation ».</p>';
      if (ra.msg) h += '<p class="form-error" role="alert">' + esc(ra.msg) + '</p>';
      h += '<div class="chips"><button class="btn btn-primary" type="button" data-ra="check"' + (ra.busy ? ' disabled' : '') + '>' + (ra.busy ? 'Vérification…' : 'Vérifier mon activation') + '</button>';
      if (CFG.contact) h += '<a class="btn btn-wa" target="_blank" rel="noopener" href="https://wa.me/' + digits(CFG.contact) + '?text=' + encodeURIComponent('Bonjour, j\'ai payé pour activer S crédits. Ma référence : ' + demande.code + ' (' + demande.client + ')') + '">Prévenir l\'administrateur (WhatsApp)</a>';
      return h + '<button class="btn btn-small" type="button" data-ra="cancel">Annuler la demande</button></div></div>';
    }
    if (ra.view === 'form' && !renew) {
      h += '<h3>Demander l\'activation</h3><div class="row-edit"><label>Votre nom<input id="rNom" type="text" autocomplete="off" value="' + esc(ra.f.nom || '') + '" placeholder="Ex. Koffi Yao"></label>' +
        '<label>Votre téléphone (Mobile Money)<input id="rTel" type="tel" autocomplete="off" inputmode="tel" value="' + esc(ra.f.tel || '') + '" placeholder="Ex. 07 00 00 00 00"></label>' +
        '<label>Code parrain (facultatif)<input id="rPar" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + esc(ra.f.par || '') + '" placeholder="Ex. KOF-7H2Q"></label></div>' +
        '<p class="form-error" id="rErr" role="alert">' + esc(ra.msg) + '</p><div class="chips"><button class="btn btn-primary" type="button" data-ra="send"' + (ra.busy ? ' disabled' : '') + '>' + (ra.busy ? 'Envoi…' : 'Envoyer la demande') + '</button><button class="btn btn-small" type="button" data-ra="home">Retour</button></div></div>';
      return h;
    }
    h += '<h3>' + (renew ? 'Renouveler en ligne' : 'Activer en ligne') + '</h3><p class="hint">Sans rendez-vous : envoyez une demande, payez par Mobile Money, puis activez dès que l\'administrateur a validé. Internet n\'est nécessaire que pour cette étape.</p>';
    if (ra.msg) h += '<p class="form-error" role="alert">' + esc(ra.msg) + '</p>';
    h += '<button class="btn btn-primary" type="button" data-ra="' + (renew ? 'send' : 'form') + '"' + (ra.busy ? ' disabled' : '') + '>' + (renew ? (ra.busy ? 'Envoi…' : 'Demander le renouvellement') : 'Demander l\'activation') + '</button></div>';
    return h;
  }
  async function raSend() {
    if (ra.busy) return;
    var renew = !!profile, nom, tel, parrain = '';
    if (renew) { nom = profile.nom; tel = profile.tel; }
    else {
      nom = ($('#rNom').value || '').trim(); tel = ($('#rTel').value || '').trim(); parrain = normCode($('#rPar').value);
      ra.f = { nom: nom, tel: tel, par: $('#rPar').value };
      if (nom.length < 2) return raSet({ msg: 'Saisissez votre nom.' });
      if (digits(tel).length < 8) return raSet({ msg: 'Saisissez un numéro de téléphone valide : il sert à payer vos commissions.' });
      if (parrain && !CODE_RE.test(parrain)) return raSet({ msg: SRV_ERR.parrain_invalide });
    }
    raSet({ busy: true, msg: '' });
    var d = { id: newId() + newId() + newId(), date: new Date().toISOString(), type: renew ? 'renouvellement' : 'nouveau', client: nom, tel: tel, code: renew ? profile.code : genCode(nom), parrain: parrain };
    var res = null;
    try {
      for (var i = 0; i < 5; i++) {
        try { res = await srvPost(Object.assign({ action: 'demande' }, d)); }
        catch (e) { return raSet({ busy: false, msg: 'Pas de connexion internet. Activez les données mobiles puis réessayez.' }); }
        if (!renew && res && res.erreur === 'code_pris') { d.code = genCode(nom); continue; }
        break;
      }
      if (!res || !res.ok) return raSet({ busy: false, msg: (SRV_ERR[res && res.erreur] || 'Le serveur a refusé la demande' + (res && res.erreur ? ' (' + res.erreur + ')' : '') + '.') + (res && res.detail ? ' Détail : ' + res.detail : '') });
      demande = d;
      try { await dbRef.doc('license/demande').set(d); } catch (e) { /* la demande reste en mémoire */ }
      raSet({ busy: false, msg: '', view: 'home', f: {} });
    } catch (e) { raSet({ busy: false, msg: 'Erreur inattendue. Réessayez.' }); }
  }
  async function raCheck() {
    if (ra.busy || !demande) return;
    raSet({ busy: true, msg: '' });
    var res = null;
    try { res = await srvPost({ action: 'statut', id: demande.id }); }
    catch (e) { return raSet({ busy: false, msg: 'Pas de connexion internet. Réessayez quand le réseau est revenu.' }); }
    if (!res || !res.ok) {
      if (res && res.erreur === 'demande_inconnue') { await raClear(); return raSet({ busy: false, msg: SRV_ERR.demande_inconnue, view: 'home' }); }
      return raSet({ busy: false, msg: (SRV_ERR[res && res.erreur] || 'Vérification impossible pour le moment.') + (res && res.detail ? ' Détail : ' + res.detail : '') });
    }
    if (res.statut === 'Refusé') { await raClear(); return raSet({ busy: false, view: 'home', msg: 'Votre demande a été refusée' + (res.note ? ' : ' + res.note : '.') + ' Contactez l\'administrateur.' }); }
    if (res.statut !== 'Validé') return raSet({ busy: false, msg: 'Pas encore validée. Payez puis patientez : l\'administrateur valide après réception du paiement.' });
    var d = demande;
    var newExp = addDays(baseDate(), CFG.jours);
    var okL = await writeLicense({ expiresAt: newExp });
    if (!okL) return raSet({ busy: false, msg: "Paiement validé, mais la licence n'a pas pu être enregistrée sur cet appareil. Réessayez." });
    if (d.type === 'nouveau') {
      profile = { code: d.code, nom: d.client, tel: d.tel, parrain: d.parrain || '', venteLe: d.date };
      try { await dbRef.doc('license/profil').set(profile); } catch (e) { toast("Le code parrain n'a pas pu être gardé sur cet appareil."); }
    }
    await raClear();
    ra = { view: 'home', msg: '', busy: false };
    toast('Licence activée jusqu\'au ' + fmtDate(newExp));
    renderParrainBtn();
  }
  async function raClear() { demande = null; try { await dbRef.doc('license/demande').delete(); } catch (e) { /* ignoré */ } }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ra]'); if (!b) return;
    var a = b.dataset.ra;
    if (a === 'form') raSet({ view: 'form', msg: '' });
    else if (a === 'home') raSet({ view: 'home', msg: '', f: {} });
    else if (a === 'send') raSend();
    else if (a === 'check') raCheck();
    else if (a === 'cancel') { raClear().then(function () { raSet({ view: 'home', msg: '' }); }); }
  });

  /* Sauvegarde en ligne et autres appareils (voir sync.js) */
  var SYNC = window.SCreditsSync;
  var sy = { view: 'login', busy: false, msg: '', outAsk: false };
  function syncOn() { return !!(SYNC && SYNC.enabled); }
  function closeSync() { $('#syncOv').hidden = true; $('#syDialog').innerHTML = ''; sy.msg = ''; sy.outAsk = false; }
  function openSync(view) {
    if (!syncOn()) return;
    if (view) sy.view = view;
    $('#syncOv').hidden = false; syRender();
  }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function syRender() {
    if ($('#syncOv').hidden) return;
    var st = SYNC.state(), h = '';
    if (st.signedIn && !st.needLogin) {
      var line = st.busy ? 'Synchronisation en cours…' : st.error ? esc(st.error) : st.pending ? st.pending + ' modification' + (st.pending > 1 ? 's' : '') + ' en attente d\'envoi.' : st.lastSync ? 'Tout est synchronisé (' + hhmm(st.lastSync) + ').' : 'En attente de la première synchronisation…';
      h = '<h2 id="syTitle">Sauvegarde en ligne</h2><p>Compte : <strong>+' + esc(st.phone) + '</strong></p><p class="' + (st.error ? 'form-error' : 'hint') + '" role="status">' + line + '</p>' +
        '<p class="hint">Vos crédits, versements, photos et votre licence sont copiés dans ce compte. Pour les retrouver sur un autre appareil : installez S crédits, puis « Me connecter » avec le même téléphone et le même code.</p>';
      if (st.devices && st.devices.length) {
        h += '<h3>Appareils connectés (' + st.devices.length + ' sur ' + SYNC.maxDevices + ' autorisés)</h3><ul class="hist">' + st.devices.map(function (d) {
          var me = d.id === st.deviceId;
          return '<li><span class="d">' + esc(d.name || 'Appareil') + (me ? ' (cet appareil)' : '') + (d.seen ? ' · vu le ' + esc(d.seen) : '') + '</span>' + (me ? '' : '<button class="link link-danger" type="button" data-sy="rmdev" data-id="' + esc(d.id) + '">Retirer</button>') + '</li>';
        }).join('') + '</ul>';
      }
      h += '<div class="chips"><button class="btn btn-primary" type="button" data-sy="now"' + (st.busy ? ' disabled' : '') + '>Synchroniser maintenant</button><button class="btn" type="button" data-sy="close">Fermer</button></div>';
      h += sy.outAsk
        ? '<div class="dupbox"><p>Se déconnecter ? Les données restent sur cet appareil mais ne seront plus synchronisées, et la place est libérée pour un autre appareil.</p><div class="pay"><button class="btn btn-small btn-danger" type="button" data-sy="outyes">Oui, me déconnecter</button><button class="btn btn-small" type="button" data-sy="outno">Annuler</button></div></div>'
        : '<button class="link link-danger" type="button" data-sy="out">Se déconnecter</button>';
    } else {
      var signup = sy.view === 'signup';
      h = '<h2 id="syTitle">Sauvegarde en ligne</h2>' +
        (st.needLogin ? '<p class="form-error">Votre session a expiré : reconnectez-vous avec votre code.</p>' : '') +
        (st.notice ? '<p class="form-error">' + esc(st.notice) + '</p>' : '') +
        '<div class="chips"><button class="chip" type="button" data-sy="tab" data-v="login" aria-pressed="' + !signup + '">Me connecter</button><button class="chip" type="button" data-sy="tab" data-v="signup" aria-pressed="' + signup + '">Créer mon compte</button></div>' +
        '<p class="hint">' + (signup ? 'Créez un compte avec votre téléphone et un code secret : vos données seront copiées en ligne et récupérables sur un autre appareil.' : 'Retrouvez vos données sur cet appareil avec le téléphone et le code de votre compte.') + '</p>' +
        '<div class="row-edit"><label>Votre téléphone<input id="syPhone" type="tel" inputmode="tel" autocomplete="off" placeholder="Ex. 07 00 00 00 00" value="' + esc(sy.phone || (profile && profile.tel) || '') + '"></label>' +
        '<label>Code secret (6 à 12 chiffres)<input id="syPin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••••"></label>' +
        (signup ? '<label>Répétez le code<input id="syPin2" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••••"></label>' : '') + '</div>' +
        (signup ? '<p class="hint"><strong>Gardez bien ce code :</strong> il ne peut pas être retrouvé s\'il est oublié.</p>' : '') +
        '<p class="form-error" role="alert">' + esc(sy.msg) + '</p>' +
        '<div class="chips"><button class="btn btn-primary" type="button" data-sy="go"' + (sy.busy ? ' disabled' : '') + '>' + (sy.busy ? 'Un instant…' : signup ? 'Créer mon compte' : 'Me connecter') + '</button><button class="btn" type="button" data-sy="close">Fermer</button></div>';
    }
    $('#syDialog').innerHTML = h;
  }
  async function syGo() {
    if (sy.busy) return;
    var phone = ($('#syPhone').value || '').trim(), pin = ($('#syPin').value || '').trim(), signup = sy.view === 'signup';
    sy.phone = phone;
    if (signup && pin !== ($('#syPin2').value || '').trim()) { sy.msg = 'Les deux codes sont différents.'; return syRender(); }
    sy.busy = true; sy.msg = ''; syRender();
    try {
      if (signup) await SYNC.signUp(phone, pin); else await SYNC.signIn(phone, pin);
      sy.busy = false; sy.msg = '';
      toast(signup ? 'Compte créé : vos données sont sauvegardées en ligne.' : 'Connecté : vos données ont été récupérées.');
      if (lstate === 'ok' || SYNC.state().signedIn) syRender();
    } catch (e) { sy.busy = false; sy.msg = (e && e.message) || 'Connexion impossible.'; syRender(); }
  }
  if (syncOn()) SYNC.onChange(function () { syRender(); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-sy]'); if (!b || !syncOn()) return;
    var a = b.dataset.sy;
    if (a === 'open') openSync(b.dataset.v);
    else if (a === 'close') closeSync();
    else if (a === 'tab') { sy.view = b.dataset.v; sy.msg = ''; syRender(); }
    else if (a === 'go') syGo();
    else if (a === 'now') SYNC.syncNow();
    else if (a === 'out') { sy.outAsk = true; syRender(); }
    else if (a === 'outno') { sy.outAsk = false; syRender(); }
    else if (a === 'outyes') { sy.outAsk = false; SYNC.signOut().then(function () { toast('Déconnecté'); syRender(); }); }
    else if (a === 'rmdev') SYNC.removeDevice(b.dataset.id).then(function () { toast('Appareil retiré'); }, function (er) { toast((er && er.message) || 'Impossible de retirer cet appareil.'); });
  });
  $('#syncOv').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); syGo(); } if (e.key === 'Escape') closeSync(); });

  /* Exportation : fichier Excel (.xlsx) et PDF de tous les crédits, pour garder une copie de secours */
  function fnum(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function sd(iso) { iso = String(iso || ''); return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : iso; }
  function exportData() {
    var list = credits.slice().sort(function (a, b) { return String(a.nom).localeCompare(String(b.nom), 'fr'); });
    var sum = list.map(function (c) {
      return { c: c, nom: c.nom, tel: c.tel || '', total: c.total, paid: paid(c), reste: reste(c), rappel: c.rappel ? sd(c.rappel) : '', cree: c.createdAt ? sd(c.createdAt) : '', statut: reste(c) <= 0 ? 'Soldé' : 'En cours', note: c.note || '' };
    });
    var moves = [];
    list.forEach(function (c) {
      var m = [{ d: c.createdAt || '', type: 'Crédit initial', label: '', montant: initialAmount(c) }];
      (c.ajouts || []).forEach(function (a) { m.push({ d: a.date, type: 'Crédit ajouté', label: a.label || '', montant: a.montant }); });
      (c.versements || []).forEach(function (v) { m.push({ d: v.date, type: 'Versement', label: v.label || '', montant: v.montant }); });
      m.sort(function (x, y) { return String(x.d).localeCompare(String(y.d)); });
      m.forEach(function (x) { moves.push({ nom: c.nom, tel: c.tel || '', date: x.d ? sd(x.d) : '', type: x.type, label: x.label, montant: x.montant }); });
    });
    return { sum: sum, moves: moves };
  }
  /* --- ZIP minimal (sans compression) pour fabriquer le .xlsx --- */
  var CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) { CRC_T = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) crc = CRC_T[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, now = new Date();
    var dt = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      var head = [0x50, 0x4B, 3, 4].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(dt), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([0x50, 0x4B, 1, 2].concat(u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(dt), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += head.length + name.length + data.length;
    });
    var csize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new Uint8Array([0x50, 0x4B, 5, 6].concat(u16(0), u16(0), u16(files.length), u16(files.length), u32(csize), u32(offset), u16(0)));
    var all = parts.concat(central, [end]), total = all.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }
  function xesc(t) { return String(t == null ? '' : t).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function colL(i) { return String.fromCharCode(65 + i); }
  function sheetXml(rows, widths) {
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' +
      widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>';
    rows.forEach(function (row, r) {
      x += '<row r="' + (r + 1) + '">';
      row.forEach(function (cell, i) {
        var ref = colL(i) + (r + 1);
        if (cell === null || cell === undefined || cell === '') return;
        if (typeof cell === 'object') x += '<c r="' + ref + '" s="' + (cell.s || 0) + '">' + (cell.f ? '<f>' + xesc(cell.f) + '</f>' : '') + '<v>' + cell.v + '</v></c>';
        else if (typeof cell === 'number') x += '<c r="' + ref + '" s="2"><v>' + cell + '</v></c>';
        else x += '<c r="' + ref + '" t="inlineStr" s="' + (r === 0 ? 1 : 0) + '"><is><t xml:space="preserve">' + xesc(cell) + '</t></is></c>';
      });
      x += '</row>';
    });
    return x + '</sheetData></worksheet>';
  }
  function buildXlsx() {
    var d = exportData(), n = d.sum.length;
    var r1 = [['Client', 'Téléphone', 'Total dû (FCFA)', 'Versé (FCFA)', 'Reste à payer (FCFA)', 'Prochain rappel', 'Créé le', 'Statut', 'Note']];
    d.sum.forEach(function (s) { r1.push([s.nom, s.tel, s.total, s.paid, s.reste, s.rappel, s.cree, s.statut, s.note]); });
    var T = function (col) { return { s: 3, f: 'SUM(' + col + '2:' + col + (n + 1) + ')', v: d.sum.reduce(function (a, s) { return a + (col === 'C' ? s.total : col === 'D' ? s.paid : s.reste); }, 0) }; };
    if (n) r1.push([{ s: 3, v: 0 }].slice(0, 0).concat(['TOTAL', '', T('C'), T('D'), T('E')]));
    var r2 = [['Client', 'Téléphone', 'Date', 'Opération', 'Détail', 'Montant (FCFA)']];
    d.moves.forEach(function (m) { r2.push([m.nom, m.tel, m.date, m.type, m.label, m.montant]); });
    var NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    return zipStore([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ' + NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Crédits" sheetId="1" r:id="rId1"/><sheet name="Mouvements" sheetId="2" r:id="rId2"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ' + NS + '><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3EFEC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(r1, [26, 16, 16, 16, 20, 16, 14, 11, 34]) },
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml(r2, [26, 16, 14, 16, 30, 16]) }
    ]);
  }
  /* --- PDF minimal (texte) --- */
  function pdfText(t) {
    var s = String(t == null ? '' : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[  ]/g, ' ').replace(/œ/g, 'oe').replace(/Œ/g, 'OE');
    var o = '';
    for (var i = 0; i < s.length; i++) { var ch = s.charCodeAt(i); o += ch > 255 ? '?' : s.charAt(i); }
    return o.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function pad2(s, w, right) { s = String(s); if (s.length > w) s = s.slice(0, w - 1) + '.'; var sp = new Array(w - s.length + 1).join(' '); return right ? sp + s : s + sp; }
  function buildPdf() {
    var d = exportData(), pages = [], cur = null, y = 0, LH = 13.5, SZ = 9, CW = 0.6 * SZ;
    var today = sd(todayIso());
    function newPage() { cur = []; pages.push(cur); y = 800; }
    function txt(x, yy, str, font, size) { cur.push('BT /' + font + ' ' + size + ' Tf ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' Td (' + pdfText(str) + ') Tj ET'); }
    function rule(yy) { cur.push('0.6 w 40 ' + yy.toFixed(1) + ' m 555 ' + yy.toFixed(1) + ' l S'); }
    function line(str, bold) { if (y < 60) { newPage(); } txt(40, y, str, bold ? 'F4' : 'F3', SZ); y -= LH; }
    newPage();
    txt(40, y, 'S credits', 'F2', 20); y -= 22;
    txt(40, y, 'Situation de tous les credits au ' + today, 'F1', 11); y -= 26;
    var tT = 0, tP = 0, tR = 0; d.sum.forEach(function (s) { tT += s.total; tP += s.paid; tR += s.reste; });
    txt(40, y, 'Clients : ' + d.sum.length + '     Total du : ' + fnum(tT) + ' FCFA     Verse : ' + fnum(tP) + ' FCFA', 'F2', 10); y -= 15;
    txt(40, y, 'Reste a payer : ' + fnum(tR) + ' FCFA', 'F2', 12); y -= 22;
    var head = pad2('Client', 22) + ' ' + pad2('Telephone', 12) + ' ' + pad2('Total', 11, 1) + ' ' + pad2('Verse', 11, 1) + ' ' + pad2('Reste', 11, 1) + ' ' + pad2('Rappel', 10);
    function tableHead() { line(head, true); rule(y + 9); y -= 2; }
    tableHead();
    d.sum.forEach(function (s) {
      if (y < 60) { newPage(); tableHead(); }
      line(pad2(s.nom, 22) + ' ' + pad2(s.tel, 12) + ' ' + pad2(fnum(s.total), 11, 1) + ' ' + pad2(fnum(s.paid), 11, 1) + ' ' + pad2(fnum(s.reste), 11, 1) + ' ' + pad2(s.reste <= 0 ? 'Solde' : s.rappel, 10));
    });
    rule(y + 9); y -= 2;
    line(pad2('TOTAL', 35) + ' ' + pad2(fnum(tT), 11, 1) + ' ' + pad2(fnum(tP), 11, 1) + ' ' + pad2(fnum(tR), 11, 1), true);
    if (d.sum.length) {
      newPage(); txt(40, y, 'Detail par client', 'F2', 14); y -= 24;
      d.sum.forEach(function (s) {
        var m = d.moves.filter(function (x) { return x.nom === s.nom && x.tel === s.tel; });
        if (y < 110) newPage();
        txt(40, y, s.nom + (s.tel ? '  -  ' + s.tel : ''), 'F2', 10.5); y -= 14;
        line('Total du ' + fnum(s.total) + '   Verse ' + fnum(s.paid) + '   Reste ' + fnum(s.reste) + ' FCFA' + (s.note ? '   (' + s.note + ')' : ''), true);
        m.forEach(function (x) { line('  ' + pad2(x.date, 10) + '  ' + pad2(x.type, 14) + ' ' + pad2(x.label, 24) + ' ' + pad2((x.type === 'Versement' ? '-' : '+') + fnum(x.montant), 12, 1)); });
        y -= 8;
      });
    }
    pages.forEach(function (p, i) { p.push('BT /F3 8 Tf 40 28 Td (' + pdfText('S credits - page ' + (i + 1) + '/' + pages.length) + ') Tj ET'); });
    var objs = [], n = 4 + 2 * pages.length;
    var kids = pages.map(function (p, i) { return (5 + i * 2) + ' 0 R'; }).join(' ');
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>';
    objs[3] = '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> /F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >> /F4 << /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >> >>';
    objs[4] = '<< /Producer (S credits) >>';
    pages.forEach(function (p, i) {
      var c = p.join('\n');
      objs[5 + i * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font 3 0 R >> /Contents ' + (6 + i * 2) + ' 0 R >>';
      objs[6 + i * 2] = '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream';
    });
    var out = '%PDF-1.4\n', offs = [];
    for (var i = 1; i <= n; i++) { offs[i] = out.length; out += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    var xref = out.length;
    out += 'xref\n0 ' + (n + 1) + '\n0000000000 65535 f \n';
    for (i = 1; i <= n; i++) out += ('0000000000' + offs[i]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + (n + 1) + ' /Root 1 0 R /Info 4 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    var u8 = new Uint8Array(out.length);
    for (i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 255;
    return u8;
  }
  function saveFile(bytes, fname, mime, title) {
    var cap = window.Capacitor, CP = cap && cap.Plugins;
    var native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    if (native && CP && CP.Filesystem && CP.Share) {
      var bin = '', CH = 0x8000;
      for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return CP.Filesystem.writeFile({ path: fname, data: btoa(bin), directory: 'CACHE' }).then(function (r) {
        return CP.Share.share({ title: title, files: [r.uri], dialogTitle: title });
      }).catch(function (e) { if (!/cancel/i.test(String((e && e.message) || e))) toast("Impossible de partager le fichier : " + ((e && e.message) || e)); });
    }
    var url = URL.createObjectURL(new Blob([bytes], { type: mime })), a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast('Fichier enregistré : ' + fname);
    return Promise.resolve();
  }
  function exportFile(kind) {
    if (!credits.length) { toast("Aucun crédit à exporter."); return; }
    var day = todayIso();
    try {
      if (kind === 'xlsx') saveFile(buildXlsx(), 'scredits-credits-' + day + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Exportation des crédits');
      else saveFile(buildPdf(), 'scredits-credits-' + day + '.pdf', 'application/pdf', 'Exportation des crédits');
    } catch (e) { toast("L'exportation a échoué : " + ((e && e.message) || e)); }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ex]'); if (!b) return;
    var a = b.dataset.ex;
    if (a === 'open') { $('#exOv').hidden = false; $('#exCount').textContent = credits.length + ' client' + (credits.length > 1 ? 's' : ''); var bx = document.querySelector('#exOv [data-ex="xlsx"]'); if (bx) bx.hidden = CFG.excel === false; }
    else if (a === 'close') $('#exOv').hidden = true;
    else if (a === 'xlsx' || a === 'pdf') exportFile(a);
  });
  $('#exOv').addEventListener('keydown', function (e) { if (e.key === 'Escape') $('#exOv').hidden = true; });

  function openAdmin() {
    adStep = 'code'; adSale = null; renderAdmin();
    $('#adminOv').hidden = false;
    var i = $('#adCode'); if (i) i.focus();
  }
  function closeAdmin() { $('#adminOv').hidden = true; adStep = 'code'; adminCodeMem = ''; adSale = null; $('#adDialog').innerHTML = ''; }
  function updateAdStatus() {
    var el = $('#adStatus');
    if (!el) return;
    if (!license || !license.expiresAt) { el.textContent = "Licence non activée. Ajoutez du temps pour l'activer."; return; }
    var n = daysLeft();
    el.innerHTML = (n < 0 ? 'Licence expirée depuis le ' : "Licence valable jusqu'au ") + '<strong>' + fmtDate(license.expiresAt) + '</strong>' +
      (n >= 0 ? ' (' + n + (n <= 1 ? ' jour restant)' : ' jours restants)') : '') + '.';
  }
  function renderAdmin() {
    var d = $('#adDialog');
    if (adStep === 'code') {
      d.innerHTML = '<h2 id="adTitle">Espace administrateur</h2><p>Saisissez le code administrateur pour gérer la licence.</p>' +
        '<div class="field"><label for="adCode">Code administrateur</label><input id="adCode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
        '<p class="form-error" id="adErr" role="alert"></p>' +
        '<div class="acts"><button class="btn" type="button" data-adm="close">Annuler</button><button class="btn btn-primary" type="button" data-adm="check">Valider</button></div>';
      return;
    }
    d.innerHTML = '<h2 id="adTitle">Gestion de la licence</h2><p class="adstat" id="adStatus"></p>' + saleHtml() +
      '<div class="adsec"><h3>Ajouter du temps</h3><div class="chips">' +
        [7, 30, 90, 365].map(function (n) { return '<button class="chip" type="button" data-adm="add" data-n="' + n + '">+ ' + n + ' jours</button>'; }).join('') + '</div></div>' +
      '<div class="adsec"><h3>Durée personnalisée</h3><div class="row-edit"><label>Nombre de jours<input id="adDays" type="number" min="1" step="1" inputmode="numeric" placeholder="Ex. 15"></label>' +
        '<button class="btn btn-small btn-primary" type="button" data-adm="addc">Ajouter</button><button class="btn btn-small" type="button" data-adm="subc">Retirer</button></div>' +
        '<p class="hint">Retirer des jours peut bloquer l\'application immédiatement.</p></div>' +
      '<div class="adsec"><h3>Date d\'expiration exacte</h3><div class="row-edit"><label>Expire le<input id="adDate" type="date" value="' + esc(license && license.expiresAt || '') + '"></label>' +
        '<button class="btn btn-small" type="button" data-adm="setdate">Appliquer</button></div></div>' +
      '<div class="adsec"><h3>Contact affiché aux utilisateurs</h3><div class="row-edit"><label>Téléphone ou e-mail<input id="adContact" type="text" autocomplete="off" value="' + esc(license && license.contact || '') + '"></label>' +
        '<button class="btn btn-small" type="button" data-adm="contact">Enregistrer</button></div></div>' +
      '<div class="adsec"><h3>Code administrateur</h3><div class="row-edit"><label>Nouveau code<input id="adNew" type="password" autocomplete="new-password"></label>' +
        '<label>Confirmer<input id="adNew2" type="password" autocomplete="new-password"></label>' +
        '<button class="btn btn-small" type="button" data-adm="pin">Changer le code</button></div></div>' +
      '<div class="acts"><button class="btn" type="button" data-adm="close">Quitter l\'espace administrateur</button></div>';
    updateAdStatus();
  }
  async function adCheck() {
    var err = $('#adErr'), inp = $('#adCode');
    if (!inp) return;
    if (Date.now() < adLockUntil) { err.textContent = 'Trop d\'essais. Réessayez dans ' + Math.ceil((adLockUntil - Date.now()) / 1000) + ' secondes.'; return; }
    var code = (inp.value || '').trim().toUpperCase();
    if (!code) { err.textContent = 'Saisissez le code.'; return; }
    var ok = false;
    try { ok = await verifyCode(code); } catch (e) { err.textContent = 'Vérification impossible sur cet appareil.'; return; }
    if (ok) { adFails = 0; adminCodeMem = code; adStep = 'panel'; renderAdmin(); return; }
    adFails++; inp.value = '';
    if (adFails >= 5) { adLockUntil = Date.now() + 30000; adFails = 0; err.textContent = 'Code incorrect. Nouvel essai possible dans 30 secondes.'; }
    else err.textContent = 'Code incorrect.';
  }
  async function changePin() {
    var a = ($('#adNew').value || '').trim().toUpperCase(), b = ($('#adNew2').value || '').trim().toUpperCase();
    if (a.length < 4) { toast('Le code doit contenir au moins 4 caractères.'); return; }
    if (a !== b) { toast('Les deux codes ne sont pas identiques.'); return; }
    try {
      var salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
      await dbRef.doc('admin/pin').set({ salt: salt, hash: await sha(salt + a), updatedAt: new Date().toISOString() });
      $('#adNew').value = ''; $('#adNew2').value = '';
      toast('Code administrateur modifié');
    } catch (e) { toast("Le code n'a pas pu être modifié."); }
  }
  function customDays() { var n = Math.floor(Number($('#adDays').value)); return n > 0 ? Math.min(n, 3650) : 0; }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-adm]');
    if (!b) return;
    var a = b.dataset.adm;
    if (a === 'open') { if (isOwner) openAdmin(); return; }
    if (a === 'close') { closeAdmin(); return; }
    if (a === 'check') { adCheck(); return; }
    if (adStep !== 'panel' || !isOwner) return;
    if (a === 'add') { writeLicense({ expiresAt: addDays(baseDate(), Number(b.dataset.n)) }); return; }
    if (a === 'addc') { var n1 = customDays(); if (!n1) { toast('Indiquez un nombre de jours.'); return; } writeLicense({ expiresAt: addDays(baseDate(), n1) }); return; }
    if (a === 'subc') { var n2 = customDays(); if (!n2) { toast('Indiquez un nombre de jours.'); return; } writeLicense({ expiresAt: addDays(license && license.expiresAt || todayIso(), -n2) }); return; }
    if (a === 'setdate') { var v = $('#adDate').value; if (!v) { toast('Choisissez une date.'); return; } writeLicense({ expiresAt: v }); return; }
    if (a === 'contact') { writeLicense({ contact: $('#adContact').value.trim() }); return; }
    if (a === 'pin') { changePin(); return; }
    if (a === 'sell') { sellLicense(); return; }
    if (a === 'newsale') { adSale = null; renderAdmin(); return; }
    if (a === 'sendcode') { if (adSale) openLink('https://wa.me/' + waPhone(adSale.sale.tel) + '?text=' + encodeURIComponent(welcomeText(adSale.sale, adSale.expiresAt))); return; }
  });
  $('#adminOv').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'adCode') { e.preventDefault(); adCheck(); }
    if (e.key === 'Escape') closeAdmin();
  });

  /* Démarrage */
  function ready() {
    loaded = true;
    lastDay = todayIso();
    render();
    checkDue();
  }
  async function start() {
    $('#logoHead').innerHTML = logoSvg(92);
    render();
    applyGate();
    var db = null, uid = null;
    try {
      if (window.SCreditsStore && window.SCreditsStore.use) {
        var user = await window.SCreditsStore.use('user');
        uid = user ? await user.id() : null;
        db = uid ? await window.SCreditsStore.use('db') : null;
      }
    } catch (e) { db = null; }
    dbRef = db;
    if (!db || !uid) { licFailed = true; applyGate(); return; }
    try { var u2 = await window.SCreditsStore.use('user'); isOwner = !!(u2 && await u2.isOwner()); } catch (e) { isOwner = false; }
    watchLicense(db);
    watchProfile(db);
    loadDemande();
    if (db && uid) {
      mode = 'cloud';
      col = db.collection('data/users/' + uid);
      var timer = setTimeout(function () { slow = true; renderFoot(); }, 10000);
      col.onSnapshot(function (snap) {
        if (!snap.metadata.fromCache) { clearTimeout(timer); slow = false; }
        credits = snap.docs.map(function (d) { var o = normalize(clone(d.data())); o.id = d.id; return o; });
        if (!loaded) ready(); else { render(); checkDue(); }
      }, function () {
        clearTimeout(timer); loadError = true; loaded = true; render();
      });
    } else {
      mode = 'local';
      loadLocal();
      credits = credits.map(normalize);
      ready();
    }
  }
  start();

  /* Vérification périodique : changement de jour et nouvelles échéances */
  setInterval(function () {
    applyGate();
    if (!loaded) return;
    var d = todayIso();
    if (d !== lastDay) { lastDay = d; render(); }
    checkDue();
  }, 60000);
})();
