'use strict';
/*
 * Espaces — éditeur de textes regroupés en espaces (et sous-espaces), navigables en roue 3D.
 * Le même fichier tourne dans l'app macOS (pont natif WebKit), dans un navigateur
 * (repli localStorage) et dans un espace exporté en HTML (lecture seule).
 */
(() => {
  const EXPORT = window.__EXPORT__ || null;
  const READONLY = !!EXPORT;
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  const NATIVE = !!bridge && !READONLY;
  const call = (cmd, payload) => bridge.postMessage({ cmd, payload: payload === undefined ? null : payload });
  // journal de diagnostic de l'iPhone (Documents/espaces-diag.log) : ce qui se passait juste avant un rechargement
  const diag = m => { if (NATIVE && (/iPhone/.test(navigator.userAgent) || navigator.maxTouchPoints > 1)) { try { const r = call('diag', String(m)); if (r && r.catch) r.catch(() => {}); } catch (e) { /* rien */ } } };
  // sur iPhone, un message de plusieurs dizaines de Mo vers l'app native tue la page : le texte part par petits morceaux, un envoi à la fois
  let bigQueue = Promise.resolve();
  const sendBig = (cmd, text) => {
    if (!/iPhone/.test(navigator.userAgent)) return call(cmd, text);
    const run = async () => {
      const SIZE = 1 << 20;
      for (let at = 0, i = 0; at < text.length; i++) {
        let end = Math.min(text.length, at + SIZE);
        const c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c < 0xdc00 && end < text.length) end--;   // ne pas couper un caractère en deux
        await call('chunk', { i, s: text.slice(at, end) });
        at = end;
      }
      return call(cmd, null);
    };
    const done = bigQueue.then(run, run);
    bigQueue = done.catch(() => {});
    return done;
  };
  diag('js: démarrage');
  addEventListener('error', e => diag('js: erreur ' + e.message + ' @' + e.lineno));
  addEventListener('unhandledrejection', e => diag('js: rejet ' + ((e.reason && e.reason.message) || e.reason)));
  document.addEventListener('visibilitychange', () => diag('js: visible=' + !document.hidden));
  /*
   * Retour haptique du trackpad Force Touch (app native seulement ; senti uniquement le doigt posé sur le trackpad).
   * 'hover' : un effleurement au survol ; 'tick' : un petit cran (quelque chose passe, s'aligne) ;
   * 'step' : un cran franc (on pose, on bascule, on coupe).
   */
  const haptic = (kind = 'tick') => {
    if (!bridge) return;
    const now = performance.now();
    if (now - (haptic.t || 0) < 40) return;
    haptic.t = now;
    try { const r = bridge.postMessage({ cmd: 'haptic', payload: kind }); if (r && r.catch) r.catch(() => {}); } catch (e) { /* rien */ }
  };
  const LS_KEY = 'espaces.library.v1';
  /*
   * Dans un navigateur (sur PC, l'app installée depuis la page web), la bibliothèque vit dans IndexedDB : le stockage
   * local plafonne à quelques Mo, ce qu'une seule image dépasse. L'ancienne copie du stockage local est reprise une fois.
   */
  const idb = (() => {
    let db = null;
    const open = () => db || (db = new Promise((ok, ko) => {
      const r = indexedDB.open('espaces', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    }));
    const run = (mode, f) => open().then(d => new Promise((ok, ko) => {
      const t = d.transaction('kv', mode), q = f(t.objectStore('kv'));
      t.oncomplete = () => ok(q.result);
      t.onerror = t.onabort = () => ko(t.error);
    }));
    return { get: k => run('readonly', st => st.get(k)), set: (k, v) => run('readwrite', st => st.put(v, k)) };
  })();
  // le navigateur ne vide pas la bibliothèque de lui-même quand le disque se remplit
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  async function browserLoad() {
    try { const v = await idb.get(LS_KEY); if (v) return v; } catch (e) { console.error(e); }
    return localStorage.getItem(LS_KEY);
  }
  async function browserSave(data) {
    try { await idb.set(LS_KEY, data); } catch (e) { localStorage.setItem(LS_KEY, data); return; }
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* tant pis */ }
  }
  /*
   * Version de l'app, et numéro du format des données. Chaque changement de structure ajoute une migration :
   * une bibliothèque ou un .espace plus ancien est remis à niveau à l'ouverture ; un plus récent s'ouvre
   * tel quel (ce que cette version ne connaît pas est conservé, simplement pas affiché).
   */
  const APP_VERSION = '0.2.0', SCHEMA = 1;
  const MIGRATIONS = {
    // 0 → 1 : la structure ne change pas, elle reçoit simplement son numéro
    1: d => d
  };
  function migrate(data) {
    let v = data.schema || 0;
    while (v < SCHEMA) { v++; data = (MIGRATIONS[v] || (d => d))(data); data.schema = v; }
    return data;
  }
  // mode Lecteur de l'app : on parcourt l'espace exactement comme le recevra le lecteur de l'export
  let readerMode = false;
  const PHONE = window.__PLATFORM === 'iphone';
  const VSTORE = PHONE && NATIVE;   // l'iPhone range les versions des cartes à part (voir loadVersions)
  const asReader = () => !PHONE && (READONLY || readerMode);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = ts => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

  /* ───────────── Données ───────────── */

  let state = { spaces: [], current: null };
  let view = null;
  let saveTimer = null;
  let onSaved = null;

  async function load() {
    if (EXPORT) {
      // ancien format d'export : un seul espace
      const spaces = EXPORT.spaces || [EXPORT.space];
      return { spaces, current: EXPORT.root || spaces[0].id };
    }
    let raw = null;
    try { raw = NATIVE ? await call('load') : await browserLoad(); } catch (e) { console.error(e); }
    try {
      const s = raw ? JSON.parse(raw) : null;
      if (s && Array.isArray(s.spaces)) return migrate(s);
    } catch (e) { console.error(e); }
    return { spaces: [], current: null, schema: SCHEMA };
  }

  /*
   * La bibliothèque en JSON, sans tout réécrire à chaque enregistrement : le texte d'une carte et ses versions, seuls
   * à peser lourd (les images y sont en base64), restent en mémoire tant qu'ils n'ont pas changé.
   */
  const docCache = new WeakMap();
  // sur iPhone : les cartes dont les versions sont en mémoire, celles qui les attendent, et ce qui en a été envoyé
  const vers = { open: new Set(), pending: new Set(), sent: new Map() };
  const versionsKey = h => h && h.list ? `${h.list.length}|${(h.list[h.list.length - 1] || {}).t}|${h.list.filter(v => v.keep).length}|${Object.keys(h.pool || {}).length}` : null;
  function docText(d) {
    const { html, history, ...rest } = d;
    let c = docCache.get(d);
    if (!c) { c = {}; if (!PHONE) docCache.set(d, c); }   // (sur iPhone, la mémoire compte plus que ces quelques millisecondes)
    if (html !== undefined && c.html !== html) { c.html = html; c.htmlJ = JSON.stringify(html); }
    const key = versionsKey(history);
    if (history !== undefined && !VSTORE && (key === null || c.h !== history || c.key !== key)) { c.h = history; c.key = key; c.hJ = JSON.stringify(history); }
    const parts = [];
    if (html !== undefined) parts.push('"html":' + c.htmlJ);
    // (sur iPhone, les versions ont leur propre rangement : voir versionsPut)
    if (history !== undefined && !VSTORE) parts.push('"history":' + c.hJ);
    const r = JSON.stringify(rest);
    if (r.length > 2) parts.push(r.slice(1, -1));
    return '{' + parts.join() + '}';
  }
  const withField = (json, name, value) => json.slice(0, -1) + (json.length > 2 ? ',' : '') + `"${name}":${value}}`;
  function libText({ spaces, ...meta }) {
    const list = spaces.map(({ docs, ...sp }) => withField(JSON.stringify(sp), 'docs', '[' + docs.map(docText).join() + ']'));
    return withField(JSON.stringify(meta), 'spaces', '[' + list.join() + ']');
  }

  function persist(now) {
    if (READONLY) return;
    clearTimeout(saveTimer);
    const run = async () => {
      // on n'interrompt pas la main : l'enregistrement attend la pause
      if (!now && inkBusy()) { saveTimer = setTimeout(run, 1500); return; }
      // une grande page n'est recopiée qu'ici, pas à chaque frappe (voir changed)
      if (view === 'editor' && edDoc) commitEditor();
      if (VSTORE) sendVersions();
      if (sync.on) stampChanges();
      const data = libText(state);
      sync.size = data.length;
      diag('save: ' + data.length + ' vue=' + view);
      try {
        if (NATIVE) await sendBig('save', data);
        else await browserSave(data);
        if (onSaved) onSaved();
        scheduleSync();
        schedulePeer();
      } catch (e) {
        console.error(e);
        toast("Impossible d'enregistrer : " + (e.message || e));
      }
    };
    if (now) run(); else saveTimer = setTimeout(run, 450);
  }

  /*
   * Synchronisation entre appareils (app native : Mac et iPad).
   * Chaque appareil garde sa bibliothèque et travaille hors ligne ; une copie partagée vit dans un dossier choisi
   * une fois (dans iCloud Drive). À chaque changement, l'appareil relit la copie partagée, fusionne, puis la réécrit.
   * La fusion se fait élément par élément : pour un même espace ou une même carte, la version la plus récente gagne ;
   * une suppression est retenue (pierre tombale datée) pour que l'autre appareil ne fasse pas revivre l'élément.
   */
  const sync = { on: false, timer: null, sigs: new Map(), ids: null, busy: false, again: false, cloudIds: null };
  // ce qui se synchronise : l'espace iCloud, ses sous-espaces, et leurs cartes
  function cloudSubset() {
    const root = byId(CLOUD_ID);
    const spaces = root ? [root, ...descendants(root)] : [];
    const ids = new Set();
    for (const sp of spaces) { ids.add(sp.id); for (const d of sp.docs) ids.add(d.id); }
    return { spaces, ids };
  }
  // avant la synchronisation sélective, toute la bibliothèque se synchronisait : ce qui était déjà partagé entre dans iCloud
  function migrateToCloud(remote) {
    if (state.cloudMigrated) return;
    state.cloudMigrated = true;
    const legacy = !remote.spaces.some(s => s.id === CLOUD_ID);
    const remoteIds = new Set(remote.spaces.map(s => s.id));
    const now = Date.now();
    for (const sp of state.spaces) if (!isCloudRoot(sp) && !sp.parent && remoteIds.has(sp.id)) { sp.parent = CLOUD_ID; sp.updatedAt = now; }
    if (legacy) for (const r of remote.spaces) if (!r.parent && r.id !== CLOUD_ID) r.parent = CLOUD_ID;
  }
  const SYNC_FILE_DELAY = 700;
  const itemTime = o => (o && (o.updatedAt || o.createdAt)) || 0;
  const spaceMeta = sp => { const m = Object.assign({}, sp); delete m.docs; delete m.updatedAt; return m; };
  // (sur iPhone, les versions d'une carte ne sont en mémoire que pendant qu'elle est ouverte : sendVersions s'en charge)
  const docSig = (sp, d) => { const { html, history, updatedAt, ...m } = d; return { html, k: hashOf(sp.id + '|' + JSON.stringify(m)) + (VSTORE ? '' : versionsKey(history)) }; };

  // ce qui a changé depuis le dernier enregistrement reçoit l'heure du changement ; ce qui a disparu, une pierre tombale
  function stampChanges() {
    const now = Date.now(), ids = new Set(), first = !sync.ids;
    state.deleted = state.deleted || {};
    for (const sp of state.spaces) {
      ids.add(sp.id);
      const s = hashOf(JSON.stringify(spaceMeta(sp)));
      if (!first && sync.sigs.has(sp.id) && sync.sigs.get(sp.id) !== s) sp.updatedAt = now;
      sync.sigs.set(sp.id, s);
      for (const d of sp.docs) {
        ids.add(d.id);
        const k = docSig(sp, d);
        const was = sync.sigs.get(d.id);
        if (!first && was && (was.k !== k.k || was.html !== k.html)) d.updatedAt = Math.max(now, d.updatedAt || 0);
        sync.sigs.set(d.id, k);
      }
    }
    if (!first) for (const id of sync.ids) if (!ids.has(id)) { state.deleted[id] = now; sync.sigs.delete(id); }
    sync.ids = ids;
  }
  // après une fusion : l'état reçu devient la référence, sans être compté comme un changement local
  function rememberSigs() { sync.ids = null; sync.sigs.clear(); stampChanges(); }

  // a : la bibliothèque de cet appareil, b : la copie partagée. Garde les objets locaux (l'éditeur y tient des références).
  function mergeLibraries(a, b) {
    const res = { changed: false, stale: false, updated: new Set() };
    const deleted = Object.assign({}, b.deleted || {});
    for (const [k, t] of Object.entries(a.deleted || {})) { if ((deleted[k] || 0) < t) { deleted[k] = t; res.stale = true; } }
    const old = Date.now() - 90 * 864e5;
    for (const k of Object.keys(deleted)) if (deleted[k] < old) delete deleted[k];
    const adopt = (local, remote, skip) => {
      for (const k of Object.keys(local)) if (!skip.includes(k) && !(k in remote)) delete local[k];
      for (const k of Object.keys(remote)) if (!skip.includes(k)) local[k] = remote[k];
    };
    const gone = o => (deleted[o.id] || 0) > itemTime(o);
    // les espaces : leurs réglages viennent de la version la plus récente
    const bSp = new Map(b.spaces.map(s => [s.id, s])), spaces = [];
    for (const s of a.spaces) {
      const r = bSp.get(s.id);
      if (!r) res.stale = true;
      else if (itemTime(r) > itemTime(s)) { adopt(s, r, ['id', 'docs']); res.changed = true; }
      else if (itemTime(s) > itemTime(r)) res.stale = true;
      if (gone(s)) { res.changed = true; continue; }
      spaces.push(s);
    }
    const have = new Set(spaces.map(s => s.id));
    for (const r of b.spaces) if (!have.has(r.id) && !a.spaces.some(s => s.id === r.id) && !gone(r)) {
      spaces.push(Object.assign({}, r, { docs: [] })); res.changed = true;
    }
    // les cartes : la version la plus récente gagne, et avec elle l'espace où elle se trouve
    const where = lib => { const m = new Map(); for (const s of lib.spaces) for (const d of s.docs) m.set(d.id, { d, sp: s.id }); return m; };
    const A = where(a), B = where(b), win = new Map();
    for (const [id, x] of A) {
      const y = B.get(id);
      if (!y) { res.stale = true; win.set(id, { d: x.d, sp: x.sp }); continue; }
      if (itemTime(y.d) > itemTime(x.d)) {
        // (sur iPhone, la copie partagée arrive sans l'historique des versions : la carte garde le sien)
        adopt(x.d, y.d, VSTORE ? ['id', 'history'] : ['id']); res.changed = true; res.updated.add(id); win.set(id, { d: x.d, sp: y.sp });
      } else {
        if (itemTime(x.d) > itemTime(y.d) || x.sp !== y.sp) res.stale = true;
        win.set(id, { d: x.d, sp: x.sp });
      }
    }
    for (const [id, y] of B) if (!A.has(id)) { win.set(id, { d: Object.assign({}, y.d), sp: y.sp }); res.changed = true; res.updated.add(id); }
    for (const [id, w] of win) if (gone(w.d)) { win.delete(id); if (A.has(id)) res.changed = true; }
    // l'ordre : celui de cet appareil, puis ce qui arrive d'ailleurs dans l'ordre de l'autre
    const placed = new Set();
    for (const s of spaces) {
      const keep = s.docs.filter(d => win.has(d.id) && win.get(d.id).sp === s.id);
      if (keep.length !== s.docs.length) res.changed = true;
      keep.forEach(d => placed.add(d.id));
      s.docs = keep;
    }
    const spById = new Map(spaces.map(s => [s.id, s]));
    for (const r of b.spaces) for (const d of r.docs) {
      const w = win.get(d.id);
      if (!w || placed.has(d.id)) continue;
      const target = spById.get(w.sp);
      if (target) { target.docs.push(w.d); placed.add(d.id); res.changed = true; }
    }
    // une carte orpheline (son espace a disparu) n'est jamais perdue : elle va dans le premier espace
    for (const [id, w] of win) if (!placed.has(id) && spaces.length) { spaces[0].docs.push(w.d); placed.add(id); res.changed = true; }
    res.spaces = spaces;
    res.deleted = deleted;
    return res;
  }

  // l'interface suit ce qui vient d'arriver, sans bousculer ce qu'on est en train de faire
  function refreshAfterSync(updated) {
    if (view === 'editor' && edDoc) {
      if (!spaceOfDoc(edDoc.id)) { closeEditor(); toast('Cette carte a été supprimée sur un autre appareil'); return; }
      if (updated.has(edDoc.id)) {
        // on vient de taper ici : on garde son texte (le plus récent l'emportera) ; sinon la carte suit sur place
        if (Date.now() - (sync.lastTyped || 0) < 1500) return;
        const a = document.activeElement, focused = a && (a === $('#edTitle') || edBody().contains(a) || a === edBody());
        const sel = focused ? selPath() : null, sc = $('#edScroll').scrollTop;
        if ($('#edTitle').textContent !== edDoc.title) $('#edTitle').textContent = edDoc.title;
        if (edBody().innerHTML !== edDoc.html) edBody().innerHTML = edDoc.html;
        if (sel) { try { restoreSel(sel); } catch (e) { /* le texte a trop changé : le curseur reste au début */ } }
        histCommit();
        $('#edScroll').scrollTop = sc;
        $('#edStatus').textContent = 'Mis à jour depuis un autre appareil';
        requestAnimationFrame(renderPeers);
        scheduleA4();
      }
      return;
    }
    if (view === 'quick') return renderQuick();
    if (view === 'welcome' && state.spaces.length) return route();
    if (view === 'space') {
      if (!state.spaces.length) return showWelcome();
      if (!byId(state.current) && ring.ctx !== 'all') return enterSpace(null, { instant: true, keepRotation: true });
      refreshRingInPlace();
    }
  }
  function refreshRingInPlace() {
    const next = currentItems();
    const same = next.length === ring.items.length && next.every((it, i) => it.id === ring.items[i].id && it.kind === ring.items[i].kind);
    // des cartes en plus, en moins, ou dans un autre ordre : la roue se reconstruit, à la même rotation
    if (!same) return enterSpace(state.current, { instant: true, keepRotation: true });
    ring.items = next;
    for (const c of $$('#ring > .card[data-id]')) {
      const item = next[+c.dataset.idx], old = $('.face', c);
      if (!item || !old) continue;
      const face = faceOf(item);
      if (face.innerHTML === old.innerHTML && face.style.cssText === old.style.cssText && face.className.replace(' img', '') === old.className.replace(' img', '')) continue;
      if (old.classList.contains('img')) { face.style.backgroundImage = old.style.backgroundImage; face.classList.add('img'); }
      c.replaceChild(face, old);
    }
    paintCovers($('#ring'), next);
    renderChrome();
  }

  // la part partagée de cette bibliothèque, à jour : ce qui est entré dans iCloud ou en est sorti depuis la dernière fois
  function prepareCloud() {
    const created = ensureCloudRoot();
    ensureQuick();
    stampChanges();
    state.deleted = state.deleted || {};
    const mine = cloudSubset();
    if (sync.cloudIds) {
      const now = Date.now();
      // ce qui a quitté iCloud (retiré, ou supprimé) disparaît des autres appareils
      for (const id of sync.cloudIds) if (!mine.ids.has(id)) state.deleted[id] = Math.max(state.deleted[id] || 0, now);
      // ce qui (re)entre dans iCloud l'emporte sur une ancienne suppression : sous-espaces et cartes compris
      for (const sp of mine.spaces) for (const o of [sp, ...sp.docs]) {
        if (sync.cloudIds.has(o.id)) continue;
        delete state.deleted[o.id];
        o.updatedAt = now;
      }
    }
    sync.cloudIds = mine.ids;
    return { mine, created };
  }

  // fusionne une copie reçue (le fichier iCloud, ou l'autre appareil en direct)
  function absorb(remote, mine) {
    if (remote.linkKey) state.linkKey = remote.linkKey;
    const m = mergeLibraries({ spaces: mine.spaces, deleted: state.deleted }, remote);
    // ce que cet appareil garde pour lui ne revient jamais par la synchronisation
    const local = state.spaces.filter(sp => !mine.ids.has(sp.id));
    const localIds = new Set(local.flatMap(sp => [sp.id, ...sp.docs.map(d => d.id)]));
    const merged = m.spaces.filter(sp => !localIds.has(sp.id));
    for (const sp of merged) sp.docs = sp.docs.filter(d => !localIds.has(d.id));
    state.spaces = [...merged, ...local];
    state.deleted = m.deleted;
    if (m.changed) {
      rememberSigs();
      if (!byId(state.current)) state.current = null;
      refreshAfterSync(m.updated);
    }
    sync.cloudIds = cloudSubset().ids;
    return m;
  }
  // ce qui a changé se lit sur les dates : inutile de garder en mémoire des copies entières de la bibliothèque
  const fullHash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length.toString(36); };
  const sharedKey = () => JSON.stringify([state.linkKey, cloudSubset().spaces.map(sp => [spaceMeta(sp), sp.updatedAt, sp.docs.map(d => [d.id, d.updatedAt])]), state.deleted || {}]);
  // (sur iPhone, sans les versions : l'app native y remet celles de son rangement)
  const sharedPayload = () => libText({ schema: SCHEMA, linkKey: state.linkKey, spaces: cloudSubset().spaces, deleted: state.deleted || {} });
  const newLinkKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

  // le lien direct (même réseau) : l'app native s'en charge dès qu'elle connaît la clé partagée
  function startPeer() {
    if (PHONE) return;   // le lien direct échange toute la bibliothèque d'un bloc, ce qui tue la page sur iPhone : iCloud suffit
    if (!state.linkKey || sync.peerKey === state.linkKey) return;
    sync.peerKey = state.linkKey;
    call('peerStart', state.linkKey).catch(() => {});
  }

  async function syncNow() {
    if (!sync.on || READONLY) return;
    if (inkBusy()) return scheduleSync();
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true;
    try {
      if (view === 'editor' && edDoc) commitEditor();
      let remote = null;
      diag('sync: lecture');
      // sur iPhone, le fichier partagé inchangé n'est même pas relu : deux bibliothèques en mémoire tuent la page
      const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
      const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* tant pis */ } };
      let stamp = PHONE ? await call('syncStamp') : null;
      const untouched = !!stamp && stamp === lsGet('espaces.syncStamp.v2');   // (.v2 : relu une fois, pour que les versions des autres appareils rejoignent l'iPhone)
      let text = untouched ? null : await call('syncRead');
      diag('sync: lu ' + (text ? text.length : 0));
      // la copie partagée n'a pas bougé depuis notre dernier passage : rien à relire ni à fusionner
      const seen = text ? fullHash(text) : null, same = untouched || (!!seen && seen === sync.seen);
      if (text && !same) { try { remote = migrate(JSON.parse(text)); } catch (e) { console.error(e); } }
      text = null;   // le texte lu n'est plus utile : la mémoire qu'il occupe peut être rendue avant la fusion
      const has = remote && Array.isArray(remote.spaces);
      sync.foundFile = !!has || same;
      if (has) migrateToCloud(remote);
      else if (!same) state.cloudMigrated = true;
      diag('sync: analysé, même=' + same);
      const { mine, created } = prepareCloud();
      let stale = !same, changed = created;
      if (has) {
        const m = absorb(remote, mine);
        stale = m.stale || !remote.linkKey;
        changed = changed || m.changed;
      }
      if (!state.linkKey) { state.linkKey = newLinkKey(); stale = true; changed = true; }
      diag('sync: fusionné changed=' + changed + ' stale=' + stale);
      if (changed) await sendBig('save', libText(state));
      const key = sharedKey();
      const base = sync.base || (PHONE && lsGet('espaces.syncBase'));
      const keyH = PHONE ? fullHash(key) : key;
      if (same && keyH !== base) stale = true;
      if (stale) { const out = sharedPayload(); diag('sync: écriture ' + out.length); await sendBig('syncWrite', out); sync.seen = fullHash(out); }
      else if (!untouched) sync.seen = seen;
      sync.base = keyH;
      if (PHONE) { stamp = await call('syncStamp'); if (stamp) lsSet('espaces.syncStamp.v2', stamp); lsSet('espaces.syncBase', keyH); }
      diag('sync: fini');
      startPeer();
    } catch (e) {
      console.error(e);
    } finally {
      sync.busy = false;
      drainSync();
    }
  }

  // une copie arrive directement de l'autre appareil
  async function peerIncoming(text) {
    if (!sync.on || READONLY) return;
    if (text.startsWith('{"presence"')) {
      try { const o = JSON.parse(text); if (o.linkKey === state.linkKey) receivePresence(o.presence); } catch (e) { /* ignoré */ }
      return;
    }
    if (sync.busy) { sync.inbox = text; return; }
    sync.busy = true;
    try {
      const remote = migrate(JSON.parse(text));
      if (!remote || !Array.isArray(remote.spaces) || remote.linkKey !== state.linkKey) return;
      if (view === 'editor' && edDoc) commitEditor();
      const { mine } = prepareCloud();
      const m = absorb(remote, mine);
      if (m.changed) await sendBig('save', libText(state));
      // cet appareil avait du plus récent : il le renvoie (les deux convergent en un aller-retour)
      if (m.stale) schedulePeer();
    } catch (e) {
      console.error(e);
    } finally {
      sync.busy = false;
      drainSync();
    }
  }
  function drainSync() {
    if (sync.inbox) { const t = sync.inbox; sync.inbox = null; peerIncoming(t); return; }
    if (sync.again) { sync.again = false; scheduleSync(); }
  }

  // une grosse bibliothèque coûte cher à faire voyager : on attend une vraie pause de la frappe
  const heavyLibrary = () => (sync.size || 0) > 15e5;
  const scheduleSync = () => { if (!sync.on) return; clearTimeout(sync.timer); sync.timer = setTimeout(syncNow, heavyLibrary() ? 4000 : SYNC_FILE_DELAY); };
  // chaque changement part aussitôt vers les appareils proches
  function schedulePeer() {
    if (PHONE || !sync.on || !state.linkKey) return;
    clearTimeout(sync.peerTimer);
    sync.peerTimer = setTimeout(() => {
      if (sync.busy) return schedulePeer();
      if (view === 'editor' && edDoc) commitEditor();
      prepareCloud();
      const key = sharedKey();
      if (key === sync.peerSent) return;
      sync.peerSent = key;
      call('peerSend', sharedPayload()).catch(() => {});
    }, heavyLibrary() ? 1500 : 250);
  }
  // l'app native prévient quand la copie partagée a changé (l'autre appareil vient d'écrire), ou au retour au premier plan
  window.__syncChanged = () => appReady.then(syncNow);
  window.__peerIncoming = text => appReady.then(() => peerIncoming(text));
  window.__peerJoined = () => appReady.then(() => { sync.peerSent = null; schedulePeer(); sendPresence(true); });
  // sur iPad, l'entrée « Plus d'options… » du menu du texte ouvre le menu de l'éditeur, là où est la sélection
  window.__editorMenu = () => appReady.then(() => {
    if (view !== 'editor') return;
    const s = document.getSelection();
    const r = s.rangeCount ? s.getRangeAt(0) : null;
    const b = r ? (r.getClientRects()[0] || r.getBoundingClientRect()) : edBody().getBoundingClientRect();
    const node = r ? (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode) : edBody();
    editorMenu({ target: node, clientX: b.left, clientY: b.bottom + 8, altKey: false, preventDefault() {} });
  });

  async function startSync() {
    if (!NATIVE) return;
    for (const el of [edBody(), $('#edTitle')]) el.addEventListener('input', () => { sync.lastTyped = Date.now(); });
    try {
      const st = await call('syncState');
      sync.on = !!(st && st.enabled);
      paintSyncItem(st);
      paintPhoneNav();
      if (sync.on) syncNow();
    } catch (e) { /* une version de l'app sans synchronisation */ }
  }
  function paintSyncItem(st) {
    const b = $('#filePop [data-action="sync"]');
    if (!b) return;
    b.hidden = !NATIVE;
    b.textContent = st && st.enabled ? `Synchronisé avec ${st.folder || 'iCloud'} (arrêter)` : 'Synchroniser avec iCloud…';
  }

  /* ───────────── Note partagée : travailler à deux, chacun avec son iCloud ─────────────
   * La note vit aussi dans un fichier (.espnote) d'un dossier iCloud Drive que l'auteur a partagé avec l'autre personne
   * (Finder : clic droit › Partager). Toutes les quelques secondes, et après chaque modification, chacun relit ce fichier :
   * les deux versions se fusionnent paragraphe par paragraphe depuis leur dernier point commun, puis le fichier est réécrit.
   * Deux personnes qui retouchent le même paragraphe au même moment : les deux versions sont gardées, l'une sous l'autre. */
  const SHARE_DEV = () => window.__PLATFORM || 'mac';
  const shareRef = sh => sh && sh.refs && sh.refs[SHARE_DEV()];
  const shareBlocks = html => {
    const t = document.createElement('template');
    t.innerHTML = html || '';
    return Array.from(t.content.childNodes).map(n => n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? n.textContent : '').filter(x => x.trim());
  };
  // les blocs communs à deux versions (plus longue sous-suite commune), d'un indice de la première à celui de la seconde
  function lcsMap(a, b) {
    const n = a.length, m = b.length, map = new Map();
    if (n * m > 4e6) { for (let i = 0; i < Math.min(n, m) && a[i] === b[i]; i++) map.set(i, i); return map; }
    const L = new Uint32Array((n + 1) * (m + 1)), W = m + 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) { map.set(i, j); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
    }
    return map;
  }
  // les mots d'un paragraphe, balises comprises, pour fusionner deux retouches d'un même paragraphe
  const mergeTokens = html => html.match(/<[^>]+>|\s+|[^\s<]+/g) || [];
  const wordsOfBlock = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  const tagOfBlock = h => (/^<([a-z0-9]+)/i.exec(h) || [])[1] || '#';
  // deux versions d'un même paragraphe : même balise, et au moins la moitié des mots en commun
  function sameBlock(x, y) {
    if (x === y) return true;
    if (tagOfBlock(x) !== tagOfBlock(y)) return false;
    const a = wordsOfBlock(x), b = new Set(wordsOfBlock(y));
    if (!a.length || !b.size) return false;
    return a.filter(w => b.has(w)).length / Math.max(a.length, b.size) >= .5;
  }
  function lcsEq(a, b, eq) {
    const n = a.length, m = b.length, map = new Map();
    if (n * m > 4e6) return map;
    const L = new Uint32Array((n + 1) * (m + 1)), W = m + 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = eq(a[i], b[j]) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (eq(a[i], b[j]) && L[i * W + j] === L[(i + 1) * W + j + 1] + 1) { map.set(i, j); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
    }
    return map;
  }
  // un même paragraphe retouché des deux côtés : on fusionne mot à mot (chacun garde ses mots, s'ils ne se touchent pas)
  function mergeBlock(o, a, b) {
    if (a === o || a === b) return { html: b, conflict: false };
    if (b === o) return { html: a, conflict: false };
    const m = merge3(mergeTokens(o), mergeTokens(a), mergeTokens(b), false);
    return m.conflict ? { html: a + b, conflict: true } : { html: m.blocks.join(''), conflict: false };
  }
  // fusion à trois : o, l'ancêtre commun ; a, cette version ; b, celle de l'autre.
  // Entre deux blocs restés communs, ce qui a changé des deux côtés se reprend paragraphe par paragraphe (fine)
  function merge3(o, a, b, fine = true) {
    const ma = lcsMap(o, a), mb = lcsMap(o, b), out = [];
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    let io = 0, ia = 0, ib = 0, conflict = false;
    for (;;) {
      let k = io;
      while (k < o.length && !(ma.has(k) && mb.has(k))) k++;
      const ea = k < o.length ? ma.get(k) : a.length, eb = k < o.length ? mb.get(k) : b.length;
      const O = o.slice(io, k), A = a.slice(ia, ea), B = b.slice(ib, eb);
      if (same(A, O)) out.push(...B);
      else if (same(B, O) || same(A, B)) out.push(...A);
      else if (fine) { const r = mergeChunk(O, A, B); out.push(...r.blocks); conflict = conflict || r.conflict; }
      else { out.push(...A, ...B); conflict = true; }
      if (k >= o.length) break;
      out.push(o[k]);
      io = k + 1; ia = ea + 1; ib = eb + 1;
    }
    return { blocks: out, conflict };
  }
  // un passage changé des deux côtés : on y retrouve chaque paragraphe d'origine dans les deux versions (même s'il a été
  // retouché), puis chacun est fusionné ; un paragraphe supprimé d'un côté et retouché de l'autre garde la retouche
  function mergeChunk(O, A, B) {
    const ma = lcsEq(O, A, sameBlock), mb = lcsEq(O, B, sameBlock), out = [];
    let ia = 0, ib = 0, conflict = false;
    const flush = (ea, eb) => { out.push(...A.slice(ia, ea), ...B.slice(ib, eb)); ia = ea; ib = eb; };
    O.forEach((o, k) => {
      const ja = ma.get(k), jb = mb.get(k);
      if (ja != null) flush(ja, ib);
      if (jb != null) flush(ia, jb);
      const va = ja != null ? A[ja] : null, vb = jb != null ? B[jb] : null;
      if (ja != null) ia = ja + 1;
      if (jb != null) ib = jb + 1;
      if (va != null && vb != null) { const r = mergeBlock(o, va, vb); out.push(r.html); conflict = conflict || r.conflict; }
      else if (va != null) { if (va !== o) out.push(va); }          // supprimé de l'autre côté : seule une retouche d'ici le retient
      else if (vb != null) { if (vb !== o) out.push(vb); }
    });
    flush(A.length, B.length);
    return { blocks: out, conflict };
  }

  // la mise en scène voyage avec la note : chaque réglage vient de celui qui l'a changé en dernier
  const SHARE_LOOK = ['present', 'scene', 'weather', 'night', 'lamp'];
  const lookOf = doc => { const o = {}; for (const k of SHARE_LOOK) if (doc[k] != null && doc[k] !== '' && doc[k] !== false) o[k] = doc[k]; return o; };

  let shareBusy = false, shareTimer = 0, shareLive = 0;
  const shareSoon = () => {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => { if (view === 'editor' && edDoc && edDoc.share) shareTick(edDoc); }, 1500);
    // à proximité, l'autre appareil reçoit la note tout de suite par le lien direct
    clearTimeout(shareLive);
    shareLive = setTimeout(() => { if (view === 'editor' && edDoc && edDoc.share) shareSendLive(edDoc); }, 250);
  };
  const shareState = (doc, rev) => ({ espnote: 1, id: doc.share.id, title: doc.title, html: doc.html, look: lookOf(doc), rev, t: Date.now(), by: quickDevice() });
  // fusionne une version reçue (le fichier, ou l'autre appareil en direct) ; vrai si la note a changé ici
  function shareAbsorb(doc, remote) {
    const sh = doc.share, base = sh.base || { title: doc.title, html: doc.html, look: lookOf(doc) };
    if (!remote || remote.rev === sh.rev) return false;
    const m = merge3(shareBlocks(base.html), shareBlocks(doc.html), shareBlocks(remote.html));
    const html = m.blocks.join(''), title = doc.title !== base.title ? doc.title : remote.title;
    const mine = lookOf(doc), theirs = remote.look || {}, was = base.look || {};
    const look = {};
    for (const k of SHARE_LOOK) {
      const v = JSON.stringify(mine[k]) !== JSON.stringify(was[k]) ? mine[k] : theirs[k];
      if (v != null) look[k] = v;
    }
    if (m.conflict) toast('Le même passage a été changé des deux côtés au même moment : les deux versions sont gardées, l’une sous l’autre');
    sh.rev = remote.rev;
    sh.by = remote.by || '';
    const lookChanged = JSON.stringify(look) !== JSON.stringify(mine);
    for (const k of SHARE_LOOK) { if (look[k] != null) doc[k] = look[k]; else delete doc[k]; }
    sh.base = { title, html, look };
    if (html === doc.html && title === doc.title && !lookChanged) return false;
    doc.html = html;
    doc.title = title;
    doc.updatedAt = Date.now();
    return true;
  }
  function shareShow(doc) {
    if (view !== 'editor' || edDoc !== doc) return;
    const a = document.activeElement, focused = a && (a === $('#edTitle') || edBody().contains(a));
    const sel = focused ? selPath() : null, sc = $('#edScroll').scrollTop;
    if ($('#edTitle').textContent !== doc.title) $('#edTitle').textContent = doc.title;
    if (edBody().innerHTML !== doc.html) edBody().innerHTML = doc.html;
    if (sel) { try { restoreSel(sel); } catch (e) { /* le texte a trop changé */ } }
    $('#edScroll').scrollTop = sc;
    $('.sheet').classList.toggle('night', !!doc.night);
    histCommit();
    $('#edStatus').textContent = 'Mis à jour par l’autre personne';
    requestAnimationFrame(renderPeers);
  }
  async function shareTick(doc) {
    const sh = doc && doc.share, ref = shareRef(sh);
    if (!ref || !NATIVE || shareBusy || inkBusy()) return;
    shareBusy = true;
    const here = () => view === 'editor' && edDoc === doc;
    try {
      if (here()) commitEditor();
      const mine = doc.html + doc.title;
      let remote = null;
      const text = await call('shareRead', { ref, file: sh.file });
      if (text) { try { remote = JSON.parse(text); } catch (e) { /* fichier en cours d'écriture : au prochain passage */ return; } }
      // on a écrit pendant la lecture : on recommencera avec le texte à jour
      if (here()) commitEditor();
      if (doc.html + doc.title !== mine) return shareSoon();
      const moved = shareAbsorb(doc, remote);
      if (!sh.base) sh.base = { title: doc.title, html: doc.html, look: lookOf(doc) };
      const lookHere = JSON.stringify(lookOf(doc));
      if (!remote || doc.html !== remote.html || doc.title !== remote.title || lookHere !== JSON.stringify(remote.look || {})) {
        const rev = uid();
        await call('shareWrite', { ref, file: sh.file, text: JSON.stringify(shareState(doc, rev)) });
        sh.rev = rev;
        sh.base = { title: doc.title, html: doc.html, look: lookOf(doc) };
      }
      if (moved) shareShow(doc);
      persist();
    } catch (e) {
      console.error(e);
    } finally {
      shareBusy = false;
    }
  }

  /* À proximité (même Wi-Fi, ou Bluetooth) : les deux appareils se parlent directement. La note passe à chaque frappe,
   * et chacun voit le curseur de l'autre, comme entre ses propres appareils. */
  let shareLinked = null;
  function shareLinkStart(doc) {
    const key = doc && doc.share && shareRef(doc.share) ? 'note:' + doc.share.id : null;
    if (!NATIVE || key === shareLinked) return;
    shareLinked = key;
    call('sharePeerStart', key || '').catch(() => {});
  }
  function shareSendLive(doc) {
    if (shareLinked !== 'note:' + doc.share.id || inkBusy()) return;
    commitEditor();
    const rev = uid();
    const st = shareState(doc, rev);
    st.from = sh0(doc);
    call('sharePeerSend', JSON.stringify({ note: st })).then(() => {
      // l'autre l'a reçue : elle devient notre point commun
      if (doc.html === st.html && doc.title === st.title) { doc.share.rev = rev; doc.share.base = { title: st.title, html: st.html, look: st.look }; }
    }).catch(() => {});
  }
  const sh0 = doc => doc.share.rev || '';
  window.__shareIncoming = text => appReady.then(() => {
    let o = null;
    try { o = JSON.parse(text); } catch (e) { return; }
    const doc = view === 'editor' && edDoc && edDoc.share ? edDoc : null;
    if (!doc) return;
    if (o.presence) { if (o.presence.doc === 'note:' + doc.share.id) receivePresence(Object.assign(o.presence, { doc: doc.id })); return; }
    if (!o.note || o.note.id !== doc.share.id || inkBusy()) return;
    commitEditor();
    // la version reçue part du même point que nous : c'est une simple mise à jour, sinon une fusion
    if (shareAbsorb(doc, o.note)) { shareShow(doc); persist(); }
  });
  function shareSendPresence() {
    if (!edDoc || !edDoc.share || shareLinked !== 'note:' + edDoc.share.id) return;
    const me = { id: ME.id, dev: 'L’autre personne · ' + quickDevice(), color: '#2f8f6b', doc: 'note:' + edDoc.share.id, sel: mySelection() };
    call('sharePeerSend', JSON.stringify({ presence: me })).catch(() => {});
  }
  setInterval(() => {
    shareLinkStart(view === 'editor' ? edDoc : null);
    if (view === 'editor' && edDoc && edDoc.share && !document.hidden) { shareTick(edDoc); shareSendPresence(); }
  }, 4000);

  const shareName = t => ((t || '').replace(/[\/\\:*?"<>|.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Note');
  async function shareStart() {
    if (!NATIVE) return toast('Le partage se fait dans l’app, sur Mac, iPad ou iPhone');
    const pick = await call('sharePick', 'Choisissez un dossier iCloud Drive partagé avec l’autre personne (dans le Finder : clic droit sur le dossier › Partager)');
    if (!pick) return;
    const doc = edDoc;
    commitEditor();
    doc.share = { id: uid(), file: `${shareName(doc.title)} ${doc.id.slice(0, 5)}.espnote`, folder: pick.name, refs: { [SHARE_DEV()]: pick.ref }, rev: null, base: null };
    await shareTick(doc);
    persist();
    toast(`Note partagée dans « ${pick.name} ». L’autre personne fait Fichier › Rejoindre une note partagée`);
  }
  async function shareRelink() {
    const pick = await call('sharePick', `Retrouvez le dossier « ${edDoc.share.folder} » sur cet appareil`);
    if (!pick) return;
    edDoc.share.refs = Object.assign({}, edDoc.share.refs, { [SHARE_DEV()]: pick.ref });
    persist();
    shareTick(edDoc);
  }
  function shareStop() {
    delete edDoc.share;
    persist();
    toast('Cette note n’est plus partagée ici (le fichier reste dans le dossier)');
  }
  async function shareJoin() {
    if (!NATIVE) return toast('Le partage se fait dans l’app, sur Mac, iPad ou iPhone');
    const pick = await call('sharePick', 'Choisissez le dossier iCloud Drive qu’on a partagé avec vous');
    if (!pick) return;
    const files = await call('shareList', pick.ref);
    if (!files || !files.length) return toast(`Aucune note partagée dans « ${pick.name} » (elle est peut-être encore en téléchargement)`);
    const join = async file => {
      const text = await call('shareRead', { ref: pick.ref, file });
      let r = null;
      try { r = JSON.parse(text); } catch (e) { /* illisible */ }
      if (!r || !r.espnote) return toast('Cette note n’est pas encore arrivée : réessayez dans un instant');
      for (const sp of state.spaces) for (const d of sp.docs) if (d.share && d.share.id === r.id) {
        d.share.refs = Object.assign({}, d.share.refs, { [SHARE_DEV()]: pick.ref });
        persist();
        return openDoc(d.id);
      }
      const sp = space() || state.spaces.find(x => !isCloudRoot(x)) || state.spaces[0];
      const doc = newDoc(sp, Object.assign({ title: r.title, html: r.html, share: { id: r.id, file, folder: pick.name, refs: { [SHARE_DEV()]: pick.ref }, rev: r.rev, by: r.by || '', base: { title: r.title, html: r.html, look: r.look || {} } } }, r.look || {}));
      openDoc(doc.id);
      toast('Note partagée ouverte : vos modifications se retrouvent chez l’autre personne');
    };
    if (files.length === 1) return join(files[0]);
    showMenu(innerWidth / 2 - 120, innerHeight / 3, [{ head: `Notes partagées dans « ${pick.name} »` }, ...files.map(f => ({ label: f.replace(/\.espnote$/, ''), act: () => join(f) }))]);
  }

  async function toggleSync() {
    if (sync.on) {
      // en deux temps : un premier choix prévient, le second (dans les 4 s) arrête
      if (Date.now() - (sync.armed || 0) > 4000) {
        sync.armed = Date.now();
        toast('Touchez encore pour arrêter. Vos espaces restent.');
        return;
      }
      await call('syncStop');
      sync.on = false;
      paintSyncItem(null);
      toast('Synchronisation arrêtée sur cet appareil');
      return;
    }
    const st = await call('syncSetup');
    if (!st || !st.enabled) return;
    sync.on = true;
    paintSyncItem(st);
    await syncNow();
    if (view === 'space') enterSpace(state.current, { instant: true, keepRotation: true });
    paintPhoneNav();
    if (PHONE) {
      const n = cloudSubset().spaces.filter(s => !isCloudRoot(s) && s.id !== QUICK_ID).length;
      toast(sync.foundFile ? `iCloud connecté : ${n > 1 ? n + ' espaces retrouvés' : n ? '1 espace retrouvé' : 'aucun espace partagé pour le moment'}` : 'Ce dossier ne contient pas encore vos espaces : choisissez iCloud Drive › Espaces, le même dossier que sur le Mac');
      return;
    }
    toast('Synchronisation activée');
  }

  /* ───────────── Présence : le curseur de l'autre appareil, en direct ───────────── */

  /*
   * Par le lien direct (même réseau), chaque appareil dit où il se trouve : quelle carte est ouverte, et où est
   * son curseur (ou sa sélection). L'autre l'affiche à sa couleur, avec son nom, comme dans un document partagé.
   */
  const ME = Object.assign(window.__PLATFORM === 'ipad' ? { name: 'iPad', color: '#3d7fd6' } : { name: 'Mac', color: '#c93470' }, { id: uid() });
  const presence = { peers: new Map(), timer: null, beat: null, sent: '' };
  const nodePath = (root, n) => { const p = []; for (let x = n; x && x !== root; x = x.parentNode) { if (!x.parentNode) return null; p.unshift(Array.prototype.indexOf.call(x.parentNode.childNodes, x)); } return p; };
  const nodeAt = (root, p) => { let n = root; for (const i of p || []) { if (!n.childNodes[i]) return null; n = n.childNodes[i]; } return n; };
  function mySelection() {
    const s = document.getSelection();
    if (!s.rangeCount) return null;
    const title = $('#edTitle'), body = edBody();
    const where = n => (title.contains(n) ? { root: 't', p: nodePath(title, n) } : body.contains(n) ? { root: 'b', p: nodePath(body, n) } : null);
    const a = where(s.anchorNode), f = where(s.focusNode);
    return a && f ? { a, ao: s.anchorOffset, f, fo: s.focusOffset } : null;
  }
  function sendPresence(force) {
    if (!sync.on || !state.linkKey || READONLY) return;
    const me = { id: ME.id, dev: ME.name, color: ME.color, doc: view === 'editor' && edDoc ? edDoc.id : null, sel: view === 'editor' ? mySelection() : null };
    const text = JSON.stringify(me);
    if (!force && text === presence.sent) return;
    presence.sent = text;
    call('peerSend', JSON.stringify({ presence: me, linkKey: state.linkKey })).catch(() => {});
  }
  const schedulePresence = () => { clearTimeout(presence.timer); presence.timer = setTimeout(() => { sendPresence(); shareSendPresence(); }, 120); };

  function receivePresence(p) {
    if (!p || !p.id || p.id === ME.id) return;
    presence.peers.set(p.id, Object.assign(p, { at: Date.now() }));
    renderPeers();
  }

  // les curseurs des autres, posés dans la page : un trait à leur couleur, leur nom au-dessus, leur sélection en surbrillance
  function renderPeers() {
    const scroll = $('#edScroll');
    let layer = $('#peerLayer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'peerLayer'; scroll.append(layer); }
    layer.textContent = '';
    if (view !== 'editor' || !edDoc) return;
    const base = scroll.getBoundingClientRect(), now = Date.now();
    for (const [key, p] of presence.peers) {
      const dev = p.dev;
      if (now - p.at > 20000) { presence.peers.delete(key); continue; }
      if (p.doc !== edDoc.id || !p.sel) continue;
      const pick = (w, off) => {
        const root = w.root === 't' ? $('#edTitle') : edBody(), n = nodeAt(root, w.p);
        return n ? [n, Math.min(off, n.nodeType === 3 ? n.length : n.childNodes.length)] : null;
      };
      const A = pick(p.sel.a, p.sel.ao), F = pick(p.sel.f, p.sel.fo);
      if (!A || !F) continue;
      const r = document.createRange();
      try {
        r.setStart(...A); r.setEnd(...A);
        const sel = document.createRange();
        // dans un sens ou dans l'autre : la sélection va de l'ancre au point le plus loin
        if (A[0].compareDocumentPosition(F[0]) & Node.DOCUMENT_POSITION_PRECEDING || (A[0] === F[0] && F[1] < A[1])) { sel.setStart(...F); sel.setEnd(...A); } else { sel.setStart(...A); sel.setEnd(...F); }
        if (!sel.collapsed) for (const b of sel.getClientRects()) {
          const h = document.createElement('i');
          h.className = 'peer-sel';
          Object.assign(h.style, { left: (b.left - base.left) + 'px', top: (b.top - base.top + scroll.scrollTop) + 'px', width: b.width + 'px', height: b.height + 'px', background: p.color });
          layer.append(h);
        }
        const c = document.createRange();
        c.setStart(...F); c.collapse(true);
        let b = c.getClientRects()[0] || c.getBoundingClientRect();
        if (!b || (!b.height && F[0].nodeType !== 3)) { const el = F[0].nodeType === 1 ? F[0] : F[0].parentNode; b = el.getBoundingClientRect(); }
        const caret = document.createElement('div');
        caret.className = 'peer-caret';
        caret.style.setProperty('--pc', p.color);
        Object.assign(caret.style, { left: (b.left - base.left) + 'px', top: (b.top - base.top + scroll.scrollTop) + 'px', height: Math.max(16, b.height) + 'px' });
        caret.innerHTML = `<span>${esc(dev)}</span>`;
        layer.append(caret);
      } catch (e) { /* le texte a changé sous ce curseur : il reviendra au prochain mouvement */ }
    }
  }

  function bindPresence() {
    if (!NATIVE) return;
    document.addEventListener('selectionchange', () => { if (view === 'editor') schedulePresence(); });
    // le texte bouge sous les curseurs des autres : on les repose
    for (const el of [edBody(), $('#edTitle')]) el.addEventListener('input', () => { if (sync.on) requestAnimationFrame(renderPeers); });
    addEventListener('resize', () => requestAnimationFrame(renderPeers));
    // un battement régulier : un appareil qui arrive voit tout de suite où sont les autres ; les absents disparaissent
    presence.beat = setInterval(() => { sendPresence(true); renderPeers(); }, 5000);
  }

  /* ───────────── Exporter la page : PDF, Word, Pages ───────────── */

  // la page seule (titre et texte), sans la mise en scène
  function pageForExport() {
    commitEditor();
    const box = document.createElement('div');
    box.innerHTML = edDoc.html;
    for (const el of $$('[contenteditable]', box)) el.removeAttribute('contenteditable');
    for (const el of $$('[data-audio]', box)) el.removeAttribute('data-audio');
    return { title: edDoc.title || 'Sans titre', body: box };
  }
  const exportName = () => (edDoc.title || 'Sans titre').replace(/[\/\\:*?"<>|]+/g, '-').slice(0, 120);

  // le diaporama en PDF : une page 16:9 par diapositive, mises en forme comme à l'écran
  const SLIDE_W = 1280, SLIDE_H = 720;
  async function exportSlides() {
    if (!edDoc) return;
    commitEditor();
    const stage = document.createElement('div');
    stage.className = 'rd-stage rd-slides';
    stage.style.cssText = `position:fixed;left:-99999px;top:0;width:${SLIDE_W}px;height:${SLIDE_H}px`;
    const track = document.createElement('div');
    track.className = 'rd-track';
    track.append(slideCover(edDoc), ...groupsOf(edDoc, 'slides').map(p => slideOf(edDoc, p)));
    stage.append(track);
    document.body.append(stage);
    $$('.rd-sub', track).forEach(s => s.remove());
    for (const el of $$('[contenteditable], [data-audio]', track)) { el.removeAttribute('contenteditable'); el.removeAttribute('data-audio'); }
    const slides = $$('.rd-slide', track);
    track.style.cssText = 'position:static;display:block;height:auto';
    slides.forEach(s => { s.style.padding = '64px 104px 72px'; s.style.height = SLIDE_H + 'px'; });
    await Promise.all($$('img', track).map(im => im.decode().catch(() => {})));
    fitSlideImages(slides);
    stage.style.cssText = `position:static;width:${SLIDE_W}px;height:auto`;
    const cuts = slides.map((s, i) => (i + 1) * SLIDE_H);
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>html, body { margin: 0; background: #f6f5f1 !important; width: ${SLIDE_W}px; height: auto !important; overflow: visible !important; position: static !important; } .rd-slides { overflow: visible !important; } .rd-slide { overflow: hidden !important; box-sizing: border-box; }</style></head>`
      + `<body>${stage.outerHTML}<script>window.__breaks = function () { return ${JSON.stringify(cuts)}; };</script></body></html>`;
    stage.remove();
    try {
      const r = await call('exportPDF', { html, name: exportName(), width: SLIDE_W, height: SLIDE_H });
      if (r) toast('PDF enregistré : ' + r);
    } catch (e) {
      console.error(e);
      toast('Export impossible : ' + (e.message || e));
    }
  }

  async function exportPage(kind) {
    if (!edDoc) return;
    const { title, body } = pageForExport();
    try {
      if (kind === 'pdf') {
        const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>${PRINT_CSS}</style></head>`
          + `<body class="print"><article class="page"><h1 class="print-title">${esc(title)}</h1><div class="prose">${body.innerHTML}</div></article>`
          + `<script>${PRINT_BREAKS}</script></body></html>`;
        const r = await call('exportPDF', { html, name: exportName() });
        if (r) toast('PDF enregistré : ' + r);
        return;
      }
      toast('Préparation du document…');
      await inkForWord(body);
      const data = await buildDocx(title, body);
      const r = await call('saveFile', { name: exportName(), ext: 'docx', data, open: kind === 'pages' ? 'pages' : '' });
      if (r) toast(kind === 'pages' ? 'Ouvert dans Pages (enregistrez-le en .pages depuis Pages)' : 'Document Word enregistré : ' + r);
    } catch (e) {
      console.error(e);
      toast('Export impossible : ' + (e.message || e));
    }
  }
  function exportMenu(x, y) {
    showMenu(x, y, [
      { head: 'Exporter la page' },
      { label: 'PDF', act: () => exportPage('pdf') },
      edDoc && edDoc.present === 'slides' ? { label: 'Diaporama en PDF', act: exportSlides } : null,
      { label: 'Word (.docx)', act: () => exportPage('docx') },
      { label: 'Ouvrir dans Pages', act: () => exportPage('pages') },
      '-',
      { head: 'Travailler à deux' },
      !edDoc || !edDoc.share ? { label: 'Partager cette note…', act: shareStart } : { label: `Partagée dans « ${edDoc.share.folder} »`, off: true },
      edDoc && edDoc.share && !shareRef(edDoc.share) ? { label: 'Retrouver le dossier sur cet appareil…', act: shareRelink } : null,
      edDoc && edDoc.share ? { label: 'Arrêter le partage', act: shareStop } : null
    ]);
  }

  // où couper les pages : au plus près du bas de la page, sous un bloc (paragraphe, image, titre, ligne de liste…)
  const PRINT_BREAKS = `window.__breaks = function (h) {
    var page = document.querySelector('.page'), ends = [];
    // le bas de chaque ligne de texte, et de chaque image : on ne coupe jamais au milieu
    var walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT), r = document.createRange(), t;
    while ((t = walker.nextNode())) {
      if (!t.textContent.trim()) continue;
      r.selectNodeContents(t);
      var rects = r.getClientRects();
      for (var i = 0; i < rects.length; i++) ends.push(rects[i].bottom + window.scrollY);
    }
    document.querySelectorAll('.page img, .page hr, .page li, .prose > *').forEach(function (e) { ends.push(e.getBoundingClientRect().bottom + window.scrollY); });
    // une feuille manuscrite peut se couper d'une page à l'autre, mais seulement entre deux lignes d'écriture
    document.querySelectorAll('.page .ix-ink').forEach(function (b) {
      var svg = b.querySelector('svg'); if (!svg) return;
      var r = svg.getBoundingClientRect(), u = r.width / 1000, top = r.top + window.scrollY, iv = [];
      svg.querySelectorAll('path').forEach(function (p) {
        try { var bb = p.getBBox(), pad = (+p.getAttribute('data-w') || 4) / 2 + 5; iv.push([bb.y - pad, bb.y + bb.height + pad]); } catch (e) {}
      });
      for (var y = top + 100; y < top + r.height - 60; y += 8) {
        var uy = (y - top) / u, free = true;
        for (var i = 0; i < iv.length; i++) if (uy > iv[i][0] && uy < iv[i][1]) { free = false; break; }
        if (free) ends.push(y);
      }
    });
    ends.sort(function (a, b) { return a - b; });
    var total = Math.ceil(page.getBoundingClientRect().bottom + window.scrollY), out = [], y = 0;
    while (total - y > 1) {
      var lim = y + h;
      if (total <= lim) { out.push(total); break; }
      var best = 0;
      for (var k = 0; k < ends.length; k++) if (ends[k] > y + 20 && ends[k] <= lim) best = ends[k];
      var c = Math.ceil(best || lim);
      out.push(c);
      y = c;
    }
    return out;
  };`;

  // la mise en page imprimée : la page seule, en A4, sans interface
  const PRINT_CSS = `
    html, body { background: #fff !important; height: auto !important; min-height: 0 !important; overflow: visible !important; position: static !important; }
    body.print { margin: 0; color: #111; width: 483px; }
    body.print .page { max-width: none; width: 483px; margin: 0; padding: 0; }
    .print-title { font: 600 30px/1.1 var(--sans); letter-spacing: -.02em; margin: 0 0 24px; }
    .prose { font-size: 15.5px; }
    .prose img { max-width: 100%; height: auto; break-inside: avoid; }
    .prose :is(blockquote, pre, .callout, figure, li) { break-inside: avoid; }
    .prose :is(h1, h2, h3) { break-after: avoid; }
    [data-ix] { box-shadow: none !important; }
  `;

  /* Word (.docx) : un vrai document, écrit ici même (titres, gras, italique, listes, citations, images). */
  async function buildDocx(title, root) {
    const X = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const media = [];
    let drawingId = 1;
    // les images : PNG ou JPEG (Word ne lit pas le WebP), et leur taille pour la page
    const imageRun = async img => {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('data:')) return '';
      const el = new Image();
      el.src = src;
      try { await el.decode(); } catch (e) { return ''; }
      let mime = /^data:([^;]+)/.exec(src)[1], b64 = src.split(',')[1];
      if (!/^image\/(png|jpeg)$/.test(mime)) {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth; c.height = el.naturalHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        b64 = c.toDataURL('image/png').split(',')[1]; mime = 'image/png';
      }
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const n = media.length + 1, ext = mime === 'image/png' ? 'png' : 'jpeg';
      media.push({ name: `word/media/image${n}.${ext}`, data: bytes, rid: 'rIdImg' + n, target: `media/image${n}.${ext}` });
      // au plus la largeur du texte (16 cm), proportions gardées
      const maxW = 6048000, w = Math.min(maxW, el.naturalWidth * 9525), h = Math.round(w * el.naturalHeight / Math.max(1, el.naturalWidth));
      const id = drawingId++;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${id}" name="Image ${id}"/>`
        + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
        + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
        + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    };
    // le texte d'un bloc, avec sa mise en forme
    const runs = async (node, f = {}) => {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const t = n.textContent.replace(/\s+/g, ' ');
          if (!t) continue;
          const pr = (f.b ? '<w:b/>' : '') + (f.i ? '<w:i/>' : '') + (f.u ? '<w:u w:val="single"/>' : '') + (f.s ? '<w:strike/>' : '')
            + (f.mono ? '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/>' : '') + (f.color ? `<w:color w:val="${f.color}"/>` : '');
          out += `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${X(t)}</w:t></w:r>`;
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName, g = Object.assign({}, f);
        if (tag === 'BR') { out += '<w:r><w:br/></w:r>'; continue; }
        if (tag === 'IMG') { out += await imageRun(n); continue; }
        if (/^(B|STRONG)$/.test(tag)) g.b = true;
        if (/^(I|EM)$/.test(tag)) g.i = true;
        if (tag === 'U') g.u = true;
        if (/^(S|STRIKE|DEL)$/.test(tag)) g.s = true;
        if (tag === 'CODE') g.mono = true;
        if (tag === 'A') { g.u = true; g.color = 'C93470'; }
        const m = /color:\s*(#[0-9a-f]{6}|rgb\([^)]+\))/i.exec(n.getAttribute('style') || '');
        if (m) g.color = m[1].startsWith('#') ? m[1].slice(1).toUpperCase() : m[1].match(/\d+/g).slice(0, 3).map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
        out += await runs(n, g);
      }
      return out;
    };
    const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
    const style = s => `<w:pStyle w:val="${s}"/>`;
    // les blocs de la page, un à un
    const blocks = async (node, depth = 0) => {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) { if (n.textContent.trim()) out += para(`<w:r><w:t xml:space="preserve">${X(n.textContent.trim())}</w:t></w:r>`); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (/^H[1-3]$/.test(tag)) out += para(await runs(n), style('Heading' + tag[1]));
        else if (tag === 'P') out += para(await runs(n));
        else if (tag === 'IMG') out += para(await imageRun(n), '<w:jc w:val="center"/>');
        else if (tag === 'TABLE' || (n.dataset && /^(chart|map)$/.test(n.dataset.ix))) {
          // un graphique part dans Word sous la forme d'un tableau de ses données
          const rows = tag === 'TABLE' ? [...n.rows].map(r => [...r.cells].map(c => c.textContent)) : n.dataset.ix === 'map' ? [['', n.dataset.x, n.dataset.y], ...JSON.parse(n.dataset.points || '[]').map(p => [p.n, Math.round(p.x) + ' %', Math.round(100 - p.y) + ' %'])] : chartRows(n.dataset.data).map(r => [r.label, chartNum(r.value) + (r.unit ? ' ' + r.unit : '')]);
          if (tag !== 'TABLE' && n.dataset.title) out += para(`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${X(n.dataset.title)}</w:t></w:r>`);
          const line = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(k => `<w:${k} w:val="single" w:sz="4" w:color="BBBBBB"/>`).join('');
          out += `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${line}</w:tblBorders></w:tblPr>${rows.map(r => `<w:tr>${r.map(c => `<w:tc><w:p><w:r><w:t xml:space="preserve">${X(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` + para('');
        } else if (tag === 'HR') out += para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>');
        else if (tag === 'BLOCKQUOTE') {
          const inner = n.querySelector('p') ? n : null;
          if (inner) for (const p of n.children) out += para(await runs(p), style('Quote'));
          else out += para(await runs(n), style('Quote'));
        } else if (tag === 'PRE') {
          const lines = n.textContent.split('\n').map(l => `<w:r><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${X(l)}</w:t></w:r>`);
          out += para(lines.join('<w:r><w:br/></w:r>'), '<w:shd w:val="clear" w:color="auto" w:fill="F3EFF1"/>');
        } else if (tag === 'UL' || tag === 'OL') {
          let k = 0;
          const todo = n.classList.contains('todo');
          for (const li of n.children) {
            if (li.tagName !== 'LI') continue;
            k++;
            const mark = todo ? (li.classList.contains('done') ? '☑ ' : '☐ ') : tag === 'OL' ? k + '. ' : '• ';
            const own = li.cloneNode(true);
            for (const sub of $$(':scope > ul, :scope > ol', own)) sub.remove();
            const ind = 360 * (depth + 1);
            out += para(`<w:r><w:t xml:space="preserve">${mark}</w:t></w:r>` + await runs(own), `<w:ind w:left="${ind + 280}" w:hanging="280"/>`);
            for (const sub of $$(':scope > ul, :scope > ol', li)) out += await blocks({ childNodes: [sub] }, depth + 1);
          }
        } else if (tag === 'DETAILS') {
          const sum = n.querySelector('summary');
          if (sum) out += para(await runs(sum, { b: true }));
          const rest = n.cloneNode(true);
          const s2 = rest.querySelector('summary'); if (s2) s2.remove();
          out += await blocks(rest, depth);
        } else if (n.classList && n.classList.contains('callout')) {
          out += para(await runs(n), '<w:shd w:val="clear" w:color="auto" w:fill="F3EFF1"/><w:ind w:left="240" w:right="240"/>');
        } else if (n.querySelector && n.querySelector('p, h1, h2, h3, ul, ol, img, blockquote, pre, div')) out += await blocks(n, depth);
        else if (n.textContent.trim()) out += para(await runs(n));
      }
      return out;
    };
    const content = para(`<w:r><w:t xml:space="preserve">${X(title)}</w:t></w:r>`, style('Title')) + await blocks(root);
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${content}`
      + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const font = (a, sz, extra = '') => `<w:rPr><w:rFonts w:ascii="${a}" w:hAnsi="${a}" w:cs="${a}"/>${sz ? `<w:sz w:val="${sz}"/>` : ''}${extra}</w:rPr>`;
    const head = (id, name, sz, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
      + `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/></w:pPr>${font('Helvetica Neue', sz, '<w:b/>')}</w:style>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
      + `<w:docDefaults><w:rPrDefault>${font('Georgia', 23)}</w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
      + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
      + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="360"/></w:pPr>${font('Helvetica Neue', 56, '<w:b/>')}</w:style>`
      + head('Heading1', 'heading 1', 40, 360) + head('Heading2', 'heading 2', 32, 300) + head('Heading3', 'heading 3', 26, 240)
      + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="C93470"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="444444"/></w:rPr></w:style>`
      + `</w:styles>`;
    const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`).join('')
      + `</Relationships>`;
    const enc = s => new TextEncoder().encode(s);
    const bytes = zipStore([
      { name: '[Content_Types].xml', data: enc(types) }, { name: '_rels/.rels', data: enc(rels) },
      { name: 'word/document.xml', data: enc(doc) }, { name: 'word/styles.xml', data: enc(styles) },
      { name: 'word/_rels/document.xml.rels', data: enc(docRels) }, ...media
    ]);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // une archive ZIP sans compression (ce que demande le format .docx), avec ses sommes de contrôle
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zipStore(files) {
    const parts = [], central = [];
    let offset = 0;
    const u16 = v => [v & 0xFF, v >>> 8 & 0xFF], u32 = v => [v & 0xFF, v >>> 8 & 0xFF, v >>> 16 & 0xFF, v >>> 24 & 0xFF];
    for (const f of files) {
      const name = new TextEncoder().encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = Uint8Array.from([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
      parts.push(local, name, f.data);
      central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += local.length + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  /* ───────────── Présentation par pages (A4) dans l'éditeur ───────────── */

  /*
   * Comme la vue « page » d'un traitement de texte : le texte se pose sur des feuilles A4 blanches, l'une sous l'autre,
   * avec leurs marges. Un bloc qui chevaucherait deux feuilles passe à la suivante. Rien n'est écrit dans le texte :
   * les sauts sont des marges ajoutées par une feuille de style, recalculées à chaque frappe.
   */
  const A4 = { W: 794, H: 1123, M: 90, G: 28 };       // en pixels CSS (96 ppp) : largeur, hauteur, marge, écart entre feuilles
  const a4 = { on: false, raf: 0 };
  try { a4.on = localStorage.getItem('espaces.a4') === '1'; } catch (e) { /* stockage indisponible : mode continu */ }

  function setA4(on) {
    a4.on = on;
    try { localStorage.setItem('espaces.a4', on ? '1' : '0'); } catch (e) { /* tant pis */ }
    $('.sheet').classList.toggle('a4', on);
    layoutA4();
    requestAnimationFrame(renderPeers);
  }
  const scheduleA4 = () => { if (!a4.on || ink.full) return; cancelAnimationFrame(a4.raf); a4.raf = requestAnimationFrame(layoutA4); };

  function layoutA4() {
    // pendant qu'une feuille manuscrite est agrandie, la page ne bouge pas : on remet en page en sortant
    if (document.body.classList.contains('ink-full')) return;
    let style = $('#a4Style');
    if (!style) { style = document.createElement('style'); style.id = 'a4Style'; document.head.append(style); }
    style.textContent = '';
    const page = $('#edScroll .page');
    let layer = $('#a4Sheets');
    if (!a4.on || view !== 'editor') { if (layer) layer.textContent = ''; if ($('#a4Ink')) $('#a4Ink').textContent = ''; return; }
    if (!layer) { layer = document.createElement('div'); layer.id = 'a4Sheets'; page.prepend(layer); }
    // à l'écran étroit (iPad en portrait), les feuilles se réduisent pour tenir en largeur
    const room = $('#edScroll').clientWidth - 40, z = Math.min(1, room / A4.W);
    page.style.setProperty('--a4z', z.toFixed(4));
    const box = page.getBoundingClientRect(), k = box.width / page.offsetWidth || 1;
    const top = el => (el.getBoundingClientRect().top - box.top) / k, bottom = el => (el.getBoundingClientRect().bottom - box.top) / k;
    const pitch = A4.H + A4.G, contentH = A4.H - 2 * A4.M;
    // les blocs à poser : ceux du texte ; un bloc plus haut qu'une page est découpé en ses enfants (lignes de liste, paragraphes d'un encadré…)
    const units = [{ el: $('#edTitle'), sel: '#edTitle' }];
    Array.from(edBody().children).forEach((c, i) => {
      const sel = `#edBody > :nth-child(${i + 1})`;
      if (bottom(c) - top(c) > contentH && c.children.length > 1 && !c.matches('[data-ix], img, pre')) Array.from(c.children).forEach((cc, j) => units.push({ el: cc, sel: `${sel} > :nth-child(${j + 1})` }));
      else units.push({ el: c, sel });
    });
    // on pose les blocs un à un, en mesurant après chaque saut ajouté (il n'y en a qu'un ou deux par feuille)
    let prevBottom = A4.M, rules = '';
    const apply = r => { rules += r; style.textContent = rules; };
    const sheets = [];
    for (const u of units) {
      // une feuille manuscrite plus longue que la place qui reste continue sur la feuille A4 suivante
      if (u.el.matches('.ix-ink')) {
        const t = top(u.el), p = Math.floor(t / pitch), contentTop = p * pitch + A4.M, contentBottom = p * pitch + A4.H - A4.M;
        const sh = inkSvg(u.el).getBoundingClientRect().height / k, gap = Math.max(0, t - prevBottom);
        let at = t;
        if (t < contentTop - 1) { apply(`.sheet.a4 ${u.sel} { margin-top: ${(gap + contentTop - t).toFixed(1)}px !important; }\n`); at = contentTop; }
        else if (t + sh > contentBottom + 1 && contentBottom - t < 140) {
          // trop peu de place en bas de la feuille : la feuille manuscrite commence sur la suivante
          apply(`.sheet.a4 ${u.sel} { margin-top: ${(gap + contentTop + pitch - t).toFixed(1)}px !important; }\n`);
          at = contentTop + pitch;
        }
        const parts = inkA4Parts(at, sh, pitch);
        if (parts.length > 1) {
          const sel = `body:not(.ink-full) .sheet.a4 ${u.sel}`;
          apply(`${sel} { padding-bottom: ${((parts.length - 1) * (2 * A4.M + A4.G)).toFixed(1)}px !important; background: transparent !important; box-shadow: none !important; }\n`
            + `${sel} > .ink-svg { visibility: hidden; }\n`);
          sheets.push(u.el);
        }
        prevBottom = bottom(u.el);
        continue;
      }
      const t = top(u.el), h = bottom(u.el) - t;
      const p = Math.floor(t / pitch), pageTop = p * pitch, contentTop = pageTop + A4.M, contentBottom = pageTop + A4.H - A4.M;
      const gap = Math.max(0, t - prevBottom);
      if (t < contentTop - 1) apply(`.sheet.a4 ${u.sel} { margin-top: ${(gap + contentTop - t).toFixed(1)}px !important; }\n`);
      else if (t + h > contentBottom + 1) {
        if (h <= contentH && t > contentTop + 1) apply(`.sheet.a4 ${u.sel} { margin-top: ${(gap + contentTop + pitch - t).toFixed(1)}px !important; }\n`);
        else if (u.el.tagName === 'P') {
          // un paragraphe plus long qu'une feuille se coupe entre deux lignes : une bande invisible, à la frontière,
          // que le texte contourne (shape-outside) ; les lignes suivantes reprennent en haut de la feuille d'après
          const band = 2 * A4.M + A4.G, pts = [];
          let end = h, q = p, last = 0;
          for (; q * pitch + A4.H - A4.M < t + end; q++) {
            const a = q * pitch + A4.H - A4.M - t;
            pts.push(`0 ${a}px`, `100% ${a}px`, `100% ${a + band}px`, `0 ${a + band}px`);
            end += band;
            last = a + band;
          }
          if (pts.length) apply(`.sheet.a4 ${u.sel}::before { content: ""; float: left; width: 100%; height: ${last}px; shape-outside: polygon(0 0, ${pts.join(', ')}); }\n`);
        }
      }
      prevBottom = bottom(u.el);
    }
    const pages = Math.max(1, Math.ceil((prevBottom + A4.M) / pitch));
    apply(`.sheet.a4 #edScroll .page { min-height: ${pages * pitch - A4.G}px; }\n`);
    inkA4Paint(page, sheets, top, k, box, pitch);
    if (layer.children.length !== pages) layer.innerHTML = Array.from({ length: pages }, (_, i) => `<i style="top:${i * pitch}px"><b>${i + 1}</b></i>`).join('');
  }

  // les morceaux d'une feuille manuscrite posée à cheval sur plusieurs feuilles A4 : [début dans la page, décalage dans la feuille, hauteur]
  function inkA4Parts(at, sh, pitch) {
    const band = 2 * A4.M + A4.G, parts = [];
    let off = 0, y = at;
    while (off < sh - .5) {
      const room = Math.floor(y / pitch) * pitch + A4.H - A4.M - y, len = Math.max(1, Math.min(room, sh - off));
      parts.push({ y, off, len });
      off += len;
      y += len + band;
    }
    return parts;
  }

  /*
   * La feuille manuscrite elle-même garde sa place (et sa hauteur, plus les écarts entre les feuilles A4) ; par-dessus,
   * ses morceaux, un par feuille A4, chacun montrant la bonne partie des traits. Rien de tout cela n'entre dans la page :
   * c'est un calque à part, refait à chaque mise en page.
   */
  function inkA4Paint(page, sheets, top, k, box, pitch) {
    let layer = $('#a4Ink');
    if (!sheets.length) { if (layer) layer.textContent = ''; return; }
    if (!layer) { layer = document.createElement('div'); layer.id = 'a4Ink'; layer.className = 'prose'; page.append(layer); }
    layer.textContent = '';
    for (const blk of sheets) {
      const svg = inkSvg(blk), sh = svg.getBoundingClientRect().height / k, r = blk.getBoundingClientRect();
      const parts = inkA4Parts(top(blk), sh, pitch), left = (r.left - box.left) / k, width = r.width / k;
      parts.forEach((pt, i) => {
        const s = document.createElement('div');
        s.dataset.for = blk.dataset.id;
        s.className = 'ix-ink ink-slice' + (i ? ' cut-t' : '') + (i < parts.length - 1 ? ' cut-b' : ' last');
        s.dataset.paper = blk.dataset.paper || 'lignes';
        s.style.cssText = `left:${left.toFixed(1)}px; top:${pt.y.toFixed(1)}px; width:${width.toFixed(1)}px; height:${pt.len.toFixed(1)}px;`;
        const c = svg.cloneNode(true);
        c.removeAttribute('id');
        c.style.cssText = `position:absolute; left:0; top:${(-pt.off).toFixed(1)}px; width:100%; height:auto; visibility:visible;`;
        s.appendChild(c);
        if (i) s.insertAdjacentHTML('beforeend', '<span class="ink-cont">suite</span>');
        layer.appendChild(s);
      });
    }
    // mesurée pendant un mouvement (ouverture de la carte, retour d'une feuille agrandie) ou juste avant que la page
    // change de largeur (la barre de défilement qui apparaît), la mise en page serait fausse : on vérifie un peu après
    clearTimeout(a4.check);
    a4.check = setTimeout(() => {
      const pg = $('#edScroll .page'), bx = pg.getBoundingClientRect(), kk = bx.width / pg.offsetWidth || 1;
      const off = sheets.some(blk => {
        const mine = $$('#a4Ink .ink-slice').filter(x => x.dataset.for === blk.dataset.id), last = mine[mine.length - 1];
        if (!blk.isConnected || !last) return false;
        const want = (blk.getBoundingClientRect().bottom - bx.top) / kk, got = parseFloat(last.style.top) + parseFloat(last.style.height);
        const first = (blk.getBoundingClientRect().top - bx.top) / kk;
        return Math.abs(want - got) > 2 || Math.abs(first - parseFloat(mine[0].style.top)) > 2;
      });
      if (off && (a4.retry = (a4.retry || 0) + 1) < 8) scheduleA4();
      else if (!off) a4.retry = 0;
    }, 200);
  }

  function bindA4() {
    for (const el of [edBody(), $('#edTitle')]) el.addEventListener('input', scheduleA4);
    edBody().addEventListener('load', scheduleA4, true);   // une image qui finit de charger
    addEventListener('resize', scheduleA4);
  }

  /* Hiérarchie : un espace peut avoir un parent. */
  const byId = id => state.spaces.find(s => s.id === id) || null;
  const parentOf = sp => (sp && sp.parent ? byId(sp.parent) : null);
  const childrenOf = sp => state.spaces.filter(s => s.parent === sp.id);
  // l'espace « iCloud » (identifiant fixe, le même sur tous les appareils) passe toujours en premier
  const CLOUD_ID = 'icloud';
  const isCloudRoot = sp => !!sp && sp.id === CLOUD_ID;
  const topSpaces = () => state.spaces.filter(s => !parentOf(s)).sort((a, b) => isCloudRoot(b) - isCloudRoot(a));
  const siblingsOf = sp => (parentOf(sp) ? childrenOf(parentOf(sp)) : topSpaces());
  const descendants = sp => childrenOf(sp).flatMap(c => [c, ...descendants(c)]);
  // ce qui est rangé dans iCloud se synchronise ; le reste ne quitte pas cet appareil
  const inCloud = sp => { for (let s = sp; s; s = parentOf(s)) if (isCloudRoot(s)) return true; return false; };
  function ensureCloudRoot() {
    if (byId(CLOUD_ID)) return false;
    // createdAt et updatedAt à 0 : la version partagée (renommée, colorée ailleurs) l'emporte toujours
    state.spaces.unshift({ id: CLOUD_ID, title: 'iCloud', parent: null, createdAt: 0, updatedAt: 0, docs: [] });
    return true;
  }
  // déplacer un espace (et tout ce qu'il contient) : dans iCloud, dans un autre espace, ou à la racine
  function moveSpace(sp, target) {
    sp.parent = target ? target.id : null;
    persist();
    renderRing();
    renderChrome();
    toast(target ? (isCloudRoot(target) ? '« ' + sp.title + ' » est maintenant dans iCloud' : 'Déplacé dans « ' + target.title + ' »')
      : (sync.on ? '« ' + sp.title + ' » ne se synchronise plus : il reste sur cet appareil' : 'Déplacé dans Tous les espaces'));
  }
  const pathOf = sp => { const p = []; for (let s = sp; s; s = parentOf(s)) p.unshift(s); return p; };
  const space = () => byId(state.current) || topSpaces()[0] || null;
  const spaceOfDoc = id => state.spaces.find(s => s.docs.some(d => d.id === id));

  function newSpace(title, parent) {
    const sp = { id: uid(), title: (title || '').trim() || 'Mon espace', parent: parent ? parent.id : null, createdAt: Date.now(), docs: [] };
    state.spaces.push(sp);
    sound.create();
    state.current = sp.id;
    persist();
    return sp;
  }

  function newDoc(sp, fields) {
    const doc = Object.assign({ id: uid(), title: '', html: '', createdAt: Date.now(), updatedAt: Date.now() }, fields);
    sp.docs.push(doc);
    sound.create();
    persist();
    return doc;
  }

  function coverOf(doc) {
    const m = /<img[^>]+src="([^"]+)"/i.exec(doc.html || '');
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  const textCache = new Map();
  function plainOf(doc) {
    if (doc.plain) return doc.plain;
    const seen = textCache.get(doc.id);
    if (seen && seen.html === doc.html) return seen.text;
    // (sans les images et les sons en base64 : c'est eux qui pèsent, et ils n'ont pas de texte)
    const light = (doc.html || '').replace(/\s(src|data-audio)="data:[^"]*"/g, '').replace(/\sdata-audio="[^"]*"/g, '');
    // (l'écriture des feuilles manuscrites, lue en arrière-plan, se cherche comme le reste)
    const hand = Array.from((doc.html || '').matchAll(/data-read="([^"]*)"/g), m => m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join(' ');
    const text = ((new DOMParser().parseFromString(light, 'text/html').body.textContent || '') + ' ' + hand).replace(/\s+/g, ' ').trim();
    textCache.set(doc.id, { html: doc.html, text });
    return text;
  }

  // Les couvertures sont réduites une fois en vignettes légères pour la roue.
  const thumbCache = new Map();
  let thumbQueue = Promise.resolve();
  function thumbOf(doc) {
    const src = coverOf(doc);
    if (!src) return Promise.resolve(null);
    // (la même image reste la même vignette, quoi qu'on écrive dans la page)
    const key = doc.id + ':' + src.length + ':' + src.slice(-48);
    if (!thumbCache.has(key)) {
      // une seule grande image décodée à la fois : d'un coup, tout un espace dépasse la mémoire permise sur iPhone
      const made = thumbQueue.then(() => new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          try {
            const w = 420, h = Math.round(w * img.naturalHeight / img.naturalWidth) || w;
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', .82));
            c.width = c.height = 0;
          } catch (e) { resolve(src); }
          img.src = '';
        };
        img.onerror = () => resolve(null);
        img.src = src;
      }));
      thumbQueue = made;
      thumbCache.set(key, made);
    }
    return thumbCache.get(key);
  }

  /*
   * Les icônes de l'interface : un seul trait, tracé à main levée (les lignes ne sont jamais tout à fait droites).
   * ic('nom') rend un <svg> qui prend la couleur et la taille du texte autour.
   */
  const ICONS = {
    // présentations
    page: '<path d="M6.4 3.9q5.7-.4 11.3.1l.2 16.1q-5.7.4-11.4-.1z"/><path d="M9 8.6q3.1-.2 6.2 0M9 11.9q3.3-.2 6.4.1M9 15.2q2-.2 4 0"/>',
    reveal: '<path d="M4.6 6.8q7.4-.5 14.8.1M4.6 11.9q5-.3 10 0"/><path d="M4.8 17h.4M8.4 17h.4M12 17h.4" stroke-width="2.2"/>',
    slides: '<path d="M3.6 5.4q8.4-.6 16.8 0l-.2 11.2q-8.2.5-16.4 0z"/><path d="M12 16.8v2.9M9 19.9q3-.3 6 0"/>',
    typewriter: '<path d="M7.2 12.6V4.4q4.8-.3 9.6 0v8.2"/><path d="M9.6 8q2.4-.2 4.8 0"/><path d="M3.8 13q8.2-.6 16.4 0l-.3 6.4q-7.9.5-15.8 0z"/><path d="M7 16.4h.3M10.3 16.4h.3M13.6 16.4h.3M16.9 16.4h.3" stroke-width="2"/>',
    phrase: '<path d="M4.2 12.2q5.8-.7 11.3-.1"/><path d="M18.6 7.6q.3 4.4-.1 8.9"/>',
    memoire: '<path d="M12 3.9a8.1 8.1 0 1 1-.2 0"/><path d="M12 4v16M8.6 5v13.9M5.7 7.6v8.7"/>',
    flip: '<path d="M4.6 7.1l9.2-1.9 2.6 12.4-9.2 1.9z"/><path d="M16.4 5.7l3.2.9-3.1 12.2"/>',
    encre: '<path d="M12 3.6c2.9 4.1 5.6 7.1 5.6 10.4a5.6 5.6 0 0 1-11.2 0c0-3.2 2.7-6.2 5.6-10.4z"/><path d="M9.4 14.6q.4 2 2.3 2.6"/>',
    mots: '<path d="M5 16.6l4.8-6.9 4.4 4.6 4.8-8.2"/><circle cx="5" cy="16.6" r="1.4"/><circle cx="9.8" cy="9.7" r="1.4"/><circle cx="14.2" cy="14.3" r="1.4"/><circle cx="19" cy="6.1" r="1.4"/>',
    album: '<path d="M5.6 5.8l11.6-1.6 1.9 13.6-11.6 1.6z"/><path d="M8.2 8.1l7.4-1 1 7.3-7.4 1z"/>',
    film: '<path d="M4.2 3.8q7.8-.3 15.6 0l-.1 16.4q-7.7.4-15.4 0z"/><path d="M7.4 4v16M16.6 4v16"/><path d="M5.8 7.2h.2M5.8 12h.2M5.8 16.8h.2M18.1 7.2h.2M18.1 12h.2M18.1 16.8h.2" stroke-width="1.9"/>',
    carnet: '<path d="M6.2 4q5.9-.3 11.5 0 1 .1 1 1.1l-.1 13.8q0 1.1-1 1.1-5.6.3-11.4 0z"/><path d="M9.2 4.1v15.8M4.4 7.6h3.4M4.4 12h3.4M4.4 16.4h3.4"/>',
    lettre: '<path d="M3.7 6.4q8.3-.5 16.6 0l-.1 11.3q-8.2.4-16.4 0z"/><path d="M4 6.8l8 6.1 8.1-6.2"/>',
    univers: '<path d="M12.1 12.3c.8-.9-.3-2.1-1.3-1.6-1.6.8-1.2 3.1.4 3.6 2.4.8 4.4-1.4 3.7-3.8-.9-3.1-4.8-4.1-7.3-2.3-3.4 2.5-2.8 7.7.9 9.4 4.2 2 9-.6 9.4-5.6"/>',
    portes: '<path d="M6.6 20.4V9.6a5.4 5.4 0 0 1 10.8-.1v10.9"/><path d="M4.4 20.5q7.6-.4 15.2 0"/><path d="M14.4 14.1v.9"/>',
    planete: '<circle cx="12" cy="12" r="5.6"/><path d="M6.3 14.1c-2.7 1.9-2.8 3.4.3 3 3.2-.4 8.2-2.9 11.6-5.8 3.3-2.9 3.7-4.8.7-4.3"/>',
    apesanteur: '<path d="M4 8.9l6.2-1.3M13.2 12.8l6.9-1.6M5.8 17.2l5.8.5"/>',
    // atmosphères
    none: '<path d="M6 12.2q6-.5 12 0"/>',
    pluie: '<path d="M7.4 14.2a3.9 3.9 0 0 1 .4-7.7 5 5 0 0 1 9.4 1.6 3.1 3.1 0 0 1-.4 6.1z"/><path d="M8.6 17.2l-.8 2.4M12.4 17.2l-.8 2.4M16.2 17.2l-.8 2.4"/>',
    orage: '<path d="M13.6 3.6L7.4 13.1h4.8l-1.6 7.3 6.4-9.8h-4.9z"/>',
    neige: '<path d="M12 3.8v16.4M4.9 7.9l14.2 8.2M4.9 16.1l14.2-8.2"/><path d="M10.2 5.2l1.8 1.6 1.8-1.6M10.2 18.8l1.8-1.6 1.8 1.6"/>',
    brume: '<path d="M4 8.4c2.6-1.5 5.4 1.4 8 0s5.4 1.5 8 0M4 12.4c2.6-1.5 5.4 1.4 8 0s5.4 1.5 8 0M4 16.4c2.6-1.5 5.4 1.4 8 0s5.4 1.5 8 0"/>',
    aurore: '<path d="M3.8 17.6c2.2-7 4.4-10.5 6.6-5.2s4.3 3.6 5.9-2.4c.9-3.3 2.4-4.6 3.9-4.1"/><path d="M4.2 20.3q7.8-.4 15.6 0"/>',
    lucioles: '<circle cx="7.4" cy="8.2" r="1.2"/><circle cx="15.8" cy="6.6" r="1"/><circle cx="12.6" cy="13.4" r="1.5"/><circle cx="6.6" cy="17.4" r=".9"/><circle cx="17.8" cy="16.6" r="1.2"/>',
    feuilles: '<path d="M5.4 18.6C5 10.8 9.6 5.6 18.8 5.2c.3 8.8-4.8 13.6-13.4 13.4z"/><path d="M5.4 18.6C8.6 14.8 11.6 11.6 15.4 8.6"/>',
    petales: '<circle cx="12" cy="12" r="1.9"/><path d="M12 10.1C9.6 7.4 11 4 12 4s2.4 3.4 0 6.1zM13.8 11.4c2.6-2.7 6-1.4 6.1-.4.1 1-3.2 2.6-6.1.4zM13.1 13.6c1.1 3.4-1.4 6-2.4 5.6-.9-.4-1.1-4 2.4-5.6zM10.9 13.6c-3.3 1.4-5.9-1.1-5.6-2 .3-1 3.9-1.2 5.6 2z"/>',
    desert: '<circle cx="15.6" cy="8.2" r="2.6"/><path d="M3.8 17.4c3.4-3.4 6.6-3.6 9.8-.8 2.2-1.6 4.4-1.7 6.6-.3"/><path d="M4 20.4q8-.4 16 0"/>',
    feu: '<path d="M12 3.8c3.6 3.6 5.8 6.6 5.8 10a5.8 5.8 0 0 1-11.6 0c0-2 .9-3.6 2.2-5 .3 1.8 1.2 3 2.4 3.4-.6-3 .1-5.6 1.2-8.4z"/>',
    // blocs
    bullets: '<path d="M9.4 7.2q5.4-.3 10.6 0M9.4 12.1q5.4-.3 10.6 0M9.4 17q5.4-.3 10.6 0"/><path d="M5 7.2h.3M5 12.1h.3M5 17h.3" stroke-width="2.4"/>',
    todo: '<path d="M5 5.2q6.9-.4 13.9 0l-.2 13.7q-6.8.4-13.6 0z"/>',
    checked: '<path d="M5 5.2q6.9-.4 13.9 0l-.2 13.7q-6.8.4-13.6 0z"/><path d="M8.4 12.3l2.6 2.7 4.8-5.6"/>',
    quote: '<path d="M10.2 7.4c-3 .8-4.6 3-4.4 6.4M17.8 7.4c-3 .8-4.6 3-4.4 6.4"/><circle cx="7.6" cy="15.2" r="1.8"/><circle cx="15.2" cy="15.2" r="1.8"/>',
    callout: '<path d="M4.4 5.2q7.6-.5 15.2 0l-.1 11.4q-4.4.3-8.6 0L7 19.6l.4-3q-1.6 0-3-.1z"/>',
    image: '<path d="M3.9 5.3q8.1-.5 16.2 0l-.1 13.4q-8 .4-16 0z"/><circle cx="9" cy="9.7" r="1.5"/><path d="M4.3 16.4l4.6-3.9 3.4 2.6 3.2-3.2 4.4 4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.3v4.9l3.1 2"/>',
    fold: '<path d="M9.4 6.6l5.4 5.4-5.4 5.4"/>',
    blur: '<path d="M4.3 9.6q7.7-.5 15.4 0l-.1 5q-7.6.4-15.2 0z" stroke-dasharray="2.2 2.4"/>',
    blank: '<path d="M4.6 16.6q7.4-.4 14.8 0"/><path d="M4.6 14.4v2.2M19.4 14.4v2.2"/>',
    pen: '<path d="M15.6 4.8l3.6 3.6L9 18.6l-4.6 1.1 1-4.6z"/><path d="M13.4 7l3.6 3.6"/>',
    gallery: '<path d="M6.4 6.3q6-.4 11.2 0l-.1 11.4q-5.6.4-11.1 0z"/><path d="M3.4 8.6v6.8M20.6 8.6v6.8"/>',
    compare: '<path d="M4.2 5.3q7.8-.4 15.6 0l-.1 13.4q-7.7.4-15.4 0z"/><path d="M12 3.4v17.2"/><path d="M4.4 15.6l3.2-3 3 2.4M13.2 14.4l2.6-2.4 3.6 3.2"/>',
    fork: '<path d="M12 20.4v-6.2c0-2.8-5.6-3.8-5.6-8.4M12 14.2c0-2.8 5.6-3.8 5.6-8.4"/><path d="M4.6 7.6l1.8-2.2 2 2.1M15.6 7.5l2-2.1 1.8 2.2"/>',
    goto: '<path d="M7.2 16.8l9.4-9.6"/><path d="M9.4 6.8q3.7-.4 7.4.2.4 3.6-.1 7.3"/>',
    write: '<path d="M4.4 18.6q2.4-2.6 4.2-.6 1.9 2 4.2-.6 2.2-2.4 4.4-.4"/><path d="M14.2 4.6l3 3-7.4 7.4-3.4.6.5-3.4z"/>',
    quiz: '<path d="M8.8 8.8c0-2.4 1.6-3.8 3.4-3.8 2.1 0 3.4 1.4 3.4 3.2 0 2.8-3.6 3-3.6 6"/><path d="M12 18.6h.3" stroke-width="2.4"/>',
    scratch: '<path d="M4 6q8-.5 16 0l-.2 12q-7.9.4-15.6 0z"/><path d="M7.2 14.8l3-3.4M10.2 15.4l5.2-6M14.2 15.2l3-3.4"/>',
    lock: '<path d="M6 10.8q6-.4 12 0l-.1 8.6q-5.9.4-11.8 0z"/><path d="M8.6 10.6V8a3.4 3.4 0 0 1 6.8 0v2.6"/><path d="M12 14.2v2"/>',
    breathe: '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="3.4"/>',
    // objets de l'album
    ticket: '<path d="M4 7q8-.4 16 0v2.8a2.2 2.2 0 0 0 0 4.4V17q-8 .4-16 0v-2.8a2.2 2.2 0 0 0 0-4.4z"/><path d="M14.8 7.2v9.6" stroke-dasharray="1.4 1.8"/>',
    stamp: '<path d="M6 4.6q6-.3 12 0l-.1 14.8q-5.9.3-11.9 0z" stroke-dasharray="1.6 1.4"/><path d="M8.6 8q3.4-.2 6.8 0l-.1 6.6q-3.3.2-6.7 0z"/>',
    postmark: '<circle cx="10.4" cy="12" r="5.8"/><path d="M15.4 8.6c1.6-1.2 3.2-1.2 4.8 0M15.8 12c1.4-1.2 2.8-1.2 4.4 0M15.4 15.4c1.6-1.2 3.2-1.2 4.8 0"/>',
    cup: '<path d="M5 8.4q6.4-.4 12.8 0l-1 8.6q-.3 2.4-2.6 2.4H8.6q-2.3 0-2.6-2.4z"/><path d="M17.6 10.2c2.4-.4 3.2 2.6.4 3.6"/><path d="M9.6 3.8q-.8 1.2 0 2.4M13 3.8q-.8 1.2 0 2.4"/>',
    heart: '<path d="M12 19.2C6.6 15.4 4 12.4 4.2 9.2 4.4 6.4 6.4 5 8.4 5.1c1.6.1 2.8 1 3.6 2.4.8-1.4 2-2.3 3.6-2.4 2-.1 4 1.3 4.2 4.1.2 3.2-2.4 6.2-7.8 10z"/>',
    star: '<path d="M12 4.2l2.4 5 5.4.6-4 3.8 1.1 5.4-4.9-2.7L7.1 19l1.1-5.4-4-3.8 5.4-.6z"/>',
    squiggle: '<path d="M3.8 15.2c2.2-4 4-4 5.4-1.2s3 2.8 4.6-.8c1.2-2.6 2.8-3.4 5.2-3.2"/><path d="M16.4 7.6l2.8 2.4-2.6 2.6"/>',
    tape: '<path d="M4.4 9.2q7.6-.6 15.2.2l-.6 5.6q-7.4-.6-14.8-.2z"/><path d="M4.4 9.2l-.8 1.6.8 1.4-.6 1.6.6 1.2M19.6 9.4l.8 1.4-.8 1.6.6 1.4-.8 1.2"/>',
    clip: '<path d="M9 7.4v8.8a3 3 0 0 0 6 0V6.6a2 2 0 0 0-4 0v9"/>',
    pin: '<circle cx="12" cy="9.4" r="4"/><path d="M12 13.4v6.8"/>',
    // divers
    scene: '<path d="M3.8 4.4q8.2-.4 16.4 0"/><path d="M5 4.6c0 6 1.6 11 4.6 15M19 4.6c0 6-1.6 11-4.6 15"/><path d="M9.6 19.6q2.4-.3 4.8 0"/>',
    cut: '<circle cx="6.6" cy="17.4" r="2.4"/><circle cx="6.6" cy="6.6" r="2.4"/><path d="M8.6 7.9l11 8.6M8.6 16.1l11-8.6"/>',
    interact: '<path d="M6.4 4.6l11.4 6.2-5 1.4-2.2 4.8z"/><path d="M12.8 12.2l4.4 4.6"/>',
    dot: '<circle cx="12" cy="12" r="3.2"/>',
    cloud: '<path d="M7.2 18.4a4.4 4.4 0 0 1-.5-8.8 5.6 5.6 0 0 1 10.8 1.6 3.6 3.6 0 0 1-.4 7.2z"/>',
    rosette: '<circle cx="12" cy="12" r="2.6"/><path d="M12 4.6v2.6M12 16.8v2.6M4.6 12h2.6M16.8 12h2.6M6.8 6.8l1.8 1.8M15.4 15.4l1.8 1.8M6.8 17.2l1.8-1.8M15.4 8.6l1.8-1.8"/>',
    mic: '<rect x="9" y="3.6" width="6" height="11" rx="3"/><path d="M5.6 11.6q.3 6 6.4 6.2t6.4-6.2M12 17.8v2.8M9 20.8h6"/>',
    camera: '<path d="M3.8 8.2q0-1.4 1.4-1.4h2.6l1.4-2.2h5.6l1.4 2.2h2.6q1.4 0 1.4 1.4v9.4q0 1.4-1.4 1.4H5.2q-1.4 0-1.4-1.4z"/><circle cx="12" cy="13" r="3.6"/>',
    send: '<path d="M12 19.4V5M6.2 10.6L12 4.8l5.8 5.8"/>',
    // écriture manuscrite
    sheet: '<path d="M5.4 4q6.6-.4 13.2 0l-.2 16q-6.4.4-12.8 0z"/><path d="M8 13.4q1.4-3.4 2.8 0t2.9-.4 2.3 1.4"/>',
    nib: '<path d="M12 3.4q4 4.6 5.4 9.4L12 20.6l-5.4-7.8Q8 8 12 3.4z"/><path d="M12 12.8v7.6"/><circle cx="12" cy="11.4" r="1.2"/>',
    pencil: '<path d="M15.8 4.2l4 4L8.6 19.4l-5 1 1-5z"/><path d="M13.6 6.4l4 4"/>',
    marker: '<path d="M14.6 4.4l5 5-7.2 7.2-5-5z"/><path d="M7.4 11.6l-2.4 5 2.4 2.4 5-2.4"/><path d="M3.6 20.4h5.6"/>',
    eraser: '<path d="M14.2 4.4l5.4 5.4-8.8 8.8H6.4L3.6 15.8z"/><path d="M9.4 9.2l5.4 5.4M11.6 18.6h8.6"/>',
    lasso: '<path d="M12 4.4c4.6 0 8.2 2.3 8.2 5.2s-3.6 5.2-8.2 5.2-8.2-2.3-8.2-5.2 3.6-5.2 8.2-5.2z" stroke-dasharray="2.4 2.6"/><path d="M8.6 14.2q-1.6 2.6.6 4.2t.6 2.4"/>',
    paper: '<path d="M6 3.8q6-.3 12 .1l-.2 16.2q-5.9.3-11.8-.1z"/><path d="M8.6 8.4h6.8M8.6 11.8h6.8M8.6 15.2h4.4"/>',
    undo: '<path d="M9 6.4L4.8 10.4 9 14.4"/><path d="M5.2 10.4q7-.6 10.2.6t3.6 5.6q-.4 2.4-2.4 3.4"/>',
    redo: '<path d="M15 6.4l4.2 4L15 14.4"/><path d="M18.8 10.4q-7-.6-10.2.6t-3.6 5.6q.4 2.4 2.4 3.4"/>',
    table: '<rect x="3.8" y="5" width="16.4" height="14" rx="1.6"/><path d="M3.8 9.8h16.4M3.8 14.4h16.4M9.2 9.8V19M14.8 9.8V19"/>',
    mapping: '<path d="M12 3.8v16.4M3.8 12h16.4"/><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="9.5" r="1.5"/><circle cx="14.5" cy="16" r="1.5"/>',
    bars: '<path d="M4.4 6.4h9M4.4 12h15M4.4 17.6h6" stroke-width="3"/>',
    pie: '<path d="M12 3.8a8.2 8.2 0 1 0 8.2 8.2H12z"/><path d="M15 3.8q4.6.8 5.2 5.2H15z"/>',
    ruler: '<path d="M3.4 15.6L15.6 3.4l5 5L8.4 20.6z"/><path d="M7.2 11.8l1.6 1.6M10 9l2.4 2.4M12.8 6.2l1.6 1.6"/>',
    more: '<path d="M5.6 12h.2M11.9 12h.2M18.2 12h.2" stroke-width="2.6"/>'
  };
  const ic = name => `<svg class="gi" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // Couleurs proposées pour les cartes. Les 8 premières servent aussi au choix automatique.
  const COLORS = [
    { id: 'craie', name: 'Craie', bg: '#efeee9', fg: '#111' },
    { id: 'vermillon', name: 'Vermillon', bg: '#c8442b', fg: '#fff6f0' },
    { id: 'encre', name: 'Encre', bg: '#161616', fg: '#f1efe8' },
    { id: 'sauge', name: 'Sauge', bg: '#dfe3d5', fg: '#1d2a1b' },
    { id: 'lin', name: 'Lin', bg: '#e9dcc9', fg: '#3b2a1a' },
    { id: 'blanc', name: 'Blanc', bg: '#ffffff', fg: '#111' },
    { id: 'olive', name: 'Olive', bg: '#8a8f79', fg: '#fbfbf5' },
    { id: 'brume', name: 'Brume', bg: '#b9c2c6', fg: '#141b1f' },
    { id: 'ocre', name: 'Ocre', bg: '#d9a441', fg: '#2a1d05' },
    { id: 'nuit', name: 'Bleu nuit', bg: '#1f2a44', fg: '#eef0f6' },
    { id: 'rose', name: 'Rose poudré', bg: '#ead1cc', fg: '#3a1f1a' },
    { id: 'foret', name: 'Forêt', bg: '#2f4a3a', fg: '#eef3ec' },
    { id: 'lavande', name: 'Lavande', bg: '#cfcbe3', fg: '#1e1a33' },
    { id: 'terre', name: 'Terre cuite', bg: '#a8593a', fg: '#fff3ea' }
  ];
  // les fonds de la mise en scène : les classiques, puis une palette plus franche et plus variée
  const NEW_TONES = [
    { id: 'corail', name: 'Corail', bg: '#f0705a', fg: '#2b0f0a' }, { id: 'framboise', name: 'Framboise', bg: '#b3265e', fg: '#fff0f5' },
    { id: 'prune', name: 'Prune', bg: '#4b2147', fg: '#f7ecf6' }, { id: 'violet', name: 'Violet', bg: '#5a3fc0', fg: '#f3f0ff' },
    { id: 'indigo', name: 'Indigo', bg: '#27327e', fg: '#eef0ff' }, { id: 'azur', name: 'Azur', bg: '#2f7fd6', fg: '#f1f7ff' },
    { id: 'ciel', name: 'Ciel', bg: '#bfe0f5', fg: '#10293b' }, { id: 'lagon', name: 'Lagon', bg: '#128a8a', fg: '#ecfbfa' },
    { id: 'menthe', name: 'Menthe', bg: '#bfe8d2', fg: '#10301f' }, { id: 'emeraude', name: 'Émeraude', bg: '#17805a', fg: '#ecfbf3' },
    { id: 'citron', name: 'Citron', bg: '#f4e06a', fg: '#2c2600' }, { id: 'mandarine', name: 'Mandarine', bg: '#ef8a2c', fg: '#2d1500' }
  ];
  const ALL_TONES = [...COLORS, ...NEW_TONES];
  const SCENE_COLORS = [...['blanc', 'craie', 'lin', 'encre', 'sauge', 'foret', 'nuit'].map(id => COLORS.find(c => c.id === id)), ...NEW_TONES];
  const PALETTE = COLORS.slice(0, 8).map(c => [c.bg, c.fg]);
  function paletteOf(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  // couleur choisie par l'utilisateur, sinon couleur automatique
  function colorOf(obj) {
    const c = obj.color && ALL_TONES.find(x => x.id === obj.color);
    return c ? [c.bg, c.fg] : paletteOf(obj.id);
  }

  /* ───────────── Cartes ───────────── */

  // Un élément de la roue : un texte, un (sous-)espace, ou la carte « + ».
  const docItem = doc => ({ kind: 'doc', id: doc.id, doc });
  const spaceItem = sp => ({ kind: 'space', id: sp.id, sp });
  const coverDocOf = item => item.kind === 'doc' ? item.doc
    : item.kind === 'space' ? item.sp.docs.find(coverOf) || null : null;

  function faceOf(item) {
    const f = document.createElement('div');
    f.className = 'face';
    if (!item) return f;
    if (item.kind === 'plus') {
      f.classList.add('plus');
      f.innerHTML = `<div class="plus-mark">+</div><div class="k">${esc(item.label)}</div>`;
      return f;
    }
    if (item.kind === 'space') {
      const sp = item.sp, subs = childrenOf(sp).length;
      f.classList.add('sp');
      if (sp.color) {
        const [bg, fg] = colorOf(sp);
        f.style.setProperty('--bg', bg);
        f.style.setProperty('--fg', fg);
      }
      if (isCloudRoot(sp)) f.classList.add('cloud');
      f.innerHTML = `<div class="k">${isCloudRoot(sp) ? ic('cloud') + ' Synchronisé' : 'Espace'}</div><div class="t">${esc(sp.title)}</div>`
        + `<div class="x">${isCloudRoot(sp) && !subs && !sp.docs.length ? 'Rangez-y les espaces à retrouver partout' : plural(sp.docs.length, 'texte') + (subs ? ', ' + plural(subs, 'sous-espace') : '')}</div>`;
      return f;
    }
    const doc = item.doc;
    const [bg, fg] = colorOf(doc);
    f.style.setProperty('--bg', bg);
    f.style.setProperty('--fg', fg);
    if (asReader() && isLocked(doc)) {
      f.innerHTML = '<div class="k">Protégée</div><div class="t">' + ic('lock') + '</div><div class="x">Mot de passe requis</div>';
      return f;
    }
    const kind = doc.source === 'pdf' ? 'PDF' : 'Texte';
    const spot = doc.ribbon && doc.ribbon.label ? `Repris à « ${doc.ribbon.label} »` : plainOf(doc).slice(0, 220);
    f.innerHTML = `<div class="k">${kind}</div><div class="t">${esc(doc.title || 'Sans titre')}</div><div class="x">${esc(spot)}</div>` + cardMarks(doc);
    if (CARD_PAPERS.some(([id]) => id && id === doc.paper)) f.classList.add('paper-' + doc.paper);
    if (coverOf(doc)) f.classList.add('img');
    return f;
  }

  // Ce qu'on peut poser sur une carte : tout reste dans le cadre, et prend les ombres des boutons de l'app
  const CARD_PAPERS = [['', 'Lisse'], ['kraft', 'Kraft'], ['carton', 'Carton'], ['ligne', 'Ligné'], ['carreaux', 'Quadrillé']];
  const CARD_STATES = ['À revoir', 'En cours', 'Fini', 'Important'];
  function cardMarks(doc) {
    const top = (doc.ribbon ? '<i class="m-ribbon"></i>' : '') + (doc.pin ? '<i class="m-pin"></i>' : '');
    return (top ? `<div class="m-top">${top}</div>` : '')
      + (doc.state ? `<div class="m-state">${esc(doc.state)}</div>` : '')
      + (doc.corner ? '<i class="m-corner"></i>' : '');
  }

  // Le ruban suit la lecture : il retient le bloc en haut de l'écran quand on quitte la carte, et le titre qui le précède
  function ribbonSpot() {
    const top = $('#edScroll').getBoundingClientRect().top, kids = Array.from(edBody().children);
    const at = Math.max(0, kids.findIndex(k => k.getBoundingClientRect().bottom > top + 8));
    const head = kids.slice(0, at + 1).reverse().find(k => /^H[1-3]$/.test(k.tagName));
    return { at, label: head ? head.textContent.trim().slice(0, 60) : '' };
  }

  /*
   * L'atelier de la carte : comme la mise en scène, un espace à part, avec la carte au centre, entre ses voisines de la
   * roue, et les réglages à droite. Il réunit l'allure de la carte, sa musique et, depuis l'éditeur, la vue par pages.
   */
  const LOOK_MARKS = [
    ['ribbon', 'Ruban', '<svg viewBox="0 0 20 20"><path d="M6.5 2.5h7v15L10 14.4l-3.5 3.1z"/></svg>'],
    ['pin', 'Épingle', '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4.6"/></svg>'],
    ['corner', 'Coin corné', '<svg viewBox="0 0 20 20"><path d="M4 3.5h12v8l-5 5H4z"/><path d="M16 11.5h-5v5"/></svg>']
  ];
  const lk = { doc: null };
  function paintLook() {
    const doc = lk.doc, sp = spaceOfDoc(doc.id);
    // les voisines dans l'ordre de la roue
    const docs = [...sp.docs.filter(d => d.pin), ...sp.docs.filter(d => !d.pin)], i = docs.indexOf(doc), n = docs.length;
    const box = $('#lkCenter');
    box.innerHTML = '<div class="lk-stage"></div>';
    const stage = $('.lk-stage', box), place = (d, cls) => {
      const c = document.createElement('div');
      c.className = 'card doc ' + cls;
      c.dataset.id = d.id;
      c.append(faceOf(docItem(d)));
      stage.append(c);
    };
    if (n > 2) place(docs[(i + n - 1) % n], 'lk-side lk-l');
    place(doc, 'lk-main');
    if (n > 1) place(docs[(i + 1) % n], 'lk-side lk-r');
    paintCovers(box, [docItem(doc)]);
    const moods = PAGE_MOODS.map(m => [m.id, m.id ? m.name : 'Selon la couleur']);
    const custom = !!doc.state && !CARD_STATES.includes(doc.state);
    const tile = ([k, label, icon]) => `<button class="pp-tile${doc[k] ? ' on' : ''}" data-mark="${k}"><i>${icon}</i><span>${label}</span></button>`;
    $('#lkInspector').innerHTML = '<div class="sc-sec">Carte</div>'
      + fieldHTML({ key: 'color', label: 'Couleur', type: 'swatch', options: [['', 'Automatique', 'linear-gradient(135deg, #efeee9 50%, #c8442b 50%)'], ...SCENE_COLORS.map(c => [c.id, c.name, c.bg])] }, doc.color || '', 'k')
      + fieldHTML({ key: 'paper', label: 'Papier', type: 'seg', options: CARD_PAPERS }, doc.paper || '', 'k')
      + '<div class="sc-sec">Repères</div><div class="sc-objs lk-marks">' + LOOK_MARKS.map(tile).join('') + '</div>'
      + '<div class="sc-sec">État</div>'
      + fieldHTML({ key: 'state', label: 'Sur la carte', type: 'seg', options: [['', 'Aucun'], ...CARD_STATES.map(x => [x, x])] }, custom ? '__' : doc.state || '', 'k')
      + `<div class="sc-field"><input class="sc-text" maxlength="24" placeholder="Ou un mot à vous" value="${custom ? esc(doc.state) : ''}"></div>`
      + '<div class="sc-sec">Musique</div>'
      + fieldHTML({ key: 'mood', label: 'Mood', type: 'seg', options: [...moods, ['__surprise', 'Surprise']] }, doc.mood || '', 'k')
      + (doc === edDoc && !PHONE ? '<div class="sc-sec">Page</div>' + fieldHTML({ key: 'a4', label: 'Vue de l’éditeur', type: 'seg', options: [['', 'Continue'], ['1', 'Pages A4']] }, a4.on ? '1' : '', 'k') : '');
  }
  function lookSaved() {
    const doc = lk.doc;
    sound.nav();
    if (doc === edDoc) { paintColorButton(); changed(); } else persist();
    paintLook();
  }
  function openCardLook(doc) {
    if (!doc || !spaceOfDoc(doc.id) || READONLY) return;
    if (doc === edDoc) commitEditor();
    lk.doc = doc;
    hideTools();
    $('#look').hidden = false;
    paintLook();
  }
  function closeLook() {
    if ($('#look').hidden) return;
    $('#look').hidden = true;
    lk.doc = null;
    sound.nav();
    if (view === 'space') { renderRing(); renderChrome(); }
  }
  function bindLook() {
    $('#edLook').addEventListener('click', () => openCardLook(edDoc));
    $('#lkBack').addEventListener('click', closeLook);
    $('#lkReset').addEventListener('click', () => {
      for (const k of ['ribbon', 'pin', 'corner', 'paper', 'state']) delete lk.doc[k];
      lookSaved();
    });
    $('#lkInspector').addEventListener('click', e => {
      const doc = lk.doc, m = e.target.closest('button[data-mark]'), f = e.target.closest('button[data-f]');
      if (m) {
        const k = m.dataset.mark;
        if (doc[k]) delete doc[k];
        else doc[k] = k !== 'ribbon' ? true : doc === edDoc ? ribbonSpot() : { at: 0, label: '' };
        return lookSaved();
      }
      if (!f) return;
      const key = f.dataset.f;
      let v = f.dataset.v;
      if (key === 'a4') { setA4(!!v); sound.tick(); return paintLook(); }
      if (key === 'mood' && v === '__surprise') {
        const choices = PAGE_MOODS.slice(1).filter(x => x.id !== doc.mood);
        v = choices[Math.floor(Math.random() * choices.length)].id;
        toast('Mood : ' + PAGE_MOODS.find(x => x.id === v).name);
      }
      if (v) doc[key] = v; else delete doc[key];
      if (doc === edDoc && (key === 'color' || key === 'mood')) sound.seed('carte:' + doc.id, docMood(doc));
      if (key === 'color') sound.colorChord(moodOf(doc.color));
      lookSaved();
    });
    $('#lkInspector').addEventListener('change', e => {
      if (!e.target.matches('.sc-text')) return;
      const v = e.target.value.trim();
      if (v) lk.doc.state = v; else delete lk.doc.state;
      lookSaved();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#look').hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeLook(); } }, true);
  }

  function paintCovers(root, items) {
    for (const item of items) {
      const doc = coverDocOf(item);
      if (!doc) continue;
      thumbOf(doc).then(url => {
        if (!url) return;
        for (const f of $$(`[data-id="${item.id}"] .face`, root)) {
          f.style.backgroundImage = `url("${url}")`;
          f.classList.add('img');
        }
      });
    }
  }

  /*
   * Roue : les cartes sont posées radialement, à pas fixe tant qu'il y en a peu,
   * si bien qu'elle se remplit au fil des textes ajoutés.
   */
  function buildRing(host, items, { slots, radius, cw, ch, ghosts }) {
    host.textContent = '';
    host.style.setProperty('--r', radius + 'px');
    host.style.setProperty('--cw', cw + 'px');
    host.style.setProperty('--ch', ch + 'px');
    const n = Math.max(slots, items.length);
    const step = 360 / n;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const item = items[i] || null;
      if (!item && !ghosts) break;
      const c = document.createElement('div');
      c.className = 'card' + (item ? ' ' + item.kind : ' ghost');
      c.style.setProperty('--a', (i * step) + 'deg');
      c.dataset.a = i * step;
      c.dataset.idx = i;
      const f = faceOf(item);
      if (item) c.dataset.id = item.id;
      else f.style.setProperty('--bg', PALETTE[(i * 3) % PALETTE.length][0]);
      c.appendChild(f);
      if (item && item.kind !== 'plus') {
        const badge = document.createElement('div');
        badge.className = 'badge';
        c.appendChild(badge);
      }
      frag.appendChild(c);
    }
    host.appendChild(frag);
    paintCovers(host, items);
    return { n, step };
  }

  /* ───────────── Vues ───────────── */

  function show(v) {
    view = v;
    diag('vue: ' + v);
    $('#welcome').hidden = v !== 'welcome';
    $('#space').hidden = !['space', 'editor', 'reader'].includes(v);
    $('#editor').hidden = v !== 'editor';
    $('#quick').hidden = v !== 'quick';
    if (v !== 'reader' && v !== 'editor') $('#reader').hidden = true;
    document.body.classList.toggle('editing', v === 'editor' || v === 'reader');
  }

  /*
   * Si iOS recharge la page (mémoire épuisée), on reprend là où on était : la page ouverte est notée pour cette session.
   */
  const noteOpen = id => { try { if (id) sessionStorage.setItem('espaces.open', id); else sessionStorage.removeItem('espaces.open'); } catch (e) { /* tant pis */ } };
  function route() {
    let open = null;
    try { open = sessionStorage.getItem('espaces.open'); } catch (e) { /* tant pis */ }
    if (open && !READONLY && spaceOfDoc(open)) { if (PHONE) showQuick(); else enterSpace(spaceOfDoc(open).id, { instant: true }); return openDoc(open); }
    if (PHONE) showQuick();
    else if (!state.spaces.length) showWelcome();
    else enterSpace(null, { instant: true });
  }

  const TILT = 14;
  const AUTO_SPEED = 0.045;   // degrés par image
  const IDLE_DELAY = 2600;    // ms sans interaction avant de reprendre la rotation
  const ring = {
    rot: 0, target: 0, step: 10, n: 0, items: [], ctx: 'space',
    focusIdx: -1, hover: null, lastT: '', auto: 0, lastInteract: 0
  };
  const touch = () => { ring.lastInteract = performance.now(); };

  function ringGeometry() {
    const w = innerWidth, h = innerHeight;
    // sur iPhone, un plan rapproché : la carte de devant occupe l'écran, ses voisines dépassent à peine
    if (PHONE) { const radius = w * .95, cw = w * .38; return { radius, cw, ch: cw * 1.3 }; }
    const radius = Math.max(260, Math.min(w * .38, h * .62, 720));
    const cw = radius * .27;
    return { radius, cw, ch: cw * 1.18 };
  }

  function currentItems() {
    let items;
    if (ring.ctx === 'all') {
      items = topSpaces().map(spaceItem);
      if (!asReader()) items.push({ kind: 'plus', id: 'plus', label: 'Nouvel espace', action: promptNewSpace });
    } else {
      const sp = space();
      items = [...childrenOf(sp).map(spaceItem), ...sp.docs.filter(d => d.pin).map(docItem), ...sp.docs.filter(d => !d.pin).map(docItem)];
      if (!asReader()) items.push({ kind: 'plus', id: 'plus', label: 'Nouveau texte', action: createAndOpen });
    }
    return items;
  }

  const realCount = () => ring.items.filter(i => i.kind !== 'plus').length;

  function renderRing() {
    ring.items = currentItems();
    const r = buildRing($('#ring'), ring.items, Object.assign({ slots: 44 }, ringGeometry()));
    // sol posé sous les cartes : il tourne avec elles et donne du volume à l'espace
    const floor = document.createElement('div');
    floor.className = 'floor';
    $('#ring').append(floor);
    ring.n = r.n;
    ring.step = r.step;
    ring.focusIdx = -1;
    ring.hover = null;
    ring.lastT = '';
    $('#emptyCta').hidden = realCount() > 0 || asReader() || ring.ctx === 'all';
  }

  function renderChrome() {
    const all = ring.ctx === 'all';
    const sp = space();
    $('#spaceTitle').textContent = all ? 'Vos espaces' : sp.title;
    $('#space').style.setProperty('--tint', all ? '#e9e7e1' : colorOf(sp)[0]);
    applySpaceTheme(!all && sp.color ? ALL_TONES.find(c => c.id === sp.color) : null);
    for (const b of $$('.actions [data-ctx]')) b.hidden = b.dataset.ctx !== (all ? 'all' : 'space');

    const crumbs = $('#crumbs');
    crumbs.textContent = '';
    if (all) {
      $('#spaceCount').textContent = plural(topSpaces().length, 'espace');
    } else {
      const parts = READONLY ? [] : [{ id: 'all', title: 'Tous les espaces' }];
      for (const p of pathOf(sp).slice(0, -1)) parts.push({ id: p.id, title: p.title });
      for (const p of parts) {
        const b = document.createElement('button');
        b.className = 'crumb';
        b.dataset.go = p.id;
        b.textContent = p.title;
        crumbs.append(b, document.createTextNode(' / '));
      }
      const subs = childrenOf(sp).length;
      $('#spaceCount').textContent = plural(sp.docs.length, 'texte') + (subs ? ', ' + plural(subs, 'sous-espace') : '');
    }
    const sibs = all ? [] : siblingsOf(sp);
    const i = sibs.indexOf(sp);
    $('#prevSpace').hidden = $('#nextSpace').hidden = all || sibs.length < 2;
    $('#prevSpace').disabled = i <= 0;
    $('#nextSpace').disabled = i >= sibs.length - 1;
    $('#delSpace').hidden = all || asReader() || isCloudRoot(space());
    renderConstellation();
    $('#spaceColor').hidden = all || asReader();
    $('#renameSpace').hidden = all || asReader();
    if (!all) $('#spaceColor').style.setProperty('--dot', sp.color ? colorOf(sp)[0] : 'transparent');
    fitTitle();
  }

  /* Le titre de l'espace se réduit jusqu'à tenir sur deux lignes. */
  function fitTitle() {
    const t = $('#spaceTitle');
    if (!t.clientWidth) return;
    let size = Math.max(48, Math.min(168, innerWidth * .11, innerHeight * .2));
    // sur deux lignes, le bloc ne doit pas monter sur l'avant de la roue
    const fits = () => t.scrollWidth <= t.clientWidth + 1
      && (t.scrollHeight <= size * 1.15 || (t.scrollHeight <= size * 2.02 && size <= innerHeight * .095));
    t.style.fontSize = size + 'px';
    while (size > 30 && !fits()) {
      size *= .93;
      t.style.fontSize = size + 'px';
    }
  }

  /*
   * Passage d'un espace à l'autre : l'anneau s'en va en tournant (on plonge vers un
   * sous-espace, on recule vers le parent, on glisse vers un voisin), le suivant arrive en sens inverse.
   */
  const LEAVE_MS = 380;
  let transitioning = false;
  function transition(fn, dir = 'in') {
    const el = $('#space');
    if (view !== 'space' || transitioning) return fn();
    transitioning = true;
    gust(.85, dir === 'prev' || dir === 'out' ? -1 : 1);
    el.dataset.tr = 'leave-' + dir;
    ring.target += dir === 'prev' ? 50 : -50;
    setTimeout(() => {
      el.classList.add('no-tr');
      el.dataset.tr = 'enter-' + dir;
      fn();
      void el.offsetWidth;
      el.classList.remove('no-tr');
      el.dataset.tr = '';
      transitioning = false;
    }, LEAVE_MS);
  }

  function placeRing(opts) {
    const i = opts.focusId ? ring.items.findIndex(it => it.id === opts.focusId) : -1;
    if (i >= 0) { ring.target = -i * ring.step; ring.rot = ring.target + 20; }
    else if (!opts.keepRotation) { ring.target = 0; ring.rot = 40; }
  }

  function enterSpace(id, opts = {}) {
    const go = () => {
      if (id) state.current = id;
      const sp = space();
      if (!sp) return showWelcome();
      state.current = sp.id;
      ring.ctx = 'space';
      show('space');
      sound.seed('espace:' + sp.id, moodOf(sp.color));
      renderRing();
      renderChrome();
      placeRing(opts);
      // (circuler ne réécrit pas la bibliothèque : sur iPhone, une écriture complète de plusieurs dizaines de Mo tue la page)
    };
    if (opts.instant) go(); else transition(go, opts.dir || 'in');
  }

  function showAll() {
    if (READONLY) return;
    transition(() => {
      ring.ctx = 'all';
      sound.seed('tous');
      show('space');
      renderRing();
      renderChrome();
      placeRing({ focusId: (pathOf(space())[0] || {}).id });
    }, 'out');
  }

  function switchSibling(delta) {
    if (ring.ctx !== 'space') return;
    const sp = space();
    const sibs = siblingsOf(sp);
    const next = sibs[sibs.indexOf(sp) + delta];
    if (next) enterSpace(next.id, { dir: delta > 0 ? 'next' : 'prev' });
  }

  function goUp() {
    if (ring.ctx !== 'space') return;
    const p = parentOf(space());
    if (p) enterSpace(p.id, { focusId: space().id, dir: 'out' });
    else showAll();
  }

  function openItem(item) {
    if (!item) return;
    sound.drop();
    if (item.kind === 'doc') { setTimeout(() => gust(.6, 1), 90); openDoc(item.id); }
    else if (item.kind === 'space') enterSpace(item.id);
    else if (item.kind === 'plus') item.action();
  }

  /* Boucle d'animation : rotation lente automatique, suspendue dès qu'on interagit. */
  function frame() {
    requestAnimationFrame(frame);
    if (view !== 'space' && view !== 'editor' && view !== 'reader') return;
    const idle = performance.now() - ring.lastInteract > IDLE_DELAY;
    // derrière une page ouverte la roue s'arrête : elle est floutée, et la recalculer à chaque image coûte très cher
    const want = PHONE || view !== 'space' ? 0 : idle && !drag.active && !ring.hover ? AUTO_SPEED : 0;
    ring.auto += (want - ring.auto) * .03;
    if (!want && ring.auto < .001) ring.auto = 0;
    ring.target -= ring.auto;
    ring.rot += (ring.target - ring.rot) * 0.085;
    if (Math.abs(ring.target - ring.rot) < 0.002) ring.rot = ring.target;
    const t = `rotateX(${-TILT}deg) rotateY(${ring.rot.toFixed(3)}deg)`;
    if (t !== ring.lastT) {
      $('#ring').style.transform = t;
      ring.lastT = t;
      if (view === 'space') updateFocus();
      faceFocused();
    }
    // la roue s'arrête sur une carte (après que l'utilisateur l'a tournée) : une note claire
    if (Math.abs(ring.target - ring.rot) > .6) ring.chimed = -1;
    else if (view === 'space' && ring.focusIdx >= 0 && ring.chimed !== ring.focusIdx && ring.auto < .01
      && Math.abs(ring.target - ring.rot) < .08 && performance.now() - ring.lastInteract < 4000) {
      ring.chimed = ring.focusIdx;
      sound.chime(ring.focusIdx);
    }
  }

  // Où qu'elle soit sur la roue, la carte mise en avant fait face au spectateur.
  function faceFocused() {
    const card = $('#ring').children[ring.focusIdx];
    if (!card || !card.classList.contains('focused')) return;
    let turn = -((+card.dataset.a + ring.rot) % 360);
    if (turn > 180) turn -= 360;
    if (turn < -180) turn += 360;
    card.style.setProperty('--turn', turn.toFixed(2) + 'deg');
  }

  function focusIndex() {
    const real = realCount();
    if (!real) return -1;
    let idx = Math.round(-ring.rot / ring.step) % ring.n;
    if (idx < 0) idx += ring.n;
    // entre la dernière carte et la première : la plus proche des deux
    if (idx >= real) idx = (idx - (real - 1) <= ring.n - idx) ? real - 1 : 0;
    return idx;
  }

  /* La carte au premier plan se tourne de face et porte le compteur. */
  const FOCUS_GAP = 14; // degrés libérés de chaque côté de la carte mise en avant

  function updateFocus() {
    const idx = focusIndex();
    if (idx === ring.focusIdx) return;
    const cards = $$('#ring > .card');
    if (cards[ring.focusIdx]) {
      cards[ring.focusIdx].classList.remove('focused');
      cards[ring.focusIdx].style.removeProperty('--turn');
    }
    // « tik » quand une carte passe devant, si c'est l'utilisateur qui fait tourner la roue
    if (ring.focusIdx >= 0 && idx >= 0 && (drag.active || performance.now() - ring.lastInteract < 1500)) { sound.tick(); haptic(); }
    ring.focusIdx = idx;
    $('#ring').classList.toggle('lit', idx >= 0);
    // les voisines s'écartent, de moins en moins à mesure qu'on s'éloigne
    for (const c of cards) {
      let d = (+c.dataset.idx - idx) % ring.n;
      if (d > ring.n / 2) d -= ring.n;
      if (d < -ring.n / 2) d += ring.n;
      const s = idx < 0 || d === 0 ? 0 : Math.max(0, FOCUS_GAP - Math.abs(d) * ring.step * .5);
      if (s) c.style.setProperty('--shift', (Math.sign(d) * s).toFixed(2) + 'deg');
      else c.style.removeProperty('--shift');
      // de si près, on verrait le dos des voisines de droite, en miroir : elles montrent leur face
      if (PHONE && d) c.style.setProperty('--turn', d > 0 ? '-90deg' : '90deg');
    }
    const card = cards[idx];
    if (!card) return;
    card.classList.add('focused');
    const badge = $('.badge', card);
    if (badge) badge.textContent = `${idx + 1} / ${realCount()}`;
  }

  /* Interaction avec la roue : molette, glisser, clavier. */
  const drag = { active: false, x: 0, moved: 0 };

  function bindSpace() {
    const stage = $('#stage');
    let press = null;
    const cancelPress = () => {
      if (!press) return;
      clearTimeout(press.soft);
      clearTimeout(press.timer);
      press.c.classList.remove('pressing');
      press = null;
    };
    $('#space').addEventListener('wheel', e => {
      if (view !== 'space') return;
      e.preventDefault();
      touch();
      ring.target -= (e.deltaY + e.deltaX) * 0.055;
    }, { passive: false });

    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.ctrlKey) return;   // clic droit (ou ctrl-clic) : c'est le menu contextuel
      drag.active = true; drag.x = e.clientX; drag.moved = 0;
      touch();
      stage.setPointerCapture(e.pointerId);
      // au doigt : un appui qui dure met la carte en avant
      const c = e.pointerType !== 'mouse' && e.target.closest('.card[data-id]');
      if (c && ring.items[+c.dataset.idx] && ring.items[+c.dataset.idx].kind !== 'plus') {
        press = { c, soft: setTimeout(() => c.classList.add('pressing'), 110), timer: setTimeout(() => {
          const it = ring.items[+c.dataset.idx];
          cancelPress();
          drag.active = false;
          peekCard(c, it);
        }, 430) };
      }
    });
    stage.addEventListener('pointermove', e => {
      touch();
      if (!drag.active) return;
      const dx = e.clientX - drag.x;
      drag.x = e.clientX;
      drag.moved += Math.abs(dx);
      if (drag.moved > 4) { stage.classList.add('dragging'); cancelPress(); }
      ring.target += dx * 0.22;
    });
    const end = e => {
      cancelPress();
      if (!drag.active) return;
      drag.active = false;
      stage.classList.remove('dragging');
      if (drag.moved <= 4) {
        // la capture du pointeur redirige l'événement : on retrouve la carte sous le curseur
        stage.releasePointerCapture(e.pointerId);
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const c = el && el.closest('.card[data-id]');
        if (c) openItem(ring.items[+c.dataset.idx]);
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', () => { cancelPress(); drag.active = false; stage.classList.remove('dragging'); });
    // la souris quitte la fenêtre : la roue reprend aussitôt
    document.documentElement.addEventListener('mouseleave', () => { ring.lastInteract = 0; ring.hover = null; });

    $('#ring').addEventListener('mouseover', e => {
      const c = e.target.closest('.card[data-id]');
      const item = c ? ring.items[+c.dataset.idx] || null : null;
      if (item && item !== ring.hover) sound.brush();
      ring.hover = item;
    });
    $('#ring').addEventListener('mouseleave', () => { ring.hover = null; });


    $('#prevSpace').addEventListener('click', () => switchSibling(-1));
    $('#nextSpace').addEventListener('click', () => switchSibling(1));
    $('#crumbs').addEventListener('click', e => {
      const b = e.target.closest('[data-go]');
      if (!b) return;
      if (b.dataset.go === 'all') showAll();
      else enterSpace(b.dataset.go, { focusId: pathOf(space())[pathOf(byId(b.dataset.go)).length].id, dir: 'out' });
    });

    // le menu Fichier de la barre : il s'ouvre au clic, se referme dès qu'on choisit ou qu'on clique ailleurs
    const filePop = $('#filePop'), fileBtn = $('#fileBtn');
    const fileMenu = open => { filePop.hidden = !open; fileBtn.setAttribute('aria-expanded', open); fileBtn.classList.toggle('on', open); };
    fileBtn.addEventListener('click', e => { e.stopPropagation(); fileMenu(filePop.hidden); sound.pop(); });
    document.addEventListener('click', e => { if (!filePop.hidden && !e.target.closest('#filePop')) fileMenu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !filePop.hidden) { fileMenu(false); e.stopPropagation(); } }, true);

    for (const b of $$('[data-action]')) {
      b.addEventListener('click', () => {
        fileMenu(false);
        const a = b.dataset.action;
        if (a === 'new') createAndOpen();
        if (a === 'pdf') importPDFs(space());
        if (a === 'export') exportSpace();
        if (a === 'share') exportEspaceFile();
        if (a === 'openEspace') openEspaceFile();
        if (a === 'joinShare') shareJoin();
        if (a === 'sub') promptSubSpace();
        if (a === 'newSpace') promptNewSpace();
        if (a === 'sync') toggleSync();
        if (a === 'install') installApp();
      });
    }

    $('#spaceColor').addEventListener('click', e => {
      e.stopPropagation();
      const sp = space();
      openColorPop($('#spaceColor'), sp.color || null, c => {
        if (c) sp.color = c; else delete sp.color;
        persist();
        renderChrome();
        sound.seed('espace:' + sp.id, moodOf(sp.color));
        sound.colorChord(moodOf(sp.color));
      });
    });
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('#colorPop, #spaceColor, [data-cmd="accent"]')) $('#colorPop').hidden = true;
    });

    armable($('#delSpace'), 'Confirmer : supprimer l’espace et tout son contenu', () => {
      sound.remove();
      const sp = space();
      const gone = new Set([sp, ...descendants(sp)]);
      const parent = parentOf(sp);
      const sibs = siblingsOf(sp).filter(s => s !== sp);
      state.spaces = state.spaces.filter(s => !gone.has(s));
      persist();
      if (!state.spaces.length) return showWelcome();
      if (parent) enterSpace(parent.id);
      else if (sibs.length) enterSpace(sibs[0].id);
      else showAll();
    });

    // renommer l'espace : double-clic sur le titre
    const title = $('#spaceTitle');
    const startRename = () => {
      if (asReader() || ring.ctx !== 'space') return;
      title.contentEditable = 'true';
      title.focus();
      document.getSelection().selectAllChildren(title);
    };
    title.addEventListener('dblclick', startRename);
    $('#renameSpace').addEventListener('click', startRename);
    const commitTitle = () => {
      if (title.contentEditable !== 'true') return;
      title.contentEditable = 'false';
      const sp = space();
      const t = title.textContent.replace(/\s+/g, ' ').trim();
      if (t) sp.title = t;
      persist();
      renderChrome();
      renderRing();
    };
    title.addEventListener('input', fitTitle);
    title.addEventListener('blur', commitTitle);
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      if (e.key === 'Escape') { title.textContent = space().title; title.blur(); }
      e.stopPropagation();
    });

    const relayout = () => {
      if (view === 'space' || view === 'editor') { renderRing(); fitTitle(); }
      if (view === 'welcome') buildWelcomeRing();
    };
    // sur iPad, pendant une rotation, la taille annoncée est encore l'ancienne : on refait la mise en place une fois tournée
    let settle = null;
    addEventListener('resize', () => { relayout(); clearTimeout(settle); settle = setTimeout(relayout, 450); });
    addEventListener('orientationchange', () => { clearTimeout(settle); settle = setTimeout(relayout, 450); });

    // déposer des PDF ou des images directement sur l'espace
    $('#space').addEventListener('dragover', e => { if (!READONLY) e.preventDefault(); });
    $('#space').addEventListener('drop', e => {
      if (READONLY || view !== 'space' || ring.ctx !== 'space') return;
      e.preventDefault();
      importDroppedFiles(Array.from(e.dataTransfer.files), space());
    });
  }

  /* Demande d'un nom, à la place de prompt(). */
  function askName(title, placeholder) {
    return new Promise(resolve => {
      const box = $('#ask'), input = $('#askInput'), form = $('#askForm');
      $('#askTitle').textContent = title;
      input.placeholder = placeholder;
      input.value = '';
      box.hidden = false;
      setTimeout(() => input.focus(), 30);
      const done = v => {
        box.hidden = true;
        form.onsubmit = null;
        $('#askCancel').onclick = null;
        input.onkeydown = null;
        box.onmousedown = null;
        resolve(v);
      };
      form.onsubmit = e => { e.preventDefault(); done(input.value.trim() || null); };
      $('#askCancel').onclick = () => done(null);
      input.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      box.onmousedown = e => { if (e.target === box) done(null); };
    });
  }

  async function promptNewSpace() {
    const name = await askName('Nouvel espace', "Nom de l'espace");
    if (!name) return;
    const sp = newSpace(name, null);
    enterSpace(sp.id);
  }

  async function promptSubSpace() {
    const parent = space();
    const name = await askName('Nouveau sous-espace dans « ' + parent.title + ' »', 'Nom du sous-espace');
    if (!name) return;
    const sp = newSpace(name, parent);
    enterSpace(sp.id);
  }

  /* ───────────── Accueil ───────────── */

  function showWelcome() {
    show('welcome');
    sound.seed('accueil');
    buildWelcomeRing();
    setTimeout(() => $('#welcomeName').focus(), 50);
  }

  function buildWelcomeRing() {
    const host = $('#welcomeRing');
    host.textContent = '';
    const r = document.createElement('div');
    r.className = 'ring';
    host.appendChild(r);
    const h = Math.min(innerHeight, innerWidth * .8);
    buildRing(r, [], { slots: 36, radius: h * .36, cw: h * .11, ch: h * .15, ghosts: true });
  }

  function bindWelcome() {
    $('#welcomeForm').addEventListener('submit', e => {
      e.preventDefault();
      const sp = newSpace($('#welcomeName').value, null);
      ring.ctx = 'space';
      show('space');
      renderRing();
      renderChrome();
      const doc = newDoc(sp, {});
      openDoc(doc.id, { fresh: true });
    });
    $('#welcomePdf').addEventListener('click', async () => {
      const sp = newSpace($('#welcomeName').value, null);
      const added = await importPDFs(sp);
      if (!added) {
        state.spaces = state.spaces.filter(s => s !== sp);
        state.current = state.spaces[0] ? state.spaces[0].id : null;
        persist();
      }
    });
  }

  /* Bouton à deux temps à la place de confirm(). */
  function armable(btn, armedLabel, action) {
    const label = btn.textContent;
    let timer = null;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.classList.contains('armed')) {
        clearTimeout(timer);
        btn.classList.remove('armed');
        btn.textContent = label;
        action();
        return;
      }
      btn.classList.add('armed');
      btn.textContent = armedLabel;
      timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3000);
    });
  }

  /* ───────────── Éditeur (au-dessus de la roue) ───────────── */

  let edDoc = null;
  let savedRange = null;
  let selImg = null;
  const edBody = () => $('#edBody');

  function createAndOpen() {
    const sp = space() || newSpace('', null);
    const doc = newDoc(sp, {});
    if (view === 'space' && ring.ctx === 'space') renderRing();
    openDoc(doc.id, { fresh: true });
  }

  function openDoc(id, opts = {}) {
    const sp = spaceOfDoc(id);
    if (!sp) return;
    const doc = sp.docs.find(d => d.id === id);
    // côté lecteur (export, ou mode Lecteur de l'app) : la page s'ouvre telle que l'auteur l'a présentée
    if (asReader()) {
      if (isLocked(doc)) { unlockDoc(doc).then(ok => { if (ok) openReader(doc, false); }); return; }
      return openReader(doc, false);
    }
    edDoc = doc;
    noteOpen(doc.id);
    spellPaintBtn();
    state.current = sp.id;
    $('#edTitle').textContent = doc.title;
    $('.sheet').classList.toggle('night', !!doc.night);
    const body = edBody();
    body.innerHTML = doc.html;
    $('#edTitle').contentEditable = READONLY ? 'false' : 'plaintext-only';
    body.contentEditable = READONLY ? 'false' : 'true';
    if (READONLY) for (const a of $$('a', body)) { a.target = '_blank'; a.rel = 'noopener'; }
    else {
      // un texte vide commence par un vrai paragraphe
      if (!body.innerHTML.trim()) body.innerHTML = '<p><br></p>';
      normalizeDivs(); normalizeCallouts(); normalizeQuotes(); tidy(); ensureTrailingParagraph();
    }
    $('#edSpaceName').textContent = sp.title;
    $('#edStatus').textContent = doc.updatedAt ? 'Modifié le ' + new Date(doc.updatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
    fillMoveSelect(sp);
    paintColorButton();
    hideTools();
    show('editor');
    $('#edScroll').scrollTop = 0;
    // le ruban ramène là où on s'était arrêté
    if (doc.ribbon && doc.ribbon.at && !opts.fresh) requestAnimationFrame(() => { const k = edBody().children[doc.ribbon.at]; if (k && edDoc === doc) k.scrollIntoView({ block: 'start' }); });
    if (opts.fresh && !READONLY) $('#edTitle').focus();
    histReset();
    if (VSTORE && !vers.open.has(doc)) loadVersions(doc);
    else if (!READONLY && snapshot(doc)) persist();
    if (sync.on) { presence.sent = ''; schedulePresence(); requestAnimationFrame(renderPeers); }
    $('.sheet').classList.toggle('a4', a4.on);
    requestAnimationFrame(layoutA4);
    sound.seed('carte:' + doc.id, docMood(doc));
  }

  /* Choix de couleur d'une carte (texte ou espace). */
  function openColorPop(anchor, current, onPick) {
    const pop = $('#colorPop');
    pop.innerHTML = `<div class="cp-head">Couleur de la carte</div><div class="cp-grid">`
      + `<button data-c="" class="auto${current ? '' : ' on'}" title="Automatique">A</button>`
      + SCENE_COLORS.map(c => `<button data-c="${c.id}" title="${esc(c.name)}" class="${c.id === current ? 'on' : ''}" style="--sw:${c.bg}"></button>`).join('')
      + `</div><div class="cp-name">${esc(current ? ALL_TONES.find(c => c.id === current).name : 'Automatique')}</div>`;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(12, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
    pop.style.top = (r.bottom + pop.offsetHeight + 12 > innerHeight ? r.top - pop.offsetHeight - 8 : r.bottom + 8) + 'px';
    pop.onmousedown = null;
    pop.onmouseover = e => {
      const b = e.target.closest('button[data-c]');
      if (b) $('.cp-name', pop).textContent = b.title;
    };
    pop.onclick = e => {
      const b = e.target.closest('button[data-c]');
      if (!b) return;
      onPick(b.dataset.c || null);
      pop.hidden = true;
    };
  }

  // couleur lisible sur la page blanche : la teinte elle-même si elle est assez sombre, sinon son encre
  function inkOf(c) {
    const n = parseInt(c.bg.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
    return lum < .62 ? c.bg : c.fg;
  }

  /* Couleur du texte ou surlignage, avec la même palette que les cartes. */
  function openTextColorPop(anchor) {
    saveRange();
    const pop = $('#colorPop');
    const swatch = (c, mode) => mode === 'text'
      ? `<button data-mode="text" data-c="${c.id}" title="${esc(c.name)}" class="txt" style="--sw:${inkOf(c)}">A</button>`
      : `<button data-mode="hl" data-c="${c.id}" title="${esc(c.name)}" class="hl" style="--sw:${c.bg};color:${c.fg}">A</button>`;
    pop.innerHTML = `<div class="cp-head">Couleur du texte</div><div class="cp-grid">`
      + `<button data-mode="reset" class="auto" title="Par défaut">×</button>`
      + SCENE_COLORS.map(c => swatch(c, 'text')).join('')
      + `</div><div class="cp-head">Surlignage (comme les cartes)</div><div class="cp-grid">`
      + SCENE_COLORS.map(c => swatch(c, 'hl')).join('')
      + `</div><div class="cp-name">Choisissez une couleur</div>`;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(12, r.left + r.width / 2 - pop.offsetWidth / 2)) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.onmousedown = e => e.preventDefault();
    pop.onmouseover = e => {
      const b = e.target.closest('button[data-mode]');
      if (b) $('.cp-name', pop).textContent = b.title;
    };
    pop.onclick = e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      const c = ALL_TONES.find(x => x.id === b.dataset.c);
      restoreRange();
      document.execCommand('styleWithCSS', false, true);
      if (b.dataset.mode === 'reset') {
        document.execCommand('foreColor', false, '#1b1b1b');
        document.execCommand('hiliteColor', false, 'transparent');
      } else if (b.dataset.mode === 'text') {
        document.execCommand('foreColor', false, inkOf(c));
      } else {
        document.execCommand('hiliteColor', false, c.bg);
        document.execCommand('foreColor', false, c.fg);
      }
      document.execCommand('styleWithCSS', false, false);
      // « Par défaut » ne laisse pas de couleur figée (qui resterait sombre de nuit)
      tidy();
      $('#accentBar').style.background = c ? (b.dataset.mode === 'text' ? inkOf(c) : c.bg) : 'var(--accent)';
      saveRange();
      changed();
      pop.hidden = true;
    };
  }

  function paintColorButton() {
    paintMoodButton();
  }

  /* Mood de la page : l'humeur de la musique pendant qu'on la lit (et dans l'export). */
  const PAGE_MOODS = [
    { id: '', name: 'Selon la couleur', hint: 'La couleur de la carte guide la musique' },
    { id: 'calme', name: 'Calme', hint: 'Très lent, de longues notes graves' },
    { id: 'contemplatif', name: 'Contemplatif', hint: 'Ouvert, suspendu, comme un horizon' },
    { id: 'lumineux', name: 'Lumineux', hint: 'Clair et cristallin, des cloches' },
    { id: 'melancolique', name: 'Mélancolique', hint: 'Mineur, des cordes feutrées' },
    { id: 'mysterieux', name: 'Mystérieux', hint: 'Brumeux, une basse plus présente' },
    { id: 'onirique', name: 'Onirique', hint: 'Flottant, des éclats de verre' },
    { id: 'vif', name: 'Vif', hint: 'Plus rapide, une pulsation légère' },
    { id: 'intense', name: 'Intense', hint: 'Plus dense et plus ample' },
    { id: 'aube', name: 'Aube', hint: 'De très longs accords pleins d’espoir, des voix douces' },
    { id: 'horizon', name: 'Horizon', hint: 'Une lente montée lumineuse, un sommet, puis la retombée' },
    { id: 'ailleurs', name: 'Ailleurs', hint: 'Un monde parallèle : accords venus d’ailleurs, sons à l’envers' },
    { id: 'voyage', name: 'Voyage', hint: 'L’aube, l’horizon, puis ailleurs, à la suite' }
  ];

  const LOOK_ICON = '<svg viewBox="0 0 20 20"><path d="M5.5 2.8h6.2l3 3v11.4h-9.2z"/><path d="M11.5 2.9v3h3"/><path d="M7.8 9.5h4.6M7.8 12h4.6M7.8 14.5h3"/></svg>';
  const SCENE_ICON = '<svg viewBox="0 0 20 20"><path d="M3.4 8.4h13.2v7.9q0 1.2-1.2 1.2H4.6q-1.2 0-1.2-1.2z"/><path d="M3.4 8.4l-.7-2.7q-.2-1 .8-1.3l11.5-2.6q1-.2 1.3.8l.6 2.5z"/><path d="M6.5 3.8l2.2 3.3M11 2.8l2.2 3.3"/></svg>';
  function paintMoodButton() {
    if (!edDoc) return;
    const m = PAGE_MOODS.find(x => x.id === (edDoc.mood || '')) || PAGE_MOODS[0];
    // le libellé est dans un <span> pour pouvoir se raccourcir (…) quand la barre manque de place ; le texte entier reste en infobulle
    const pill = (el, label) => { el.innerHTML = `<span>${esc(label)}</span>`; el.title = label; };
    // le bouton réunit la carte (couleur, papier, repères), sa musique et la vue par pages
    $('#edLook').innerHTML = LOOK_ICON;
    $('#edLook').title = 'Personnaliser la carte' + (edDoc.mood ? ', ' + m.name : '');
    const p = PRESENTS.find(x => x.id === (edDoc.present || '')) || PRESENTS[0];
    const W = WEATHERS.find(x => x.id === edDoc.weather);
    // la mise en scène réunit la présentation et l'ambiance de la page : le bouton résume ce qui est choisi
    const extras = (edDoc.night ? ', Nuit' : '') + (W && W.id ? ', ' + W.name : '') + (edDoc.lamp ? ', Lampe' : '') + (edDoc.lock ? ', protégée' : '');
    $('#edScene').innerHTML = SCENE_ICON;
    $('#edScene').title = 'Mise en scène : ' + p.name + extras;
    $('#scPresent').innerHTML = `<i>${p.icon}</i><span>${esc(p.name + extras)}</span><b>▾</b>`;
  }

  /* ───────────── Présentation de la page ───────────── */

  const PRESENTS = [
    { id: '', group: 'Lecture', icon: ic('page'), name: 'Normale', short: 'Normale', hint: 'La page, simplement.' },
    { id: 'reveal', group: 'Lecture', icon: ic('reveal'), name: 'Révélation au défilement', short: 'Révélation', hint: 'Les paragraphes arrivent en fondu.' },
    { id: 'slides', group: 'Lecture', icon: ic('slides'), name: 'Diaporama', short: 'Diaporama', hint: 'Un écran par partie.' },
    { id: 'typewriter', group: 'Lecture', icon: ic('typewriter'), name: 'Machine à écrire', short: 'Machine', hint: 'Le texte se tape sous vos yeux.' },
    { id: 'phrase', group: 'Lecture', icon: ic('phrase'), name: 'Phrase par phrase', short: 'Phrases', hint: 'Une phrase à la fois.' },
    { id: 'memoire', group: 'Lecture', icon: ic('memoire'), name: 'Mémoire qui s’efface', short: 'Mémoire', hint: 'Ce qu’on a lu s’estompe.' },
    { id: 'flip', group: 'Matières', icon: ic('flip'), name: 'Carte à retourner', short: 'Carte', hint: 'Un recto, un verso.' },
    { id: 'encre', group: 'Matières', icon: ic('encre'), name: 'Encre qui se répand', short: 'Encre', hint: 'Chaque passage s’étale comme une tache d’encre.' },
    { id: 'mots', group: 'Matières', icon: ic('mots'), name: 'Constellation de mots', short: 'Mots', hint: 'Les mots dérivent, puis se rangent.' },
    { id: 'album', group: 'Souvenirs', icon: ic('album'), name: 'Album de souvenirs', short: 'Album', hint: 'Des notes et des photos sur une table.' },
    { id: 'film', group: 'Souvenirs', icon: ic('film'), name: 'Pellicule', short: 'Pellicule', hint: 'Image par image, avec le grain du projecteur.' },
    { id: 'carnet', group: 'Souvenirs', icon: ic('carnet'), name: 'Carnet de voyage', short: 'Carnet', hint: 'Un carnet qu’on feuillette.' },
    { id: 'lettre', group: 'Souvenirs', icon: ic('lettre'), name: 'Lettre', short: 'Lettre', hint: 'Une enveloppe à ouvrir.' },
    { id: 'voyage', group: 'Voyages', icon: ic('univers'), name: 'Univers', short: 'Univers', hint: 'Les passages flottent dans l’espace.' },
    { id: 'portes', group: 'Voyages', icon: ic('portes'), name: 'Couloir de portes', short: 'Portes', hint: 'Un passage derrière chaque porte.' },
    { id: 'planete', group: 'Voyages', icon: ic('planete'), name: 'Planète', short: 'Planète', hint: 'Une petite planète à faire tourner.' },
    { id: 'apesanteur', group: 'Voyages', icon: ic('apesanteur'), name: 'Apesanteur', short: 'Apesanteur', hint: 'Des phrases à attraper au vol.' }
  ];
  // présentations qui se lisent dans un univers sombre
  const DARK_PRESENTS = ['voyage', 'portes', 'mots', 'film', 'planete', 'apesanteur'];

  // mood choisi, sinon une page de nuit appelle une musique sombre, sinon la couleur décide
  function docMood(d) { return d.mood || (d.night ? 'sombre' : moodOf(d.color)); }

  function openPagePop() {
    const pop = $('#pagePop');
    const cur = edDoc.present || '';
    const curP = PRESENTS.find(p => p.id === cur) || PRESENTS[0];
    const groups = [...new Set(PRESENTS.map(p => p.group))];
    pop.innerHTML = '<div class="pp-head"><b>Présentation et ambiance</b></div>'
      + '<div class="pp-body">'
      + '<div class="pp-sec">Présentation</div>'
      + groups.map(gname => `<div class="pp-group">${gname}</div><div class="pp-grid">`
        + PRESENTS.filter(p => p.group === gname).map(p => `<button data-p="${p.id}" class="pp-tile${p.id === cur ? ' on' : ''}" data-hint="${esc(p.hint)}"><i>${p.icon}</i><span>${esc(p.short)}</span></button>`).join('')
        + '</div>').join('')
      + `<div class="pp-desc"><b>${esc(curP.name)}</b>${esc(curP.hint)}</div>`
      + '<div class="pp-sec">Ambiance</div>'
      + `<div class="pp-row"><span>Lumière</span><div class="pp-seg"><button data-t="jour" class="${edDoc.night ? '' : 'on'}">Jour</button><button data-t="nuit" class="${edDoc.night ? 'on' : ''}">Nuit</button></div></div>`
      + '<div class="pp-group">Atmosphère</div>'
      + `<div class="pp-grid pp-atmos">${WEATHERS.map(w => `<button data-w="${w.id}" title="${esc(w.name)}" class="pp-tile${(edDoc.weather || '') === w.id ? ' on' : ''}"><i>${w.icon}</i><span>${esc(w.short || w.name)}</span></button>`).join('')}</div>`
      + `<div class="pp-row"><span>Lampe qui suit le regard</span><button data-lamp="1" class="pp-switch${edDoc.lamp ? ' on' : ''}" aria-label="Lampe"><i></i></button></div>`
      + '<div class="pp-sec">Accès</div>'
      + `<div class="pp-row"><span>${edDoc.lock ? ic('lock') + ' Protégée par mot de passe' : 'Mot de passe'}</span><button data-lock="1" class="pp-link">${edDoc.lock ? 'Modifier' : 'Protéger'}</button></div>`
      + '</div>';
    pop.hidden = false;
    const r = $('#scPresent').getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(12, r.left)) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.onmouseover = e => {
      const t = e.target.closest('.pp-tile');
      const p = t ? PRESENTS.find(x => x.id === t.dataset.p) : curP;
      $('.pp-desc', pop).innerHTML = `<b>${esc(p.name)}</b>${esc(p.hint)}`;
    };
  }

  function bindPagePop() {
    $('#scPresent').addEventListener('click', e => {
      e.stopPropagation();
      if ($('#pagePop').hidden) openPagePop(); else $('#pagePop').hidden = true;
    });
    bindLook();
    $('#pagePop').addEventListener('click', e => {
      if (!edDoc) return;
      const p = e.target.closest('[data-p]'), t = e.target.closest('[data-t]');
      const wth = e.target.closest('[data-w]'), lamp = e.target.closest('[data-lamp]');
      if (wth) {
        if (wth.dataset.w) edDoc.weather = wth.dataset.w; else delete edDoc.weather;
      } else if (lamp) {
        if (edDoc.lamp) delete edDoc.lamp; else edDoc.lamp = true;
      } else if (p) {
        if ((p.dataset.p || '') === (edDoc.present || '')) return;
        if (p.dataset.p) edDoc.present = p.dataset.p; else delete edDoc.present;
        scn.sel = null; scn.view = null;
      } else if (t) {
        if (t.dataset.t === 'nuit') edDoc.night = true; else delete edDoc.night;
        $('.sheet').classList.toggle('night', !!edDoc.night);
        sound.seed('carte:' + edDoc.id, docMood(edDoc));
      } else if (e.target.closest('[data-lock]')) {
        $('#pagePop').hidden = true;
        editLock();
        return;
      } else return;
      paintMoodButton();
      changed();
      scenePush();
      if (p) renderScene();
      openPagePop();
    });
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('#pagePop, #scPresent')) $('#pagePop').hidden = true;
    });
  }

  function fillMoveSelect(sp) {
    const sel = $('#edMove');
    const ordered = [];
    const walk = list => { for (const s of list) { ordered.push(s); walk(childrenOf(s)); } };
    walk(topSpaces());
    sel.innerHTML = ordered.map(s => `<option value="${s.id}">${esc(pathOf(s).map(p => p.title).join(' / '))}</option>`).join('')
      + '<option value="__new">Nouvel espace…</option>';
    sel.value = sp.id;
  }

  const isEmptyDoc = d => !d.title.trim() && !plainOf(d) && !/<img|<hr/i.test(d.html);

  function commitEditor() {
    if (!edDoc || READONLY) return;
    inkSettle();
    // le moteur d'édition colle parfois un style sur le mot caché : on le retire
    for (const s of $$('.ix-hide[style]', edBody())) s.removeAttribute('style');
    const title = $('#edTitle').textContent.replace(/\s+/g, ' ').trim();
    const html = edBody().innerHTML.replace(/ class="sel"/g, '').replace(/ sel"/g, '"');
    // une carte seulement ouverte n'est pas « modifiée » : sinon elle paraîtrait toujours plus récente que celle
    // qui arrive d'un autre appareil, et la mise à jour en direct serait ignorée
    if (title === edDoc.title && html === edDoc.html) return;
    edDoc.title = title;
    edDoc.html = html;
    edDoc.updatedAt = Date.now();
  }

  /*
   * Historique d'annulation de l'éditeur. L'annulation native du navigateur ne connaît que ses
   * propres commandes : après nos retouches du document (citations, encadrés, cases à cocher…)
   * elle rejoue ses opérations au mauvais endroit et peut effacer des lignes. On garde donc des
   * instantanés du texte et on annule/rétablit nous-mêmes.
   */
  const hist = { stack: [], i: -1, timer: null, applying: false, keyAt: 0 };
  const HIST_MAX = 300;
  const HIST_BYTES = PHONE ? 16e6 : 64e6;

  function selPath() {
    const s = document.getSelection();
    if (!s.rangeCount) return null;
    const n = s.anchorNode, title = $('#edTitle');
    if (title.contains(n)) return { title: true, off: s.anchorOffset };
    const root = edBody();
    if (!root.contains(n)) return null;
    const path = [];
    for (let x = n; x !== root; x = x.parentNode) path.unshift(Array.prototype.indexOf.call(x.parentNode.childNodes, x));
    return { path, off: s.anchorOffset };
  }

  function restoreSel(p) {
    const root = edBody(), s = document.getSelection();
    const r = document.createRange();
    if (p && p.title) {
      const t = $('#edTitle');
      const node = t.firstChild || t;
      r.setStart(node, Math.min(p.off, node.nodeType === 3 ? node.length : node.childNodes.length));
      t.focus();
    } else {
      let n = root;
      if (p) for (const i of p.path) { if (!n.childNodes[i]) break; n = n.childNodes[i]; }
      root.focus();
      if (p && n !== root) r.setStart(n, Math.min(p.off, n.nodeType === 3 ? n.length : n.childNodes.length));
      else { r.selectNodeContents(root); r.collapse(false); }
    }
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
    saveRange();
  }

  const histState = () => ({ html: edBody().innerHTML, title: $('#edTitle').textContent, sel: selPath() });

  function histReset() {
    clearTimeout(hist.timer);
    hist.stack = [histState()];
    hist.i = 0;
    histPaint();
  }

  // sur iPhone, les boutons annuler et rétablir s'estompent quand il n'y a plus rien à faire
  function histPaint(typing) {
    if (!PHONE) return;
    $('#edUndo').classList.toggle('off', !typing && hist.i <= 0);
    $('#edRedo').classList.toggle('off', !!typing || hist.i >= hist.stack.length - 1);
  }

  // enregistre l'état courant comme une étape (si le texte a changé depuis la dernière)
  function histCommit() {
    clearTimeout(hist.timer);
    if (hist.applying || view !== 'editor' || READONLY || hist.i < 0) return;
    const st = histState();
    const top = hist.stack[hist.i];
    if (top && top.html === st.html && top.title === st.title) { top.sel = st.sel; histPaint(); return; }
    hist.stack.length = hist.i + 1;
    hist.stack.push(st);
    if (hist.stack.length > HIST_MAX) hist.stack.shift();
    // une page chargée d'images pèse lourd : l'annulation garde au plus 64 Mo (mais toujours quelques étapes)
    let weight = hist.stack.reduce((n, s) => n + s.html.length, 0);
    while (weight > HIST_BYTES && hist.stack.length > 8) weight -= hist.stack.shift().html.length;
    hist.i = hist.stack.length - 1;
    histPaint();
  }

  // la frappe continue est regroupée en une seule étape
  function histSchedule() {
    if (hist.applying) return;
    clearTimeout(hist.timer);
    hist.timer = setTimeout(histCommit, 700);
    histPaint(true);
  }

  function histApply(st) {
    hist.applying = true;
    hideTools();
    // feuille manuscrite ouverte : elle reste exactement où elle est, même si l'annulation la raccourcit
    const open = ink.active, top = open && open.scrollTop, page = $('#edScroll').scrollTop;
    if (open) edBody().style.setProperty('--ink-keep', inkSvg(open).getBoundingClientRect().height + 'px');
    edBody().innerHTML = st.html;
    $('#edTitle').textContent = st.title;
    if (open) { inkRefind(top); $('#edScroll').scrollTop = page; }
    // clavier fermé sur iPhone : annuler ne le rouvre pas, et la page ne bouge pas
    else if (PHONE && !document.activeElement.closest('#edBody, #edTitle')) $('#edScroll').scrollTop = page;
    else { restoreSel(st.sel); if (PHONE) $('#edScroll').scrollTop = page; }
    commitEditor();
    persist();
    scheduleA4();
    $('#edStatus').textContent = 'Enregistré';
    refreshToolbar();
    hist.applying = false;
    histPaint();
  }

  function undo() {
    inkCommitNow();
    histCommit();
    if (hist.i <= 0) return;
    hist.i--;
    histApply(hist.stack[hist.i]);
  }

  function redo() {
    inkCommitNow();
    histCommit();
    if (hist.i >= hist.stack.length - 1) return;
    hist.i++;
    histApply(hist.stack[hist.i]);
  }

  /* ───────────── Le correcteur ─────────────
   * Rouge pour l'orthographe (le dictionnaire du système), bleu pour la grammaire (le système sur Mac, et les règles
   * ci-dessous partout). Rien ne quitte l'appareil. Les soulignés sont sur une couche à part : ils ne touchent pas au
   * texte, donc ni à l'enregistrement, ni à l'annulation, ni à la synchronisation.
   */
  const L = 'a-zà-öø-ÿœæ', VOW = 'aeiouàâäéèêëîïôöùûüœæ';
  const elide = { le: 'l’', la: 'l’', de: 'd’', je: 'j’', me: 'm’', te: 't’', se: 's’', ne: 'n’', que: 'qu’' };
  const NO_ELIDE = /^(onze|onzième|oui|ouistiti|une|un|où|à|et|ou|en)$/;
  const MUTE_H = 'homme|hommes|heure|heures|histoire|histoires|hôtel|hôtels|hiver|habitude|habitudes|herbe|herbes|hôpital|honneur|humain|humains|huile|hiérarchie|hypothèse|humeur|héritage|horizon';
  const FIXED_PLURAL = /^(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille|autre|même|moins|plus)$/;
  const NOT_PARTICIPLE = /^(hier|premier|dernier|entier|léger|cher|amer|fier|super|papier|métier|cahier|clavier|escalier|panier|quartier|chantier|sentier|boulanger|danger|étranger|mer|ver|fer|hiver|cuiller|poster|laser|dîner|déjeuner|goûter)$/;
  const NOT_INFINITIVE = /^(été|côté|beauté|liberté|vérité|café|thé|bébé|société|santé|qualité|quantité|réalité|ville|pré|clé|idée|année|journée|très|mauvaisé)$/;
  const SUBJECT = /(^|\s)(je|tu|il|elle|on|nous|vous|ils|elles|ne|n’|j’)\s*$/i;

  function grammarIssues(text) {
    const out = [], rule = (re, fn) => {
      for (const m of text.matchAll(re)) { const r = fn(m); if (r) out.push({ s: m.index + (r.at || 0), l: r.len || m[0].length, k: 'g', m: r.m, g: r.g }); }
    };
    const low = v => v.toLowerCase(), keep = (from, to) => from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
    // la liaison : « le arbre » devient « l'arbre »
    rule(new RegExp(`(?<![${L}’'-])(le|la|de|je|me|te|se|ne|que)\\s+((?:[${VOW}]|${MUTE_H.replace(/\|/g, '|')})[${L}]*)`, 'gi'), m => {
      const w = low(m[2]);
      if (NO_ELIDE.test(w) || (!new RegExp(`^[${VOW}]`).test(w) && !new RegExp(`^(${MUTE_H})$`).test(w))) return;
      return { m: 'Élision', g: [keep(m[1], elide[low(m[1])]) + m[2]] };
    });
    rule(new RegExp(`(?<![${L}’'-])si\\s+(ils?)(?![${L}])`, 'gi'), m => ({ m: 'Élision', g: [keep(m[0], 's’') + m[1]] }));
    // les confusions avec le verbe avoir ou être
    rule(new RegExp(`(?<![${L}’'-])(il|elle|on)\\s+à(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [`${m[1]} a`] }));
    rule(new RegExp(`(?<![${L}’'-])(il|elle|on)\\s+ont(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [`${m[1]} a`] }));
    rule(new RegExp(`(?<![${L}’'-])(ils|elles)\\s+(a|à)(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [`${m[1]} ont`] }));
    rule(new RegExp(`(?<![${L}’'-])(ils|elles)\\s+est(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [`${m[1]} sont`] }));
    rule(new RegExp(`(?<![${L}’'-])(il|elle|on)\\s+sont(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [`${m[1]} est`] }));
    rule(new RegExp(`(?<![${L}’'-])tu\\s+est(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: [m[0].slice(0, 2) + ' es'] }));
    rule(new RegExp(`(?<![${L}’'-])je\\s+es?t?(?![${L}])`, 'gi'), m => ({ m: 'Accord du verbe', g: ['je suis'] }));
    rule(new RegExp(`(?<![${L}’'-])on\\s+([${L}]{2,}é)(?![${L}])`, 'gi'), m => NOT_INFINITIVE.test(low(m[1])) ? null : { m: 'Confusion on / ont', g: [`ont ${m[1]}`] });
    // après avoir, le participe ; après aller, pouvoir, vouloir, devoir, l'infinitif
    rule(new RegExp(`(?<![${L}-])(ai|as|a|avons|avez|ont|avait|avais|avaient)\\s+([${L}]{2,}er)(?![${L}])`, 'gi'), m => {
      if (NOT_PARTICIPLE.test(low(m[2]))) return;
      return { at: m[0].length - m[2].length, len: m[2].length, m: 'Participe passé', g: [m[2].slice(0, -2) + 'é'] };
    });
    rule(new RegExp(`(?<![${L}’'-])(vais|vas|va|allons|allez|vont|peux|peut|pouvons|pouvez|peuvent|veux|veut|voulons|voulez|veulent|dois|doit|devons|devez|doivent|pour|sans)\\s+([${L}]{2,}é)(?![${L}])`, 'gi'), m => {
      if (NOT_INFINITIVE.test(low(m[2]))) return;
      return { at: m[0].length - m[2].length, len: m[2].length, m: 'Infinitif', g: [m[2].slice(0, -1) + 'er'] };
    });
    // le pluriel après un déterminant
    rule(new RegExp(`(?<![${L}’'-])(les|des|ces|mes|tes|ses|nos|vos|leurs|plusieurs|quelques)\\s+([${L}]{3,})(?![${L}’'-])`, 'gi'), m => {
      const w = low(m[2]);
      if (/[sxz]$/.test(w) || FIXED_PLURAL.test(w) || !/[aeiouéèêy]$|[bcdfglmnprt]$/.test(w)) return;
      // « je les mange » : « les » est alors un pronom
      if (low(m[1]) === 'les' && (SUBJECT.test(text.slice(0, m.index)) || /(er|ir|re|nt)$/.test(w))) return;
      return { at: m[0].length - m[2].length, len: m[2].length, m: 'Accord au pluriel', g: [m[2] + 's'] };
    });
    // le mot répété
    rule(new RegExp(`(?<![${L}’'-])([${L}]{2,})\\s+\\1(?![${L}’'-])`, 'gi'), m => {
      if (/^(nous|vous|que)$/i.test(m[1]) || m[0].split(/\s+/)[0] !== m[0].split(/\s+/)[1]) return;
      return { m: 'Mot répété', g: [m[1]] };
    });
    rule(/(?<=\S) {2,}(?=\S)/g, () => ({ m: 'Espaces en trop', g: [' '] }));
    return out;
  }

  const spell = { cache: new Map(), state: new WeakMap(), ignored: new Set(), items: [], timer: 0, raf: 0, running: false, again: false, held: false };
  const spellOn = () => sound.prefs().spell !== false;

  // les paragraphes à relire : le titre, puis chaque paragraphe, ligne de liste ou titre, hors blocs interactifs et code
  function spellLeaves() {
    const out = [$('#edTitle')], BLOCK = 'p, li, ul, ol, blockquote, div, h1, h2, h3, details, table, tr, td, th';
    const walk = el => {
      if (el.matches('[contenteditable="false"], pre, code, [data-ix]')) return;
      const kids = Array.from(el.children).filter(c => c.matches(BLOCK));
      if (kids.length) kids.forEach(walk); else out.push(el);
    };
    Array.from(edBody().children).forEach(walk);
    return out;
  }
  function spellText(el) {
    const nodes = [];
    let text = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('[contenteditable="false"], code, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, at: text.length }); text += n.nodeValue; }
    return { text, nodes };
  }
  function spellRange(map, s, l) {
    const find = at => { let k = map.nodes.length - 1; while (k > 0 && map.nodes[k].at > at) k--; return map.nodes[k]; };
    if (!map.nodes.length) return null;
    const a = find(s), b = find(s + l - 1), r = document.createRange();
    r.setStart(a.n, s - a.at);
    r.setEnd(b.n, s + l - b.at);
    return r;
  }
  // on garde ce qui mérite d'être montré : pas les noms propres au milieu d'une phrase, ni les mots avec un chiffre
  function spellKeep(text, list) {
    const seen = [], out = [];
    for (const it of [...list.filter(x => x.k === 's'), ...list.filter(x => x.k !== 's')]) {
      const word = text.substr(it.s, it.l);
      if (it.k === 's' && (word.length < 2 || /\d/.test(word) || (/^[A-ZÀ-Ý]/.test(word) && it.s > 0 && !/[.!?…:]\s*$/.test(text.slice(0, it.s))) || /^[A-ZÀ-Ý]{2,}$/.test(word))) continue;
      if (seen.some(o => it.s < o.s + o.l && o.s < it.s + it.l)) continue;
      seen.push(it);
      out.push({ ...it, word });
    }
    return out;
  }
  async function spellRun() {
    if (spell.running) { spell.again = true; return; }
    if (view !== 'editor' || !edDoc || READONLY || !spellOn()) return spellPaint();
    spell.running = true;
    try {
      const leaves = spellLeaves().map(el => ({ el, map: spellText(el) })).filter(x => x.map.text.trim());
      const missing = [...new Set(leaves.map(x => x.map.text))].filter(t => !spell.cache.has(t));
      for (let i = 0; i < missing.length; i += 24) {
        const part = missing.slice(i, i + 24);
        const found = NATIVE ? await call('spellCheck', part).catch(() => null) : null;
        part.forEach((t, k) => spell.cache.set(t, spellKeep(t, [...((found && found[k]) || []), ...grammarIssues(t)])));
        if (i + 24 < missing.length) { spellPaint(leaves); await new Promise(r => setTimeout(r, 30)); }
      }
      if (spell.cache.size > 4000) spell.cache.clear();
      spellPaint(leaves);
    } finally {
      spell.running = false;
      if (spell.again) { spell.again = false; spellLater(); }
    }
  }
  function spellPaint(leaves) {
    spell.items = [];
    spell.held = false;
    if (leaves && spellOn()) {
      const s = document.getSelection(), caret = s.rangeCount && s.isCollapsed ? s.getRangeAt(0) : null;
      for (const { el, map } of leaves) {
        const list = [];
        for (const it of spell.cache.get(map.text) || []) {
          if (spell.ignored.has(it.word)) continue;
          const r = spellRange(map, it.s, it.l);
          if (!r) continue;
          // le mot qu'on est en train de taper n'est pas encore une faute
          if (caret && caret.startContainer === r.endContainer && caret.startOffset === r.endOffset) { spell.held = true; continue; }
          list.push({ ...it, r });
        }
        spell.state.set(el, list);
        spell.items.push(...list);
      }
    }
    spellDraw();
  }
  // les vagues sont posées sur une couche à part, au-dessus de la page, sans jamais toucher au texte
  function spellDraw() {
    const page = $('#edScroll .page');
    if (!page) return;
    let layer = $('#spellLayer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'spellLayer'; page.prepend(layer); }
    // (en pages A4, la page peut être réduite pour tenir dans la fenêtre)
    const o = layer.getBoundingClientRect(), k = page.getBoundingClientRect().width / page.offsetWidth || 1;
    let html = '';
    for (const it of spell.items) for (const b of it.r.getClientRects()) {
      if (b.width < 1) continue;
      html += `<i class="${it.k === 's' ? 'w-s' : 'w-g'}" style="left:${((b.left - o.left) / k).toFixed(1)}px;top:${((b.bottom - o.top) / k - 1).toFixed(1)}px;width:${(b.width / k).toFixed(1)}px"></i>`;
    }
    layer.innerHTML = html;
  }
  const spellLater = () => { clearTimeout(spell.timer); spell.timer = setTimeout(spellRun, 650); };

  function spellAt(x, y) {
    if (!spellOn()) return null;
    const c = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    if (!c) return null;
    const el = (c.startContainer.nodeType === 3 ? c.startContainer.parentElement : c.startContainer).closest('p, li, h1, h2, h3, blockquote, div');
    for (let e = el; e && (e === $('#edTitle') || edBody().contains(e)); e = e.parentElement) {
      const hit = (spell.state.get(e) || []).find(it => it.r.comparePoint(c.startContainer, c.startOffset) === 0);
      if (hit) return hit;
    }
    return null;
  }
  // masquer les fautes, le temps de relire ou de présenter sa page : le réglage suit l'app, sur toutes les pages
  function spellPaintBtn() {
    const b = $('#tbSpell'), on = spellOn();
    b.classList.toggle('muted', !on);
    b.title = on ? 'Masquer les fautes' : 'Afficher les fautes';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(!on));
  }
  function spellToggle() {
    sound.prefs().spell = !spellOn();
    persist();
    spellPaintBtn();
    spellRun();
    sound.tick();
  }
  function spellItems(it) {
    const fix = v => {
      const s = document.getSelection();
      (it.r.startContainer.parentElement.closest('[contenteditable]') || edBody()).focus();
      s.removeAllRanges();
      s.addRange(it.r);
      document.execCommand('insertText', false, v);
      s.collapseToEnd();
    };
    return [{ head: it.k === 's' ? 'Orthographe' : it.m || 'Grammaire' },
      ...(it.g || []).map(v => ({ label: v === ' ' ? 'Une seule espace' : v, act: () => fix(v) })),
      (it.g || []).length ? '-' : null,
      { label: 'Ignorer', act: () => { spell.ignored.add(it.word); spellRun(); } },
      it.k === 's' ? { label: 'Ajouter au dictionnaire', act: () => { if (NATIVE) call('spellLearn', it.word).catch(() => {}); spell.ignored.add(it.word); spell.cache.clear(); spellRun(); } } : null,
      '-', { label: 'Masquer les fautes', act: spellToggle }];
  }
  function bindSpell() {
    if (READONLY) return;
    $('#tbSpell').addEventListener('mousedown', e => e.preventDefault());
    $('#tbSpell').addEventListener('click', spellToggle);
    // le texte bouge : les vagues le suivent aussitôt, et la relecture attend la fin de la frappe
    const redraw = () => { if (!spell.raf) spell.raf = setTimeout(() => { spell.raf = 0; spellDraw(); }, 160); };
    const seen = () => { if (view === 'editor') { redraw(); spellLater(); } };
    addEventListener('resize', redraw);
    new ResizeObserver(redraw).observe(edBody());
    new MutationObserver(seen).observe(edBody(), { childList: true, subtree: true, characterData: true });
    new MutationObserver(seen).observe($('#edTitle'), { childList: true, subtree: true, characterData: true });
    document.addEventListener('selectionchange', () => { if (spell.held) spellLater(); });
    // toucher un mot souligné propose sa correction
    for (const box of [edBody(), $('#edTitle')]) box.addEventListener('click', e => {
      if (ink.active || !document.getSelection().isCollapsed) return;
      const it = spellAt(e.clientX, e.clientY);
      // (après ce clic, sinon il refermerait le menu aussitôt ouvert)
      // et, si le clavier est en train de monter, une fois qu'il est là
      const vv = window.visualViewport, rising = TOUCH && vv && innerHeight - vv.height < 80;
      if (it) setTimeout(() => showMenu(e.clientX, e.clientY + 12, spellItems(it)), rising ? 550 : 60);
    });
  }

  let toolbarLater = 0;
  function bindHistory() {
    const body = edBody(), title = $('#edTitle');
    // ⌘Z / Ctrl+Z annule, ⇧⌘Z / ⌘Y / Ctrl+Y rétablit
    document.addEventListener('keydown', e => {
      if (view !== 'editor' || READONLY || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (ink.active) return;   // une feuille manuscrite ouverte a ses propres raccourcis (sinon ⌘Z annulerait deux fois)
      if (!$('#scene').hidden) {
        // dans un champ, ⌘Z annule la frappe comme d'habitude
        if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'y') { e.preventDefault(); e.stopPropagation(); sceneStep(k === 'y' || e.shiftKey ? 1 : -1); }
        return;
      }
      if (!body.contains(e.target) && e.target !== body && e.target !== title && e.target !== document.body) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); e.stopPropagation(); redo(); }
    }, true);
    // « Annuler » / « Rétablir » du menu Édition arrivent ici
    for (const el of [body, title]) {
      el.addEventListener('beforeinput', e => {
        if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); }
        else if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); }
      });
    }
    // une étape avant et après chaque action qui structure le texte
    body.addEventListener('keydown', e => {
      if (['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key) || ((e.metaKey || e.ctrlKey) && /^[biuxv]$/i.test(e.key))) {
        // une touche d'effacement gardée enfoncée ne relit pas toute la page à chaque lettre : une seule étape, à la fin
        const now = performance.now(), burst = (e.key === 'Backspace' || e.key === 'Delete') && now - hist.keyAt < 500;
        hist.keyAt = now;
        if (burst) { histSchedule(); return; }
        histCommit();
        setTimeout(histCommit, 0);
      }
    }, true);
    for (const type of ['paste', 'drop', 'cut']) {
      body.addEventListener(type, () => { histCommit(); setTimeout(histCommit, 0); }, true);
    }
    // la fin d'un mot clôt une étape de frappe
    body.addEventListener('input', e => {
      if (e.data && /[\s.,;:!?]$/.test(e.data)) setTimeout(histCommit, 0);
    });
  }

  // une grande page (images comprises) n'est pas relue à chaque touche : persist la reprend juste avant d'enregistrer
  let commitLater = 0;
  function changed() {
    if (edDoc.html.length < 3e5) commitEditor();
    else { clearTimeout(commitLater); commitLater = setTimeout(commitEditor, 300); }
    edDoc.updatedAt = Date.now();
    if (edDoc.share) shareSoon();
    snapshot(edDoc);
    $('#edStatus').textContent = 'Enregistrement…';
    onSaved = () => { if (view === 'editor') { $('#edStatus').textContent = 'Enregistré'; sound.saved(); } };
    persist();
    histSchedule();
    scheduleA4();
  }

  /*
   * Revenir à l'espace d'un geste. L'espace est rétabli tout de suite, dessous ; par-dessus, une copie de la feuille
   * se soulève et repart, puis disparaît. Rien ne change d'état au milieu de la transition : pas de saut possible.
   */
  function leaveEditor() {
    if (view !== 'editor' || $('.leave-ghost')) return;
    // une page chargée d'images n'est pas recopiée pour l'animation : sur iPhone, c'est ce qui épuisait la mémoire
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || edDoc.html.length > 3e5 || PHONE) return closeEditor();
    const sheet = $('.sheet'), r = sheet.getBoundingClientRect(), top = $('#edScroll').scrollTop;
    const wrap = document.createElement('div'), ghost = sheet.cloneNode(true);
    wrap.className = 'leave-ghost';
    // la copie garde ses identifiants (les styles du titre en dépendent) ; $('#…') trouve toujours l'original, placé avant elle
    for (const el of $$('[contenteditable]', ghost)) el.removeAttribute('contenteditable');
    Object.assign(ghost.style, { position: 'absolute', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0 });
    wrap.append(ghost);
    document.body.append(wrap);
    const sc = $('.ed-scroll', ghost);
    if (sc) sc.scrollTop = top;
    // l'espace revient par couches pendant que la feuille repart. D'abord posé, immobile, dans son état de départ
    // (back-pre), puis relâché une image plus tard (back-go) : des transitions, qui partent toujours de ce qui est
    // déjà affiché. Des animations à délai faisaient voir un éclair de l'état final dans WebKit.
    const b = document.body.classList;
    clearTimeout(leaveEditor.t);
    b.remove('back-go');
    b.add('back-pre');
    closeEditor();
    void document.body.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      b.remove('back-pre');
      b.add('back-go');
      leaveEditor.t = setTimeout(() => b.remove('back-go'), 1500);
    }));
    setTimeout(() => wrap.remove(), 520);
  }

  function closeEditor() {
    if (sync.on) setTimeout(() => sendPresence(), 0);
    $('#scene').hidden = true;
    $('#versions').hidden = true;
    if (!edDoc) return enterSpace(null, { instant: true, keepRotation: true });
    commitEditor();
    if (edDoc.ribbon && !READONLY) edDoc.ribbon = ribbonSpot();
    const sp = spaceOfDoc(edDoc.id);
    const id = edDoc.id, fromQuick = PHONE && edDoc.quick;
    if (!READONLY && sp && isEmptyDoc(edDoc)) sp.docs = sp.docs.filter(d => d !== edDoc);
    const closing = edDoc;
    edDoc = null;
    noteOpen(null);
    hideTools();
    persist(true);   // (envoie aussitôt ses versions, avant qu'elles ne quittent la mémoire)
    if (VSTORE && vers.open.has(closing)) dropVersions(closing);
    if (fromQuick) return showQuick();
    if (!state.spaces.length) return showWelcome();
    enterSpace(sp ? sp.id : null, { instant: true, focusId: id, keepRotation: true });
  }

  function saveRange() {
    const s = document.getSelection();
    if (s.rangeCount && edBody().contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  }

  function restoreRange() {
    const body = edBody();
    body.focus();
    const s = document.getSelection();
    s.removeAllRanges();
    if (savedRange && body.contains(savedRange.startContainer)) s.addRange(savedRange);
    else {
      const r = document.createRange();
      r.selectNodeContents(body);
      r.collapse(false);
      s.addRange(r);
    }
  }

  function exec(cmd, arg) {
    histCommit();
    restoreRange();
    document.execCommand(cmd, false, arg);
    if (cmd === 'formatBlock') { normalizeQuotes(); ensureTrailingParagraph(); }
    tidy();
    saveRange();
    changed();
    histCommit();
    refreshToolbar();
  }

  function refreshToolbar() {
    if (view !== 'editor') return;
    for (const b of $$('#toolbar [data-cmd]')) {
      const c = b.dataset.cmd;
      if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyCenter', 'justifyRight'].includes(c)) {
        let on = false;
        try { on = document.queryCommandState(c); } catch (e) { /* ignore */ }
        b.classList.toggle('on', on);
      }
    }
    let block = '';
    try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (e) { /* ignore */ }
    const sel = $('#tbBlock');
    sel.value = [...sel.options].some(o => o.value === block) ? block : 'p';
  }

  function insertHTMLAtSelection(html) {
    restoreRange();
    document.execCommand('insertHTML', false, html);
    saveRange();
    changed();
  }

  function insertImages(srcs) {
    if (!srcs || !srcs.length) return;
    insertHTMLAtSelection(srcs.map(s => `<img src="${esc(s)}" class="m">`).join('') + '<p><br></p>');
  }

  const pdfPagesHTML = pages => pages.map(p => `<img src="${esc(p)}" class="l pdf">`).join('');

  function bindEditor() {
    const body = edBody();
    const title = $('#edTitle');
    // Entrée crée toujours un paragraphe, jamais un <div> sans marges
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }

    $('#edExport').addEventListener('click', e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); exportMenu(r.left, r.bottom + 6); });
    $('#tbMore').addEventListener('mousedown', e => e.preventDefault());
    $('#tbMore').addEventListener('click', () => window.__editorMenu());
    for (const [id, go] of [['#edUndo', undo], ['#edRedo', redo]]) {
      $(id).addEventListener('mousedown', e => e.preventDefault());
      $(id).addEventListener('click', go);
    }
    $('#edBack').addEventListener('click', leaveEditor);
    // un clic à côté de la feuille la referme
    // (sauf autour d'une feuille manuscrite agrandie : ce clic-là la rend simplement à la page)
    $('#editor').addEventListener('mousedown', e => { if (e.button === 0 && !e.ctrlKey && e.target === $('#editor') && !document.body.classList.contains('ink-full')) leaveEditor(); });
    title.addEventListener('input', changed);
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); body.focus(); }
    });
    body.addEventListener('input', changed);

    document.addEventListener('selectionchange', () => {
      if (view !== 'editor') return;
      saveRange();
      // interroger l'état de la mise en forme force le moteur à tout mesurer : pas à chaque lettre
      clearTimeout(toolbarLater);
      toolbarLater = setTimeout(() => { refreshToolbar(); maybeShowLink(); }, 140);
    });

    // les boutons de la barre ne doivent pas voler la sélection
    $('#toolbar').addEventListener('mousedown', e => {
      if (e.target.closest('button')) e.preventDefault();
    });
    $('#toolbar').addEventListener('click', e => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'accent') return openTextColorPop(b);
      if (c === 'link') return openLinkPop();
      if (c === 'image') return pickImages();
      if (c === 'pdf') return insertPDFPages();
      if (c === 'table') return tableInsert();
      if (c === 'chart') return ixInsert('chart', { kind: 'bar' });
      exec(c);
    });
    $('#tbBlock').addEventListener('change', e => exec('formatBlock', '<' + e.target.value + '>'));
    body.addEventListener('keydown', tableKeys, true);
    body.addEventListener('input', e => { const n = document.getSelection().anchorNode, tb = n && (n.nodeType === 1 ? n : n.parentElement).closest('table'); if (tb && tb.querySelector('tr.tot')) tableTotals(tb); });
    body.addEventListener('mousedown', tableResize, true);
    body.addEventListener('pointerdown', mapPointer, true);
    for (const t of ['mousedown', 'click', 'dblclick']) body.addEventListener(t, e => { if (e.target.closest('.mp-plot')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    body.addEventListener('mousemove', e => {
      const cell = e.target.closest('td, th'), edge = cell && tableEdge(e, cell);
      body.classList.toggle('tb-col', edge === 'col');
      body.classList.toggle('tb-row', edge === 'row');
    });
    const cellAt = n => (n && (n.nodeType === 1 ? n : n.parentElement).closest('#edBody td, #edBody th')) || null;
    document.addEventListener('mousemove', e => { if (e.target.closest && !e.target.closest('.tb-plus') && !(TOUCH && tbPlus.cell)) tablePlus(cellAt(e.target)); });
    document.addEventListener('selectionchange', () => { if (TOUCH) tablePlus(cellAt(document.getSelection().anchorNode)); });
    $('#edScroll').addEventListener('scroll', () => tablePlus(null));

    body.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', u: 'underline' };
      if (map[k]) { e.preventDefault(); exec(map[k]); }
      // ⌘K : lien s'il y a du texte sélectionné, sinon la recherche globale prend le relais
      if (k === 'k' && !document.getSelection().isCollapsed) { e.preventDefault(); openLinkPop(); }
    });

    // collage : images en données, HTML nettoyé
    body.addEventListener('paste', e => {
      const cd = e.clipboardData;
      const files = Array.from(cd.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        saveRange();
        Promise.all(files.map(fileToDataURL)).then(insertImages);
        return;
      }
      // le collage s'adapte à l'endroit : titre de pli, intertitre, puce, citation, code, page
      const html = cd.getData('text/html'), text = cd.getData('text/plain');
      if (!html && !text) return;
      e.preventDefault();
      pasteFrom(html, text);
    });

    // ⌘C ou ⌘X sans sélection, dans un tableau ou sur un bloc qu'on vient de toucher : c'est le bloc entier qui part
    let touched = null;
    document.addEventListener('pointerdown', e => {
      const t = e.target.closest && body.contains(e.target) ? e.target.closest(ATOM_SEL + ', img') : null;
      touched = t;
    }, true);
    document.addEventListener('keydown', e => {
      if (READONLY || !(e.metaKey || e.ctrlKey) || !['c', 'x'].includes(e.key.toLowerCase()) || !touched || !touched.isConnected) return;
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      const s = document.getSelection();
      if (s.rangeCount && !s.isCollapsed) return;
      const r = document.createRange();
      r.selectNode(touched);
      s.removeAllRanges();
      s.addRange(r);
    }, true);
    for (const type of ['copy', 'cut']) body.addEventListener(type, e => {
      const s = document.getSelection();
      if (READONLY || !s.rangeCount || s.isCollapsed) return;
      const box = document.createElement('div');
      box.append(s.getRangeAt(0).cloneContents());
      if (!clipHasBlock(box.innerHTML)) return;
      e.preventDefault();
      e.clipboardData.setData('text/html', clipWrap(box.innerHTML));
      e.clipboardData.setData('text/plain', s.toString());
      if (type === 'cut') { s.deleteFromDocument(); tidy(); ensureTrailingParagraph(); changed(); }
    });

    body.addEventListener('dragover', e => { if (!READONLY) e.preventDefault(); });
    body.addEventListener('drop', e => {
      if (READONLY) return;
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) savedRange = r;
      const imgs = files.filter(f => f.type.startsWith('image/'));
      const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      Promise.all(imgs.map(fileToDataURL)).then(insertImages);
      for (const f of pdfs) renderPDFFile(f).then(res => { if (res) insertHTMLAtSelection(pdfPagesHTML(res.pages)); });
    });

    // images : sélection et outils de taille
    body.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && (READONLY || e.metaKey)) {
        e.preventDefault();
        openURL(a.href);
        return;
      }
      if (READONLY) return;
      if (e.target.closest('details.ix-fold > summary')) e.preventDefault();
      if (e.target.closest('.ix-voice')) return;
      const sheet = e.target.closest('.ix-ink');
      // (un clic qui termine un étirement de la feuille ne l'ouvre pas)
      if (sheet) { e.preventDefault(); if (Date.now() - (ink.resizedAt || 0) > 400) inkActivate(sheet); return; }
      // l'horodatage d'une note rapide est d'un seul bloc : on le retire d'un geste
      const stamp = e.target.closest('.qn-src');
      if (stamp) {
        e.preventDefault();
        if (TOUCH && document.activeElement) document.activeElement.blur();   // (sinon iOS ouvre aussi son menu Coller)
        setTimeout(() => showMenu(e.clientX, e.clientY + 12, [{ label: 'Retirer l’horodatage', danger: true, act: () => { histCommit(); stamp.remove(); ensureTrailingParagraph(); changed(); histCommit(); } }]), 60);
        return;
      }
      const ixEl = e.target.closest('[data-ix], .ix-note, .ix-goto, .ix-blank');
      if (ixEl && !(e.target.tagName === 'IMG' && ixEl.dataset.ix === 'gallery')) { e.preventDefault(); ixEdit(ixEl); return; }
      const icon = e.target.closest('.callout-icon');
      if (icon) { openIconPop(icon); return; }
      // case d'une liste de tâches
      const li = e.target.closest('ul.todo > li');
      if (li && e.clientX < li.getBoundingClientRect().left) {
        li.classList.toggle('done');
        sound.check(li.classList.contains('done'));
        changed();
        return;
      }
      if (e.target.tagName === 'IMG') selectImg(e.target);
      else hideImgTools();
    });
    $('#imgTools').addEventListener('mousedown', e => e.preventDefault());
    $('#imgTools').addEventListener('click', e => {
      if (e.target.closest('[data-size="cap"]') && selImg) return imgCaption(selImg);
      const b = e.target.closest('button');
      if (!b || !selImg) return;
      if (b.dataset.size === 'del') selImg.remove();
      else if (b.dataset.size === 'zoom') { selImg.toggleAttribute('data-zoom'); toast(selImg.hasAttribute('data-zoom') ? 'Loupe activée : le lecteur voit le détail sous son curseur' : 'Loupe retirée'); }
      else { selImg.classList.remove('s', 'm', 'l'); selImg.classList.add(b.dataset.size); }
      hideImgTools();
      changed();
    });
    $('#edScroll').addEventListener('scroll', () => { hideImgTools(); $('#linkPop').hidden = true; });

    // liens
    $('#linkInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
      if (e.key === 'Escape') { e.stopPropagation(); $('#linkPop').hidden = true; restoreRange(); }
    });
    $('#linkOk').addEventListener('click', applyLink);
    $('#linkRemove').addEventListener('click', () => {
      const a = linkAtSelection();
      if (a) { a.replaceWith(...a.childNodes); changed(); }
      else exec('unlink');
      $('#linkPop').hidden = true;
    });
    $('#linkOpen').addEventListener('click', () => {
      const v = normalizeURL($('#linkInput').value);
      if (v) openURL(v);
    });

    // déplacer / supprimer
    $('#edMove').addEventListener('change', async e => {
      if (!edDoc) return;
      const from = spaceOfDoc(edDoc.id);
      let to;
      if (e.target.value === '__new') {
        const name = await askName('Nouvel espace', "Nom de l'espace");
        if (!name) { e.target.value = from.id; return; }
        to = newSpace(name, null);
      } else {
        to = byId(e.target.value);
      }
      if (!to || to === from) return;
      from.docs = from.docs.filter(d => d !== edDoc);
      to.docs.push(edDoc);
      state.current = to.id;
      $('#edSpaceName').textContent = to.title;
      fillMoveSelect(to);
      persist();
      toast('Déplacé dans « ' + to.title + ' »');
    });
    armable($('#edDelete'), 'Confirmer la suppression', () => {
      sound.remove();
      const sp = spaceOfDoc(edDoc.id);
      sp.docs = sp.docs.filter(d => d !== edDoc);
      edDoc = null;
      persist(true);
      enterSpace(sp.id, { instant: true, keepRotation: true });
    });
  }

  /* ───────────── Menu « / » (comme dans Notion) ───────────── */

  const SLASH_ITEMS = [
    { id: 'p', label: 'Texte', hint: '', icon: 'T', keys: 'texte paragraphe text' },
    { id: 'h1', label: 'Titre', hint: '', icon: 'H1', keys: 'titre heading' },
    { id: 'h2', label: 'Sous-titre', hint: '', icon: 'H2', keys: 'sous-titre heading' },
    { id: 'h3', label: 'Intertitre', hint: '', icon: 'H3', keys: 'intertitre heading' },
    { id: 'ul', label: 'Liste à puces', hint: '', icon: ic('bullets'), keys: 'liste puces bullet' },
    { id: 'ol', label: 'Liste numérotée', hint: '', icon: '1.', keys: 'liste numerotee numbered' },
    { id: 'todo', label: 'Liste de tâches', hint: '', icon: ic('todo'), keys: 'taches todo cocher checkbox' },
    { id: 'quote', label: 'Citation', hint: '', icon: ic('quote'), keys: 'citation quote' },
    { id: 'callout', label: 'Encadré', hint: '', icon: ic('callout'), keys: 'encadre callout note' },
    { id: 'code', label: 'Code', hint: '', icon: '{ }', keys: 'code' },
    { id: 'hr', label: 'Séparateur', hint: '', icon: '—', keys: 'separateur ligne divider' },
    { id: 'table', label: 'Tableau', hint: '', icon: ic('table'), keys: 'tableau table lignes colonnes cellules' },
    { id: 'chart-bar', label: 'Graphique en barres', hint: '', icon: ic('bars'), keys: 'graphique barres histogramme diagramme chart' },
    { id: 'map', label: 'Mapping', hint: 'Deux axes et des points à placer', icon: ic('mapping'), keys: 'mapping positionnement matrice axes points graphique carte perceptuelle' },
    { id: 'chart-pie', label: 'Camembert', hint: '', icon: ic('pie'), keys: 'graphique camembert secteurs diagramme chart pie' },
    { id: 'image', label: 'Image', hint: '', icon: ic('image'), keys: 'image photo' },
    { id: 'pdf', label: 'Pages d’un PDF', hint: '', icon: 'PDF', keys: 'pdf document' },
    { id: 'voice', label: 'Note vocale', hint: 'Enregistrer sa voix', icon: ic('mic'), keys: 'vocal voix audio son enregistrer micro note' },
    { id: 'ink', label: 'Feuille manuscrite', hint: 'Écrire et dessiner à la main', icon: ic('sheet'), keys: 'feuille manuscrit main ecrire dessiner croquis schema notes stylet crayon pencil' },
    { id: 'date', label: 'Date du jour', hint: '', icon: ic('clock'), keys: 'date jour aujourd hui' },
    { id: 'ix-fold', label: 'Bloc dépliable', hint: 'Un titre qui révèle un contenu', icon: ic('fold'), keys: 'deplier depliable accordeon cacher interactif' },
    { id: 'ix-hide', label: 'Mot à découvrir', hint: 'Flouté jusqu’au clic', icon: ic('blur'), keys: 'mot cache flou decouvrir spoiler interactif' },
    { id: 'ix-blank', label: 'Trou à compléter', hint: 'Le lecteur complète librement', icon: ic('blank'), keys: 'trou texte a trous completer remplir mot interactif' },
    { id: 'ix-note', label: 'Note en marge', hint: 'Un mot qui ouvre une bulle', icon: ic('pen'), keys: 'note marge bulle commentaire interactif' },
    { id: 'ix-gallery', label: 'Galerie', hint: 'Images à faire défiler', icon: ic('gallery'), keys: 'galerie images photos carrousel interactif' },
    { id: 'ix-compare', label: 'Avant / après', hint: 'Deux images à comparer', icon: ic('compare'), keys: 'avant apres comparer comparateur interactif' },
    { id: 'ix-choices', label: 'Chemin à choix', hint: 'Le lecteur choisit la suite', icon: ic('fork'), keys: 'chemin choix parcours histoire interactif' },
    { id: 'ix-goto', label: 'Lien vers une carte', hint: 'Ouvre une autre carte', icon: ic('goto'), keys: 'lien carte aller interactif' },
    { id: 'ix-answer', label: 'Zone de réponse', hint: 'Le lecteur écrit', icon: ic('write'), keys: 'reponse question ecrire zone interactif' },
    { id: 'ix-quiz', label: 'Quiz', hint: 'Questions et score', icon: ic('quiz'), keys: 'quiz questions qcm score interactif' },
    { id: 'ix-check', label: 'Liste du lecteur', hint: 'Le lecteur coche', icon: ic('checked'), keys: 'liste cocher checklist lecteur interactif' },
    { id: 'ix-scratch', label: 'Carte à gratter', hint: 'On gratte pour découvrir', icon: ic('scratch'), keys: 'gratter carte grattage surprise interactif' },
    { id: 'ix-riddle', label: 'Énigme', hint: 'La bonne réponse débloque la suite', icon: ic('lock'), keys: 'enigme devinette question secret interactif' },
    { id: 'ix-breathe', label: 'Pause respiration', hint: 'Respiration guidée', icon: ic('breathe'), keys: 'respiration respirer pause calme meditation interactif' }
  ];
  const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let slash = null; // { node, start, items, sel }

  function slashCaret() {
    const s = document.getSelection();
    return s.rangeCount && s.isCollapsed ? { node: s.anchorNode, off: s.anchorOffset } : null;
  }

  // `inserted` : le texte que la frappe vient d'ajouter (un caractère, ou davantage).
  function openSlash(inserted) {
    const c = slashCaret();
    if (!c || c.node.nodeType !== 3) return;
    const start = c.node.textContent.lastIndexOf('/', c.off - 1);
    if (start < c.off - inserted.length) return;
    const before = c.node.textContent[start - 1];
    if (before !== undefined && !/[\s\u00a0]/.test(before)) return;
    slash = { node: c.node, start, items: SLASH_ITEMS, sel: 0 };
    sound.pop();
    updateSlash();
  }

  function closeSlash() {
    slash = null;
    $('#slashMenu').hidden = true;
  }

  function updateSlash() {
    const c = slashCaret();
    if (!c || c.node !== slash.node || c.off <= slash.start || slash.node.textContent[slash.start] !== '/') return closeSlash();
    const q = fold(slash.node.textContent.slice(slash.start + 1, c.off));
    if (q.length > 24 || / $/.test(q) && !SLASH_ITEMS.some(i => fold(i.label).startsWith(q))) return closeSlash();
    const words = q.trim().split(/\s+/).filter(Boolean);
    slash.items = SLASH_ITEMS.filter(i => words.every(w => fold(i.label + ' ' + i.keys).includes(w)));
    slash.sel = 0;
    renderSlash();
  }

  function renderSlash() {
    const menu = $('#slashMenu');
    menu.innerHTML = slash.items.length
      ? '<div class="slash-head">Blocs</div>' + slash.items.map((it, i) =>
        `<button data-i="${i}" class="${i === slash.sel ? 'on' : ''}"><span class="ic">${it.icon.startsWith('<') ? it.icon : esc(it.icon)}</span><span class="lb">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</span></button>`).join('')
      : '<div class="slash-empty">Aucun bloc ne correspond</div>';
    menu.hidden = false;
    const s = document.getSelection();
    let r = s.rangeCount ? s.getRangeAt(0).getClientRects()[0] : null;
    if (!r) r = slash.node.parentElement.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = Math.min(innerWidth - menu.offsetWidth - 12, Math.max(12, r.left - 8)) + 'px';
    menu.style.top = (r.bottom + h + 16 > innerHeight ? r.top - h - 8 : r.bottom + 8) + 'px';
    const on = $('button.on', menu);
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function chooseSlash(item) {
    histCommit();
    const c = slashCaret();
    if (c && c.node === slash.node) {
      const r = document.createRange();
      r.setStart(slash.node, slash.start);
      r.setEnd(slash.node, c.off);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('delete');
    }
    closeSlash();
    saveRange();
    runBlock(item.id);
  }

  function currentBlock() {
    const body = edBody();
    let n = document.getSelection().anchorNode;
    if (!n || !body.contains(n)) return null;
    if (n === body) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      body.appendChild(p);
      return p;
    }
    while (n.parentNode !== body) n = n.parentNode;
    if (n.nodeType === 3) {
      const p = document.createElement('p');
      n.replaceWith(p);
      p.appendChild(n);
      return p;
    }
    return n;
  }

  function runBlock(id) {
    const blocks = { p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', code: 'pre' };
    if (blocks[id]) { exec('formatBlock', '<' + blocks[id] + '>'); return ensureTrailingParagraph(); }
    if (id === 'ul') { exec('insertUnorderedList'); return unwrapList(); }
    if (id === 'ol') { exec('insertOrderedList'); return unwrapList(); }
    if (id === 'hr') return exec('insertHorizontalRule');
    if (id === 'table') return tableInsert();
    if (id === 'map') return ixInsert('map');
    if (id.startsWith('chart-')) return ixInsert('chart', { kind: id.slice(6) });
    if (id === 'image') return pickImages();
    if (id === 'pdf') return insertPDFPages();
    if (id === 'ink') return inkInsert();
    if (id === 'voice') return voiceInsert();
    if (id.startsWith('ix-')) return ixInsert(id.slice(3));
    if (id === 'date') return exec('insertText', new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    restoreRange();
    if (id === 'todo') {
      const inList = n => n && n.closest && n.closest('ul');
      let n = document.getSelection().anchorNode;
      if (n && n.nodeType === 3) n = n.parentNode;
      if (!inList(n)) document.execCommand('insertUnorderedList');
      n = document.getSelection().anchorNode;
      if (n && n.nodeType === 3) n = n.parentNode;
      const ul = inList(n);
      if (ul) ul.classList.add('todo');
      unwrapList();
    }
    if (id === 'callout') {
      const block = currentBlock();
      if (block && !block.closest('.callout')) {
        const box = document.createElement('div');
        box.className = 'callout';
        block.replaceWith(box);
        box.append(makeIcon(GLYPHS[0]), block);
        if (!block.textContent && !block.querySelector('br,img')) block.appendChild(document.createElement('br'));
        const r = document.createRange();
        r.selectNodeContents(block);
        r.collapse(false);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(r);
      }
    }
    ensureTrailingParagraph();
    saveRange();
    changed();
    histCommit();
  }

  // Le moteur d'édition glisse parfois la liste dans un <p> : on la remet au niveau du bloc.
  function unwrapList() {
    const s = document.getSelection();
    if (!s.rangeCount) return;
    const { anchorNode: node, anchorOffset: off } = s;
    const el = node && (node.nodeType === 3 ? node.parentNode : node);
    const list = el && el.closest && el.closest('ul, ol');
    const p = list && list.parentElement;
    if (!p || p.tagName !== 'P') return;
    p.replaceWith(...p.childNodes);
    s.removeAllRanges();
    const r = document.createRange();
    r.setStart(node, off);
    s.addRange(r);
    saveRange();
    changed();
  }

  /* ───────────── Sortir des blocs (citation, encadré, code) ───────────── */

  const BOX_SEL = 'blockquote, pre, .callout';
  const isEmptyFrag = frag => {
    for (const ic of frag.querySelectorAll('.callout-icon')) ic.remove();
    return !frag.textContent.replace(/[\s ]/g, '') && !frag.querySelector('img, hr');
  };

  // le bloc de premier niveau (citation, encadré, code) qui contient le curseur
  function caretBox() {
    const s = document.getSelection();
    if (!s.rangeCount || !s.isCollapsed) return null;
    let n = s.anchorNode;
    if (n && n.nodeType === 3) n = n.parentNode;
    const box = n && n.closest ? n.closest(BOX_SEL) : null;
    return box && box.parentNode === edBody() ? box : null;
  }

  function caretAt(box, where) {
    const s = document.getSelection();
    const r = document.createRange();
    r.selectNodeContents(box);
    if (where === 'start') r.setEnd(s.anchorNode, s.anchorOffset);
    else r.setStart(s.anchorNode, s.anchorOffset);
    return isEmptyFrag(r.cloneContents());
  }

  function emptyParagraph() {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    return p;
  }

  function caretInto(node, atEnd) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!atEnd);
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    saveRange();
  }

  // Les <div> nus (laissés par d'anciennes versions ou par Entrée après un titre) deviennent des paragraphes
  function normalizeDivs() {
    for (const d of Array.from(edBody().children)) {
      if (d.tagName !== 'DIV' || d.attributes.length) continue;
      const p = document.createElement('p');
      p.append(...d.childNodes);
      d.replaceWith(p);
    }
  }

  // Après une citation, un encadré, du code ou une image en fin de page, on garde toujours une ligne où écrire.
  function ensureTrailingParagraph() {
    const body = edBody();
    const last = body.lastElementChild;
    if (last && last.matches(BOX_SEL + ', hr, img, table, [data-ix], details')) body.appendChild(emptyParagraph());
  }

  // La dernière ligne du bloc est-elle vide ? (retour à la ligne final, paragraphe vide…)
  function endsWithEmptyLine(box) {
    let n = box.lastChild;
    while (n && n.nodeType === 3 && !n.textContent.replace(/[ \t\u00a0]/g, '') && !n.textContent.includes('\n')) n = n.previousSibling;
    if (!n) return true;
    if (n.nodeName === 'BR') return true;
    if (n.nodeType === 3) return /\n$/.test(n.textContent);
    if (n.classList && n.classList.contains('callout-icon')) return true;
    return !n.textContent.replace(/[\s\u00a0]/g, '') && !n.querySelector('img');
  }

  // On retire les lignes vides laissées en fin de bloc après une coupure.
  function trimBox(box) {
    for (let n = box.lastChild; n; n = box.lastChild) {
      if (n.nodeType === 3 && !n.textContent.replace(/[\s ]/g, '')) { n.remove(); continue; }
      if (n.nodeName === 'BR') { n.remove(); continue; }
      if (n.nodeType === 1 && !n.classList.contains('callout-icon') && !n.textContent.replace(/[\s ]/g, '') && !n.querySelector('img')) { n.remove(); continue; }
      break;
    }
    if (box.tagName === 'PRE' && box.lastChild && box.lastChild.nodeType === 3) box.lastChild.textContent = box.lastChild.textContent.replace(/\n+$/, '');
  }

  // Défait le bloc : son contenu redevient du texte normal.
  /*
   * Une citation est faite de lignes-paragraphes (<blockquote><p>…</p><p>…</p></blockquote>),
   * comme un encadré : Entrée crée une ligne, sur la dernière ligne vide on sort. On convertit ici
   * les citations écrites avec des <br> (anciens textes, ou mise en forme par le moteur d'édition).
   */
  const LINE_BLOCK = /^(P|DIV|H[1-6]|UL|OL|PRE)$/;

  function normalizeQuote(bq) {
    const kids = Array.from(bq.childNodes);
    if (!kids.some(n => n.nodeName === 'DIV' || (n.nodeType === 1 && !LINE_BLOCK.test(n.nodeName)) || (n.nodeType === 3 && n.textContent.replace(/[\t\n\r ]/g, '')))) return;
    const s = document.getSelection();
    const an = s.rangeCount && bq.contains(s.anchorNode) ? s.anchorNode : null;
    const ao = s.anchorOffset;
    const out = [];
    let cur = null;
    const flush = () => { if (cur) { out.push(cur); cur = null; } };
    for (const n of kids) {
      if (n.nodeType === 1 && LINE_BLOCK.test(n.nodeName)) {
        flush();
        if (n.nodeName === 'DIV') {
          const p = document.createElement('p');
          p.append(...n.childNodes);
          out.push(p);
        } else out.push(n);
        continue;
      }
      if (n.nodeName === 'BR') {
        // un <br> termine la ligne en cours ; seul, il porte une ligne vide
        if (cur) flush();
        else { const p = document.createElement('p'); p.append(n); out.push(p); }
        continue;
      }
      if (n.nodeType === 3 && !n.textContent.replace(/[\t\n\r ]/g, '') && !cur) continue;
      if (!cur) cur = document.createElement('p');
      cur.append(n);
    }
    flush();
    if (!out.length) out.push(document.createElement('p'));
    for (const p of out) if (!p.firstChild) p.appendChild(document.createElement('br'));
    bq.replaceChildren(...out);
    if (an && an.isConnected && an !== bq) {
      const r = document.createRange();
      r.setStart(an, Math.min(ao, an.nodeType === 3 ? an.length : an.childNodes.length));
      s.removeAllRanges();
      s.addRange(r);
      saveRange();
    } else if (an) caretInto(out[out.length - 1], true);
  }

  const normalizeQuotes = () => { for (const bq of $$('blockquote', edBody())) normalizeQuote(bq); };

  // la ligne (enfant direct du bloc) qui contient le curseur
  function caretLine(box) {
    let n = document.getSelection().anchorNode;
    if (n === box) return box.children[Math.max(0, document.getSelection().anchorOffset - 1)] || null;
    while (n && n.parentNode !== box) n = n.parentNode;
    return n && n.nodeType === 1 ? n : null;
  }

  const lineIsEmpty = el => !el.textContent.replace(/[\s ]/g, '') && !el.querySelector('img, hr');
  const lastLine = box => Array.from(box.children).filter(c => !c.classList.contains('callout-icon')).pop() || null;

  // Entrée sur la dernière ligne vide : on la retire et on écrit sous le bloc.
  function leaveBox(box, line) {
    line.remove();
    let target = box.nextElementSibling;
    if (!(target && target.tagName === 'P' && lineIsEmpty(target))) {
      target = emptyParagraph();
      box.after(target);
    }
    if (!lastLine(box) || lineIsEmpty(box)) box.remove();
    caretInto(target, false);
  }

  function unwrapBox(box) {
    for (const ic of box.querySelectorAll('.callout-icon')) ic.remove();
    let first;
    if (box.tagName === 'BLOCKQUOTE') normalizeQuote(box);
    if ((box.classList.contains('callout') || box.tagName === 'BLOCKQUOTE') && box.firstElementChild) {
      first = box.firstElementChild;
      box.replaceWith(...box.childNodes);
    } else {
      const p = document.createElement('p');
      p.append(...box.childNodes);
      if (!p.firstChild) p.appendChild(document.createElement('br'));
      box.replaceWith(p);
      first = p;
    }
    caretInto(first, false);
  }

  function exitBox(box) {
    const s = document.getSelection();
    const r = document.createRange();
    r.setStart(s.anchorNode, s.anchorOffset);
    r.setEnd(box, box.childNodes.length);
    const rest = r.extractContents();
    for (const ic of rest.querySelectorAll('.callout-icon')) ic.remove();
    const holder = document.createElement('div');
    holder.append(rest);
    trimBox(box);
    const blocks = Array.from(holder.children).filter(el => /^(P|DIV|H[1-3]|UL|OL)$/.test(el.tagName));
    let target;
    if (blocks.length && blocks.length === holder.children.length && holder.textContent.trim()) {
      box.after(...holder.childNodes);
      target = blocks[0];
    } else if (!holder.textContent.replace(/[\s ]/g, '') && box.nextElementSibling && box.nextElementSibling.tagName === 'P'
      && !box.nextElementSibling.textContent.replace(/[\s ]/g, '') && !box.nextElementSibling.querySelector('img')) {
      // une ligne vide suit déjà le bloc : on s'en sert
      target = box.nextElementSibling;
    } else {
      target = document.createElement('p');
      if (holder.textContent.replace(/[\s ]/g, '')) target.append(...holder.childNodes);
      else target.appendChild(document.createElement('br'));
      box.after(target);
    }
    if (!box.textContent.replace(/[\s ]/g, '').replace(box.querySelector('.callout-icon') ? box.querySelector('.callout-icon').textContent : '', '') && !box.querySelector('img')) box.remove();
    caretInto(target, false);
  }

  function bindBlocks() {
    edBody().addEventListener('keydown', e => {
      if (READONLY || e.metaKey || e.ctrlKey || e.altKey) return;
      const box = caretBox();
      if (!box) return;
      const body = edBody();
      if (e.key === 'Enter' && !e.shiftKey) {
        // Entrée au tout début d'un bloc : une ligne s'ouvre au-dessus
        if (caretAt(box, 'start') && !caretAt(box, 'end')) {
          e.preventDefault();
          box.before(emptyParagraph());
          changed();
          return;
        }
        // citation, encadré : Entrée ouvre une nouvelle ligne dans le bloc ;
        // sur la dernière ligne, si elle est vide, on sort du bloc
        if (box.tagName !== 'PRE') {
          if (box.tagName === 'BLOCKQUOTE') normalizeQuote(box);
          const line = caretLine(box);
          if (!line || line !== lastLine(box) || !lineIsEmpty(line)) return;
          e.preventDefault();
          leaveBox(box, line);
          ensureTrailingParagraph();
          changed();
          return;
        }
        // code : Entrée passe à la ligne ; une seconde Entrée sur la ligne vide finale en sort
        if (!(caretAt(box, 'end') && endsWithEmptyLine(box))) return;
        e.preventDefault();
        exitBox(box);
        ensureTrailingParagraph();
        changed();
        return;
      }
      if (e.key === 'Backspace' && box.tagName === 'BLOCKQUOTE') normalizeQuote(box);
      if (e.key === 'Backspace' && caretAt(box, 'start')) {
        e.preventDefault();
        unwrapBox(box);
        changed();
        return;
      }
      if (e.key === 'ArrowUp' && box === body.firstElementChild && caretAt(box, 'start')) {
        e.preventDefault();
        const p = emptyParagraph();
        box.before(p);
        caretInto(p, false);
        changed();
        return;
      }
      if (e.key === 'ArrowDown' && box === body.lastElementChild && caretAt(box, 'end')) {
        e.preventDefault();
        const p = emptyParagraph();
        box.after(p);
        caretInto(p, false);
        changed();
      }
    });
  }

  /* ───────────── Icône des encadrés : glyphes sobres ou émojis Apple ───────────── */

  const GLYPHS = ['◐', '●', '○', '◎', '◆', '◇', '■', '□', '▲', '△', '★', '☆', '✦', '✧', '✳', '✱', '❋', '✿', '❦', '※',
    '✓', '✗', '→', '↗', '↻', '∞', '¶', '§', '†', '⚑', '✎', '✉', '☎', '⌘', '⌂', '♪', '☀', '☾', '☁', '☂',
    '♥', '♡', '⚠', '⚙', '☕', '✂', '✈', '⚓', '☘', '⊕', '?', '!', 'i', '1', '2', '3']
    .map(g => /^[?!i0-9]$/.test(g) ? g : g + '︎');
  const EMOJIS = ['💡', '📌', '📝', '✅', '⚠️', '❗️', '❓', '🔥', '⭐️', '✨', '🎯', '📎', '🔗', '📚', '📖', '🗂️',
    '📅', '⏰', '🧭', '🗺️', '🌿', '🌱', '🌸', '🌙', '☀️', '🌊', '⛰️', '🏛️', '🏠', '🎨', '🎬', '🎵',
    '📷', '✈️', '🚀', '💬', '💭', '❤️', '👀', '🙂', '🤔', '👉', '🧠', '🔒', '🔑', '💰', '🍃', '☕️'];
  let iconTarget = null;

  function makeIcon(v) {
    const s = document.createElement('span');
    s.className = 'callout-icon';
    s.contentEditable = 'false';
    s.textContent = v;
    return s;
  }

  // les encadrés créés avant l'icône cliquable en reçoivent une
  function normalizeCallouts() {
    for (const box of $$('.callout', edBody())) {
      let ic = box.querySelector(':scope > .callout-icon');
      if (!ic) { ic = makeIcon(GLYPHS[0]); box.prepend(ic); }
      ic.contentEditable = 'false';
    }
  }

  function renderIconGrid(tab) {
    for (const b of $$('#iconPop .ip-tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    const list = tab === 'emoji' ? EMOJIS : GLYPHS;
    $('#ipGrid').className = 'ip-grid ' + tab;
    $('#ipGrid').innerHTML = list.map(v => `<button data-icon="${esc(v)}">${esc(v)}</button>`).join('');
    $('#ipMore').hidden = tab !== 'emoji';
  }

  function openIconPop(icon) {
    iconTarget = icon;
    const pop = $('#iconPop');
    renderIconGrid(/\p{Extended_Pictographic}/u.test(icon.textContent) && !icon.textContent.includes('︎') ? 'emoji' : 'glyph');
    pop.hidden = false;
    const r = icon.getBoundingClientRect();
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(12, r.left - 8)) + 'px';
    pop.style.top = (r.bottom + pop.offsetHeight + 12 > innerHeight ? r.top - pop.offsetHeight - 8 : r.bottom + 8) + 'px';
  }

  function setIcon(v) {
    if (!iconTarget || !v) return;
    iconTarget.textContent = v;
    $('#iconPop').hidden = true;
    iconTarget = null;
    changed();
  }

  function lastGrapheme(s) {
    if (window.Intl && Intl.Segmenter) {
      const parts = Array.from(new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(s));
      return parts.length ? parts[parts.length - 1].segment : '';
    }
    return Array.from(s).pop() || '';
  }

  function bindIconPop() {
    const pop = $('#iconPop');
    pop.addEventListener('mousedown', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    pop.addEventListener('click', e => {
      const t = e.target.closest('[data-tab]');
      if (t) return renderIconGrid(t.dataset.tab);
      const b = e.target.closest('[data-icon]');
      if (b) setIcon(b.dataset.icon);
    });
    $('#ipInput').addEventListener('input', e => {
      const v = lastGrapheme(e.target.value.trim());
      e.target.value = '';
      if (v) setIcon(v);
    });
    $('#ipPalette').addEventListener('click', () => {
      $('#ipInput').focus();
      if (NATIVE) call('emojiPalette');
      else toast('Ctrl ⌘ Espace ouvre les émojis du Mac');
    });
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('#iconPop, .callout-icon')) pop.hidden = true;
    });
  }

  function bindSlash() {
    const body = edBody();
    body.addEventListener('input', e => {
      if (READONLY) return;
      if (slash) updateSlash();
      else if (e.inputType === 'insertText' && e.data && e.data.includes('/')) openSlash(e.data);
    });
    // capturé avant les autres raccourcis de l'éditeur (et avant Échap qui ferme la page)
    body.addEventListener('keydown', e => {
      if (!slash) return;
      const n = slash.items.length;
      if (e.key === 'ArrowDown' && n) { slash.sel = (slash.sel + 1) % n; renderSlash(); sound.nav(); }
      else if (e.key === 'ArrowUp' && n) { slash.sel = (slash.sel - 1 + n) % n; renderSlash(); sound.nav(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && n) chooseSlash(slash.items[slash.sel]);
      else if (e.key === 'Escape') closeSlash();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    document.addEventListener('selectionchange', () => {
      if (!slash) return;
      const c = slashCaret();
      if (!c || c.node !== slash.node || c.off <= slash.start) closeSlash();
    });
    body.addEventListener('blur', () => setTimeout(() => { if (slash && document.activeElement !== body) closeSlash(); }, 0));
    $('#slashMenu').addEventListener('mousedown', e => {
      e.preventDefault();
      const b = e.target.closest('button[data-i]');
      if (b && slash) chooseSlash(slash.items[+b.dataset.i]);
    });
    $('#slashMenu').addEventListener('mousemove', e => {
      const b = e.target.closest('button[data-i]');
      if (b && slash && +b.dataset.i !== slash.sel) {
        slash.sel = +b.dataset.i;
        for (const x of $$('#slashMenu button')) x.classList.toggle('on', x === b);
      }
    });
  }

  function selectImg(img) {
    if (selImg) selImg.classList.remove('sel');
    selImg = img;
    img.classList.add('sel');
    const r = img.getBoundingClientRect();
    const t = $('#imgTools');
    $('[data-size="zoom"]', t).classList.toggle('on', img.hasAttribute('data-zoom'));
    t.hidden = false;
    t.style.left = Math.max(12, r.left + r.width / 2 - t.offsetWidth / 2) + 'px';
    t.style.top = Math.max(64, r.top - t.offsetHeight - 12) + 'px';
  }
  function hideImgTools() {
    if (selImg) selImg.classList.remove('sel');
    selImg = null;
    $('#imgTools').hidden = true;
  }
  // la légende : une petite ligne en italique juste sous l'image, qui se présente avec elle
  function imgCaption(img) {
    let at = img;
    while (at.parentElement !== edBody()) at = at.parentElement;
    let cap = at.nextElementSibling;
    if (!cap || !cap.matches('p.cap')) {
      histCommit();
      cap = document.createElement('p');
      cap.className = 'cap';
      cap.append(document.createElement('br'));
      at.after(cap);
      changed();
    }
    hideImgTools();
    edBody().focus();
    caretInto(cap, true);
    saveRange();
  }

  function hideTools() { hideImgTools(); $('#linkPop').hidden = true; $('#colorPop').hidden = true; $('#iconPop').hidden = true; $('#pagePop').hidden = true; closeSlash(); }

  function linkAtSelection() {
    const s = document.getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    if (n && n.nodeType === 3) n = n.parentNode;
    const a = n && n.closest ? n.closest('a') : null;
    return a && edBody().contains(a) ? a : null;
  }

  function placePop(pop) {
    const s = document.getSelection();
    let r = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) r = edBody().getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 12, Math.max(12, r.left)) + 'px';
    pop.style.top = Math.min(innerHeight - 60, r.bottom + 10) + 'px';
  }

  function openLinkPop() {
    if (READONLY) return;
    saveRange();
    const a = linkAtSelection();
    const s = document.getSelection();
    if (!a && (!s.rangeCount || s.isCollapsed)) { toast('Sélectionnez le texte à transformer en lien'); return; }
    $('#linkInput').value = a ? a.getAttribute('href') : '';
    placePop($('#linkPop'));
    $('#linkInput').focus();
  }

  function maybeShowLink() {
    if (READONLY || document.activeElement === $('#linkInput')) return;
    const a = linkAtSelection();
    const pop = $('#linkPop');
    if (a && document.getSelection().isCollapsed) {
      $('#linkInput').value = a.getAttribute('href') || '';
      placePop(pop);
    } else pop.hidden = true;
  }

  function normalizeURL(v) {
    v = (v || '').trim();
    if (!v) return '';
    if (/^(https?:|mailto:|tel:|#)/i.test(v)) return v;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'mailto:' + v;
    return 'https://' + v;
  }

  function applyLink() {
    const url = normalizeURL($('#linkInput').value);
    $('#linkPop').hidden = true;
    restoreRange();
    const a = linkAtSelection();
    if (a) { if (url) a.setAttribute('href', url); else a.replaceWith(...a.childNodes); changed(); return; }
    if (url) exec('createLink', url);
  }

  function openURL(url) {
    if (NATIVE) call('openURL', url);
    else window.open(url, '_blank', 'noopener');
  }

  /* Nettoyage du HTML collé : on garde la structure, pas les styles. */
  const KEEP = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'IMG', 'HR']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
  const RENAME = { H4: 'H3', H5: 'H3', H6: 'H3', DIV: 'P', SECTION: 'P', ARTICLE: 'P', TR: 'P' };

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const clean = node => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 8) { child.remove(); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (DROP.has(tag)) { child.remove(); continue; }
        if (tag === 'TD' || tag === 'TH') child.append(' ');
        clean(child);
        if (RENAME[tag]) {
          const n = doc.createElement(RENAME[tag]);
          n.append(...child.childNodes);
          child.replaceWith(n);
          continue;
        }
        if (!KEEP.has(tag)) { child.replaceWith(...child.childNodes); continue; }
        for (const at of Array.from(child.attributes)) {
          const ok = (tag === 'A' && at.name === 'href' && /^(https?:|mailto:|#)/i.test(at.value))
            || (tag === 'IMG' && at.name === 'src' && /^(data:image\/|https?:)/i.test(at.value));
          if (!ok) child.removeAttribute(at.name);
        }
        if (tag === 'IMG') child.className = 'm';
      }
    };
    clean(doc.body);
    return doc.body.innerHTML;
  }

  /* ───────────── Structure du texte : collage selon l'endroit, nettoyage, blocs protégés ─────────────
   * Le moteur d'édition laisse des traces (styles recopiés à la fusion de deux lignes, titres collés dans
   * un titre de pli, second <summary> à l'Entrée…). Ici, chaque ligne reste à sa place : un titre de pli
   * ou un intertitre ne contient que du texte, une puce que du texte, un bloc interactif ne s'efface pas
   * par un simple retour arrière. */

  const ATOM_SEL = '[data-ix], details.ix-fold, hr, table, .qn-src';
  const LINE_SEL = 'summary, h1, h2, h3, li, p, pre';
  const HOLDER_SEL = 'blockquote, .callout, .ix-fold-body';

  // les couleurs de la palette de l'éditeur : seules celles-ci survivent au nettoyage
  let paletteRGB = null;
  const rgbOf = v => { const st = document.createElement('span').style; st.color = v; return st.color; };
  // (sans le blanc ni l'encre quasi noire : identiques au texte courant, le moteur les recopie à la fusion de deux lignes)
  const palette = () => paletteRGB || (paletteRGB = new Set(ALL_TONES.flatMap(c => [inkOf(c), c.fg, c.bg]).filter(Boolean).map(rgbOf)
    .filter(v => !['rgb(255, 255, 255)', 'rgb(17, 17, 17)', 'rgb(27, 27, 27)'].includes(v))));

  const isBlank = el => !el.textContent.replace(/[\s ​]/g, '') && !el.matches('table') && !el.querySelector('img, hr, table, [data-ix], .ix-blank');

  // le contenu « en ligne » d'un élément : ses blocs internes deviennent des espaces
  function inlineOf(el) {
    const frag = document.createDocumentFragment();
    const walk = node => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 1 && /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|SUMMARY|DETAILS|TR)$/.test(n.tagName)) {
          if (frag.textContent && !/\s$/.test(frag.textContent)) frag.append(' ');
          walk(n);
        } else if (n.nodeType === 1 && n.tagName === 'IMG') continue;
        else frag.append(n.cloneNode(true));
      }
    };
    walk(el);
    while (frag.lastChild && frag.lastChild.nodeName === 'BR') frag.lastChild.remove();
    return frag;
  }

  // Le collage, réduit à une suite de lignes { tag, frag } : p, h1-3, ul, ol (une puce), quote, pre, img, hr
  function linesOf(root) {
    const lines = [];
    let run = null;
    const flush = () => { if (run && run.textContent.replace(/[\s ]/g, '')) lines.push({ tag: 'p', frag: run }); run = null; };
    const walk = (node, quote) => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) { if (run || n.textContent.trim()) (run || (run = document.createDocumentFragment())).append(n.cloneNode()); continue; }
        if (n.nodeType !== 1) continue;
        const t = n.tagName;
        if (t === 'BR') { flush(); continue; }
        if (/^(B|STRONG|I|EM|U|S|A|CODE|SPAN)$/.test(t)) { (run || (run = document.createDocumentFragment())).append(n.cloneNode(true)); continue; }
        flush();
        if (t === 'IMG') lines.push({ tag: 'img', el: n.cloneNode() });
        else if (t === 'HR') lines.push({ tag: 'hr' });
        else if (t === 'PRE') lines.push({ tag: 'pre', text: n.textContent.replace(/\n+$/, '') });
        else if (t === 'BLOCKQUOTE') walk(n, true);
        else if (t === 'UL' || t === 'OL') {
          for (const li of n.querySelectorAll('li')) {
            const own = li.cloneNode(true);
            for (const sub of own.querySelectorAll('ul, ol')) sub.remove();
            if (!isBlank(own)) lines.push({ tag: t.toLowerCase(), frag: inlineOf(own) });
          }
        } else if (/^H[1-3]$/.test(t) && !quote) lines.push({ tag: t.toLowerCase(), frag: inlineOf(n) });
        else if (n.querySelector('p, h1, h2, h3, ul, ol, blockquote, pre, img, hr')) walk(n, quote);
        else if (!isBlank(n)) lines.push({ tag: quote ? 'quote' : 'p', frag: inlineOf(n) });
      }
      flush();
    };
    walk(root, false);
    return lines;
  }

  // une ligne collée devient un élément, adapté au contenant qui la reçoit
  function lineEl(l, ctx) {
    if (l.tag === 'hr') return ctx === 'block' ? document.createElement('hr') : null;
    if (l.tag === 'img') { const im = l.el; im.className = 'm'; return ctx === 'block' ? im : null; }
    const tag = ctx === 'li' ? 'li' : ctx === 'quote' ? 'p'
      : l.tag === 'pre' ? 'pre' : /^h[1-3]$/.test(l.tag) ? l.tag : 'p';
    const el = document.createElement(tag);
    if (l.tag === 'pre') el.textContent = l.text; else el.append(l.frag);
    el._list = ctx === 'block' && (l.tag === 'ul' || l.tag === 'ol') ? l.tag : null;
    el._quote = ctx === 'block' && l.tag === 'quote';
    return el;
  }

  // Colle des lignes à l'endroit du curseur : la première rejoint la ligne en cours, la fin de celle-ci suit la dernière
  function pasteLines(lines, plain) {
    const body = edBody();
    const s = document.getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    if (!body.contains(r.commonAncestorContainer)) return;
    const elAt = n => n.nodeType === 3 ? n.parentElement : n;
    if (elAt(r.startContainer).closest('pre')) { document.execCommand('insertText', false, plain); return; }
    if (!lines.length) return;
    r.deleteContents();
    let line = elAt(r.startContainer).closest(LINE_SEL + ', ' + HOLDER_SEL + ', #edBody');
    if (!line || !body.contains(line) && line !== body) return;
    if (!line.matches(LINE_SEL)) {
      // curseur entre deux blocs : on ouvre une ligne
      const p = document.createElement('p');
      r.insertNode(p);
      line = p;
      r.selectNodeContents(p);
    }
    const holder = line.parentElement;
    const ctx = line.tagName === 'LI' ? 'li' : holder.closest('blockquote') ? 'quote' : 'block';
    const tailR = document.createRange();
    tailR.setStart(r.startContainer, r.startContainer === line && !line.childNodes.length ? 0 : r.startOffset);
    tailR.setEnd(line, line.childNodes.length);
    const tail = tailR.extractContents();
    for (const b of tail.querySelectorAll('br')) if (!b.nextSibling) b.remove();
    const wasEmpty = line.tagName === 'P' && isBlank(line) && !tail.textContent.trim();
    for (const b of Array.from(line.querySelectorAll('br'))) if (!b.nextSibling) b.remove();

    let els = [];
    let first = lines;
    if (!(wasEmpty && ctx !== 'li')) {
      // la première ligne rejoint la ligne en cours (titre de pli, intertitre, puce, phrase entamée)
      const l0 = lines[0];
      if (l0.frag) line.append(l0.frag); else if (l0.tag === 'pre') line.append(l0.text);
      first = lines.slice(1);
    }
    for (const l of first) { const el = lineEl(l, ctx); if (el) els.push(el); }
    // les puces collées hors d'une liste se regroupent, les lignes de citation aussi
    const grouped = [];
    for (const el of els) {
      const prev = grouped[grouped.length - 1];
      if (el._list) {
        if (prev && prev.tagName === el._list.toUpperCase()) { const li = document.createElement('li'); li.append(...el.childNodes); prev.append(li); continue; }
        const list = document.createElement(el._list), li = document.createElement('li');
        li.append(...el.childNodes); list.append(li); grouped.push(list); continue;
      }
      if (el._quote) {
        if (prev && prev.tagName === 'BLOCKQUOTE') { prev.append(el); continue; }
        const bq = document.createElement('blockquote'); bq.append(el); grouped.push(bq); continue;
      }
      grouped.push(el);
    }
    els = grouped;

    // où vont les lignes suivantes : sous un titre de pli, au début de son contenu ; sinon juste après la ligne
    let anchor = line;
    if (line.tagName === 'SUMMARY') {
      const fb = foldBody(line.parentElement);
      line.parentElement.open = true;
      for (const el of els.slice().reverse()) fb.prepend(el);
    } else if (wasEmpty && ctx !== 'li' && els.length) {
      for (const el of els) line.before(el);
      line.remove();
      anchor = null;
    } else {
      for (const el of els) { anchor.after(el); anchor = el; }
    }

    // la fin de la ligne d'origine reprend après le collage, et le curseur se pose à la jointure
    let last = line;
    if (els.length && line.tagName !== 'SUMMARY') {
      last = els[els.length - 1];
      if (/^(UL|OL|BLOCKQUOTE)$/.test(last.tagName)) last = last.lastElementChild;
      if (!last.matches(LINE_SEL) || last.tagName === 'PRE') {
        const p = document.createElement(line.tagName === 'LI' ? 'li' : 'p');
        els[els.length - 1].after(p);
        last = p;
      }
    }
    const mark = document.createTextNode('');
    last.append(mark, tail);
    const r2 = document.createRange();
    r2.setStart(mark, 0);
    r2.collapse(true);
    s.removeAllRanges();
    s.addRange(r2);
    for (const el of [line, ...els]) if (el.isConnected && el.matches && el.matches('p, h1, h2, h3, li') && isBlank(el) && !el.querySelector('br')) el.appendChild(document.createElement('br'));
  }

  // colle du HTML (ou à défaut du texte brut) au curseur : sert au ⌘V comme au menu contextuel
  /* Les blocs (tableau, graphique, image, encadré…) voyagent tels quels dans le presse-papiers, dans une enveloppe
   * reconnue au collage : le nettoyage habituel, fait pour le contenu venu d'ailleurs, ne les aplatit pas. */
  const CLIP_ATTR = 'data-espaces-clip';
  const clipWrap = html => `<div ${CLIP_ATTR}="1">${html.replace(/ class="sel"/g, '').replace(/ sel"/g, '"')}</div>`;
  const clipHasBlock = html => /<(table|hr|img|details)\b|data-ix|class="[^"]*callout/.test(html);
  function pasteBlocks(html) {
    const box = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${CLIP_ATTR}]`);
    if (!box) return false;
    for (const el of $$('script, iframe, object, embed, style, link, meta', box)) el.remove();
    for (const el of $$('*', box)) for (const at of Array.from(el.attributes)) {
      if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) el.removeAttribute(at.name);
    }
    for (const el of $$('[data-ix][data-id]', box)) el.dataset.id = ixId();
    const body = edBody(), s = document.getSelection();
    let line = caretElement();
    if (!line || !body.contains(line)) line = body.lastElementChild;
    while (line && line.parentElement !== body) line = line.parentElement;
    const nodes = Array.from(box.childNodes);
    if (!line) body.append(...nodes);
    else { line.after(...nodes); if (isBlank(line)) line.remove(); }
    const last = nodes[nodes.length - 1];
    const next = last.nextElementSibling;
    if (next && !next.matches(ATOM_SEL) && isBlank(next)) caretInto(next, false);
    else { const p = emptyParagraph(); last.after(p); caretInto(p, false); }
    tidy();
    ensureTrailingParagraph();
    changed();
    return true;
  }

  function pasteFrom(html, text) {
    if (html && html.includes(CLIP_ATTR) && pasteBlocks(html)) return;
    const lines = html
      ? linesOf(new DOMParser().parseFromString(sanitize(html), 'text/html').body)
      : (text || '').split(/\r?\n/).filter(l => l.trim()).map(l => ({ tag: 'p', frag: document.createTextNode(l) }));
    pasteLines(lines, text || lines.map(l => l.frag ? l.frag.textContent : '').join('\n'));
    tidy();
    ensureTrailingParagraph();
    changed();
  }

  // un pli se défait : son titre devient un paragraphe, son contenu (sans les lignes vides) le suit
  function dissolveFold(fold) {
    const sum = fold.querySelector(':scope > summary'), fb = foldBody(fold);
    const p = document.createElement('p');
    if (sum) p.append(...sum.childNodes);
    if (!p.firstChild) p.appendChild(document.createElement('br'));
    fold.replaceWith(p, ...Array.from(fb.children).filter(c => !isBlank(c)));
    caretInto(p, false);
    ensureTrailingParagraph();
    changed();
  }

  const foldBody = fold => {
    let fb = fold.querySelector(':scope > .ix-fold-body');
    if (!fb) { fb = document.createElement('div'); fb.className = 'ix-fold-body'; fold.append(fb); }
    return fb;
  };

  // Nettoie le texte sans toucher au curseur : rend vrai si quelque chose a changé
  function tidy(root) {
    root = root || edBody();
    const before = root.innerHTML;
    const s = document.getSelection();
    const keep = s.rangeCount && root.contains(s.anchorNode) ? { n: s.anchorNode, o: s.anchorOffset } : null;
    const ranged = s.rangeCount > 0 && !s.isCollapsed;
    const editable = el => !el.closest('[contenteditable="false"]');
    const unwrap = el => el.replaceWith(...el.childNodes);
    const toP = el => { const p = document.createElement('p'); p.append(...el.childNodes); el.replaceWith(p); return p; };

    // l'horodatage d'une note rapide se déplace et s'efface d'un bloc (y compris dans les pages déjà écrites)
    for (const st of $$('p.qn-src:not([contenteditable])', root)) st.setAttribute('contenteditable', 'false');
    // styles recopiés par le moteur : on ne garde que l'alignement des lignes et les couleurs de la palette
    for (const f of $$('font', root)) { const sp = document.createElement('span'); if (f.color) sp.style.color = f.color; sp.append(...f.childNodes); f.replaceWith(sp); }
    for (const el of $$('[style]', root)) {
      if (!editable(el) || el.matches('[data-ix], [data-ix] *, table.tb td, table.tb th')) continue;
      const st = el.style, keepSt = {};
      if (/^(P|H[1-3]|LI|BLOCKQUOTE|PRE|DIV)$/.test(el.tagName) && st.textAlign) keepSt['text-align'] = st.textAlign;
      if (!/^(P|H[1-3]|LI|BLOCKQUOTE|PRE|DIV|IMG)$/.test(el.tagName)) {
        if (st.color && palette().has(rgbOf(st.color))) keepSt.color = st.color;
        if (st.backgroundColor && palette().has(rgbOf(st.backgroundColor))) keepSt['background-color'] = st.backgroundColor;
      }
      el.removeAttribute('style');
      for (const [k, v] of Object.entries(keepSt)) el.style.setProperty(k, v);
    }
    for (const sp of $$('span:not([class]):not([style]):not([data-id])', root)) if (editable(sp)) unwrap(sp);

    // titres de pli : du texte seulement ; un pli a toujours un titre et un contenu
    for (const fold of $$('details.ix-fold', root)) {
      const sums = $$(':scope > summary', fold);
      let sum = sums[0];
      if (!sum) { sum = document.createElement('summary'); sum.textContent = 'Titre à déplier'; fold.prepend(sum); }
      const fb = foldBody(fold);
      for (const extra of sums.slice(1)) { if (!isBlank(extra)) fb.prepend(toP(extra)); else extra.remove(); }
      // ce qui traîne hors du titre et du contenu rejoint le contenu
      for (const n of Array.from(fold.childNodes)) {
        if (n === sum || n === fb) continue;
        if (n.nodeType === 1 && n.matches('p, h1, h2, h3, ul, ol, blockquote, pre, hr, img')) fb.append(n);
        else if (n.nodeType === 1 || n.textContent.trim()) { const p = document.createElement('p'); p.append(n); fb.append(p); }
        else n.remove();
      }
      const blocks = Array.from(sum.children).filter(c => /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|IMG|HR|DETAILS)$/.test(c.tagName));
      if (blocks.length) {
        const moved = [];
        for (const b of blocks.slice(1)) moved.push(b);
        for (const b of moved.reverse()) fb.prepend(b.tagName === 'DIV' ? toP(b) : b);
        const head = blocks[0];
        if (head.tagName === 'IMG' || head.tagName === 'HR') fb.prepend(head);
        else head.replaceWith(inlineOf(head));
      }
      for (const br of $$('br', sum)) br.remove();
      if (!fb.firstElementChild) fb.append(emptyParagraph());
      // dans l'éditeur, un pli reste ouvert : on écrit dans ce qu'on voit (le lecteur, lui, les referme)
      if (root === edBody() && !fold.open) fold.open = true;
    }
    // intertitres et puces : du texte seulement
    for (const h of $$('h1, h2, h3, li', root)) {
      if (!editable(h)) continue;
      for (const b of Array.from(h.children)) {
        if (h.tagName === 'LI' && /^(UL|OL)$/.test(b.tagName)) continue;
        if (/^(P|DIV|H[1-6]|BLOCKQUOTE)$/.test(b.tagName)) {
          const frag = inlineOf(b);
          if (b.previousSibling && b.previousSibling.textContent && !/\s$/.test(b.previousSibling.textContent)) frag.prepend(' ');
          b.replaceWith(frag);
        }
      }
    }
    // une sous-liste appartient à la puce qui la précède
    for (const sub of $$(':is(ul, ol) > :is(ul, ol)', root)) {
      const prev = sub.previousElementSibling;
      if (prev && prev.tagName === 'LI') prev.append(sub);
      else { const li = document.createElement('li'); sub.before(li); li.append(sub); }
    }
    // une citation est faite de lignes
    for (const h of $$('blockquote > h1, blockquote > h2, blockquote > h3', root)) toP(h);
    // un paragraphe ne contient pas de bloc : il se coupe autour
    for (const p of $$('p', root)) {
      if (!editable(p)) continue;
      const inner = Array.from(p.children).filter(c => /^(P|H[1-3]|UL|OL|BLOCKQUOTE|PRE|DIV|DETAILS)$/.test(c.tagName));
      if (!inner.length) continue;
      let cur = document.createElement('p');
      const out = [];
      for (const n of Array.from(p.childNodes)) {
        if (inner.includes(n)) { if (!isBlank(cur)) out.push(cur); out.push(n.tagName === 'DIV' && !n.attributes.length ? toP(n) : n); cur = document.createElement('p'); }
        else cur.append(n);
      }
      if (!isBlank(cur)) out.push(cur);
      p.replaceWith(...out);
    }
    // du texte posé à même la page rejoint un paragraphe
    let run = null;
    for (const n of Array.from(root.childNodes)) {
      const inline = n.nodeType === 3 ? !!n.textContent.trim() || !!run : n.nodeType === 1 && /^(B|STRONG|I|EM|U|S|A|SPAN|CODE)$/.test(n.tagName);
      if (inline) { if (!run) { run = document.createElement('p'); n.before(run); } run.append(n); }
      else { run = null; if (n.nodeType === 1 && n.tagName === 'BR') n.replaceWith(emptyParagraph()); }
    }
    // une ligne vide garde sa hauteur
    for (const el of $$('p, h1, h2, h3, li', root)) if (editable(el) && !el.childNodes.length) el.appendChild(document.createElement('br'));
    // mises en forme vides, sauf celle où l'on s'apprête à écrire
    for (const el of $$('b, strong, i, em, u, s, a', root)) if (!el.childNodes.length && editable(el) && !(keep && (el === keep.n || el.contains(keep.n)))) el.remove();

    // (un curseur seulement : replier une vraie sélection ferait effacer autre chose que ce qui est sélectionné)
    if (keep && !ranged && keep.n.isConnected) {
      try { const r = document.createRange(); r.setStart(keep.n, Math.min(keep.o, keep.n.nodeType === 3 ? keep.n.length : keep.n.childNodes.length)); r.collapse(true); s.removeAllRanges(); s.addRange(r); } catch (e) { /* ignore */ }
    }
    return root.innerHTML !== before;
  }

  // L'élément où se trouve le curseur. WebKit exprime parfois la fin d'une ligne par une position dans son parent
  // (« après le titre », dans le <details>) : on redescend alors vers l'enfant qui précède le curseur.
  function caretElement() {
    const s = document.getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode, o = s.anchorOffset;
    if (n && n.nodeType === 1 && n.childNodes.length && !n.matches(LINE_SEL)) n = n.childNodes[Math.max(0, Math.min(o, n.childNodes.length) - 1)];
    return n && (n.nodeType === 3 ? n.parentElement : n);
  }

  // Les touches qui défont la structure : titre de pli, sortie d'un pli, blocs interactifs voisins
  function bindStructure() {
    const body = edBody();
    const topOf = n => { while (n && n.parentNode !== body) n = n.parentNode; return n; };

    /* Un bloc entier (pli, bloc interactif, trait) se supprime en deux temps, comme dans les éditeurs de blocs :
     * le premier retour arrière le sélectionne (cerné d'accent), le second l'efface. Toute autre touche le relâche. */
    let armed = null;
    const ring = document.createElement('div');
    ring.className = 'ed-armed';
    ring.hidden = true;
    document.body.append(ring);
    const placeRing = () => {
      if (!armed || !armed.isConnected) return disarm();
      const r = armed.getBoundingClientRect();
      Object.assign(ring.style, { left: r.left - 5 + 'px', top: r.top - 5 + 'px', width: r.width + 10 + 'px', height: r.height + 10 + 'px' });
    };
    function disarm() { armed = null; ring.hidden = true; }
    function arm(el) {
      armed = el;
      const r = document.createRange();
      r.selectNode(el);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      ring.hidden = false;
      placeRing();
      if (el.getBoundingClientRect().top < 90) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const lineAround = (el, after) => {
      const p = emptyParagraph();
      el[after ? 'after' : 'before'](p);
      caretInto(p, false);
      return p;
    };
    document.addEventListener('selectionchange', () => {
      if (!armed) return;
      const s = document.getSelection();
      if (!s.rangeCount || s.isCollapsed || !s.getRangeAt(0).intersectsNode(armed)) disarm();
    });
    $('#edScroll').addEventListener('scroll', placeRing);
    addEventListener('resize', placeRing);

    body.addEventListener('keydown', e => {
      if (READONLY || e.isComposing) return;
      if (armed) {
        if (e.metaKey || e.ctrlKey) return;           // copier, couper : le moteur s'en charge
        const el = armed, prev = el.previousElementSibling, next = el.nextElementSibling;
        const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
        if (e.key === 'Backspace' || e.key === 'Delete') {
          stop();
          disarm();
          el.remove();
          const text = n => n && !n.matches(ATOM_SEL);
          // le curseur reste en fin de la ligne d'où l'on venait
          if (text(prev)) caretInto(prev, true);
          else if (text(next)) caretInto(next, false);
          else lineAround(next || prev || body.appendChild(emptyParagraph()), !next);
          ensureTrailingParagraph();
          changed();
          return;
        }
        if (e.key === 'Escape' || e.key === 'Enter' || e.key.length === 1) {
          // écrire après un bloc sélectionné ouvre une ligne sous lui, sans l'effacer
          if (e.key.length !== 1) stop();   // une lettre, elle, s'écrit dans la nouvelle ligne
          disarm();
          if (next && !next.matches(ATOM_SEL) && e.key !== 'Enter' && isBlank(next)) caretInto(next, false);
          else lineAround(el, true);
          if (e.key === 'Enter') changed();
          return;
        }
        if (/^Arrow/.test(e.key)) {
          stop();
          disarm();
          const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
          const to = back ? prev : next;
          if (to && !to.matches(ATOM_SEL)) caretInto(to, back);
          else lineAround(el, !back);
          return;
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Tab : dans une liste, la puce se décale ; ailleurs, le curseur ne quitte pas la page
      if (e.key === 'Tab') {
        const s = document.getSelection();
        const at = s.anchorNode && (s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode);
        if (!at || !body.contains(at)) return;
        e.preventDefault();
        if (at.closest('li')) { document.execCommand(e.shiftKey ? 'outdent' : 'indent'); tidy(); changed(); }
        else if (at.closest('pre') && !e.shiftKey) document.execCommand('insertText', false, '  ');
        return;
      }
      if (!['Enter', 'Backspace', 'Delete'].includes(e.key)) return;
      const s = document.getSelection();
      if (!s.rangeCount || !s.isCollapsed) return;
      const at = caretElement();
      if (!at || !body.contains(at)) return;
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

      // au début d'une ligne de liste déjà écrite, Entrée ou retour arrière la sort de la liste (d'un niveau si elle est imbriquée)
      const item = at.closest('li');
      if (item && !e.shiftKey && e.key !== 'Delete' && !isBlank(item) && caretAt(item, 'start')) {
        stop();
        const list = item.parentElement, up = list.parentElement.closest('li'), tail = list.cloneNode(false);
        if (up) {
          while (item.nextSibling) tail.append(item.nextSibling);
          if (tail.children.length) item.append(tail);
          up.after(item);
          if (!list.children.length) list.remove();
          caretInto(item, false);
        } else {
          const p = document.createElement('p');
          const subs = Array.from(item.children).filter(c => /^(UL|OL)$/.test(c.tagName));
          subs.forEach(c => c.remove());
          p.append(...item.childNodes);
          while (item.nextSibling) tail.append(item.nextSibling);
          item.remove();
          list.after(p);
          p.after(...subs, ...(tail.children.length ? [tail] : []));
          if (!list.children.length) list.remove();
          caretInto(p, false);
        }
        tidy();
        changed();
        return;
      }

      // titre d'un pli : Entrée descend dans le contenu, rien ne fusionne
      const sum = at.closest('details.ix-fold > summary');
      if (sum) {
        const fold = sum.parentElement;
        if (e.key === 'Enter') { stop(); fold.open = true; const fb = foldBody(fold); caretInto(fb.firstElementChild || fb, false); return; }
        if (e.key === 'Backspace' && caretAt(sum, 'start')) {
          // retour arrière au début du titre : le pli se défait, son titre et son contenu redeviennent du texte
          stop();
          dissolveFold(fold);
          return;
        }
        if (e.key === 'Delete' && caretAt(sum, 'end')) { stop(); const fb = foldBody(fold); caretInto(fb.firstElementChild || fb, false); return; }
        return;
      }
      // contenu d'un pli : une ligne vide en fin de pli fait sortir ; on ne fusionne ni avec le titre ni avec la suite
      const fb = at.closest('details.ix-fold > .ix-fold-body');
      if (fb && !at.closest('blockquote, .callout, pre, li')) {
        let line = at; while (line && line.parentElement !== fb) line = line.parentElement;
        if (!line) return;
        const fold = fb.parentElement;
        if (e.key === 'Enter' && !e.shiftKey && line === fb.lastElementChild && isBlank(line)) {
          stop();
          // les lignes vides qui terminent le pli partent avec la sortie
          while (fb.children.length > 1 && fb.lastElementChild && isBlank(fb.lastElementChild)) fb.lastElementChild.remove();
          const p = emptyParagraph();
          fold.after(p);
          caretInto(p, false);
          changed();
          return;
        }
        if (e.key === 'Backspace' && line === fb.firstElementChild && caretAt(line, 'start')) {
          stop();
          if (isBlank(line) && fb.children.length > 1) { line.remove(); changed(); }
          caretInto(fold.querySelector(':scope > summary'), true);
          return;
        }
        if (e.key === 'Delete' && line === fb.lastElementChild && caretAt(line, 'end')) { stop(); return; }
        return;
      }
      // à côté d'un bloc interactif, d'un pli ou d'un trait : le retour arrière ne l'avale pas
      const top = topOf(at);
      if (!top || top.nodeType !== 1 || top.matches(ATOM_SEL)) return;
      if (e.key === 'Backspace' && caretAt(top, 'start')) {
        const prev = top.previousElementSibling;
        if (!prev || !prev.matches(ATOM_SEL)) return;
        stop();
        // une ligne vide sous le bloc disparaît ; le bloc est sélectionné, un second retour arrière l'efface
        if (isBlank(top)) { top.remove(); ensureTrailingParagraph(); changed(); }
        arm(prev);
        return;
      }
      if (e.key === 'Delete' && caretAt(top, 'end')) {
        const next = top.nextElementSibling;
        if (!next || !next.matches(ATOM_SEL)) return;
        stop();
        if (isBlank(top) && top.previousElementSibling) { top.remove(); changed(); }
        arm(next);
      }
    }, true);

    // un pli ne se referme pas sous la plume (WebKit le bascule à l'Entrée ou au clic sur son titre)
    body.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('details.ix-fold') && !e.target.open) e.target.open = true; }, true);

    // après chaque frappe qui structure, et après un collage ou un dépôt, le texte est remis d'aplomb
    const settle = () => setTimeout(() => {
      const last = edBody().lastElementChild;
      const changedAny = tidy();
      ensureTrailingParagraph();
      if (changedAny || edBody().lastElementChild !== last) changed();
    }, 0);
    // une fois la frappe faite, et non à l'appui : sur iPhone et iPad, l'effacement n'arrive qu'après la touche
    body.addEventListener('input', e => { if (/^delete|^insertParagraph|^insertLineBreak/.test(e.inputType)) settle(); });
    body.addEventListener('drop', settle);
    body.addEventListener('cut', settle);
  }

  /* ───────────── Menu contextuel : le clic droit propre à Espaces ─────────────
   * Ce qui se trouve sous le curseur décide du menu : passage sélectionné, ligne, mot interactif, bloc, image,
   * lien, carte, fond d'un espace, page en lecture. ⌥ + clic droit rend le menu du système (orthographe…). */

  const cm = { stack: [] };   // menus ouverts, du principal au sous-menu le plus profond

  function closeMenu() {
    for (const m of cm.stack) m.el.remove();
    cm.stack = [];
  }

  // items : { label, k (raccourci), act, sub, danger, off, confirm, check } ; '-' sépare ; { head } titre de section
  function showMenu(x, y, items, parent) {
    if (!parent) closeMenu();
    const el = document.createElement('div');
    el.className = 'cm';
    el.setAttribute('role', 'menu');
    const list = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1));
    const m = { el, items: [], sel: -1 };
    for (const it of list) {
      if (it === '-') { el.append(Object.assign(document.createElement('i'), { className: 'cm-sep' })); continue; }
      if (it.head) { el.append(Object.assign(document.createElement('div'), { className: 'cm-head', textContent: it.head })); continue; }
      const b = document.createElement('button');
      b.className = 'cm-item' + (it.danger ? ' danger' : '') + (it.sub ? ' has-sub' : '');
      b.disabled = !!it.off;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="cm-check">${it.check ? '✓' : ''}</span><span class="cm-l">${esc(it.label)}</span>`
        + (it.k ? `<span class="cm-k">${esc(it.k)}</span>` : '') + (it.sub ? '<span class="cm-k">›</span>' : '');
      const idx = m.items.length;
      m.items.push({ it, b });
      b.onmouseenter = () => focusItem(m, idx, true);
      b.onclick = e => { e.stopPropagation(); activate(m, idx); };
      el.append(b);
    }
    el.onmousedown = e => e.preventDefault();   // la sélection de l'éditeur reste en place
    el.oncontextmenu = e => e.preventDefault();
    document.body.append(el);
    m.anchor = { x, y, parent };
    placeMenu(m);
    cm.stack.push(m);
    sound.pop();
    return m;
  }

  // le menu reste dans la partie visible de l'écran : au-dessus du clavier, et il défile s'il est trop long pour y tenir
  function placeMenu(m) {
    const { el, anchor: { parent } } = m, vv = window.visualViewport;
    let { x, y } = m.anchor;
    const top = (vv ? vv.offsetTop : 0) + 8, bottom = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
    el.style.maxHeight = bottom - top + 'px';
    const w = el.offsetWidth, h = el.offsetHeight;
    let up = false;
    if (parent) {
      const r = parent.b.getBoundingClientRect();
      x = r.right + w + 6 > innerWidth ? r.left - w - 2 : r.right + 2;
      y = Math.min(r.top - 6, bottom - h);
    } else {
      x = Math.min(x, innerWidth - w - 8);
      up = y + h > bottom;
      if (up) y = Math.min(y, bottom) - h;
    }
    el.style.left = Math.max(8, x) + 'px';
    el.style.top = Math.max(top, y) + 'px';
    // l'apparition part du point touché
    el.style.transformOrigin = `${Math.max(0, Math.min(w, m.anchor.x - Math.max(8, x)))}px ${up ? '100%' : '0'}`;
  }
  // le clavier s'ouvre ou se ferme alors qu'un menu est affiché
  if (window.visualViewport) for (const ev of ['resize', 'scroll']) visualViewport.addEventListener(ev, () => cm.stack.forEach(placeMenu));

  function focusItem(m, idx, byMouse) {
    // en survolant un autre élément, le sous-menu ouvert depuis ce menu se referme
    while (cm.stack.length && cm.stack[cm.stack.length - 1] !== m) cm.stack.pop().el.remove();
    m.items.forEach((x, i) => x.b.classList.toggle('on', i === idx));
    m.sel = idx;
    const cur = m.items[idx];
    if (cur && cur.it.sub && !cur.b.disabled && byMouse) clearTimeout(cm.t), cm.t = setTimeout(() => { if (m.sel === idx && cm.stack[cm.stack.length - 1] === m) openSub(m, idx); }, 120);
  }

  function openSub(m, idx) {
    const cur = m.items[idx];
    const sub = showMenu(0, 0, typeof cur.it.sub === 'function' ? cur.it.sub() : cur.it.sub, cur);
    return sub;
  }

  function activate(m, idx) {
    const { it, b } = m.items[idx];
    if (b.disabled) return;
    if (it.sub) { const sub = openSub(m, idx); focusItem(sub, 0); return; }
    // une action destructrice demande un second clic, comme les boutons à deux temps
    if (it.confirm && !b.classList.contains('armed')) {
      b.classList.add('armed');
      b.querySelector('.cm-l').textContent = it.confirm;
      return;
    }
    closeMenu();
    it.act && it.act();
  }

  function bindMenuKeys() {
    document.addEventListener('keydown', e => {
      if (!cm.stack.length) return;
      const m = cm.stack[cm.stack.length - 1];
      const n = m.items.length;
      const move = d => { let i = m.sel; do { i = (i + d + n) % n; } while (m.items[i].b.disabled && i !== m.sel); focusItem(m, i); };
      const handled = { ArrowDown: () => move(1), ArrowUp: () => move(-1),
        ArrowRight: () => { const c = m.items[m.sel]; if (c && c.it.sub) focusItem(openSub(m, m.sel), 0); },
        ArrowLeft: () => { if (cm.stack.length > 1) cm.stack.pop().el.remove(); },
        Enter: () => { if (m.sel >= 0) activate(m, m.sel); },
        Escape: () => closeMenu() }[e.key];
      e.preventDefault();
      e.stopPropagation();
      if (handled) handled();
    }, true);
    document.addEventListener('mousedown', e => { if (cm.stack.length && !e.target.closest('.cm')) closeMenu(); }, true);
    addEventListener('blur', closeMenu);
    addEventListener('resize', closeMenu);
    document.addEventListener('wheel', e => { if (cm.stack.length && !e.target.closest('.cm')) closeMenu(); }, { capture: true, passive: true });
  }

  // un point d'ancrage invisible, pour ouvrir les palettes de couleur là où l'on a cliqué
  function anchorAt(x, y) {
    let a = $('#cmAnchor');
    if (!a) { a = document.createElement('i'); a.id = 'cmAnchor'; document.body.append(a); }
    Object.assign(a.style, { position: 'fixed', left: x + 'px', top: y + 'px', width: '1px', height: '1px', pointerEvents: 'none' });
    return a;
  }

  /* ── Presse-papiers : par l'app sur Mac (fiable, même depuis un menu), sinon par le navigateur ── */

  async function clipWrite(html, text) {
    if (NATIVE) return call('writeClipboard', { html, text });
    try { await navigator.clipboard.writeText(text); } catch (e) { document.execCommand('copy'); }
  }

  async function clipRead() {
    if (NATIVE) { const c = await call('readClipboard'); return { html: (c && c.html) || '', text: (c && c.text) || '' }; }
    try { return { html: '', text: await navigator.clipboard.readText() }; } catch (e) { toast('Utilisez ⌘V pour coller ici'); return null; }
  }

  async function edCopy(cut, el) {
    if (el) { await clipWrite(clipWrap(el.outerHTML), el.innerText || ''); return; }
    restoreRange();
    const s = document.getSelection();
    if (!s.rangeCount || s.isCollapsed) return;
    const r = s.getRangeAt(0);
    const box = document.createElement('div');
    box.append(r.cloneContents());
    await clipWrite(clipHasBlock(box.innerHTML) ? clipWrap(box.innerHTML) : box.innerHTML, s.toString());
    if (cut) { histCommit(); r.deleteContents(); tidy(); ensureTrailingParagraph(); changed(); histCommit(); }
  }

  async function edPaste() {
    const keep = savedRange && savedRange.cloneRange();
    const c = await clipRead();
    if (!c || (!c.html && !c.text)) return c && toast('Le presse-papiers ne contient pas de texte');
    savedRange = keep;
    restoreRange();
    histCommit();
    pasteFrom(c.html, c.text);
    histCommit();
  }

  /* ── Transformer un passage choisi ── */

  // enveloppe le passage sélectionné (sur une seule ligne) dans l'élément que fabrique `build`
  function wrapSelection(build) {
    restoreRange();
    const s = document.getSelection();
    if (!s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    const line = n => (n.nodeType === 3 ? n.parentElement : n).closest(LINE_SEL);
    if (!line(r.startContainer) || line(r.startContainer) !== line(r.endContainer)) { toast('Choisissez un passage sur une seule ligne'); return null; }
    histCommit();
    const frag = r.extractContents();
    for (const old of frag.querySelectorAll('.ix-hide, .ix-note, .ix-goto')) old.replaceWith(...old.childNodes);
    const el = build(frag);
    r.insertNode(el);
    // en fin de ligne, un espace après le mot interactif permet de reprendre l'écriture hors de lui
    if (!el.nextSibling || el.nextSibling.nodeName === 'BR') el.after('\u00a0');
    const r2 = document.createRange();
    r2.setStartAfter(el);
    r2.collapse(true);
    s.removeAllRanges();
    s.addRange(r2);
    saveRange();
    tidy();
    changed();
    histCommit();
    return el;
  }

  const spanOf = (cls, frag, data = {}) => { const sp = document.createElement('span'); sp.className = cls; sp.dataset.id = ixId(); Object.assign(sp.dataset, data); sp.append(frag); return sp; };

  async function selToHide() { wrapSelection(f => spanOf('ix-hide', f)); }

  async function selToNote() {
    const keep = savedRange.cloneRange();
    const r = await ixDialog({ title: 'Note en marge', fields: [{ name: 'note', label: 'Note', type: 'textarea', rows: 3 }], submit: 'Ajouter' });
    if (!r || !r.values) return;
    savedRange = keep;
    wrapSelection(f => spanOf('ix-note', f, { note: r.values.note }));
  }

  async function selToBlank() {
    const keep = savedRange.cloneRange();
    const len = keep.toString().trim().length;
    const r = await ixDialog({ title: 'Trou à compléter', note: BLANK_NOTE, fields: blankFields({ size: len < 14 ? 's' : len < 40 ? 'm' : 'l' }), submit: 'Remplacer' });
    if (!r || !r.values) return;
    savedRange = keep;
    wrapSelection(() => { const t = document.createElement('span'); t.innerHTML = blankHTML(r.values, ixId()); return t.firstChild; });
  }

  async function selToGoto() {
    if (noOtherCard()) return;
    const keep = savedRange.cloneRange();
    const r = await ixDialog({ title: 'Lien vers une carte', fields: [{ name: 'to', label: 'Carte', type: 'select', options: cardOptions() }], submit: 'Relier' });
    if (!r || !r.values) return;
    savedRange = keep;
    wrapSelection(f => { const a = document.createElement('a'); a.className = 'ix-goto'; a.dataset.goto = r.values.to; a.href = '#'; a.append(f); return a; });
  }

  // les lignes sélectionnées deviennent un pli : la première en est le titre, les suivantes le contenu
  function selToFold() {
    restoreRange();
    const s = document.getSelection();
    const body = edBody();
    const top = n => { while (n && n.parentNode !== body) n = n.parentNode; return n; };
    const r = s.getRangeAt(0);
    const a = top(r.startContainer), b = top(r.endContainer);
    if (!a || !b || a.nodeType !== 1 || a.matches('details.ix-fold')) return toast('Placez le curseur sur une ligne de texte');
    const blocks = [];
    for (let n = a; n; n = n.nextElementSibling) { blocks.push(n); if (n === b) break; }
    histCommit();
    const d = document.createElement('details');
    d.className = 'ix-fold';
    d.open = true;
    d.dataset.id = ixId();
    const sum = document.createElement('summary');
    sum.append(inlineOf(blocks[0]));
    if (isBlank(sum)) sum.textContent = 'Titre à déplier';
    const fb = document.createElement('div');
    fb.className = 'ix-fold-body';
    a.before(d);
    blocks[0].remove();
    for (const n of blocks.slice(1)) fb.append(n);
    if (!fb.firstChild) fb.append(emptyParagraph());
    d.append(sum, fb);
    caretInto(fb.firstElementChild, false);
    tidy();
    ensureTrailingParagraph();
    changed();
    histCommit();
  }

  const unwrapEl = el => { histCommit(); el.replaceWith(...el.childNodes); tidy(); changed(); histCommit(); };
  const removeEl = el => { histCommit(); el.remove(); tidy(); ensureTrailingParagraph(); changed(); histCommit(); };

  /* ── Les menus de l'éditeur ── */

  const TRANSFORM = [
    { id: 'p', label: 'Texte' }, { id: 'h1', label: 'Titre' }, { id: 'h2', label: 'Sous-titre' }, { id: 'h3', label: 'Intertitre' }, '-',
    { id: 'ul', label: 'Liste à puces' }, { id: 'ol', label: 'Liste numérotée' }, { id: 'todo', label: 'Liste de tâches' }, '-',
    { id: 'quote', label: 'Citation' }, { id: 'callout', label: 'Encadré' }, { id: 'code', label: 'Code' }, { id: 'fold', label: 'Bloc dépliable' }
  ];

  function transformItems(currentTag) {
    return TRANSFORM.map(t => t === '-' ? '-' : {
      label: t.label, check: t.id === currentTag,
      act: () => { if (t.id === 'fold') return selToFold(); restoreRange(); histCommit(); runBlock(t.id); tidy(); changed(); histCommit(); }
    });
  }

  function insertItems() {
    const pick = it => ({ label: it.label, act: () => { restoreRange(); runBlock(it.id); } });
    const blocks = SLASH_ITEMS.filter(it => !it.id.startsWith('ix-') && !/^(p|h1|h2|h3)$/.test(it.id)).map(pick);
    const ix = SLASH_ITEMS.filter(it => it.id.startsWith('ix-')).map(pick);
    return [...blocks, '-', { label: 'Bloc interactif', sub: ix }];
  }

  function editorMenu(e) {
    const body = edBody(), t = e.target;
    const miss = spellAt(e.clientX, e.clientY);
    if (miss) return showMenu(e.clientX, e.clientY, spellItems(miss));
    const s = document.getSelection();
    // clic droit hors de la sélection : le curseur se pose là où l'on a cliqué
    let r = s.rangeCount ? s.getRangeAt(0) : null;
    const inside = r && !r.collapsed && body.contains(r.commonAncestorContainer) && Array.from(r.getClientRects()).some(b => e.clientX >= b.left - 2 && e.clientX <= b.right + 2 && e.clientY >= b.top - 2 && e.clientY <= b.bottom + 2);
    if (!inside && body.contains(t) && !t.closest('[contenteditable="false"]')) {
      const c = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (c && body.contains(c.startContainer)) { s.removeAllRanges(); s.addRange(c); }
    }
    saveRange();
    const sel = savedRange && !savedRange.collapsed && savedRange.toString().trim() ? savedRange : null;
    const block = t.closest('[data-ix]');
    const img = !block && t.closest('img');
    const inl = t.closest('.ix-hide, .ix-note, .ix-goto, .ix-blank');
    const link = t.closest('a[href]:not(.ix-goto):not(.ix-opt)');
    const fold = t.closest('details.ix-fold');
    const callout = t.closest('.callout'), quote = t.closest('blockquote'), todo = t.closest('ul.todo > li');
    const line = (savedRange ? (savedRange.startContainer.nodeType === 3 ? savedRange.startContainer.parentElement : savedRange.startContainer) : t).closest('h1, h2, h3, p, li, pre, blockquote');
    const tag = line ? ({ H1: 'h1', H2: 'h2', H3: 'h3', PRE: 'code', BLOCKQUOTE: 'quote' }[line.tagName] || (line.closest('blockquote') ? 'quote' : line.closest('.callout') ? 'callout' : line.closest('ul.todo') ? 'todo' : line.closest('ol') ? 'ol' : line.closest('ul') ? 'ul' : 'p')) : '';
    const under = t.closest(ATOM_SEL + ', img');
    const edit = [
      { label: 'Couper', k: '⌘X', off: !sel, act: () => edCopy(true) },
      { label: 'Copier', k: '⌘C', off: !sel && !under, act: () => edCopy(false, sel ? null : under) },
      { label: 'Coller', k: '⌘V', act: edPaste }
    ];

    // un bloc interactif (quiz, galerie, énigme…)
    if (block) {
      const T = IX[block.dataset.ix];
      return showMenu(e.clientX, e.clientY, [
        { head: (T && T.title) || (SLASH_ITEMS.find(x => x.id === 'ix-' + block.dataset.ix || x.id === block.dataset.ix) || {}).label || 'Bloc' },
        block.dataset.ix === 'ink' ? { label: 'Écrire sur la feuille', act: () => inkActivate(block) } : block.dataset.ix === 'voice' ? null : { label: 'Modifier…', act: () => ixEdit(block) },
        block.dataset.ix === 'ink' ? { label: 'Convertir l’écriture en texte', act: () => inkToText(block, inkPaths(block)) } : null,
        // la feuille s'étire d'un bord à l'autre de la page (de la feuille A4 en présentation par pages) ; l'écriture grandit avec elle
        block.dataset.ix === 'ink' ? { label: 'Pleine largeur', check: block.classList.contains('wide'), act: () => { histCommit(); block.classList.toggle('wide'); changed(); histCommit(); } } : null,
        { label: 'Copier', k: '⌘C', act: () => edCopy(false, block) },
        { label: 'Dupliquer', act: () => { histCommit(); const c = block.cloneNode(true); c.dataset.id = ixId(); block.after(c); changed(); histCommit(); } },
        '-',
        { label: 'Ligne au-dessus', act: () => { block.before(emptyParagraph()); caretInto(block.previousElementSibling, false); changed(); } },
        { label: 'Ligne en dessous', act: () => { block.after(emptyParagraph()); caretInto(block.nextElementSibling, false); changed(); } },
        '-',
        { label: 'Supprimer le bloc', danger: true, act: () => removeEl(block) }
      ]);
    }
    // une image posée dans le texte
    if (img) {
      const size = c => ({ label: { s: 'Petite', m: 'Moyenne', l: 'Pleine largeur' }[c], check: img.classList.contains(c), act: () => { img.classList.remove('s', 'm', 'l'); img.classList.add(c); changed(); } });
      return showMenu(e.clientX, e.clientY, [
        { head: 'Image' }, size('s'), size('m'), size('l'), '-',
        { label: 'Loupe pour le lecteur', check: img.hasAttribute('data-zoom'), act: () => { img.toggleAttribute('data-zoom'); changed(); } },
        '-',
        { label: 'Supprimer l’image', danger: true, act: () => { hideImgTools(); removeEl(img); } }
      ]);
    }

    const items = [];
    const cell = t.closest('#edBody td, #edBody th');
    if (cell) items.push({ head: 'Tableau' }, ...tableItems(cell), '-');
    // un mot interactif ou un lien sous le curseur
    if (inl && inl.classList.contains('ix-hide')) items.push({ head: 'Mot à découvrir' }, { label: 'Retirer l’effet', act: () => unwrapEl(inl) }, '-');
    else if (inl && inl.classList.contains('ix-note')) items.push({ head: 'Note en marge' }, { label: 'Modifier la note…', act: () => ixEdit(inl) }, { label: 'Retirer la note', act: () => unwrapEl(inl) }, '-');
    else if (inl && inl.classList.contains('ix-goto')) items.push({ head: 'Lien vers une carte' },
      { label: 'Ouvrir la carte', act: () => { const d = findDoc(inl.dataset.goto); if (d) openDoc(d.id); } },
      { label: 'Changer de carte…', act: () => ixEdit(inl) }, { label: 'Retirer le lien', act: () => unwrapEl(inl) }, '-');
    else if (inl && inl.classList.contains('ix-blank')) items.push({ head: 'Trou à compléter' }, { label: 'Modifier…', act: () => ixEdit(inl) }, { label: 'Supprimer le trou', danger: true, act: () => removeEl(inl) }, '-');
    if (link) items.push({ head: 'Lien' },
      { label: 'Ouvrir le lien', act: () => openURL(link.href) },
      { label: 'Modifier le lien…', act: () => { const r2 = document.createRange(); r2.selectNodeContents(link); savedRange = r2; restoreRange(); openLinkPop(); } },
      { label: 'Retirer le lien', act: () => unwrapEl(link) }, '-');

    if (sel) {
      items.push(
        { label: 'Gras', k: '⌘B', act: () => exec('bold') },
        { label: 'Italique', k: '⌘I', act: () => exec('italic') },
        { label: 'Souligné', k: '⌘U', act: () => exec('underline') },
        { label: 'Barré', act: () => exec('strikeThrough') },
        { label: 'Couleur du texte…', act: () => openTextColorPop(anchorAt(e.clientX, e.clientY)) },
        { label: 'Lien web…', k: '⌘K', act: () => { restoreRange(); openLinkPop(); } },
        '-',
        { label: 'Rendre interactif', sub: [
          { label: 'Mot à découvrir', act: selToHide },
          { label: 'Note en marge…', act: selToNote },
          { label: 'Trou à compléter…', act: selToBlank },
          { label: 'Lien vers une carte…', act: selToGoto }
        ] },
        { label: 'Transformer en', sub: () => transformItems(tag) },
        { label: 'Effacer la mise en forme', act: () => exec('removeFormat') },
        '-');
    } else if (!t.closest('summary')) {
      items.push({ label: 'Transformer la ligne en', sub: () => transformItems(tag) }, { label: 'Insérer', sub: insertItems }, '-');
    }
    if (todo) items.push({ label: todo.classList.contains('done') ? 'Décocher la tâche' : 'Cocher la tâche', act: () => { todo.classList.toggle('done'); sound.check(todo.classList.contains('done')); changed(); } }, '-');
    if (fold && !inl) items.push({ label: 'Défaire le pli', act: () => { histCommit(); dissolveFold(fold); histCommit(); } }, { label: 'Supprimer le pli', danger: true, act: () => removeEl(fold) }, '-');
    if (callout && !fold) items.push({ label: 'Changer l’icône…', act: () => openIconPop(callout.querySelector('.callout-icon')) }, { label: 'Défaire l’encadré', act: () => { histCommit(); unwrapBox(callout); changed(); histCommit(); } }, '-');
    if (quote && !callout && !fold) items.push({ label: 'Défaire la citation', act: () => { histCommit(); unwrapBox(quote); changed(); histCommit(); } }, '-');
    items.push(...edit, { label: 'Tout sélectionner', k: '⌘A', act: () => { const r2 = document.createRange(); r2.selectNodeContents(body); document.getSelection().removeAllRanges(); document.getSelection().addRange(r2); saveRange(); } },
      '-', { label: 'Exporter la page', sub: [
        { label: 'PDF', act: () => exportPage('pdf') },
        { label: 'Word (.docx)', act: () => exportPage('docx') },
        { label: 'Ouvrir dans Pages', act: () => exportPage('pages') }
      ] });
    showMenu(e.clientX, e.clientY, items);
  }

  /* ── Les cartes et le fond d'un espace ── */

  function cardMenu(e, item) {
    const items = item && cardItems(e, item);
    if (items) showMenu(e.clientX, e.clientY, items);
  }

  function cardItems(e, item) {
    const items = [];
    if (item.kind === 'doc') {
      const doc = findDoc(item.id), sp = spaceOfDoc(item.id);
      if (!doc || !sp) return;
      items.push({ head: doc.title || 'Sans titre' }, { label: asReader() ? 'Lire' : 'Ouvrir', act: () => openItem(item) });
      if (!asReader()) {
        if (doc.quick) items.push({ label: 'Déplacer vers une page…', act: () => quickToPage(doc, true) }, { label: 'Copier vers une page…', act: () => quickToPage(doc, false) });
        items.push(PHONE ? null : { label: 'Lire comme un lecteur', act: () => openReader(doc, false) }, '-',
          { label: 'Personnaliser…', act: () => openCardLook(doc) },
          { label: 'Déplacer vers', sub: () => state.spaces.filter(x => x !== sp).map(x => ({ label: pathOf(x).map(p => p.title || 'Sans titre').join(' / '), act: () => {
            sp.docs = sp.docs.filter(d => d !== doc); x.docs.push(doc); persist(); renderRing(); toast('Déplacé dans « ' + x.title + ' »');
          } })).concat(state.spaces.length > 1 ? [] : [{ label: 'Aucun autre espace', off: true }]) },
          { label: 'Dupliquer', act: () => {
            const copy = JSON.parse(JSON.stringify(doc));
            delete copy.history;
            Object.assign(copy, { id: uid(), title: (doc.title || 'Sans titre') + ' (copie)', createdAt: Date.now(), updatedAt: Date.now() });
            sp.docs.splice(sp.docs.indexOf(doc) + 1, 0, copy);
            sound.create(); persist(); renderRing();
          } },
          '-',
          { label: 'Supprimer', danger: true, confirm: 'Confirmer la suppression', act: () => { sound.remove(); sp.docs = sp.docs.filter(d => d !== doc); persist(true); renderRing(); } });
      }
    } else if (item.kind === 'space') {
      const sp = byId(item.id);
      if (!sp) return;
      items.push({ head: sp.title || 'Sans titre' }, { label: 'Ouvrir', act: () => openItem(item) });
      if (!asReader()) {
        items.push('-',
          { label: 'Renommer…', act: async () => { const n = await askName('Renommer l’espace', sp.title); if (n) { sp.title = n; persist(); renderRing(); renderChrome(); } } },
          { label: 'Couleur…', act: () => openColorPop(anchorAt(e.clientX, e.clientY), sp.color || null, c => { if (c) sp.color = c; else delete sp.color; persist(); renderRing(); }) });
        if (!isCloudRoot(sp)) {
          const cloud = byId(CLOUD_ID), inside = new Set([sp, ...descendants(sp)]);
          items.push('-');
          if (cloud && !inCloud(sp)) items.push({ label: 'Mettre dans iCloud', act: () => moveSpace(sp, cloud) });
          if (inCloud(sp)) items.push({ label: 'Retirer d’iCloud', act: () => moveSpace(sp, null) });
          items.push({ label: 'Déplacer vers', sub: () => [
            ...(sp.parent ? [{ label: 'Tous les espaces', act: () => moveSpace(sp, null) }] : []),
            ...state.spaces.filter(x => !inside.has(x) && x.id !== sp.parent).map(x => ({ label: pathOf(x).map(p => p.title || 'Sans titre').join(' / '), act: () => moveSpace(sp, x) }))
          ] },
          '-',
          { label: 'Supprimer l’espace', danger: true, confirm: 'Confirmer : supprimer avec son contenu', act: () => {
            sound.remove();
            const gone = new Set([sp, ...descendants(sp)]);
            state.spaces = state.spaces.filter(x => !gone.has(x));
            persist(); renderRing(); renderChrome();
          } });
        }
      }
    } else return null;
    return items;
  }

  /*
   * Appui long sur une carte (iPhone, iPad) : la carte s'enfonce, puis quitte la roue et vient au centre, le reste flouté,
   * ses actions dessous. Rien ne s'ouvre au relâché : seul « Ouvrir » ouvre, et toucher à côté referme.
   */
  function peekCard(c, item) {
    const items = cardItems({ clientX: innerWidth / 2, clientY: innerHeight / 2 }, item);
    if (!items) return;
    const ratio = c.offsetHeight / c.offsetWidth, w = Math.min(innerWidth * .6, 280, innerHeight * .36 / ratio), from = c.getBoundingClientRect();
    const box = document.createElement('div'), card = document.createElement('div'), sheet = document.createElement('div');
    box.className = 'peek';
    card.className = 'pk-card ' + c.className.replace(/\b(focused|pressing)\b/g, '');
    card.style.setProperty('--cw', w + 'px');
    card.style.setProperty('--ch', w * ratio + 'px');
    card.append($('.face', c).cloneNode(true));
    sheet.className = 'pk-sheet';
    const head = (items.find(i => i && i.head) || {}).head || '';
    const paint = (list, title, back) => {
      sheet.innerHTML = `<div class="pk-head">${back ? `<button class="pk-back" aria-label="Retour">‹</button>` : ''}<b>${esc(title)}</b></div>`;
      if (back) $('.pk-back', sheet).onclick = back;
      for (const it of list.filter(Boolean)) {
        if (it.head) continue;
        if (it === '-') { sheet.append(Object.assign(document.createElement('i'), { className: 'pk-sep' })); continue; }
        const b = document.createElement('button');
        b.className = 'pk-row' + (it.danger ? ' danger' : '') + (list.find(x => x && x.act && !x.head) === it && !back ? ' main' : '');
        b.disabled = !!it.off;
        b.innerHTML = `<span>${esc(it.label)}</span>${it.sub ? '<em>›</em>' : ''}`;
        b.onclick = () => {
          if (it.sub) return paint(it.sub(), it.label, () => paint(list, title, back));
          if (it.confirm && !b.classList.contains('armed')) { b.classList.add('armed'); $('span', b).textContent = it.confirm; haptic('tick'); return; }
          close(it.act);
        };
        sheet.append(b);
      }
    };
    paint(items, head);
    box.append(card, sheet);
    document.body.append(box);
    c.classList.add('peeked');
    ring.hover = item;
    const to = card.getBoundingClientRect();
    if (card.animate) card.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` }, { transform: 'none' }
    ], { duration: 340, easing: 'cubic-bezier(.2, .9, .25, 1.08)' });
    haptic('step');
    sound.pop();
    // le relâché du doigt qui a ouvert ne compte pas : seul un nouveau toucher peut refermer
    let ready = false;
    const arm = () => { removeEventListener('pointerup', arm); setTimeout(() => { ready = true; }, 60); };
    addEventListener('pointerup', arm);
    function close(act) {
      box.classList.add('out');
      c.classList.remove('peeked');
      ring.hover = null;
      setTimeout(() => box.remove(), 220);
      if (act) act();
    }
    box.addEventListener('click', e => { if (ready && e.target === box) close(); });
  }

  function spaceMenu(e) {
    if (asReader()) return;
    if (ring.ctx === 'all') {
      return showMenu(e.clientX, e.clientY, [
        { label: 'Nouvel espace…', act: promptNewSpace },
        { label: 'Ouvrir un .espace…', act: openEspaceFile }
      ]);
    }
    showMenu(e.clientX, e.clientY, [
      { head: (space() || {}).title || 'Espace' },
      { label: 'Nouveau texte', act: createAndOpen },
      { label: 'Nouveau sous-espace…', act: promptSubSpace },
      { label: 'Importer un PDF…', act: () => importPDFs(space()) },
      '-',
      { label: 'Renommer l’espace', act: () => $('#renameSpace').click() },
      { label: 'Couleur de l’espace…', act: () => $('#spaceColor').click() },
      '-',
      { label: 'Partager (.espace)…', act: exportEspaceFile },
      { label: 'Exporter en HTML…', act: exportSpace }
    ]);
  }

  // un champ de saisie (recherche, nom, réglages d'un bloc) : les gestes d'édition, sans plus
  function fieldMenu(e, f) {
    const has = f.selectionStart !== f.selectionEnd;
    const put = text => {
      f.focus();
      f.setRangeText(text, f.selectionStart, f.selectionEnd, 'end');
      f.dispatchEvent(new Event('input', { bubbles: true }));
    };
    showMenu(e.clientX, e.clientY, [
      { label: 'Couper', k: '⌘X', off: !has, act: () => { clipWrite('', f.value.slice(f.selectionStart, f.selectionEnd)); put(''); } },
      { label: 'Copier', k: '⌘C', off: !has, act: () => clipWrite('', f.value.slice(f.selectionStart, f.selectionEnd)) },
      { label: 'Coller', k: '⌘V', act: async () => { const c = await clipRead(); if (c && c.text) put(f.tagName === 'INPUT' ? c.text.replace(/\s*\n\s*/g, ' ') : c.text); } },
      '-',
      { label: 'Tout sélectionner', k: '⌘A', act: () => { f.focus(); f.select(); } }
    ]);
  }

  function readerMenu(e) {
    const s = document.getSelection();
    const has = s.rangeCount && !s.isCollapsed && $('#reader').contains(s.anchorNode);
    showMenu(e.clientX, e.clientY, [
      { label: 'Copier', k: '⌘C', off: !has, act: () => { const box = document.createElement('div'); box.append(s.getRangeAt(0).cloneContents()); clipWrite(box.innerHTML, s.toString()); } },
      '-',
      { label: reader.preview ? 'Revenir à l’édition' : 'Revenir à l’espace', act: closeReader }
    ]);
  }

  /*
   * Au doigt (iPad) : ce qui se fait à la souris sur Mac. Un appui long ouvre le même menu qu'un clic droit
   * (sauf dans le texte, où l'iPad garde sa sélection et son menu Copier/Coller) ; la page ne zoome ni ne rebondit.
   */
  const TOUCH = window.__PLATFORM === 'ipad' || matchMedia('(pointer: coarse)').matches;
  function bindTouch() {
    if (!TOUCH) return;
    document.body.classList.add('touch');
    if (window.__PLATFORM) $('meta[name="viewport"]').setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    let press = null, swallow = false;
    const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
    document.addEventListener('touchstart', e => {
      cancel();
      swallow = false;
      if (e.touches.length !== 1 || e.target.closest('input, textarea, select, .cm, .peek, .card[data-id], #qkVoice, #qkSend')) return;
      // dans le texte, l'iPad garde son menu ; un bloc posé dans le texte (feuille manuscrite, quiz…) a le nôtre
      const ce = e.target.closest('[contenteditable]');
      if (ce && ce.getAttribute('contenteditable') !== 'false') return;
      // jamais sous le crayon (le tenir immobile redresse le trait), ni sous le doigt qui écrit sur la feuille ouverte
      const sheet = e.target.closest('.ix-ink');
      if (e.touches[0].touchType === 'stylus' || (sheet && ink.active === sheet && ink.finger)) return;
      const t = e.target, x = e.touches[0].clientX, y = e.touches[0].clientY;
      press = { x, y, timer: setTimeout(() => {
        press = null;
        swallow = true;
        haptic('step');
        t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      }, 520) };
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', e => { const p = e.touches[0]; if (press && p && Math.hypot(p.clientX - press.x, p.clientY - press.y) > 9) cancel(); }, { capture: true, passive: true });
    document.addEventListener('touchend', cancel, { capture: true, passive: true });
    document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
    // le relâché qui suit un appui long ne doit pas aussi « cliquer » (ouvrir la carte sous le doigt)
    document.addEventListener('click', e => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);
    bindGestures();
  }

  /*
   * Les gestes habituels de l'iPad :
   *  · glisser depuis le bord gauche : revenir en arrière (fermer la carte, la présentation, la mise en scène…) ;
   *  · balayer vers la gauche ou la droite dans une présentation : passage suivant ou précédent ;
   *  · balayer vers le haut ou le bas sur la roue : espace suivant ou précédent ;
   *  · toucher deux fois le titre d'un espace : le renommer ;
   *  · pincer la table de l'album (mise en scène) : zoomer ;
   *  · le clavier à l'écran ne cache jamais le curseur.
   */
  function goBack() {
    closeMenu();
    if (!$('#scene').hidden) return closeScene();
    if (!$('#versions').hidden) return closeVersions();
    if (view === 'editor') return leaveEditor();
    if (view === 'reader') return closeReader();
    if (view === 'space') {
      const sp = space();
      if (ring.ctx === 'all') return;
      if (sp && parentOf(sp)) return enterSpace(parentOf(sp).id, { dir: 'out' });
      return showAll();
    }
  }
  function bindGestures() {
    let sw = null, tap = { t: 0, el: null };
    const opt = { capture: true, passive: true };
    document.addEventListener('touchstart', e => {
      if (sw || e.touches.length > 1) { if (sw) sw.multi = true; return; }   // un deuxième doigt : ce n'est plus un balayage
      const p = e.touches[0];
      sw = { x: p.clientX, y: p.clientY, lx: p.clientX, ly: p.clientY, t: performance.now(), edge: p.clientX < 26, target: e.target,
        ink: p.touchType === 'stylus' || !!(e.target.closest && e.target.closest('.ix-ink') && ink.finger) };
    }, opt);
    document.addEventListener('touchmove', e => { const p = e.touches[0]; if (sw && p) { sw.lx = p.clientX; sw.ly = p.clientY; } }, opt);
    const end = e => {
      if (!sw || e.touches.length) return;
      const s = sw;
      sw = null;
      if (s.multi || s.ink) return;
      const dx = s.lx - s.x, dy = s.ly - s.y, dt = performance.now() - s.t, ax = Math.abs(dx), ay = Math.abs(dy);
      // toucher deux fois au même endroit (titre d'un espace) : comme un double-clic
      if (ax < 10 && ay < 10 && dt < 300) {
        const now = performance.now(), el = s.target.closest && s.target.closest('#spaceTitle');
        if (el && tap.el === el && now - tap.t < 320) { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); tap = { t: 0, el: null }; }
        else tap = { t: now, el };
        return;
      }
      // depuis le bord gauche, vers la droite : revenir (geste sans ambiguïté : pas de limite de durée)
      if (s.edge && dx > 70 && ax > ay * 1.5) { haptic('step'); return goBack(); }
      if (dt > 1200 || s.target.closest('[contenteditable="true"], input, textarea, .cm, .pp-seg, input[type="range"]')) return;
      // dans une présentation : balayer pour avancer ou reculer (le diaporama a déjà son propre geste)
      if (view === 'reader' && ax > 60 && ax > ay * 1.6 && !$('#reader .rd-slides') && !s.target.closest('.ix-gal, .ix-compare, .rd-nav')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: dx < 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }));
        return;
      }
      // sur la roue : balayer vers le haut ou le bas pour changer d'espace
      if (view === 'space' && ay > 80 && ay > ax * 1.6 && s.target.closest('#space') && !s.target.closest('button, a, .actions, .space-meta, .sound, .mode-switch, .act-pop') && ring.ctx !== 'all') {
        const b = $(dy < 0 ? '#nextSpace' : '#prevSpace');
        if (b && !b.disabled && !b.hidden) b.click();
      }
    };
    document.addEventListener('touchend', end, opt);
    document.addEventListener('touchcancel', end, opt);

    // le clavier à l'écran : la feuille raccourcit d'autant, et le curseur reste visible
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => {
        const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
        // (écrite sur la racine, cette valeur recalcule le style de toute la page : seulement si elle change)
        if (kb !== fit.kb) { fit.kb = kb; document.documentElement.style.setProperty('--kb', kb + 'px'); }
        if (kb > 80 && view === 'editor') {
          const s = document.getSelection();
          if (s.rangeCount && edBody().contains(s.anchorNode)) {
            const r = s.getRangeAt(0).getBoundingClientRect(), limit = vv.height - 40;
            if (r.bottom > limit) $('#edScroll').scrollTop += r.bottom - limit;
          }
        }
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
      document.addEventListener('selectionchange', () => { if (view === 'editor') requestAnimationFrame(fit); });
    }
  }

  function bindContextMenu() {
    bindTouch();
    bindMenuKeys();
    document.addEventListener('contextmenu', e => {
      if (e.altKey) { closeMenu(); return; }          // ⌥ : le menu du système
      e.preventDefault();
      const t = e.target;
      if (t.closest('.cm')) return;
      const field = t.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea');
      if (field) return fieldMenu(e, field);
      if (view === 'editor' && !READONLY && (t.closest('#edBody') || t === edBody())) return editorMenu(e);
      if (view === 'editor' && t.closest('#edTitle')) return fieldMenuTitle(e);
      if (view === 'reader' && t.closest('#reader')) return readerMenu(e);
      if (view === 'space') {
        const c = t.closest('.card[data-id]');
        if (c) return cardMenu(e, ring.items[+c.dataset.idx]);
        if (!t.closest('button, a, .actions, #crumbs')) return spaceMenu(e);
      }
      closeMenu();
    });
  }

  // le titre d'une carte : couper, copier, coller en texte simple
  function fieldMenuTitle(e) {
    const title = $('#edTitle');
    const s = document.getSelection();
    const has = s.rangeCount && !s.isCollapsed && title.contains(s.anchorNode);
    const range = has ? s.getRangeAt(0).cloneRange() : null;
    const back = () => { if (range) { s.removeAllRanges(); s.addRange(range); } title.focus(); };
    showMenu(e.clientX, e.clientY, [
      { label: 'Couper', k: '⌘X', off: !has, act: () => { back(); clipWrite('', range.toString()); document.execCommand('delete'); } },
      { label: 'Copier', k: '⌘C', off: !has, act: () => clipWrite('', range.toString()) },
      { label: 'Coller', k: '⌘V', act: async () => { const c = await clipRead(); if (!c || !c.text) return; back(); document.execCommand('insertText', false, c.text.replace(/\s*\n\s*/g, ' ')); } }
    ]);
  }

  /* ───────────── Fichiers : images, PDF, export ───────────── */

  function fileToDataURL(file) {
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => {
        const src = fr.result;
        if (file.type === 'image/gif' || file.size < 1.2e6) return resolve(src);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * k);
          c.height = Math.round(img.naturalHeight * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', .86));
        };
        img.onerror = () => resolve(src);
        img.src = src;
      };
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }

  function browserPick(accept, multiple) {
    return new Promise(resolve => {
      const input = $('#filePick');
      input.accept = accept;
      input.multiple = !!multiple;
      input.value = '';
      input.onchange = () => resolve(Array.from(input.files));
      input.click();
    });
  }

  async function pickImages() {
    saveRange();
    insertImages(await chooseImages());
  }

  function renderPDFFile(file) {
    if (!NATIVE) { toast("L'import PDF est disponible dans l'app macOS"); return Promise.resolve(null); }
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => call('pdfFromData', { name: file.name.replace(/\.pdf$/i, ''), data: String(fr.result).split(',')[1] })
        .then(resolve, () => { toast('PDF illisible : ' + file.name); resolve(null); });
      fr.readAsDataURL(file);
    });
  }

  function addPDFDocs(sp, results) {
    let last = null;
    for (const r of results) {
      if (!r || !r.pages || !r.pages.length) continue;
      last = newDoc(sp, {
        title: r.name,
        html: pdfPagesHTML(r.pages),
        plain: (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        source: 'pdf'
      });
    }
    return last;
  }

  async function importPDFs(sp) {
    if (!NATIVE) { toast("L'import PDF est disponible dans l'app macOS"); return 0; }
    let results;
    try { results = await call('importPDF'); } catch (e) { toast('Import impossible : ' + (e.message || e)); return 0; }
    if (!results || !results.length) return 0;
    const last = addPDFDocs(sp, results);
    if (!last) { toast('Aucune page lisible'); return 0; }
    toast(results.length > 1 ? `${results.length} PDF importés` : '« ' + last.title + ' » importé');
    enterSpace(sp.id, { instant: view !== 'space', focusId: last.id });
    return results.length;
  }

  async function insertPDFPages() {
    if (!NATIVE) return toast("L'import PDF est disponible dans l'app macOS");
    saveRange();
    let results;
    try { results = await call('importPDF'); } catch (e) { return toast('Import impossible'); }
    for (const r of results || []) if (r && r.pages) insertHTMLAtSelection(pdfPagesHTML(r.pages));
  }

  async function importDroppedFiles(files, sp) {
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter(f => f.type.startsWith('image/'));
    let last = null;
    if (pdfs.length) last = addPDFDocs(sp, await Promise.all(pdfs.map(renderPDFFile)));
    for (const f of imgs) {
      const src = await fileToDataURL(f);
      if (src) last = newDoc(sp, { title: f.name.replace(/\.[^.]+$/, ''), html: `<img src="${esc(src)}" class="l"><p><br></p>` });
    }
    if (last) enterSpace(sp.id, { instant: true, focusId: last.id });
  }

  /* L'export emporte l'espace et tous ses sous-espaces. */
  async function exportSpace() {
    const sp = space();
    if (!sp) return;
    const tree = [sp, ...descendants(sp)];
    if (!tree.some(s => s.docs.length)) return toast('Cet espace est vide : rien à exporter');
    if (!NATIVE) return toast("L'export HTML est disponible dans l'app macOS");
    const spaces = [];
    for (const s of tree) {
      const docs = [];
      for (const d of s.docs) {
        const c = Object.assign({}, d);
        if (c.lock) {
          if (!(window.crypto && crypto.subtle)) return toast('Chiffrement indisponible : export annulé');
          c.locked = await encryptDoc(d);
          c.title = ''; c.html = ''; c.plain = '';
        }
        delete c.lock;
        delete c.history;
        if (c.html && c.html.includes('ix-riddle')) c.html = await hashRiddles(c.html);
        docs.push(c);
      }
      spaces.push(Object.assign({}, s, { docs }, s === sp ? { parent: null } : {}));
    }
    try {
      const name = await call('exportHTML', { name: sp.title, data: JSON.stringify({ spaces, root: sp.id, exportedAt: Date.now() }) });
      if (name) toast('Exporté : ' + name);
    } catch (e) {
      toast('Export impossible : ' + (e.message || e));
    }
  }

  /* ───────────── Recherche globale (⌘K) ───────────── */

  const search = { results: [], sel: 0 };

  // version sans accents ni majuscules, caractère par caractère : les positions restent alignées sur l'original
  const foldKeep = s => Array.from(s, ch => fold(ch)[0] || ch).join('');

  function highlight(text, words) {
    const f = foldKeep(text);
    const marks = new Array(text.length).fill(false);
    for (const w of words) {
      for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + w.length)) marks.fill(true, i, i + w.length);
    }
    let out = '', open = false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
      out += esc(text[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  function snippetOf(text, words) {
    const f = foldKeep(text);
    let at = -1;
    for (const w of words) { const i = f.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 0) return text.slice(0, 140);
    const start = Math.max(0, at - 50);
    return (start > 0 ? '…' : '') + text.slice(start, start + 150).trim() + (start + 150 < text.length ? '…' : '');
  }

  function runSearch(q) {
    const words = foldKeep(q).trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const sp of state.spaces) {
      const path = pathOf(sp).map(s => s.title).join(' / ');
      if (words.length && words.every(w => foldKeep(sp.title).includes(w))) {
        out.push({ kind: 'space', sp, score: 3, title: sp.title, path: parentOf(sp) ? pathOf(sp).slice(0, -1).map(s => s.title).join(' / ') : 'Espace', snip: '' });
      }
      for (const doc of sp.docs) {
        if (asReader() && isLocked(doc)) continue;
        const title = doc.title || 'Sans titre';
        const text = plainOf(doc);
        if (!words.length) { out.push({ kind: 'doc', doc, sp, score: doc.updatedAt, title, path, snip: text.slice(0, 140) }); continue; }
        const ft = foldKeep(title), fx = foldKeep(text);
        if (!words.every(w => ft.includes(w) || fx.includes(w))) continue;
        const inTitle = words.filter(w => ft.includes(w)).length;
        out.push({ kind: 'doc', doc, sp, score: inTitle === words.length ? 2 : inTitle ? 1 : 0, title, path, snip: snippetOf(text, words) });
      }
    }
    out.sort((a, b) => b.score - a.score || ((b.doc || b.sp).updatedAt || 0) - ((a.doc || a.sp).updatedAt || 0));
    search.results = out.slice(0, 60);
    search.sel = 0;
    renderSearch(words, !words.length);
  }

  function renderSearch(words, recent) {
    const box = $('#searchResults');
    if (!search.results.length) {
      box.innerHTML = `<div class="sr-empty">${state.spaces.length ? 'Aucun résultat' : 'Aucun texte pour l’instant'}</div>`;
      return;
    }
    box.innerHTML = (recent ? '<div class="sr-head">Récemment modifiés</div>' : '')
      + search.results.map((r, i) => {
        const [bg, fg] = r.kind === 'doc' ? colorOf(r.doc) : (r.sp.color ? colorOf(r.sp) : ['#171717', '#f3f1ea']);
        const chip = `<span class="sr-chip${r.kind === 'space' ? ' sp' : ''}" style="background:${bg};color:${fg}">${r.kind === 'space' ? ic('dot') : ''}</span>`;
        return `<button class="sr${i === search.sel ? ' on' : ''}" data-i="${i}">${chip}<span class="sr-main">`
          + `<span class="sr-title">${highlight(r.title, words)}</span>`
          + `<span class="sr-path">${esc(r.path)}</span>`
          + (r.snip ? `<span class="sr-snip">${highlight(r.snip, words)}</span>` : '')
          + `</span></button>`;
      }).join('');
    const on = $('.sr.on', box);
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function moveSearch(d) {
    const n = search.results.length;
    if (!n) return;
    search.sel = (search.sel + d + n) % n;
    if (d) sound.nav();
    for (const b of $$('#searchResults .sr')) b.classList.toggle('on', +b.dataset.i === search.sel);
    const on = $('#searchResults .sr.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function openSearch() {
    if (!state.spaces.length) return;
    hideTools();
    $('#search').hidden = false;
    sound.pop();
    const input = $('#searchInput');
    input.value = '';
    runSearch('');
    setTimeout(() => input.focus(), 20);
  }

  function closeSearch() {
    $('#search').hidden = true;
  }

  function pickSearch(r) {
    if (!r) return;
    closeSearch();
    if (view === 'editor') closeEditor();
    if (r.kind === 'space') return enterSpace(r.sp.id, { instant: view !== 'space' });
    enterSpace(r.sp.id, { instant: true, focusId: r.doc.id });
    openDoc(r.doc.id);
    // on place le curseur sur la première occurrence du texte cherché
    const words = foldKeep($('#searchInput').value).trim().split(/\s+/).filter(Boolean);
    if (words.length) revealInEditor(words[0]);
  }

  function revealInEditor(word) {
    const body = edBody();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = foldKeep(n.textContent).indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + word.length);
      const s = document.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      const rect = r.getBoundingClientRect();
      const scroller = $('#edScroll');
      scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
      // le curseur se pose devant l'occurrence (une sélection détournerait ⌘K vers les liens)
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
      saveRange();
      return;
    }
  }

  function bindSearch() {
    const input = $('#searchInput');
    input.addEventListener('input', () => runSearch(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); pickSearch(search.results[search.sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
    });
    $('#searchResults').addEventListener('mousedown', e => e.preventDefault());
    $('#searchResults').addEventListener('click', e => {
      const b = e.target.closest('.sr');
      if (b) pickSearch(search.results[+b.dataset.i]);
    });
    $('#searchResults').addEventListener('mousemove', e => {
      const b = e.target.closest('.sr');
      if (b && +b.dataset.i !== search.sel) { search.sel = +b.dataset.i; moveSearch(0); }
    });
    $('#search').addEventListener('mousedown', e => { if (e.target === $('#search')) closeSearch(); });
    $('#searchBtn').addEventListener('click', openSearch);
    document.addEventListener('keydown', e => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || e.defaultPrevented) return;
      if (!$('#ask').hidden) return;
      e.preventDefault();
      if ($('#search').hidden) openSearch(); else closeSearch();
    });
  }

  /* ───────────── Son : effets et musique d'ambiance, entièrement synthétisés ───────────── */

  /*
   * Aucun fichier audio : tout est fabriqué avec Web Audio.
   * La musique suit le principe des boucles de Brian Eno (Music for Airports, Discreet Music) :
   * quelques notes longues, chacune répétée sur une boucle de durée différente et sans rapport
   * simple avec les autres, si bien que les combinaisons ne se répètent jamais à l'identique.
   * Une « graine » (l'espace, ou la carte ouverte) fixe la tonalité, le mode, les boucles et la couleur.
   */
  const sound = (() => {
    let ctx = null, master, musicBus, sfxBus, reverb, reverbIn, noise;
    let drone = null, voices = [], params = null, seedKey = null, timer = null;
    let duckBus = null, voiceBus = null, voiceSrc = null, musicRevIn = null, musicEchoIn = null, musicEcho = null, gen = null, musicOn = false, stopTimer = null, started = false, seedMood = null;
    let lastTick = 0;
    // un petit journal du son, tenu par l'app iPad (Documents/espaces-son.log), pour comprendre ce que fait iOS
    const alog = m => { if (NATIVE && TOUCH) try { call('log', `${new Date().toISOString().slice(11, 23)} ${m}`).catch(() => {}); } catch (e) { /* tant pis */ } };
    const prefs = () => {
      if (!state.prefs) state.prefs = { music: true, sfx: true, volume: .7 };
      return state.prefs;
    };

    function hash(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }
    function rng(seed) {
      let a = seed || 1;
      return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

    // Réverbération longue : une réponse impulsionnelle de bruit qui s'éteint doucement.
    const revCache = new Map();
    function makeReverb(seconds) {
      const c = ctx.createConvolver();
      // calculée une seule fois : le son redémarre après chaque retour dans l'app, et ce calcul figeait l'écran
      const known = revCache.get(seconds + ':' + ctx.sampleRate);
      if (known) { c.buffer = known; return c; }
      const len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          lp = lp * .55 + (Math.random() * 2 - 1) * .45; // un peu adoucie
          d[i] = lp * Math.pow(1 - i / len, 2.6);
        }
      }
      revCache.set(seconds + ':' + ctx.sampleRate, buf);
      c.buffer = buf;
      return c;
    }

    /*
     * Une musique d'une autre app ou un appel sont prioritaires : la page passe en son « d'appoint », qui se mêle à eux au
     * lieu de les couper (le type « playback » les interrompt), et notre musique se tait pour ne pas se superposer.
     */
    let external = !!window.__OTHER_AUDIO;
    const setSessionType = () => { try { if (navigator.audioSession) navigator.audioSession.type = external ? 'ambient' : 'playback'; } catch (e) { /* pas d'API : son ordinaire */ } };
    function setExternal(on) {
      if (on === external) return;
      external = on;
      alog(on ? 'autre son en cours : musique coupée' : 'plus d’autre son');
      setSessionType();
      if (ctx) applyPrefs();
    }
    // iOS compte le son de cette page comme celui d'une autre app : la question n'a de sens que page muette (au lancement,
    // au retour dans l'app, son interrompu), sinon l'app se ferait taire elle-même. Le système, lui, ne peut qu'annoncer la fin.
    const askOther = () => call('otherAudio').then(on => setExternal(!!on)).catch(() => {});
    window.__otherAudio = on => { if (!on) setExternal(false); };

    let hushed = false;
    function init() {
      if (hushed) return false;
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      // sur iPad, le son joue comme celui d'une app de musique : le mode silencieux (vibreur) ne le coupe pas
      setSessionType();
      // une grande mémoire tampon si le moteur l'accorde (WebKit l'ignore et reste à 128 images : c'est pourquoi les
      // réverbérations sont courtes et les nappes limitées, pour tenir la cadence sans décrocher)
      ctx = new AC({ latencyHint: 'playback' });
      alog(`init : ${ctx.state} · audioSession ${navigator.audioSession ? navigator.audioSession.type : 'absente'} · visible ${!document.hidden}`);
      ctx.onstatechange = () => {
        alog(`état : ${ctx && ctx.state}`);
        // iOS a coupé le son en passant (app figée un instant, appel, autre app) : il revient sans attendre un toucher
        if (ctx && ctx.state === 'interrupted' && !document.hidden) setTimeout(async () => {
          if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || document.hidden) return;
          if (NATIVE && window.__PLATFORM) await askOther();   // une musique vient de démarrer ? on repart sans la couper
          if (ctx) ctx.resume().catch(() => {});
        }, 400);
      };
      master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      // les très graves (la plus grande part de l'énergie de la musique) sont hors de portée des haut-parleurs d'un Mac, d'un
      // iPad ou d'un iPhone : ils ne s'entendent pas, mais font vibrer la membrane jusqu'à grésiller. On les retire à la sortie.
      const sub1 = ctx.createBiquadFilter(), sub2 = ctx.createBiquadFilter();
      sub1.type = sub2.type = 'highpass';
      // (ceux d'un Mac vibrent encore plus haut)
      sub1.frequency.value = sub2.frequency.value = window.__PLATFORM ? 110 : 170;
      sub1.Q.value = sub2.Q.value = .7;
      // (ces graves portaient l'essentiel du niveau : on rend à ce qui s'entend la place qu'ils prenaient)
      const lift = ctx.createGain();
      lift.gain.value = 3;
      master.connect(sub1).connect(sub2).connect(lift).connect(comp).connect(ctx.destination);
      // la musique a sa propre réverbération, placée avant le fondu : couper la musique coupe aussi son écho
      musicBus = ctx.createGain();
      musicBus.gain.value = 0;
      // la musique passe par un réglage de niveau : elle se fait discrète quand on écoute une note vocale
      duckBus = ctx.createGain();
      voiceBus = ctx.createGain();
      musicBus.connect(duckBus).connect(master);
      voiceBus.connect(master);
      musicRevIn = ctx.createGain();
      musicRevIn.connect(makeReverb(3.5)).connect(musicBus);
      // un écho rythmé, d'une oreille à l'autre, pour la mélodie et les arpèges
      musicEchoIn = ctx.createGain();
      const el = ctx.createDelay(4), er = ctx.createDelay(4), fb = ctx.createGain(), elp = ctx.createBiquadFilter();
      const merge = ctx.createChannelMerger(2), echoRev = ctx.createGain();
      el.delayTime.value = er.delayTime.value = .8;
      fb.gain.value = .38;
      elp.type = 'lowpass';
      elp.frequency.value = 2600;
      musicEchoIn.connect(el);
      el.connect(er).connect(fb).connect(elp).connect(el);
      el.connect(merge, 0, 0);
      er.connect(merge, 0, 1);
      merge.connect(musicBus);
      echoRev.gain.value = .5;
      merge.connect(echoRev).connect(musicRevIn);
      musicEcho = { l: el, r: er };
      sfxBus = ctx.createGain();
      sfxBus.connect(master);
      reverb = makeReverb(2.5);
      reverbIn = ctx.createGain();
      reverbIn.gain.value = .9;
      reverbIn.connect(reverb).connect(sfxBus);
      const n = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noise = n;
      applyPrefs();
      return true;
    }

    // Le navigateur n'autorise le son qu'après un premier geste : on démarre à ce moment-là.
    // (sur iPad, le son peut aussi être « interrompu » par le système : un appel, une autre app, un retour de veille)
    function unlock() {
      const fresh = !ctx;
      if (!init()) return;
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        alog(`relance (${ctx.state})`);
        ctx.resume().then(() => alog(`relancé : ${ctx && ctx.state}`), e => alog(`relance refusée : ${e && e.message}`));
      }
      // sur iPad, un son muet joué pendant le geste réveille la sortie audio (iOS l'exige parfois)
      if (TOUCH && fresh) {
        try { const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, 22050); b.connect(ctx.destination); b.start(0); } catch (e) { /* tant pis */ }
      }
      if (prefs().music && !external && !musicOn) applyPrefs();
      if (fresh && pendingAmb) { const k = pendingAmb; pendingAmb = null; ambience(k); }
    }

    const MUSIC_LEVEL = .55;
    const FADE = 3; // secondes, à l'arrêt comme au retour de la musique

    function applyPrefs() {
      if (!ctx) return;
      const p = prefs(), t = ctx.currentTime;
      master.gain.setTargetAtTime(p.volume, t, .1);
      sfxBus.gain.setTargetAtTime(p.sfx ? 1 : 0, t, .05);
      const wanted = p.music && !external;
      if (wanted === musicOn) return;
      musicOn = wanted;
      const g = musicBus.gain;
      const from = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(from, t);
      g.linearRampToValueAtTime(musicOn ? MUSIC_LEVEL : 0, t + (musicOn && !started ? .35 : FADE));
      if (musicOn) started = true;
      clearTimeout(stopTimer);
      if (musicOn) startMusic();
      // une fois le fondu terminé, on cesse de produire des notes
      else stopTimer = setTimeout(stopMusic, FADE * 1000 + 200);
    }

    /*
     * Niveau de chaque bruitage. Les valeurs sont calibrées à la mesure (niveau efficace) pour que
     * chaque bruitage sonne à FX_RATIO (6,5 %) du niveau moyen de la musique, quel que soit le réglage du volume.
     */
    const FX_RATIO = .065;
    // mesuré : musique ≈ 0,042 en moyenne (4 ambiances) ; facteur = 0,4 × musique ÷ niveau mesuré du bruitage
    const FX_CAL = {
      tick: 2.37, drop: .46, woosh: 2.7, word: 12.09, newline: .97, saved: 23.5, brush: 7.95, chime: 1.46,
      create: 1.65, remove: .55, pop: 1.76, nav: 7.46, check: 1.99, colorChord: 1.27
    };
    const fxBuses = {};
    let fx = null;
    function busFor(name) {
      if (!fxBuses[name]) {
        const dry = ctx.createGain(), rev = ctx.createGain();
        dry.gain.value = rev.gain.value = (FX_CAL[name] || 1) * FX_RATIO;
        dry.connect(sfxBus);
        rev.connect(reverbIn);
        fxBuses[name] = { dry, rev };
      }
      return fxBuses[name];
    }
    // chaque bruitage passe par son propre niveau
    // chaque bruitage passe par son niveau, puis par un panoramique placé là où l'on a agi
    const routed = (name, f) => (...a) => {
      if (!ctx) return;
      const bus = busFor(name);
      if (prefs().spatial !== false && ctx.createStereoPanner) {
        const pan = (panX * 2 - 1) * .85, d = ctx.createStereoPanner(), r = ctx.createStereoPanner();
        d.pan.value = r.pan.value = pan;
        d.connect(bus.dry);
        r.connect(bus.rev);
        fx = { dry: d, rev: r };
      } else fx = bus;
      return f(...a);
    };

    /* ── Effets ── */

    function env(g, t, peak, attack, decay) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(.0001, t + attack + decay);
    }

    // « tik » : un petit clic boisé à chaque carte qui passe devant
    function tick(strength = 1) {
      if (!ctx || !prefs().sfx || ctx.state !== 'running') return;
      const now = performance.now();
      if (now - lastTick < 28) return;
      lastTick = now;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1900 + Math.random() * 500, t);
      o.frequency.exponentialRampToValueAtTime(900, t + .03);
      f.type = 'highpass';
      f.frequency.value = 600;
      env(g, t, .09 * strength, .001, .045);
      o.connect(f).connect(g).connect(fx.dry);
      o.start(t);
      o.stop(t + .08);
      const s = ctx.createBufferSource(), sg = ctx.createGain(), bp = ctx.createBiquadFilter();
      s.buffer = noise;
      bp.type = 'bandpass';
      bp.frequency.value = 4200;
      bp.Q.value = 3;
      env(sg, t, .05 * strength, .0005, .02);
      s.connect(bp).connect(sg).connect(fx.dry);
      s.start(t, Math.random());
      s.stop(t + .04);
    }

    // « goutte » : une note ronde dont la hauteur tombe, un peu de réverbération
    function drop() {
      if (!ctx || !prefs().sfx) return;
      const t = ctx.currentTime + .005;
      const base = 520 + Math.random() * 120;
      for (const [mul, vol] of [[1, .22], [2.76, .05]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(base * mul * 1.9, t);
        o.frequency.exponentialRampToValueAtTime(base * mul, t + .07);
        env(g, t, vol, .004, .42);
        o.connect(g);
        g.connect(fx.dry);
        const send = ctx.createGain();
        send.gain.value = .35;
        g.connect(send).connect(fx.rev);
        o.start(t);
        o.stop(t + .6);
      }
    }

    // « woosh » : un souffle filtré qui balaie l'espace stéréo
    function woosh(dur = .75, dir = 1) {
      if (!ctx || !prefs().sfx) return;
      const t = ctx.currentTime + .01;
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      s.loop = true;
      f.type = 'bandpass';
      f.Q.value = .9;
      f.frequency.setValueAtTime(260, t);
      f.frequency.exponentialRampToValueAtTime(2300, t + dur * .45);
      f.frequency.exponentialRampToValueAtTime(420, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(.16, t + dur * .4);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      let out = g;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.setValueAtTime(-.6 * dir, t);
        p.pan.linearRampToValueAtTime(.6 * dir, t + dur);
        g.connect(p);
        out = p;
      }
      s.connect(f).connect(g);
      out.connect(fx.dry);
      const send = ctx.createGain();
      send.gain.value = .25;
      out.connect(send).connect(fx.rev);
      s.start(t, Math.random());
      s.stop(t + dur + .05);
    }

    /* ── Musique ── */

    /*
     * Un petit morceau qui s'écrit tout seul, sans jamais se répéter :
     * – une suite d'accords qui avance lentement, et qui change un accord à chaque tour ;
     * – des sections qui montent et redescendent (presque rien, puis une basse, une mélodie, un arpège…) ;
     * – un motif mélodique qui revient, à chaque fois varié (renversé, à l'envers, orné, déplacé…)
     *   et qui dérive doucement au fil des sections ;
     * – de temps en temps, la tonalité glisse ailleurs ;
     * – par-dessus, les boucles à la Eno, qui jouent maintenant les notes de l'accord en cours.
     */

    const MODES = [
      [0, 2, 4, 7, 9],          // pentatonique majeure
      [0, 2, 4, 6, 7, 9, 11],   // lydien
      [0, 2, 3, 5, 7, 9, 10],   // dorien
      [0, 3, 5, 7, 10],         // pentatonique mineure
      [0, 2, 5, 7, 9, 10],      // suspendu
      [0, 2, 4, 7, 11],         // majeur 7, très ouvert
      [0, 1, 5, 7, 8],          // in-sen, japonisant et brumeux
      [0, 2, 4, 5, 7, 9, 11]    // majeur : la lumière franche
    ];
    // les modes voisins, vers lesquels la musique peut glisser au cours d'un morceau
    const MODE_NEAR = { 0: [5, 1, 7], 1: [0, 5, 7], 2: [3, 4], 3: [2, 4], 4: [0, 2], 5: [1, 0], 6: [3, 2], 7: [1, 5] };

    // Chaque ambiance a son instrument : des couches d'oscillateurs [forme, multiple, désaccord, niveau],
    // et une voix de mélodie (synthèse FM : rapport, indice, chute, attaque).
    const TIMBRES = {
      doux: { layers: [['sine', 1, 0, 1], ['triangle', 1, 4, .5], ['sine', 2, -3, .18]], gain: 1, bells: .25, bright: 1,
        lead: { ratio: 1, index: 1.1, decay: 2.6, attack: .012 } },
      cordes: { layers: [['sawtooth', 1, -9, .3], ['sawtooth', 1, 9, .3], ['sine', .5, 0, .45]], gain: .7, bells: .1, bright: .65,
        lead: { ratio: 1, index: .55, decay: 3.4, attack: .09 } },
      orgue: { layers: [['square', 1, 0, .12], ['sine', 2, 0, .32], ['sine', .5, 0, .55]], gain: .8, bells: .12, bright: .75,
        lead: { ratio: 2, index: .8, decay: 3, attack: .03 } },
      verre: { layers: [['sine', 1, 0, .8], ['sine', 3, 3, .12]], gain: .85, bells: .7, bright: 1.4,
        lead: { ratio: 3.5, index: 1.8, decay: 3.8, attack: .004 } },
      halo: { layers: [['triangle', 1, 0, .6], ['sine', 1.5, 0, .22], ['sine', 2, 6, .15]], gain: .9, bells: .3, bright: 1.1,
        lead: { ratio: 2, index: 1.4, decay: 4.2, attack: .02 } },
      // des voix lointaines : deux scies désaccordées passées dans les résonances d'une voyelle
      choeur: { layers: [['sawtooth', 1, -8, .32], ['sawtooth', 1, 8, .32], ['sine', .5, 0, .35]], gain: 1.1, bells: .3, bright: 1.1, formant: true,
        lead: { ratio: 1, index: .45, decay: 3.8, attack: .14 } }
    };
    const TIMBRE_NAMES = Object.keys(TIMBRES);

    // Une graine donne une ambiance entière ; si elle ressemble trop à la précédente, on s'en écarte franchement.
    // La couleur d'un espace ou d'une carte oriente l'ambiance : sombre et grave, claire et lumineuse…
    // energy : l'intensité autour de laquelle le morceau respire ; beat : la durée d'un temps.
    const MOODS = {
      sombre: { modes: [2, 3, 6], timbres: ['cordes', 'orgue', 'doux'], registers: [-12, -12, 0], bright: .55, density: 1.3, energy: .38, beat: 1.3 },
      clair: { modes: [0, 1, 5, 7], timbres: ['verre', 'halo', 'doux'], registers: [0, 12, 12], bright: 1.35, density: .9, energy: .55, beat: 1, shimmer: .3 },
      chaud: { modes: [0, 4, 5, 7], timbres: ['cordes', 'doux', 'halo'], registers: [-12, 0, 0], bright: .85, density: 1, energy: .48, beat: 1.15, shimmer: .25 },
      froid: { modes: [1, 2, 6], timbres: ['verre', 'halo', 'orgue'], registers: [0, 0, 12], bright: 1.15, density: 1.1, energy: .45, beat: 1.1 },
      // moods choisis pour une page : toujours apaisants, mais plus ou moins denses, vifs ou intenses
      calme: { modes: [0, 4, 5], timbres: ['doux', 'halo'], registers: [-12, 0], bright: .75, density: 1.05, nv: [5, 6], dur: [10, 16], vel: .85, drone: .06, energy: .28, beat: 1.45 },
      contemplatif: { modes: [1, 4, 5], timbres: ['halo', 'doux', 'verre'], registers: [0, 0, 12], bright: 1, density: 1.2, dur: [9, 14], energy: .34, beat: 1.35 },
      lumineux: { modes: [0, 1, 5], timbres: ['verre', 'halo'], registers: [0, 12, 12], bright: 1.45, density: .9, bells: .55, energy: .58, beat: .95 },
      melancolique: { modes: [2, 3, 6], timbres: ['cordes', 'doux'], registers: [-12, 0], bright: .7, density: 1.15, dur: [9, 15], energy: .4, beat: 1.3 },
      mysterieux: { modes: [6, 2], timbres: ['orgue', 'verre', 'cordes'], registers: [-12, 0], bright: .6, density: 1.1, bells: .5, drone: .09, energy: .36, beat: 1.25 },
      onirique: { modes: [1, 4], timbres: ['halo', 'verre'], registers: [0, 12], bright: 1.2, density: .85, bells: .6, energy: .45, beat: 1.1 },
      vif: { modes: [0, 4, 1], timbres: ['verre', 'halo', 'doux'], registers: [0, 12], bright: 1.25, density: .45, nv: [5, 7], dur: [4, 7], pulse: .62, energy: .72, beat: .62 },
      intense: { modes: [3, 2, 6], timbres: ['cordes', 'orgue'], registers: [-12, 0], bright: 1.2, density: .55, nv: [7, 9], dur: [6, 11], vel: 1.4, drone: .11, pulse: 1.1, energy: .8, beat: .75 },
      /*
       * Les moods « mondes » : de longs accords pleins d'espoir.
       * chordLen : durée d'un accord ; progs : des suites qui s'élèvent ; shapes : des accords enrichis (9e, 7e majeure, 6/9, sus2) ;
       * arc : l'intensité section après section ; shimmer : un scintillement à l'octave, surtout dans la réverbération ;
       * push : une basse qui pousse au sommet ; riser : un souffle qui monte avant le sommet ; arpRise : des arpèges qui grimpent ;
       * mediant : des accords venus d'ailleurs (à une tierce, hors de la gamme) ; reverse : des notes à l'envers, aspirées ;
       * tape : une justesse qui ondule comme une vieille bande ; circle : des sons qui tournent autour de l'auditeur.
       */
      aube: {
        modes: [7, 1], timbres: ['choeur', 'halo', 'doux'], registers: [0, 0, -12], bright: 1.05, density: 1.3, energy: .3, beat: 1.4,
        nv: [4, 5], dur: [12, 18], vel: .9, drone: .05, bells: .35, melody: .5,
        chordLen: [30, 40], progs: [[3, 0, 4, 5], [0, 4, 5, 3], [0, 3, 0, 4], [5, 3, 0, 4], [0, 1, 3, 0]],
        shapes: [[0, 2, 4, 8], [0, 4, 8], [0, 2, 4, 6], [0, 1, 4, 7], [0, 4, 5, 8]],
        arc: [.15, .3, .22, .42, .3, .5, .2], shimmer: .55
      },
      horizon: {
        modes: [7, 1], timbres: ['cordes', 'halo', 'choeur'], registers: [0, -12], bright: 1.3, density: 1, energy: .55, beat: .85,
        nv: [5, 7], dur: [8, 13], drone: .08, bells: .45,
        chordLen: [16, 24], progs: [[0, 4, 5, 3], [5, 3, 0, 4], [3, 0, 4, 5], [0, 2, 3, 3], [0, 5, 3, 4]],
        shapes: [[0, 2, 4, 8], [0, 2, 4, 6], [0, 4, 7, 9]],
        arc: [.15, .3, .45, .6, .75, .9, .97, .45, .2], shimmer: 1, push: true, riser: true, arpRise: true
      },
      ailleurs: {
        modes: [1, 7, 5], timbres: ['choeur', 'verre', 'halo'], registers: [0, 12], bright: 1.15, density: 1.1, energy: .42, beat: 1.15,
        nv: [5, 6], dur: [10, 16], drone: .06, bells: .5,
        chordLen: [20, 30], progs: [[0, 1, 0, 5], [0, 3, 1, 0], [0, 5, 3, 1], [0, 1, 4, 3]],
        shapes: [[0, 2, 4, 8], [0, 4, 8], [0, 2, 4, 6]],
        arc: [.25, .45, .3, .6, .4, .2], shimmer: .7, mediant: .28, reverse: true, tape: 14, circle: true
      },
      // les trois mondes à la suite : quelques minutes d'aube, une montée vers l'horizon, un passage ailleurs, puis le retour
      voyage: { chapters: ['aube', 'horizon', 'ailleurs'] }
    };

    const pick = (r, a) => a[Math.floor(r() * a.length)];
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    // Un motif : quelques notes (en degrés de la gamme, depuis la fondamentale de l'accord) et leurs durées (en temps).
    function makeMotif(r) {
      const n = 4 + Math.floor(r() * 3), out = [];
      let deg = pick(r, [0, 2, 4, 4, 2]);
      for (let i = 0; i < n; i++) {
        out.push({ deg, d: pick(r, [1, 1, 1, 2, .5, 1.5, 2, 3]) });
        deg += pick(r, [-2, -1, -1, 1, 1, 2, 0, 3, -3]);
      }
      out[n - 1].d = Math.max(out[n - 1].d, 2);   // la phrase se pose sur sa dernière note
      return out;
    }

    // Une variation du motif : une ou deux transformations, plus fréquentes et plus vives quand la musique monte.
    function varyMotif(m, r, energy) {
      let v = m.map(n => ({ ...n }));
      const ops = ['invert', 'retro', 'shift', 'ornament', 'fragment', 'drop', energy < .45 ? 'augment' : 'diminish'];
      const k = r() < .2 ? 0 : r() < .7 ? 1 : 2;
      for (let i = 0; i < k; i++) {
        const op = pick(r, ops), f = v[0].deg;
        if (op === 'invert') v = v.map(n => ({ ...n, deg: f - (n.deg - f) }));
        else if (op === 'retro') v = v.slice().reverse();
        else if (op === 'shift') { const s = pick(r, [-2, -1, 1, 2, 3]); v = v.map(n => ({ ...n, deg: n.deg + s })); }
        else if (op === 'ornament') {
          const j = Math.floor(r() * v.length);
          if (v[j].d >= 1) { v[j].d -= .5; v.splice(j, 0, { deg: v[j].deg + pick(r, [1, -1]), d: .5 }); }
        } else if (op === 'fragment' && v.length > 3) {
          const h = v.slice(0, Math.ceil(v.length / 2)), s = pick(r, [-1, 1, 2]);
          v = h.concat(h.map(n => ({ ...n, deg: n.deg + s })));
        } else if (op === 'drop' && v.length > 3) {
          const j = 1 + Math.floor(r() * (v.length - 2));
          v[j - 1].d += v[j].d;
          v.splice(j, 1);
        } else if (op === 'augment') v = v.map(n => ({ ...n, d: n.d * 2 }));
        else if (op === 'diminish') v = v.map(n => ({ ...n, d: n.d >= 1 ? n.d / 2 : n.d }));
      }
      v[v.length - 1].d = Math.max(v[v.length - 1].d, 1.5);
      return v;
    }

    // Une suite d'accords : des degrés de la gamme, qui partent de la tonique et n'y restent pas.
    function makeProg(r, size) {
      const cand = size >= 7 ? [3, 4, 5, 1, 5, 3, 2, 6] : [1, 2, 3, 4, 3, 2];
      const n = 3 + Math.floor(r() * 3), out = [0];
      while (out.length < n) {
        const d = pick(r, cand);
        if (d !== out[out.length - 1]) out.push(d);
      }
      return out;
    }

    function paramsFor(key, prev, mood) {
      const r = rng(hash(key));
      let M = MOODS[mood] || null;
      // un voyage commence par son premier monde
      const chapters = M && M.chapters || null;
      if (chapters) M = MOODS[chapters[0]];
      const modes = M ? M.modes : MODES.map((_, i) => i);
      const timbres = M ? M.timbres : TIMBRE_NAMES;
      let root = 45 + Math.floor(r() * 12);
      let modeIdx = modes[Math.floor(r() * modes.length)];
      let timbre = timbres[Math.floor(r() * timbres.length)];
      const registers = M ? M.registers : [-12, 0, 0, 12];
      const register = registers[Math.floor(r() * registers.length)];
      const density = (.55 + r() * 1.05) * (M ? M.density : 1);   // < 1 : plus de notes ; > 1 : plus d'espace
      if (prev) {
        const d = ((root - prev.root) % 12 + 12) % 12;
        if (d < 3 || d > 9) root += 5;                 // au moins une quarte d'écart
        if (modeIdx === prev.modeIdx) modeIdx = modes[(modes.indexOf(modeIdx) + 1 + Math.floor(r() * (modes.length - 1))) % modes.length];
        if (timbre === prev.timbre) timbre = timbres[(timbres.indexOf(timbre) + 1 + Math.floor(r() * (timbres.length - 1))) % timbres.length];
      }
      const T = TIMBRES[timbre];
      const p = {
        key, root, modeIdx, mode: MODES[modeIdx], timbre, T, register, rand: r,
        bright: (500 + r() * 1700) * T.bright * (M ? M.bright : 1),
        drone: M && M.drone || .07, vel: M && M.vel || 1,
        pulse: M && M.pulse || 0,
        beat: (M ? M.beat : 1 + r() * .4) * (.9 + r() * .2),
        energyBase: M ? M.energy : .35 + r() * .25,
        chordLen: (15 + r() * 9) * clamp(density, .75, 1.35),
        motif: makeMotif(r),
        energy: 0, sec: null, secLeft: 0, step: 0, cycle: 0, voicing: null, chords: [], nextChord: 0
      };
      p.note = deg => {
        const m = p.mode, n = m.length;
        return p.root + Math.floor(deg / n) * 12 + m[((deg % n) + n) % n];
      };
      p.F = M || {};
      p.arcPos = 0;
      p.chapters = chapters;
      p.chapter = 0;
      p.chapterLeft = chapters ? M.arc.length : 0;
      if (M && M.chordLen) p.chordLen = M.chordLen[0] + r() * (M.chordLen[1] - M.chordLen[0]);
      p.prog = M && M.progs ? pick(r, M.progs).slice() : makeProg(r, p.mode.length);
      // les boucles à la Eno : chacune joue une note de l'accord en cours, sur sa propre période
      const loops = [];
      const [nvMin, nvMax] = (M && M.nv) || [4, 6];
      const nv = nvMin + Math.floor(r() * (nvMax - nvMin + 1));
      const [dMin, dMax] = (M && M.dur) || [7, 14];
      const bells = M && M.bells != null ? M.bells : T.bells;
      for (let i = 0; i < nv; i++) {
        loops.push({
          tone: Math.floor(r() * 4), oct: pick(r, [0, 0, 12, 12, 24]),
          period: (15 + r() * 26) * density,           // des boucles qui ne se recoupent jamais pareil
          dur: dMin + r() * (dMax - dMin),
          vel: (.03 + r() * .025) * T.gain * p.vel,
          bell: r() < bells
        });
      }
      p.loops = loops;
      return p;
    }

    // Une « génération » regroupe les notes d'une ambiance, pour pouvoir la faire disparaître d'un bloc.
    // Son niveau garde la musique aussi forte qu'avant (mesuré), pour que les bruitages restent à leur place.
    const GEN_LEVEL = .8;
    function newGen(fadeIn) {
      const t = ctx.currentTime;
      const g = { dry: ctx.createGain(), send: ctx.createGain(), echo: ctx.createGain() };
      g.dry.connect(musicBus);
      g.send.connect(musicRevIn);
      g.echo.connect(musicEchoIn);
      for (const n of [g.dry, g.send, g.echo]) {
        n.gain.setValueAtTime(fadeIn ? 0 : GEN_LEVEL, t);
        if (fadeIn) n.gain.linearRampToValueAtTime(GEN_LEVEL, t + fadeIn);
      }
      return g;
    }

    function retire(g, seconds) {
      const t = ctx.currentTime;
      for (const n of [g.dry, g.send, g.echo]) {
        n.gain.cancelScheduledValues(t);
        n.gain.setValueAtTime(n.gain.value, t);
        n.gain.linearRampToValueAtTime(0, t + seconds);
      }
      setTimeout(() => { g.dry.disconnect(); g.send.disconnect(); g.echo.disconnect(); }, (seconds + 30) * 1000);
    }

    // vers la sortie : un panoramique (au hasard, ou imposé), la réverbération, et l'écho rythmé si demandé
    function route(node, sendLevel, echo = 0, pan = null, dry = 1) {
      if (prefs().spatial !== false && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        if (pan == null && params && params.F.circle) {
          // le son tourne lentement autour de l'auditeur
          const n = 64, ph = Math.random() * Math.PI * 2, turns = .4 + Math.random() * .8, curve = new Float32Array(n);
          for (let i = 0; i < n; i++) curve[i] = Math.sin(ph + turns * Math.PI * 2 * i / (n - 1)) * .85;
          p.pan.setValueCurveAtTime(curve, ctx.currentTime, 40);
        } else p.pan.value = pan == null ? (Math.random() * 2 - 1) * .7 : pan;
        node.connect(p);
        node = p;
      }
      if (dry === 1) node.connect(gen.dry);
      else { const d = ctx.createGain(); d.gain.value = dry; node.connect(d).connect(gen.dry); }
      const send = ctx.createGain();
      send.gain.value = sendLevel;
      node.connect(send).connect(gen.send);
      if (echo) {
        const e = ctx.createGain();
        e.gain.value = echo;
        node.connect(e).connect(gen.echo);
      }
    }

    // une nappe : les couches du timbre, un filtre qui s'ouvre et se referme, et un lent mouvement qui la fait vivre
    // au-delà, les longues nappes se recouvrent sans rien ajouter à l'oreille, et pèsent lourd sur le calcul du son
    let padsLive = 0;
    const PADS_MAX = 8;
    function pad(midi, t, dur, vel, p, attack) {
      if (padsLive >= PADS_MAX) return;
      padsLive++;
      setTimeout(() => padsLive--, Math.max(0, t - ctx.currentTime + dur) * 1000);
      const f = mtof(midi);
      const g = ctx.createGain(), lp = ctx.createBiquadFilter();
      const peak = p.bright * (.75 + Math.random() * .5);
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(peak * .5, t);
      lp.frequency.linearRampToValueAtTime(peak, t + dur * (.3 + Math.random() * .3));
      lp.frequency.linearRampToValueAtTime(peak * .45, t + dur);
      lp.Q.value = .4 + Math.random() * .5;
      const att = attack || Math.min(4, dur * .3), rel = Math.min(6, dur * .45);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + att);
      g.gain.setValueAtTime(vel, t + dur - rel);
      g.gain.linearRampToValueAtTime(0, t + dur);
      // le souffle de la nappe : le filtre et la justesse ondulent très lentement
      const lfo = ctx.createOscillator(), lfoF = ctx.createGain(), lfoP = ctx.createGain();
      lfo.frequency.value = .05 + Math.random() * .12;
      lfoF.gain.value = peak * .18;
      lfoP.gain.value = 4 + (p.F && p.F.tape || 0);
      lfo.connect(lfoF).connect(lp.frequency);
      lfo.connect(lfoP);
      lfo.start(t);
      lfo.stop(t + dur + .1);
      for (const [type, mul, det, v] of p.T.layers) {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = type;
        o.frequency.value = f * mul;
        o.detune.value = det + (Math.random() * 2 - 1) * 3;
        lfoP.connect(o.detune);
        og.gain.value = v;
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(t + dur + .1);
      }
      if (p.T.formant) {
        // le chœur : deux résonances de voyelle, qui glissent lentement d'une voyelle à l'autre
        const a = pick(Math.random, VOWELS), b = pick(Math.random, VOWELS);
        for (let k = 0; k < 2; k++) {
          const bp = ctx.createBiquadFilter(), bg = ctx.createGain();
          bp.type = 'bandpass';
          bp.Q.value = k ? 7 : 5;
          bp.frequency.setValueAtTime(a[k], t);
          bp.frequency.linearRampToValueAtTime(b[k], t + dur);
          bg.gain.value = k ? 1.6 : 2.6;
          lp.connect(bp).connect(bg).connect(g);
        }
      } else lp.connect(g);
      route(g, .8);
    }
    const VOWELS = [[800, 1150], [450, 800], [350, 640], [600, 1040], [400, 1700]];   // a, o, ou, è, é

    function bell(midi, t, vel, echo = 0) {
      const f = mtof(midi + 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + .03);
      g.gain.exponentialRampToValueAtTime(.0001, t + 7);
      for (const [mul, v] of [[1, 1], [2.01, .25], [3.98, .08]]) {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f * mul;
        og.gain.value = v;
        o.connect(og).connect(g);
        o.start(t);
        o.stop(t + 7.2);
      }
      route(g, 1.1, echo);
    }

    // une note pincée, douce et brève : les arpèges
    function pluck(midi, t, vel, bright, echo = .35) {
      const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      o.type = 'triangle';
      o.frequency.value = mtof(midi);
      o.detune.value = (Math.random() * 2 - 1) * 5;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(bright * 1.6, t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(200, bright * .4), t + 1.2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + .012);
      g.gain.exponentialRampToValueAtTime(.0001, t + 1.6);
      o.connect(lp).connect(g);
      route(g, .9, echo);
      o.start(t);
      o.stop(t + 1.7);
    }

    // la voix de la mélodie : une synthèse FM douce, dont l'éclat s'éteint avec la note (piano électrique, verre, flûte…)
    function lead(midi, t, dur, vel, p) {
      const L = p.T.lead, f = mtof(midi);
      const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      c.type = m.type = 'sine';
      c.frequency.value = f;
      c.detune.value = (Math.random() * 2 - 1) * 4;
      m.frequency.value = f * L.ratio;
      mg.gain.setValueAtTime(f * L.index, t);
      mg.gain.exponentialRampToValueAtTime(f * L.index * .06 + 1, t + L.decay * .5);
      m.connect(mg).connect(c.frequency);
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(8000, p.bright * 2.4 + 600);
      const end = t + dur + L.decay * .6;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + L.attack);
      g.gain.setTargetAtTime(vel * .55, t + L.attack, L.decay * .35);
      g.gain.setTargetAtTime(.0001, t + dur, L.decay * .18);
      c.connect(lp).connect(g);
      route(g, .75, .45, (Math.random() * 2 - 1) * .35);
      c.start(t); m.start(t);
      c.stop(end + .1); m.stop(end + .1);
      if (p.F.tape) {
        const w = ctx.createOscillator(), wg = ctx.createGain();
        w.frequency.value = .3 + Math.random() * .4;
        wg.gain.value = p.F.tape * .6;
        w.connect(wg).connect(c.detune);
        w.start(t);
        w.stop(end + .1);
      }
    }

    // un scintillement : la note une et deux octaves plus haut, qui naît lentement et vit surtout dans la réverbération
    function shimmer(midi, t, dur, vel) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + dur * .45);
      g.gain.linearRampToValueAtTime(0, t + dur);
      for (const [k, v] of [[12, 1], [24, .45], [19, .25]]) {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = mtof(Math.min(midi + k, 100));
        o.detune.value = (Math.random() * 2 - 1) * 6;
        og.gain.value = v;
        o.connect(og).connect(g);
        o.start(t);
        o.stop(t + dur + .1);
      }
      route(g, 2.4, .15, null, .35);
    }

    // une note à l'envers : elle enfle depuis le silence et s'arrête net, comme aspirée par l'accord suivant
    function reversed(midi, t, dur, vel, p) {
      const g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(p.bright * .4, t);
      lp.frequency.exponentialRampToValueAtTime(p.bright * 2.2, t + dur);
      g.gain.setValueAtTime(.0001, t);
      g.gain.exponentialRampToValueAtTime(vel, t + dur - .07);
      g.gain.linearRampToValueAtTime(0, t + dur);
      for (const [type, det] of [['triangle', -6], ['sine', 6], ['sine', 1200]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = mtof(midi);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + .05);
      }
      lp.connect(g);
      route(g, 1.4);
    }

    // avant le sommet : un souffle qui monte et s'ouvre
    function riser(t, dur, vel) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      s.loop = true;
      f.type = 'bandpass';
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(220, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + dur - .3);
      g.gain.linearRampToValueAtTime(0, t + dur + .5);
      s.connect(f).connect(g);
      route(g, 1.2, 0, 0);
      s.start(t, Math.random());
      s.stop(t + dur + .6);
    }

    // la basse qui pousse : une pulsation ronde, à chaque temps
    function thump(midi, t, vel) {
      const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      o.type = 'triangle';
      o.frequency.value = mtof(midi);
      lp.type = 'lowpass';
      lp.frequency.value = 280;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t + .75);
      o.connect(lp).connect(g);
      route(g, .15, 0, 0);
      o.start(t);
      o.stop(t + .8);
    }

    // la basse : ronde, presque sourde, au centre
    function bassNote(midi, t, dur, vel) {
      const g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 340;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + 1.8);
      g.gain.setTargetAtTime(vel * .7, t + 1.8, dur * .4);
      g.gain.setTargetAtTime(.0001, t + dur - 2, 1.2);
      for (const [type, det, v] of [['sine', 0, 1], ['triangle', 5, .35]]) {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = type;
        o.frequency.value = mtof(midi);
        o.detune.value = det;
        og.gain.value = v;
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(t + dur + 4);
      }
      lp.connect(g);
      route(g, .25, 0, 0);
    }

    // du vent : un souffle filtré qui passe lentement d'un côté à l'autre
    function wind(t, dur, vel) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      s.loop = true;
      f.type = 'bandpass';
      f.Q.value = 2.5;
      f.frequency.setValueAtTime(300 + Math.random() * 300, t);
      for (let x = 1; x <= 4; x++) f.frequency.linearRampToValueAtTime(250 + Math.random() * 1100, t + dur * x / 4);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + dur * .4);
      g.gain.linearRampToValueAtTime(0, t + dur);
      s.connect(f).connect(g);
      route(g, 1, 0, Math.random() * 1.2 - .6);
      s.start(t, Math.random());
      s.stop(t + dur + .1);
    }

    // un souffle qui monte, comme une respiration, pour annoncer la nouvelle ambiance
    function swell(t) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      s.loop = true;
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(180, t);
      f.frequency.exponentialRampToValueAtTime(1600, t + 1.6);
      f.frequency.exponentialRampToValueAtTime(500, t + 3);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(.05, t + 1.4);
      g.gain.linearRampToValueAtTime(0, t + 3);
      s.connect(f).connect(g);
      g.connect(musicBus);
      const send = ctx.createGain();
      send.gain.value = 1;
      g.connect(send).connect(musicRevIn);
      s.start(t, Math.random());
      s.stop(t + 3.1);
    }

    function setDrone(root, fast) {
      const t = ctx.currentTime;
      if (!drone) {
        drone = { gain: ctx.createGain(), oscs: [] };
        drone.gain.gain.value = 0;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 420;
        drone.gain.connect(lp).connect(musicBus);
        for (const [mul, det] of [[.5, 0], [.5, 6], [.75, -4]]) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.detune.value = det;
          o.connect(drone.gain);
          o.start();
          drone.oscs.push({ o, mul });
        }
        drone.gain.gain.setTargetAtTime(params ? params.drone : .07, t, .5);
      }
      // la basse glisse vers la nouvelle tonalité (plus vite lors d'un changement d'ambiance)
      for (const { o, mul } of drone.oscs) o.frequency.setTargetAtTime(mtof(root) * mul, t, fast ? .9 : 2.2);
    }

    /* ── Le chef d'orchestre ── */

    // Une section : une intensité, et les instruments qui jouent. Chaque section s'écarte franchement de la précédente.
    // Les mondes suivent un arc écrit (monter lentement, culminer, retomber) ; un voyage passe d'un monde à l'autre.
    function newSection(p) {
      const r = p.rand;
      if (p.chapters && p.sec && --p.chapterLeft <= 0) enterChapter(p);
      const F = p.F, prev = p.sec ? p.sec.energy : p.energyBase;
      let e;
      if (F.arc) e = clamp(F.arc[p.arcPos++ % F.arc.length] + (r() - .5) * .08, .06, .98);
      else {
        e = clamp(p.energyBase + (r() - .5) * .7, .06, .95);
        if (Math.abs(e - prev) < .2) e = clamp(prev + (e < prev ? -.25 : .25) * (prev > .8 ? -1 : 1), .06, .95);
      }
      const nextE = F.arc ? F.arc[p.arcPos % F.arc.length] : e;
      const rise = F.arpRise && e > .55;
      p.sec = {
        energy: e,
        bass: e > .22 && r() < .85,
        melody: r() < (.25 + e * .8) * (F.melody != null ? F.melody : 1),
        arp: ((p.pulse ? e > .3 : e > .62) || rise) && r() < .85,
        arpShape: rise ? 'up' : pick(r, ['up', 'down', 'updown', 'walk']),
        wind: r() < .3,
        bells: r() < .55 + (1 - e) * .3,
        shimmer: (F.shimmer || 0) * (.4 + e * .8),
        push: !!F.push && e > .68,
        riser: !!F.riser && nextE > e + .1,
        reverse: !!F.reverse && r() < .7
      };
      p.secLeft = p.chapters ? 1 + Math.floor(r() * 2) : 2 + Math.floor(r() * 3);
      // le motif dérive : une note change, ou deux durées s'échangent
      if (r() < .7) {
        const m = p.motif, i = Math.floor(r() * m.length);
        if (r() < .65) m[i].deg = clamp(m[i].deg + pick(r, [-1, 1, -2, 2]), -2, 9);
        else { const j = Math.floor(r() * m.length); [m[i].d, m[j].d] = [m[j].d, m[i].d]; }
      }
      if (drone) drone.gain.gain.setTargetAtTime(p.drone * (.6 + e * .7), ctx.currentTime, 5);
    }

    // un voyage change de monde : nouvel instrument, nouvelle lumière, nouvelle suite d'accords
    function enterChapter(p) {
      const r = p.rand, t = ctx.currentTime;
      p.chapter = (p.chapter + 1) % p.chapters.length;
      const M = p.F = MOODS[p.chapters[p.chapter]];
      p.arcPos = 0;
      p.chapterLeft = M.arc.length;
      p.modeIdx = pick(r, M.modes);
      p.mode = MODES[p.modeIdx];
      p.timbre = pick(r, M.timbres);
      p.T = TIMBRES[p.timbre];
      p.register = pick(r, M.registers);
      p.bright = (900 + r() * 900) * p.T.bright * M.bright;
      p.beat = M.beat * (.9 + r() * .2);
      p.energyBase = M.energy;
      p.drone = M.drone || .07;
      p.chordLen = M.chordLen[0] + r() * (M.chordLen[1] - M.chordLen[0]);
      p.prog = pick(r, M.progs).slice();
      p.step = 0;
      // passer ailleurs, c'est glisser d'une tierce
      if (M.mediant) p.root += pick(r, [4, -4, 3, -3]);
      if (p.root > 57) p.root -= 12;
      if (p.root < 43) p.root += 12;
      setEcho(p.beat);
      setDrone(p.root - 12, false);
      swell(t + .2);
    }

    // à la fin d'un tour de la suite d'accords : un accord change, et parfois la tonalité s'en va ailleurs
    function newCycle(p, t) {
      const r = p.rand, F = p.F;
      p.step = 0;
      p.cycle++;
      const another = () => F.progs ? pick(r, pick(r, F.progs)) % p.mode.length : makeProg(r, p.mode.length)[1];
      if (r() < .55) {
        const i = 1 + Math.floor(r() * (p.prog.length - 1));
        const d = another();
        if (d !== p.prog[i - 1] && d !== p.prog[i + 1]) p.prog[i] = d;
      }
      const extra = another();
      if (r() < .2 && p.prog.length < 6 && extra !== p.prog[p.prog.length - 1] && extra !== p.prog[0]) p.prog.push(extra);
      if (F.mediant && p.cycle >= 1 && r() < .4) {
        // ailleurs : la tonalité glisse d'une tierce, lumineuse et étrange à la fois
        p.root += pick(r, [4, -4, 3, -3, 8]);
        if (p.root > 57) p.root -= 12;
        if (p.root < 43) p.root += 12;
        p.cycle = 0;
        setDrone(p.root - 12, false);
        const s = Math.max(t - 3, ctx.currentTime + .05);
        if (t - s > .8) reversed(p.note(4) + p.register + 24, s, t - s, .03, p);
      } else if (p.cycle >= 2 && r() < .3) {
        if (r() < .6) {
          p.root += pick(r, [5, 7, -5, -7, 2, -2]);
          if (p.root > 57) p.root -= 12;
          if (p.root < 43) p.root += 12;
        } else {
          p.modeIdx = pick(r, MODE_NEAR[p.modeIdx]);
          p.mode = MODES[p.modeIdx];
          p.prog = p.prog.map(d => d % p.mode.length).filter((d, i, a) => i === 0 || d !== a[i - 1]);
        }
        p.cycle = 0;
        setDrone(p.root - 12, false);
        bell(p.note(4) + p.register + 12, t + .4, .03, .4);
      }
    }

    // les notes de l'accord, posées au plus près de l'accord précédent (comme le ferait une main sur un clavier)
    // mid : la fondamentale d'un accord majeur venu d'ailleurs (hors de la gamme)
    function voice(p, deg, e, mid) {
      const F = p.F, center = 60 + p.register, prev = p.voicing;
      let pitches;
      if (mid != null) pitches = [0, 4, 7, 14].map(i => mid + i);
      else {
        let shape = e < .3 ? [0, 4, 7] : e < .65 ? [0, 2, 4] : [0, 2, 4, 6];
        if (F.shapes) shape = pick(p.rand, F.shapes);
        // dans les modes majeurs, une 9e de temps en temps : la couleur de l'espoir
        else if ((p.modeIdx === 7 || p.modeIdx === 1) && e >= .3 && p.rand() < .4) shape = [0, 2, 4, 8];
        pitches = shape.map(s => p.note(deg + s));
      }
      let tones = pitches.map(x => {
        let m = x + p.register + 12;
        const target = prev ? prev.reduce((a, b) => Math.abs(b - m) < Math.abs(a - m) ? b : a) : center;
        while (m - target > 6) m -= 12;
        while (target - m > 6) m += 12;
        return clamp(m, 40, 86);
      });
      tones = [...new Set(tones)].sort((a, b) => a - b);
      p.voicing = tones;
      // au sommet d'un monde, l'accord s'élargit vers le haut
      if (F.shapes && e > .8) tones = tones.concat(tones.slice(1, 3).map(m => m + 12).filter(m => m <= 90));
      return tones;
    }

    function chordAt(p, t) {
      let c = p.chords[0];
      for (const x of p.chords) if (x.t <= t) c = x;
      return c;
    }

    function nextChord(p, t, first) {
      const r = p.rand;
      if (p.secLeft <= 0) newSection(p);
      p.secLeft--;
      if (p.step >= p.prog.length) newCycle(p, t);
      const deg = p.prog[p.step++], S = p.sec, e = S.energy, beat = p.beat;
      const len = p.chordLen * (.85 + r() * .3), F = p.F;
      const mid = !first && F.mediant && r() < F.mediant ? p.root + pick(r, [4, 8, -4, 3]) : null;
      const tones = voice(p, deg, e, mid);
      p.chords.push({ t, tones, deg });
      if (p.chords.length > 4) p.chords.shift();
      // la nappe, notes égrenées
      const pv = (.024 + e * .012) * p.T.gain * p.vel;
      tones.forEach((m, i) => pad(m, t + (first ? i * .1 : i * (.08 + r() * .3)), len + 5, pv * (i === 0 ? 1.1 : 1), p, first ? .6 : null));
      // la basse
      let b = (mid != null ? mid : p.note(deg)) + p.register - 12;
      while (b > 50) b -= 12;
      while (b < 33) b += 12;
      if (S.bass) {
        bassNote(b, t + .2, len + 1, .07 * p.vel);
        if (e > .55 && r() < .5) bassNote(b + 7, t + len * .55, len * .45 + 1, .035 * p.vel);
      }
      // la mélodie : le motif varié, et parfois sa réponse
      if (S.melody && !first && mid == null && r() < .45 + e * .5) {
        let at = t + beat * (1 + Math.floor(r() * 3));
        const end = t + len - 1;
        let phrase = varyMotif(p.motif, r, e), answer = false;
        while (phrase) {
          let lastMidi = null;
          for (const n of phrase) {
            if (at + n.d * beat > end) break;
            let m = p.note(deg + n.deg) + p.register + 12;
            while (m > 86) m -= 12;
            while (m < 57) m += 12;
            if (lastMidi != null && Math.abs(m - lastMidi) > 9) m += m > lastMidi ? -12 : 12;
            lastMidi = m;
            const jit = (r() - .5) * .04;
            lead(m, at + jit, n.d * beat * .92, (.045 + r() * .015) * p.vel * (1 - .15 * answer), p);
            at += n.d * beat;
          }
          at += beat * (2 + Math.floor(r() * 3));
          phrase = !answer && at + 4 * beat < end && r() < .55 ? varyMotif(p.motif, r, e) : null;
          answer = true;
        }
      }
      // l'arpège : il gonfle puis s'efface sur la durée de l'accord
      if (S.arp) {
        const step = p.pulse ? p.pulse : beat / 2;
        let notes = tones.concat(tones.map(m => m + 12));
        if (F.arpRise && e > .7) notes = notes.concat(tones.map(m => m + 24));
        notes = notes.filter(m => m <= 98);
        const n = Math.floor((len - .5) / step);
        let i = S.arpShape === 'down' ? notes.length - 1 : 0, dir = S.arpShape === 'down' ? -1 : 1;
        for (let k = 0; k < n; k++) {
          const tt = t + .3 + k * step * (1 + (r() - .5) * .06), arc = Math.sin(Math.PI * (k + .5) / n);
          if (r() < .12) continue;   // quelques silences, pour respirer
          pluck(notes[i], tt, (.012 + .03 * arc) * p.vel, p.bright);
          if (S.arpShape === 'walk') i = clamp(i + pick(r, [-1, 1, 1, 2, -2]), 0, notes.length - 1);
          else if (S.arpShape === 'updown') { if (i + dir < 0 || i + dir >= notes.length) dir = -dir; i += dir; }
          else i = (i + dir + notes.length) % notes.length;
        }
      }
      if (S.wind && r() < .6) wind(t + r() * 3, len * (.6 + r() * .5), .012 + e * .01);
      // le scintillement au-dessus de l'accord
      if (S.shimmer > .05) tones.slice(-2).forEach((m, i) => shimmer(m, t + 1 + i * .7, len + 4, pv * S.shimmer * .9));
      // la basse qui pousse, temps après temps
      if (S.push) {
        const n = Math.floor((len - .5) / beat);
        for (let k = 0; k < n; k++) if (r() > .08) thump(b, t + k * beat, (.02 + .03 * Math.sin(Math.PI * (k + .5) / n)) * p.vel);
      }
      // juste avant le sommet, un souffle qui monte
      if (S.riser && p.secLeft === 0) riser(t + len * .35, len * .65, .03);
      // une note à l'envers, aspirée par l'accord suivant
      if (S.reverse && !first && r() < .55) reversed(Math.min(tones[tones.length - 1] + 12, 90), t + len - 3.5, 3.5, pv * 1.3, p);
      p.nextChord = t + len;
    }

    function schedule() {
      if (!ctx || !params || !gen) return;
      const now = ctx.currentTime, ahead = now + 1, p = params;
      if (p.nextChord < now - 2) p.nextChord = now + .1;   // après une longue pause
      while (p.nextChord < ahead) nextChord(p, p.nextChord, false);
      // les boucles à la Eno, sur les notes de l'accord en cours
      for (const v of voices) {
        while (v.next < ahead) {
          if (v.next > now - .2) {
            const c = chordAt(p, v.next), S = p.sec;
            if (c && S) {
              const m = c.tones[v.tone % c.tones.length] + v.oct;
              if (v.bell) { if (S.bells) bell(m - 12, v.next, v.vel * .55, .25); }
              else if (r01() < .35 + (1 - S.energy) * .5) pad(clamp(m, 48, 88), v.next, v.dur, v.vel, p);
            }
          }
          v.next += v.period * (.9 + r01() * .2);
        }
      }
    }
    const r01 = Math.random;

    function startMusic() {
      if (!ctx || timer) return;
      gen = newGen(0);
      timer = setInterval(schedule, 250);
      if (seedKey) applySeed(seedKey, true);
    }

    function stopMusic() {
      if (musicOn) return;
      clearInterval(timer);
      timer = null;
      if (gen) { retire(gen, .1); gen = null; }
      voices = [];
    }

    function setEcho(beat) {
      const t = ctx.currentTime;
      musicEcho.l.delayTime.setTargetAtTime(beat * .75, t, .4);
      musicEcho.r.delayTime.setTargetAtTime(beat * .75, t, .4);
    }

    function applySeed(key, first) {
      const prev = params;
      params = paramsFor(key, first ? null : prev, seedMood);
      const p = params, now = ctx.currentTime;
      setEcho(p.beat);
      newSection(p);
      if (first) {
        // au lancement, la musique doit s'entendre en moins d'une seconde : un accord s'ouvre tout de suite
        nextChord(p, now + .03, true);
        voices = p.loops.map((l, i) => Object.assign({}, l, { next: now + 3 + i * (1.2 + p.rand() * 2.5) }));
        setDrone(p.root - 12, false);
        return;
      }
      // changement d'ambiance : l'ancienne s'efface, un souffle monte, puis l'accord de la nouvelle s'ouvre
      retire(gen, 2.6);
      gen = newGen(.8);
      swell(now);
      nextChord(p, now + .5, true);
      bell(p.note(4) + p.register, now + 1.1, .04, .3);
      setDrone(p.root - 12, true);
      drone.gain.gain.setTargetAtTime(p.drone, now, 1.5);
      // les boucles reprennent après l'accord
      voices = p.loops.map((l, i) => Object.assign({}, l, { next: now + 4.5 + i * (1.5 + p.rand() * 3) }));
    }

    // graine de l'espace, ou de la carte ouverte
    function seed(key, mood) {
      const full = key + (mood ? '|' + mood : '');
      if (full === seedKey) return;
      seedKey = full;
      seedMood = mood || null;
      if (ctx && timer && gen) applySeed(full, false);
    }

    function setPrefs(p) {
      Object.assign(prefs(), p);
      if (!READONLY) persist();
      if (prefs().music || prefs().sfx) unlock();
      applyPrefs();
    }

    /*
     * Sur iPad, quitter l'app coupe le son de la page, et iOS ne le rend pas toujours au retour : le moteur se dit « en
     * marche » mais reste muet. On l'éteint donc entièrement en partant, et on le recrée au premier toucher du retour
     * (pendant un geste, le seul moment où iOS l'accepte à coup sûr) : même musique, même ambiance.
     */
    let pendingAmb = null;
    function duck(level) { if (ctx && duckBus) duckBus.gain.setTargetAtTime(level, ctx.currentTime, .16); }
    const vox = {
      decode: bytes => { unlock(); return ctx.decodeAudioData(bytes); },
      // rend l'instant (sur l'horloge du son) où le vocal aurait commencé
      play(buf, from, onEnd) {
        unlock();
        vox.stop();
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(voiceBus);
        s.onended = () => { if (voiceSrc === s) { voiceSrc = null; duck(1); onEnd(); } };
        s.start(0, from);
        voiceSrc = s;
        duck(.3);     // la musique s'efface un peu, la voix passe devant
        return ctx.currentTime - from;
      },
      stop() { if (voiceSrc) { const s = voiceSrc; voiceSrc = null; try { s.stop(); } catch (e) { /* déjà fini */ } duck(1); } },
      now: () => ctx ? ctx.currentTime : 0
    };
    const reset = () => { if (ctx) sleepAudio(); };
    // le micro est ouvert : plus aucun son de la page, sinon iOS interrompt l'enregistrement (au premier toucher qui relance le son)
    const hush = on => { hushed = on; if (on && TOUCH) reset(); };
    const hushing = () => hushed;
    function sleepAudio() {
      const old = ctx;
      alog('départ : son éteint');
      pendingAmb = amb ? amb.kind : null;
      clearInterval(timer);
      clearTimeout(stopTimer);
      if (amb) { try { amb.halt(); amb.stop(); } catch (e) { /* déjà arrêtée */ } }
      voiceSrc = null;
      ctx = null; drone = null; gen = null; timer = null; voices = []; musicOn = false; started = false; amb = null; ambBufs = null;
      for (const k of Object.keys(fxBuses)) delete fxBuses[k];
      try { old.close(); } catch (e) { /* tant pis */ }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) persist(true);   // l'app part à l'arrière-plan : rien ne reste en attente
      alog(document.hidden ? 'app quittée' : 'retour dans l\'app');
      if (!document.hidden && !ctx && NATIVE && window.__PLATFORM) askOther();
      if (!ctx) return;
      // (sur iPad, même au retour : si le départ n'a pas été vu, le vieux moteur muet est remplacé au premier toucher)
      if (TOUCH) sleepAudio();
      else if (document.hidden) ctx.suspend();
      else ctx.resume().catch(() => {});
    });

    /* ── Bruitages de l'écriture et de l'interface (accordés sur l'ambiance en cours) ── */

    const ok = () => !!ctx && prefs().sfx && ctx.state === 'running';
    const lastFx = {};
    const every = (name, ms) => {
      const n = performance.now();
      if (n - (lastFx[name] || 0) < ms) return false;
      lastFx[name] = n;
      return true;
    };
    // une note de la gamme de l'ambiance (ou une pentatonique douce si la musique est coupée)
    const keyNote = deg => {
      if (params) return params.note(deg) + (params.register < 0 ? 12 : 0);
      const pen = [0, 2, 4, 7, 9];
      return 57 + pen[((deg % 5) + 5) % 5] + 12 * Math.floor(deg / 5);
    };

    function tone(midi, t, vel, dur, type = 'sine', rev = .4) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.value = mtof(midi);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + .008);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g);
      g.connect(fx.dry);
      if (rev) { const s = ctx.createGain(); s.gain.value = rev; g.connect(s).connect(fx.rev); }
      o.start(t);
      o.stop(t + dur + .05);
    }

    function breath(t, type, freq, q, vel, attack, dur) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise;
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + attack);
      g.gain.exponentialRampToValueAtTime(.0001, t + attack + dur);
      s.connect(f).connect(g).connect(fx.dry);
      s.start(t, Math.random() * 1.5);
      s.stop(t + attack + dur + .05);
    }

    // 1. un mot écrit : une plume sur du papier
    function word() {
      if (!ok() || !every('word', 90)) return;
      breath(ctx.currentTime, 'bandpass', 1100 + Math.random() * 900, .7, .035, .006, .07);
    }

    // 2. retour à la ligne : une note grave et ronde
    function newline() {
      if (!ok() || !every('newline', 60)) return;
      let m = keyNote(0);
      while (m > 52) m -= 12;
      tone(m, ctx.currentTime, .09, .55, 'sine', .25);
    }

    // 3. enregistré : un souffle presque imperceptible
    function saved() {
      if (!ok() || !every('saved', 6000)) return;
      breath(ctx.currentTime, 'lowpass', 520, .3, .022, .18, .5);
    }

    // 4. survol d'une carte : un frôlement de papier
    function brush() {
      if (!ok() || !every('brush', 70)) return;
      breath(ctx.currentTime, 'highpass', 5200 + Math.random() * 1500, .5, .028, .004, .045);
    }

    // 5. la roue s'arrête sur une carte : une note cristalline
    function chime(i) {
      if (!ok() || !every('chime', 250)) return;
      const t = ctx.currentTime, m = keyNote(2 + (i % 5)) + 12;
      tone(m, t, .05, 3, 'sine', 1);
      tone(m + 12, t, .012, 1.6, 'sine', 1);
    }

    // 6. création : trois notes qui montent
    function create() {
      if (!ok() || !every('create', 300)) return;
      const t = ctx.currentTime;
      [0, 2, 4].forEach((d, k) => tone(keyNote(d) + 12, t + k * .09, .05, 1.3, 'triangle', .5));
    }

    // 7. suppression : un « pouf » étouffé qui descend
    function remove() {
      if (!ok()) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = 'sine';
      o.frequency.setValueAtTime(240, t);
      o.frequency.exponentialRampToValueAtTime(70, t + .3);
      f.type = 'lowpass';
      f.frequency.value = 500;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(.16, t + .01);
      g.gain.exponentialRampToValueAtTime(.0001, t + .38);
      o.connect(f).connect(g).connect(fx.dry);
      o.start(t);
      o.stop(t + .42);
      breath(t, 'lowpass', 340, .5, .07, .005, .25);
    }

    // 8. ouverture d'un menu : un « pop » ; déplacement dans la liste : un clic doux
    function pop() {
      if (!ok()) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(520, t);
      o.frequency.exponentialRampToValueAtTime(980, t + .06);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(.07, t + .005);
      g.gain.exponentialRampToValueAtTime(.0001, t + .12);
      o.connect(g).connect(fx.dry);
      o.start(t);
      o.stop(t + .14);
    }
    function nav() {
      if (!ok() || !every('nav', 30)) return;
      tone(96, ctx.currentTime, .022, .035, 'sine', 0);
    }

    // 9. tâche cochée : « tic » puis une note plus aiguë ; décochée : une seule note plus grave
    function check(done) {
      if (!ok()) return;
      const t = ctx.currentTime;
      if (done) {
        breath(t, 'bandpass', 3800, 2, .05, .001, .025);
        tone(keyNote(4) + 12, t + .02, .055, .35, 'triangle', .2);
        tone(keyNote(7) + 12, t + .09, .05, .6, 'triangle', .3);
      } else tone(keyNote(2) + 12, t, .04, .3, 'triangle', .1);
    }

    // 10. nouvelle couleur : un accord, chaud ou froid selon la teinte
    function colorChord(mood) {
      if (!ok()) return;
      const t = ctx.currentTime + .02;
      const intervals = mood === 'chaud' ? [0, 4, 7, 11] : mood === 'froid' ? [0, 2, 7, 14]
        : mood === 'sombre' ? [-12, 0, 3, 7] : mood === 'clair' ? [0, 7, 12, 16] : [0, 7, 12];
      const root = keyNote(0);
      intervals.forEach((iv, k) => tone(root + iv, t + k * .06, .045, 2.4, 'triangle', .8));
    }

    const running = () => !!ctx && ctx.state === 'running';
    const fxs = { tick, drop, woosh, word, newline, saved, brush, chime, create, remove, pop, nav, check, colorChord };
    for (const k of Object.keys(fxs)) fxs[k] = routed(k, fxs[k]);
    /*
     * Paysage sonore d'une météo. Deux règles : rien d'agressif (attaques douces, aigus filtrés,
     * un limiteur sur l'ensemble) et rien qui se répète (bruits longs lus à des vitesses différentes,
     * dérives aléatoires plutôt qu'oscillations régulières, événements au hasard, par vagues et accalmies).
     */
    let amb = null, ambBufs = null;
    // des bruits longs, de durées sans commune mesure : leurs boucles ne retombent jamais ensemble
    function ambNoise() {
      if (ambBufs) return ambBufs;
      const make = (secs, kind) => {
        const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          if (kind === 'pink') {
            // bruit rose (filtre de Kellet) : plus doux que le bruit blanc, comme la pluie ou le vent
            b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852;
            b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362) * .11; b6 = w * .115926;
          } else { last = (last + .02 * w) / 1.02; d[i] = last * 3.5; } // bruit brun : un grondement
        }
        // on fond la fin dans le début : la boucle ne claque pas
        const fade = Math.floor(ctx.sampleRate * .25);
        for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = d[i] * k + d[len - fade + i] * (1 - k); }
        return b;
      };
      ambBufs = { pink: [make(13.7, 'pink'), make(17.3, 'pink')], brown: make(11.9, 'brown') };
      return ambBufs;
    }

    function ambience(kind) {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (amb) { const a = amb; a.g.gain.setTargetAtTime(0, t, .7); a.halt(); setTimeout(a.stop, 4000); amb = null; }
      if (!kind) return;
      const N = ambNoise();
      // le chemin de sortie : un filtre qui retire les aigus durs, puis un limiteur qui écrase les pics
      const g = ctx.createGain(), soft = ctx.createBiquadFilter(), comp = ctx.createDynamicsCompressor();
      g.gain.value = 0;
      soft.type = 'lowpass'; soft.frequency.value = 6500; soft.Q.value = .4;
      comp.threshold.value = -26; comp.knee.value = 18; comp.ratio.value = 3.5; comp.attack.value = .02; comp.release.value = .4;
      g.connect(soft).connect(comp).connect(musicBus);
      const srcs = [], timers = [];
      let live = true;
      const R = (a, b) => a + Math.random() * (b - a);
      const later = (fn, ms) => timers.push(setTimeout(() => { if (live) fn(); }, ms));
      // une valeur qui dérive au hasard, sans période : à chaque fois une nouvelle cible, un nouveau temps
      const wander = (param, base, depth, minS = 2.5, maxS = 9) => {
        const step = () => {
          if (ctx.state === 'running') param.setTargetAtTime(Math.max(0, base * (1 + R(-depth, depth))), ctx.currentTime, R(minS, maxS) / 2.5);
          later(step, R(minS, maxS) * 1000);
        };
        step();
      };
      // l'animation générale de la scène : par moments plus d'activité, par moments presque rien
      let activity = 1;
      const breathe = () => { activity = Math.max(.25, Math.min(1.6, activity + R(-.45, .45))); later(breathe, R(3000, 9000)); };
      breathe();
      // un bruit filtré qui vit : son niveau et sa couleur dérivent lentement
      const bed = ({ buf = 'pink', type = 'lowpass', freq = 800, q = .5, level = .3, depth = .35, fdepth = .15 }) => {
        const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), lg = ctx.createGain();
        s.buffer = buf === 'brown' ? N.brown : N.pink[Math.floor(Math.random() * 2)];
        s.loop = true;
        s.playbackRate.value = R(.9, 1.1);
        f.type = type; f.frequency.value = freq; f.Q.value = q;
        lg.gain.value = level;
        s.connect(f).connect(lg).connect(g);
        s.start(t, R(0, s.buffer.duration));
        srcs.push(s);
        wander(lg.gain, level, depth);
        if (fdepth) wander(f.frequency, freq, fdepth, 4, 14);
        wander(s.playbackRate, 1, .06, 8, 20);
        return { f, lg };
      };
      // un son placé dans l'espace, de gauche à droite
      const out = pan => {
        if (pan == null || !ctx.createStereoPanner || prefs().spatial === false) return g;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        p.connect(g);
        return p;
      };
      // un grain de bruit (goutte, feuille, crépitement) : jamais d'attaque sèche
      const burst = (at, { type = 'bandpass', freq = 1000, q = 1, dur = .2, level = .05, attack = .01, pan = null, sweep = null }) => {
        const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), e = ctx.createGain();
        s.buffer = N.pink[0];
        f.type = type; f.frequency.setValueAtTime(freq, at); f.Q.value = q;
        if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, at + dur);
        e.gain.setValueAtTime(0, at);
        e.gain.linearRampToValueAtTime(level, at + Math.max(.004, attack));
        e.gain.exponentialRampToValueAtTime(.0001, at + dur + attack);
        s.connect(f).connect(e).connect(out(pan));
        s.start(at, R(0, 12)); s.stop(at + dur + attack + .05);
      };
      // une note douce : elle naît en quelques centièmes de seconde, sans clic
      const ping = (at, freq, dur, level, pan = null, attack = .04) => {
        const o = ctx.createOscillator(), e = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq * (1 + R(-.004, .004));
        e.gain.setValueAtTime(0, at);
        e.gain.linearRampToValueAtTime(level, at + attack);
        e.gain.setTargetAtTime(0, at + attack, dur / 4);
        o.connect(e).connect(out(pan));
        o.start(at); o.stop(at + attack + dur + .1);
      };
      // des événements au hasard (loi de Poisson), plus serrés quand la scène s'anime, avec de vraies accalmies
      const scatter = (meanMs, fn, minMs = 25) => {
        const go = () => {
          if (ctx.state === 'running') fn(ctx.currentTime + .03);
          later(go, Math.max(minMs, -Math.log(1 - Math.random()) * meanMs / activity));
        };
        later(go, R(200, meanMs * 2));
      };
      // une gamme pentatonique dans une tonalité tirée au hasard ; on y marche sans rejouer la même note
      const walker = (lo, hi) => {
        const root = lo * Math.pow(2, Math.floor(R(0, 12)) / 12), steps = [0, 2, 4, 7, 9];
        const notes = [];
        for (let o = 0; o < 4; o++) for (const s of steps) { const f = root * Math.pow(2, o + s / 12); if (f >= lo && f <= hi) notes.push(f); }
        let i = Math.floor(R(0, notes.length));
        return () => { i = Math.max(0, Math.min(notes.length - 1, i + [-2, -1, 1, 2][Math.floor(R(0, 4))])); return notes[i]; };
      };
      const pan = () => R(-.75, .75);
      let level = .32, onGust = null;

      if (kind === 'pluie' || kind === 'orage') {
        const storm = kind === 'orage';
        bed({ type: 'lowpass', freq: 2200, q: .3, level: storm ? .55 : .45, depth: .3 });
        bed({ buf: 'brown', type: 'lowpass', freq: 600, level: storm ? .4 : .3, depth: .4 });
        if (storm) bed({ buf: 'brown', type: 'lowpass', freq: 120, q: .6, level: .28, depth: .6, fdepth: .3 });
        // des gouttes qui tombent près de soi, ici et là
        scatter(storm ? 120 : 170, at => burst(at, { freq: R(900, 2600), q: R(2, 5), dur: R(.03, .07), level: R(.01, .035), attack: .008, pan: pan() }));
        level = storm ? .36 : .32;
      } else if (kind === 'neige') {
        bed({ buf: 'brown', type: 'lowpass', freq: 380, level: .35, depth: .35 });
        bed({ type: 'bandpass', freq: 900, q: .4, level: .05, depth: .5 });
      } else if (kind === 'brume') {
        bed({ type: 'bandpass', freq: 260, q: .7, level: .4, depth: .4, fdepth: .25 });
        bed({ buf: 'brown', type: 'lowpass', freq: 140, level: .25, depth: .5 });
      } else if (kind === 'lucioles') {
        // la nuit très calme, et des notes de verre qui s'allument comme les lucioles
        bed({ buf: 'brown', type: 'lowpass', freq: 320, level: .18, depth: .4 });
        const note = walker(620, 1500);
        scatter(2600, at => { const p = pan(), n = Math.random() < .25 ? 2 : 1; for (let k = 0; k < n; k++) ping(at + k * R(.2, .6), note(), R(1.4, 3), R(.014, .03), p, R(.04, .09)); }, 600);
        level = .8;
      } else if (kind === 'feuilles') {
        // le vent dans les arbres, et des froissements de feuilles quand il se lève
        const wind = bed({ type: 'bandpass', freq: 520, q: .6, level: .45, depth: .55, fdepth: .3 });
        bed({ buf: 'brown', type: 'lowpass', freq: 260, level: .25, depth: .4 });
        scatter(700, at => {
          const p = pan(), n = 1 + Math.floor(R(0, 4 * Math.min(1.4, wind.lg.gain.value / .45)));
          for (let k = 0; k < n; k++) burst(at + k * R(.03, .11), { freq: R(1500, 3200), q: .8, dur: R(.05, .15), level: R(.015, .045), attack: .012, pan: p + R(-.1, .1) });
        }, 120);
      } else if (kind === 'petales') {
        // une brise douce et un carillon à vent, jamais la même suite de notes
        bed({ type: 'lowpass', freq: 700, q: .3, level: .35, depth: .45 });
        const note = walker(880, 2400);
        scatter(3200, at => {
          const n = 1 + Math.floor(R(0, 3.5)), p = pan();
          let x = at;
          for (let k = 0; k < n; k++) { ping(x, note(), R(2.5, 5), R(.013, .026), p + R(-.15, .15), .015); x += R(.1, .45); }
        }, 900);
        level = .5;
      } else if (kind === 'aurore') {
        // une nappe de verre presque immobile : ses notes changent une à une, au hasard, très lentement
        const note = walker(200, 700);
        const voice = () => {
          const o = ctx.createOscillator(), e = ctx.createGain();
          o.type = 'sine'; o.frequency.value = note();
          e.gain.value = 0;
          o.connect(e).connect(g);
          o.start(ctx.currentTime);
          srcs.push(o);
          e.gain.setTargetAtTime(R(.01, .018), ctx.currentTime, R(3, 6));
          wander(e.gain, .014, .5, 4, 12);
          wander(o.detune, 1, 6, 6, 18);
          return { o, e };
        };
        const voices = [voice(), voice(), voice(), voice()];
        const change = () => {
          const v = voices[Math.floor(R(0, voices.length))];
          v.o.frequency.setTargetAtTime(note(), ctx.currentTime, R(2, 5));
          later(change, R(14000, 40000));
        };
        later(change, R(10000, 25000));
        bed({ type: 'bandpass', freq: 2400, q: 1, level: .015, depth: .6 });
        const spark = walker(1100, 2600);
        scatter(5500, at => ping(at, spark(), R(1.2, 2.4), R(.006, .012), pan(), .06), 1500);
        level = .9;
      } else if (kind === 'desert') {
        // un vent sec, du sable qui siffle doucement, et des rafales qui balayent l'espace comme la poussière à l'écran
        bed({ type: 'bandpass', freq: 650, q: .8, level: .4, depth: .5, fdepth: .35 });
        bed({ type: 'bandpass', freq: 2600, q: .6, level: .05, depth: .6 });
        onGust = at => {
          const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), e = ctx.createGain(), dur = R(2.5, 4.5), dir = Math.random() < .5 ? -1 : 1;
          s.buffer = N.pink[1]; s.loop = true;
          f.type = 'bandpass'; f.Q.value = R(.8, 1.3);
          f.frequency.setValueAtTime(R(260, 340), at); f.frequency.exponentialRampToValueAtTime(R(900, 1400), at + dur * R(.35, .5)); f.frequency.exponentialRampToValueAtTime(R(320, 420), at + dur);
          e.gain.setValueAtTime(0, at); e.gain.linearRampToValueAtTime(R(.2, .28), at + dur * .4); e.gain.linearRampToValueAtTime(0, at + dur);
          let node = s.connect(f).connect(e);
          if (ctx.createStereoPanner && prefs().spatial !== false) {
            const p = ctx.createStereoPanner();
            p.pan.setValueAtTime(-.8 * dir, at); p.pan.linearRampToValueAtTime(.8 * dir, at + dur);
            node = node.connect(p);
          }
          node.connect(g);
          s.start(at, R(0, 15)); s.stop(at + dur + .1);
        };
        level = .36;
      } else if (kind === 'feu') {
        // le grondement sourd des flammes, et le bois qui crépite, par salves irrégulières
        bed({ buf: 'brown', type: 'lowpass', freq: 170, q: .5, level: .5, depth: .4 });
        bed({ type: 'bandpass', freq: 420, q: .4, level: .13, depth: .55, fdepth: .3 });
        scatter(150, at => burst(at, { freq: R(1200, 3200), q: R(1.5, 3), dur: R(.008, .03), level: R(.008, .04), attack: .003, pan: R(-.4, .4) }), 20);
        scatter(5000, at => burst(at, { freq: R(500, 1000), q: 1, dur: R(.05, .09), level: R(.05, .08), attack: .005, pan: R(-.4, .4) }), 1500);
        level = .4;
      }
      g.gain.setTargetAtTime(level, t, 1.5);
      const halt = () => { live = false; for (const x of timers) clearTimeout(x); };
      amb = { kind, g, halt, onGust, stop: () => { halt(); for (const s of srcs) { try { s.stop(); } catch (e) { /* déjà arrêté */ } } g.disconnect(); soft.disconnect(); comp.disconnect(); } };
    }

    // une rafale visible à l'écran : on l'entend passer en même temps
    function gust() {
      if (ctx && amb && amb.onGust && ctx.state === 'running') amb.onGust(ctx.currentTime + .02);
    }

    // le tonnerre d'un éclair : un roulement sourd, jamais un claquement, d'autant plus tardif et grave que l'orage est loin
    function thunder(near) {
      if (!ctx || !amb || amb.kind !== 'orage') return;
      const R = (a, b) => a + Math.random() * (b - a);
      const t0 = ctx.currentTime + .25 + (1 - near) * 2.4, n = 2 + Math.floor(R(0, 3));
      for (let k = 0; k < n; k++) {
        // plusieurs grondements qui se chevauchent, chacun différent
        const t = t0 + (k ? R(.3, 1.6) * k : 0), dur = R(2.5, 4) + (1 - near) * 2.5, peak = (k ? R(.35, .7) : 1) * (.32 + near * .38);
        const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), e = ctx.createGain();
        s.buffer = ambNoise().brown; s.loop = true;
        f.type = 'lowpass';
        f.frequency.setValueAtTime((near > .65 ? 650 : 380) * R(.8, 1.15), t);
        f.frequency.exponentialRampToValueAtTime(R(50, 75), t + dur);
        e.gain.setValueAtTime(0, t);
        e.gain.linearRampToValueAtTime(peak, t + .12 + (1 - near) * .45);
        e.gain.setTargetAtTime(peak * .5, t + .5, .5);
        e.gain.setTargetAtTime(0, t + 1.3, dur / 4);
        s.connect(f).connect(e).connect(amb.g);
        s.start(t, R(0, 10));
        s.stop(t + dur + 2);
      }
    }

    // position de l'interaction à l'écran : les bruitages viennent de là, de gauche à droite
    let panX = .5;
    const at = x => { panX = Math.max(0, Math.min(1, x / innerWidth)); };

    return Object.assign({ voice: vox, duck, reset, hush, hushing, unlock, seed, setPrefs, prefs, running, ambience, thunder, gust, at }, fxs);
  })();

  function bindSound() {
    // iOS n'autorise le son qu'au cours de certains gestes (le relâché d'un toucher, un clic) : on essaie à chacun
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, () => sound.unlock(), { capture: true, passive: true });
    // le son suit la main : chaque geste place les bruitages à gauche ou à droite
    for (const type of ['pointermove', 'pointerdown']) document.addEventListener(type, e => { if (!ink.stroke) sound.at(e.clientX); }, { capture: true, passive: true });
    edBody().addEventListener('input', () => {
      if (PHONE) return;
      const s = document.getSelection();
      const r = s.rangeCount ? s.getRangeAt(0).getClientRects()[0] : null;
      if (r) sound.at(r.left);
    });
    $('#sndSpatial').addEventListener('change', e => { sound.setPrefs({ spatial: e.target.checked }); });
    // l'écriture : une plume à chaque mot, une note grave à chaque retour à la ligne
    edBody().addEventListener('input', e => {
      if (e.inputType === 'insertText' && e.data && /[\s.,;:!?]$/.test(e.data)) sound.word();
    });
    edBody().addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !READONLY) sound.newline();
    });
    const pop = $('#soundPop');
    const paint = () => {
      const p = sound.prefs();
      $('#sndMusic').checked = p.music;
      $('#sndSfx').checked = p.sfx;
      $('#sndSpatial').checked = p.spatial !== false;
      $('#sndVol').value = Math.round(p.volume * 100);
      paintRange($('#sndVol'));
      $('#soundBtn').classList.toggle('muted', !p.music && !p.sfx);
    };
    $('#soundBtn').addEventListener('click', e => {
      e.stopPropagation();
      paint();
      pop.hidden = !pop.hidden;
    });
    $('#sndMusic').addEventListener('change', e => { sound.setPrefs({ music: e.target.checked }); paint(); });
    $('#sndSfx').addEventListener('change', e => { sound.setPrefs({ sfx: e.target.checked }); paint(); });
    $('#sndVol').addEventListener('input', e => sound.setPrefs({ volume: e.target.value / 100 }));
    document.addEventListener('mousedown', e => { if (!e.target.closest('#soundPop, #soundBtn')) pop.hidden = true; });
    paint();
  }

  /* ───────────── Vent : l'image qui accompagne le « woosh » ───────────── */

  const wind = (() => {
    let cv, g, parts = [], raf = 0, t0 = 0, life = 0, dir = 1, rgb = '60,58,52', band = null, dpr = 1;

    function gust(seconds = .8, direction = 1) {
      cv = cv || $('#wind');
      g = g || cv.getContext('2d');
      // le vent n'a pas besoin de la pleine définition de l'écran : sur iPhone, 3× coûte cher pour de simples filets d'air
      const W = innerWidth, H = innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== W * dpr || cv.height !== H * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      rgb = getComputedStyle(document.body).getPropertyValue('--wind-rgb').trim() || '60,58,52';
      dir = direction;
      life = seconds * 1000 + 600;
      t0 = performance.now();
      band = { from: dir > 0 ? -W * .5 : W * 1.5, to: dir > 0 ? W * 1.5 : -W * .5 };
      // des filets d'air fins et ondulants qui traversent l'écran
      for (let i = 0; i < (PHONE ? 36 : 64); i++) {
        parts.push({
          t0, life,
          y: H * (.08 + Math.random() * .84),
          x: dir > 0 ? -Math.random() * W * .5 : W + Math.random() * W * .5,
          len: 70 + Math.random() * 260,
          speed: (W * 1.5) / (life / 1000) * (.65 + Math.random() * .8),
          w: .5 + Math.random() * 1.4,
          amp: 3 + Math.random() * 16,
          freq: .003 + Math.random() * .009,
          phase: Math.random() * 6.28,
          delay: Math.random() * life * .3,
          a: .18 + Math.random() * .42,
          dir
        });
      }
      if (!raf) raf = requestAnimationFrame(step);
    }

    function step(now) {
      const W = innerWidth, H = innerHeight;
      // repartir de zéro à chaque image : iOS peut remettre le canevas à neuf (retour dans l'app, manque de mémoire), et
      // son échelle avec lui. Le vent se dessinait alors à la mauvaise taille, et ce qui dépassait n'était jamais effacé
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // un voile d'air, très léger, qui balaie l'écran
      const k = Math.min(1, (now - t0) / life);
      if (band && k < 1) {
        const x = band.from + (band.to - band.from) * k;
        const grd = g.createLinearGradient(x - W * .35, 0, x + W * .35, 0);
        grd.addColorStop(0, `rgba(${rgb},0)`);
        grd.addColorStop(.5, `rgba(${rgb},${.05 * Math.sin(Math.PI * k)})`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = grd;
        g.fillRect(0, 0, W, H);
      }
      g.lineCap = 'round';
      parts = parts.filter(p => now - p.t0 - p.delay < p.life - p.delay);
      for (const p of parts) {
        const age = now - p.t0 - p.delay;
        if (age < 0) continue;
        const l = age / (p.life - p.delay), env = Math.sin(Math.PI * l);
        const head = p.x + p.dir * p.speed * age / 1000;
        g.beginPath();
        for (let s = 0; s <= 8; s++) {
          const x = head - p.dir * p.len * (s / 8);
          const y = p.y + Math.sin(x * p.freq + p.phase + l * 3) * p.amp;
          if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        const grd = g.createLinearGradient(head, 0, head - p.dir * p.len, 0);
        grd.addColorStop(0, `rgba(${rgb},${p.a * env})`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        g.strokeStyle = grd;
        g.lineWidth = p.w;
        g.stroke();
      }
      if (parts.length || k < 1) raf = requestAnimationFrame(step);
      else { raf = 0; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); }
    }

    return { gust };
  })();

  function gust(seconds, direction) {
    sound.woosh(seconds, direction);
    wind.gust(seconds, direction);
  }

  /* ───────────── Couleur de l'espace sur tout son fond ───────────── */

  const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; };
  const mixHex = (a, b, t) => '#' + hexRgb(a).map((v, i) => Math.round(v * (1 - t) + hexRgb(b)[i] * t).toString(16).padStart(2, '0')).join('');
  const lumOf = h => { const [r, gg, b] = hexRgb(h); return (.299 * r + .587 * gg + .114 * b) / 255; };

  // humeur musicale d'une couleur de la palette
  function moodOf(colorId) {
    const c = colorId && ALL_TONES.find(x => x.id === colorId);
    if (!c) return null;
    const l = lumOf(c.bg);
    if (l < .35) return 'sombre';
    if (l > .82) return 'clair';
    const [r, g, b] = hexRgb(c.bg).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < .08) return null;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return h < 60 || h > 330 ? 'chaud' : h >= 150 && h <= 290 ? 'froid' : null;
  }

  function applySpaceTheme(c) {
    const el = $('#space'), body = document.body;
    if (!c) {
      for (const v of ['--space-bg', '--space-light', '--space-shade', '--spot-rgb']) el.style.removeProperty(v);
      el.classList.remove('dark');
      for (const v of ['--veil', '--wind-rgb']) body.style.removeProperty(v);
      return;
    }
    const bg = mixHex(c.bg, '#ffffff', .1);
    const dark = lumOf(bg) < .5;
    el.style.setProperty('--space-bg', bg);
    el.style.setProperty('--space-light', dark ? .14 : .42);
    el.style.setProperty('--space-shade', dark ? .22 : .1);
    el.style.setProperty('--spot-rgb', hexRgb(mixHex(c.bg, '#ffffff', dark ? .35 : .7)).join(','));
    el.classList.toggle('dark', dark);
    body.style.setProperty('--veil', `rgba(${hexRgb(mixHex(c.bg, '#ffffff', dark ? .25 : .6)).join(',')},.78)`);
    body.style.setProperty('--wind-rgb', dark ? '255,255,255' : hexRgb(mixHex(c.bg, '#000000', .55)).join(','));
  }

  /* ───────────── Lecteur : la page présentée comme l'auteur l'a choisi ───────────── */

  const reader = { doc: null, preview: false, cleanup: [], onKey: null };

  // ce qui se manipule dans la page ne la fait pas tourner ; une sélection de texte en cours non plus
  function rdControl(e, extra) {
    return !!e.target.closest('a, button, input, textarea, details, .ix-hide, .ix-note, [data-ix], .rd-anno, .ix-blank, .ix-zoom, .anno-pill, .anno-pop, .anno-panel' + (extra || ''))
      || !document.getSelection().isCollapsed;
  }

  function readerPage(doc) {
    const wrap = document.createElement('div');
    wrap.className = 'rd-scroll';
    wrap.innerHTML = '<article class="page"><h1 class="rd-title"></h1><div class="prose"></div></article>';
    $('.rd-title', wrap).textContent = doc.title || 'Sans titre';
    $('.prose', wrap).innerHTML = doc.html;
    for (const a of $$('a:not([data-goto])', wrap)) { a.target = '_blank'; a.rel = 'noopener'; }
    for (const el of $$('[contenteditable]', wrap)) el.removeAttribute('contenteditable');
    hydrate(wrap, doc);
    return wrap;
  }

  // les blocs de la page, sans les lignes vides
  function pageBlocks(doc) {
    const src = document.createElement('div');
    src.innerHTML = doc.html;
    for (const el of $$('[contenteditable]', src)) el.removeAttribute('contenteditable');
    return Array.from(src.children).filter(b => b.tagName === 'HR' || b.tagName === 'IMG' || b.querySelector('img') || b.textContent.trim());
  }
  /* ───────────── Mise en scène : les réglages propres à chaque présentation ───────────── */

  // l'empreinte d'un bloc : de quoi le retrouver même si le reste de la page a bougé autour de lui
  function blockSig(b) {
    const img = b.tagName === 'IMG' ? b : b.querySelector && b.querySelector('img');
    const t = b.tagName + '|' + (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '|' + (img ? (img.getAttribute('src') || '').slice(-48) : '');
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'b' + (h >>> 0).toString(36);
  }
  const sceneOf = (doc, id = doc.present || '') => (doc.scene && doc.scene[id]) || {};
  const sceneFor = (doc, id) => { doc.scene = doc.scene || {}; return (doc.scene[id] = doc.scene[id] || {}); };
  const sceneItem = (doc, id, key) => (sceneOf(doc, id).items || {})[key] || {};
  const sceneItemFor = (doc, id, key) => { const sc = sceneFor(doc, id); sc.items = sc.items || {}; return (sc.items[key] = sc.items[key] || {}); };

  // découpages par défaut : un intertitre emmène le bloc qui le suit ;
  // le diaporama coupe aux séparateurs, sinon aux titres, sinon tous les trois blocs
  const AUTO_CUTS = {
    // la carte à retourner reste une seule carte tant que l'auteur ne l'a pas découpée
    whole: () => [0],
    passages: (all, blocks) => blocks.map((b, i) => i).filter(i => !(i > 0 && /^H[1-3]$/.test(blocks[i - 1].tagName))),
    slides: all => {
      const hasHr = all.some(b => b.tagName === 'HR'), hasHead = all.some(b => /^H[12]$/.test(b.tagName));
      const out = [];
      let i = 0, run = 0, afterHr = false;
      for (const b of all) {
        if (b.tagName === 'HR') { afterHr = true; continue; }
        if (i === 0 || (hasHr ? afterHr : hasHead ? /^H[12]$/.test(b.tagName) : run >= 3)) { out.push(i); run = 0; }
        afterHr = false;
        run++;
        i++;
      }
      return out;
    }
  };

  // où commence chaque passage : le découpage de l'auteur s'il en a fait un, sinon celui par défaut
  function cutStarts(doc, id, all, blocks) {
    const sc = sceneOf(doc, id);
    if (!sc.cuts) return new Set((id === 'slides' ? AUTO_CUTS.slides : id === 'flip' ? AUTO_CUTS.whole : AUTO_CUTS.passages)(all, blocks));
    const sigs = blocks.map(blockSig), used = new Set(), starts = new Set([0]);
    for (const c of sc.cuts) {
      // deux blocs identiques : on prend celui qui est le plus près de sa place d'origine
      let best = -1;
      sigs.forEach((s, j) => { if (s === c.s && !used.has(j) && (best < 0 || Math.abs(j - c.i) < Math.abs(best - c.i))) best = j; });
      if (best > 0) { used.add(best); starts.add(best); }
    }
    return starts;
  }

  // le recto d'une carte à retourner : le titre de la page pour la première, sinon l'intertitre qui ouvre la carte
  // (il quitte alors le verso), à défaut sa première phrase
  function flipFront(doc, blocks, k) {
    const first = blocks[0];
    const head = first && /^H[1-3]$/.test(first.tagName) && (k > 0 || !doc.title);
    if (k === 0 && doc.title) return { front: doc.title, head: false };
    if (head) return { front: first.textContent.trim(), head: true };
    const t = blocks.map(b => b.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const m = /^.{1,90}?[.!?…](\s|$)/.exec(t);
    return { front: m ? m[0].trim() : t.slice(0, 80) + (t.length > 80 ? '…' : '') || 'Carte ' + (k + 1), head: false };
  }

  /* Ce que montre chaque face d'une carte. L'auteur choisit, élément par élément (le titre de la page compris,
   * sur la première carte) ; sans choix, le titre ou l'intertitre qui ouvre la carte va au recto, le reste au verso. */
  function flipSides(doc, blocks, k, key) {
    const it = sceneItem(doc, 'flip', key), side = it.side || {};
    const auto = flipFront(doc, blocks, k);
    // le titre de la carte : celui que l'auteur a écrit, sinon celui de la page sur la première carte
    const own = (it.title || '').trim(), titleText = own || (k === 0 ? doc.title || '' : '');
    const rows = [];
    if (titleText) rows.push({ sig: 'title', title: true, text: titleText, side: side.title || 'r' });
    // un titre écrit prend la place de l'intertitre d'ouverture, qui passe alors au verso
    blocks.forEach((b, i) => { const sig = blockSig(b); rows.push({ sig, i, block: b, side: side[sig] || (auto.head && !own && i === 0 ? 'r' : 'v') }); });
    const recto = rows.filter(r => r.side === 'r');
    const custom = Object.keys(side).length > 0 || !!own;
    // un recto fait d'un seul titre garde la grande typographie ; sans rien au recto, la première phrase s'y affiche
    const titleOnly = recto.length === 1 && (recto[0].title || /^H[1-3]$/.test(recto[0].block.tagName));
    const label = titleOnly ? (recto[0].title ? titleText : recto[0].block.textContent.trim()) : !recto.length && !custom ? auto.front : '';
    return { rows, recto, titleOnly, label, titleText, own, auto: auto.front };
  }

  // la page découpée en groupes de blocs ; chaque groupe garde l'empreinte de son premier bloc comme clé
  function groupsOf(doc, id = doc.present || '') {
    const all = pageBlocks(doc), blocks = all.filter(b => b.tagName !== 'HR');
    const starts = cutStarts(doc, id, all, blocks), groups = [];
    blocks.forEach((b, i) => { if (!groups.length || starts.has(i)) groups.push([]); groups[groups.length - 1].push(b); });
    const max = (SCENE[id] || {}).max;
    return groups.flatMap(g => {
      const key = blockSig(g[0]);
      if (!max) return [{ key, blocks: g }];
      // un passage trop long pour son cadre continue sur le suivant, plutôt que d'être coupé à l'écran
      // (dans le diaporama, une image ne compte presque pas : la diapositive la pose à côté du texte, elle reste avec lui)
      return fitPieces(g, max, id === 'slides' ? slideWeight : blockWeight).map((p, n) => ({ key: n ? key + '.' + n : key, blocks: p, cont: n > 0 }));
    });
  }

  // la place qu'un bloc prend à l'écran, comptée en caractères (une image ou un bloc interactif pèsent lourd)
  const blockWeight = b => (b.textContent || '').replace(/\s+/g, ' ').trim().length + 40
    + (b.tagName === 'IMG' || b.querySelector('img') ? 520 : 0) + (/^H[1-3]$/.test(b.tagName) ? 80 : 0)
    + (b.matches('.ix-chart') ? 120 : b.matches('[data-ix], details') ? 380 : 0) + (/^(UL|OL)$/.test(b.tagName) ? b.children.length * 25 : 0);

  const isMediaBlock = b => (b.tagName === 'IMG' || (/^(P|FIGURE|DIV)$/.test(b.tagName) && b.querySelector('img') && !b.textContent.trim())) && !b.matches('[data-ix], .callout');
  const slideWeight = b => isMediaBlock(b) ? 60 : blockWeight(b);

  // un groupe de blocs réparti en morceaux de taille voisine, sans dépasser la limite
  function fitPieces(blocks, max, blockWeight) {
    const total = blocks.reduce((s, b) => s + blockWeight(b), 0);
    if (total <= max) return [blocks];
    const lim = Math.min(max, Math.ceil(total / Math.ceil(total / max) * 1.12));
    const parts = blocks.flatMap(b => (blockWeight(b) > lim ? splitBlock(b, lim) : [b]));
    const out = [];
    let cur = [], w = 0;
    for (const b of parts) {
      const bw = blockWeight(b);
      const isHead = x => /^H[1-3]$/.test(x.tagName);
      if (cur.length && w + bw > lim && !cur.every(isHead)) {
        // un intertitre ne reste jamais seul en bas d'un morceau : il part avec ce qui le suit
        const head = isHead(cur[cur.length - 1]) ? cur.pop() : null;
        out.push(cur);
        cur = head ? [head] : [];
        w = head ? blockWeight(head) : 0;
      }
      cur.push(b);
      w += bw;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // un paragraphe trop long est coupé entre deux phrases (à défaut entre deux mots), une liste entre deux puces
  function splitBlock(b, lim) {
    if (/^(UL|OL)$/.test(b.tagName)) {
      const out = [];
      let cur = null, w = 0, n = 0;
      const start = +(b.getAttribute('start') || 1);
      for (const li of Array.from(b.children)) {
        const lw = li.textContent.length + 25;
        if (!cur || w + lw > lim) {
          cur = b.cloneNode(false);
          if (b.tagName === 'OL') cur.setAttribute('start', start + n);
          out.push(cur);
          w = 40;
        }
        cur.append(li.cloneNode(true));
        w += lw;
        n++;
      }
      return out;
    }
    if (!/^(P|BLOCKQUOTE)$/.test(b.tagName) || b.querySelector('img, [data-ix]')) return [b];
    const { nodes, s } = textMap(b);
    if (!nodes.length) return [b];
    const ends = [];
    for (const m of s.matchAll(/[.!?…]+["»”’)\]]*\s+/g)) ends.push(m.index + m[0].length);
    ends.push(s.length);
    const cuts = [];
    let last = 0, prev = 0;
    for (const c of ends) {
      if (c - last > lim) {
        if (prev > last) { cuts.push(prev); last = prev; }
        while (c - last > lim) {
          let sp = s.lastIndexOf(' ', last + lim);
          if (sp <= last) sp = last + lim;
          cuts.push(sp);
          last = sp;
        }
      }
      prev = c;
    }
    if (!cuts.length) return [b];
    // chaque morceau garde la mise en forme du texte (gras, liens…) : on le recopie tel quel, entre deux positions
    const at = p => { for (const x of nodes) if (p < x.at + x.n.textContent.length) return [x.n, p - x.at]; const z = nodes[nodes.length - 1]; return [z.n, z.n.textContent.length]; };
    const bounds = [0, ...cuts, s.length];
    return bounds.slice(1).map((e, k) => {
      const r = document.createRange();
      if (k === 0) r.setStart(b, 0); else r.setStart(...at(bounds[k]));
      if (k === bounds.length - 2) r.setEnd(b, b.childNodes.length); else r.setEnd(...at(e));
      const piece = b.cloneNode(false);
      piece.append(r.cloneContents());
      return piece;
    });
  }

  // une place « au hasard », mais toujours la même pour une même page
  const seeded = (k, salt) => { const x = Math.sin(k * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };

  const SPEEDS = [['', 'Normale'], ['lent', 'Lente'], ['rapide', 'Rapide']];
  const SLIDE_TONES = [['', 'Sans couleur', '#ffffff'], ...SCENE_COLORS.map(c => [c.id, c.name, c.bg])];
  const DOOR_COLORS = ['#1f6f78', '#9b3d3d', '#c08a2e', '#3f6b3a', '#2c4a86', '#6d3f7a', '#b4583a', '#4a6f8f'];
  const DOOR_TONES = [['', 'Automatique', 'conic-gradient(#1f6f78 0 25%, #9b3d3d 0 50%, #c08a2e 0 75%, #6d3f7a 0)'], ...[['sarcelle', 'Sarcelle'], ['bordeaux', 'Bordeaux'], ['ocre', 'Ocre'], ['vert', 'Vert'], ['bleu', 'Bleu nuit'], ['prune', 'Prune'], ['terre', 'Terre cuite'], ['ardoise', 'Ardoise']].map(([id, n], i) => [id, n, DOOR_COLORS[i]])];
  const doorColor = id => { const t = DOOR_TONES.find(x => x[0] === id); return t && id ? t[2] : null; };
  /* ───────────── WebGL : de quoi peindre un volume pixel par pixel ───────────── */

  // un rectangle plein cadre et un fragment shader ; null si WebGL manque (la présentation garde alors sa version simple)
  function glQuad(canvas, frag, opts = {}) {
    const gl = canvas.getContext('webgl', { alpha: !!opts.alpha, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
    const fs = sh(gl.FRAGMENT_SHADER, 'precision highp float;\n' + GLSL_NOISE + frag);
    if (!vs || !fs) return null;
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const locs = {};
    const loc = name => (name in locs ? locs[name] : (locs[name] = gl.getUniformLocation(pr, name)));
    return {
      set(name, v) {
        const l = loc(name);
        if (!l) return;
        if (typeof v === 'number') gl.uniform1f(l, v);
        else if (v.length === 2) gl.uniform2fv(l, v);
        else if (v.length === 3) gl.uniform3fv(l, v);
        else if (v.length === 4) gl.uniform4fv(l, v);
        else gl.uniformMatrix3fv(l, false, v);
      },
      texture(name, unit, source) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        gl.uniform1i(loc(name), unit);
      },
      draw() { gl.viewport(0, 0, canvas.width, canvas.height); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); },
      lose() { const e = gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); }
    };
  }

  // bruits lisses (valeur, en 2D et 3D) et leurs sommes d'octaves
  const GLSL_NOISE = `
float h3(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1., 0., 0.)), f.x), mix(h3(i + vec3(0., 1., 0.)), h3(i + vec3(1., 1., 0.)), f.x), f.y),
             mix(mix(h3(i + vec3(0., 0., 1.)), h3(i + vec3(1., 0., 1.)), f.x), mix(h3(i + vec3(0., 1., 1.)), h3(i + vec3(1., 1., 1.)), f.x), f.y), f.z); }
float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.02 + vec3(1.7, 9.2, 3.1); a *= .5; } return s; }
float h2(vec2 p){ p = fract(p * vec2(.1031, .1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float n2(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1., 0.)), f.x), mix(h2(i + vec2(0., 1.)), h2(i + vec2(1., 1.)), f.x), f.y); }
float f2(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * n2(p); p = p * 2.03 + vec2(5.2, 1.3); a *= .5; } return s; }
`;

  // rotations 3×3, rangées ligne par ligne, avec les conventions du CSS (x à droite, y vers le bas, z vers le lecteur)
  const M3 = {
    rx: a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; },
    ry: a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; },
    mul: (A, B) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return r; },
    app: (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]],
    // la même matrice, colonne par colonne, comme WebGL l'attend
    gl: A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]]
  };
  const seedOf = id => { const h = [...(id || 'p')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); return [h % 997 / 9.7, (h >>> 10) % 997 / 9.7, (h >>> 20) % 997 / 9.7]; };

  /*
   * La surface de la planète : pour chaque pixel, un rayon part de l'œil (même perspective que le CSS), touche la sphère,
   * et l'on calcule ce point dans le repère de la planète. Relief en volume (la normale suit les reliefs), lumière rasante,
   * mer qui brille, nuages qui dérivent, atmosphère sur le bord. Les repères, en CSS 3D, tournent avec la même matrice.
   */
  const PLANET_FRAG = `
uniform vec2 uRes; uniform float uDpr, uR, uP, uKind, uTime; uniform mat3 uM; uniform vec3 uSeed, uL;
float hOcean(vec3 p){ vec3 q = p * 1.45 + uSeed; vec3 w = vec3(fbm(q + 3.1), fbm(q + 7.7), fbm(q + 1.3)); return fbm(q + 1.1 * w); }
float crater(vec3 q, float s, float k){
  vec3 c = floor(q * s), f = q * s - c;
  if (h3(c + k) < .42) return 0.;
  vec3 cen = .5 + (vec3(h3(c + k + 1.7), h3(c + k + 5.3), h3(c + k + 9.1)) - .5) * .3;
  float r = .16 + .18 * h3(c + k + 13.), x = length(f - cen) / r;
  return (x < 1. ? (x * x - 1.) * .9 : 0.) + exp(-pow((x - 1.) * 3.4, 2.)) * .32;
}
float hMoon(vec3 p){
  vec3 q = p + uSeed * .01;
  return crater(q, 3.2, 1.) / 3.2 + crater(q, 7., 2.) / 7. + crater(q, 15., 3.) / 15. + crater(q, 31., 4.) / 31. + (fbm(p * 5. + uSeed) - .5) * .06;
}
vec4 halo(vec2 pt, float dist){
  float g = 1. - (dist - uR) / (uR * (uKind < .5 ? .16 : .06));
  if (g <= 0.) return vec4(0.);
  vec2 sd = normalize(pt);
  float lit = clamp(dot(sd, normalize(uL.xy)) * .6 + .55, 0., 1.);
  vec3 col = uKind < .5 ? vec3(.38, .62, 1.) : vec3(.75, .74, .7);
  float a = pow(g, 2.4) * (uKind < .5 ? .7 : .14) * lit;
  return vec4(col * a, a);
}
void main(){
  vec2 hs = uRes / uDpr * .5;
  vec2 pt = vec2(gl_FragCoord.x / uDpr - hs.x, hs.y - gl_FragCoord.y / uDpr);
  vec3 E = vec3(0., 0., uP), d = normalize(vec3(pt, 0.) - E), V = -d;
  float b = dot(E, d), disc = b * b - (dot(E, E) - uR * uR);
  float dist = sqrt(max(dot(E, E) - b * b, 0.));
  vec4 hl = halo(pt, dist);
  if (disc < 0.) { gl_FragColor = hl; return; }
  vec3 n = (E + (-b - sqrt(disc)) * d) / uR;
  vec3 p = n * uM;
  vec3 t1 = normalize(cross(abs(p.y) > .99 ? vec3(1., 0., 0.) : vec3(0., 1., 0.), p)), t2 = cross(p, t1);
  vec3 L = normalize(uL), col;
  if (uKind < .5) {
    float h = hOcean(p), sea = .5, land = smoothstep(sea, sea + .008, h), el = clamp((h - sea) / .22, 0., 1.);
    vec3 nl = p;
    if (h > sea - .015) {
      float e = .006, hx = hOcean(normalize(p + t1 * e)), hy = hOcean(normalize(p + t2 * e));
      nl = normalize(p - ((hx - h) * t1 + (hy - h) * t2) / e * (.16 + .5 * el) * land);
    }
    float lat = abs(p.y);
    float dry = smoothstep(.42, .62, vnoise(p * 2.6 + uSeed * 1.3)) * (1. - smoothstep(.3, .62, lat));
    vec3 low = mix(vec3(.16, .33, .13), vec3(.66, .55, .33), dry);
    vec3 ground = mix(low, vec3(.42, .36, .3), smoothstep(.22, .6, el));
    ground = mix(ground, vec3(.94, .95, .97), smoothstep(.78, .95, el + lat * .12));
    vec3 water = mix(vec3(.015, .07, .19), vec3(.05, .29, .43), smoothstep(sea - .13, sea, h));
    float ice = smoothstep(.9, .95, lat + (vnoise(p * 6. + uSeed) - .5) * .08);
    vec3 base = mix(mix(water, ground, land), vec3(.92, .95, .98), ice);
    float day = smoothstep(-.12, .3, dot(n, L));
    col = base * (.035 + 1.15 * max(dot(uM * nl, L), 0.) * day);
    col += (1. - land) * (1. - ice) * pow(max(dot(n, normalize(L + V)), 0.), 80.) * .6 * day;
    float cl = smoothstep(.6, .82, fbm(p * 2.4 + uSeed * 2. + vec3(uTime * .012, 0., uTime * .006)));
    col = mix(col, vec3(1.) * (.04 + 1.05 * max(dot(n, L), 0.)), cl * .88);
    col += vec3(.3, .55, 1.) * pow(1. - max(dot(n, V), 0.), 2.6) * .6 * (day + .08);
  } else {
    float h = hMoon(p), e = .0025;
    float hx = hMoon(normalize(p + t1 * e)), hy = hMoon(normalize(p + t2 * e));
    vec3 nl = normalize(p - ((hx - h) * t1 + (hy - h) * t2) / e * .55);
    float mare = smoothstep(.46, .6, fbm(p * 1.25 + uSeed + 5.));
    vec3 albedo = mix(vec3(.66, .65, .62), vec3(.34, .34, .34), mare) * (.84 + .32 * fbm(p * 9. + uSeed));
    col = albedo * (.015 + 1.2 * max(dot(uM * nl, L), 0.) * smoothstep(-.04, .12, dot(n, L)));
    col += vec3(.8) * pow(1. - max(dot(n, V), 0.), 3.) * .05;
  }
  float a = clamp((uR - dist) * uDpr * .9, 0., 1.);
  gl_FragColor = mix(hl, vec4(col, 1.), a);
}`;

  // les repères, de petits objets en volume posés debout sur le sol (y vers le haut = -y) ; data-n : la normale de chaque face
  const prism = (cls, sides, r, h, top) => {
    const w = 2 * r * Math.tan(Math.PI / sides) + .3;
    return Array.from({ length: sides }, (_, i) => { const a = i * 360 / sides, ra = a * Math.PI / 180;
      return `<i class="${cls}" data-n="${Math.sin(ra).toFixed(3)},0,${Math.cos(ra).toFixed(3)}" style="left:${(-w / 2).toFixed(2)}px;top:${top}px;width:${w.toFixed(2)}px;height:${h}px;transform:rotateY(${a}deg) translateZ(${r}px)"></i>`; }).join('');
  };
  const PLANET_MARKS = {
    point: '',
    drapeau: '<i class="k-shadow"></i><i class="k-pole" data-n="1,0,0,2"></i><i class="k-pole b" data-n="0,0,1,2"></i><i class="k-cloth" data-n="0,0,1,2"></i>',
    phare: '<i class="k-shadow wide"></i>' + prism('k-tower', 8, 5, 24, -24) + prism('k-lamp', 8, 3.4, 5, -29) + prism('k-cap', 8, 4.4, 3, -32)
      + '<div class="k-beam"><i></i><i class="b"></i></div>',
    maison: '<i class="k-shadow wide"></i>'
      + '<i class="k-wall gable front" data-n="0,0,1" style="transform:translateZ(6px)"></i>'
      + '<i class="k-wall side" data-n="-1,0,0" style="transform:rotateY(-90deg) translateZ(7px)"></i><i class="k-wall side" data-n="1,0,0" style="transform:rotateY(90deg) translateZ(7px)"></i>'
      + '<i class="k-wall gable back" data-n="0,0,-1" style="transform:rotateY(180deg) translateZ(6.05px)"></i>'
      + '<i class="k-roof" data-n="-.58,-.81,0" style="transform:translate3d(-3.5px,-11.5px,0) rotateZ(-35.5deg) rotateX(90deg)"></i><i class="k-roof" data-n=".58,-.81,0" style="transform:translate3d(3.5px,-11.5px,0) rotateZ(35.5deg) rotateX(90deg)"></i>'
  };
  const PLANET_MARK_OPTS = [['point', 'Point'], ['drapeau', 'Drapeau'], ['phare', 'Phare'], ['maison', 'Maison']];

  // les décors du couloir : le ciel, l'horizon, le sol, ce qui flotte dans l'air, et jusqu'où porte le regard
  const DOOR_DECORS = {
    nuit: { stars: 1, fog: [3500, 4500], motes: 'poussiere' },
    desert: { fog: [4600, 5600], motes: 'sable' },
    jardin: { fog: [3000, 4200], motes: 'lucioles' },
    brume: { fog: [1500, 2600], motes: 'brume' }
  };
  const PAPERS = [['', 'Papier crème', '#fbf7ec'], ['blanc', 'Blanc', '#ffffff'], ['kraft', 'Kraft', '#d9c09a'], ['jaune', 'Post-it jaune', '#fde68a'], ['rose', 'Post-it rose', '#fbcfe0'],
    ['bleu', 'Post-it bleu', '#c4e0fb'], ['vert', 'Post-it vert', '#c9f2c7'], ['orange', 'Post-it orange', '#fed2a8'], ['lilas', 'Post-it lilas', '#e2d7fb'], ['ardoise', 'Ardoise', '#2b2a28']];
  // la couverture de l'album est sombre par défaut : sa liste propose donc le papier crème comme un vrai choix
  const COVER_PAPERS = [['', 'Couverture sombre', '#2b2a28'], ['creme', 'Papier crème', '#fbf7ec'], ...PAPERS.slice(1).filter(p => p[0] !== 'ardoise')];
  // la Lettre : couleur de l'enveloppe (et de l'encre de l'adresse), couleur du cachet
  const LETTER_ENVS = [['', 'Kraft', '#c9a77c', '#3a2a18'], ['blanc', 'Blanc', '#f3efe6', '#2e2a24'], ['nuit', 'Bleu nuit', '#2c3e5c', '#f1ece2'], ['bordeaux', 'Bordeaux', '#7a2e35', '#f6e9e2'], ['sauge', 'Sauge', '#a3b39c', '#1f2a1c']];
  const LETTER_SEALS = [['', 'Rouge', '#a3262a'], ['bleu', 'Bleu', '#2b4c8c'], ['or', 'Or', '#b8892e'], ['vert', 'Vert', '#2f6b45'], ['noir', 'Noir', '#26231f']];
  const TABLES = [['', 'Bois'], ['sombre', 'Bois sombre'], ['liege', 'Liège'], ['lin', 'Lin'], ['ardoise', 'Ardoise']];

  /*
   * Ce que l'on peut régler, présentation par présentation.
   * cuts : l'auteur choisit où commence chaque passage ; global : réglages d'ensemble ; item : réglages d'un passage.
   * Pour chaque réglage, la première option est la valeur par défaut.
   */
  const FLIP_TONES = [['', 'Couleur de la carte', 'conic-gradient(#c8442b 0 25%, #1f2a44 0 50%, #dfe3d5 0 75%, #d9a441 0)'], ...SCENE_COLORS.map(c => [c.id, c.name, c.bg])];
  const SCENE = {
    flip: {
      cuts: true, unit: 'Carte',
      global: [{ key: 'layout', label: 'Disposition', type: 'seg', options: [['', 'Une à une'], ['grille', 'Toutes ensemble']] }],
      item: [{ key: 'tone', label: 'Couleur du recto', type: 'swatch', options: FLIP_TONES }]
    },
    slides: {
      cuts: true, unit: 'Diapositive', max: 1300,
      global: [{ key: 'transition', label: 'Transition', type: 'seg', options: [['', 'Glisser'], ['fondu', 'Fondu'], ['zoom', 'Zoom']] }],
      item: [
        { key: 'bg', label: 'Fond', type: 'swatch', options: SLIDE_TONES },
        { key: 'layout', label: 'Images', type: 'seg', options: [['', 'Auto'], ['gauche', 'À gauche'], ['droite', 'À droite'], ['fond', 'En fond'], ['pile', 'Empilées']] },
        { key: 'align', label: 'Alignement', type: 'seg', options: [['', 'Gauche'], ['center', 'Centré']] },
        { key: 'size', label: 'Taille du texte', type: 'seg', options: [['', 'Normale'], ['s', 'Petite'], ['l', 'Grande']] }
      ]
    },
    album: {
      cuts: true, unit: 'Souvenir', board: true,
      global: [{ key: 'table', label: 'Table', type: 'seg', options: TABLES }],
      item: [
        { key: 'paper', label: 'Papier', type: 'swatch', options: PAPERS },
        { key: 'fix', label: 'Attache', type: 'seg', options: [['', 'Scotch'], ['punaise', 'Punaise'], ['aucune', 'Aucune']] },
        { key: 'rot', label: 'Inclinaison', type: 'range', min: -25, max: 25, unit: '°' }
      ]
    },
    portes: {
      cuts: true, unit: 'Pièce',
      global: [
        { key: 'decor', label: 'Décor', type: 'seg', options: [['', 'Nuit'], ['desert', 'Désert'], ['jardin', 'Jardin'], ['brume', 'Brume']] },
        { key: 'path', label: 'Parcours', type: 'seg', options: [['', 'Sinueux'], ['escalier', 'Escalier']] }
      ],
      item: [{ key: 'door', label: 'Couleur de la porte', type: 'swatch', options: DOOR_TONES }]
    },
    // max : au-delà de ce nombre de caractères (à peu près), un passage continue sur le suivant
    voyage: { cuts: true, unit: 'Passage', max: 600 },
    encre: { cuts: true, unit: 'Passage', max: 750 },
    mots: { cuts: true, unit: 'Passage', max: 650 },
    film: { cuts: true, unit: 'Image', max: 620 },
    carnet: { cuts: true, unit: 'Page', max: 900 },
    lettre: {
      global: [
        { key: 'env', label: 'Enveloppe', type: 'swatch', options: LETTER_ENVS.map(([v, l, c]) => [v, l, c]) },
        { key: 'seal', label: 'Cachet de cire', type: 'swatch', options: LETTER_SEALS },
        { key: 'paper', label: 'Papier', type: 'seg', options: [['', 'Crème'], ['blanc', 'Blanc'], ['bleu', 'Bleuté']] }
      ]
    },
    planete: {
      cuts: true, unit: 'Lieu',
      global: [
        { key: 'surface', label: 'Surface', type: 'seg', options: [['', 'Grille'], ['ocean', 'Océan'], ['lune', 'Lune']] },
        { key: 'spin', label: 'Rotation', type: 'seg', options: [['', 'Au toucher'], ['auto', 'Automatique']] },
        { key: 'mark', label: 'Repères', type: 'seg', options: PLANET_MARK_OPTS.map(([v, l]) => [v === 'point' ? '' : v, l]) }
      ],
      item: [{ key: 'mark', label: 'Repère de ce lieu', type: 'seg', options: [['', 'Comme les autres'], ...PLANET_MARK_OPTS] }]
    },
    reveal: {
      global: [
        { key: 'style', label: 'Apparition', type: 'seg', options: [['', 'Douce'], ['fondu', 'Fondu'], ['montee', 'Montée'], ['zoom', 'Zoom']] },
        { key: 'speed', label: 'Vitesse', type: 'seg', options: SPEEDS }
      ]
    },
    typewriter: { global: [{ key: 'speed', label: 'Vitesse de frappe', type: 'seg', options: SPEEDS }] },
    phrase: { global: [{ key: 'unit', label: 'À chaque clic', type: 'seg', options: [['', 'Une phrase'], ['para', 'Un paragraphe']] }] }
  };


  function openReader(doc, preview) {
    closeReaderInner();
    reader.doc = doc;
    reader.preview = !!preview;
    const el = $('#reader'), stage = $('#rdStage');
    stage.textContent = '';
    stage.className = 'rd-stage rd-' + (doc.present || 'normal');
    stage.style.backgroundColor = '';   // le diaporama y laisse le fond de sa dernière diapositive
    el.classList.toggle('night', !!doc.night);
    $('#rdHint').textContent = '';
    $('#rdClose').textContent = preview ? '← Retour à l’édition' : '← ' + (spaceOfDoc(doc.id) || {}).title;
    el.hidden = false;
    if (!preview) {
      state.current = spaceOfDoc(doc.id).id;
      show('reader');
      sound.seed('carte:' + doc.id, docMood(doc));
    }
    el.classList.toggle('voyage', doc.present === 'voyage');
    // l'univers est sombre : le texte et les blocs prennent leurs couleurs de nuit
    if (DARK_PRESENTS.includes(doc.present)) el.classList.add('night');
    ({
      reveal: presentReveal, slides: presentSlides, flip: presentFlip, typewriter: presentTypewriter, phrase: presentPhrase, voyage: presentVoyage,
      portes: presentDoors, encre: presentInk, mots: presentWords, album: presentAlbum, film: presentFilm, carnet: presentNotebook, lettre: presentLetter,
      memoire: presentMemory, planete: presentPlanet, apesanteur: presentFloat
    }[doc.present] || presentNormal)(doc, stage);
    startWeather(doc.weather);
    if (doc.lamp) startLamp();
    paintNotesBtn();
    contrastSoon();
    if (!preview && asReader()) markRead(doc);
    watchReaderEnd(doc, stage);
  }

  /*
   * À la fin d'une lecture : la carte choisie dans la mise en scène (doc.next) s'annonce en bas de l'écran. Un clic ou
   * Entrée y mène, par une transition : la scène s'éloigne, la carte suivante arrive. Les présentations qui se déroulent
   * disent leur fin par readerEnd ; une page qui défile, quand on arrive en bas ; les autres gardent le lien affiché.
   */
  const nextCard = doc => { const to = doc && doc.next && doc.next !== doc.id ? findDoc(doc.next) : null; return to || null; };
  function readerEnd(on) {
    reader.endKnown = true;
    const to = nextCard(reader.doc);
    let pill = $('#rdNextCard');
    if (!on || !to) { if (pill) pill.remove(); return; }
    if (pill) return;
    pill = document.createElement('div');
    pill.id = 'rdNextCard';
    pill.innerHTML = `<button class="btn ghost rn-go"><small>Ensuite</small><b>${esc(to.title || 'Sans titre')}</b><span aria-hidden="true">→</span></button>`;
    $('.rn-go', pill).onclick = e => { e.stopPropagation(); goNextCard(); };
    $('#reader').append(pill);
  }
  async function goNextCard() {
    const from = reader.doc, to = nextCard(from);
    if (!to || reader.leaving) return;
    if (reader.preview) return toast(`En lecture, on passera à « ${to.title || 'Sans titre'} »`);
    if (isLocked(to) && !await unlockDoc(to)) return;
    const stage = $('#rdStage'), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) return openReader(to, false);
    reader.leaving = true;
    const pill = $('#rdNextCard');
    if (pill) pill.remove();
    sound.woosh(.8, 1);
    const ease = 'cubic-bezier(.4, 0, .7, .2)';
    await stage.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(.92) translateY(-3%)', filter: 'blur(10px)' }], { duration: 480, easing: ease, fill: 'forwards' }).finished.catch(() => {});
    reader.leaving = false;
    stage.getAnimations().forEach(x => x.cancel());
    if (reader.doc !== from) return;
    openReader(to, false);
    stage.animate([{ opacity: 0, transform: 'scale(1.06) translateY(3%)', filter: 'blur(10px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 720, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
  function watchReaderEnd(doc, stage) {
    if (!nextCard(doc) || doc.present === 'flip') return;
    const scroller = $('.rd-scroll', stage);
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
      const bottom = () => { readerEnd(scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 60); };
      listen(scroller, 'scroll', bottom, { passive: true });
      return;
    }
    const t = setTimeout(() => { if (reader.doc === doc && !reader.endKnown) readerEnd(true); }, 4000);
    reader.cleanup.push(() => clearTimeout(t));
  }

  // Un écouteur posé sur la scène partagée est retiré à la fermeture : sinon il survit à sa présentation
  // (la molette de Voyage bloquait ensuite le défilement de toutes les autres)
  function listen(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    reader.cleanup.push(() => el.removeEventListener(type, fn, opts));
  }

  function closeReaderInner() {
    $$('.ix-bubble, .ix-light, .zoom-lens').forEach(x => x.remove());
    const stage = $('#rdStage');
    for (const k of ['onclick', 'onpointerdown', 'onpointermove', 'onpointerup', 'onwheel']) stage[k] = null;
    closeAnnoUI();
    for (const f of reader.cleanup) f();
    reader.cleanup = [];
    reader.onKey = null;
    reader.endKnown = false;
    const pill = $('#rdNextCard');
    if (pill) pill.remove();
  }

  function closeReader() {
    const doc = reader.doc;
    closeReaderInner();
    $('#reader').hidden = true;
    reader.doc = null;
    if (reader.preview || !doc) return;
    const sp = spaceOfDoc(doc.id);
    enterSpace(sp ? sp.id : null, { instant: true, focusId: doc.id, keepRotation: true });
  }

  function presentNormal(doc, stage) {
    stage.append(readerPage(doc));
  }

  // 1. Révélation : chaque bloc apparaît en fondu en entrant dans l'écran
  function presentReveal(doc, stage) {
    const page = readerPage(doc);
    stage.append(page);
    const set = sceneOf(doc, 'reveal'), pace = { lent: 1.8, rapide: .5 }[set.speed] || 1;
    if (set.style) stage.classList.add('rv-' + set.style);
    stage.style.setProperty('--rv-k', pace);
    const items = [$('.rd-title', page), ...$('.prose', page).children];
    for (const x of items) x.classList.add('rv');
    const io = new IntersectionObserver(entries => {
      let k = 0;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        en.target.style.transitionDelay = (k++ * 120 * pace) + 'ms';
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }, { root: page, threshold: .12 });
    for (const x of items) io.observe(x);
    reader.cleanup.push(() => io.disconnect());
  }

  // 2. Diaporama : un écran par partie
  // une diapositive habillée selon la mise en scène : fond, alignement, taille du texte
  // le trait des citations : la couleur d'accent, sinon noir ou blanc si elle se lit mal sur ce fond
  function quoteLine(el, bg) {
    const lum = hex => { const n = parseInt(hex.slice(1), 16), v = [n >> 16, n >> 8 & 255, n & 255].map(x => (x /= 255) <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
    const a = lum(bg), b = lum('#c93470');
    if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) < 3) el.style.setProperty('--quote-line', a > .18 ? '#111' : '#fff');
  }
  function dressSlide(s, set) {
    const tone = set.bg && ALL_TONES.find(c => c.id === set.bg);
    if (tone) { s.style.background = tone.bg; s.style.color = tone.fg; s.classList.add('toned'); quoteLine(s, tone.bg); }
    if (set.align) s.classList.add('al-' + set.align);
    if (set.size) s.classList.add('sz-' + set.size);
  }
  /*
   * La disposition d'une diapositive avec des images, pour présenter un projet :
   *  · une image et du texte : côte à côte (l'image du côté où elle est dans la page), l'image entière, jamais rognée ;
   *  · une image seule, ou avec un simple titre : elle prend la diapositive, le titre en légende ;
   *  · plusieurs images : une mosaïque ;
   *  · « en fond » : la première image couvre la diapositive, le texte se pose dessus ;
   *  · « empilé » : l'ancienne disposition, images et texte l'un sous l'autre.
   */
  function layoutSlide(s, how) {
    if (how === 'pile') return;
    const inner = $('.rd-slide-in', s);
    const kids = Array.from(inner.children), media = kids.filter(isMediaBlock), caps = kids.filter(k => k.matches('p.cap')), text = kids.filter(k => !media.includes(k) && !caps.includes(k));
    if (!media.length) return;
    const imgs = media.flatMap(m => m.tagName === 'IMG' ? [m] : $$('img', m));
    const words = text.map(k => k.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const brief = !text.length || (words.length < 90 && text.every(k => /^(H[1-3]|P)$/.test(k.tagName)));
    let kind = how;
    if (!kind) kind = brief ? (imgs.length > 1 ? 'mosaique' : 'pleine') : kids.indexOf(media[0]) < kids.indexOf(text[0]) ? 'gauche' : 'droite';
    if (kind === 'fond') {
      s.style.backgroundImage = `url("${imgs[0].getAttribute('src')}")`;
      s.classList.add('lay-bg');
      for (const m of media) m.remove();
      return;
    }
    const box = document.createElement('div');
    box.className = 'sl-media' + (imgs.length > 1 ? ' n' + Math.min(imgs.length, 4) : '');
    box.append(...imgs, ...caps);
    imgs.forEach(im => { im.className = 'sl-pic'; });
    for (const m of media) if (m.isConnected && m !== box) m.remove();
    const words2 = document.createElement('div');
    words2.className = 'sl-words';
    words2.append(...text);
    inner.textContent = '';
    inner.classList.remove('prose');
    words2.classList.add('prose');
    s.classList.add('lay-' + (kind === 'pleine' || kind === 'mosaique' ? 'full' : 'split'), 'media-' + (kind === 'droite' ? 'right' : 'left'));
    if (kind === 'pleine' || kind === 'mosaique') inner.append(box, ...(text.length ? [words2] : []));
    else inner.append(box, words2);
  }

  // la couverture et les diapositives : les mêmes en présentation et dans la mise en scène
  function slideCover(doc) {
    const cover = document.createElement('div');
    cover.className = 'rd-slide rd-cover';
    cover.innerHTML = '<div class="rd-slide-in"><h1 class="rd-title"></h1><p class="rd-sub">Utilisez → ou cliquez pour avancer</p></div>';
    $('.rd-title', cover).textContent = doc.title || 'Sans titre';
    dressSlide(cover, sceneItem(doc, 'slides', 'cover'));
    return cover;
  }
  function slideOf(doc, part) {
    const s = document.createElement('div');
    s.className = 'rd-slide';
    s.innerHTML = '<div class="rd-slide-in prose"></div>';
    $('.prose', s).append(...part.blocks);
    // une diapositive qui continue la précédente (texte trop long) garde son fond et sa mise en forme
    const set = sceneItem(doc, 'slides', part.key.split('.')[0]);
    dressSlide(s, set);
    layoutSlide(s, set.layout || '');
    return s;
  }
  // les images prennent la place que le texte de leur diapositive leur laisse : grandes seules, plus sages avec du texte
  // (mesures sans transformation : la mise en scène montre ces diapositives réduites)
  function fitSlideImages(slides) {
    for (const sl of slides) {
      // les blocs interactifs (avant/après, galerie…) gardent leurs propres images
      const imgs = $$('.rd-slide-in img', sl).filter(im => !im.closest('[data-ix], details, .ix-gal, .sl-media'));
      imgs.forEach(im => im.classList.add('sl-img'));
      const inner = $('.rd-slide-in', sl), pad = parseFloat(getComputedStyle(sl).paddingTop) + parseFloat(getComputedStyle(sl).paddingBottom);
      // un texte un peu trop long reste sur sa diapositive : il se resserre plutôt que de déborder
      if (!imgs.length) {
        inner.style.fontSize = '';
        // (mesuré sur le texte seul : à côté d'une image, c'est la hauteur de l'image qui compte sinon)
        const words = $('.sl-words', sl) || inner;
        for (let size = parseFloat(getComputedStyle(inner).fontSize); size > 15 && words.offsetHeight > sl.clientHeight - pad; size -= 1) inner.style.fontSize = size - 1 + 'px';
        continue;
      }
      imgs.forEach(im => { im.style.maxHeight = '0px'; });
      const text = inner.offsetHeight;
      const room = Math.max(140, (sl.clientHeight - pad - text - 8) / imgs.length);
      imgs.forEach(im => { im.style.maxHeight = Math.floor(room) + 'px'; });
    }
  }

  function presentSlides(doc, stage) {
    const parts = groupsOf(doc, 'slides');
    const mode = sceneOf(doc, 'slides').transition || '';
    if (mode) stage.classList.add('sl-' + mode);
    stage.innerHTML = '<div class="rd-track"></div><div class="rd-nav"><button class="rd-prev">‹</button><span class="rd-count"></span><button class="rd-next">›</button></div><button class="btn ghost rd-notes-btn" hidden>Notes</button><aside class="rd-notes" hidden></aside>';
    // les notes de l'orateur : ce que l'auteur a écrit pour chaque diapositive, affiché pour lui seul (N, ou le bouton)
    const notesOf = k => k ? (sceneItem(doc, 'slides', parts[k - 1].key.split('.')[0]).notes || '') : '';
    const anyNotes = parts.some((_, k) => notesOf(k + 1).trim());
    const nb = $('.rd-notes-btn', stage), na = $('.rd-notes', stage);
    nb.hidden = !anyNotes;
    const paintNotes = () => { const t = notesOf(i); na.textContent = t || 'Pas de note pour cette diapositive'; na.classList.toggle('empty', !t); };
    const toggleNotes = () => { na.hidden = !na.hidden; nb.classList.toggle('on', !na.hidden); paintNotes(); };
    nb.onclick = e => { e.stopPropagation(); toggleNotes(); };
    na.onclick = e => e.stopPropagation();
    const track = $('.rd-track', stage);
    track.append(slideCover(doc), ...parts.map(part => slideOf(doc, part)));
    const slides = $$('.rd-slide', track);
    hydrate(track, doc);
    const fitImages = () => fitSlideImages(slides);
    fitImages();
    $$('.rd-slide-in img', track).forEach(im => { if (!im.complete) im.addEventListener('load', fitImages, { once: true }); });
    listen(window, 'resize', fitImages);
    const n = parts.length + 1;
    let i = 0;
    const go = (to, dir) => {
      if (to >= n && nextCard(doc)) return goNextCard();
      to = Math.max(0, Math.min(n - 1, to));
      if (to === i && dir) return;
      i = to;
      if (mode) slides.forEach((x, j) => x.classList.toggle('on', j === i));
      else track.style.transform = `translateX(${-i * 100}%)`;
      // la scène prend le fond de la diapositive : la navigation reste lisible dessus
      stage.style.backgroundColor = slides[i].style.background ? getComputedStyle(slides[i]).backgroundColor : '';
      contrastSoon();
      $('.rd-count', stage).textContent = `${i + 1} / ${n}`;
      $('.rd-prev', stage).disabled = i === 0;
      $('.rd-next', stage).disabled = i === n - 1 && !nextCard(doc);
      readerEnd(i === n - 1);
      if (!na.hidden) paintNotes();
      if (dir) sound.woosh(.45, dir);
    };
    go(0);
    $('.rd-prev', stage).onclick = e => { e.stopPropagation(); go(i - 1, -1); };
    $('.rd-next', stage).onclick = e => { e.stopPropagation(); go(i + 1, 1); };
    stage.onclick = e => {
      if (rdControl(e, ', .rd-nav')) return;
      if (e.clientX < innerWidth / 3) go(i - 1, -1); else go(i + 1, 1);
    };
    let x0 = null;
    stage.onpointerdown = e => { x0 = e.clientX; };
    stage.onpointerup = e => { if (x0 != null && Math.abs(e.clientX - x0) > 60) { go(i + (e.clientX < x0 ? 1 : -1), e.clientX < x0 ? 1 : -1); stage.onclick = null; setTimeout(() => { stage.onclick = clickNav; }, 0); } x0 = null; };
    const clickNav = stage.onclick;
    reader.onKey = e => {
      if ((e.key === 'n' || e.key === 'N') && anyNotes) { toggleNotes(); return true; }
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { go(i + 1, 1); return true; }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { go(i - 1, -1); return true; }
    };
  }

  // 3. Carte à retourner : recto (titre, image), verso (le texte) ; découpée dans la mise en scène, une carte par passage
  function presentFlip(doc, stage) {
    const set = sceneOf(doc, 'flip');
    const parts = passages(doc);
    if (!parts.length) parts.push(Object.assign(document.createElement('div'), { className: 'prose' }));
    const n = parts.length, grid = n > 1 && set.layout === 'grille';
    // chaque passage devient une carte ; chaque élément va au recto ou au verso, comme l'auteur l'a réglé
    const raw = groupsOf(doc, 'flip');
    const seen = new Set();   // la suite s'annonce quand chaque carte a été retournée
    const cards = parts.map((wrap, k) => {
      const g = raw[k] || { blocks: [], key: wrap.dataset.key };
      const fs = flipSides(doc, g.blocks, k, wrap.dataset.key);
      const kids = Array.from(wrap.children);
      const rectoEls = fs.titleOnly ? [] : fs.rows.filter(r => r.side === 'r' && !r.title).map(r => kids[r.i]).filter(Boolean);
      for (const r of fs.rows) if (r.side === 'r' && !r.title && fs.titleOnly && kids[r.i]) kids[r.i].remove();
      const tone = ALL_TONES.find(c => c.id === (sceneItem(doc, 'flip', wrap.dataset.key).tone || ''));
      if (tone) quoteLine(wrap, tone.bg);
      const [bg, fg] = tone ? [tone.bg, tone.fg] : colorOf(doc);
      const rich = !fs.titleOnly && !fs.label;
      const titleOnFront = fs.rows.some(r => r.title && r.side === 'r');
      const backTitle = fs.label || (fs.rows.some(r => r.title && r.side === 'v') ? fs.titleText : '');
      const box = document.createElement('div');
      box.className = 'rd-flipbox';
      box.innerHTML = `<div class="rd-card"><div class="rd-face rd-front${rich ? ' rich' : ''}"><div class="rd-front-in"><div class="k">Toucher pour retourner</div><h1 class="rd-title"></h1></div></div><div class="rd-face rd-back"><div class="rd-scroll"><article class="page">${backTitle ? '<h1 class="rd-title"></h1>' : ''}</article></div><button class="btn ghost rd-turn">↺ Recto</button></div></div>`;
      const front = $('.rd-front', box), card = $('.rd-card', box);
      front.style.setProperty('--bg', bg);
      front.style.setProperty('--fg', fg);
      const ft = $('.rd-front .rd-title', box);
      if (rich) {
        // un recto composé : le titre de la page s'il y est, puis les éléments choisis
        if (titleOnFront) ft.textContent = fs.titleText; else ft.remove();
        if (rectoEls.length) { const pr = document.createElement('div'); pr.className = 'prose'; pr.append(...rectoEls); $('.rd-front-in', box).append(pr); }
        else if (!titleOnFront) { const t = document.createElement('h1'); t.className = 'rd-title'; t.textContent = 'Carte ' + (k + 1); $('.rd-front-in', box).append(t); }
      } else {
        ft.textContent = fs.label || doc.title || 'Sans titre';
        if (ft.textContent.length > 60) ft.classList.add('long');
      }
      const bt = $('.rd-back .rd-title', box);
      if (bt) bt.textContent = backTitle;
      $('article', box).append(wrap);
      for (const a of $$('a:not([data-goto])', box)) { a.target = '_blank'; a.rel = 'noopener'; }
      if (k === 0 && !tone && !rich && coverOf(doc)) thumbOf(doc).then(u => { if (u) { front.style.backgroundImage = `url("${u}")`; front.classList.add('img'); } });
      const flip = on => { if (card.classList.contains('flipped') === on) return; card.classList.toggle('flipped', on); sound.woosh(.55, on ? 1 : -1); if (on) seen.add(k); if (seen.size === n && !box.closest('.fl-stack')) readerEnd(true); };
      // dans le paquet, une carte voisine vient d'abord devant ; on la retourne une fois devant
      // (un bloc interactif posé au recto reste utilisable : le cliquer ne retourne pas la carte)
      front.onclick = e => { if (box.closest('.fl-stack') && !box.classList.contains('here')) return; if (rdControl(e)) return; e.stopPropagation(); flip(true); };
      $('.rd-turn', box).onclick = e => { e.stopPropagation(); flip(false); };
      return { box, card, flip };
    });

    // toutes ensemble : une table de cartes que l'on retourne une à une, la page défile
    if (grid || n === 1) {
      stage.classList.toggle('fl-grid', grid);
      const holder = document.createElement('div');
      holder.className = grid ? 'fl-cards' : 'fl-one';
      holder.append(...cards.map(c => c.box));
      stage.append(holder);
      reader.onKey = e => {
        if (n === 1 && [' ', 'Enter'].includes(e.key) && !cards[0].card.classList.contains('flipped')) { cards[0].flip(true); return true; }
      };
      return;
    }

    // une à une : le paquet, et l'on passe d'une carte à l'autre
    stage.classList.add('fl-deck');
    stage.insertAdjacentHTML('beforeend', '<div class="fl-stack"></div><div class="fl-nav"><button class="btn ghost" data-d="-1" aria-label="Carte précédente">‹</button><span></span><button class="btn ghost" data-d="1" aria-label="Carte suivante">›</button></div><div class="rd-progress"><i></i></div>');
    const stack = $('.fl-stack', stage), label = $('.fl-nav span', stage);
    stack.append(...cards.map(c => c.box));
    let cur = 0;
    const paint = dir => {
      cards.forEach((c, k) => {
        c.box.classList.toggle('here', k === cur);
        c.box.classList.toggle('before', k < cur);
        c.box.classList.toggle('after', k > cur);
        c.box.style.setProperty('--d', Math.min(3, Math.abs(k - cur)));
      });
      label.textContent = `${cur + 1} / ${n}`;
      $('.fl-nav [data-d="-1"]', stage).disabled = cur === 0;
      $('.fl-nav [data-d="1"]', stage).disabled = cur === n - 1 && !nextCard(doc);
      progress(stage, cur, n);
      if (dir) sound.woosh(.7, dir);
    };
    const to = k => { if (k >= n && nextCard(doc)) return goNextCard(); k = Math.max(0, Math.min(n - 1, k)); if (k !== cur) { const d = k > cur ? 1 : -1; cur = k; paint(d); } };
    for (const b of $$('.fl-nav [data-d]', stage)) b.onclick = e => { e.stopPropagation(); to(cur + +b.dataset.d); };
    // un clic sur une carte voisine l'amène devant
    stack.onclick = e => { const b = e.target.closest('.rd-flipbox'); if (b && !b.classList.contains('here')) to(cards.findIndex(c => c.box === b)); };
    reader.onKey = e => {
      if ([' ', 'Enter'].includes(e.key)) { const c = cards[cur]; c.flip(!c.card.classList.contains('flipped')); return true; }
      if (['ArrowRight', 'PageDown'].includes(e.key)) { to(cur + 1); return true; }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { to(cur - 1); return true; }
    };
    paint(0);
  }

  // 4. Machine à écrire : le texte s'écrit lettre par lettre ; un clic l'achève
  function presentTypewriter(doc, stage) {
    const page = readerPage(doc);
    stage.append(page);
    const art = $('article', page);
    const seq = [];
    const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if (!n.textContent.trim()) continue;
        seq.push({ node: n, text: n.textContent });
        n.textContent = '';
      } else if (/^(IMG|HR)$/.test(n.tagName) || n.classList.contains('callout-icon') || n.classList.contains('ix-blank')) {
        n.classList.add('tw-hide');
        seq.push({ el: n });
      }
    }
    // les contenants (citation, encadré, puce, surlignage…) n'apparaissent qu'avec leur premier mot
    for (const s of seq) {
      s.boxes = [];
      for (let e = (s.node || s.el).parentElement; e && e !== art; e = e.parentElement) {
        if (!e.classList.contains('tw-box')) { e.classList.add('tw-box'); s.boxes.push(e); }
      }
    }
    const showBoxes = s => { for (const e of s.boxes) e.classList.add('on'); };
    const caret = document.createElement('span');
    caret.className = 'tw-caret';
    const pace = { lent: 1.9, rapide: .45 }[sceneOf(doc, 'typewriter').speed] || 1;
    let k = 0, pos = 0, timer = null, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of seq) { if (s.node) s.node.textContent = s.text; else s.el.classList.remove('tw-hide'); showBoxes(s); }
      caret.remove();
      $('#rdHint').textContent = '';
      readerEnd(true);
    };
    const step = () => {
      if (k >= seq.length) { finish(); return; }
      const s = seq[k];
      if (s.el) { showBoxes(s); s.el.classList.remove('tw-hide'); k++; timer = setTimeout(step, 350 * pace); return; }
      if (!pos) showBoxes(s);
      pos++;
      s.node.textContent = s.text.slice(0, pos);
      s.node.after(caret);
      const ch = s.text[pos - 1];
      if (pos % 3 === 0) sound.word();
      if (caret.getBoundingClientRect().bottom > innerHeight - 80) page.scrollTop += 40;
      if (pos >= s.text.length) { k++; pos = 0; }
      timer = setTimeout(step, (/[.!?…]/.test(ch) ? 320 : /[,;:]/.test(ch) ? 140 : 22 + Math.random() * 26) * pace);
    };
    $('#rdHint').textContent = 'Cliquez pour tout afficher';
    timer = setTimeout(step, 500);
    page.addEventListener('click', e => { if (!e.target.closest('a')) finish(); });
    reader.cleanup.push(() => { done = true; clearTimeout(timer); });
    reader.onKey = e => { if ([' ', 'Enter'].includes(e.key)) { finish(); return true; } };
  }

  // 5. Phrase par phrase : une seule phrase à l'écran ; chaque clic fait place à la suivante
  function presentPhrase(doc, stage) {
    const steps = [{ kind: 'title', text: doc.title || 'Sans titre' }];
    const byPara = sceneOf(doc, 'phrase').unit === 'para';
    const split = t => byPara ? [t.replace(/\s+/g, ' ').trim()].filter(Boolean) : (t.replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["»”’)\]]*|$)/g) || []).map(s => s.trim()).filter(Boolean);
    for (const b of pageBlocks(doc)) {
      if (b.tagName === 'HR') continue;
      // un bloc interactif occupe un écran à lui seul
      if (b.matches('[data-ix], details.ix-fold') || b.querySelector('.ix-blank')) { steps.push({ kind: 'block', el: b }); continue; }
      const img = b.tagName === 'IMG' ? b : b.querySelector('img');
      if (img) { steps.push({ kind: 'img', src: img.getAttribute('src') }); if (!b.textContent.trim()) continue; }
      if (/^H[1-3]$/.test(b.tagName)) { steps.push({ kind: 'head', text: b.textContent.trim() }); continue; }
      const parts = /^(UL|OL)$/.test(b.tagName) ? Array.from(b.children).map(li => li.textContent) : [b.textContent];
      for (const p of parts) for (const s of split(p)) steps.push({ kind: b.tagName === 'BLOCKQUOTE' ? 'quote' : 'text', text: s });
    }
    // une carte choisie pour la suite prend la place de l'écran de fin
    const follow = steps.length && nextCard(doc);
    if (!follow) steps.push({ kind: 'end' });
    stage.innerHTML = '<div class="rd-phrasebox"></div><div class="rd-progress"><i></i></div>';
    const box = $('.rd-phrasebox', stage);
    let i = -1, current = null;
    const render = s => {
      const d = document.createElement('div');
      d.className = 'rd-sent rd-' + s.kind;
      if (s.kind === 'img') { const im = document.createElement('img'); im.src = s.src; d.append(im); }
      else if (s.kind === 'block') { const p = document.createElement('div'); p.className = 'prose'; p.append(s.el.cloneNode(true)); d.append(p); hydrate(d, reader.doc); }
      else if (s.kind === 'end') {
        d.innerHTML = '<div class="rd-fin">Fin</div><div class="rd-end-actions"><button class="btn ghost" data-again>Recommencer</button><button class="btn" data-close>Fermer</button></div>';
        $('[data-again]', d).onclick = e => { e.stopPropagation(); go(0); };
        $('[data-close]', d).onclick = e => { e.stopPropagation(); closeReader(); };
      } else d.textContent = s.text;
      return d;
    };
    const go = to => {
      if (follow && to >= steps.length) return goNextCard();
      to = Math.max(0, Math.min(steps.length - 1, to));
      if (to === i) return;
      i = to;
      if (current) {
        const old = current;
        old.classList.remove('in');
        old.classList.add('out');
        setTimeout(() => old.remove(), 700);
      }
      current = render(steps[i]);
      box.append(current);
      requestAnimationFrame(() => requestAnimationFrame(() => current.classList.add('in')));
      $('.rd-progress i', stage).style.width = (i / (steps.length - 1) * 100) + '%';
      readerEnd(i === steps.length - 1);
            if (i > 0) sound.word();
    };
    go(0);
    stage.onclick = e => {
      if (rdControl(e)) return;
      go(e.clientX < innerWidth / 4 ? i - 1 : i + 1);
    };
    reader.onKey = e => {
      if (['ArrowRight', ' ', 'Enter', 'PageDown'].includes(e.key)) { go(i + 1); return true; }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { go(i - 1); return true; }
    };
  }

  /*
   * Lisibilité garantie : chaque texte du lecteur est comparé à la surface réellement derrière lui
   * (contraste WCAG). En dessous de 4,5:1, il passe en sombre ou en clair, selon ce qui se lit le mieux.
   */
  const rgbaOf = s => {
    // les couleurs mélangées (color-mix) sont rendues en « color(srgb r g b / a) », entre 0 et 1
    const c = /color\(srgb ([^)]+)\)/.exec(s || '');
    if (c) { const v = c[1].split(/[\s/]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]; }
    const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
  };
  const relLum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const contrastOf = (a, b) => { const l1 = relLum(a), l2 = relLum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
  function surfaceOf(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = rgbaOf(getComputedStyle(n).backgroundColor);
      if (c && c[3] >= .5) return c;
    }
    return [246, 245, 241, 1];
  }
  // le blanc pur, parce qu'un blanc cassé ne suffit pas sur les teintes moyennes (le vermillon par exemple)
  const DARK_INK = [21, 21, 21], LIGHT_INK = [255, 255, 255];
  function ensureContrast(root) {
    const els = new Set();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() && n.parentElement) els.add(n.parentElement);
    for (const el of els) {
      el.style.removeProperty('color');
      if (el.closest('.lay-bg')) continue;   // posé sur une image : le voile sombre assure déjà la lecture
      const cs = getComputedStyle(el), col = rgbaOf(cs.color);
      if (!col || col[3] < .2) continue; // mot caché : volontairement transparent
      const bg = surfaceOf(el);
      if (contrastOf(col, bg) >= 4.5) continue;
      el.style.color = contrastOf(DARK_INK, bg) >= contrastOf(LIGHT_INK, bg) ? 'rgb(21, 21, 21)' : 'rgb(255, 255, 255)';
    }
  }
  let contrastTimer = 0;
  const contrastSoon = () => { clearTimeout(contrastTimer); contrastTimer = setTimeout(() => { if (!$('#reader').hidden) ensureContrast($('#rdStage')); }, 80); };

  function bindReader() {
    // dès que le contenu du lecteur change (passage suivant, bloc qui s'ouvre…), on revérifie
    new MutationObserver(contrastSoon).observe($('#rdStage'), { childList: true, subtree: true, attributeFilter: ['class'] });
    // un formulaire de fenêtre ne doit jamais recharger la page, même envoyé hors de son usage
    for (const f of ['#ixForm', '#askForm']) $(f).addEventListener('submit', e => e.preventDefault());
    $('#rdClose').addEventListener('click', closeReader);
    // deux clics à droite une fois au bout de la lecture : on passe à la carte qui suit. Le lien doit déjà être là au
    // premier clic : sinon, deux clics rapides sur l'avant-dernier passage sauteraient le dernier sans le lire.
    let rightTap = 0;
    $('#reader').addEventListener('click', e => {
      const here = performance.now(), right = e.clientX > innerWidth / 2 && !!$('#rdNextCard') && !rdControl(e);
      if (right && here - rightTap < 380) { rightTap = 0; goNextCard(); return; }
      rightTap = right ? here : 0;
    }, true);
    bindAnnotations();
    $('#reader').addEventListener('mousedown', e => { if (!e.target.closest('.ix-note, .ix-bubble')) $$('.ix-bubble').forEach(b => b.remove()); });
    window.addEventListener('keydown', e => {
      if ($('#reader').hidden || !$('#ixModal').hidden) return;
      if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.key !== 'Escape') return;
      // une photo agrandie passe avant la présentation : les flèches la font défiler, Échap la referme
      const light = $('#reader .ix-light');
      if (light) {
        if (e.key === 'Escape') light.remove();
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') $(e.key === 'ArrowRight' ? '.ix-l-next' : '.ix-l-prev', light).click();
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === 'Escape') { closeReader(); }
      else if (e.key === 'Enter' && $('#rdNextCard')) goNextCard();
      else if (!(reader.onKey && reader.onKey(e))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  /* ───────────── Blocs interactifs ───────────── */

  /*
   * Chaque bloc est écrit dans le HTML de la page (données en attributs), si bien qu'il voyage avec
   * l'export. Dans l'éditeur on le voit comme une maquette qu'on règle d'un clic ; dans le lecteur
   * (et donc chez la personne qui reçoit le HTML), hydrate() lui donne vie.
   */

  // Fenêtre de réglage générique (champs + actions), à la place de prompt().
  function ixDialog({ title, fields = [], actions = [], submit = 'Valider', note = '' }) {
    return new Promise(resolve => {
      const box = $('#ixModal'), form = $('#ixForm'), fbox = $('#ixFields'), acts = $('#ixActions');
      $('#ixTitle').textContent = title;
      $('#ixNote').textContent = note;
      $('#ixNote').hidden = !note;
      fbox.textContent = '';
      for (const f of fields) {
        const lab = document.createElement('label');
        lab.className = 'ix-field' + (f.half ? ' half' : '');
        const cap = document.createElement('span');
        cap.textContent = f.label;
        lab.append(cap);
        let input;
        if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = f.rows || 4; }
        else if (f.type === 'select') {
          input = document.createElement('select');
          for (const o of f.options) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; input.append(op); }
        } else if (f.type === 'swatch') {
          // le même choix de couleur que pour les cartes
          input = document.createElement('input');
          input.type = 'hidden';
          const grid = document.createElement('div');
          grid.className = 'cp-grid';
          for (const o of f.options) {
            const b = document.createElement('button');
            b.type = 'button';
            b.title = o.label;
            b.style.setProperty('--sw', o.value);
            b.classList.toggle('on', o.value === f.value);
            b.onclick = e => { e.preventDefault(); input.value = o.value; for (const x of grid.children) x.classList.toggle('on', x === b); };
            grid.append(b);
          }
          lab.append(grid);
        } else { input = document.createElement('input'); input.type = f.type || 'text'; }
        input.name = f.name;
        input.value = f.value == null ? '' : f.value;
        if (f.placeholder) input.placeholder = f.placeholder;
        lab.append(input);
        fbox.append(lab);
      }
      acts.textContent = '';
      const done = v => { box.hidden = true; form.onsubmit = null; box.onkeydown = null; resolve(v); };
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost' + (a.danger ? ' danger' : '');
        b.textContent = a.label;
        b.onclick = () => done({ action: a.value });
        acts.append(b);
      }
      const spacer = document.createElement('span');
      spacer.className = 'ix-spacer';
      acts.append(spacer);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn ghost';
      cancel.textContent = 'Annuler';
      cancel.onclick = () => done(null);
      const ok = document.createElement('button');
      ok.type = 'submit';
      ok.className = 'btn';
      ok.textContent = submit;
      acts.append(cancel, ok);
      form.onsubmit = e => {
        e.preventDefault();
        const v = {};
        for (const f of fields) v[f.name] = form.elements[f.name].value;
        done({ values: v });
      };
      box.onmousedown = e => { if (e.target === box) done(null); };
      box.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      box.hidden = false;
      setTimeout(() => { const first = $('input, textarea, select', fbox); if (first) first.focus(); }, 30);
    });
  }

  const ixId = () => 'ix' + uid();
  const allDocs = () => state.spaces.flatMap(sp => sp.docs.map(d => ({ d, sp })));
  const findDoc = id => (allDocs().find(x => x.d.id === id) || {}).d || null;
  function cardOptions(blank) {
    const out = blank ? [{ value: '', label: '—' }] : [];
    for (const { d, sp } of allDocs()) {
      if (edDoc && d.id === edDoc.id) continue;
      out.push({ value: d.id, label: pathOf(sp).map(s => s.title).join(' / ') + ' — ' + (d.title || 'Sans titre') });
    }
    return out;
  }

  // Quiz : un format simple à écrire. Une question par paragraphe, « * » devant la bonne réponse.
  function parseQuiz(t) {
    const qs = [];
    for (const chunk of t.split(/\n\s*\n/)) {
      const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const q = { q: lines[0], options: [], correct: -1 };
      for (const l of lines.slice(1)) {
        const m = /^([*+✓-])\s*(.+)$/.exec(l);
        if (!m) continue;
        if (m[1] !== '-') q.correct = q.options.length;
        q.options.push(m[2]);
      }
      if (q.options.length >= 2) { if (q.correct < 0) q.correct = 0; qs.push(q); }
    }
    return qs;
  }
  const quizText = qs => qs.map(q => [q.q, ...q.options.map((o, i) => (i === q.correct ? '* ' : '- ') + o)].join('\n')).join('\n\n');
  const json = el => { try { return JSON.parse(el); } catch (e) { return null; } };

  const BREATH_PATTERNS = [
    { value: '4-4-6', label: '4-4-6, apaisant' },
    { value: '4-7-8', label: '4-7-8, pour s’endormir' },
    { value: '5-5', label: '5-5, cohérence cardiaque' },
    { value: '4-4-4-4', label: '4-4-4-4, respiration carrée' }
  ];

  // Trou à compléter : un blanc dans la phrase, que le lecteur remplit comme il veut (aucune bonne réponse)
  const BLANK_NOTE = 'Il n’y a pas de bonne réponse : le lecteur complète librement, et ce qu’il écrit reste dans son navigateur.';
  const BLANK_SIZES = [{ value: 's', label: 'Court (un mot)' }, { value: 'm', label: 'Moyen' }, { value: 'l', label: 'Long (une phrase)' }];
  const blankFields = v => [
    { name: 'hint', label: 'Indice affiché dans le trou (facultatif)', value: v.hint || '', placeholder: 'par exemple : un souvenir' },
    { name: 'size', label: 'Longueur', type: 'select', value: v.size || 'm', options: BLANK_SIZES }
  ];
  const blankHTML = (v, id) => `<span class="ix-blank" contenteditable="false" data-id="${id}" data-hint="${esc(v.hint.trim())}" data-size="${esc(v.size || 'm')}">${esc(v.hint.trim()) || '……'}</span>`;

  /* ── Les graphiques : une ligne « libellé : valeur » par donnée, dessinée dans la page ── */
  const CHART_COLORS = ['#c93470', '#161616', '#d9a441', '#2f4a3a', '#a8593a', '#1f2a44', '#8a8f79'];
  const chartRows = text => (text || '').split('\n').map(l => {
    const m = l.trim().match(/^(.*?)[\s:;=]+(\d[\d\s.,]*)\s*(\S{0,3})$/);
    if (!m) return null;
    const value = parseFloat(m[2].replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(value) ? { label: m[1].trim(), value, unit: m[3] } : null;
  }).filter(Boolean);
  const chartNum = v => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

  function chartHTML(kind, rows) {
    const sum = rows.reduce((n, r) => n + r.value, 0), top = Math.max(...rows.map(r => r.value));
    if (kind !== 'pie') return `<div class="ch-bars">${rows.map(r => `<div class="ch-row"><span>${esc(r.label)}</span><i><b style="width:${top ? r.value / top * 100 : 0}%"></b></i><em>${esc(chartNum(r.value) + (r.unit ? ' ' + r.unit : ''))}</em></div>`).join('')}</div>`;
    let at = 0;
    const part = r => r.value / (sum || 1) * 100;
    const arcs = rows.map((r, i) => {
      const s = `<circle cx="50" cy="50" r="25" pathLength="100" stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-dasharray="${(part(r) + .2).toFixed(3)} 100" stroke-dashoffset="${(-at).toFixed(3)}"/>`;
      at += part(r);
      return s;
    }).join('');
    const legend = rows.map((r, i) => `<div class="ch-leg"><u style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></u><span>${esc(r.label)}</span><em>${chartNum(Math.round(part(r) * 10) / 10)} %</em></div>`).join('');
    return `<div class="ch-pie"><svg viewBox="0 0 100 100" aria-hidden="true">${arcs}</svg><div>${legend}</div></div>`;
  }

  /* Chaque type : champs de réglage, lecture d'un bloc existant, construction du HTML. */
  const IX = {
    map: {
      title: 'Mapping',
      note: 'Cliquez ensuite sur le plan pour placer un point, et glissez-le pour le déplacer.',
      fields: v => [
        { name: 'title', label: 'Titre (facultatif)', value: v.title || '' },
        { name: 'x', label: 'Axe horizontal', value: v.x || '', placeholder: 'par exemple : Prix', half: true },
        { name: 'y', label: 'Axe vertical', value: v.y || '', placeholder: 'par exemple : Qualité', half: true }
      ],
      read: el => ({ title: el.dataset.title || '', x: el.dataset.x || '', y: el.dataset.y || '', points: JSON.parse(el.dataset.points || '[]') }),
      build: (v, id) => {
        const pts = v.points || [];
        return `<div class="ix-chart ix-map" contenteditable="false" data-ix="map" data-id="${id}" data-title="${esc(v.title)}" data-x="${esc(v.x)}" data-y="${esc(v.y)}" data-points="${esc(JSON.stringify(pts))}">${v.title.trim() ? `<div class="ch-title">${esc(v.title)}</div>` : ''}`
          + `<div class="mp-plot"><span class="mp-axis mp-x">${esc(v.x)}</span><span class="mp-axis mp-y">${esc(v.y)}</span>${pts.map((p, i) => `<span class="mp-pt${p.x > 72 ? ' left' : ''}" data-i="${i}" style="left:${p.x}%;top:${p.y}%"><u${p.c ? ` style="background:${esc(p.c)}"` : ''}></u><span>${esc(p.n)}</span></span>`).join('')}</div></div>`;
      }
    },
    chart: {
      title: 'Graphique',
      note: 'Une donnée par ligne, par exemple : Janvier : 12',
      fields: v => [
        { name: 'kind', label: 'Forme', type: 'select', value: v.kind || 'bar', options: [{ value: 'bar', label: 'Barres' }, { value: 'pie', label: 'Camembert' }] },
        { name: 'title', label: 'Titre (facultatif)', value: v.title || '' },
        { name: 'data', label: 'Données', type: 'textarea', rows: 6, value: v.data || '' }
      ],
      read: el => ({ kind: el.dataset.kind, title: el.dataset.title || '', data: el.dataset.data || '' }),
      build: (v, id) => {
        const rows = chartRows(v.data);
        return rows.length ? `<div class="ix-chart" contenteditable="false" data-ix="chart" data-id="${id}" data-kind="${esc(v.kind)}" data-title="${esc(v.title)}" data-data="${esc(v.data)}">${v.title.trim() ? `<div class="ch-title">${esc(v.title)}</div>` : ''}${chartHTML(v.kind, rows)}</div>` : '';
      }
    },
    scratch: {
      title: 'Carte à gratter',
      fields: v => [{ name: 'label', label: 'Inscription sur la surface', value: v.label || 'Grattez ici' }, { name: 'text', label: 'Texte caché', type: 'textarea', rows: 3, value: v.text || '' }],
      read: el => ({ label: el.dataset.label, text: el.dataset.text || '', src: el.dataset.src || '' }),
      build: (v, id) => (v.text.trim() || v.src)
        ? `<div class="ix-scratch" contenteditable="false" data-ix="scratch" data-id="${id}" data-label="${esc(v.label)}" data-text="${esc(v.text)}"${v.src ? ` data-src="${esc(v.src)}"` : ''}><div class="ix-sc-content">${v.src ? `<img src="${esc(v.src)}">` : esc(v.text).split('\n').map(l => `<p>${l}</p>`).join('')}</div></div>` : null
    },
    riddle: {
      title: 'Énigme',
      note: 'Séparez les réponses par « / »',
      fields: v => [
        { name: 'q', label: 'Énigme', type: 'textarea', rows: 3, value: v.q || '' },
        { name: 'a', label: 'Réponse(s) acceptée(s)', value: v.a || '' },
        { name: 'hint', label: 'Indice (facultatif)', value: v.hint || '' },
        { name: 'reveal', label: 'Texte révélé par la bonne réponse', type: 'textarea', rows: 3, value: v.reveal || '' },
        { name: 'gate', label: 'Suite de la page', type: 'select', value: v.gate || '0', options: [{ value: '0', label: 'Toujours visible' }, { value: '1', label: 'Cachée jusqu’à la bonne réponse' }], half: true },
        { name: 'to', label: 'Ouvre ensuite la carte', type: 'select', value: v.to || '', options: cardOptions(true), half: true }
      ],
      read: el => ({ q: el.dataset.q, a: el.dataset.a || '', hint: el.dataset.hint || '', reveal: el.dataset.reveal || '', gate: el.dataset.gate || '0', to: el.dataset.to || '' }),
      build: (v, id) => (v.q.trim() && v.a.trim())
        ? `<div class="ix-riddle" contenteditable="false" data-ix="riddle" data-id="${id}" data-q="${esc(v.q)}" data-a="${esc(v.a)}" data-hint="${esc(v.hint)}" data-reveal="${esc(v.reveal)}" data-gate="${esc(v.gate)}" data-to="${esc(v.to)}"><div class="ix-q">${esc(v.q)}</div><div class="ix-rd-answer">Réponse : ${esc(v.a)}</div></div>` : null
    },
    gallery: {
      read: el => ({ srcs: $$('img', el).map(i => i.getAttribute('src')) }),
      build: (v, id) => v.srcs.length ? `<div class="ix-gallery" contenteditable="false" data-ix="gallery" data-id="${id}">${v.srcs.map(s => `<img src="${esc(s)}">`).join('')}</div>` : null
    },
    compare: {
      title: 'Avant / après',
      fields: v => [{ name: 'la', label: 'Étiquette de gauche', value: v.la || 'Avant', half: true }, { name: 'lb', label: 'Étiquette de droite', value: v.lb || 'Après', half: true }],
      read: el => ({ a: $('.ix-a', el).getAttribute('src'), b: $('.ix-b', el).getAttribute('src'), la: el.dataset.la, lb: el.dataset.lb }),
      build: (v, id) => `<div class="ix-compare" contenteditable="false" data-ix="compare" data-id="${id}" data-la="${esc(v.la)}" data-lb="${esc(v.lb)}"><img class="ix-a" src="${esc(v.a)}"><img class="ix-b" src="${esc(v.b)}"><span class="ix-la">${esc(v.la)}</span><span class="ix-lb">${esc(v.lb)}</span></div>`
    },
    choices: {
      title: 'Chemin à choix',
      note: 'Chaque choix mène à une autre carte.',
      fields: v => [{ name: 'intro', label: 'Texte avant les choix', value: v.intro == null ? 'Où aller maintenant ?' : v.intro }]
        .concat(...[0, 1, 2, 3].map(i => [
          { name: 'l' + i, label: 'Choix ' + (i + 1), value: (v.opts && v.opts[i] && v.opts[i].label) || '', placeholder: i < 2 ? 'Libellé du bouton' : 'facultatif', half: true },
          { name: 't' + i, label: 'Mène à', type: 'select', options: cardOptions(true), value: (v.opts && v.opts[i] && v.opts[i].to) || '', half: true }
        ])),
      read: el => ({ intro: ($('.ix-q', el) || {}).textContent || '', opts: $$('.ix-opt', el).map(a => ({ label: a.textContent, to: a.dataset.goto })) }),
      build: (v, id) => {
        const opts = v.opts || [0, 1, 2, 3].map(i => ({ label: (v['l' + i] || '').trim(), to: v['t' + i] })).filter(o => o.label && o.to);
        if (!opts.length) return null;
        return `<div class="ix-choices" contenteditable="false" data-ix="choices" data-id="${id}"><p class="ix-q">${esc(v.intro)}</p><div class="ix-opts">${opts.map(o => `<a class="ix-opt" data-goto="${esc(o.to)}" href="#">${esc(o.label)}</a>`).join('')}</div></div>`;
      }
    },
    answer: {
      title: 'Zone de réponse',
      fields: v => [{ name: 'q', label: 'Question', type: 'textarea', rows: 2, value: v.q || '' }, { name: 'ph', label: 'Texte d’aide dans la zone', value: v.ph || 'Écrivez ici…' }],
      read: el => ({ q: el.dataset.q, ph: el.dataset.ph }),
      build: (v, id) => v.q.trim() ? `<div class="ix-answer" contenteditable="false" data-ix="answer" data-id="${id}" data-q="${esc(v.q)}" data-ph="${esc(v.ph)}"><div class="ix-q">${esc(v.q)}</div><div class="ix-area">${esc(v.ph)}</div></div>` : null
    },
    quiz: {
      title: 'Quiz',
      note: '« - » mauvaise réponse, « * » bonne réponse',
      fields: v => [{ name: 'text', label: 'Questions', type: 'textarea', rows: 11, value: v.qs ? quizText(v.qs) : 'Quelle est la couleur du ciel par temps clair ?\n- Vert\n* Bleu\n- Rouge\n\nCombien de saisons compte une année ?\n- Deux\n- Trois\n* Quatre' }],
      read: el => ({ qs: json(el.dataset.quiz) || [] }),
      build: (v, id) => {
        const qs = v.qs || parseQuiz(v.text || '');
        if (!qs.length) return null;
        return `<div class="ix-quiz" contenteditable="false" data-ix="quiz" data-id="${id}" data-quiz="${esc(JSON.stringify(qs))}">`
          + qs.map(q => `<div class="ix-qz-item"><div class="ix-qz-q">${esc(q.q)}</div><ul>${q.options.map((o, i) => `<li class="${i === q.correct ? 'good' : ''}">${esc(o)}</li>`).join('')}</ul></div>`).join('') + '</div>';
      }
    },
    check: {
      title: 'Liste à cocher par le lecteur',
      fields: v => [{ name: 'title', label: 'Titre (facultatif)', value: v.title || '' }, { name: 'items', label: 'Éléments, un par ligne', type: 'textarea', rows: 6, value: (v.items || []).join('\n') }],
      read: el => ({ title: el.dataset.title || '', items: json(el.dataset.items) || [] }),
      build: (v, id) => {
        const items = Array.isArray(v.items) ? v.items : v.items.split('\n').map(s => s.trim()).filter(Boolean);
        if (!items.length) return null;
        return `<div class="ix-check" contenteditable="false" data-ix="check" data-id="${id}" data-title="${esc(v.title)}" data-items="${esc(JSON.stringify(items))}">${v.title ? `<div class="ix-q">${esc(v.title)}</div>` : ''}<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
      }
    },
    breathe: {
      title: 'Pause respiration',
      fields: v => [
        { name: 'text', label: 'Phrase d’invitation', value: v.text || 'Prenez un moment pour respirer.' },
        { name: 'min', label: 'Durée', type: 'select', value: v.min || '2', options: ['1', '2', '3', '5'].map(m => ({ value: m, label: m + ' min' })), half: true },
        { name: 'pattern', label: 'Rythme', type: 'select', value: v.pattern || '4-4-6', options: BREATH_PATTERNS, half: true }
      ],
      read: el => ({ text: el.dataset.text, min: el.dataset.min, pattern: el.dataset.pattern }),
      build: (v, id) => `<div class="ix-breathe" contenteditable="false" data-ix="breathe" data-id="${id}" data-text="${esc(v.text)}" data-min="${esc(v.min)}" data-pattern="${esc(v.pattern)}"><div class="ix-br-text">${esc(v.text)}</div><div class="ix-br-circle"><span>Respirer</span></div><div class="ix-br-time">${esc(v.min)} min, ${esc(v.pattern.split('-').join('-'))}</div></div>`
    }
  };

  async function chooseImages() {
    try {
      const srcs = NATIVE ? await call('pickImages') : await Promise.all((await browserPick('image/*', true)).map(fileToDataURL));
      return (srcs || []).filter(Boolean);
    } catch (e) { toast('Image impossible à lire'); return []; }
  }

  function noOtherCard() {
    if (cardOptions().length) return false;
    toast('Créez d’abord d’autres cartes à relier');
    return true;
  }

  // insertion depuis le menu « / »
  async function ixInsert(type, preset = {}) {
    saveRange();
    const id = ixId();
    let html = null;
    if (type === 'fold') {
      html = `<details class="ix-fold" open data-id="${id}"><summary>Titre à déplier</summary><div class="ix-fold-body"><p>Contenu révélé au clic…</p></div></details>`;
    } else if (type === 'hide') {
      insertHTMLAtSelection(`<span class="ix-hide" data-id="${id}">mot caché</span>&nbsp;`);
      const s = $(`[data-id="${id}"]`, edBody());
      if (s) { const r = document.createRange(); r.selectNodeContents(s); document.getSelection().removeAllRanges(); document.getSelection().addRange(r); saveRange(); }
      return;
    } else if (type === 'blank') {
      const r = await ixDialog({ title: 'Trou à compléter', note: BLANK_NOTE, fields: blankFields({}), submit: 'Insérer' });
      if (!r || !r.values) return;
      return insertHTMLAtSelection(blankHTML(r.values, id) + '&nbsp;');
    } else if (type === 'note') {
      const r = await ixDialog({ title: 'Note en marge', fields: [{ name: 'word', label: 'Mot ou passage', value: '' }, { name: 'note', label: 'Note', type: 'textarea', rows: 3 }], submit: 'Insérer' });
      if (!r || !r.values || !r.values.word.trim()) return;
      return insertHTMLAtSelection(`<span class="ix-note" data-id="${id}" data-note="${esc(r.values.note)}">${esc(r.values.word.trim())}</span>&nbsp;`);
    } else if (type === 'goto') {
      if (noOtherCard()) return;
      const r = await ixDialog({ title: 'Lien vers une carte', fields: [{ name: 'to', label: 'Carte', type: 'select', options: cardOptions() }, { name: 'text', label: 'Texte du lien (facultatif)', placeholder: 'le titre de la carte' }], submit: 'Insérer' });
      if (!r || !r.values) return;
      const d = findDoc(r.values.to);
      return insertHTMLAtSelection(`<a class="ix-goto" data-goto="${esc(r.values.to)}" href="#">${esc(r.values.text.trim() || (d && d.title) || 'Voir la carte')}</a>&nbsp;`);
    } else if (type === 'gallery') {
      const srcs = await chooseImages();
      if (!srcs.length) return;
      html = IX.gallery.build({ srcs }, id);
    } else if (type === 'compare') {
      toast('Choisissez deux images : avant, puis après');
      const srcs = await chooseImages();
      if (srcs.length < 2) return toast('Il faut deux images');
      html = IX.compare.build({ a: srcs[0], b: srcs[1], la: 'Avant', lb: 'Après' }, id);
    } else {
      if (type === 'choices' && noOtherCard()) return;
      const T = IX[type];
      const r = await ixDialog({ title: T.title, note: T.note, fields: T.fields(preset), submit: 'Insérer', actions: type === 'scratch' ? [{ label: 'Cacher une image', value: 'image' }] : [] });
      if (!r) return;
      if (r.action === 'image') {
        const srcs = await chooseImages();
        if (!srcs.length) return;
        html = T.build({ label: 'Grattez ici', text: '', src: srcs[0] }, id);
      } else html = T.build(r.values, id);
      if (!html) return toast('Bloc vide : rien n’a été inséré');
    }
    histCommit();
    insertHTMLAtSelection(html + '<p><br></p>');
    histCommit();
  }

  /* ── Les tableaux : un vrai tableau dans le texte, la première ligne sert d'en-tête ── */
  const tableCell = tag => { const c = document.createElement(tag); c.append(document.createElement('br')); return c; };

  function tableInsert() {
    restoreRange();
    const n = document.getSelection().anchorNode;
    if (n && (n.nodeType === 1 ? n : n.parentElement).closest('td, th')) return toast('Un tableau ne se place pas dans un autre');
    const id = ixId(), row = tag => `<tr>${`<${tag}><br></${tag}>`.repeat(3)}</tr>`;
    histCommit();
    insertHTMLAtSelection(`<table class="tb" data-id="${id}"><tbody>${row('th')}${row('td')}${row('td')}</tbody></table><p><br></p>`);
    const t = $(`table[data-id="${id}"]`, edBody());
    if (t) { const p = t.parentElement; if (p.tagName === 'P') p.replaceWith(...p.childNodes); caretInto($('th', t), false); }
    ensureTrailingParagraph();
    saveRange();
    histCommit();
  }

  // sous la ligne et à droite de la colonne survolées (ou du curseur, au doigt), un petit + en ajoute une
  const tbPlus = {};
  function tablePlus(cell) {
    if (!tbPlus.row) for (const [k, label, title] of [['row', 'Ligne en dessous', 'Ajouter une ligne'], ['col', 'Colonne à droite', 'Ajouter une colonne']]) {
      const b = tbPlus[k] = document.createElement('button');
      b.className = 'tb-plus';
      b.textContent = '+';
      b.title = title;
      b.hidden = true;
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => { if (tbPlus.cell) tableItems(tbPlus.cell).find(i => i.label === label).act(); tablePlus(tbPlus.cell); });
      document.body.append(b);
    }
    tbPlus.cell = cell;
    tbPlus.row.hidden = tbPlus.col.hidden = !cell;
    if (!cell) return;
    const c = cell.getBoundingClientRect(), t = cell.closest('table').getBoundingClientRect();
    tbPlus.row.style.cssText = `left:${t.left - 11}px;top:${c.bottom - 11}px`;
    tbPlus.col.style.cssText = `left:${c.right - 11}px;top:${t.top - 11}px`;
  }

  // tirer le bord droit d'une case change la largeur de sa colonne, tirer son bord bas la hauteur de sa ligne
  const tableEdge = (e, cell) => {
    const r = cell.getBoundingClientRect();
    if (cell.nextElementSibling && r.right - e.clientX < 6) return 'col';
    return r.bottom - e.clientY < 6 ? 'row' : '';
  };

  function tableResize(e) {
    const cell = e.target.closest && e.target.closest('#edBody td, #edBody th');
    const edge = cell && e.button === 0 && tableEdge(e, cell);
    if (!edge) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    histCommit();
    const table = cell.closest('table'), row = cell.parentElement, x0 = e.clientX, y0 = e.clientY;
    const heads = [...table.rows[0].cells], total = table.getBoundingClientRect().width;
    const w0 = heads.map(c => c.getBoundingClientRect().width / total * 100), i = cell.cellIndex, h0 = row.getBoundingClientRect().height;
    heads.forEach((c, k) => { c.style.width = w0[k] + '%'; });
    const move = m => {
      if (edge === 'row') { row.cells[0].style.height = Math.max(24, h0 + m.clientY - y0) + 'px'; return; }
      const d = Math.max(5 - w0[i], Math.min(w0[i + 1] - 5, (m.clientX - x0) / total * 100));
      heads[i].style.width = w0[i] + d + '%';
      heads[i + 1].style.width = w0[i + 1] - d + '%';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); changed(); histCommit(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /* Le mapping se manipule directement : un clic sur le plan pose un point, on le glisse, un clic dessus le renomme. */
  const MAP_COLORS = [['#c93470', 'Rose'], ['#161616', 'Encre'], ['#2f7fd6', 'Azur'], ['#128a8a', 'Lagon'], ['#17805a', 'Émeraude'], ['#d9a441', 'Ocre'], ['#ef8a2c', 'Mandarine'], ['#f0705a', 'Corail'], ['#5a3fc0', 'Violet'], ['#8a8f79', 'Olive']].map(([value, label]) => ({ value, label }));
  function mapSave(el, v) {
    histCommit();
    el.outerHTML = IX.map.build(v, el.dataset.id || ixId());
    changed();
    histCommit();
  }

  function mapPointer(e) {
    const plot = e.target.closest('#edBody .mp-plot');
    if (!plot || e.button) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = plot.closest('.ix-map'), v = IX.map.read(el), pt = e.target.closest('.mp-pt'), r = plot.getBoundingClientRect();
    const at = m => ({ x: Math.round(Math.max(0, Math.min(100, (m.clientX - r.left) / r.width * 100)) * 10) / 10, y: Math.round(Math.max(0, Math.min(100, (m.clientY - r.top) / r.height * 100)) * 10) / 10 });
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, last = at(e);
    const move = m => {
      moved = moved || Math.hypot(m.clientX - x0, m.clientY - y0) > 4;
      if (!moved || !pt) return;
      last = at(m);
      pt.style.left = last.x + '%';
      pt.style.top = last.y + '%';
    };
    const up = async () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (pt && moved) { Object.assign(v.points[+pt.dataset.i], last); return mapSave(el, v); }
      if (moved) return;
      const cur = pt ? v.points[+pt.dataset.i] : null;
      const d = await ixDialog({ title: cur ? 'Point' : 'Nouveau point', fields: [{ name: 'n', label: 'Nom', value: cur ? cur.n : '' }, { name: 'c', label: 'Couleur', type: 'swatch', value: cur ? cur.c || '#c93470' : '#c93470', options: MAP_COLORS }], submit: cur ? 'Valider' : 'Ajouter', actions: cur ? [{ label: 'Supprimer', value: 'delete', danger: true }] : [] });
      if (!d) return;
      if (d.action === 'delete') v.points.splice(+pt.dataset.i, 1);
      else if (!d.values.n.trim()) return;
      else if (cur) Object.assign(cur, { n: d.values.n.trim(), c: d.values.c });
      else v.points.push({ n: d.values.n.trim(), c: d.values.c, ...last });
      mapSave(el, v);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  function tableEdit(fn) { histCommit(); fn(); for (const t of $$('table', edBody())) tableTotals(t); changed(); histCommit(); }

  function tableRow(cell, after) {
    const tr = cell.parentElement, n = tr.cloneNode(false);
    n.removeAttribute('class');
    for (let i = 0; i < tr.cells.length; i++) n.append(tableCell('td'));
    // la ligne de total reste la dernière
    if (tr.classList.contains('tot')) tr.before(n); else tr[after ? 'after' : 'before'](n);
  }

  // un nombre écrit à la française (« 1 250,5 », « 12 % », « 30 € ») ; NaN sinon
  function cellNum(t) {
    t = (t || '').replace(/[\s\u00a0\u202f€$%]/g, '');
    if (!/^[-+]?[\d.,]+$/.test(t)) return NaN;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    return parseFloat(t);
  }
  // les lignes de données : sans l'en-tête (cellules de titre) ni la ligne de total
  const tableBody = table => Array.from(table.rows).filter((r, i) => !r.classList.contains('tot') && !(i === 0 && r.cells[0] && r.cells[0].tagName === 'TH'));
  function tableSort(table, col, dir) {
    const rows = tableBody(table), key = r => (r.cells[col] || {}).textContent || '';
    const nums = rows.every(r => !key(r).trim() || !isNaN(cellNum(key(r))));
    rows.sort((a, b) => dir * (nums ? (cellNum(key(a)) || 0) - (cellNum(key(b)) || 0) : key(a).localeCompare(key(b), 'fr', { numeric: true, sensitivity: 'base' })));
    const tot = table.querySelector('tr.tot'), host = rows[0] && rows[0].parentElement;
    for (const r of rows) host.insertBefore(r, tot && tot.parentElement === host ? tot : null);
  }
  // la ligne de total additionne chaque colonne de nombres ; les autres restent vides (la première dit « Total »)
  function tableTotals(table) {
    const tot = table.querySelector('tr.tot');
    if (!tot) return;
    const rows = tableBody(table);
    Array.from(tot.cells).forEach((c, i) => {
      const vals = rows.map(r => r.cells[i] ? r.cells[i].textContent.trim() : '').filter(Boolean);
      const ok = vals.length && vals.every(v => !isNaN(cellNum(v)));
      const sum = ok ? vals.reduce((t, v) => t + cellNum(v), 0) : null;
      const text = sum != null ? sum.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : i === 0 ? 'Total' : '';
      if (c.textContent !== text) c.textContent = text;
    });
  }

  function tableItems(cell) {
    const tr = cell.parentElement, table = tr.closest('table'), col = cell.cellIndex;
    const gone = () => { if (!table.rows.length || !table.rows[0].cells.length) table.remove(); ensureTrailingParagraph(); };
    const colAdd = after => tableEdit(() => { for (const r of table.rows) { const c = r.cells[col]; c[after ? 'after' : 'before'](tableCell(c.tagName)); } for (const c of table.rows[0].cells) c.style.width = ''; });
    return [
      { label: 'Ligne au-dessus', off: tr === table.rows[0], act: () => tableEdit(() => tableRow(cell, false)) },
      { label: 'Ligne en dessous', act: () => tableEdit(() => tableRow(cell, true)) },
      { label: 'Colonne à gauche', act: () => colAdd(false) },
      { label: 'Colonne à droite', act: () => colAdd(true) },
      '-',
      { label: 'Trier de A à Z', off: !tableBody(table).length, act: () => tableEdit(() => tableSort(table, col, 1)) },
      { label: 'Trier de Z à A', off: !tableBody(table).length, act: () => tableEdit(() => tableSort(table, col, -1)) },
      { label: 'Fusionner avec la cellule de droite', off: !cell.nextElementSibling, act: () => tableEdit(() => {
        const n = cell.nextElementSibling;
        if (n.textContent.trim()) { if (cell.textContent.trim()) cell.append(' '); cell.append(...n.childNodes); }
        cell.colSpan += n.colSpan;
        n.remove();
      }) },
      { label: 'Séparer la cellule', off: cell.colSpan < 2, act: () => tableEdit(() => { for (let i = 1; i < cell.colSpan; i++) cell.after(tableCell(cell.tagName)); cell.colSpan = 1; }) },
      { label: table.querySelector('tr.tot') ? 'Retirer la ligne de total' : 'Ajouter une ligne de total', act: () => tableEdit(() => {
        const t = table.querySelector('tr.tot');
        if (t) return t.remove();
        const row = document.createElement('tr');
        row.className = 'tot';
        for (const c of table.rows[0].cells) { const n = tableCell('td'); n.colSpan = c.colSpan; row.append(n); }
        (table.tBodies[0] || table).append(row);
        tableTotals(table);
      }) },
      '-',
      { label: 'Supprimer la ligne', act: () => tableEdit(() => { tr.remove(); gone(); }) },
      { label: 'Supprimer la colonne', act: () => tableEdit(() => { for (const r of table.rows) r.cells[col].remove(); gone(); }) },
      { label: 'Supprimer le tableau', danger: true, act: () => removeEl(table) }
    ];
  }

  // Tab passe à la cellule suivante (une ligne s'ajoute après la dernière), Entrée revient à la ligne dans la cellule
  function tableKeys(e) {
    if (e.key !== 'Tab' && e.key !== 'Enter') return;
    const from = document.getSelection().anchorNode, cap = from && (from.nodeType === 1 ? from : from.parentElement).closest('#edBody p.cap');
    // Entrée quitte la légende : on continue sur une ligne de texte normale
    if (cap && e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = emptyParagraph();
      cap.after(next);
      caretInto(next, false);
      return changed();
    }
    const n = document.getSelection().anchorNode, cell = n && (n.nodeType === 1 ? n : n.parentElement).closest('#edBody td, #edBody th');
    if (!cell) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') return void document.execCommand('insertLineBreak');
    const all = $$('td, th', cell.closest('table')), i = all.indexOf(cell) + (e.shiftKey ? -1 : 1);
    if (i < 0) return;
    if (!all[i]) tableEdit(() => tableRow(cell, true));
    caretInto(all[i] || cell.parentElement.nextElementSibling.cells[0], false);
  }

  // modification d'un bloc existant, d'un clic dans l'éditeur
  async function ixEdit(el) {
    const del = [{ label: 'Supprimer', value: 'delete', danger: true }];
    const unwrap = () => el.replaceWith(document.createTextNode(el.textContent));
    let r;
    if (el.classList.contains('ix-blank')) {
      r = await ixDialog({ title: 'Trou à compléter', note: BLANK_NOTE, fields: blankFields({ hint: el.dataset.hint, size: el.dataset.size }), actions: [{ label: 'Retirer le trou', value: 'delete', danger: true }] });
      if (!r) return;
      if (r.action) el.remove(); else el.outerHTML = blankHTML(r.values, el.dataset.id || ixId());
    } else if (el.classList.contains('ix-note')) {
      r = await ixDialog({ title: 'Note en marge', fields: [{ name: 'word', label: 'Mot ou passage', value: el.textContent }, { name: 'note', label: 'Note', type: 'textarea', rows: 3, value: el.dataset.note }], actions: [{ label: 'Retirer la note', value: 'delete', danger: true }] });
      if (!r) return;
      if (r.action) unwrap(); else { el.textContent = r.values.word; el.dataset.note = r.values.note; }
    } else if (el.classList.contains('ix-goto')) {
      r = await ixDialog({ title: 'Lien vers une carte', fields: [{ name: 'to', label: 'Carte', type: 'select', options: cardOptions(), value: el.dataset.goto }, { name: 'text', label: 'Texte du lien', value: el.textContent }], actions: [{ label: 'Retirer le lien', value: 'delete', danger: true }] });
      if (!r) return;
      if (r.action) unwrap(); else { el.dataset.goto = r.values.to; el.textContent = r.values.text || (findDoc(r.values.to) || {}).title || 'Voir la carte'; }
    } else if (el.dataset.ix === 'gallery') {
      r = await ixDialog({ title: 'Galerie', note: 'Cliquez sur une image de la galerie pour la retirer.', actions: [{ label: 'Ajouter des images', value: 'add' }].concat(del), submit: 'OK' });
      if (!r) return;
      if (r.action === 'delete') el.remove();
      else if (r.action === 'add') { const srcs = await chooseImages(); for (const s of srcs) { const im = document.createElement('img'); im.src = s; el.append(im); } }
    } else {
      const type = el.dataset.ix, T = IX[type];
      if (!T || !T.fields) return;
      const cur = T.read(el);
      r = await ixDialog({ title: T.title, note: T.note, fields: T.fields(cur), actions: del });
      if (!r) return;
      if (r.action === 'delete') el.remove();
      else {
        const html = T.build(Object.assign({}, cur, r.values, type === 'choices' ? { opts: null } : {}, type === 'quiz' ? { qs: null } : {}), el.dataset.id || ixId());
        if (html) el.outerHTML = html; else toast('Bloc vide : modification ignorée');
      }
    }
    histCommit();
    changed();
    histCommit();
  }

  /* ── Loupe : sous le curseur, le détail de l'image, agrandi ── */

  function zoomable(im) {
    im.classList.add('ix-zoom');
    let lens = null;
    const Z = 2.6;
    const place = e => {
      const r = im.getBoundingClientRect();
      if (!r.width) return;
      if (!lens) {
        lens = document.createElement('div');
        lens.className = 'zoom-lens';
        lens.style.backgroundImage = `url("${im.currentSrc || im.src}")`;
        $('#reader').append(lens);
        requestAnimationFrame(() => lens && lens.classList.add('on'));
      }
      const S = lens.offsetWidth || 190, x = e.clientX - r.left, y = e.clientY - r.top;
      lens.style.left = (e.clientX - S / 2) + 'px';
      lens.style.top = (e.clientY - S / 2) + 'px';
      lens.style.backgroundSize = `${r.width * Z}px ${r.height * Z}px`;
      lens.style.backgroundPosition = `${(S / 2 - x * Z).toFixed(1)}px ${(S / 2 - y * Z).toFixed(1)}px`;
    };
    const leave = () => {
      if (!lens) return;
      const l = lens;
      lens = null;
      l.classList.remove('on');
      setTimeout(() => l.remove(), 250);
    };
    im.addEventListener('pointerenter', e => { place(e); sound.nav(); });
    im.addEventListener('pointermove', place);
    im.addEventListener('pointerleave', leave);
    im.addEventListener('pointercancel', leave);
  }

  /* ── Annotations : le lecteur surligne un passage et y laisse une note, gardée dans son navigateur ── */

  const annoKey = doc => 'notes.' + doc.id;
  const annosOf = doc => (doc && store.get(annoKey(doc))) || [];
  const saveAnnos = (doc, list) => store.set(annoKey(doc), list);

  // le texte d'un conteneur, nœud par nœud (hors blocs interactifs, champs et réglages)
  function textMap(root) {
    const nodes = [];
    let s = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('[data-ix], details.ix-fold > summary, input, textarea, button, .ix-blank, .anno-pill, .anno-pop, .anno-panel, .rd-nav, .rd-hint') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, at: s.length }); s += n.textContent; }
    return { nodes, s };
  }

  // entoure les caractères [a, b) de surlignages, en découpant les nœuds de texte concernés
  function wrapSpan(map, a, b, id) {
    const marks = [];
    for (const { n, at } of map.nodes) {
      const len = n.textContent.length, s = Math.max(a, at), e = Math.min(b, at + len);
      if (e <= s) continue;
      let t = n;
      if (s > at) t = t.splitText(s - at);
      if (e < at + len) t.splitText(e - s);
      if (!t.textContent.trim()) continue;
      const m = document.createElement('mark');
      m.className = 'rd-anno';
      m.dataset.anno = id;
      t.replaceWith(m);
      m.append(t);
      marks.push(m);
    }
    return marks;
  }

  // retrouve un passage : le texte exact, départagé par ce qui l'entoure
  function findAnno(s, a) {
    let best = -1, score = -1;
    for (let i = s.indexOf(a.text); i >= 0; i = s.indexOf(a.text, i + 1)) {
      const pre = s.slice(Math.max(0, i - a.prefix.length), i), post = s.slice(i + a.text.length, i + a.text.length + a.suffix.length);
      let k = 0, j = 0;
      while (k < pre.length && pre[pre.length - 1 - k] === a.prefix[a.prefix.length - 1 - k]) k++;
      while (j < post.length && post[j] === a.suffix[j]) j++;
      if (k + j > score) { score = k + j; best = i; }
    }
    return best;
  }

  function markAnno(marks, a) {
    marks.forEach((m, k) => { m.classList.toggle('has-note', !!a.note); m.classList.toggle('anno-end', k === marks.length - 1); });
  }

  function applyAnnos(root, doc) {
    for (const a of annosOf(doc)) {
      if (root.querySelector(`[data-anno="${a.id}"]`)) continue;
      const map = textMap(root), i = findAnno(map.s, a);
      if (i >= 0) markAnno(wrapSpan(map, i, i + a.text.length, a.id), a);
    }
  }

  const marksOf = id => $$(`#rdStage [data-anno="${id}"]`);
  function unwrapAnno(id) {
    for (const m of $$(`[data-anno="${id}"]`)) { const p = m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); }
  }

  let annoPending = null;
  function closeAnnoUI() {
    annoPending = null;
    for (const s of ['.anno-pill', '.anno-pop', '.anno-panel']) { const el = $(s); if (el) el.hidden = true; }
  }

  function paintNotesBtn() {
    const b = $('#rdNotes');
    if (!b) return;
    const n = annosOf(reader.doc).length;
    b.hidden = !n;
    b.innerHTML = ic('pen') + (n > 1 ? ` ${n} notes` : ' 1 note');
  }

  // la note d'un passage : une bulle avec une zone d'écriture, sous le passage
  function openAnnoPop(id) {
    const doc = reader.doc, list = annosOf(doc), a = list.find(x => x.id === id), marks = marksOf(id);
    if (!a) return;
    const pop = $('.anno-pop');
    $('.anno-pill').hidden = true;
    pop.innerHTML = '<div class="ap-quote"></div><textarea placeholder="Votre note…" rows="3"></textarea><div class="ap-actions"><button class="btn ghost danger" data-del>Retirer</button><span></span><button class="btn" data-ok>OK</button></div>';
    $('.ap-quote', pop).textContent = a.text.length > 120 ? a.text.slice(0, 118) + '…' : a.text;
    const ta = $('textarea', pop);
    ta.value = a.note || '';
    const save = () => {
      const l = annosOf(doc), x = l.find(y => y.id === id);
      if (!x) return;
      x.note = ta.value.trim();
      saveAnnos(doc, l);
      markAnno(marksOf(id), x);
      renderNotesPanel();
    };
    ta.oninput = save;
    ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); pop.hidden = true; } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.hidden = true; } };
    $('[data-ok]', pop).onclick = () => { save(); pop.hidden = true; sound.saved(); };
    $('[data-del]', pop).onclick = () => { removeAnno(id); pop.hidden = true; };
    pop.hidden = false;
    const r = (marks[marks.length - 1] || marks[0] || $('#rdStage')).getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
    pop.style.top = (r.bottom + h + 20 < innerHeight ? r.bottom + 10 : Math.max(12, r.top - h - 10)) + 'px';
    setTimeout(() => ta.focus(), 20);
  }

  function removeAnno(id) {
    const doc = reader.doc;
    saveAnnos(doc, annosOf(doc).filter(x => x.id !== id));
    unwrapAnno(id);
    sound.remove();
    paintNotesBtn();
    renderNotesPanel();
  }

  function annosText(doc) {
    const list = annosOf(doc);
    return `Mes notes : ${doc.title || 'Sans titre'}\n\n` + list.map(a => `« ${a.text} »` + (a.note ? `\n→ ${a.note}` : '')).join('\n\n') + '\n';
  }

  function renderNotesPanel() {
    const panel = $('.anno-panel');
    if (!panel || panel.hidden) return;
    const list = annosOf(reader.doc);
    if (!list.length) { panel.hidden = true; return; }
    panel.innerHTML = '<div class="an-head"><b>Mes notes</b><button class="an-x" data-close aria-label="Fermer">×</button></div><div class="an-list"></div><div class="an-foot"><button class="btn ghost" data-copy>Copier mes notes</button></div>';
    const box = $('.an-list', panel);
    for (const a of list) {
      const it = document.createElement('div');
      it.className = 'an-item';
      it.innerHTML = '<div class="an-q"></div><div class="an-n"></div><div class="an-acts"><button data-go>Voir</button><button data-edit>Modifier</button><button data-del class="danger">Retirer</button></div>';
      $('.an-q', it).textContent = '« ' + (a.text.length > 160 ? a.text.slice(0, 158) + '…' : a.text) + ' »';
      $('.an-n', it).textContent = a.note || '';
      const here = marksOf(a.id).length > 0;
      $('[data-go]', it).hidden = !here;
      $('[data-edit]', it).hidden = !here;
      $('[data-go]', it).onclick = () => { const m = marksOf(a.id)[0]; m.scrollIntoView({ behavior: 'smooth', block: 'center' }); for (const x of marksOf(a.id)) { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); } };
      $('[data-edit]', it).onclick = () => { panel.hidden = true; openAnnoPop(a.id); };
      $('[data-del]', it).onclick = () => removeAnno(a.id);
      box.append(it);
    }
    $('[data-close]', panel).onclick = () => { panel.hidden = true; };
    $('[data-copy]', panel).onclick = () => copyText(annosText(reader.doc)).then(ok => toast(ok ? 'Notes copiées' : 'Copie impossible'));
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* on passe par une zone de texte */ }
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function bindAnnotations() {
    const host = $('#reader');
    const mk = (cls, html) => { const el = document.createElement('div'); el.className = cls; el.hidden = true; el.innerHTML = html || ''; host.append(el); return el; };
    const pill = mk('anno-pill', '<button data-a="mark">Surligner</button><button data-a="note">' + ic('pen') + ' Annoter</button>');
    mk('anno-pop');
    const panel = mk('anno-panel');
    const btn = document.createElement('button');
    btn.className = 'btn ghost rd-notes';
    btn.id = 'rdNotes';
    btn.hidden = true;
    host.append(btn);
    btn.onclick = e => { e.stopPropagation(); panel.hidden = !panel.hidden; renderNotesPanel(); if (!panel.hidden) sound.pop(); };

    // une sélection dans la page : on propose de la surligner
    const offer = () => {
      const sel = document.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) { pill.hidden = true; annoPending = null; return; }
      const r = sel.getRangeAt(0), stage = $('#rdStage');
      const anc = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
      if (!stage.contains(anc) || anc.closest('[data-ix], input, textarea')) { pill.hidden = true; annoPending = null; return; }
      const map = textMap(stage);
      let a = -1, b = -1;
      for (const { n, at } of map.nodes) {
        if (!r.intersectsNode(n)) continue;
        const s = n === r.startContainer ? r.startOffset : 0, e = n === r.endContainer ? r.endOffset : n.textContent.length;
        if (e <= s) continue;
        if (a < 0) a = at + s;
        b = at + e;
      }
      if (a < 0) { pill.hidden = true; return; }
      while (a < b && /\s/.test(map.s[a])) a++;
      while (b > a && /\s/.test(map.s[b - 1])) b--;
      if (b - a < 2) { pill.hidden = true; return; }
      annoPending = { a, b, map };
      pill.hidden = false;
      const box = r.getBoundingClientRect();
      pill.style.left = Math.max(12, Math.min(innerWidth - pill.offsetWidth - 12, box.left + box.width / 2 - pill.offsetWidth / 2)) + 'px';
      pill.style.top = (box.top > 60 ? box.top - pill.offsetHeight - 8 : box.bottom + 8) + 'px';
    };
    host.addEventListener('mouseup', e => { if (!e.target.closest('.anno-pill, .anno-pop, .anno-panel')) setTimeout(offer, 0); });
    host.addEventListener('keyup', e => { if (e.shiftKey) offer(); });

    pill.addEventListener('mousedown', e => e.preventDefault());
    pill.addEventListener('click', e => {
      const b = e.target.closest('[data-a]');
      if (!b || !annoPending || !reader.doc) return;
      const { a, b: z, map } = annoPending, doc = reader.doc;
      const an = { id: 'n' + uid(), text: map.s.slice(a, z), prefix: map.s.slice(Math.max(0, a - 40), a), suffix: map.s.slice(z, z + 40), note: '', at: Date.now() };
      const list = annosOf(doc);
      list.push(an);
      saveAnnos(doc, list);
      markAnno(wrapSpan(map, a, z, an.id), an);
      document.getSelection().removeAllRanges();
      pill.hidden = true;
      annoPending = null;
      sound.brush();
      paintNotesBtn();
      renderNotesPanel();
      if (b.dataset.a === 'note') openAnnoPop(an.id);
    });

    // un passage surligné : un clic rouvre sa note
    host.addEventListener('click', e => {
      const m = e.target.closest('.rd-anno');
      if (m && document.getSelection().isCollapsed) { e.stopPropagation(); openAnnoPop(m.dataset.anno); return; }
      if (!e.target.closest('.anno-pop')) $('.anno-pop').hidden = true;
    }, true);
  }


  /* ── Dans le lecteur : les blocs prennent vie ── */

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('espaces.lecteur.' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('espaces.lecteur.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  };

  /*
   * Suivre un lien vers une carte : la couleur de la carte d'arrivée s'ouvre en cercle depuis le lien cliqué,
   * recouvre l'écran le temps d'y lire son titre, puis s'efface sur la nouvelle page.
   */
  let passing = false;
  function gotoCard(id, from) {
    const d = findDoc(id);
    if (!d) return toast('Cette carte n’existe plus');
    if (reader.preview) return toast('Dans l’aperçu : ce lien ouvrira « ' + (d.title || 'Sans titre') + ' »');
    if (passing) return;
    gust(.6, 1);
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = from && from.isConnected ? from.getBoundingClientRect() : null;
    const [bg, fg] = colorOf(d), sp = spaceOfDoc(d.id);
    const ov = document.createElement('div');
    ov.className = 'go-pass' + (calm ? ' calm' : '');
    ov.style.setProperty('--x', (r ? r.left + r.width / 2 : innerWidth / 2) + 'px');
    ov.style.setProperty('--y', (r ? r.top + r.height / 2 : innerHeight / 2) + 'px');
    ov.style.setProperty('--bg', bg);
    ov.style.setProperty('--fg', fg);
    ov.innerHTML = '<div class="gp-in"><small></small><strong></strong></div>';
    $('small', ov).textContent = sp ? sp.title : '';
    $('strong', ov).textContent = d.title || 'Sans titre';
    document.body.append(ov);
    passing = true;
    ov.getBoundingClientRect();
    ov.classList.add('in');
    // la page change sous le voile, puis le voile s'efface
    setTimeout(() => {
      openDoc(id);
      ov.classList.add('out');
      setTimeout(() => { ov.remove(); passing = false; }, calm ? 300 : 650);
    }, calm ? 250 : 900);
  }

  function noteBubble(n) {
    $$('.ix-bubble').forEach(b => b.remove());
    const b = document.createElement('div');
    b.className = 'ix-bubble';
    b.textContent = n.dataset.note || '';
    $('#reader').append(b);
    const r = n.getBoundingClientRect();
    b.style.left = Math.min(innerWidth - b.offsetWidth - 16, Math.max(16, r.left + r.width / 2 - b.offsetWidth / 2)) + 'px';
    b.style.top = (r.top - b.offsetHeight - 10 < 10 ? r.bottom + 10 : r.top - b.offsetHeight - 10) + 'px';
    requestAnimationFrame(() => b.classList.add('in'));
    sound.pop();
  }

  function lightbox(srcs, i) {
    const l = document.createElement('div');
    l.className = 'ix-light';
    l.innerHTML = '<img><button class="ix-l-prev">‹</button><button class="ix-l-next">›</button>';
    const show = k => { i = (k + srcs.length) % srcs.length; $('img', l).src = srcs[i]; };
    $('.ix-l-prev', l).onclick = e => { e.stopPropagation(); show(i - 1); };
    $('.ix-l-next', l).onclick = e => { e.stopPropagation(); show(i + 1); };
    l.onclick = () => l.remove();
    show(i);
    $('#reader').append(l);
  }

  /* ───────────── Écriture manuscrite : la feuille ─────────────
   * Une feuille est un bloc comme les autres : protégée dans le texte, synchronisée, annulable, exportée.
   * Les traits sont du vectoriel dans un <svg> large de 1000 unités : chaque <path> garde ses points
   * (x y pression) dans data-p, et son dessin dans d, pour s'afficher partout (lecture, PDF, présentations)
   * sans script. Sur iPad, seul l'Apple Pencil écrit, le doigt fait défiler (sauf « écrire au doigt ») ;
   * sur Mac, on écrit à la souris ou au trackpad une fois la feuille choisie.
   */
  const INK_W = 1000;
  const INK_COLORS = { encre: '#211c1f', rose: '#c93470', bleu: '#2f5a9a', vert: '#3d7656', ocre: '#b0742a', ardoise: '#857b81' };
  const INK_HL = { jaune: '#f4d35e', rose: '#f5a3c3', vert: '#a6dcae', bleu: '#a3cbf2' };
  const INK_SIZES = { pen: [2.4, 3.8, 6.5], pencil: [2, 3.2, 5.2], hl: [16, 26, 38], eraser: [12, 26, 48] };
  const INK_TOOLS = [['pen', 'Plume', 'nib'], ['pencil', 'Crayon', 'pencil'], ['hl', 'Surligneur', 'marker'], ['eraser', 'Gomme', 'eraser'], ['lasso', 'Lasso', 'lasso']];
  const INK_PAPERS = [['vierge', 'Vierge'], ['lignes', 'Lignes'], ['carreaux', 'Quadrillage'], ['points', 'Points']];
  const ink = {
    tool: 'pen', color: { pen: 'encre', pencil: 'ardoise', hl: 'jaune' }, size: { pen: 1, pencil: 1, hl: 1, eraser: 1 },
    erase: 'part', finger: false,
    active: null, activeId: null, stroke: null, sel: null, drawing: false, full: null
  };
  try {
    const saved = JSON.parse(localStorage.getItem('espaces.ink') || '{}');
    for (const k of ['tool', 'color', 'size', 'erase', 'finger']) if (saved[k] != null) ink[k] = saved[k];
  } catch (e) { /* réglages par défaut */ }
  const inkSavePrefs = () => {
    try { localStorage.setItem('espaces.ink', JSON.stringify({ tool: ink.tool, color: ink.color, size: ink.size, erase: ink.erase, finger: ink.finger })); } catch (e) { /* tant pis */ }
  };

  const inkHTML = (id, h = 760, paper = 'lignes') => `<div class="ix-ink" contenteditable="false" data-ix="ink" data-id="${id}" data-paper="${paper}" data-h="${h}">`
    + `<svg class="ink-svg" viewBox="0 0 ${INK_W} ${h}" preserveAspectRatio="xMidYMin meet" xmlns="http://www.w3.org/2000/svg"></svg></div>`;
  const inkSvg = blk => {
    let s = blk.querySelector('svg.ink-svg');
    if (!s) { blk.insertAdjacentHTML('afterbegin', `<svg class="ink-svg" viewBox="0 0 ${INK_W} ${blk.dataset.h || 760}" preserveAspectRatio="xMidYMin meet" xmlns="http://www.w3.org/2000/svg"></svg>`); s = blk.querySelector('svg.ink-svg'); }
    return s;
  };
  const inkH = blk => +blk.dataset.h || 760;
  function inkSetH(blk, h) {
    h = Math.round(h);
    blk.dataset.h = h;
    inkSvg(blk).setAttribute('viewBox', `0 0 ${INK_W} ${h}`);
  }
  const inkPaths = blk => $$('path[data-p]', inkSvg(blk));
  function inkUnits(blk, cx, cy) {
    const r = inkSvg(blk).getBoundingClientRect(), s = INK_W / r.width;
    return [(cx - r.left) * s, (cy - r.top) * s];
  }

  /* ── Le dessin d'un trait ── */

  const r1 = v => Math.round(v * 10) / 10;
  const inkDecode = s => (s || '').trim().split(/\s+/).map(Number);
  const inkEncode = pts => pts.map((v, i) => i % 3 === 2 ? +v.toFixed(2) : r1(v)).join(' ');

  // la plume : un contour lissé autour du trait, plus large où l'on appuie et effilé aux deux bouts
  // (le crayon, lui, est une simple ligne d'épaisseur égale aux bouts ronds : voir inkRender)
  function inkOutline(pts, size) {
    const n = pts.length / 3;
    const X = i => pts[i * 3], Y = i => pts[i * 3 + 1];
    const rad = i => Math.max(.4, size / 2 * (.3 + .95 * Math.pow(pts[i * 3 + 2], .85)));
    if (n < 2 || (n === 2 && Math.hypot(X(1) - X(0), Y(1) - Y(0)) < .5)) {
      const r = rad(0);
      return `M${r1(X(0) - r)} ${r1(Y(0))}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0Z`;
    }
    const dist = [0];
    for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(X(i) - X(i - 1), Y(i) - Y(i - 1));
    const total = dist[n - 1], taper = size * 2.5;
    const L = [], R = [];
    let nx = 0, ny = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = X(b) - X(a), dy = Y(b) - Y(a), len = Math.hypot(dx, dy) || 1;
      nx = -dy / len; ny = dx / len;
      const t = Math.min(1, .45 + .55 * Math.min(dist[i], total - dist[i]) / taper);
      const r = rad(i) * t;
      L.push([X(i) + nx * r, Y(i) + ny * r]);
      R.push([X(i) - nx * r, Y(i) - ny * r]);
    }
    // les bouts arrondis
    const cap = (i, from) => {
      const out = [], r = Math.hypot(L[i][0] - R[i][0], L[i][1] - R[i][1]) / 2, cx = (L[i][0] + R[i][0]) / 2, cy = (L[i][1] + R[i][1]) / 2;
      const a0 = Math.atan2(from[1] - cy, from[0] - cx);
      for (let k = 1; k < 6; k++) { const a = a0 - Math.PI * k / 6; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
      return out;
    };
    const endCap = cap(n - 1, L[n - 1]), startCap = cap(0, R[0]);
    const poly = L.concat(endCap, R.slice().reverse(), startCap);
    const m = (p, q) => `${r1((p[0] + q[0]) / 2)} ${r1((p[1] + q[1]) / 2)}`;
    let d = `M${m(poly[0], poly[1])}`;
    for (let i = 1; i <= poly.length; i++) {
      const p = poly[i % poly.length], q = poly[(i + 1) % poly.length];
      d += `Q${r1(p[0])} ${r1(p[1])} ${m(p, q)}`;
    }
    return d + 'Z';
  }

  // le crayon et le surligneur : une ligne lissée qui passe par les points, tracée d'une épaisseur égale aux bouts ronds
  function inkLine(pts) {
    const n = pts.length / 3, P = i => [pts[i * 3], pts[i * 3 + 1]];
    if (n < 2) return `M${r1(pts[0])} ${r1(pts[1])}l.1 0`;
    let d = `M${r1(pts[0])} ${r1(pts[1])}`;
    for (let i = 1; i < n - 1; i++) {
      const p = P(i), q = P(i + 1);
      d += `Q${r1(p[0])} ${r1(p[1])} ${r1((p[0] + q[0]) / 2)} ${r1((p[1] + q[1]) / 2)}`;
    }
    const z = P(n - 1);
    return d + `L${r1(z[0])} ${r1(z[1])}`;
  }

  // pts : pendant qu'on écrit, les points du trait en cours (sans repasser par leur forme enregistrée, plus rapide)
  function inkRender(path, pts) {
    const t = path.dataset.t, c = path.dataset.c, w = +path.dataset.w;
    pts = pts || inkDecode(path.dataset.p);
    if (path.getAttribute('class') !== 'k-' + t) path.setAttribute('class', 'k-' + t);
    if (t === 'pen') {
      path.setAttribute('d', inkOutline(pts, w));
      path.setAttribute('style', `fill:var(--k-${c},${INK_COLORS[c] || INK_COLORS.encre})`);
      for (const a of ['stroke-width', 'stroke-linecap', 'stroke-linejoin']) path.removeAttribute(a);
    } else {
      // crayon (encre pleine, épaisseur égale) et surligneur (large et translucide) : une ligne aux bouts ronds
      path.setAttribute('d', inkLine(pts));
      path.setAttribute('stroke-width', r1(t === 'pencil' ? w * .85 : w));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('style', t === 'hl'
        ? `stroke:var(--hl-${c},${INK_HL[c] || INK_HL.jaune});fill:none;opacity:.45`
        : `stroke:var(--k-${c},${INK_COLORS[c] || INK_COLORS.encre});fill:none`);
    }
    delete path._bb;
  }

  function inkNewPath(svg, t, c, w, pts) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.dataset.t = t;
    p.dataset.c = c;
    p.dataset.w = r1(w);
    p.dataset.p = inkEncode(pts);
    inkRender(p);
    // le surligneur passe sous l'encre
    if (t === 'hl') svg.insertBefore(p, svg.querySelector('path:not(.k-hl)'));
    else svg.appendChild(p);
    return p;
  }

  // moins de points, même dessin (Ramer-Douglas-Peucker, la pression suit)
  function inkSimplify(pts, eps = .2) {
    const n = pts.length / 3;
    if (n < 3) return pts;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a * 3], ay = pts[a * 3 + 1], bx = pts[b * 3], by = pts[b * 3 + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let best = 0, at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i * 3] - ax) * dy - (pts[i * 3 + 1] - ay) * dx) / len;
        if (d > best) { best = d; at = i; }
      }
      if (best > eps) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    return out;
  }

  function inkBox(path) {
    if (path._bb) return path._bb;
    const pts = inkDecode(path.dataset.p), w = (+path.dataset.w || 4) / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
    }
    return (path._bb = { x0: x0 - w, y0: y0 - w, x1: x1 + w, y1: y1 + w });
  }
  function inkBoxOf(paths) {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of paths) { const q = inkBox(p); b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); }
    return b;
  }

  /* ── Formes : garder la pointe posée en fin de trait le redresse ── */

  function inkShape(pts) {
    // on lit la forme sur des points espacés : le frémissement de la pointe, surtout quand elle reste posée,
    // allongerait le trait et une droite ne serait plus reconnue
    const P = [];
    for (let i = 0; i < pts.length; i += 3) {
      const l = P[P.length - 1];
      if (!l || Math.hypot(pts[i] - l[0], pts[i + 1] - l[1]) >= 4) P.push([pts[i], pts[i + 1]]);
    }
    const n = P.length;
    if (n < 4) return null;
    let len = 0;
    for (let i = 1; i < n; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const span = Math.hypot(bx1 - bx0, by1 - by0);
    if (len < 40 || span < 25) return null;
    const first = P[0], last = P[n - 1], gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const flat = [];
    for (const p of P) flat.push(p[0], p[1], .6);
    const corners = [];
    const simple = inkSimplify(flat, span * .07);
    for (let i = 0; i < simple.length; i += 3) corners.push([simple[i], simple[i + 1]]);
    const seg = (a, b, k = 24) => { const o = []; for (let i = 0; i <= k; i++) o.push(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k, .6); return o; };
    const poly = (cs, k = 24) => { let o = []; for (let i = 0; i < cs.length; i++) o = o.concat(seg(cs[i], cs[(i + 1) % cs.length], k).slice(i ? 3 : 0)); return o; };
    if (gap > Math.max(24, len * .2)) {
      // ouvert : une ligne, ou une flèche (le trait, puis la pointe dessinée en revenant)
      // une droite se juge sur le corps du trait : le crochet de la pose et celui de la fin ne comptent pas, ni quelques
      // écarts de la main (on regarde 85 % des points, autour d'une droite ajustée sur ce corps)
      const cut = Math.floor(n * .1), mid = P.slice(cut, n - cut);
      const mx = mid.reduce((t, p) => t + p[0], 0) / mid.length, my = mid.reduce((t, p) => t + p[1], 0) / mid.length;
      let xx = 0, yy = 0, xy = 0;
      for (const p of mid) { xx += (p[0] - mx) ** 2; yy += (p[1] - my) ** 2; xy += (p[0] - mx) * (p[1] - my); }
      const ang = Math.atan2(2 * xy, xx - yy) / 2, ux = Math.cos(ang), uy = Math.sin(ang);
      const offs = mid.map(p => Math.abs((p[0] - mx) * uy - (p[1] - my) * ux)).sort((a, b) => a - b);
      const off = offs[Math.floor(offs.length * .85)];
      const ends = P.map(p => (p[0] - first[0]) * ux + (p[1] - first[1]) * uy);
      const reach = Math.max(...ends) - Math.min(...ends);
      diag(`forme: n=${n} long=${len | 0} corde=${gap | 0} écart=${off.toFixed(1)} portée=${reach | 0}`);
      if (off < Math.max(12, gap * .07) && gap > reach * .8) return { strokes: [seg(first, last, 32)], name: 'Ligne' };
      const shaft = Math.hypot(corners[1][0] - first[0], corners[1][1] - first[1]);
      if (corners.length >= 3 && shaft > len * .55 && corners.slice(2).every(c => Math.hypot(c[0] - corners[1][0], c[1] - corners[1][1]) < shaft * .35)) {
        const tip = corners[1], a = Math.atan2(tip[1] - first[1], tip[0] - first[0]), hl = Math.min(60, shaft * .22);
        const barb = s => [tip[0] - Math.cos(a + s * .45) * hl, tip[1] - Math.sin(a + s * .45) * hl];
        return { strokes: [seg(first, tip, 32), seg(barb(1), tip, 8), seg(barb(-1), tip, 8)], name: 'Flèche' };
      }
      return null;
    }
    // fermé : un triangle, un rectangle, ou une ellipse
    let cs = corners.slice();
    if (cs.length > 2 && Math.hypot(cs[0][0] - cs[cs.length - 1][0], cs[0][1] - cs[cs.length - 1][1]) < span * .2) cs.pop();
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const rs = P.map(p => Math.hypot((p[0] - cx) / ((bx1 - bx0) / 2 || 1), (p[1] - cy) / ((by1 - by0) / 2 || 1)));
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length, dev = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length) / mean;
    if (cs.length === 3) return { strokes: [poly(cs)], name: 'Triangle' };
    if (cs.length === 4 && dev > .06) {
      // presque droit : un rectangle bien d'aplomb
      const straight = cs.every((c, i) => { const d = cs[(i + 1) % 4], a = Math.abs(Math.atan2(d[1] - c[1], d[0] - c[0])) % (Math.PI / 2); return a < .21 || a > Math.PI / 2 - .21; });
      return { strokes: [poly(straight ? [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]] : cs)], name: 'Rectangle' };
    }
    if (dev < .16 || cs.length >= 5) {
      let rx = (bx1 - bx0) / 2, ry = (by1 - by0) / 2;
      if (Math.abs(rx - ry) / Math.max(rx, ry) < .14) rx = ry = (rx + ry) / 2;
      const o = [];
      for (let i = 0; i <= 64; i++) { const a = Math.PI * 2 * i / 64; o.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, .6); }
      return { strokes: [o], name: rx === ry ? 'Cercle' : 'Ellipse' };
    }
    return null;
  }

  /* ── La barre d'outils et le calque d'aide (lasso, sélection, gomme, poignée) ── */

  let inkBar = null, inkUI = null;
  function inkBuildUI() {
    if (inkBar) return;
    inkBar = document.createElement('div');
    inkBar.id = 'inkBar';
    inkBar.className = 'ink-bar';
    inkBar.hidden = true;
    document.body.appendChild(inkBar);
    inkUI = document.createElement('div');
    inkUI.id = 'inkUI';
    inkUI.hidden = true;
    inkUI.innerHTML = `<svg class="ink-ov" preserveAspectRatio="xMidYMin meet"><path class="ink-lasso"/><circle class="ink-rub" r="0"/><circle class="ink-hover" r="0"/><g class="ink-ruler" style="display:none"><rect/><path class="ink-ticks"/><text class="ink-angle" text-anchor="middle"></text></g>`
      + `<g class="ink-selbox" style="display:none"><rect class="ink-selrect"/><circle class="ink-h" data-h="0" r="9"/><circle class="ink-h" data-h="1" r="9"/><circle class="ink-h" data-h="2" r="9"/><circle class="ink-h" data-h="3" r="9"/></g></svg>`
      + `<button class="ink-grip" title="Agrandir ou réduire la feuille" aria-label="Hauteur de la feuille"></button>`;
    document.body.appendChild(inkUI);
    const sm = document.createElement('div');
    sm.className = 'ink-selmenu';
    sm.hidden = true;
    document.body.appendChild(sm);
    inkBar.addEventListener('mousedown', e => e.preventDefault());
    inkBar.addEventListener('click', inkBarClick);
    const selmenu = sm;
    selmenu.addEventListener('mousedown', e => e.preventDefault());
    selmenu.addEventListener('click', inkSelMenuClick);
    // déplacer ou agrandir la sélection, changer la hauteur de la feuille : souris, doigt ou crayon
    const grab = (e, kind, h) => {
      e.preventDefault();
      e.stopPropagation();
      const pt = e.touches ? e.touches[0] : e;
      inkGrab(kind, h, pt.clientX, pt.clientY);
    };
    $('.ink-selrect', inkUI).addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') grab(e, 'move'); });
    $('.ink-selrect', inkUI).addEventListener('touchstart', e => grab(e, 'move'), { passive: false });
    for (const h of $$('.ink-h', inkUI)) {
      h.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') grab(e, 'scale', +h.dataset.h); });
      h.addEventListener('touchstart', e => grab(e, 'scale', +h.dataset.h), { passive: false });
    }
    const grip = $('.ink-grip', inkUI);
    grip.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') grab(e, 'grow'); });
    grip.addEventListener('touchstart', e => grab(e, 'grow'), { passive: false });
  }

  const dot = (k, col, on, attr) => `<button class="ib-dot${on ? ' on' : ''}" ${attr}="${k}" style="--c:${col}" title="${k}"></button>`;
  function inkPaintBar() {
    const t = ink.tool;
    let opts = '';
    if (t === 'pen' || t === 'pencil') opts = Object.entries(INK_COLORS).map(([k, c]) => dot(k, `var(--k-${k},${c})`, ink.color[t] === k, 'data-color')).join('');
    else if (t === 'hl') opts = Object.entries(INK_HL).map(([k, c]) => dot(k, c, ink.color.hl === k, 'data-color')).join('');
    else if (t === 'eraser') opts = `<div class="ib-seg">${[['part', 'Partielle', 'Efface seulement ce qui passe sous la gomme'], ['stroke', 'Trait', 'Efface chaque trait touché en entier'], ['object', 'Objet', 'Efface tout l’objet touché : un mot, une forme, un dessin']].map(([k, n, h]) => `<button data-erase="${k}" class="${ink.erase === k ? 'on' : ''}" title="${h}">${n}</button>`).join('')}</div>`;
    else opts = '<span class="ib-hint">Entourez des traits</span>';
    const sizes = t === 'lasso' ? '' : '<span class="ib-sep"></span>' + INK_SIZES[t].map((s, i) => `<button class="ib-size${ink.size[t] === i ? ' on' : ''}" data-size="${i}" title="Épaisseur ${i + 1}"><i style="--s:${4 + i * 4}px"></i></button>`).join('');
    inkBar.innerHTML = `<div class="ib-tools">${INK_TOOLS.map(([id, name, icon]) => `<button data-tool="${id}" class="${t === id ? 'on' : ''}" title="${name}" aria-label="${name}">${ic(icon)}</button>`).join('')}</div>`
      + `<span class="ib-sep"></span><div class="ib-opts">${opts}${sizes}</div><span class="ib-sep"></span>`
      + `<button data-act="undo" title="Annuler" aria-label="Annuler">${ic('undo')}</button><button data-act="redo" title="Rétablir" aria-label="Rétablir">${ic('redo')}</button>`
      + `<button data-act="ruler" class="${ink.ruler ? 'on' : ''}" title="Règle" aria-label="Règle">${ic('ruler')}</button>`
      + `<button data-act="paper" title="Papier" aria-label="Papier">${ic('paper')}</button>`
      + `<button data-act="more" title="Plus" aria-label="Plus">${ic('more')}</button>`
      + `<button data-act="done" class="ib-done">OK</button>`;
  }

  // les menus de la trousse s'ouvrent du côté de l'écran où il reste de la place (la trousse est en haut quand la feuille est agrandie)
  const inkMenuY = r => document.body.classList.contains('ink-full') ? r.bottom + 8 : r.top - 8;
  function inkBarClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const blk = ink.active;
    if (b.dataset.tool) { if (b.dataset.tool !== ink.tool) ink.prevTool = ink.tool; ink.tool = b.dataset.tool; if (ink.tool !== 'lasso') inkSelect(null); haptic('tick'); }
    else if (b.dataset.color) ink.color[ink.tool] = b.dataset.color;
    else if (b.dataset.size) ink.size[ink.tool] = +b.dataset.size;
    else if (b.dataset.erase) ink.erase = b.dataset.erase;
    else if (b.dataset.act === 'done') return inkDeactivate();
    else if (b.dataset.act === 'undo' || b.dataset.act === 'redo') return inkUndo(b.dataset.act === 'redo');
    else if (b.dataset.act === 'ruler') { inkToggleRuler(); haptic('tick'); }
    else if (b.dataset.act === 'paper' && blk) {
      const r = b.getBoundingClientRect();
      return showMenu(r.left, inkMenuY(r), [{ head: 'Papier' }].concat(INK_PAPERS.map(([id, name]) => ({
        label: (blk.dataset.paper === id ? '✓ ' : '') + name, act: () => { histCommit(); blk.dataset.paper = id; changed(); histCommit(); }
      }))));
    } else if (b.dataset.act === 'more' && blk) {
      const r = b.getBoundingClientRect();
      return showMenu(r.left, inkMenuY(r), [
        { head: 'Feuille manuscrite' },
        { label: 'Coller les traits', off: !inkClip(), act: () => inkPaste(blk) },
        { label: 'Convertir l’écriture en texte', act: () => inkToText(blk, inkPaths(blk)) },
        { label: 'Agrandir la feuille', act: () => { histCommit(); inkSetH(blk, inkH(blk) + 500); changed(); histCommit(); } },
        TOUCH ? { label: (ink.finger ? '✓ ' : '') + 'Écrire au doigt', act: () => { ink.finger = !ink.finger; inkSavePrefs(); toast(ink.finger ? 'Le doigt écrit ; deux doigts font défiler' : 'Seul le crayon écrit ; le doigt fait défiler'); } } : null,
        '-',
        { label: 'Effacer la feuille', danger: true, act: () => { histCommit(); for (const p of inkPaths(blk)) p.remove(); inkSelect(null); changed(); histCommit(); } },
        { label: 'Supprimer la feuille', danger: true, act: () => { const b2 = blk; inkDeactivate(); removeEl(b2); } }
      ]);
    }
    inkSavePrefs();
    inkPaintBar();
  }

  /*
   * Les gestes de l'Apple Pencil, transmis par l'app : double-toucher (ou presser, sur le Pencil Pro) fait ce que l'on a
   * choisi dans les Réglages de l'iPad — passer à la gomme et revenir, revenir à l'outil d'avant, montrer la palette,
   * ou changer d'épaisseur. La palette s'ouvre sous la pointe quand le crayon survole l'écran.
   */
  window.__pencil = ({ kind, action, x, y } = {}) => {
    if (!ink.active || action === 'ignore') return;
    const t = ink.tool;
    if (action === 'eraser') inkSetTool(t === 'eraser' ? ink.prevTool || 'pen' : 'eraser');
    else if (action === 'previous') inkSetTool(ink.prevTool || (t === 'pen' ? 'eraser' : 'pen'));
    else if (action === 'attributes' && t !== 'lasso') { ink.size[t] = (ink.size[t] + 1) % 3; inkSavePrefs(); inkPaintBar(); toast(['Fin', 'Moyen', 'Épais'][ink.size[t]]); }
    else inkQuick(x != null ? [x, y] : null, true);
    haptic('tick');
  };
  function inkSetTool(tool) {
    if (tool !== ink.tool) ink.prevTool = ink.tool;
    ink.tool = tool;
    if (tool !== 'lasso') inkSelect(null);
    inkSavePrefs();
    inkPaintBar();
    toast(INK_TOOLS.find(x => x[0] === tool)[1]);
  }

  // la palette rapide : les outils et les encres, là où l'on a pressé le crayon (ou sous la trousse)
  function inkQuick(at, open) {
    let q = $('#inkQuick');
    if (!open) { if (q) q.hidden = true; return; }
    if (!q) {
      q = document.createElement('div');
      q.id = 'inkQuick';
      q.className = 'ink-quick';
      document.body.appendChild(q);
      q.addEventListener('mousedown', e => e.preventDefault());
      q.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tool) inkSetTool(b.dataset.tool);
        else if (b.dataset.color) { ink.color[ink.tool === 'hl' ? 'hl' : ink.tool === 'pencil' ? 'pencil' : 'pen'] = b.dataset.color; if (ink.tool === 'eraser' || ink.tool === 'lasso') inkSetTool(ink.prevTool && ink.prevTool !== 'eraser' && ink.prevTool !== 'lasso' ? ink.prevTool : 'pen'); inkSavePrefs(); inkPaintBar(); }
        q.hidden = true;
      });
    }
    const t = ink.tool === 'hl' ? 'hl' : ink.tool === 'pencil' ? 'pencil' : 'pen';
    const colors = t === 'hl' ? Object.entries(INK_HL).map(([k, c]) => [k, c]) : Object.entries(INK_COLORS).map(([k, c]) => [k, `var(--k-${k},${c})`]);
    q.innerHTML = `<div class="ib-tools">${INK_TOOLS.map(([id, name, icon]) => `<button data-tool="${id}" class="${ink.tool === id ? 'on' : ''}" title="${name}">${ic(icon)}</button>`).join('')}</div>`
      + `<div class="iq-colors">${colors.map(([k, c]) => `<button class="ib-dot${ink.color[t] === k ? ' on' : ''}" data-color="${k}" style="--c:${c}"></button>`).join('')}</div>`;
    q.hidden = false;
    const w = q.offsetWidth, h = q.offsetHeight, bar = inkBar.getBoundingClientRect();
    const x = at ? at[0] - w / 2 : bar.left + bar.width / 2 - w / 2, y = at ? at[1] - h - 24 : bar.bottom + 10;
    q.style.left = Math.max(10, Math.min(innerWidth - w - 10, x)) + 'px';
    q.style.top = Math.max(10, Math.min(innerHeight - h - 10, y < 10 && at ? at[1] + 24 : y)) + 'px';
  }

  /* ── Choisir une feuille ── */

  function inkActivate(blk) {
    if (READONLY || ink.active === blk) return;
    inkDeactivate();
    inkBuildUI();
    ink.active = blk;
    ink.activeId = blk.dataset.id;
    // les traits sont redessinés depuis leurs points : une feuille venue d'une version plus ancienne prend le tracé actuel
    for (const p of inkPaths(blk)) inkRender(p);
    // le clavier se range : on écrit à la main
    saveRange();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    document.body.classList.add('inking');
    if (NATIVE) call('inkMode', true).catch(() => {});
    inkEnlarge(blk);
    inkPaintBar();
    inkBar.hidden = false;
    inkUI.hidden = false;
    sound.brush();
    try {
      if (!localStorage.getItem('espaces.ink.tips')) {
        localStorage.setItem('espaces.ink.tips', '1');
        if (TOUCH) setTimeout(() => toast('Deux doigts pour annuler, trois pour rétablir'), 500);
      }
    } catch (e) { /* tant pis */ }
    requestAnimationFrame(inkFollow);
  }

  function inkDeactivate() {
    if (!ink.active) return;
    inkReadLater(ink.active);
    ink.ruler = null;
    inkPaintRuler();
    inkSelect(null);
    ink.active = null;
    ink.activeId = null;
    ink.stroke = null;
    ink.drawing = false;
    document.body.classList.remove('inking');
    if (NATIVE) call('inkMode', false).catch(() => {});
    inkHover(null);
    inkQuick(null);
    inkEnlarge(null);
    if (inkBar) inkBar.hidden = true;
    if (inkUI) inkUI.hidden = true;
    ink.ui = null;
  }

  /*
   * Entrer dans la feuille : elle quitte un moment sa place pour occuper presque tout l'écran (plus large, donc on y
   * écrit plus gros et plus confortablement), puis revient exactement à sa place en sortant. Rien n'est changé dans la
   * page elle-même : c'est une feuille de style à part, qui vise la feuille par son identifiant.
   */
  function inkEnlarge(blk) {
    let st = $('#inkFull');
    if (!st) { st = document.createElement('style'); st.id = 'inkFull'; document.head.appendChild(st); }
    const sc = $('#edScroll');
    if (blk) {
      // la feuille garde sa place dans la page pendant qu'elle est agrandie : le texte qui suit ne remonte pas dessous
      const cs = getComputedStyle(blk), keep = Math.round(blk.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom));
      const sel = `body.ink-full #edBody .ix-ink[data-id="${blk.dataset.id}"]`;
      ink.full = { id: blk.dataset.id, scroll: sc.scrollTop };
      document.body.classList.add('ink-full', 'ink-entering');
      setTimeout(() => document.body.classList.remove('ink-entering'), 460);
      inkVeil(true);
      st.textContent = `${sel} { position: fixed; z-index: 35; margin: 0;
        top: calc(82px + env(safe-area-inset-top)); left: calc(14px + env(safe-area-inset-left)); right: calc(14px + env(safe-area-inset-right));
        bottom: calc(14px + var(--kb, 0px) + env(safe-area-inset-bottom)); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
        border-radius: 18px; }
        body.ink-entering #edBody .ix-ink[data-id="${blk.dataset.id}"] { animation: ink-enter .42s cubic-bezier(.2, .8, .2, 1); }
        ${sel} > .ink-svg { min-height: max(100%, var(--ink-keep, 0px)); }
        ${blk.nextElementSibling ? `${sel} + * { margin-top: ${keep}px !important; }` : `body.ink-full #edBody { padding-bottom: ${keep}px; }`}`;
      blk.scrollTop = 0;
      sc.scrollTop = ink.full.scroll;
      return;
    }
    // quoi qu'il arrive, le mode agrandi est entièrement défait
    inkVeil(false);
    edBody().style.removeProperty('--ink-keep');
    const sheet = ink.full && edBody().querySelector(`.ix-ink[data-id="${ink.full.id}"]`), from = sheet && sheet.getBoundingClientRect();
    document.body.classList.remove('ink-full');
    st.textContent = '';
    if (!ink.full) return;
    // la feuille revient à sa taille : on la remet en haut (sinon elle resterait décalée de ce qu'on y a fait défiler),
    // et la page reprend exactement où on l'avait laissée
    if (sheet) sheet.scrollTop = 0;
    sc.scrollTop = ink.full.scroll;
    ink.full = null;
    // elle rejoint sa place en se rétrécissant, depuis sa grande taille
    // (la mise en page A4 attend la fin du mouvement : mesurée pendant, la feuille paraîtrait encore agrandie)
    if (sheet && from && sheet.animate) {
      const to = sheet.getBoundingClientRect(), k = from.width / (to.width || 1);
      const anim = sheet.animate([
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})`, transformOrigin: '0 0', opacity: .85 },
        { transform: 'none', transformOrigin: '0 0', opacity: 1 }
      ], { duration: 380, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      anim.onfinish = anim.oncancel = scheduleA4;
    } else scheduleA4();
  }

  // Le voile derrière la feuille agrandie. Toucher le voile rend la feuille à la page (jamais ne quitte la page) ;
  // en sortant, il s'efface puis est retiré : WebKit garde parfois à l'écran un flou qu'on s'est contenté de cacher.
  let veilTimer = 0;
  function inkVeil(on) {
    let v = $('#inkVeil');
    clearTimeout(veilTimer);
    if (on) {
      if (!v) {
        v = document.createElement('div');
        v.id = 'inkVeil';
        // souris : on bloque l'appui (l'éditeur se fermerait), le clic rend la feuille ;
        // toucher : on rend la feuille au relâché, sans laisser passer le clic simulé qui suivrait
        v.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        let tap = null;
        v.addEventListener('touchstart', e => {
          e.stopPropagation();
          const t = e.touches[0];
          tap = e.touches.length === 1 && !ink.drawing && performance.now() - (ink.lastPen || 0) > 900 ? { x: t.clientX, y: t.clientY, t0: performance.now() } : null;
        }, { passive: true });
        v.addEventListener('touchend', e => {
          e.stopPropagation();
          e.preventDefault();
          const t = e.changedTouches[0], ok = tap && performance.now() - tap.t0 < 450 && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) < 12;
          tap = null;
          if (ok && !ink.drawing) inkDeactivate();
        }, { passive: false });
        v.addEventListener('click', e => { e.stopPropagation(); inkDeactivate(); });
        // (sur iPhone, .sheet forme son propre étage : posé dans #editor, le voile passerait devant la feuille)
        $('#editor .sheet').appendChild(v);
      }
      requestAnimationFrame(() => v.classList.add('on'));
      return;
    }
    if (!v) return;
    v.classList.remove('on');
    veilTimer = setTimeout(() => v.remove(), 360);
  }

  function inkRefind(top) {
    const b = edBody().querySelector(`.ix-ink[data-id="${ink.activeId}"]`);
    if (!b) return false;
    ink.active = b;
    b.scrollTop = top;
    ink.sel = null;
    inkPaintSel();
    return true;
  }

  // le calque d'aide suit la feuille à l'écran ; si la page a été remplacée (annuler, synchro), il retrouve la feuille
  function inkFollow() {
    if (!ink.active) return;
    if (view !== 'editor') return inkDeactivate();
    if (!ink.active.isConnected) {
      // la page a été remplacée (annuler, synchro) : on retrouve la feuille, au même endroit de son défilement
      if (!inkRefind(ink.sheetScroll || 0)) return inkDeactivate();
    }
    ink.sheetScroll = ink.active.scrollTop;
    const r = inkSvg(ink.active).getBoundingClientRect(), h = inkH(ink.active);
    const seen = document.body.classList.contains('ink-full') ? ink.active.getBoundingClientRect() : $('#edScroll').getBoundingClientRect(), m = 10;
    // (on ne réécrit le calque que s'il a bougé : réécrire à chaque image ralentirait le tracé)
    const key = [r.left, r.top, r.width, r.height, h, seen.top, seen.bottom, seen.left, seen.right].map(Math.round).join();
    if (key !== ink.ui) {
      ink.ui = key;
      inkUI.style.transform = `translate(${r.left}px, ${r.top}px)`;
      inkUI.style.width = r.width + 'px';
      inkUI.style.height = r.height + 'px';
      const ov = $('.ink-ov', inkUI);
      if (ov.getAttribute('viewBox') !== `0 0 ${INK_W} ${h}`) ov.setAttribute('viewBox', `0 0 ${INK_W} ${h}`);
      inkUI.style.setProperty('--u', (r.width / INK_W).toFixed(4));
      inkUI.style.clipPath = `inset(${Math.max(-m, seen.top - r.top)}px ${Math.max(-m, r.right - seen.right)}px ${Math.max(-m, r.bottom - seen.bottom)}px ${Math.max(-m, seen.left - r.left)}px)`;
      if (ink.sel) inkPlaceSelMenu();
    }
    requestAnimationFrame(inkFollow);
  }

  /* ── Écrire, gommer, entourer ── */

  /* Le trait en cours se dessine sur un calque à part, segment par segment : la feuille SVG, qui peut contenir des
   * milliers de traits, n'est repeinte qu'une fois la pointe levée. */
  addEventListener('scroll', () => inkSettle(), { capture: true, passive: true });
  function inkLiveStart(st) {
    const cv = ink.live || (ink.live = Object.assign(document.createElement('canvas'), { className: 'ink-live' }));
    if (!cv.isConnected) document.body.append(cv);
    cv.style.display = '';
    const dpr = window.devicePixelRatio || 1, w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; ink.liveG = null; }
    const g = ink.liveG || (ink.liveG = cv.getContext('2d', { desynchronized: true }));
    const a = inkUnits(st.blk, 0, 0), b = inkUnits(st.blk, 100, 100), sx = 100 / (b[0] - a[0]), sy = 100 / (b[1] - a[1]);
    const cs = getComputedStyle(st.path), r = st.blk.getBoundingClientRect();
    g.restore();
    g.save();
    g.scale(dpr, dpr);
    g.beginPath();
    g.rect(r.left, r.top, r.width, r.height);
    g.clip();
    g.lineCap = g.lineJoin = 'round';
    g.strokeStyle = st.tool === 'pen' ? cs.fill : cs.stroke;
    st.live = { g, X: x => (x - a[0]) * sx, Y: y => (y - a[1]) * sy, s: sx, at: 3 };
    st.path.style.visibility = 'hidden';
  }
  function inkLiveDraw(st) {
    const L = st.live, P = st.pts, n = P.length;
    for (; L.at < n; L.at += 3) {
      const i = L.at, x0 = P[i - 3], y0 = P[i - 2], x1 = P[i], y1 = P[i + 1];
      const b = i >= 6 ? [(P[i - 6] + x0) / 2, (P[i - 5] + y0) / 2] : [x0, y0];
      L.g.lineWidth = (st.tool === 'pen' ? st.size * (.45 + P[i + 2] * .75) : st.size * .85) * L.s;
      L.g.beginPath();
      L.g.moveTo(L.X(b[0]), L.Y(b[1]));
      L.g.quadraticCurveTo(L.X(x0), L.Y(y0), L.X((x0 + x1) / 2), L.Y((y0 + y1) / 2));
      L.g.stroke();
    }
  }
  function inkLiveClear(st) {
    st.live = null;
    inkSettle();
  }
  // les traits finis restent sur le calque tant qu'on écrit : la feuille SVG, lente à repeindre, les reçoit à la pause
  function inkSettle() {
    if (!ink.liveG) return;
    // la feuille a bougé en plein trait : il continue sur la feuille elle-même, plutôt que de disparaître avec le calque
    const cur = ink.stroke;
    if (cur && cur.live) { cur.live = null; inkRender(cur.path, cur.pts); }
    const list = ink.pending || [];
    ink.pending = [];
    if (!(ink.stroke && ink.stroke.live)) ink.live.style.display = 'none';   // calque vide : rien à composer
    for (const p of list) if (p.isConnected) inkRender(p);
    const c = ink.live;
    ink.liveG.save();
    ink.liveG.setTransform(1, 0, 0, 1, 0, 0);
    ink.liveG.clearRect(0, 0, c.width, c.height);
    ink.liveG.restore();
  }
  // copier toute la page à chaque trait freinerait l'écriture : on enregistre quand la main marque une pause
  function inkCommitLater() {
    clearTimeout(ink.commitTimer);
    ink.commitTimer = setTimeout(inkCommitNow, 1200);
  }
  const inkBusy = () => !!(ink.stroke || ink.commitTimer);
  function inkCommitNow() {
    inkSettle();
    if (!ink.commitTimer) return;
    clearTimeout(ink.commitTimer);
    ink.commitTimer = 0;
    if (view !== 'editor') return;
    changed();
    histCommit();
    if (ink.active) inkReadLater(ink.active);
  }

  /* ── La règle : posée sur la feuille, déplacée d'un doigt, tournée de deux ; un trait commencé contre un bord le suit ── */
  const RULER_L = 2600, RULER_H = 96;
  function inkToggleRuler() {
    const blk = ink.active;
    if (ink.ruler || !blk) ink.ruler = null;
    else {
      const r = blk.getBoundingClientRect(), [x, y] = inkUnits(blk, r.left + r.width / 2, Math.max(r.top, 0) + Math.min(r.height, innerHeight) / 2);
      ink.ruler = { x, y, a: 0 };
    }
    inkPaintRuler();
  }
  function inkPaintRuler() {
    const g = inkUI && $('.ink-ruler', inkUI);
    if (!g) return;
    const R = ink.ruler;
    g.style.display = R ? '' : 'none';
    if (!R) return;
    g.setAttribute('transform', `translate(${r1(R.x)} ${r1(R.y)}) rotate(${r1(R.a)})`);
    const rect = $('rect', g);
    if (!rect.getAttribute('width')) {
      Object.entries({ x: -RULER_L / 2, y: -RULER_H / 2, width: RULER_L, height: RULER_H, rx: 10 }).forEach(([k, v]) => rect.setAttribute(k, v));
      let d = '';
      for (let i = -RULER_L / 2 + 20; i < RULER_L / 2; i += 20) { const k = i % 100 === 0 ? 22 : 11; d += `M${i} ${-RULER_H / 2}v${k}M${i} ${RULER_H / 2}v${-k}`; }
      $('.ink-ticks', g).setAttribute('d', d);
      $('.ink-angle', g).setAttribute('y', 9);
    }
    const deg = ((Math.round(-R.a) % 360) + 360) % 360;
    $('.ink-angle', g).textContent = deg + '°';
  }
  // (u : le long de la règle ; n : vers son bord)
  const rulerAxes = R => { const a = R.a * Math.PI / 180; return { ux: Math.cos(a), uy: Math.sin(a), nx: -Math.sin(a), ny: Math.cos(a) }; };
  function inkOnRuler(x, y, pad = 0) {
    const R = ink.ruler;
    if (!R) return false;
    const { ux, uy, nx, ny } = rulerAxes(R), dx = x - R.x, dy = y - R.y;
    return Math.abs(dx * ux + dy * uy) < RULER_L / 2 && Math.abs(dx * nx + dy * ny) < RULER_H / 2 + pad;
  }
  // le trait commence près d'un bord : il en suivra le fil
  function inkRuleFor(x, y, size) {
    const R = ink.ruler;
    if (!R) return null;
    const { ux, uy, nx, ny } = rulerAxes(R), dx = x - R.x, dy = y - R.y, d = dx * nx + dy * ny;
    if (Math.abs(dx * ux + dy * uy) > RULER_L / 2 || Math.abs(Math.abs(d) - RULER_H / 2) > 40) return null;
    return { side: Math.sign(d) || 1, off: RULER_H / 2 + size / 2 + 1 };
  }
  function inkRuleProj(rule, x, y) {
    const R = ink.ruler, { ux, uy, nx, ny } = rulerAxes(R), t = (x - R.x) * ux + (y - R.y) * uy;
    return [R.x + ux * t + nx * rule.side * rule.off, R.y + uy * t + ny * rule.side * rule.off];
  }
  // un doigt fait glisser la règle, deux la tournent (par crans de 15° près des angles ronds)
  function inkRulerGesture(blk, pts) {
    const R = ink.ruler, start = { x: R.x, y: R.y, a: R.a };
    const U = p => inkUnits(blk, p.x, p.y);
    const base = pts.map(U);
    const mid = q => q.length > 1 ? [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2] : q[0];
    const ang = q => q.length > 1 ? Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180 / Math.PI : 0;
    const m0 = mid(base), a0 = ang(base);
    return now => {
      const q = now.map(U);
      if (q.length !== base.length) return false;
      const m = mid(q);
      let a = start.a + (q.length > 1 ? ang(q) - a0 : 0);
      const snap = Math.round(a / 15) * 15;
      if (q.length > 1 && Math.abs(a - snap) < 2.5) a = snap;
      R.x = start.x + m[0] - m0[0]; R.y = start.y + m[1] - m0[1]; R.a = a;
      inkPaintRuler();
      return true;
    };
  }

  function inkDown(blk, cx, cy, force, kind) {
    clearTimeout(ink.commitTimer);
    if (ink.active !== blk) inkActivate(blk);
    // la pointe se pose : la feuille cesse de glisser (sinon le trait se déformerait sous la main)
    clearTimeout(ink.followTimer);
    if (document.body.classList.contains('ink-full')) blk.scrollTop = blk.scrollTop;
    const [x, y] = inkUnits(blk, cx, cy);
    // au lasso, poser la pointe sur un trait le prend, et on peut le déplacer dans le même geste
    if (ink.tool === 'lasso' && inkPickAt(blk, x, y)) return inkGrab('move', 0, cx, cy);
    ink.drawing = true;
    sync.lastTyped = Date.now();
    const t = ink.tool;
    if (t !== 'lasso') inkSelect(null);
    else if (ink.sel) inkSelect(null);
    if (t !== 'lasso' && !ink.commitTimer) histCommit();
    const st = ink.stroke = { blk, tool: t, kind, t0: performance.now(), lastT: performance.now(), p: .55, changed: false };
    if (t === 'pen' || t === 'pencil' || t === 'hl') {
      const p = kind === 'pen' && force > 0 ? Math.min(1, force) : .55;
      st.p = p;
      st.size = INK_SIZES[t][ink.size[t]];
      st.rule = inkRuleFor(x, y, st.size);
      st.pts = st.rule ? [...inkRuleProj(st.rule, x, y), p] : [x, y, p];
      st.path = inkNewPath(inkSvg(blk), t, ink.color[t], st.size, st.pts);
      st.hold = { x, y, timer: null };
      if (t !== 'hl') inkLiveStart(st);
      inkHold(st);
    } else if (t === 'eraser') {
      inkCommitNow();
      histCommit();
      st.r = INK_SIZES.eraser[ink.size.eraser] / 2;
      inkRub(x, y, st.r);
      inkEraseAt(blk, x, y, st.r, st);
    } else if (t === 'lasso') {
      st.poly = [x, y];
      $('.ink-lasso', inkUI).setAttribute('d', '');
    }
  }

  function inkMove(cx, cy, force) {
    const st = ink.stroke;
    if (!st) return;
    sync.lastTyped = Date.now();
    let [x, y] = inkUnits(st.blk, cx, cy);
    const now = performance.now();
    if (st.rule) [x, y] = inkRuleProj(st.rule, x, y);
    if (st.pts) {
      if (st.snapped) { st.raw = [x, y]; inkShapeFollow(st); return; }
      const n = st.pts.length, lx = st.pts[n - 3], ly = st.pts[n - 2];
      // le trait colle à la pointe (un soupçon de lissage seulement, pour gommer le tremblement du capteur)
      st.raw = [x, y];
      const k = st.kind === 'pen' ? 1 : st.kind === 'touch' ? .85 : .75, nx = lx + (x - lx) * k, ny = ly + (y - ly) * k;
      const d = Math.hypot(nx - lx, ny - ly);
      if (d < .35) return;
      let p;
      if (st.kind === 'pen' && force > 0) p = st.p * .35 + Math.min(1, force) * .65;
      else {
        // sans capteur de pression : plus on va vite, plus le trait s'affine
        const v = d / Math.max(1, now - st.lastT);
        p = st.p * .7 + Math.max(.3, Math.min(.95, .95 - v * .35)) * .3;
      }
      st.p = p;
      st.lastT = now;
      st.pts.push(nx, ny, p);
      if (Math.hypot(x - st.hold.x, y - st.hold.y) > 8) {   // (une main posée dérive un peu : elle reste « immobile »)
        st.hold.x = x; st.hold.y = y; inkHold(st); }
      // une seule peinture par image, quel que soit le nombre de points reçus
      if (!st.raf) st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        if (st.snapped) return;
        if (st.live) inkLiveDraw(st); else inkRender(st.path, st.pts);
      });
    } else if (st.tool === 'eraser') {
      inkRub(x, y, st.r);
      inkEraseAt(st.blk, x, y, st.r, st);
    } else if (st.poly) {
      st.poly.push(x, y);
      let d = '';
      for (let i = 0; i < st.poly.length; i += 2) d += (i ? 'L' : 'M') + r1(st.poly[i]) + ' ' + r1(st.poly[i + 1]);
      $('.ink-lasso', inkUI).setAttribute('d', d + 'Z');
    }
  }

  // la forme redressée suit la pointe jusqu'au relâchement : une ligne ou une flèche tourne et s'allonge depuis son départ,
  // une forme fermée s'étire depuis son centre
  function inkFollowPts(st) {
    const f = st.follow, [x, y] = st.raw;
    let map;
    if (f.name === 'Ligne' || f.name === 'Flèche') {
      const ox = f.base[0][0], oy = f.base[0][1];
      const a = Math.atan2(y - oy, x - ox) - Math.atan2(f.y - oy, f.x - ox);
      const k = Math.hypot(x - ox, y - oy) / (Math.hypot(f.x - ox, f.y - oy) || 1), c = Math.cos(a) * k, s = Math.sin(a) * k;
      map = (px, py) => [ox + (px - ox) * c - (py - oy) * s, oy + (px - ox) * s + (py - oy) * c];
    } else {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of f.base) for (let i = 0; i < q.length; i += 3) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      // l'échelle se lit sur la distance au centre : stable où que la pointe se soit arrêtée, et jamais une forme écrasée à rien
      const k = Math.max(.2, Math.hypot(x - cx, y - cy) / (Math.hypot(f.x - cx, f.y - cy) || 1));
      map = (px, py) => [cx + (px - cx) * k, cy + (py - cy) * k];
    }
    return f.base.map(q => { const o = q.slice(); for (let i = 0; i < o.length; i += 3) { const m = map(o[i], o[i + 1]); o[i] = m[0]; o[i + 1] = m[1]; } return o; });
  }
  function inkShapeFollow(st) {
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = 0;
      if (ink.stroke !== st) return;
      inkFollowPts(st).forEach((q, i) => inkRender(st.extra[i], q));
    });
  }

  // la pointe reste posée un instant en fin de trait : la forme se redresse
  function inkHold(st) {
    if (st.rule || (st.tool === 'hl' && st.pts.length < 12)) return;
    // un seul minuteur, qui se relance s'il le faut : pas de minuteur neuf à chaque point
    st.hold.t = performance.now();
    if (st.hold.timer) return;
    const tick = () => {
      const left = 600 - (performance.now() - st.hold.t);
      if (left > 20) { st.hold.timer = setTimeout(tick, left); return; }
      st.hold.timer = null;
      if (ink.stroke !== st || st.snapped) return;
      const sh = inkShape(st.pts);
      diag(`forme: pause, ${st.pts.length / 3} points → ${sh ? sh.name : 'rien'}`);
      if (!sh) return;
      st.snapped = true;
      inkLiveClear(st);
      st.follow = { base: sh.strokes, name: sh.name, x: st.raw ? st.raw[0] : st.hold.x, y: st.raw ? st.raw[1] : st.hold.y };
      const svg = inkSvg(st.blk);
      st.path.remove();
      st.extra = sh.strokes.map(pts => inkNewPath(svg, st.tool, ink.color[st.tool], st.size, pts));
      if (st.extra.length > 1) { const g = uid(); for (const p of st.extra) p.dataset.g = g; }
      st.path = st.extra[0];
      haptic('step');
      sound.pop();
    };
    st.hold.timer = setTimeout(tick, 600);
  }

  function inkUp() {
    const st = ink.stroke;
    ink.drawing = false;
    if (!st) return;
    ink.stroke = null;
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.hold) clearTimeout(st.hold.timer);
    const blk = st.blk;
    if (st.pts) {
      if (!st.snapped) {
        // le trait finit exactement là où la pointe s'est levée
        if (st.raw) { const n = st.pts.length; if (Math.hypot(st.raw[0] - st.pts[n - 3], st.raw[1] - st.pts[n - 2]) > .3) st.pts.push(st.raw[0], st.raw[1], st.pts[n - 1]); }
        if (st.live) inkLiveDraw(st);
        st.path.dataset.p = inkEncode(inkSimplify(st.pts));
        if (st.live) (ink.pending = ink.pending || []).push(st.path);
        else inkRender(st.path);
      } else if (st.follow && st.raw) {
        inkFollowPts(st).forEach((q, i) => { st.extra[i].dataset.p = inkEncode(q); inkRender(st.extra[i]); });
      }
      // la feuille s'allonge quand on écrit près du bas
      let bottom = 0;
      if (st.live) for (let i = 1; i < st.pts.length; i += 3) bottom = Math.max(bottom, st.pts[i]);
      else bottom = Math.max(...(st.extra || [st.path]).map(p => inkBox(p).y1));
      st.live = null;
      if (bottom > inkH(blk) - 140) inkSetH(blk, Math.max(inkH(blk) + 420, bottom + 300));
      inkFollowWriting(blk, bottom);
      inkCommitLater();
    } else if (st.tool === 'eraser') {
      $('.ink-rub', inkUI).setAttribute('r', 0);
      if (st.changed) { changed(); histCommit(); }
    } else if (st.poly) {
      $('.ink-lasso', inkUI).setAttribute('d', '');
      if (st.poly.length >= 8) inkLassoPick(blk, st.poly);
    }
  }

  // feuille agrandie : quand on écrit dans le bas de l'écran, la feuille glisse vers le haut (et s'allonge s'il le faut),
  // pour qu'on continue d'écrire à hauteur confortable
  function inkFollowWriting(blk, bottom) {
    clearTimeout(ink.followTimer);
    if (!document.body.classList.contains('ink-full')) return;
    ink.followTimer = setTimeout(() => inkGlide(blk, bottom), 650);
  }
  function inkGlide(blk, bottom) {
    if (ink.drawing || ink.active !== blk || !document.body.classList.contains('ink-full')) return;
    const vis = blk.getBoundingClientRect(), r = inkSvg(blk).getBoundingClientRect(), u = r.width / INK_W;
    const y = r.top + bottom * u;
    if (y < vis.top + vis.height * .7) return;
    const delta = y - (vis.top + vis.height * .42);
    const need = (blk.scrollTop + delta + vis.height) / u + 60;
    if (inkH(blk) < need) inkSetH(blk, need);
    blk.scrollBy({ top: delta, behavior: 'smooth' });
  }

  // un trait commencé par erreur (deux doigts posés pour un geste) disparaît sans laisser de trace
  function inkCancel() {
    const st = ink.stroke;
    ink.stroke = null;
    ink.drawing = false;
    if (!st) return;
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.hold) clearTimeout(st.hold.timer);
    for (const p of st.extra || (st.path ? [st.path] : [])) p.remove();
    if (inkUI) $('.ink-lasso', inkUI).setAttribute('d', '');
  }

  // annuler (ou rétablir) depuis la trousse, un geste, ou le crayon ; le clavier ne doit pas surgir pendant qu'on écrit à la main
  function inkUndo(again) {
    inkSelect(null);
    if (again) redo(); else undo();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    haptic('tick');
  }

  function inkHover(pt) {
    const c = inkUI && $('.ink-hover', inkUI);
    if (!c) return;
    if (!pt) { c.setAttribute('r', 0); return; }
    const t = ink.tool;
    const r = t === 'lasso' ? 3 : Math.max(2.5, INK_SIZES[t][ink.size[t]] / 2);
    c.setAttribute('cx', r1(pt[0]));
    c.setAttribute('cy', r1(pt[1]));
    c.setAttribute('r', r1(r));
    c.dataset.tool = t;
    c.style.fill = t === 'eraser' || t === 'lasso' ? '' : t === 'hl' ? INK_HL[ink.color.hl] : `var(--k-${ink.color[t]}, ${INK_COLORS[ink.color[t]]})`;
  }

  function inkRub(x, y, r) {
    const c = $('.ink-rub', inkUI);
    c.setAttribute('cx', r1(x));
    c.setAttribute('cy', r1(y));
    c.setAttribute('r', r1(r));
  }

  // la gomme : le trait entier, ou seulement ce qui passe sous elle (le trait est alors coupé en morceaux)
  function inkEraseAt(blk, x, y, r, st) {
    for (const path of inkPaths(blk)) {
      const bb = inkBox(path), w = (+path.dataset.w || 4) / 2, R = r + w;
      if (x < bb.x0 - r || x > bb.x1 + r || y < bb.y0 - r || y > bb.y1 + r) continue;
      const pts = inkDecode(path.dataset.p), n = pts.length / 3;
      // assez de points le long du trait pour couper au bon endroit
      const dense = [];
      for (let i = 0; i < n; i++) {
        if (i) {
          const ax = pts[i * 3 - 3], ay = pts[i * 3 - 2], bx = pts[i * 3], by = pts[i * 3 + 1], l = Math.hypot(bx - ax, by - ay), k = Math.ceil(l / Math.max(2, r / 2));
          for (let j = 1; j < k; j++) dense.push(ax + (bx - ax) * j / k, ay + (by - ay) * j / k, pts[i * 3 - 1] + (pts[i * 3 + 2] - pts[i * 3 - 1]) * j / k);
        }
        dense.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      }
      const hit = i => Math.hypot(dense[i * 3] - x, dense[i * 3 + 1] - y) < R;
      const m = dense.length / 3;
      let any = false;
      for (let i = 0; i < m && !any; i++) any = hit(i);
      if (!any) continue;
      st.changed = true;
      if (ink.erase === 'stroke') { path.remove(); continue; }
      if (ink.erase === 'object') { for (const p of inkObject(blk, path)) p.remove(); continue; }
      const runs = [];
      let cur = [];
      for (let i = 0; i < m; i++) {
        if (hit(i)) { if (cur.length >= 6) runs.push(cur); cur = []; }
        else cur.push(dense[i * 3], dense[i * 3 + 1], dense[i * 3 + 2]);
      }
      if (cur.length >= 6) runs.push(cur);
      for (const run of runs) {
        const np = inkNewPath(inkSvg(blk), path.dataset.t, path.dataset.c, +path.dataset.w, inkSimplify(run));
        path.parentNode.insertBefore(np, path);
      }
      path.remove();
    }
  }

  // des points réguliers le long d'un trait, assez serrés pour que deux traits qui se croisent se rencontrent
  function inkDense(pts, step) {
    const out = [pts[0], pts[1]];
    for (let i = 3; i < pts.length; i += 3) {
      const ax = pts[i - 3], ay = pts[i - 2], bx = pts[i], by = pts[i + 1], k = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
      for (let j = 1; j <= k; j++) out.push(ax + (bx - ax) * j / k, ay + (by - ay) * j / k);
    }
    return out;
  }

  // un objet : le trait touché, les traits dessinés avec lui (une flèche), et tous ceux qui le touchent vraiment, de proche
  // en proche (les lettres liées d'un mot, les traits d'un dessin). Le surligneur ne lie rien : il passe sur le texte.
  function inkObject(blk, path) {
    const all = inkPaths(blk), out = new Set([path]), todo = [path], dense = new Map();
    const dots = p => { if (!dense.has(p)) dense.set(p, inkDense(inkDecode(p.dataset.p), 3)); return dense.get(p); };
    const touch = (a, b) => {
      if (a.dataset.t === 'hl' || b.dataset.t === 'hl') return false;
      const gap = ((+a.dataset.w || 4) + (+b.dataset.w || 4)) / 2 + 3, ba = inkBox(a), bb = inkBox(b);
      if (ba.x0 - gap > bb.x1 || bb.x0 - gap > ba.x1 || ba.y0 - gap > bb.y1 || bb.y0 - gap > ba.y1) return false;
      const A = dots(a), B = dots(b);
      for (let i = 0; i < A.length; i += 2) for (let j = 0; j < B.length; j += 2) if (Math.hypot(A[i] - B[j], A[i + 1] - B[j + 1]) < gap) return true;
      return false;
    };
    while (todo.length) {
      const p = todo.pop();
      for (const q of all) {
        if (out.has(q)) continue;
        if ((p.dataset.g && q.dataset.g === p.dataset.g) || touch(p, q)) { out.add(q); todo.push(q); }
      }
    }
    return out;
  }

  /* ── Le lasso et la sélection ── */

  // le trait sous la pointe : l'encre passe avant le surligneur, puis le plus récent
  function inkHit(blk, x, y) {
    const slop = 10 * INK_W / inkSvg(blk).getBoundingClientRect().width;
    let best = null, score = Infinity;
    for (const path of inkPaths(blk)) {
      const w = (+path.dataset.w || 4) / 2, R = w + slop, bb = inkBox(path);
      if (x < bb.x0 - R || x > bb.x1 + R || y < bb.y0 - R || y > bb.y1 + R) continue;
      const pts = inkDense(inkDecode(path.dataset.p), Math.max(2, slop / 3));
      let d = Infinity;
      for (let i = 0; i < pts.length; i += 2) d = Math.min(d, Math.hypot(pts[i] - x, pts[i + 1] - y));
      if (d > R) continue;
      const s = Math.max(0, d - w) + (path.dataset.t === 'hl' ? slop * 2 : 0);
      if (s <= score) { score = s; best = path; }
    }
    return best;
  }

  function inkPickAt(blk, x, y) {
    const path = inkHit(blk, x, y);
    if (!path) return false;
    inkSelect({ blk, paths: [...inkObject(blk, path)] });
    haptic('tick');
    return true;
  }

  // il suffit d'entourer un bout d'un trait ou d'une forme : l'objet entier est pris
  function inkLassoPick(blk, poly) {
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
        const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const picked = new Set();
    for (const path of inkPaths(blk)) {
      if (picked.has(path)) continue;
      const pts = inkDense(inkDecode(path.dataset.p), 5);
      let hit = false;
      for (let i = 0; i < pts.length && !hit; i += 2) hit = inside(pts[i], pts[i + 1]);
      if (hit) for (const p of inkObject(blk, path)) picked.add(p);
    }
    inkSelect(picked.size ? { blk, paths: [...picked] } : null);
    if (picked.size) haptic('tick');
  }

  function inkSelect(sel) {
    ink.sel = sel;
    if (inkUI) inkPaintSel();
  }

  function inkPaintSel() {
    const g = $('.ink-selbox', inkUI), menu = $('body > .ink-selmenu');
    if (!ink.sel) { g.style.display = 'none'; menu.hidden = true; return; }
    const b = inkBoxOf(ink.sel.paths), pad = 10;
    const x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
    const rect = $('.ink-selrect', inkUI);
    rect.setAttribute('x', r1(x0)); rect.setAttribute('y', r1(y0));
    rect.setAttribute('width', r1(x1 - x0)); rect.setAttribute('height', r1(y1 - y0));
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y], i) => { const h = $(`.ink-h[data-h="${i}"]`, inkUI); h.setAttribute('cx', r1(x)); h.setAttribute('cy', r1(y)); });
    g.style.display = '';
    ink.sel.box = { x0, y0, x1, y1 };
    const hasInk = ink.sel.paths.some(p => p.dataset.t !== 'hl');
    menu.innerHTML = Object.entries(INK_COLORS).map(([k, c]) => `<button class="ib-dot" data-color="${k}" style="--c:var(--k-${k},${c})" title="${k}"></button>`).join('')
      + '<span class="ib-sep"></span><button data-act="copy">Copier</button><button data-act="dup">Dupliquer</button>'
      + (hasInk ? '<button data-act="text">En texte</button>' : '')
      + '<button data-act="del" class="danger">Supprimer</button>';
    menu.hidden = false;
    inkPlaceSelMenu();
  }

  function inkPlaceSelMenu() {
    const menu = $('body > .ink-selmenu'), b = ink.sel && ink.sel.box;
    if (!b || !ink.active) return;
    const r = inkSvg(ink.active).getBoundingClientRect(), u = r.width / INK_W;
    const seen = document.body.classList.contains('ink-full') ? ink.active.getBoundingClientRect() : $('#edScroll').getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let y = r.top + b.y0 * u - h - 10;
    if (y < seen.top + 4) y = Math.min(r.top + b.y1 * u + 10, seen.bottom - h - 4);
    const x = Math.max(10, Math.min(innerWidth - w - 10, r.left + b.x0 * u));
    menu.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(seen.top + 4, y))}px)`;
  }

  /* Copier des traits : ils se recollent dans n'importe quelle feuille (même d'une autre page), et le presse-papiers
   * reçoit aussi leur image, pour les poser dans le texte */
  const inkClip = () => { try { return JSON.parse(localStorage.getItem('espaces.inkclip') || 'null'); } catch (e) { return null; } };
  async function inkCopy(paths) {
    const b = inkBoxOf(paths);
    const clip = { w: b.x1 - b.x0, h: b.y1 - b.y0, paths: paths.map(p => ({ t: p.dataset.t, c: p.dataset.c, w: +p.dataset.w, g: p.dataset.g || '',
      p: inkEncode(inkDecode(p.dataset.p).map((v, i) => i % 3 === 0 ? v - b.x0 : i % 3 === 1 ? v - b.y0 : v)) })) };
    try { localStorage.setItem('espaces.inkclip', JSON.stringify(clip)); } catch (e) { return toast('Trop de traits pour les copier'); }
    toast(paths.length > 1 ? `${paths.length} traits copiés` : 'Trait copié');
    sound.pop();
    // l'image : les traits tels qu'on les voit, sur fond transparent, deux fois plus fins que l'écran
    const pad = 8, W = Math.ceil(clip.w + pad * 2), H = Math.ceil(clip.h + pad * 2);
    const body = paths.map(p => { const cs = getComputedStyle(p); return `<path d="${p.getAttribute('d')}" fill="${cs.fill}" stroke="${cs.stroke}" stroke-width="${cs.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${cs.opacity}"/>`; }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="${b.x0 - pad} ${b.y0 - pad} ${W} ${H}">${body}</svg>`;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = W * 2; c.height = H * 2;
      c.getContext('2d').drawImage(img, 0, 0);
      clipWrite(clipWrap(`<img src="${c.toDataURL('image/png')}">`), '').catch(() => {});
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function inkPaste(blk) {
    const clip = inkClip();
    if (!clip || !blk) return;
    histCommit();
    // au milieu de ce qu'on voit de la feuille
    const r = blk.getBoundingClientRect(), [cx, cy] = inkUnits(blk, r.left + r.width / 2, (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2);
    const ox = Math.max(0, Math.min(INK_W - clip.w, cx - clip.w / 2)), oy = Math.max(0, cy - clip.h / 2);
    const groups = new Map();
    const made = clip.paths.map(q => {
      const p = inkNewPath(inkSvg(blk), q.t, q.c, q.w, inkDecode(q.p).map((v, i) => i % 3 === 0 ? v + ox : i % 3 === 1 ? v + oy : v));
      if (q.g) { if (!groups.has(q.g)) groups.set(q.g, uid()); p.dataset.g = groups.get(q.g); }
      return p;
    });
    if (oy + clip.h > inkH(blk) - 40) inkSetH(blk, oy + clip.h + 200);
    ink.tool = 'lasso';
    inkPaintBar();
    inkSelect({ blk, paths: made });
    changed();
    histCommit();
  }

  function inkSelMenuClick(e) {
    const b = e.target.closest('button');
    if (!b || !ink.sel) return;
    const { blk, paths } = ink.sel;
    if (b.dataset.act === 'text') return inkToText(blk, paths);
    if (b.dataset.act === 'copy') return inkCopy(paths);
    histCommit();
    if (b.dataset.color) {
      for (const p of paths) if (p.dataset.t !== 'hl') { p.dataset.c = b.dataset.color; inkRender(p); }
      inkPaintSel();
    } else if (b.dataset.act === 'dup') {
      const copies = paths.map(p => {
        const pts = inkDecode(p.dataset.p).map((v, i) => i % 3 === 2 ? v : v + 24);
        return inkNewPath(inkSvg(blk), p.dataset.t, p.dataset.c, +p.dataset.w, pts);
      });
      inkSelect({ blk, paths: copies });
    } else if (b.dataset.act === 'del') {
      for (const p of paths) p.remove();
      inkSelect(null);
    }
    changed();
    histCommit();
  }

  // déplacer ou agrandir la sélection, ou changer la hauteur de la feuille
  function inkGrab(kind, handle, cx, cy) {
    const blk = ink.active;
    if (!blk) return;
    const [sx, sy] = inkUnits(blk, cx, cy);
    histCommit();
    const orig = ink.sel ? ink.sel.paths.map(p => ({ p, pts: inkDecode(p.dataset.p), w: +p.dataset.w })) : [];
    const box = ink.sel && ink.sel.box, h0 = inkH(blk);
    const anchor = box && [[box.x1, box.y1], [box.x0, box.y1], [box.x0, box.y0], [box.x1, box.y0]][handle || 0];
    let moved = false;
    const move = (mx, my) => {
      const [x, y] = inkUnits(blk, mx, my);
      moved = true;
      sync.lastTyped = Date.now();
      if (kind === 'grow') {
        const content = inkPaths(blk).reduce((m, p) => Math.max(m, inkBox(p).y1), 0);
        inkSetH(blk, Math.max(240, content + 30, h0 + (y - sy)));
        return;
      }
      let f = (pts) => pts, w = 1;
      if (kind === 'move') { const dx = x - sx, dy = y - sy; f = pts => pts.map((v, i) => i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v); }
      else {
        const s = Math.max(.15, Math.hypot(x - anchor[0], y - anchor[1]) / (Math.hypot(sx - anchor[0], sy - anchor[1]) || 1));
        w = s;
        f = pts => pts.map((v, i) => i % 3 === 0 ? anchor[0] + (v - anchor[0]) * s : i % 3 === 1 ? anchor[1] + (v - anchor[1]) * s : v);
      }
      for (const o of orig) { o.p.dataset.p = inkEncode(f(o.pts)); o.p.dataset.w = r1(o.w * w); inkRender(o.p); }
      inkPaintSel();
    };
    const end = () => {
      removeEventListener('pointermove', pm);
      removeEventListener('pointerup', end);
      removeEventListener('touchmove', tm);
      removeEventListener('touchend', end);
      removeEventListener('touchcancel', end);
      if (!moved) return;
      if (kind !== 'grow') {
        const bottom = inkBoxOf(ink.sel.paths).y1;
        if (bottom > inkH(blk) - 60) inkSetH(blk, bottom + 120);
      }
      changed();
      histCommit();
    };
    const pm = e => move(e.clientX, e.clientY);
    const tm = e => { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); };
    addEventListener('pointermove', pm);
    addEventListener('pointerup', end);
    addEventListener('touchmove', tm, { passive: false });
    addEventListener('touchend', end);
    addEventListener('touchcancel', end);
  }

  /* ── L'écriture devient du texte ── */

  // une image des traits : pour la reconnaissance (encre noire sur blanc) ou pour Word (en couleurs)
  async function inkPNG(paths, { black = false, box = null, maxW = 1800 } = {}) {
    const b = box || inkBoxOf(paths), pad = 24;
    const x0 = b.x0 - pad, y0 = b.y0 - pad, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const scale = Math.min(3, maxW / w);
    const body = paths.map(p => {
      if (!black) return p.outerHTML;
      if (p.dataset.t === 'hl') return '';
      if (p.dataset.t === 'pencil') return `<path d="${p.getAttribute('d')}" fill="none" stroke="#000" stroke-width="${p.getAttribute('stroke-width')}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `<path d="${p.getAttribute('d')}" fill="#000"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(x0)} ${r1(y0)} ${r1(w)} ${r1(h)}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"><rect x="${r1(x0)}" y="${r1(y0)}" width="${r1(w)}" height="${r1(h)}" fill="#fff"/>${body}</svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  /* La feuille est relue en arrière-plan, quelques secondes après qu'on a cessé d'écrire (sur l'appareil, sans réseau) :
   * son texte, gardé avec elle, rend l'écriture manuscrite trouvable par la recherche */
  function inkReadLater(blk) {
    if (!NATIVE || READONLY) return;
    clearTimeout(ink.readTimer);
    ink.readTimer = setTimeout(async () => {
      if (inkBusy()) return inkReadLater(blk);
      if (!blk.isConnected) return;
      const strokes = inkPaths(blk).filter(p => p.dataset.t !== 'hl');
      const key = strokes.map(p => p.dataset.p.length).join();
      if (blk._readKey === key) return;
      blk._readKey = key;
      let text = '';
      if (strokes.length) { try { text = await call('recognizeInk', await inkPNG(strokes, { black: true })); } catch (e) { return; } }
      text = (text || '').replace(/\s+/g, ' ').trim();
      if ((blk.dataset.read || '') === text || !blk.isConnected) return;
      if (text) blk.dataset.read = text; else delete blk.dataset.read;
      if (view === 'editor') changed();
    }, 4000);
  }

  async function inkToText(blk, paths) {
    const strokes = paths.filter(p => p.dataset.t !== 'hl');
    if (!strokes.length) return toast('Rien à lire : écrivez d’abord quelques mots');
    if (!NATIVE) return toast('La conversion en texte se fait dans l’app, sur Mac ou iPad');
    toast('Lecture de l’écriture…');
    let text = '';
    try { text = await call('recognizeInk', await inkPNG(strokes, { black: true })); } catch (e) { return toast('Lecture impossible : ' + (e.message || e)); }
    if (!text || !text.trim()) return toast('Aucun mot reconnu');
    histCommit();
    // le texte vient sous la feuille ; les traits convertis s'en vont (annuler les fait revenir)
    const ps = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const p = document.createElement('p'); p.textContent = l; return p; });
    let after = blk;
    for (const p of ps) { after.after(p); after = p; }
    for (const p of strokes) p.remove();
    inkSelect(null);
    if (!inkPaths(blk).length) { inkDeactivate(); blk.remove(); }
    changed();
    histCommit();
    sound.pop();
    toast(ps.length > 1 ? `${ps.length} lignes converties en texte` : 'Converti en texte');
  }

  // Word ne lit pas le SVG : chaque feuille y devient une image
  async function inkForWord(root) {
    for (const blk of $$('.ix-ink', root)) {
      const paths = $$('path[data-p]', blk);
      if (!paths.length) { blk.remove(); continue; }
      const img = document.createElement('img');
      img.src = await inkPNG(paths, { box: { x0: 0, y0: 0, x1: INK_W, y1: Math.max(inkBoxOf(paths).y1 + 10, 200) }, maxW: 1400 });
      blk.replaceWith(img);
    }
  }

  /* ── Insérer une feuille, et brancher le crayon, le doigt et la souris ── */

  function inkInsert() {
    restoreRange();
    const wrap = document.createElement('div');
    wrap.innerHTML = inkHTML(ixId());
    const blk = wrap.firstChild;
    let b = currentBlock();
    while (b && b.parentNode !== edBody()) b = b.parentNode;
    histCommit();
    if (b && isBlank(b)) b.replaceWith(blk);
    else if (b) b.after(blk);
    else edBody().appendChild(blk);
    if (!blk.nextElementSibling) blk.after(emptyParagraph());
    changed();
    histCommit();
    blk.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    inkActivate(blk);
  }

  /*
   * La poignée sous chaque feuille, dans la page : on la tire pour allonger ou raccourcir la feuille (jamais plus court
   * que ce qui y est écrit) ; deux touchers ou un double-clic l'ajustent juste à ce qu'on a noté.
   */
  const inkOnGrip = (blk, cy) => !document.body.classList.contains('ink-full') && blk.getBoundingClientRect().bottom - cy < 26;
  const inkContentH = blk => inkPaths(blk).reduce((m, p) => Math.max(m, inkBox(p).y1), 0);
  let gripTap = 0;
  function inkResize(blk, cy, touchId) {
    const now = Date.now();
    ink.resizedAt = now;
    if (now - gripTap < 380) {
      gripTap = 0;
      histCommit();
      inkSetH(blk, Math.max(240, inkContentH(blk) + 70));
      changed();
      histCommit();
      haptic('step');
      scheduleA4();
      return;
    }
    gripTap = now;
    const svg = inkSvg(blk), r0 = svg.getBoundingClientRect(), s = INK_W / r0.width;
    const grab = inkH(blk) - (cy - r0.top) * s, min = Math.max(240, inkContentH(blk) + 30), sc = $('#edScroll');
    let moved = false, lastY = cy;
    histCommit();
    const move = y => {
      lastY = y;
      moved = true;
      ink.resizedAt = Date.now();
      // près du bas de l'écran, la page défile pour qu'on puisse continuer à tirer
      const sr = sc.getBoundingClientRect();
      if (y > sr.bottom - 40) sc.scrollTop += 14;
      const top = svg.getBoundingClientRect().top;
      const h = Math.max(min, (y - top) * s + grab);
      if (Math.abs(h - inkH(blk)) >= 1) inkSetH(blk, h);
    };
    const pm = e => move(e.clientY);
    const tm = e => { const t = Array.from(e.changedTouches).find(x => x.identifier === touchId); if (t) { e.preventDefault(); move(t.clientY); } };
    const end = () => {
      removeEventListener('pointermove', pm);
      removeEventListener('pointerup', end);
      removeEventListener('touchmove', tm);
      removeEventListener('touchend', end);
      removeEventListener('touchcancel', end);
      ink.resizedAt = Date.now();
      if (!moved) return;
      changed();
      histCommit();
      scheduleA4();
    };
    if (touchId == null) { addEventListener('pointermove', pm); addEventListener('pointerup', end); }
    else { addEventListener('touchmove', tm, { passive: false }); addEventListener('touchend', end); addEventListener('touchcancel', end); }
  }

  function bindInk() {
    const body = edBody();
    const blockOf = t => t && t.closest && t.closest('.ix-ink');
    // souris, trackpad, tablette graphique (sur iPad, le crayon passe par les évènements tactiles, plus fiables)
    body.addEventListener('pointerdown', e => {
      const blk = blockOf(e.target);
      if (!blk || READONLY || e.pointerType === 'touch' || (TOUCH && e.pointerType === 'pen') || e.button !== 0) return;
      e.preventDefault();
      if (ink.active !== blk && inkOnGrip(blk, e.clientY)) return inkResize(blk, e.clientY, null);
      // sur Mac, le premier clic choisit la feuille ; on écrit ensuite
      if (ink.active !== blk) return inkActivate(blk);
      // à la souris, on attrape la règle par son milieu ; la molette la tourne
      if (ink.ruler && e.pointerType === 'mouse' && inkOnRuler(...inkUnits(blk, e.clientX, e.clientY), -24)) {
        const step = inkRulerGesture(blk, [{ x: e.clientX, y: e.clientY }]);
        const mv = ev => step([{ x: ev.clientX, y: ev.clientY }]);
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
        addEventListener('pointermove', mv);
        addEventListener('pointerup', up);
        return;
      }
      inkDown(blk, e.clientX, e.clientY, e.pointerType === 'pen' ? e.pressure : 0, e.pointerType === 'pen' ? 'pen' : 'mouse');
      const move = ev => {
        const list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
        for (const c of (list.length ? list : [ev])) inkMove(c.clientX, c.clientY, c.pointerType === 'pen' ? c.pressure : 0);
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); inkUp(); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });
    body.addEventListener('mousedown', e => { if (blockOf(e.target)) e.preventDefault(); });
    body.addEventListener('wheel', e => {
      if (!ink.ruler || !ink.active || !inkOnRuler(...inkUnits(ink.active, e.clientX, e.clientY))) return;
      e.preventDefault();
      ink.ruler.a += Math.sign(e.deltaY || e.deltaX) * (e.shiftKey ? 15 : 1);
      inkPaintRuler();
    }, { passive: false });
    /*
     * iPad : le crayon écrit, le doigt fait défiler (sauf « écrire au doigt » : un doigt écrit, deux font défiler).
     * Le trait suit le toucher sur l'élément même où il a commencé : iOS y livre la fin du geste même si cet élément a
     * quitté la page entre-temps (un trait gommé, une annulation), alors qu'elle n'arriverait plus jusqu'à la fenêtre.
     * Et si une fin s'est malgré tout perdue, le toucher suivant repart proprement au lieu d'être ignoré.
     */
    let touchId = null, touchEl = null, fingers = null;
    // la paume : tant que le crayon écrit, et un court instant après, un doigt posé sur la feuille n'est qu'une main qui s'appuie
    const penBusy = () => touchId != null || performance.now() - (ink.lastPen || 0) < 1200;
    const find = e => Array.from(e.changedTouches).find(t => t.identifier === touchId);
    const tmove = e => {
      const t = touchId != null && find(e);
      if (!t) return;
      e.preventDefault();
      if (t.touchType === 'stylus') ink.lastPen = performance.now();
      if (ink.stroke && ink.stroke.fine) return;   // les événements du crayon, plus précis, ont pris le relais
      inkMove(t.clientX, t.clientY, t.touchType === 'stylus' ? t.force : 0);
    };
    // le crayon mesure bien plus de points qu'il n'y a d'images : quand le système les donne, on les prend tous
    addEventListener('pointermove', e => {
      const st = ink.stroke;
      if (!st || e.pointerType !== 'pen' || st.kind !== 'pen' || !TOUCH || !e.getCoalescedEvents) return;
      const list = e.getCoalescedEvents();
      if (!list.length) return;
      st.fine = true;
      // (un point sans position, que WebKit livre parfois, enverrait le trait hors de la feuille)
      for (const c of list) if (c.clientX || c.clientY) inkMove(c.clientX, c.clientY, c.pressure);
    }, { passive: true });
    const tend = e => { if (touchId != null && find(e)) release(); };
    function release(cancel) {
      if (touchEl) {
        touchEl.removeEventListener('touchmove', tmove);
        touchEl.removeEventListener('touchend', tend);
        touchEl.removeEventListener('touchcancel', tend);
        touchEl = null;
      }
      if (touchId == null) return;
      touchId = null;
      if (cancel) inkCancel(); else inkUp();
    }
    body.addEventListener('touchstart', e => {
      const blk = blockOf(e.target);
      if (!blk || READONLY) return;
      if (touchId != null && !Array.from(e.touches).some(t => t.identifier === touchId)) release();
      const t = e.changedTouches[0], stylus = t.touchType === 'stylus';
      // des doigts sur la règle : elle bouge, rien ne s'écrit
      if (!stylus && ink.active === blk && ink.ruler) {
        const fs = Array.from(e.touches).filter(x => x.touchType !== 'stylus').slice(0, 2);
        if (ink.rulerMove || fs.some(f => inkOnRuler(...inkUnits(blk, f.clientX, f.clientY), 30))) {
          e.preventDefault();
          fingers = null;
          const ids = fs.map(f => f.identifier), at = l => ids.map(id => Array.from(l).find(x => x.identifier === id)).filter(Boolean).map(f => ({ x: f.clientX, y: f.clientY }));
          const step = inkRulerGesture(blk, at(e.touches));
          const mv = ev => { ev.preventDefault(); step(at(ev.touches)); };
          const end = ev => { if (Array.from(ev.touches).some(x => ids.includes(x.identifier))) return; removeEventListener('touchmove', mv); removeEventListener('touchend', end); removeEventListener('touchcancel', end); ink.rulerMove = null; };
          if (ink.rulerMove) ink.rulerMove();
          ink.rulerMove = () => { removeEventListener('touchmove', mv); removeEventListener('touchend', end); removeEventListener('touchcancel', end); };
          addEventListener('touchmove', mv, { passive: false });
          addEventListener('touchend', end);
          addEventListener('touchcancel', end);
          return;
        }
      }
      if (stylus) ink.lastPen = performance.now();
      // une paume sur la feuille ouverte pendant qu'on écrit : ignorée (elle ne fait pas défiler la feuille)
      else if (ink.active === blk && penBusy()) { e.preventDefault(); fingers = null; return; }
      // plusieurs doigts sur la feuille ouverte : un geste (deux doigts touchent : annuler ; trois : rétablir)
      if (!stylus && ink.active === blk) {
        if (!fingers || e.touches.length === 1) fingers = { n: e.touches.length, t0: performance.now(), x: t.clientX, y: t.clientY, moved: false };
        else fingers.n = Math.max(fingers.n, e.touches.length);
        // un deuxième doigt arrivé juste après le premier (« écrire au doigt ») : ce n'était pas un trait
        if (e.touches.length > 1 && touchId != null && ink.stroke && ink.stroke.kind === 'touch' && performance.now() - ink.stroke.t0 < 220) release(true);
      }
      if (touchId != null) { e.preventDefault(); return; }
      // la poignée du bas, au doigt comme au crayon
      if (ink.active !== blk && e.touches.length === 1 && inkOnGrip(blk, t.clientY)) { e.preventDefault(); return inkResize(blk, t.clientY, t.identifier); }
      if (!stylus && (!ink.finger || e.touches.length > 1)) return;
      e.preventDefault();
      if (ink.active !== blk) return inkActivate(blk);
      touchId = t.identifier;
      touchEl = e.target;
      touchEl.addEventListener('touchmove', tmove, { passive: false });
      touchEl.addEventListener('touchend', tend);
      touchEl.addEventListener('touchcancel', tend);
      inkDown(blk, t.clientX, t.clientY, stylus ? t.force : 0, stylus ? 'pen' : 'touch');
    }, { passive: false });
    addEventListener('touchmove', e => {
      if (!fingers) return;
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - fingers.x, t.clientY - fingers.y) > 14) fingers.moved = true;
    }, { passive: true });
    addEventListener('touchend', e => {
      if (!fingers || e.touches.length) return;
      const f = fingers;
      fingers = null;
      if (f.moved || performance.now() - f.t0 > 350 || !ink.active || performance.now() - (ink.lastPen || 0) < 1200) return;
      if (f.n === 2) inkUndo(false);
      else if (f.n === 3) inkUndo(true);
      // un doigt qui touche un trait le sélectionne (sans « écrire au doigt », où le doigt écrit) ; ailleurs, il rend la main
      else if (f.n === 1 && !ink.finger) {
        const [x, y] = inkUnits(ink.active, f.x, f.y);
        if (!inkPickAt(ink.active, x, y)) inkSelect(null);
      }
    });
    // le survol du crayon (iPad récents) : un point montre où la pointe va se poser, de la couleur et la taille de l'outil
    body.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' || e.buttons || ink.drawing || !ink.active || blockOf(e.target) !== ink.active) return inkHover(null);
      inkHover(inkUnits(ink.active, e.clientX, e.clientY));
    });
    body.addEventListener('pointerleave', () => inkHover(null));
    body.addEventListener('pointerdown', () => inkHover(null), true);
    // toucher ou cliquer à côté de la feuille la quitte ; Échap aussi
    document.addEventListener('click', e => {
      if (!e.target.closest('#inkQuick')) inkQuick(null);
      if (!ink.active || e.target.closest('.ix-ink, #inkBar, #inkUI, #inkQuick, .ink-selmenu, .cm, #toast')) return;
      inkDeactivate();
    }, true);
    /*
     * Le clavier, feuille ouverte (sur Mac, ou iPad avec clavier) : Échap la referme, ⌘Z / ⇧⌘Z annulent et rétablissent,
     * Suppr efface la sélection, et une lettre choisit l'outil — P plume, C crayon, S surligneur, E gomme, L lasso ;
     * 1, 2, 3 l'épaisseur. Ces touches passent avant celles de l'éditeur.
     */
    const KEYS = { p: 'pen', c: 'pencil', s: 'hl', e: 'eraser', l: 'lasso' };
    document.addEventListener('keydown', e => {
      if (!ink.active || /INPUT|TEXTAREA/.test(e.target.tagName) || $('.cm')) return;
      const k = e.key.toLowerCase(), stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'Escape') { stop(); inkDeactivate(); }
      else if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'z' || k === 'y')) { stop(); inkUndo(k === 'y' || e.shiftKey); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && ink.sel) {
        stop();
        histCommit();
        for (const p of ink.sel.paths) p.remove();
        inkSelect(null);
        changed();
        histCommit();
      }
      else if (e.metaKey || e.ctrlKey || e.altKey) return;
      else if (KEYS[k]) { stop(); inkSetTool(KEYS[k]); }
      else if (/^[123]$/.test(k) && ink.tool !== 'lasso') { stop(); ink.size[ink.tool] = +k - 1; inkSavePrefs(); inkPaintBar(); }
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key.length === 1) stop();   // la frappe ne va pas dans le texte caché derrière
    }, true);
  }

  /* ───────────── Notes vocales ─────────────
   * Un bloc comme les autres : le son (AAC, en base64) voyage dans la page, comme les images, donc avec la synchro.
   * Il s'écoute partout (éditeur, lecture, note rapide) ; pendant ce temps, la musique se fait plus discrète.
   * L'état de lecture vit dans une feuille de style à part : rien n'est écrit dans la page.
   */
  const VOICE_BARS = 44;
  const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const voiceHTML = ({ data, seconds, wave }) => {
    const bars = Array.from({ length: VOICE_BARS }, (_, i) => wave[Math.floor(i * wave.length / VOICE_BARS)] || 0);
    return `<div class="ix-voice" contenteditable="false" data-ix="voice" data-id="${ixId()}" data-dur="${seconds.toFixed(1)}" data-audio="${data}">`
      + `<button class="vc-play" aria-label="Écouter"></button><div class="vc-wave">${bars.map(b => `<i style="height:${Math.round(14 + b * 86)}%"></i>`).join('')}</div>`
      + `<span class="vc-time">${fmtDur(seconds)}</span></div>`;
  };

  const vc = { id: null, el: null, buf: new Map(), t0: 0, raf: 0 };
  function voicePaint(p) {
    let st = $('#vcNow');
    if (!st) { st = document.createElement('style'); st.id = 'vcNow'; document.head.append(st); }
    if (!vc.id) { st.textContent = ''; return; }
    const sel = `.ix-voice[data-id="${vc.id}"]`, n = Math.round(p * VOICE_BARS);
    st.textContent = `${sel} .vc-play::before { border: 0; width: 4px; height: 14px; margin: 0; box-shadow: 8px 0 0 currentColor; background: currentColor; transform: translateX(-4px); }`
      + (n ? `${sel} .vc-wave i:nth-child(-n+${n}) { background: var(--accent); opacity: 1; }` : '');
  }
  function voiceStop() {
    sound.voice.stop();
    cancelAnimationFrame(vc.raf);
    vc.id = vc.el = null;
    voicePaint(0);
  }
  async function voiceToggle(el, at) {
    if (sound.hushing()) return;   // le micro est ouvert
    const id = el.dataset.id;
    if (vc.id === id && at == null) return voiceStop();
    voiceStop();
    vc.id = id;
    vc.el = el;
    voicePaint(0);
    try {
      let buf = vc.buf.get(id);
      if (!buf) {
        const bytes = Uint8Array.from(atob(el.dataset.audio), c => c.charCodeAt(0));
        buf = await sound.voice.decode(bytes.buffer);
        vc.buf.set(id, buf);
      }
      if (vc.id !== id) return;
      const from = (at || 0) * buf.duration;
      vc.t0 = sound.voice.play(buf, from, voiceStop);
      const tick = () => {
        if (vc.id !== id) return;
        voicePaint(Math.min(1, (sound.voice.now() - vc.t0) / buf.duration));
        vc.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.error(e);
      voiceStop();
      toast('Lecture de la note vocale impossible');
    }
  }

  // enregistrer : un panneau avec le temps et l'onde ; rend { data, seconds, wave }, ou rien si on annule
  // une prise de son : le micro, le niveau à l'écran ; stop(garder) rend le son
  async function voiceSession(onLevel, onFull) {
    voiceStop();
    sound.duck(0);
    sound.hush(true);
    try { await call('voiceStart'); } catch (e) { sound.hush(false); sound.duck(1); toast(String(e.message || e)); return null; }
    const wave = [], t0 = Date.now();
    const tick = setInterval(async () => {
      const s = (Date.now() - t0) / 1000;
      if (s >= 600) return onFull();    // dix minutes : le son reste léger dans la page
      const lv = await call('voiceLevel').catch(() => 0);
      wave.push(lv);
      onLevel(s, wave);
    }, 110);
    let done = false;
    return {
      seconds: () => (Date.now() - t0) / 1000,
      async stop(keep) {
        if (done) return null;
        done = true;
        clearInterval(tick);
        const r = await call('voiceStop', keep).catch(() => null);
        // le son repart proprement au prochain toucher
        sound.hush(false);
        sound.duck(1);
        return keep && r ? { data: r.data, seconds: r.seconds, wave } : null;
      }
    };
  }

  function recordVoice() {
    if (!NATIVE) { toast('Les notes vocales s’enregistrent dans l’app'); return Promise.resolve(null); }
    return new Promise(async resolve => {
      const box = document.createElement('div');
      const finish = async keep => { box.remove(); resolve(await session.stop(keep)); };
      const session = await voiceSession((s, wave) => {
        $('.vc-clock', box).textContent = fmtDur(s);
        $('.vc-live', box).innerHTML = wave.slice(-36).map(v => `<i style="height:${Math.round(10 + v * 90)}%"></i>`).join('');
      }, () => finish(true));
      if (!session) return resolve(null);
      box.className = 'vc-rec';
      box.innerHTML = `<div class="vc-rec-in"><div class="vc-dot"></div><div class="vc-clock">0:00</div><div class="vc-live"></div><div class="vc-acts"><button class="btn ghost" data-a="no">Annuler</button><button class="btn" data-a="ok">Terminer</button></div></div>`;
      document.body.append(box);
      box.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) finish(b.dataset.a === 'ok'); });
    });
  }

  /*
   * La note vocale rapide, comme dans une messagerie : on garde le doigt sur le micro pour parler ; au relâché, le vocal
   * rejoint la note en cours, qu'on envoie ensuite avec la flèche. Glisser vers le haut verrouille (le pouce est libre) ; glisser vers la gauche annule.
   * Avec tap : le bouton a déjà son rôle (la flèche d'envoi) ; un toucher l'exécute, et seul un appui maintenu ouvre le micro.
   */
  function bindHoldVoice(btn, tap) {
    const LOCK_AT = 72, DROP_AT = 110, SHORT = .5;
    let rec = null;
    const clear = r => { r.bar.remove(); r.lockEl.remove(); r.hold.remove(); };
    const end = async keep => {
      const r = rec;
      if (!r || r.over) return;
      r.over = true;
      rec = null;
      clear(r);
      if (!r.session) return;
      const short = keep && !r.locked && r.session.seconds() < SHORT;
      const got = await r.session.stop(keep && !short);
      if (short) return toast('Maintenez le micro pour parler');
      if (!keep) return haptic('tick');
      if (got) { qk.draft.voices.push(got); paintDraft(); haptic('step'); }
      else toast('Aucun son enregistré');
    };
    const down = (cx, cy) => {
      if (rec) return;
      if (!NATIVE) return toast('Les notes vocales s’enregistrent dans l’app');
      quickLocate();
      const host = btn.closest('.qk-compose'), box = btn.getBoundingClientRect(), hostBox = host.getBoundingClientRect();
      const bar = document.createElement('div'), lockEl = document.createElement('div'), hold = document.createElement('div');
      bar.className = 'qk-rec';
      bar.innerHTML = `<i class="vc-dot"></i><span class="vc-clock">0:00</span><div class="vc-live"></div><span class="qk-rec-hint">‹ Glisser pour annuler</span><button class="qk-rec-no" aria-label="Annuler">×</button><button class="qk-rec-ok" aria-label="Terminer le vocal">✓</button>`;
      const left = (box.left - hostBox.left + box.width / 2) + 'px', top = (box.top - hostBox.top + box.height / 2) + 'px';
      lockEl.className = 'qk-lock';
      lockEl.innerHTML = `${ic('lock')}<i></i>`;
      lockEl.style.left = left;
      hold.className = 'qk-hold';
      hold.innerHTML = ic('mic');
      hold.style.left = left;
      hold.style.top = top;
      host.append(bar, lockEl, hold);
      const r = rec = { bar, lockEl, hold, x: cx, y: cy, locked: false, over: false, session: null };
      $('.qk-rec-no', bar).onclick = () => end(false);
      $('.qk-rec-ok', bar).onclick = () => end(true);
      haptic('step');
      voiceSession((s, wave) => {
        $('.vc-clock', bar).textContent = fmtDur(s);
        $('.vc-live', bar).innerHTML = wave.slice(-22).map(v => `<i style="height:${Math.round(14 + v * 86)}%"></i>`).join('');
        hold.style.setProperty('--lv', (wave[wave.length - 1] || 0).toFixed(2));
      }, () => end(true)).then(session => {
        r.session = session;
        if (!session) { r.over = true; if (rec === r) rec = null; clear(r); return; }
        // le doigt s'est levé pendant que le micro s'ouvrait (ou que iOS demandait l'autorisation)
        if (r.over) session.stop(false);
      });
    };
    const move = (cx, cy) => {
      const r = rec;
      if (!r || r.locked) return;
      const up = Math.min(Math.max(0, r.y - cy), LOCK_AT), left = Math.min(Math.max(0, r.x - cx), DROP_AT), hint = $('.qk-rec-hint', r.bar);
      r.lockEl.style.setProperty('--up', up + 'px');
      r.hold.style.setProperty('--x', -left + 'px');
      r.hold.style.setProperty('--y', -up + 'px');
      hint.style.transform = `translateX(${-left}px)`;
      hint.style.opacity = Math.max(.15, 1 - left / DROP_AT);
      if (up >= LOCK_AT) {
        r.locked = true;
        r.bar.classList.add('locked');
        r.lockEl.remove();
        r.hold.remove();
        haptic('step');
      } else if (left >= DROP_AT) end(false);
    };
    const up = () => { if (rec && !rec.locked) end(true); };
    let wait = 0;
    const press = (cx, cy) => {
      if (!tap) return down(cx, cy);
      wait = setTimeout(() => { wait = 0; down(cx, cy); }, 320);
    };
    const release = () => {
      if (wait) { clearTimeout(wait); wait = 0; return tap(); }
      up();
    };
    // au doigt : des évènements tactiles retenus dès le début, sinon iOS reprend la main sur un appui long et annule tout
    let finger = null;
    const mine = e => Array.from(e.changedTouches).find(t => t.identifier === finger);
    btn.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); if (finger != null) return; const t = e.changedTouches[0]; finger = t.identifier; press(t.clientX, t.clientY); }, { passive: false });
    btn.addEventListener('touchmove', e => { const t = mine(e); if (t) { e.preventDefault(); move(t.clientX, t.clientY); } }, { passive: false });
    const lift = e => { if (mine(e)) { finger = null; release(); } };
    btn.addEventListener('touchend', lift);
    btn.addEventListener('touchcancel', lift);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    // à la souris
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      press(e.clientX, e.clientY);
      const mm = ev => move(ev.clientX, ev.clientY);
      const mu = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); release(); };
      addEventListener('mousemove', mm);
      addEventListener('mouseup', mu);
    });
  }

  // un bloc posé là où est le curseur
  function insertBlockHere(html) {
    restoreRange();
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const blk = wrap.firstChild;
    let b = currentBlock();
    while (b && b.parentNode !== edBody()) b = b.parentNode;
    histCommit();
    if (b && isBlank(b)) b.replaceWith(blk);
    else if (b) b.after(blk);
    else edBody().appendChild(blk);
    if (!blk.nextElementSibling) blk.after(emptyParagraph());
    changed();
    histCommit();
    return blk;
  }
  async function voiceInsert() {
    saveRange();
    const r = await recordVoice();
    if (r) insertBlockHere(voiceHTML(r));
  }

  function bindVoice() {
    document.addEventListener('click', e => {
      const blk = e.target.closest && e.target.closest('.ix-voice');
      if (!blk) return;
      e.stopPropagation();
      const w = e.target.closest('.vc-wave');
      if (w) { const r = w.getBoundingClientRect(); voiceToggle(blk, Math.max(0, Math.min(.98, (e.clientX - r.left) / r.width))); }
      else voiceToggle(blk);
    }, true);
  }

  /* ───────────── Note rapide ─────────────
   * Chaque note rapide est une carte de l'espace « Notes rapides », rangé dans iCloud : elle se synchronise donc comme
   * le reste, note par note, et apparaît aussi sur Mac et iPad. Elle garde son contexte (quand, où, avec quoi).
   * Sur iPhone, c'est l'écran d'accueil de l'app.
   */
  const QUICK_ID = 'notes-rapides';
  function ensureQuick() {
    ensureCloudRoot();
    if (byId(QUICK_ID)) return false;
    // updatedAt à 0, comme l'espace iCloud : la version partagée l'emporte toujours
    state.spaces.push({ id: QUICK_ID, title: 'Notes rapides', parent: CLOUD_ID, createdAt: 0, updatedAt: 0, docs: [] });
    return true;
  }
  const qk = { place: null, placeAt: 0, draft: { images: [], voices: [] } };
  const quickDevice = () => window.__PLATFORM === 'iphone' ? 'iPhone' : window.__PLATFORM === 'ipad' ? 'iPad' : 'Mac';
  const fmtDay = t => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtHour = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  function quickFacts(q) {
    const moving = q.speed > 8 ? 'en route' : q.speed > 1 ? 'en marche' : '';
    return [q.place || (q.lat != null ? `${q.lat.toFixed(3)}, ${q.lon.toFixed(3)}` : ''), q.device, moving].filter(Boolean);
  }

  // le lieu est cherché dès qu'on commence une note : il est prêt quand on l'envoie
  function quickLocate() {
    if (!NATIVE || !window.__PLATFORM || Date.now() - qk.placeAt < 60000) return Promise.resolve(qk.place);
    qk.placeAt = Date.now();
    // (pas de lieu cette fois : on réessaiera à la prochaine note)
    return (qk.finding = call('whereAmI').catch(() => null).then(p => { if (!p) qk.placeAt = 0; return (qk.place = p || null); }));
  }

  function quickSend(text) {
    const d = qk.draft;
    text = text.trim();
    if (!text && !d.images.length && !d.voices.length) return false;
    ensureQuick();
    const at = Date.now(), first = text.split('\n')[0].slice(0, 48);
    const html = text.split(/\n+/).map(l => `<p>${esc(l)}</p>`).join('')
      + d.images.map(s => `<img src="${esc(s)}" class="l">`).join('') + d.voices.map(voiceHTML).join('');
    const doc = newDoc(byId(QUICK_ID), { title: first || `Note du ${fmtDay(at)}, ${fmtHour(at)}`, html, quick: { at, device: quickDevice() } });
    qk.draft = { images: [], voices: [] };
    const put = p => {
      if (!p) return;
      Object.assign(doc.quick, p);
      doc.updatedAt = Date.now();
      persist();
      if (view === 'quick') renderQuick();
    };
    if (qk.place) put(qk.place);
    else if (qk.finding) qk.finding.then(put);
    return true;
  }

  /*
   * Relier deux notes qui se suivent, comme on recolle deux passages dans la mise en scène : la seconde rejoint la
   * première. Un trait garde la place de la jonction (et ce que la note savait d'elle-même) : « Séparer » les rend intactes.
   */
  const QK_JOIN = /<hr class="qk-join"[^>]*>/g;
  function quickJoin(a, b) {
    const sp = spaceOfDoc(a.id), hr = document.createElement('hr');
    hr.className = 'qk-join';
    hr.dataset.quick = JSON.stringify(b.quick || { at: b.createdAt });
    hr.dataset.title = b.title;
    a.html += hr.outerHTML + b.html;
    a.updatedAt = Date.now();
    sp.docs = sp.docs.filter(d => d !== b);
    sound.nav();
    haptic('step');
    persist(true);
    renderQuick();
  }
  function quickSplit(doc, n) {
    const m = [...doc.html.matchAll(QK_JOIN)][n];
    if (!m) return;
    const box = document.createElement('div');
    box.innerHTML = m[0];
    const { quick, title } = box.firstChild.dataset, rest = doc.html.slice(m.index + m[0].length);
    doc.html = doc.html.slice(0, m.index);
    doc.updatedAt = Date.now();
    newDoc(spaceOfDoc(doc.id), { title: title || '', html: rest, quick: JSON.parse(quick) });
    sound.nav();
    haptic('step');
    persist(true);
    renderQuick();
  }
  // la liste ne descend à la dernière note que sur demande (ouverture, envoi) : une mise à jour venue d'ailleurs (synchro,
  // lieu trouvé) ne doit jamais ramener en bas celui qui est en train de remonter
  function renderQuick(toEnd) {
    const sp = byId(QUICK_ID), list = $('#qkList'), top = list.scrollTop;
    const notes = (sp ? sp.docs : []).slice().sort((a, b) => (a.quick ? a.quick.at : a.createdAt) - (b.quick ? b.quick.at : b.createdAt));
    let day = '', html = '', before = null;
    for (const d of notes) {
      const q = d.quick || { at: d.createdAt }, label = fmtDay(q.at);
      if (before) html += `<button class="qk-link" data-a="${before.id}" data-b="${d.id}" aria-label="Relier ces deux notes" title="Relier ces deux notes"><svg viewBox="0 0 20 20"><path d="M8.3 11.7a3 3 0 0 0 4.3 0l2.5-2.5a3 3 0 0 0-4.3-4.3l-1 1M11.7 8.3a3 3 0 0 0-4.3 0l-2.5 2.5a3 3 0 0 0 4.3 4.3l1-1"/></svg></button>`;
      before = d;
      if (label !== day) { day = label; html += `<h3 class="qk-day">${esc(label)}</h3>`; }
      let cut = 0;
      html += `<article class="qk-note" data-id="${d.id}"><header><b>${fmtHour(q.at)}</b><span>${esc(quickFacts(q).join(', '))}</span>`
        + `<button class="qk-more" aria-label="Actions">${ic('more')}</button></header><div class="prose qk-body">${d.html.replace(QK_JOIN, m => { const i = cut++; return `${m}<button class="qk-cut" data-n="${i}">Séparer</button>`; })}</div></article>`;
    }
    list.innerHTML = html || '<p class="qk-empty">Une idée, une photo, votre voix</p>';
    list.scrollTop = toEnd ? list.scrollHeight : top;
  }

  function paintDraft() {
    const d = qk.draft, box = $('#qkDraft');
    box.innerHTML = d.images.map((s, i) => `<span class="qk-chip"><img src="${esc(s)}" alt=""><button data-del="${i}" aria-label="Retirer">×</button></span>`).join('')
      + d.voices.map((v, i) => `<span class="qk-chip voice">${ic('mic')} ${fmtDur(v.seconds)}<button data-voice="${i}" aria-label="Retirer">×</button></span>`).join('');
    box.hidden = !box.innerHTML;
    const any = !!($('#qkText').value.trim() || d.images.length || d.voices.length);
    $('#qkSend').classList.toggle('on', any);
    // comme dans une messagerie : le micro tant qu'il n'y a rien à envoyer, la flèche dès qu'on a écrit
    $('.qk-row').classList.toggle('ready', any);
  }

  function showQuick() {
    const added = ensureQuick();
    show('quick');
    renderQuick(true);
    paintDraft();
    paintPhoneNav();
    if (added) persist();   // (changer d'onglet ne réécrit pas la bibliothèque)
  }

  // choisir une page : une liste de toutes les pages, avec une recherche ; on peut aussi en créer une
  function pickPage(title) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'pg-pick';
      box.innerHTML = `<div class="pg-in"><header><b>${esc(title)}</b><button class="pg-x" aria-label="Fermer">×</button></header><input placeholder="Chercher une page" autocomplete="off"><div class="pg-list"></div></div>`;
      document.body.append(box);
      const close = v => { box.remove(); resolve(v); };
      const paint = q => {
        q = fold(q.trim());
        let html = '';
        for (const sp of state.spaces.filter(s => s.id !== QUICK_ID && s.id !== CLOUD_ID)) {
          const docs = sp.docs.filter(d => !q || fold(d.title || 'Sans titre').includes(q));
          if (q && !docs.length) continue;
          html += `<h4>${esc(pathOf(sp).map(p => p.title || 'Sans titre').join(' / '))}</h4>`
            + docs.map(d => `<button data-doc="${d.id}">${esc(d.title || 'Sans titre')}</button>`).join('')
            + `<button class="new" data-new="${sp.id}">+ Nouvelle page ici</button>`;
        }
        $('.pg-list', box).innerHTML = html || '<p class="qk-empty">Aucun espace : créez-en un depuis l’onglet Espaces.</p>';
      };
      paint('');
      $('input', box).addEventListener('input', e => paint(e.target.value));
      box.addEventListener('click', e => {
        if (e.target === box || e.target.closest('.pg-x')) return close(null);
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.doc) return close(findDoc(b.dataset.doc));
        if (b.dataset.new) return close(newDoc(byId(b.dataset.new), { title: '' }));
      });
    });
  }

  // la note part dans une page, avec son contexte en petit au-dessus : on la mettra au propre là-bas
  async function quickToPage(doc, move) {
    const to = await pickPage(move ? 'Déplacer vers une page' : 'Copier vers une page');
    if (!to) return;
    const q = doc.quick || { at: doc.createdAt };
    const src = [`${fmtDay(q.at)}, ${fmtHour(q.at)}`, ...quickFacts(q)].join(', ');
    to.html = (to.html || '') + `<p class="qn-src" contenteditable="false">${esc(src)}</p>` + doc.html;
    to.updatedAt = Date.now();
    if (move) {
      const sp = spaceOfDoc(doc.id);
      sp.docs = sp.docs.filter(d => d !== doc);
      sound.remove();
    } else sound.brush();
    persist(true);
    toast((move ? 'Déplacée dans « ' : 'Copiée dans « ') + (to.title || 'Sans titre') + ' »');
    if (view === 'quick') renderQuick();
    else if (view === 'space') renderRing();
  }

  function quickMenu(doc, x, y) {
    showMenu(x, y, [
      { label: 'Déplacer vers une page…', act: () => quickToPage(doc, true) },
      { label: 'Copier vers une page…', act: () => quickToPage(doc, false) },
      { label: 'Modifier', act: () => openDoc(doc.id) },
      '-',
      { label: 'Supprimer', danger: true, confirm: 'Confirmer la suppression', act: () => {
        const sp = spaceOfDoc(doc.id);
        sound.remove();
        sp.docs = sp.docs.filter(d => d !== doc);
        persist(true);
        renderQuick();
      } }
    ]);
  }

  function quickSettings(x, y) {
    const p = sound.prefs();
    showMenu(x, y, [
      { head: 'Espaces' },
      { label: sync.on ? 'Synchronisation iCloud : active' : 'Synchroniser avec iCloud…', act: toggleSync },
      { label: p.music ? 'Couper la musique' : 'Activer la musique', act: () => sound.setPrefs({ music: !p.music }) },
      { label: p.sfx ? 'Couper les bruitages' : 'Activer les bruitages', act: () => sound.setPrefs({ sfx: !p.sfx }) }
    ]);
  }

  function paintPhoneNav() {
    // tant qu'iCloud n'est pas connecté, les espaces ne sont pas là : on le dit clairement, avec le bouton pour le faire
    const hint = $('#cloudHint');
    if (hint) hint.hidden = !PHONE || sync.on || !NATIVE;
    for (const b of $$('#phoneNav button')) b.classList.toggle('on', (b.dataset.go === 'quick') === (view === 'quick'));
  }

  function bindQuick() {
    const text = $('#qkText');
    $('#qkMenu').innerHTML = ic('more');
    $('#qkSend').innerHTML = ic('send');
    $('#qkPhoto').innerHTML = ic('camera') + '<span>Photo</span>';
    $('#qkImage').innerHTML = ic('image') + '<span>Galerie</span>';
    $('#qkVoice').innerHTML = ic('mic');
    const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(150, text.scrollHeight) + 'px'; };
    text.addEventListener('input', () => { grow(); paintDraft(); });
    text.addEventListener('focus', () => { quickLocate(); sound.unlock(); document.body.classList.add('qk-typing'); });
    text.addEventListener('blur', () => document.body.classList.remove('qk-typing'));
    const sendNow = () => {
      if (!quickSend(text.value)) return;
      text.value = '';
      grow();
      paintDraft();
      renderQuick(true);
      haptic('step');
    };
    $('#qkPhoto').addEventListener('click', async () => {
      quickLocate();
      const url = await call('takePhoto').catch(() => null);
      if (url) { qk.draft.images.push(url); paintDraft(); }
    });
    $('#qkImage').addEventListener('click', async () => {
      quickLocate();
      const srcs = await chooseImages();
      if (srcs && srcs.length) { qk.draft.images.push(...srcs); paintDraft(); }
    });
    bindHoldVoice($('#qkVoice'));
    // une note déjà commencée : garder la flèche enfoncée y ajoute un vocal, un simple toucher l'envoie
    bindHoldVoice($('#qkSend'), sendNow);
    $('#qkDraft').addEventListener('click', e => {
      const b = e.target.closest('[data-del], [data-voice]');
      if (!b) return;
      if (b.dataset.voice) qk.draft.voices.splice(+b.dataset.voice, 1); else qk.draft.images.splice(+b.dataset.del, 1);
      paintDraft();
    });
    $('#qkList').addEventListener('click', e => {
      const link = e.target.closest('.qk-link'), cut = e.target.closest('.qk-cut');
      if (link) return quickJoin(findDoc(link.dataset.a), findDoc(link.dataset.b));
      if (cut) return quickSplit(findDoc(cut.closest('.qk-note').dataset.id), +cut.dataset.n);
      const b = e.target.closest('.qk-more');
      if (!b) return;
      const doc = findDoc(b.closest('.qk-note').dataset.id), r = b.getBoundingClientRect();
      if (doc) quickMenu(doc, r.right - 220, r.bottom + 6);
    });
    $('#cloudHint button').addEventListener('click', toggleSync);
    $('#qkMenu').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); quickSettings(r.right - 240, r.bottom + 6); });
    for (const b of $$('#phoneNav button')) b.addEventListener('click', () => {
      if (b.dataset.go === 'quick') return showQuick();
      if (view !== 'space') { ring.ctx = 'all'; sound.seed('tous'); show('space'); renderRing(); renderChrome(); placeRing({}); }
      paintPhoneNav();
    });
  }

  function hydrate(root, doc) {
    applyAnnos(root, doc);
    for (const s of $$('.ix-blank', root)) {
      const key = 'trou.' + (s.dataset.id || ''), min = { s: 6, m: 11, l: 22 }[s.dataset.size] || 11;
      const inp = document.createElement('input');
      inp.className = 'ix-blank-in';
      inp.placeholder = s.dataset.hint || '';
      inp.value = store.get(key) || '';
      inp.spellcheck = false;
      inp.setAttribute('aria-label', s.dataset.hint || 'Complétez');
      const fit = () => { inp.style.width = Math.max(min, (inp.value || inp.placeholder).length + 2) + 'ch'; };
      inp.oninput = () => { fit(); store.set(key, inp.value); if (inp.value.length % 3 === 1) sound.word(); };
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
      inp.onchange = () => { if (inp.value.trim()) sound.check(true); };
      s.textContent = '';
      s.append(inp);
      s.classList.toggle('filled', !!inp.value);
      inp.addEventListener('input', () => s.classList.toggle('filled', !!inp.value));
      fit();
    }
    for (const im of $$('img[data-zoom]', root)) zoomable(im);
    for (const d of $$('details.ix-fold', root)) {
      d.open = false;
      d.addEventListener('toggle', () => sound[d.open ? 'pop' : 'nav']());
    }
    for (const s of $$('.ix-hide', root)) s.addEventListener('click', e => { e.stopPropagation(); s.classList.toggle('shown'); sound.brush(); });
    for (const n of $$('.ix-note', root)) n.addEventListener('click', e => { e.stopPropagation(); noteBubble(n); });
    for (const a of $$('[data-goto]', root)) a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); gotoCard(a.dataset.goto, a); });

    for (const g of $$('.ix-gallery', root)) {
      const srcs = $$('img', g).map(i => i.getAttribute('src'));
      g.classList.add('live');
      // une photo à la fois, toujours entière (réduite pour tenir dans son cadre) : un clic = une photo
      const n = srcs.length;
      g.innerHTML = `<div class="ix-gal-view"><div class="ix-gal-track">${srcs.map((s, i) => `<div class="ix-gal-slide"><img src="${esc(s)}" data-i="${i}" alt=""></div>`).join('')}</div></div>`
        + (n > 1 ? `<button class="ix-gal-prev" aria-label="Photo précédente">‹</button><button class="ix-gal-next" aria-label="Photo suivante">›</button><div class="ix-gal-dots">${srcs.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>` : '');
      const track = $('.ix-gal-track', g);
      let k = 0;
      const show = i => {
        k = (i + n) % n;
        track.style.transform = `translateX(${-k * 100}%)`;
        $$('.ix-gal-dots i', g).forEach((d, j) => d.classList.toggle('on', j === k));
      };
      show(0);
      if (n > 1) {
        $('.ix-gal-prev', g).onclick = e => { e.stopPropagation(); show(k - 1); sound.tick(); };
        $('.ix-gal-next', g).onclick = e => { e.stopPropagation(); show(k + 1); sound.tick(); };
        $('.ix-gal-dots', g).onclick = e => { e.stopPropagation(); const d = e.target.closest('i'); if (d) show(+d.dataset.i); };
        // glisser du doigt ou du trackpad d'une photo à l'autre
        let sx = null, wheel = 0, wt = 0;
        g.addEventListener('pointerdown', e => { sx = e.clientX; });
        g.addEventListener('pointerup', e => { if (sx != null && Math.abs(e.clientX - sx) > 40) { show(k + (e.clientX < sx ? 1 : -1)); g.dataset.swiped = '1'; } sx = null; });
        g.addEventListener('wheel', e => {
          if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
          e.preventDefault();
          const now = performance.now();
          if (now - wt < 450) return;
          wheel += e.deltaX;
          if (Math.abs(wheel) > 30) { show(k + Math.sign(wheel)); wheel = 0; wt = now; }
        }, { passive: false });
      }
      track.onclick = e => {
        e.stopPropagation();
        if (g.dataset.swiped) { delete g.dataset.swiped; return; }
        const im = e.target.closest('img');
        if (im) lightbox(srcs, +im.dataset.i);
      };
    }

    for (const c of $$('.ix-compare', root)) {
      const v = IX.compare.read(c);
      c.classList.add('live');
      c.innerHTML = `<img class="ix-b" src="${esc(v.b)}"><div class="ix-a-wrap"><img class="ix-a" src="${esc(v.a)}"></div><div class="ix-handle"><i></i></div><span class="ix-la">${esc(v.la)}</span><span class="ix-lb">${esc(v.lb)}</span>`;
      const set = x => { const r = c.getBoundingClientRect(); c.style.setProperty('--p', Math.max(0, Math.min(100, (x - r.left) / r.width * 100)) + '%'); };
      let on = false;
      c.onpointerdown = e => { on = true; c.setPointerCapture(e.pointerId); set(e.clientX); e.stopPropagation(); };
      c.onpointermove = e => { if (on) set(e.clientX); };
      c.onpointerup = () => { on = false; };
      c.onclick = e => e.stopPropagation();
    }

    for (const b of $$('.ix-answer', root)) {
      const key = doc.id + '.' + b.dataset.id;
      b.classList.add('live');
      b.innerHTML = `<div class="ix-q">${esc(b.dataset.q)}</div><textarea rows="4" placeholder="${esc(b.dataset.ph || '')}"></textarea><div class="ix-row"><small>Votre réponse reste dans ce navigateur</small><button class="btn ghost">Copier</button></div>`;
      const ta = $('textarea', b);
      ta.value = store.get(key) || '';
      ta.oninput = () => store.set(key, ta.value);
      ta.onclick = e => e.stopPropagation();
      $('button', b).onclick = e => { e.stopPropagation(); navigator.clipboard && navigator.clipboard.writeText(ta.value).then(() => toast('Réponse copiée'), () => {}); };
    }

    for (const q of $$('.ix-quiz', root)) {
      const qs = json(q.dataset.quiz) || [];
      const build = () => {
        let score = 0, answered = 0;
        q.classList.add('live');
        q.innerHTML = '';
        const result = document.createElement('div');
        result.className = 'ix-qz-result';
        qs.forEach(item => {
          const box = document.createElement('div');
          box.className = 'ix-qz-item';
          box.innerHTML = `<div class="ix-qz-q">${esc(item.q)}</div><div class="ix-qz-opts"></div>`;
          const opts = $('.ix-qz-opts', box);
          item.options.forEach((o, oi) => {
            const btn = document.createElement('button');
            btn.className = 'ix-qz-opt';
            btn.textContent = o;
            btn.onclick = e => {
              e.stopPropagation();
              if (box.dataset.done) return;
              box.dataset.done = '1';
              answered++;
              const good = oi === item.correct;
              if (good) score++;
              btn.classList.add(good ? 'ok' : 'ko');
              opts.children[item.correct].classList.add('ok');
              if (good) sound.check(true); else sound.remove();
              if (answered === qs.length) {
                result.innerHTML = `<b>${score} / ${qs.length}</b> bonne${score > 1 ? 's' : ''} réponse${score > 1 ? 's' : ''} <button class="btn ghost">Recommencer</button>`;
                $('button', result).onclick = ev => { ev.stopPropagation(); build(); };
                if (score === qs.length) sound.create();
              }
            };
            opts.append(btn);
          });
          q.append(box);
        });
        q.append(result);
      };
      build();
    }

    for (const l of $$('.ix-check', root)) {
      const items = json(l.dataset.items) || [], key = doc.id + '.' + l.dataset.id;
      const state = store.get(key) || [];
      l.classList.add('live');
      l.innerHTML = (l.dataset.title ? `<div class="ix-q">${esc(l.dataset.title)}</div>` : '') + '<ul></ul><div class="ix-check-count"></div>';
      const ul = $('ul', l), count = $('.ix-check-count', l);
      const paint = () => { count.textContent = `${state.filter(Boolean).length} / ${items.length}`; };
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.textContent = it;
        li.classList.toggle('done', !!state[i]);
        li.onclick = e => { e.stopPropagation(); state[i] = !state[i]; li.classList.toggle('done', state[i]); sound.check(state[i]); store.set(key, state); paint(); };
        ul.append(li);
      });
      paint();
    }

    for (const b of $$('.ix-breathe', root)) breathe(b, doc);

    // carte à gratter : une surface qu'on efface au doigt ou à la souris
    for (const s of $$('.ix-scratch', root)) {
      s.classList.add('live');
      const cv = document.createElement('canvas');
      cv.className = 'ix-sc-layer';
      s.append(cv);
      const g = cv.getContext('2d');
      let ready = false, down = false, moves = 0;
      const paint = () => {
        const r = s.getBoundingClientRect();
        if (!r.width) return;
        const dpr = window.devicePixelRatio || 1;
        cv.width = r.width * dpr; cv.height = r.height * dpr;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const gr = g.createLinearGradient(0, 0, r.width, r.height);
        gr.addColorStop(0, '#d9d7cf'); gr.addColorStop(.5, '#eceae4'); gr.addColorStop(1, '#c9c6bd');
        g.fillStyle = gr; g.fillRect(0, 0, r.width, r.height);
        for (let i = 0; i < r.width * r.height / 40; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * .06})`; g.fillRect(Math.random() * r.width, Math.random() * r.height, 1, 1); }
        g.fillStyle = 'rgba(40,40,40,.55)';
        g.font = '600 15px -apple-system, Helvetica, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(s.dataset.label || 'Grattez ici', r.width / 2, r.height / 2);
        g.globalCompositeOperation = 'destination-out';
        ready = true;
      };
      requestAnimationFrame(paint);
      const scratch = e => {
        if (!ready) paint();
        const r = cv.getBoundingClientRect();
        g.beginPath(); g.arc(e.clientX - r.left, e.clientY - r.top, 22, 0, 6.28); g.fill();
        sound.brush();
        if (++moves % 12 === 0) {
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          let clear = 0, tot = 0;
          for (let i = 3; i < d.length; i += 64) { tot++; if (d[i] < 40) clear++; }
          if (clear / tot > .55) { cv.classList.add('gone'); sound.create(); }
        }
      };
      cv.onpointerdown = e => { e.stopPropagation(); down = true; cv.setPointerCapture(e.pointerId); scratch(e); };
      cv.onpointermove = e => { if (down) scratch(e); };
      cv.onpointerup = () => { down = false; };
      cv.onclick = e => e.stopPropagation();
    }

    // énigme : la bonne réponse révèle un texte, la suite de la page, ou une carte
    for (const q of $$('.ix-riddle', root)) {
      const key = doc.id + '.' + q.dataset.id;
      q.classList.add('live');
      q.innerHTML = `<div class="ix-q">${esc(q.dataset.q)}</div><form class="ix-rd-form"><input placeholder="Votre réponse" autocomplete="off"><button class="btn">Valider</button>${q.dataset.hint ? '<button type="button" class="btn ghost ix-rd-hint">Indice</button>' : ''}</form><div class="ix-rd-msg"></div><div class="ix-rd-reveal" hidden></div>`;
      const gated = [];
      if (q.dataset.gate === '1') {
        let n = q.nextElementSibling;
        while (n) { n.classList.add('rd-gated'); gated.push(n); n = n.nextElementSibling; }
      }
      const solve = quiet => {
        $('.ix-rd-form', q).hidden = true;
        const rv = $('.ix-rd-reveal', q);
        rv.hidden = false;
        rv.innerHTML = (q.dataset.reveal ? esc(q.dataset.reveal).split('\n').map(l => `<p>${l}</p>`).join('') : '<p>Bonne réponse.</p>')
          + (q.dataset.to && findDoc(q.dataset.to) ? `<a class="ix-opt" data-goto="${esc(q.dataset.to)}" href="#">${esc(findDoc(q.dataset.to).title || 'Continuer')}</a>` : '');
        for (const a of $$('[data-goto]', rv)) a.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); gotoCard(a.dataset.goto, a); });
        for (const n of gated) n.classList.remove('rd-gated');
        q.classList.add('solved');
        if (!quiet) { sound.create(); store.set(key, true); }
      };
      if (store.get(key)) solve(true);
      const answers = (q.dataset.a || '').split('/').map(x => foldKeep(x).trim()).filter(Boolean);
      const hashes = (q.dataset.h || '').split(' ').filter(Boolean);
      $('.ix-rd-form', q).onsubmit = async e => {
        e.preventDefault();
        const v = foldKeep($('input', q).value).trim().replace(/\s+/g, ' ');
        let good = answers.includes(v);
        if (!good && hashes.length && window.crypto && crypto.subtle) good = hashes.includes(await sha(v));
        if (good) solve(false);
        else { $('.ix-rd-msg', q).textContent = 'Pas tout à fait…'; q.classList.remove('shake'); void q.offsetWidth; q.classList.add('shake'); sound.remove(); }
      };
      const h = $('.ix-rd-hint', q);
      if (h) h.onclick = e => { e.stopPropagation(); $('.ix-rd-msg', q).textContent = 'Indice : ' + q.dataset.hint; };
      q.onclick = e => e.stopPropagation();
    }
  }

  // Respiration guidée : le cercle s'ouvre à l'inspiration, se ferme à l'expiration.
  function breathe(el, doc) {
    const min = +el.dataset.min || 2;
    const pat = (el.dataset.pattern || '4-4-6').split('-').map(Number);
    const phases = pat.length === 2 ? [['Inspirez', pat[0], 1], ['Expirez', pat[1], 0]]
      : pat.length === 3 ? [['Inspirez', pat[0], 1], ['Retenez', pat[1], 1], ['Expirez', pat[2], 0]]
      : [['Inspirez', pat[0], 1], ['Retenez', pat[1], 1], ['Expirez', pat[2], 0], ['Retenez', pat[3], 0]];
    el.classList.add('live');
    el.innerHTML = `<div class="ix-br-text">${esc(el.dataset.text || '')}</div><div class="ix-br-circle"><span>Commencer</span></div><div class="ix-br-time">${min} min</div>`;
    const circle = $('.ix-br-circle', el), label = $('span', circle), time = $('.ix-br-time', el);
    let timer = null, tick = null, end = 0;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(tick);
      timer = tick = null;
      circle.style.transitionDuration = '1.2s';
      circle.classList.remove('big');
      label.textContent = 'Commencer';
      time.textContent = min + ' min';
      sound.seed('carte:' + doc.id, docMood(doc));
    };
    const phase = k => {
      if (Date.now() > end) { stop(); label.textContent = 'Terminé'; sound.create(); return; }
      const [name, sec, big] = phases[k % phases.length];
      label.textContent = name;
      circle.style.transitionDuration = sec + 's';
      circle.classList.toggle('big', !!big);
      sound.chime(k);
      timer = setTimeout(() => phase(k + 1), sec * 1000);
    };
    circle.onclick = e => {
      e.stopPropagation();
      if (timer) return stop();
      end = Date.now() + min * 60000;
      sound.seed('respiration:' + doc.id, 'calme');
      tick = setInterval(() => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        time.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 500);
      phase(0);
    };
    reader.cleanup.push(() => { clearTimeout(timer); clearInterval(tick); });
  }

  /* ── Carte protégée par mot de passe ── */

  // Dans l'export, le contenu d'une carte protégée est chiffré (AES-GCM, clé dérivée du mot de passe).
  const bufToB64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const b64ToBuf = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  async function keyFrom(pw, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptDoc(doc) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFrom(doc.lock, salt);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ title: doc.title, html: doc.html, plain: doc.plain || '' })));
    return { salt: bufToB64(salt), iv: bufToB64(iv), data: bufToB64(data) };
  }
  async function decryptLocked(l, pw) {
    const key = await keyFrom(pw, b64ToBuf(l.salt));
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(l.iv) }, key, b64ToBuf(l.data));
    return JSON.parse(new TextDecoder().decode(buf));
  }

  const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('');
  async function hashRiddles(html) {
    if (!(window.crypto && crypto.subtle)) return html;
    const box = document.createElement('div');
    box.innerHTML = html;
    for (const q of $$('.ix-riddle', box)) {
      const answers = (q.dataset.a || '').split('/').map(x => foldKeep(x).trim().replace(/\s+/g, ' ')).filter(Boolean);
      q.dataset.h = (await Promise.all(answers.map(sha))).join(' ');
      q.removeAttribute('data-a');
      const shown = $('.ix-rd-answer', q);
      if (shown) shown.remove();
    }
    return box.innerHTML;
  }

  const unlocked = new Set();
  const isLocked = d => !!(d && (d.lock || d.locked) && !unlocked.has(d.id));

  async function unlockDoc(doc) {
    const r = await ixDialog({ title: 'Carte protégée', fields: [{ name: 'pw', label: 'Mot de passe', type: 'password' }], submit: 'Ouvrir' });
    if (!r || !r.values) return false;
    const pw = r.values.pw;
    if (doc.locked) {
      try { Object.assign(doc, await decryptLocked(doc.locked, pw)); delete doc.locked; }
      catch (e) { toast('Mot de passe incorrect'); sound.remove(); return false; }
    } else if (pw !== doc.lock) { toast('Mot de passe incorrect'); sound.remove(); return false; }
    unlocked.add(doc.id);
    sound.create();
    if (view === 'space') renderRing();
    return true;
  }

  async function editLock() {
    const r = await ixDialog({
      title: 'Protéger la carte',
      note: 'L’export est chiffré',
      fields: [{ name: 'pw', label: 'Mot de passe', value: edDoc.lock || '' }],
      actions: edDoc.lock ? [{ label: 'Retirer la protection', value: 'delete', danger: true }] : [],
      submit: 'Protéger'
    });
    if (!r) return;
    if (r.action === 'delete' || !r.values.pw) delete edDoc.lock; else edDoc.lock = r.values.pw;
    paintMoodButton();
    changed();
  }

  /* ───────────── Immersion : météo, lampe, constellation, voyage ───────────── */

  const WEATHERS = [
    { id: '', name: 'Aucune', icon: ic('none') },
    { id: 'pluie', name: 'Pluie', icon: ic('pluie') }, { id: 'orage', name: 'Orage', icon: ic('orage') }, { id: 'neige', name: 'Neige', icon: ic('neige') },
    { id: 'brume', name: 'Brume', icon: ic('brume') }, { id: 'aurore', name: 'Aurore', icon: ic('aurore') }, { id: 'lucioles', name: 'Lucioles', icon: ic('lucioles') },
    { id: 'feuilles', name: 'Feuilles', icon: ic('feuilles') }, { id: 'petales', name: 'Pétales', icon: ic('petales') }, { id: 'desert', name: 'Désert', icon: ic('desert') },
    { id: 'feu', name: 'Feu de cheminée', short: 'Cheminée', icon: ic('feu') }
  ];

  // Météo : une couche animée au-dessus de la page, et son paysage sonore.
  // Chaque phénomène a de la profondeur (plusieurs plans), du vent, et des formes douces plutôt que géométriques.
  function sprite(size, stops) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // texture de nuage : un bruit doux sur plusieurs octaves, qui se raccorde à ses bords
  let fogTex = null;
  function fogTexture() {
    if (fogTex) return fogTex;
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), img = g.createImageData(S, S);
    const octaves = [[4, .5], [8, .27], [16, .15], [32, .08]].map(([n, w]) => ({ n, w, v: Array.from({ length: n * n }, Math.random) }));
    const smooth = t => t * t * (3 - 2 * t);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let v = 0;
      for (const o of octaves) {
        const fx = x / S * o.n, fy = y / S * o.n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
        const at = (i, j) => o.v[((j % o.n) * o.n) + (i % o.n)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * o.w;
      }
      const k = (y * S + x) * 4, al = Math.max(0, Math.min(1, (v - .32) * 1.9));
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = al * al * 255;
    }
    g.putImageData(img, 0, 0);
    // un léger flou, appliqué sur la texture répétée 3 × 3 pour que ses bords restent invisibles
    const big = document.createElement('canvas');
    big.width = big.height = S * 3;
    const bg = big.getContext('2d');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) bg.drawImage(c, i * S, j * S);
    const out = document.createElement('canvas');
    out.width = out.height = S;
    const og = out.getContext('2d');
    og.filter = 'blur(6px)';
    og.drawImage(big, -S, -S);
    return (fogTex = out);
  }

  // une feuille d'arbre, dessinée autour de son centre, la nervure plus sombre
  function leafPath(g, s) {
    g.beginPath();
    g.moveTo(-s, 0);
    g.bezierCurveTo(-s * .5, -s * .62, s * .55, -s * .5, s, 0);
    g.bezierCurveTo(s * .55, s * .5, -s * .5, s * .62, -s, 0);
  }

  /*
   * Les nouvelles atmosphères. Chacune garde la colonne de lecture dégagée : les lumières et les voiles
   * se tiennent surtout sur les bords, assez légers pour que le texte reste toujours net.
   */
  function moreWeather(kind, env) {
    const { g, dark, cv } = env, R = (a, b) => a + Math.random() * (b - a);
    let { W, H } = env;
    const sync = () => { W = env.W; H = env.H; };

    if (kind === 'feuilles' || kind === 'petales') {
      const leaves = kind === 'feuilles';
      const cols = leaves ? ['#c0612b', '#d98e32', '#a8432a', '#d9a640', '#8a5a2b', '#b5762e'] : (dark ? ['#f6d3dc', '#f2c0cd', '#fbe4ea'] : ['#e8a3b6', '#e293a8', '#efb7c6']);
      const mk = top => ({ x: R(-60, W + 60), y: top ? R(-H, -20) : R(-H, H), s: leaves ? R(11, 20) : R(7, 12), z: R(.5, 1.1), v: leaves ? R(40, 80) : R(18, 40),
        rot: R(0, 6.28), vr: R(-1.8, 1.8), ph: R(0, 6.28), fl: R(1.2, 3), sw: R(15, 45), col: cols[Math.floor(Math.random() * cols.length)] });
      const items = Array.from({ length: leaves ? 32 : 64 }, () => mk(false));
      let gust = 0, nextGust = R(3, 7);
      return (dt, t) => {
        sync();
        nextGust -= dt;
        if (nextGust < 0) { gust = leaves ? R(60, 140) : R(30, 70); nextGust = R(5, 11); }
        gust *= Math.pow(.6, dt);
        const wind = (leaves ? 18 : 10) + Math.sin(t * .3) * 12 + gust;
        for (const f of items) {
          f.y += f.v * f.z * dt;
          f.x += (wind * f.z + Math.cos(t * f.fl * .5 + f.ph) * f.sw) * dt;
          f.rot += (f.vr + gust * .01) * dt;
          if (f.y - f.s * 2 > H || f.x - 40 > W) Object.assign(f, mk(true), { x: R(-200, W * .8) });
          g.save();
          g.translate(f.x, f.y);
          g.rotate(f.rot);
          // la feuille tourne sur elle-même : on la voit de face, puis de tranche
          g.scale(1, .35 + .65 * Math.abs(Math.cos(t * f.fl + f.ph)));
          g.globalAlpha = (leaves ? .9 : .85) * (.6 + f.z * .4);
          g.fillStyle = f.col;
          if (leaves) {
            leafPath(g, f.s * f.z);
            g.fill();
            g.strokeStyle = 'rgba(70,35,15,.35)';
            g.lineWidth = .7;
            g.beginPath(); g.moveTo(-f.s * f.z, 0); g.lineTo(f.s * f.z, 0); g.stroke();
          } else {
            const s = f.s * f.z;
            g.beginPath();
            g.moveTo(0, -s);
            g.bezierCurveTo(s * 1.1, -s * .8, s * .9, s * .7, 0, s);
            g.bezierCurveTo(-s * .9, s * .7, -s * 1.1, -s * .8, -s * .15, -s * .75);
            g.fill();
          }
          g.restore();
        }
        g.globalAlpha = 1;
      };
    }

    if (kind === 'aurore') {
      // des voiles de lumière en haut de l'écran, qui ondulent et respirent
      const strip = (stops) => {
        const c = document.createElement('canvas');
        c.width = 1; c.height = 128;
        const sg = c.getContext('2d'), gr = sg.createLinearGradient(0, 0, 0, 128);
        for (const [o, cl] of stops) gr.addColorStop(o, cl);
        sg.fillStyle = gr;
        sg.fillRect(0, 0, 1, 128);
        return c;
      };
      const ribbons = dark
        ? [strip([[0, 'rgba(120,255,190,0)'], [.25, 'rgba(120,255,190,.9)'], [.6, 'rgba(90,200,255,.45)'], [1, 'rgba(160,90,255,0)']]),
          strip([[0, 'rgba(200,120,255,0)'], [.3, 'rgba(200,120,255,.7)'], [1, 'rgba(90,255,200,0)']]),
          strip([[0, 'rgba(90,255,170,0)'], [.35, 'rgba(90,255,170,.8)'], [1, 'rgba(90,255,170,0)']])]
        : [strip([[0, 'rgba(30,160,120,0)'], [.25, 'rgba(30,160,120,.8)'], [.6, 'rgba(40,120,190,.4)'], [1, 'rgba(110,60,190,0)']]),
          strip([[0, 'rgba(130,70,200,0)'], [.3, 'rgba(130,70,200,.6)'], [1, 'rgba(30,160,120,0)']]),
          strip([[0, 'rgba(20,150,110,0)'], [.35, 'rgba(20,150,110,.7)'], [1, 'rgba(20,150,110,0)']])];
      const rb = ribbons.map((img, k) => ({ img, ph: R(0, 6.28), y: .04 + k * .05, len: .2 + k * .04, a: [.5, .3, .42][k] }));
      if (dark) cv.classList.add('additive');
      const stars = dark ? Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * .5, a: R(.2, .7), p: R(0, 6.28) })) : [];
      // dessinée en basse résolution puis agrandie : des voiles lisses, sans rayures
      const lo = document.createElement('canvas'), lg = lo.getContext('2d'), Q = 4;
      return (dt, t) => {
        sync();
        for (const s of stars) { g.fillStyle = `rgba(255,255,255,${(s.a * (.6 + .4 * Math.sin(t * 1.3 + s.p))).toFixed(3)})`; g.fillRect(s.x * W, s.y * H, 1.2, 1.2); }
        const w = Math.ceil(W / Q), h = Math.ceil(H / Q);
        if (lo.width !== w || lo.height !== h) { lo.width = w; lo.height = h; }
        lg.clearRect(0, 0, w, h);
        if (dark) lg.globalCompositeOperation = 'lighter';
        for (const r of rb) {
          for (let c = -2; c < w + 2; c++) {
            const x = c * Q;
            const y0 = H * (r.y + .05 * Math.sin(x * .0035 + t * .18 + r.ph) + .025 * Math.sin(x * .011 - t * .31 + r.ph));
            const len = H * (r.len + .08 * Math.sin(x * .006 + t * .4 + r.ph));
            const fold = .5 + .5 * Math.sin(x * .028 + t * .7 + r.ph * 2) * Math.sin(x * .009 - t * .23);
            lg.globalAlpha = r.a * (.25 + .75 * fold * fold) * (dark ? 1 : .6);
            lg.drawImage(r.img, c, y0 / Q, 1, len / Q);
          }
        }
        lg.globalAlpha = 1;
        // la colonne de lecture reste dégagée : l'aurore encadre la page, elle ne passe pas derrière le texte
        lg.globalCompositeOperation = 'destination-out';
        const half = Math.min(400, W * .45), k0 = Math.max(0, .5 - (half + 90) / W), k1 = Math.max(k0 + .01, .5 - (half - 20) / W);
        const col = lg.createLinearGradient(0, 0, w, 0);
        col.addColorStop(k0, 'rgba(0,0,0,0)');
        col.addColorStop(k1, 'rgba(0,0,0,.92)');
        col.addColorStop(1 - k1, 'rgba(0,0,0,.92)');
        col.addColorStop(1 - k0, 'rgba(0,0,0,0)');
        lg.fillStyle = col;
        lg.fillRect(0, 0, w, h);
        lg.globalCompositeOperation = 'source-over';
        g.imageSmoothingQuality = 'high';
        g.drawImage(lo, 0, 0, w * Q, h * Q);
      };
    }

    if (kind === 'desert') {
      /*
       * Un désert sous le vent : un soleil voilé dans un coin, des « serpents » de sable qui ondulent au ras du sol,
       * des grains qui avancent par petits bonds, et, quand une rafale passe, un nuage de poussière qui traverse le bas de l'écran.
       */
      const sand = dark ? '214,190,150' : '176,128,62';
      const glare = dark ? '190,205,235' : '255,214,140';
      const ribbons = Array.from({ length: 9 }, (_, k) => ({
        y: .7 + k * .035 + R(-.01, .01), A: R(4, 10), k1: R(.006, .011), k2: R(.017, .028), w1: R(.9, 1.6), w2: R(1.8, 2.8),
        v: R(70, 120), ph: R(0, 100), lw: R(1, 2.2), a: R(.28, .5)
      }));
      // un grain avance en sautillant : il décolle, retombe, repart (la saltation)
      const grain = () => ({ x: R(-40, W), base: H * R(.62, 1.01), hop: R(4, 22), ph: R(0, 6.28), rate: R(2.5, 5), v: R(.7, 1.3), s: R(.7, 1.6), a: R(.35, .7) });
      const grains = Array.from({ length: 170 }, grain);
      const dust = sprite(128, [[0, `rgba(${sand},.9)`], [.5, `rgba(${sand},.35)`], [1, `rgba(${sand},0)`]]);
      const clouds = [];
      let gust = 0, nextGust = R(3, 6);
      // l'intensité du sable à un endroit du ruban : des trainées discontinues qui avancent avec le vent
      const streak = (x, r, t) => {
        const u = x - t * r.v * (1 + gust * .8);
        const n = Math.sin(u * .0042 + r.ph) * Math.sin(u * .0013 + r.ph * 1.7) + .35 * Math.sin(u * .011 + r.ph * .3);
        return Math.max(0, (n - .15) / 1.2);
      };
      return (dt, t) => {
        sync();
        nextGust -= dt;
        if (nextGust < 0) {
          gust = R(1, 1.8); nextGust = R(6, 12);
          sound.gust();
          clouds.push({ x: -W * .4, y: H * R(.72, .9), w: W * R(.35, .55), h: H * R(.12, .2), v: R(260, 380), a: R(.12, .2) });
        }
        gust *= Math.pow(.45, dt);
        // le soleil (ou la lune) voilé, dans le coin
        const gx = W * .92, gy = -H * .05, gr = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(W, H) * .6);
        const pulse = .9 + .1 * Math.sin(t * .4);
        gr.addColorStop(0, `rgba(${glare},${(dark ? .2 : .32) * pulse})`);
        gr.addColorStop(.35, `rgba(${glare},${(dark ? .07 : .12) * pulse})`);
        gr.addColorStop(1, `rgba(${glare},0)`);
        g.fillStyle = gr;
        g.fillRect(0, 0, W, H);
        // la chaleur (ou le froid de la nuit) qui monte du sol
        const ground = g.createLinearGradient(0, H * .6, 0, H);
        ground.addColorStop(0, `rgba(${sand},0)`);
        ground.addColorStop(1, `rgba(${sand},${dark ? .1 : .14})`);
        g.fillStyle = ground;
        g.fillRect(0, H * .6, W, H * .4);
        // les serpents de sable
        g.lineCap = 'round';
        for (const r of ribbons) {
          const y0 = r.y * H;
          let px = -20, py = y0;
          for (let x = -20; x <= W + 20; x += 10) {
            const y = y0 + r.A * Math.sin(x * r.k1 - t * r.w1 + r.ph) + r.A * .45 * Math.sin(x * r.k2 - t * r.w2);
            const a = streak(x, r, t) * r.a * (1 + gust * .5);
            if (a > .01) {
              g.strokeStyle = `rgba(${sand},${Math.min(.75, a).toFixed(3)})`;
              g.lineWidth = r.lw;
              g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
            }
            px = x; py = y;
          }
        }
        // les grains, par petits bonds
        g.fillStyle = `rgb(${sand})`;
        for (const s of grains) {
          s.x += (70 + gust * 200) * s.v * dt;
          s.ph += s.rate * dt;
          if (s.x > W + 20) Object.assign(s, grain(), { x: R(-60, -5) });
          const y = s.base - Math.abs(Math.sin(s.ph)) * s.hop * (1 + gust);
          g.globalAlpha = s.a * (dark ? .75 : 1);
          g.fillRect(s.x, y, s.s, s.s);
        }
        // un nuage de poussière soulevé par la rafale
        for (let i = clouds.length - 1; i >= 0; i--) {
          const c = clouds[i];
          c.x += c.v * dt;
          if (c.x - c.w > W) { clouds.splice(i, 1); continue; }
          g.globalAlpha = c.a * (dark ? .7 : 1);
          g.drawImage(dust, c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
          g.drawImage(dust, c.x - c.w * .9, c.y - c.h * .3, c.w * .7, c.h * .8);
        }
        g.globalAlpha = 1;
      };
    }

    if (kind === 'feu') {
      // la lueur d'un feu de cheminée qui vacille depuis le bas, des braises qui montent
      const ember = sprite(48, [[0, 'rgba(255,240,190,1)'], [.2, 'rgba(255,170,70,.9)'], [.5, 'rgba(255,110,30,.25)'], [1, 'rgba(255,80,20,0)']]);
      const embers = [];
      if (dark) cv.classList.add('additive');
      let flick = .5;
      return (dt, t) => {
        sync();
        flick += (Math.random() - .5) * dt * 6;
        flick = Math.max(.2, Math.min(1, flick + (.6 - flick) * dt * 2));
        const f = .65 + .2 * Math.sin(t * 7.3) * Math.sin(t * 3.1) + .25 * flick;
        const gl = g.createRadialGradient(W / 2, H * 1.25, H * .2, W / 2, H * 1.25, H * 1.15);
        gl.addColorStop(0, `rgba(255,130,40,${((dark ? .32 : .26) * f).toFixed(3)})`);
        gl.addColorStop(.55, `rgba(255,150,60,${((dark ? .12 : .1) * f).toFixed(3)})`);
        gl.addColorStop(1, 'rgba(255,150,60,0)');
        g.fillStyle = gl;
        g.fillRect(0, 0, W, H);
        if (Math.random() < dt * 9) embers.push({ x: W / 2 + R(-W * .35, W * .35), y: H + 10, vx: R(-15, 15), vy: R(-90, -40), life: 0, max: R(2.5, 5), s: R(5, 11), p: R(0, 6.28) });
        for (let i = embers.length - 1; i >= 0; i--) {
          const e = embers[i];
          e.life += dt;
          if (e.life > e.max) { embers.splice(i, 1); continue; }
          e.x += (e.vx + Math.sin(t * 2.5 + e.p) * 22) * dt; e.y += e.vy * dt;
          const k = e.life / e.max;
          g.globalAlpha = (1 - k) * (dark ? 1 : .85) * (.6 + .4 * Math.sin(t * 13 + e.p));
          const S = e.s * (1 - k * .5);
          g.drawImage(ember, e.x - S / 2, e.y - S / 2, S, S);
        }
        g.globalAlpha = 1;
      };
    }

    return null;
  }

  function startWeather(kind) {
    if (!kind) return;
    const host = $('#reader');
    const cv = document.createElement('canvas');
    cv.className = 'rd-weather';
    host.append(cv);
    const g = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const size = () => { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    addEventListener('resize', size);
    const dark = host.classList.contains('night');
    const R = (a, b) => a + Math.random() * (b - a);
    let raf = 0, last = performance.now(), t = 0, draw;
    const extra = [];

    if (kind === 'pluie' || kind === 'orage') {
      // trois plans : loin (fin, lent, pâle) → près (plus long, plus rapide, plus net) ; l'orage est plus dense
      const storm = kind === 'orage';
      const col = dark ? '205,215,230' : '96,108,126';
      const layers = [{ n: 120, len: [8, 14], v: [700, 900], w: .6, a: .18 }, { n: 80, len: [14, 24], v: [950, 1200], w: .9, a: .28 }, { n: 34, len: [26, 40], v: [1300, 1600], w: 1.3, a: .38 }]
        .map(L => storm ? { ...L, n: Math.round(L.n * 1.6), v: L.v.map(x => x * 1.15), a: L.a * 1.1 } : L)
        .map(L => ({ ...L, drops: Array.from({ length: L.n }, () => ({ x: R(-100, W + 100), y: R(-H, H), len: R(...L.len), v: R(...L.v) })) }));
      const splashes = [];
      // l'éclair : sur un bord, jamais derrière le texte ; deux éclats rapprochés, puis le tonnerre
      let nextFlash = R(3, 7), flash = null;
      const bolt = () => {
        const x = Math.random() < .5 ? R(.04, .2) * W : R(.8, .96) * W, end = R(.35, .65) * H, main = [[x, -10]];
        let px = x, py = -10;
        while (py < end) { py += R(14, 34); px += R(-24, 24); main.push([px, py]); }
        const forks = [];
        for (let k = 0; k < 2; k++) {
          const s0 = main[2 + Math.floor(Math.random() * (main.length - 3))], f = [s0];
          let fx = s0[0], fy = s0[1];
          const dir = Math.random() < .5 ? -1 : 1;
          for (let n = 0; n < 4; n++) { fx += dir * R(8, 22); fy += R(12, 26); f.push([fx, fy]); }
          forks.push(f);
        }
        return [main, ...forks];
      };
      const lightning = dt => {
        const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.hypot(W, H) * .6);
        vg.addColorStop(0, 'rgba(20,24,40,0)');
        vg.addColorStop(1, `rgba(20,24,40,${dark ? .32 : .14})`);
        g.fillStyle = vg;
        g.fillRect(0, 0, W, H);
        nextFlash -= dt;
        if (!flash && nextFlash < 0) { flash = { age: 0, paths: bolt(), near: Math.random() }; sound.thunder(flash.near); nextFlash = R(7, 16); }
        if (!flash) return;
        const a = flash.age += dt;
        if (a > .8) { flash = null; return; }
        const k = a < .07 ? 1 : a < .14 ? .15 : a < .24 ? .8 : Math.max(0, .8 * (1 - (a - .24) / .5));
        g.fillStyle = `rgba(235,240,255,${(k * (dark ? .2 : .28) * (.5 + flash.near * .5)).toFixed(3)})`;
        g.fillRect(0, 0, W, H);
        g.save();
        g.lineJoin = 'round';
        g.shadowColor = dark ? 'rgba(170,190,255,.9)' : 'rgba(70,90,170,.7)';
        g.shadowBlur = 14;
        g.strokeStyle = `rgba(255,255,255,${k.toFixed(3)})`;
        flash.paths.forEach((path, n) => {
          g.lineWidth = n ? 1 : 2.2;
          g.beginPath();
          path.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        });
        g.restore();
      };
      draw = dt => {
        const wind = (storm ? -.3 : -.18) + Math.sin(t * .35) * .07 + Math.sin(t * 1.7) * .02;
        for (const L of layers) {
          g.strokeStyle = `rgba(${col},${L.a})`;
          g.lineWidth = L.w;
          g.lineCap = 'round';
          g.beginPath();
          for (const d of L.drops) {
            d.y += d.v * dt; d.x += d.v * wind * dt;
            if (d.y > H + 20) {
              if (L === layers[2] && Math.random() < .5) splashes.push({ x: d.x, y: R(H * .78, H - 6), age: 0 });
              d.y = R(-80, -10); d.x = R(-100, W + 150);
            }
            g.moveTo(d.x, d.y);
            g.lineTo(d.x - d.len * wind, d.y - d.len);
          }
          g.stroke();
        }
        g.lineWidth = .8;
        for (let i = splashes.length - 1; i >= 0; i--) {
          const s = splashes[i];
          s.age += dt;
          if (s.age > .28) { splashes.splice(i, 1); continue; }
          const k = s.age / .28;
          g.strokeStyle = `rgba(${col},${.35 * (1 - k)})`;
          g.beginPath();
          g.ellipse(s.x, s.y, 2 + 9 * k, 1 + 2.5 * k, 0, Math.PI, 0);
          g.stroke();
        }
        if (storm) lightning(dt);
      };
    } else if (kind === 'neige') {
      // flocons doux à des distances différentes ; quelques gros flocons flous passent tout près
      // blanc la nuit ; sur une page claire, un blanc légèrement bleuté pour rester visible
      const sc = dark ? '255,255,255' : '178,190,210';
      const flake = sprite(64, [[0, `rgba(${sc},1)`], [.35, `rgba(${sc},.75)`], [1, `rgba(${sc},0)`]]);
      const soft = sprite(64, [[0, `rgba(${sc},.55)`], [.6, `rgba(${sc},.25)`], [1, `rgba(${sc},0)`]]);
      const mk = (r, v, a, img) => ({ x: R(0, W), y: R(-H, H), r: R(...r), v: R(...v), a, img, p: R(0, 6.28), f: R(.4, 1.2), amp: R(10, 40) });
      const flakes = [
        ...Array.from({ length: 110 }, () => mk([1, 2], [18, 35], .55, flake)),
        ...Array.from({ length: 70 }, () => mk([2, 4], [35, 70], .8, flake)),
        ...Array.from({ length: 22 }, () => mk([4.5, 7], [70, 110], .9, flake)),
        ...Array.from({ length: 6 }, () => mk([14, 26], [120, 180], .35, soft))
      ];
      draw = dt => {
        const wind = 12 + Math.sin(t * .25) * 18;
        for (const f of flakes) {
          f.y += f.v * dt;
          f.x += (wind * (f.r / 4) + Math.cos(t * f.f + f.p) * f.amp * .6) * dt;
          if (f.y - f.r > H) { f.y = -f.r - R(0, 40); f.x = R(-40, W + 40); }
          if (f.x > W + 40) f.x = -40;
          g.globalAlpha = f.a;
          const s = f.r * 2.6;
          g.drawImage(f.img, f.x - s / 2, f.y - s / 2, s, s);
        }
        g.globalAlpha = 1;
      };
    } else if (kind === 'brume') {
      // plusieurs voiles de nuage qui glissent à des vitesses différentes, plus épais vers le bas
      const tex = fogTexture();
      // assez dense pour l'atmosphère, assez léger pour que le texte reste net à travers
      const layers = [{ s: 3.2, v: 9, a: dark ? .18 : .38, y: .1 }, { s: 2.2, v: 16, a: dark ? .14 : .3, y: .35 }, { s: 1.5, v: 26, a: dark ? .1 : .22, y: .6 }];
      draw = () => {
        for (const L of layers) {
          const S = 256 * L.s, off = (t * L.v) % S;
          g.globalAlpha = L.a;
          for (let x = -off; x < W; x += S) for (let y = -S + (L.y * S) % S; y < H; y += S) g.drawImage(tex, x, y, S + 1, S + 1);
        }
        g.globalAlpha = 1;
        // plus dense vers le bas, presque rien en haut
        g.globalCompositeOperation = 'destination-in';
        const gr = g.createLinearGradient(0, 0, 0, H);
        gr.addColorStop(0, 'rgba(0,0,0,.25)');
        gr.addColorStop(.55, 'rgba(0,0,0,.7)');
        gr.addColorStop(1, 'rgba(0,0,0,1)');
        g.fillStyle = gr;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
        if (dark) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(150,160,180,.55)'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
      };
    } else if (kind !== 'lucioles') {
      const env = { g, cv, dark, cleanup: extra, get W() { return W; }, get H() { return H; } };
      const d = moreWeather(kind, env);
      if (!d) { cv.remove(); removeEventListener('resize', size); return; }
      draw = dt => d(dt, t);
    } else {
      // lucioles : un cœur chaud et un halo, une errance lente, des pulsations irrégulières
      const glow = sprite(96, [[0, 'rgba(255,236,170,1)'], [.12, 'rgba(255,214,120,.9)'], [.35, 'rgba(255,190,90,.22)'], [1, 'rgba(255,170,60,0)']]);
      const bugs = Array.from({ length: 30 }, () => ({ x: R(0, W), y: R(H * .25, H), a: R(0, 6.28), sp: R(10, 26), z: R(.5, 1.2), ph: R(0, 10), rate: R(.25, .7), on: 0 }));
      if (dark) cv.classList.add('additive');
      draw = dt => {
        for (const b of bugs) {
          b.a += (Math.random() - .5) * 2.4 * dt;
          b.x += Math.cos(b.a) * b.sp * dt; b.y += Math.sin(b.a) * b.sp * .6 * dt - 2 * dt;
          if (b.x < -30) b.x = W + 30; if (b.x > W + 30) b.x = -30; if (b.y < H * .1) b.a = Math.PI / 2; if (b.y > H + 30) b.y = H * .3;
          // une lueur qui s'allume puis s'éteint, à un rythme propre à chaque luciole
          const s = Math.sin(t * b.rate * 6.28 + b.ph);
          const target = s > .55 ? 1 : 0;
          b.on += (target - b.on) * Math.min(1, dt * (target ? 6 : 2));
          if (b.on < .02) continue;
          g.globalAlpha = b.on * (dark ? 1 : .85);
          const S = 34 * b.z;
          g.drawImage(glow, b.x - S / 2, b.y - S / 2, S, S);
        }
        g.globalAlpha = 1;
      };
    }

    const loop = now => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      t += dt;
      g.clearRect(0, 0, W, H);
      draw(dt);
    };
    raf = requestAnimationFrame(loop);
    sound.ambience(kind);
    reader.cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', size); cv.remove(); sound.ambience(null); for (const f of extra) f(); });
  }

  // Lampe : la page est plongée dans le noir, seule une lumière autour du regard (le curseur) l'éclaire.
  function startLamp() {
    const host = $('#reader');
    const el = document.createElement('div');
    el.className = 'rd-lamp';
    host.append(el);
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y, raf = 0;
    const move = e => { tx = e.clientX; ty = e.clientY; };
    host.addEventListener('pointermove', move);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      x += (tx - x) * .12; y += (ty - y) * .12;
      el.style.setProperty('--x', x.toFixed(1) + 'px');
      el.style.setProperty('--y', y.toFixed(1) + 'px');
    };
    loop();
    reader.cleanup.push(() => { cancelAnimationFrame(raf); host.removeEventListener('pointermove', move); el.remove(); });
  }

  // Constellation : chaque carte lue allume une étoile ; l'espace entier lu dessine la figure complète.
  const readKey = sp => 'lues.' + sp.id;
  function markRead(doc) {
    const sp = spaceOfDoc(doc.id);
    if (!sp) return;
    const lues = store.get(readKey(sp)) || [];
    if (!lues.includes(doc.id)) { lues.push(doc.id); store.set(readKey(sp), lues); }
  }

  function renderConstellation() {
    const box = $('#constel');
    const sp = space();
    if (!asReader() || ring.ctx !== 'space' || !sp || !sp.docs.length) { box.hidden = true; return; }
    const docs = sp.docs;
    const lues = (store.get(readKey(sp)) || []).filter(id => docs.some(d => d.id === id));
    const pos = id => { let h = 2166136261; for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return [14 + (h >>> 0) % 172, 14 + ((h >>> 8) >>> 0) % 92]; };
    const lines = lues.slice(1).map((id, i) => { const [a, b] = pos(lues[i]), [c, d] = pos(id); return `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`; }).join('');
    const stars = docs.map(d => { const [x, y] = pos(d.id), on = lues.includes(d.id); return `<g class="st${on ? ' on' : ''}" data-doc="${d.id}"><circle cx="${x}" cy="${y}" r="${on ? 2.6 : 1.6}"/>${on ? `<circle class="halo" cx="${x}" cy="${y}" r="7"/>` : ''}</g>`; }).join('');
    const full = lues.length === docs.length;
    box.hidden = false;
    box.classList.toggle('complete', full);
    box.innerHTML = `<svg viewBox="0 0 200 120">${lines}${stars}</svg><div class="cs-label">${full ? 'Constellation complète' : `Constellation : ${lues.length} / ${docs.length}`}</div>`;
    const done = store.get(readKey(sp) + '.fete');
    if (full && !done) { store.set(readKey(sp) + '.fete', true); setTimeout(() => { sound.create(); toast('Constellation complète : vous avez tout lu'); }, 600); }
  }

  // 7. Voyage : la page devient un univers en trois dimensions qu'on traverse passage après passage.
  function presentVoyage(doc, stage) {
    stage.innerHTML = '<canvas class="vy-stars"></canvas><div class="vy-view"><div class="vy-world"></div></div><div class="vy-progress"><i></i></div>';
    const world = $('.vy-world', stage), cv = $('.vy-stars', stage), g = cv.getContext('2d');
    const [tint] = colorOf(doc);
    stage.style.setProperty('--vy-tint', tint);
    const SP = 900;
    const items = [];
    const add = (html, cls) => {
      const p = document.createElement('div');
      p.className = 'vy-panel ' + (cls || '');
      if (typeof html === 'string') p.innerHTML = html; else p.append(html);
      world.append(p);
      items.push(p);
      return p;
    };
    const title = add('<h1 class="rd-title"></h1><p class="rd-sub">Avancez avec la molette, les flèches ou un clic</p>', 'vy-cover');
    $('.rd-title', title).textContent = doc.title || 'Sans titre';
    // un passage par panneau, selon le découpage de la page
    for (const g of groupsOf(doc, 'voyage')) {
      const wrap = document.createElement('div');
      wrap.className = 'prose';
      wrap.append(...g.blocks);
      add(wrap);
    }
    const follow = nextCard(doc);
    const end = follow ? null : add('<div class="rd-fin">Fin du voyage</div><div class="rd-end-actions"><button class="btn ghost" data-again>Recommencer</button><button class="btn" data-close>Revenir</button></div>', 'vy-cover');
    if (end) {
      $('[data-again]', end).onclick = e => { e.stopPropagation(); target = 0; };
      $('[data-close]', end).onclick = e => { e.stopPropagation(); closeReader(); };
    }
    hydrate(world, doc);
    const P = items.map((_, i) => i === 0 ? { x: 0, y: 0, ry: 0 } : { x: Math.sin(i * 1.7) * 260, y: Math.cos(i * 1.13) * 110, ry: Math.sin(i * .9) * -14 });
    items.forEach((p, i) => { p.style.transform = `translate(-50%, -50%) translate3d(${P[i].x}px, ${P[i].y}px, ${-i * SP}px) rotateY(${P[i].ry}deg)`; });
    // champ d'étoiles en 3D, qui file quand on avance
    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0;
    const size = () => { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    addEventListener('resize', size);
    const stars = Array.from({ length: 360 }, () => ({ x: (Math.random() - .5) * 2400, y: (Math.random() - .5) * 1600, z: Math.random() * 2000 }));
    let p = 0, target = 0, last = 0, raf = 0, mx = 0, my = 0;
    const max = items.length - 1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const prev = p;
      p += (target - p) * .055;
      if (Math.abs(target - p) < .0005) p = target;
      const v = (p - prev) * SP;
      const i0 = Math.floor(p), k = p - i0, a = P[i0], b = P[Math.min(max, i0 + 1)];
      const X = a.x + (b.x - a.x) * k, Y = a.y + (b.y - a.y) * k, RY = a.ry + (b.ry - a.ry) * k;
      world.style.transform = `rotateY(${(-RY * .6 + mx * 4).toFixed(2)}deg) rotateX(${(-my * 3).toFixed(2)}deg) translate3d(${-X}px, ${-Y}px, ${p * SP}px)`;
      items.forEach((el, i) => {
        const d = i - p;
        // le passage atteint est net ; les suivants ne sont qu'une lueur au loin, trop floue pour gêner la lecture
        const o = d < -.35 ? Math.max(0, 1 + (d + .35) * 3) : d > .3 ? Math.max(Math.max(0, .1 - Math.max(0, d - 1.6) * .2), 1 - (d - .3) * 2.6) : 1;
        el.style.opacity = o.toFixed(3);
        el.style.filter = Math.abs(d) > .25 ? `blur(${Math.min(12, Math.abs(d) * 5).toFixed(1)}px)` : 'none';
        el.style.pointerEvents = Math.abs(d) < .5 ? 'auto' : 'none';
      });
      g.clearRect(0, 0, W, H);
      const speed = 1.2 + Math.abs(v) * 2.2;
      for (const s of stars) {
        s.z -= speed;
        if (s.z < 1) { s.z = 2000; s.x = (Math.random() - .5) * 2400; s.y = (Math.random() - .5) * 1600; }
        const f = 600 / s.z, x = W / 2 + (s.x - X * .3) * f, y = H / 2 + (s.y - Y * .3) * f;
        const f2 = 600 / (s.z + speed * 6), x2 = W / 2 + (s.x - X * .3) * f2, y2 = H / 2 + (s.y - Y * .3) * f2;
        const al = Math.min(1, (2000 - s.z) / 1400);
        g.strokeStyle = `rgba(230,235,255,${al * .8})`;
        g.lineWidth = Math.min(2.2, f * 1.1);
        g.beginPath(); g.moveTo(x2, y2); g.lineTo(x + .1, y + .1); g.stroke();
      }
      $('.vy-progress i', stage).style.width = (p / max * 100) + '%';
      const near = Math.round(p);
      if (near !== last) { last = near; sound.woosh(.7, Math.sign(P[near].x) || 1); readerEnd(near === max); }
    };
    raf = requestAnimationFrame(loop);
    const step = d => { if (follow && d > 0 && Math.round(target) >= max) return goNextCard(); target = Math.max(0, Math.min(max, Math.round(target) + d)); };
    listen(stage, 'wheel', e => { e.preventDefault(); target = Math.max(0, Math.min(max, target + (e.deltaY + e.deltaX) * .0022)); }, { passive: false });
    stage.onclick = e => { if (rdControl(e)) return; step(e.clientX < innerWidth / 4 ? -1 : 1); };
    stage.onpointermove = e => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; };
    reader.onKey = e => {
      if (['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown'].includes(e.key)) { step(1); return true; }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { step(-1); return true; }
    };
    $('#rdHint').textContent = '';
    reader.cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', size); });
  }

  /* ───────────── Présentations : faire voyager le texte ───────────── */

  const NEXT_KEYS = ['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown'], PREV_KEYS = ['ArrowLeft', 'ArrowUp', 'PageUp'];
  const isControl = e => rdControl(e);

  // la page découpée en passages (un titre voyage avec ce qui le suit), blocs interactifs déjà vivants
  function passages(doc) {
    const out = groupsOf(doc).map(g => {
      const wrap = document.createElement('div');
      wrap.className = 'prose';
      wrap.dataset.key = g.key;
      wrap.append(...g.blocks);
      return wrap;
    });
    const tmp = document.createElement('div');
    tmp.append(...out);
    hydrate(tmp, doc);
    return out;
  }

  const titleUnit = (doc, sub) => {
    const t = document.createElement('div');
    t.className = 'prose pv-title';
    t.innerHTML = `<h1 class="rd-title"></h1>${sub ? `<p class="rd-sub">${esc(sub)}</p>` : ''}`;
    $('.rd-title', t).textContent = doc.title || 'Sans titre';
    return t;
  };

  // navigation commune : clic (à gauche pour revenir), flèches, espace
  function stepper(stage, count, go) {
    let i = 0;
    const to = k => {
      k = Math.max(0, Math.min(count - 1, k));
      if (k === i) return;
      const d = k > i ? 1 : -1;
      i = k;
      go(i, d);
    };
    listen(stage, 'click', e => { if (!isControl(e)) to(e.clientX < innerWidth / 4 ? i - 1 : i + 1); });
    reader.onKey = e => {
      if (NEXT_KEYS.includes(e.key)) { to(i + 1); return true; }
      if (PREV_KEYS.includes(e.key)) { to(i - 1); return true; }
    };
    go(0, 0);
    return to;
  }

  // un texte plus long que son cadre défile : un fondu dit qu'il continue plus bas
  function scrollHint(el) {
    if (!el || el.classList.contains('rd-scrolly')) return;
    el.classList.add('rd-scrolly');
    const upd = () => {
      el.classList.toggle('more-b', el.scrollTop + el.clientHeight < el.scrollHeight - 6);
      el.classList.toggle('more-t', el.scrollTop > 6);
    };
    el.addEventListener('scroll', upd, { passive: true });
    el.addEventListener('load', upd, true);
    requestAnimationFrame(upd);
    setTimeout(upd, 400);
    return upd;
  }

  const progress = (stage, k, n) => { const b = $('.rd-progress i', stage); if (b) b.style.width = (n > 1 ? k / (n - 1) * 100 : 100) + '%'; readerEnd(k >= n - 1); };

  /*
   * Le paysage autour des portes, en volume : pour chaque pixel, un rayon part de l'œil (la même caméra et la même
   * perspective que la scène CSS), avance jusqu'au sol (dunes, prairie, lande) ou à un arbre, prend la lumière du décor,
   * puis se perd dans sa brume. Une carte vue de dessus (uMask) aplanit le relief là où passe le chemin des portes.
   */
  const DOOR_FRAG = `
uniform vec2 uRes, uFog; uniform float uScale, uG, uKind, uTime; uniform vec3 uEye, uSun; uniform mat3 uM;
uniform sampler2D uMask; uniform vec4 uBox;
float path(vec2 xz){ vec2 uv = (xz - uBox.xy) / uBox.zw; if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return 0.; return texture2D(uMask, uv).r; }
float terr(vec2 p){
  float h;
  if (uKind < .5) {
    vec2 q = p / 3200.;
    float s = q.x * 1.1 + q.y * .55 + f2(q * .55 + 3.) * 2.4;
    h = 600. * pow(.5 + .5 * sin(s * 6.2832), 2.4) * (.35 + .9 * f2(q * .35 + 9.));
  } else if (uKind < 1.5) h = 560. * f2(p / 5600. + 2.);
  else h = 320. * f2(p / 4600. + 7.);
  return h * (1. - path(p));
}
// au plus un arbre par case, loin du chemin : un houppier rond (jardin) ou un sapin à étages (brume)
float tree(vec3 p){
  if (uKind < .5) return 1e5;
  float cell = uKind < 1.5 ? 1000. : 1150.;
  vec2 c = floor(p.xz / cell);
  if (h2(c + 3.7) < (uKind < 1.5 ? .45 : .35)) return 1e5;
  vec2 cxz = (c + .5 + (vec2(h2(c + 7.1), h2(c + 1.9)) - .5) * .36) * cell;
  if (path(cxz) > .02) return 1e5;
  vec3 q = p - vec3(cxz.x, uG - terr(cxz), cxz.y);
  float up = -q.y;
  if (uKind < 1.5) {
    float r = 170. + 120. * h2(c + 11.), hc = 280. + r;
    float crown = length(vec3(q.x, (up - hc) * 1.15, q.z)) - r + (n2(q.xz / 70. + up / 90.) - .5) * 46.;
    float trunk = max(length(q.xz) - 26., abs(up - hc * .5) - hc * .5);
    return min(crown * .8, trunk);
  }
  float H = 900. + 600. * h2(c + 5.), rb = 240. + 120. * h2(c + 2.);
  float r = rb * (1. - clamp(up / H, 0., 1.)) * (.72 + .28 * (1. - fract(up / 230.)));
  return max((length(q.xz) - r) * .7, max(-up, up - H));
}
vec3 sky(vec3 rd){
  float el = -rd.y, sd = max(dot(rd, uSun), 0.);
  vec3 c;
  if (uKind < .5) {
    c = mix(vec3(.98, .64, .42), vec3(.66, .38, .45), smoothstep(-.02, .1, el));
    c = mix(c, vec3(.13, .11, .3), smoothstep(.08, .38, el));
    c += vec3(1., .58, .3) * pow(sd, 14.) * .35 + vec3(1., .85, .6) * pow(sd, 120.) * .5;
    c = mix(c, vec3(1., .94, .78), smoothstep(.9994, .9997, sd));
  } else if (uKind < 1.5) {
    c = mix(vec3(.24, .34, .38), vec3(.1, .15, .24), smoothstep(-.02, .12, el));
    c = mix(c, vec3(.02, .035, .08), smoothstep(.1, .5, el));
    c += vec3(.5, .62, .72) * pow(sd, 30.) * .22;
    c = mix(c, vec3(.93, .95, .87), smoothstep(.9991, .9994, sd));
    vec3 g = floor(rd * 420.);
    c += vec3(.8, .86, 1.) * step(.9972, h3(g)) * smoothstep(.04, .25, el) * (.55 + .45 * sin(uTime * 2. + h3(g + 1.) * 40.));
  } else {
    c = mix(vec3(.75, .78, .8), vec3(.42, .48, .55), smoothstep(0., .6, el));
    c += vec3(1., .97, .9) * pow(sd, 8.) * .12;
  }
  return c;
}
void main(){
  vec2 hs = uRes / uScale * .5;
  vec3 rd = normalize(vec3(gl_FragCoord.x / uScale - hs.x, hs.y - gl_FragCoord.y / uScale, -1200.)) * uM, ro = uEye;
  vec3 col = sky(rd), far = sky(normalize(vec3(rd.x, 0., rd.z)));
  float maxH = uKind < .5 ? 640. : uKind < 1.5 ? 1800. : 1600., top = uG - maxH, t = 0.;
  if (ro.y < top) { if (rd.y <= .0005) { gl_FragColor = vec4(col, 1.); return; } t = (top - ro.y) / rd.y; }
  bool hit = false;
  float onTree = 0., lt = t;
  for (int i = 0; i < 120; i++) {
    vec3 p = ro + rd * t;
    if (p.y < top && rd.y < 0.) break;
    float a = (uG - terr(p.xz)) - p.y, d = a * .4;
    float dt = (a < maxH && t < 15000.) ? tree(p) : 1e5;
    onTree = dt < d ? 1. : 0.;
    d = min(d, dt);
    if (d < .5 + t * .0012) { hit = true; break; }
    lt = t;
    t += max(d, 3. + t * .004);
    if (t > 26000.) break;
  }
  // le sol : on resserre le point d'impact entre le dernier pas au-dessus et le premier en dessous
  if (hit && onTree < .5) for (int j = 0; j < 6; j++) {
    float m = (lt + t) * .5; vec3 q = ro + rd * m;
    if ((uG - terr(q.xz)) - q.y < 0.) t = m; else lt = m;
  }
  if (hit) {
    vec3 p = ro + rd * t, n;
    if (onTree > .5) {
      vec2 e = vec2(6., 0.);
      n = normalize(vec3(tree(p + e.xyy) - tree(p - e.xyy), tree(p + e.yxy) - tree(p - e.yxy), tree(p + e.yyx) - tree(p - e.yyx)));
    } else {
      float e = 12.;
      n = normalize(vec3(-(terr(p.xz + vec2(e, 0.)) - terr(p.xz - vec2(e, 0.))) / (2. * e), -1., -(terr(p.xz + vec2(0., e)) - terr(p.xz - vec2(0., e))) / (2. * e)));
    }
    float amb = .5 + .5 * -n.y, dif;
    vec3 c;
    if (uKind < .5) {
      // le sable : des rides fines près du regard, la lumière chaude du soleil bas
      float rip = sin(dot(p.xz, vec2(.045, .026)) + n2(p.xz / 500.) * 6.);
      dif = max(dot(normalize(n + vec3(.08 * rip, 0., .05 * rip) * smoothstep(5000., 600., t)), uSun), 0.);
      c = vec3(.88, .6, .38) * (.9 + .2 * n2(p.xz / 300.)) * (dif * vec3(1.25, .86, .58) * 1.35 + amb * vec3(.22, .2, .36));
    } else if (uKind < 1.5) {
      dif = max(dot(n, uSun), 0.);
      vec3 alb = onTree > .5 ? vec3(.07, .17, .09) * (.75 + .6 * n2(p.xz / 40. - p.y / 50.)) : vec3(.11, .21, .1) * (.8 + .4 * n2(p.xz / 250.));
      c = alb * (dif * vec3(.75, .86, 1.) * 1.5 + amb * vec3(.26, .34, .4));
    } else {
      dif = max(dot(n, uSun), 0.);
      vec3 alb = onTree > .5 ? vec3(.13, .17, .17) : vec3(.3, .33, .3) * (.85 + .3 * n2(p.xz / 300.));
      c = alb * (dif * .7 + amb * vec3(.55, .6, .65));
    }
    float fd = t / (uFog.x + uFog.y * .6), fog = 1. - exp(-fd * fd * 1.8);
    if (uKind > 1.5) fog = clamp(fog * (.8 + .4 * n2(p.xz / 1800. + uTime * .04)), 0., 1.);
    col = mix(c, far, fog);
  }
  gl_FragColor = vec4(col, 1.);
}`;

  function doorEnv(canvas, decor, ground, path) {
    const gl = glQuad(canvas, DOOR_FRAG);
    if (!gl) return null;
    const RAD = Math.PI / 180, K = .55;
    // le paysage est peint à un peu plus de demi-résolution puis agrandi : il n'est fait que de grandes formes douces
    const size = () => { canvas.width = Math.round(innerWidth * K); canvas.height = Math.round(innerHeight * K); gl.set('uRes', [canvas.width, canvas.height]); gl.set('uScale', K); };
    size();
    // la carte du chemin, vue de dessus : blanche là où l'on marche, et autour de chaque porte
    const xs = path.map(p => p.x), zs = path.map(p => p.z), pad = 7000;
    const x0 = Math.min(...xs) - pad, z0 = Math.min(...zs) - pad, span = Math.max(Math.max(...xs) - x0, Math.max(...zs) - z0) + pad;
    const mc = document.createElement('canvas'), S = 512, k = S / span, g = mc.getContext('2d');
    mc.width = mc.height = S;
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    g.lineCap = g.lineJoin = 'round';
    for (const [w, a] of [[4600, .3], [3400, .6], [2300, 1]]) {
      g.strokeStyle = g.fillStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = w * k;
      g.beginPath();
      path.forEach((p, i) => (i ? g.lineTo((p.x - x0) * k, (p.z - z0) * k) : g.moveTo((p.x - x0) * k, (p.z - z0) * k)));
      g.stroke();
      for (const p of path) { g.beginPath(); g.arc((p.x - x0) * k, (p.z - z0) * k, w * .55 * k, 0, 6.29); g.fill(); }
    }
    gl.texture('uMask', 0, mc);
    gl.set('uBox', [x0, z0, span, span]);
    gl.set('uG', ground);
    gl.set('uKind', { desert: 0, jardin: 1, brume: 2 }[decor]);
    gl.set('uFog', DOOR_DECORS[decor].fog);
    const [az, el] = { desert: [-55, 13], jardin: [35, 28], brume: [-10, 22] }[decor].map(v => v * RAD);
    gl.set('uSun', [-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)]);
    let last = '', lastT = 0;
    return {
      size() { size(); last = ''; },
      // même caméra que la scène : le monde tourne de rotateX(-2·my) rotateY(-yaw + 3·mx), l'œil est à 1200 px devant l'écran
      render(cam, mx, my, sway, now) {
        const key = [cam.x, cam.y, cam.z, cam.yaw, mx, my, sway].map(v => v.toFixed(2)).join();
        if (key === last && (decor === 'desert' || now - lastT < 60)) return;
        last = key; lastT = now;
        const M = M3.mul(M3.rx(-2 * my * RAD), M3.ry((-cam.yaw + mx * 3) * RAD)), back = M3.app(M3.gl(M), [0, 0, 1200]);
        gl.set('uM', M3.gl(M));
        gl.set('uEye', [cam.x + back[0], cam.y - sway + back[1], cam.z + back[2]]);
        gl.set('uTime', now / 1000);
        gl.draw();
      },
      lose: () => gl.lose()
    };
  }

  /*
   * 4. Couloir de portes : des portes posées dans un grand espace, le long d'un chemin qui tourne.
   * La caméra marche de l'une à l'autre ; chaque porte s'ouvre quand on arrive, on entre, on lit,
   * puis on repart vers la suivante, d'un seul mouvement.
   */
  function presentDoors(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    const keys = units.map((u, k) => (k ? u.dataset.key : 'title'));
    const n = units.length, RAD = Math.PI / 180;
    const set = sceneOf(doc, 'portes');
    let decor = DOOR_DECORS[set.decor] ? set.decor : 'nuit', D = DOOR_DECORS[decor];
    const stairs = set.path === 'escalier', RISE = 300, FLOOR = 480;
    stage.innerHTML = '<canvas class="dr-env"></canvas><canvas class="dr-sky"></canvas><div class="dr-scene"><div class="dr-world dr-under"></div><div class="dr-world dr-gates"></div></div><div class="dr-count"></div><div class="rd-progress"><i></i></div>';
    // deux mondes superposés, avec la même caméra : la pierre de l'escalier dessous, les portes et leurs textes dessus
    // (le moteur trierait mal ces grandes surfaces avec les panneaux : un texte pourrait passer derrière une marche)
    const scene = $('.dr-scene', stage), world = $('.dr-gates', stage), under = $('.dr-under', stage), sky = $('.dr-sky', stage), sg = sky.getContext('2d');
    const R = (a, b) => a + Math.random() * (b - a);

    // le chemin : chaque porte un peu plus loin, un peu à gauche ou à droite, tournée vers celui qui arrive
    const STEP = 2300, FRONT = 1100, INSIDE = 150;
    // des couleurs franches pour les portes (ou celle choisie dans la mise en scène) : la lumière de chaque pièce en prend la teinte
    const seed = Math.floor(Math.random() * DOOR_COLORS.length);
    const gates = [];
    let x = 0, y = 0, z = 0, h = 0;
    units.forEach((u, k) => {
      if (k) {
        const turn = R(18, 42) * (Math.random() < .5 ? -1 : 1);
        const mid = (h + turn / 2) * RAD;
        x -= Math.sin(mid) * STEP; z -= Math.cos(mid) * STEP;
        h += turn;
        // en escalier, chaque porte attend une volée de marches plus haut
        if (stairs) y -= RISE;
      }
      const el = document.createElement('div');
      el.className = 'dr-gate';
      el.style.setProperty('--room', doorColor(sceneItem(doc, 'portes', keys[k]).door) || DOOR_COLORS[(k + seed) % DOOR_COLORS.length]);
      el.style.transform = `translate(-50%, -50%) translate3d(${x.toFixed(1)}px, ${y}px, ${z.toFixed(1)}px) rotateY(${h.toFixed(2)}deg)`;
      el.innerHTML = '<div class="dr-pool"></div><div class="dr-halo"></div><div class="dr-panel"></div><div class="dr-frame"><div class="dr-jamb"></div><div class="dr-leaf l"><i></i></div><div class="dr-leaf r"><i></i></div></div><div class="dr-plate"></div>';
      $('.dr-panel', el).append(u);
      scrollHint(u);
      $('.dr-plate', el).textContent = k === 0 ? 'Entrer' : k;
      world.append(el);
      const nx = Math.sin(h * RAD), nz = Math.cos(h * RAD);
      gates.push({ el, x, y, z, h, nx, nz, pv: 0, ga: 0, prose: u });
    });
    // deux positions par porte : devant (porte fermée), et dedans (face au texte)
    const front = k => { const g = gates[k]; return { x: g.x + g.nx * FRONT, y: g.y, z: g.z + g.nz * FRONT, yaw: g.h }; };
    const inside = k => { const g = gates[k]; return { x: g.x - g.nx * INSIDE, y: g.y, z: g.z - g.nz * INSIDE, yaw: g.h }; };

    // le paysage en volume (sauf la nuit, qui garde son ciel d'étoiles) ; sans WebGL, on reste dans la nuit
    let env = null;
    if (decor !== 'nuit') {
      env = doorEnv($('.dr-env', stage), decor, FLOOR, [front(0), ...gates.map(g => ({ x: g.x, z: g.z })), inside(n - 1)]);
      if (env) reader.cleanup.push(() => env.lose());
      else { decor = 'nuit'; D = DOOR_DECORS.nuit; }
    }
    stage.classList.add('dk-' + decor);
    const ground = decor !== 'nuit';

    /*
     * L'escalier : de la pièce qu'on quitte au seuil de la porte suivante, des marches de pierre pleines.
     * Quand il y a un sol, chaque marche descend jusqu'à lui (ses deux flancs sont des murs appareillés),
     * et chaque porte se dresse sur un socle maçonné ; la nuit, l'escalier flotte, avec l'épaisseur de sa pierre.
     */
    if (stairs) for (let k = 1; k < n; k++) {
      const a = gates[k - 1], b = gates[k];
      const ax = a.x - a.nx * INSIDE, az = a.z - a.nz * INSIDE, dx = b.x - ax, dz = b.z - az;
      const len = Math.hypot(dx, dz), hd = Math.atan2(-dx, -dz) / RAD, N = 14, rise = (a.y - b.y) / N, depth = len / N;
      const ux = Math.cos(hd * RAD), uz = -Math.sin(hd * RAD), HW = 380;
      const box = document.createElement('div');
      box.className = 'dr-steps';
      box.style.setProperty('--room', b.el.style.getPropertyValue('--room'));
      const face = (cls, w, hgt, x, y, z, rot) => `<div class="${cls}" style="width:${w.toFixed(1)}px;height:${hgt.toFixed(1)}px;transform:translate(-50%,-50%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,${z.toFixed(1)}px) ${rot}"></div>`;
      let html = '';
      for (let i = 0; i < N; i++) {
        const t = (i + .5) / N, t0 = i / N, top = a.y + FLOOR - rise * (i + 1), cx = ax + dx * t, cz = az + dz * t;
        html += face('dr-step', 2 * HW, depth + 2, cx, top, cz, `rotateY(${hd.toFixed(2)}deg) rotateX(90deg)`)
          + face('dr-riser', 2 * HW, rise, ax + dx * t0, top + rise / 2, az + dz * t0, `rotateY(${hd.toFixed(2)}deg)`);
        // les flancs : jusqu'au sol s'il y en a un, sinon l'épaisseur de la dalle
        const low = ground ? FLOOR : top + 90, hgt = low - top;
        for (const sd of [-1, 1]) html += face('dr-side', depth + 1, hgt, cx + ux * HW * sd, top + hgt / 2, cz + uz * HW * sd, `rotateY(${(hd + 90 * sd).toFixed(2)}deg)`);
      }
      // le socle de la porte d'arrivée
      if (ground) {
        const ugx = Math.cos(b.h * RAD), ugz = -Math.sin(b.h * RAD), cx = b.x - b.nx * 225, cz = b.z - b.nz * 225, top = b.y + FLOOR, hgt = FLOOR - top, D2 = 475, W2 = 575;
        html += face('dr-pod top', 2 * W2, 2 * D2, cx, top, cz, `rotateY(${b.h.toFixed(2)}deg) rotateX(90deg)`)
          + face('dr-pod', 2 * W2, hgt, cx + b.nx * D2, top + hgt / 2, cz + b.nz * D2, `rotateY(${b.h.toFixed(2)}deg)`)
          + face('dr-pod', 2 * W2, hgt, cx - b.nx * D2, top + hgt / 2, cz - b.nz * D2, `rotateY(${(b.h + 180).toFixed(2)}deg)`)
          + face('dr-pod side', 2 * D2, hgt, cx + ugx * W2, top + hgt / 2, cz + ugz * W2, `rotateY(${(b.h + 90).toFixed(2)}deg)`)
          + face('dr-pod side', 2 * D2, hgt, cx - ugx * W2, top + hgt / 2, cz - ugz * W2, `rotateY(${(b.h - 90).toFixed(2)}deg)`);
      }
      box.innerHTML = html;
      under.append(box);
      b.steps = box;
    }

    // ciel : des étoiles fixes à l'infini, qui tournent avec le regard ; une poussière plus proche qui défile
    const stars = Array.from({ length: 420 }, () => ({ az: R(0, 360), el: R(-.15, 1), a: R(.15, .8), s: R(.5, 1.6) }));
    const motes = Array.from({ length: D.motes === 'sable' ? 110 : 60 }, () => ({ x: R(-1, 1), y: R(-1, 1), z: R(.2, 1) }));
    // les lucioles du jardin flottent pour de vrai dans le monde, autour des portes, à hauteur d'homme
    const flies = D.motes === 'lucioles' ? Array.from({ length: 140 }, () => {
      const g = gates[Math.floor(Math.random() * n)], a = R(0, 6.28), r = R(500, 3200);
      return { x: g.x + Math.cos(a) * r, y: g.y + FLOOR - R(60, 700), z: g.z + Math.sin(a) * r, ph: R(0, 20), w: R(.6, 1.6), vx: R(-20, 20), vz: R(-20, 20) };
    }) : [];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const size = () => { W = innerWidth; H = innerHeight; sky.width = W * dpr; sky.height = H * dpr; sg.setTransform(dpr, 0, 0, dpr, 0, 0); if (env) env.size(); };
    size();
    addEventListener('resize', size);

    let cam = { ...front(0) }, move = null, raf = 0, here = 0, inRoom = false, busy = false, mx = 0, my = 0;
    let lastMoved = { x: cam.x, z: cam.z };
    // accélérer, freiner, ou les deux : deux trajets enchaînés (« in » puis « out ») gardent une vitesse continue
    const ease = { inOut: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, in: t => t * t, out: t => 1 - (1 - t) * (1 - t) };
    const lerpAngle = (a, b, t) => { let d = ((b - a + 540) % 360) - 180; return a + d * t; };

    // un trajet courbe : on recule un peu, on tourne, on arrive de face
    function moveTo(to, dur, curve, done, kind = 'inOut') {
      const from = { ...cam };
      const back = (p, d) => ({ x: p.x + Math.sin(p.yaw * RAD) * d, z: p.z + Math.cos(p.yaw * RAD) * d });
      const c1 = { ...back(from, curve[0]), y: from.y }, c2 = { ...back(to, curve[1]), y: to.y };
      move = { from, to, c1, c2, t0: performance.now(), dur, done, e: ease[kind] };
    }
    const bez = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };

    let last = 0;
    const clamp01 = v => Math.max(0, Math.min(1, v)), smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };
    const loop = now => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - (last || now)) / 1000);
      last = now;
      if (move) {
        const k = Math.min(1, (now - move.t0) / move.dur), e = move.e(k);
        cam.x = bez(move.from.x, move.c1.x, move.c2.x, move.to.x, e);
        cam.z = bez(move.from.z, move.c1.z, move.c2.z, move.to.z, e);
        cam.y = bez(move.from.y, move.c1.y, move.c2.y, move.to.y, e);
        cam.yaw = lerpAngle(move.from.yaw, move.to.yaw, e);
        if (k >= 1) { const d = move.done; move = null; if (d) d(); }
      }
      // un léger balancement de la marche, et le regard qui suit un peu la souris
      const sway = move ? Math.sin(now / 260) * 3 : 0;
      under.style.transform = world.style.transform = `rotateX(${(my * -2).toFixed(2)}deg) rotateY(${(-cam.yaw + mx * 3).toFixed(3)}deg) translate3d(${(-cam.x).toFixed(1)}px, ${(sway - cam.y).toFixed(1)}px, ${(-cam.z).toFixed(1)}px)`;
      /*
       * Chaque porte s'efface en douceur : quand on la traverse, quand elle sort du cadre sur le côté,
       * et au loin dans la brume. Le texte de la pièce a son propre fondu : il paraît quand la porte s'ouvre,
       * s'efface quand on la quitte, et avant qu'on ne passe au travers.
       */
      const cy = Math.cos(cam.yaw * RAD), sy = Math.sin(cam.yaw * RAD);
      for (const g of gates) {
        const dx = g.x - cam.x, dz = g.z - cam.z;
        // la porte vue depuis la caméra (le monde tourne de -yaw) : profondeur (négatif = devant) et écart latéral
        const vz = dx * sy + dz * cy;
        const vx = dx * cy - dz * sy, far = -vz;
        const fog = clamp01(1 - (far - D.fog[0]) / D.fog[1]);
        // la porte qu'on traverse s'efface avant de passer de part et d'autre du regard
        const near = smooth((-60 - vz) / 450);
        const ang = far > 0 ? Math.atan2(Math.abs(vx), far) / RAD : 90;
        const side = 1 - clamp01(-vz / 400) * (1 - smooth((42 - ang) / 14));
        const ga = g.ga = fog * near * side;
        const want = g.el.classList.contains('open') && !g.el.classList.contains('left') ? 1 : 0;
        g.pv += (want - g.pv) * Math.min(1, dt * (want ? 2.4 : 5));
        const pa = g.pv * fog * clamp01(1 - (vz - INSIDE) / 220);
        g.el.style.setProperty('--fog', ga.toFixed(3));
        g.el.style.setProperty('--pfog', pa.toFixed(3));
        g.el.style.visibility = ga < .01 && pa < .01 ? 'hidden' : 'visible';
      }
      // les marches suivent la porte vers laquelle elles montent
      gates.forEach((g, k) => {
        if (!g.steps) return;
        const v = Math.max(g.ga, gates[k - 1].ga);
        g.steps.style.setProperty('--sfog', v.toFixed(3));
        g.steps.style.visibility = v < .01 ? 'hidden' : 'visible';
      });
      if (env) env.render(cam, mx, my, sway, now);
      drawSky(now, dt, sway);
    };

    /*
     * Par-dessus le paysage, ce qui flotte dans l'air, projeté comme la scène (même perspective, même regard) :
     * les étoiles de la nuit, la poussière ou le sable qui filent, les lucioles du jardin.
     */
    const PERSP = 1200;
    const screenX = az => { const d = ((az - look() + 540) % 360) - 180; return Math.abs(d) > 80 ? null : W / 2 - Math.tan(d * RAD) * PERSP; };
    const look = () => cam.yaw - mx * 3;
    function drawSky(now, dt, sway) {
      sg.clearRect(0, 0, W, H);
      const vx = cam.x - lastMoved.x, vz2 = cam.z - lastMoved.z, speed = Math.hypot(vx, vz2);
      lastMoved = { x: cam.x, z: cam.z };
      // les lucioles : projetées avec la caméra de la scène, elles s'approchent et s'éloignent comme les portes
      if (flies.length) {
        const M = M3.mul(M3.rx(-2 * my * RAD), M3.ry((-cam.yaw + mx * 3) * RAD));
        for (const f of flies) {
          f.ph += dt; f.x += f.vx * dt; f.z += f.vz * dt;
          const v = M3.app(M, [f.x - cam.x, f.y - cam.y + sway + Math.sin(f.ph * .7) * 30, f.z - cam.z]);
          if (v[2] > 1000) continue;
          const k = PERSP / (PERSP - v[2]), px = W / 2 + v[0] * k, py = H / 2 + v[1] * k, on = Math.pow((Math.sin(f.ph * f.w) + 1) / 2, 3);
          const dist = PERSP - v[2], fade = Math.max(0, 1 - (dist - 2500) / 5000);
          if (on * fade < .02 || px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
          const r = Math.min(3, Math.max(.8, 6 * k));
          sg.fillStyle = `rgba(200,255,130,${(on * fade * .16).toFixed(3)})`; sg.beginPath(); sg.arc(px, py, r * 3.2, 0, 6.28); sg.fill();
          sg.fillStyle = `rgba(240,255,190,${(on * fade * .95).toFixed(3)})`; sg.beginPath(); sg.arc(px, py, r * .6, 0, 6.28); sg.fill();
        }
        return;
      }
      if (D.motes === 'brume') return;
      // la nuit : les étoiles, fixes à l'infini, glissent exactement comme le décor quand on tourne
      if (D.stars) {
        const horizon = H / 2 - Math.tan(my * 2 * RAD) * PERSP;
        for (const st of stars) {
          const px = screenX(st.az);
          if (px == null) continue;
          sg.fillStyle = `rgba(225,232,255,${st.a.toFixed(3)})`;
          sg.fillRect(px, horizon - st.el * H * .9, st.s, st.s);
        }
      }
      // la poussière qui file quand on avance ; au désert, le sable que le vent pousse
      const sand = D.motes === 'sable';
      for (const m of motes) {
        m.z -= speed * .0004 + .0004;
        if (sand) m.x += dt * (.5 + (1 - m.z) * .8);
        if (m.z < .05 || m.x > 1.4) { m.z = 1; m.x = R(-1, 1); m.y = R(-1, 1); }
        const f = .25 / m.z, px = W / 2 + m.x * W * f, py = H / 2 + m.y * H * f;
        if (px < 0 || px > W || py < 0 || py > H) continue;
        const a = Math.min(.5, (1 - m.z) * .6).toFixed(3);
        if (sand) { sg.strokeStyle = `rgba(255,222,175,${a})`; sg.lineWidth = Math.min(1.6, f); sg.beginPath(); sg.moveTo(px, py); sg.lineTo(px - 6 - f * 5, py + 1); sg.stroke(); continue; }
        sg.fillStyle = `rgba(255,240,215,${a})`;
        sg.beginPath(); sg.arc(px, py, Math.min(2.4, f * 1.2), 0, 6.28); sg.fill();
      }
    }
    listen(stage, 'pointermove', e => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; });
    raf = requestAnimationFrame(loop);

    const paint = () => {
      gates.forEach((g, j) => g.el.classList.toggle('here', j === here && inRoom));
      $('.dr-count', stage).textContent = !inRoom && here === 0 ? 'Cliquez pour entrer' : `${here + 1} / ${n}`;
      progress(stage, here, n);
    };
    const open = k => { gates[k].el.classList.add('open'); sound.woosh(1.1, 1); setTimeout(() => sound.drop(), 260); };

    // le texte d'une pièce trop long défile : à la molette, ou pas à pas avant de repartir
    const prose = () => gates[here].prose;
    const scrollRoom = d => {
      const p = prose(), max = p.scrollHeight - p.clientHeight;
      // quelques pixels de trop ne valent pas un pas de plus
      if (max < 24 || (d > 0 ? p.scrollTop >= max - 4 : p.scrollTop <= 4)) return false;
      p.scrollBy({ top: d * p.clientHeight * .8, behavior: 'smooth' });
      return true;
    };
    listen(stage, 'wheel', e => {
      if (!inRoom || busy) return;
      e.preventDefault();
      prose().scrollTop += e.deltaY;
    }, { passive: false });

    // avancer : ouvrir la première porte, ou marcher jusqu'à la suivante et y entrer, d'un seul mouvement
    function next() {
      if (busy) return;
      if (inRoom && scrollRoom(1)) return;
      if (!inRoom) {
        busy = true;
        open(here);
        setTimeout(() => moveTo(inside(here), 1500, [-200, 520], () => { inRoom = true; busy = false; paint(); }), 550);
        return;
      }
      if (here >= n - 1) return;
      busy = true;
      const from = here;
      gates[from].el.classList.add('left');
      gates[from].el.classList.remove('here');
      here++;
      paint();
      $('.dr-count', stage).textContent = `${here + 1} / ${n}`;
      sound.woosh(.8, 1);
      const a = front(here);
      const d1 = Math.min(2400, 1300 + Math.hypot(a.x - cam.x, a.z - cam.z) / 3);
      // la porte s'ouvre un peu avant qu'on l'atteigne : on entre sans s'arrêter
      setTimeout(() => open(here), d1 * .72);
      // on repart droit devant (sans reculer), en tournant peu à peu vers la porte suivante
      moveTo(a, d1, [-700, 900], () => {
        moveTo(inside(here), 1100, [-150, 380], () => {
          gates[from].el.classList.remove('open', 'left');
          busy = false;
          paint();
        }, 'out');
      }, 'in');
    }
    function prev() {
      if (busy) return;
      if (inRoom && scrollRoom(-1)) return;
      if (here === 0) return;
      busy = true;
      const from = here;
      gates[from].el.classList.add('left');
      here--;
      gates[here].el.classList.add('open');
      gates[here].el.classList.remove('left');
      sound.woosh(.7, -1);
      moveTo(inside(here), 2000, [900, 900], () => {
        gates[from].el.classList.remove('open', 'left');
        inRoom = true; busy = false; paint();
      });
    }
    paint();
    // un clic sur le texte de la pièce avance toujours, même près de son bord gauche
    stage.onclick = e => { if (!isControl(e)) (e.clientX < innerWidth / 4 && !e.target.closest('.dr-panel') ? prev : next)(); };
    reader.onKey = e => { if (NEXT_KEYS.includes(e.key)) { next(); return true; } if (PREV_KEYS.includes(e.key)) { prev(); return true; } };
    reader.cleanup.push(() => { cancelAnimationFrame(raf); removeEventListener('resize', size); });
  }

  // 6. Encre : chaque passage naît d'une tache d'encre qui s'étale puis se fige en lettres
  function presentInk(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    const seed = Math.floor(Math.random() * 100);
    stage.innerHTML = `<svg class="ink-defs" aria-hidden="true"><filter id="inkf" x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="3" seed="${seed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter></svg><div class="ink-page"></div><div class="rd-progress"><i></i></div>`;
    const disp = $('feDisplacementMap', stage), page = $('.ink-page', stage);
    let cur = null, raf = 0;
    stepper(stage, units.length, (i, d) => {
      if (cur) { const old = cur; old.style.filter = ''; old.classList.add('out'); setTimeout(() => old.remove(), 900); }
      const el = document.createElement('div');
      el.className = 'ink-unit';
      el.innerHTML = '<div class="ink-blot"></div>';
      el.append(units[i]);
      page.append(el);
      units[i].classList.remove('rd-scrolly');
      scrollHint(units[i]);
      cur = el;
      el.style.filter = 'url(#inkf)';
      cancelAnimationFrame(raf);
      const t0 = performance.now(), dur = 2000;
      const tick = now => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        disp.setAttribute('scale', (90 * (1 - e)).toFixed(1));
        if (k < 1) raf = requestAnimationFrame(tick); else el.style.filter = '';
      };
      raf = requestAnimationFrame(tick);
      requestAnimationFrame(() => el.classList.add('in'));
      if (d) sound.drop();
      progress(stage, i, units.length);
    });
    reader.cleanup.push(() => cancelAnimationFrame(raf));
  }

  // 8. Constellation de mots : les mots dérivent comme des étoiles, puis se posent en phrases
  function presentWords(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    stage.innerHTML = '<canvas class="wd-sky"></canvas><div class="wd-box"></div><div class="rd-progress"><i></i></div>';
    const cv = $('.wd-sky', stage), g = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    for (let s = 0; s < 260; s++) { g.fillStyle = `rgba(230,235,255,${Math.random() * .7})`; g.beginPath(); g.arc(Math.random() * cv.width, Math.random() * cv.height, Math.random() * 1.2, 0, 6.28); g.fill(); }
    const box = $('.wd-box', stage);
    // chaque mot dans son étoile (sauf à l'intérieur des blocs interactifs)
    const split = root => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('[data-ix], details, .wd, .ix-blank') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim()) nodes.push(n);
      for (const n of nodes) {
        const frag = document.createDocumentFragment();
        for (const part of n.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else { const s = document.createElement('span'); s.className = 'wd'; s.textContent = part; frag.append(s); }
        }
        n.replaceWith(frag);
      }
    };
    units.forEach(split);
    // les contenants visibles (citation, encadré, puce, code…) suivent les mots : ils naissent et s'effacent avec eux
    const isBox = e => {
      if (e.closest('[data-ix]') && !e.matches('[data-ix]')) return false;
      const cs = getComputedStyle(e), bg = rgbaOf(cs.backgroundColor), bf = getComputedStyle(e, '::before');
      return (bg && bg[3] > 0) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || cs.display === 'list-item'
        || ['Top', 'Right', 'Bottom', 'Left'].some(k => parseFloat(cs['border' + k + 'Width']) > 0 && cs['border' + k + 'Style'] !== 'none')
        || (bf.content && bf.content !== 'none' && bf.content !== 'normal');
    };
    const boxesOf = el => $$('*', el).filter(e => !e.matches('.wd, img, [data-ix], details, .ix-blank') && !e.closest('.wd, [data-ix], details, .ix-blank') && isBox(e));
    const scatter = el => {
      for (const b of boxesOf(el)) { b.style.transition = 'none'; b.style.opacity = '0'; }
      for (const s of $$('.wd, img, [data-ix], details, .ix-blank', el)) {
        s.style.transition = 'none';
        s.style.transform = `translate(${(Math.random() - .5) * innerWidth * .9}px, ${(Math.random() - .5) * innerHeight * .8}px) scale(${.3 + Math.random() * .5})`;
        s.style.opacity = '0';
      }
    };
    let cur = null;
    stepper(stage, units.length, (i, d) => {
      if (cur) {
        const old = cur;
        for (const b of boxesOf(old)) { b.style.transition = 'opacity .9s ease .15s'; b.style.opacity = '0'; }
        for (const s of $$('.wd, img, [data-ix], details, .ix-blank', old)) {
          s.style.transition = `transform 1.2s cubic-bezier(.5,0,.8,.4) ${Math.random() * .3}s, opacity 1s ease ${Math.random() * .3}s`;
          s.style.transform = `translate(${(Math.random() - .5) * innerWidth}px, ${(Math.random() - .5) * innerHeight}px) scale(.3)`;
          s.style.opacity = '0';
        }
        setTimeout(() => old.remove(), 1600);
      }
      const el = document.createElement('div');
      el.className = 'wd-unit';
      el.append(units[i]);
      box.append(el);
      cur = el;
      scatter(el);
      void el.offsetWidth;
      for (const b of boxesOf(el)) { b.style.transition = 'opacity 1.5s ease .45s'; b.style.opacity = '1'; }
      for (const s of $$('.wd, img, [data-ix], details, .ix-blank', el)) {
        const delay = Math.random() * .9;
        s.style.transition = `transform 1.8s cubic-bezier(.2,.75,.2,1) ${delay}s, opacity 1.2s ease ${delay}s`;
        s.style.transform = 'none';
        s.style.opacity = '1';
      }
      if (d) sound.woosh(1.2, d);
      progress(stage, i, units.length);
    });
  }

  // 11. Album de souvenirs : notes et photos éparpillées sur une table (l'auteur peut tout placer dans la mise en scène)
  const pickOne = a => a[Math.floor(Math.random() * a.length)];
  const ALBUM_OBJECTS = {
    ticket: { label: 'Billet', icon: ic('ticket'), html: () => `<div class="al-ticket"><b>Billet</b><span>N° ${String(Math.floor(1000 + Math.random() * 98999)).padStart(5, '0')}</span><i>${pickOne(['Entrée', 'Aller simple', 'Séance de 20 h', 'Quai 3'])}</i></div>` },
    stamp: { label: 'Timbre', icon: ic('stamp'), html: () => `<div class="al-stamp" style="--sc:${pickOne(['#b5523b', '#3c6e8f', '#5d7d3c', '#8a5a9e'])}"><span>${pickOne(['Souvenir', 'Poste', 'Espaces', 'Voyage'])}</span><b>${pickOne(['1,20', '0,80', '2,50', '3'])}</b></div>` },
    postmark: { label: 'Cachet', icon: ic('postmark'), html: () => `<div class="al-postmark"><span>${pickOne(['Poste', 'Arrivée', 'Départ', 'Escale'])}, ${new Date().getFullYear()}</span></div>` },
    coffee: { label: 'Tasse', icon: ic('cup'), html: () => '<div class="al-coffee"></div>' },
    leaf: { label: 'Feuille', icon: ic('feuilles'), html: () => `<svg class="al-leaf" viewBox="0 0 60 100" style="--lc:${pickOne(['#9a7b2f', '#b5652b', '#7d8a3a', '#a9472f'])}"><path d="M30 96C30 70 30 40 30 6M30 6C8 26 4 62 30 90C56 62 52 26 30 6Z"/><path d="M30 30l-12-8M30 46l-15-9M30 62l-14-8M30 30l12-8M30 46l15-9M30 62l14-8"/></svg>` },
    flower: { label: 'Fleur', icon: ic('petales'), html: () => `<svg class="al-flower" viewBox="0 0 60 60" style="--fc:${pickOne(['#d97a8f', '#e3a74a', '#9a86d1', '#e07a5f'])}">${[0, 72, 144, 216, 288].map(a => `<ellipse cx="30" cy="16" rx="8" ry="13" transform="rotate(${a} 30 30)"/>`).join('')}<circle cx="30" cy="30" r="6"/></svg>` },
    star: { label: 'Étoile', icon: ic('star'), html: () => '<svg class="al-doodle" viewBox="0 0 60 60"><path d="M30 6l7 16 17 2-13 11 4 17-15-9-15 9 4-17L6 24l17-2z"/></svg>' },
    heart: { label: 'Cœur', icon: ic('heart'), html: () => '<svg class="al-doodle" viewBox="0 0 60 56"><path d="M30 50C10 36 4 26 8 16c4-10 16-11 22-2 6-9 18-8 22 2 4 10-2 20-22 34z"/></svg>' },
    arrow: { label: 'Flèche', icon: ic('squiggle'), html: () => '<svg class="al-doodle" viewBox="0 0 80 40"><path d="M4 30C20 6 44 6 60 22M50 12l11 10-14 5"/></svg>' },
    tape: { label: 'Scotch', icon: ic('tape'), over: true, html: () => `<span class="al-tape loose ${pickOne(['raye', 'pois', 'uni', 'carreau'])}" style="--tc:${pickOne(['#e9b8b0', '#b9d3e8', '#d9e6b5', '#f0d79a'])}"></span>` },
    // le trombone dessine lui-même son ombre et son reflet : pas de filtre CSS, que WebKit perd parfois quand la table est zoomée
    clip: { label: 'Trombone', icon: ic('clip'), over: true, html: () => `<svg class="al-clip loose" width="26" height="66" viewBox="0 0 26 66">${['al-clip-shadow', 'al-clip-wire', 'al-clip-shine'].map(c => `<path class="${c}" d="M10 20v29a4 4 0 0 0 8 0V10a6.5 6.5 0 0 0-13 0v41.5a8.5 8.5 0 0 0 17 0V24"/>`).join('')}</svg>` },
    pin: { label: 'Punaise', icon: ic('pin'), over: true, html: () => `<span class="al-pin loose ${pickOne(['rouge', 'bleu', 'vert', 'or'])}"></span>` }
  };

  // la place, l'inclinaison et l'habillage de chaque souvenir : réglés par l'auteur, sinon tirés « au hasard » (toujours le même)
  function albumLayout(doc, keys) {
    return keys.map((key, k) => {
      const s = sceneItem(doc, 'album', key);
      return {
        key,
        x: s.x != null ? s.x : k * 560 + (seeded(k, 1) - .5) * 140,
        y: s.y != null ? s.y : Math.sin(k * 1.25) * 280 + (seeded(k, 2) - .5) * 80,
        rot: s.rot != null ? s.rot : (seeded(k, 3) - .5) * 14,
        paper: s.paper || '', fix: s.fix || ''
      };
    });
  }
  function albumCard(u, k, l) {
    const card = document.createElement('div');
    const photo = !!u.querySelector('img') && u.textContent.trim().length < 60;
    card.className = 'al-item' + (photo ? ' al-photo' : '') + (k === 0 ? ' al-cover' : '') + (l.paper ? ' paper-' + l.paper : '') + (l.fix ? ' fix-' + l.fix : '');
    card.dataset.key = l.key;
    if (l.fix === 'punaise') card.insertAdjacentHTML('afterbegin', '<span class="al-pin rouge"></span>');
    card.append(u);
    card.style.left = l.x + 'px';
    card.style.top = l.y + 'px';
    card.style.setProperty('--rot', l.rot + 'deg');
    return card;
  }
  // un objet se glisse sous les souvenirs, sauf les attaches (scotch, trombone, punaise) qui se posent dessus
  const objOver = o => (o.layer ? o.layer === 'dessus' : !!(ALBUM_OBJECTS[o.type] || {}).over);
  function albumObject(o, i) {
    const d = document.createElement('div');
    d.className = 'al-deco' + (objOver(o) ? ' over' : '');
    d.dataset.obj = i;
    // le trombone a changé de dessin : ceux déjà posés prennent le nouveau (il n'a rien de tiré au hasard)
    d.innerHTML = o.type === 'clip' ? ALBUM_OBJECTS.clip.html() : o.html;
    d.style.left = o.x + 'px';
    d.style.top = o.y + 'px';
    d.style.setProperty('--rot', (o.rot || 0) + 'deg');
    d.style.setProperty('--s', o.scale || 1);
    return d;
  }
  const albumKeys = units => units.map((u, k) => (k ? u.dataset.key : 'title'));

  function presentAlbum(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    const sc = sceneOf(doc, 'album');
    stage.innerHTML = `<div class="al-table${sc.table ? ' t-' + sc.table : ''}"><div class="al-world"></div></div><div class="al-more" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></div><div class="rd-progress"><i></i></div>`;
    const table = $('.al-table', stage), world = $('.al-world', stage);
    (sc.objects || []).forEach((o, i) => world.append(albumObject(o, i)));
    const L = albumLayout(doc, albumKeys(units));
    const items = units.map((u, k) => { world.append(albumCard(u, k, L[k])); return { card: world.lastChild, ...L[k] }; });
    // une note plus haute que l'écran se lit en descendant le long d'elle, avant de passer à la suivante
    let i = 0, off = 0;
    const room = () => table.clientHeight - 150;
    const maxOff = it => Math.max(0, it.card.offsetHeight - room());
    const place = speed => {
      const it = items[i], m = maxOff(it), r = it.rot * Math.PI / 180;
      const dy = m ? room() / 2 - it.card.offsetHeight / 2 + off : 0;
      world.style.transition = speed ? `transform ${speed}s cubic-bezier(.2, .7, .2, 1)` : '';
      world.style.transform = `translate(${table.clientWidth / 2}px, ${table.clientHeight / 2}px) rotate(${-it.rot * .7}deg) translate(${-(it.x - Math.sin(r) * dy)}px, ${-(it.y + Math.cos(r) * dy)}px)`;
      $('.al-more', stage).classList.toggle('on', off < m - 4);
    };
    const go = (k, d) => {
      i = k;
      off = 0;
      place();
      items.forEach((o, j) => o.card.classList.toggle('here', j === i));
      if (d) sound.brush();
      progress(stage, i, items.length);
    };
    const next = () => {
      const m = maxOff(items[i]);
      if (off < m - 4) { off = Math.min(m, off + room() * .8); place(.7); }
      else if (i < items.length - 1) go(i + 1, 1);
    };
    const prev = () => {
      if (off > 4) { off = Math.max(0, off - room() * .8); place(.7); }
      else if (i > 0) go(i - 1, -1);
    };
    listen(stage, 'wheel', e => {
      const m = maxOff(items[i]);
      if (!m) return;
      e.preventDefault();
      off = Math.max(0, Math.min(m, off + e.deltaY));
      place(.25);
    }, { passive: false });
    listen(stage, 'click', e => { if (!isControl(e)) (e.clientX < innerWidth / 4 ? prev : next)(); });
    reader.onKey = e => { if (NEXT_KEYS.includes(e.key)) { next(); return true; } if (PREV_KEYS.includes(e.key)) { prev(); return true; } };
    go(0, 0);
  }


  /* ───────────── L'éditeur de mise en scène ───────────── */

  // sel : la clé du passage choisi, ou { obj: n } pour un objet de l'album ; view : le cadrage de la table de l'album
  const scn = { sel: null, view: null };
  const scId = () => edDoc.present || '';
  const scSpec = () => SCENE[scId()] || null;

  function openScene() {
    if (!edDoc || READONLY) return;
    commitEditor();
    hideTools();
    scn.sel = null;
    scn.view = null;
    sceneHist.stack = [sceneState()];
    sceneHist.i = 0;
    $('#scene').hidden = false;
    renderScene();
    sound.pop();
  }
  function closeScene() {
    $('#scene').hidden = true;
    $('#pagePop').hidden = true;
    sound.nav();
  }
  /*
   * L'historique de la mise en scène : ⌘Z annule une coupe, un déplacement, un réglage, un changement de présentation…
   * Chaque état garde le texte de la page (que le montage peut réordonner) et tous les réglages de mise en scène.
   * La frappe dans un champ et le glissement d'un curseur ne font qu'une étape.
   */
  const sceneHist = { stack: [], i: -1, t: 0, soft: false };
  const sceneState = () => JSON.stringify({ html: edDoc.html, scene: edDoc.scene || null, present: edDoc.present || '', weather: edDoc.weather || '', night: !!edDoc.night, lamp: !!edDoc.lamp });
  function scenePush(soft) {
    if (sceneHist.i < 0 || $('#scene').hidden) return;
    const st = sceneState();
    if (st === sceneHist.stack[sceneHist.i]) return;
    const now = Date.now();
    sceneHist.stack.length = sceneHist.i + 1;
    // une suite de frappes (ou de petits pas de curseur) remplace l'étape qu'elle a commencée
    if (soft && sceneHist.soft && now - sceneHist.t < 1200 && sceneHist.i > 0) sceneHist.stack[sceneHist.i] = st;
    else { sceneHist.stack.push(st); sceneHist.i++; }
    sceneHist.t = now;
    sceneHist.soft = !!soft;
    if (sceneHist.stack.length > 120) { sceneHist.stack.shift(); sceneHist.i--; }
  }
  function sceneStep(d) {
    const k = sceneHist.i + d;
    if (k < 0 || k >= sceneHist.stack.length) return sound.tick();
    sceneHist.i = k;
    sceneHist.soft = false;
    const st = JSON.parse(sceneHist.stack[k]);
    edDoc.html = st.html;
    if (st.scene) edDoc.scene = st.scene; else delete edDoc.scene;
    for (const f of ['present', 'weather', 'night', 'lamp']) { if (st[f]) edDoc[f] = st[f]; else delete edDoc[f]; }
    // l'éditeur, derrière, suit (et garde de quoi annuler à son tour)
    edBody().innerHTML = edDoc.html;
    histCommit();
    $('.sheet').classList.toggle('night', !!edDoc.night);
    if (scn.sel && typeof scn.sel === 'string' && !$(`#scCenter [data-key="${scn.sel}"]`)) scn.sel = null;
    changed();
    renderScene();
    if (!$('#pagePop').hidden) openPagePop();
    sound.nav();
  }
  const sceneSaved = soft => { changed(); scenePush(soft); };

  /* ───────────── Versions d'une page ───────────── */

  /*
   * La page garde ses états passés : un instantané à l'ouverture, puis au plus un toutes les cinq
   * minutes de travail, et un juste avant chaque restauration (qu'on peut donc annuler).
   * Les images, souvent lourdes, ne sont stockées qu'une fois par page, quel que soit le nombre de versions.
   */
  const VERSION_MAX = 40, VERSION_GAP = 5 * 60 * 1000;
  const hashOf = s => {
    let h = 2166136261;
    const step = s.length > 4000 ? 7 : 1;
    for (let i = 0; i < s.length; i += step) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + s.length.toString(36);
  };
  const wordsOf = html => { const d = document.createElement('div'); d.innerHTML = html; return (d.textContent.match(/\S+/g) || []).length; };
  const unpackHTML = (doc, html) => html.replace(/src="vimg:([a-z0-9]+)"/g, (m, h) => `src="${esc((doc.history && doc.history.pool[h]) || '')}"`);
  // une même image peut être écrite « &lt; » ou « < » selon d'où vient la page : on la ramène à une seule forme
  const rawAttr = v => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  /*
   * Sur iPhone, l'app range les versions à part, une carte à la fois (la bibliothèque entière ne tiendrait pas dans
   * la page) : la carte ouverte les demande, les envoie quand elles changent, puis les rend en se fermant.
   */
  function loadVersions(doc) {
    vers.pending.add(doc);
    call('versionsGet', doc.id).then(t => {
      const h = t ? JSON.parse(t) : null;
      if (h && Array.isArray(h.list)) {
        const mine = doc.history, seen = new Set(h.list.map(v => v.t));
        if (mine) { for (const v of mine.list) if (!seen.has(v.t)) h.list.push(v); h.list.sort((a, b) => a.t - b.t); Object.assign(h.pool, mine.pool); }
        doc.history = h;
      }
    }).catch(e => console.error(e)).finally(() => {
      vers.pending.delete(doc);
      vers.open.add(doc);
      vers.sent.set(doc.id, versionsKey(doc.history));
      if (edDoc !== doc) return dropVersions(doc);
      if (snapshot(doc)) persist();
      if (!$('#versions').hidden) renderVersions();
    });
  }
  // une version de plus (ou gardée) : la carte a changé pour les autres appareils
  function sendVersions() {
    for (const d of vers.open) {
      const k = versionsKey(d.history);
      if (!d.history || k === vers.sent.get(d.id)) continue;
      vers.sent.set(d.id, k);
      d.updatedAt = Math.max(Date.now(), d.updatedAt || 0);
      sendBig('versionsPut', JSON.stringify({ id: d.id, history: d.history })).catch(e => console.error(e));
    }
  }
  function dropVersions(doc) {
    vers.open.delete(doc);
    vers.sent.delete(doc.id);
    delete doc.history;
  }

  function snapshot(doc, opts = {}) {
    if (!doc || READONLY) return false;
    if (VSTORE && !vers.open.has(doc)) return false;   // ses versions ne sont pas encore là
    const before = doc.history && doc.history.list[doc.history.list.length - 1];
    // pendant la frappe, on ne fait rien tant que la dernière version a moins de cinq minutes
    if (!opts.force && !opts.keep && before && Date.now() - before.t < VERSION_GAP) return false;
    if (isEmptyDoc(doc)) return false;
    const H = doc.history = doc.history || { pool: {}, list: [] };
    const html = doc.html.replace(/src="(data:[^"]+)"/g, (m, d) => { d = rawAttr(d); const h = hashOf(d); H.pool[h] = d; return `src="vimg:${h}"`; });
    const last = H.list[H.list.length - 1];
    if (last && last.html === html && last.title === doc.title) { if (opts.keep) last.keep = true; return false; }
    if (!opts.force && last && Date.now() - last.t < VERSION_GAP) return false;
    H.list.push({ t: Date.now(), title: doc.title, html, words: wordsOf(doc.html), keep: !!opts.keep, why: opts.why || '' });
    // au-delà du maximum, les plus anciennes s'en vont (sauf celles que l'auteur a gardées)
    while (H.list.length > VERSION_MAX) {
      const k = H.list.findIndex(v => !v.keep);
      if (k < 0) break;
      H.list.splice(k, 1);
    }
    const used = new Set();
    for (const v of H.list) for (const m of v.html.matchAll(/src="vimg:([a-z0-9]+)"/g)) used.add(m[1]);
    for (const h of Object.keys(H.pool)) if (!used.has(h)) delete H.pool[h];
    return true;
  }

  // la comparaison : les blocs, puis les mots dans un paragraphe retouché
  function lcsOps(a, b, eq = (x, y) => x === y) {
    const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { ops.push(['=', a[i], b[j]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', a[i++]]);
      else ops.push(['+', b[j++]]);
    }
    while (i < n) ops.push(['-', a[i++]]);
    while (j < m) ops.push(['+', b[j++]]);
    return ops;
  }
  const blockKey = b => b.tagName + '|' + b.textContent.replace(/\s+/g, ' ').trim() + '|' + ((b.tagName === 'IMG' ? b : b.querySelector('img')) || { getAttribute: () => '' }).getAttribute('src').slice(-40);
  function wordDiff(oldText, newText) {
    const a = oldText.split(/(\s+)/), b = newText.split(/(\s+)/);
    if (a.length * b.length > 400000) return null;
    return lcsOps(a, b).map(([op, x, y]) => op === '=' ? esc(x) : op === '-' ? `<del>${esc(x)}</del>` : `<ins>${esc(x)}</ins>`).join('');
  }
  function diffHTML(oldHTML, newHTML) {
    const A = document.createElement('div'), B = document.createElement('div');
    A.innerHTML = oldHTML; B.innerHTML = newHTML;
    const a = Array.from(A.children), b = Array.from(B.children);
    if (a.length * b.length > 250000) return { html: newHTML, changes: -1 };
    const ops = lcsOps(a.map(blockKey), b.map(blockKey));
    let ia = 0, ib = 0, out = '', changes = 0;
    const blocks = ops.map(([op]) => op === '=' ? { op, a: a[ia++], b: b[ib++] } : op === '-' ? { op, a: a[ia++] } : { op, b: b[ib++] });
    for (let k = 0; k < blocks.length; k++) {
      const x = blocks[k], y = blocks[k + 1];
      if (x.op === '=') { out += x.b.outerHTML; continue; }
      changes++;
      // un paragraphe retiré suivi d'un paragraphe ajouté du même genre : c'est le même, retouché
      if (x.op === '-' && y && y.op === '+' && x.a.tagName === y.b.tagName && /^(P|H[1-3]|LI|BLOCKQUOTE)$/.test(x.a.tagName) && !x.a.querySelector('img, [data-ix]')) {
        const w = wordDiff(x.a.textContent, y.b.textContent);
        if (w != null) { const c = y.b.cloneNode(false); c.innerHTML = w; c.classList.add('vd-mod'); out += c.outerHTML; k++; continue; }
      }
      const el = (x.a || x.b).cloneNode(true);
      el.classList.add(x.op === '-' ? 'vd-del' : 'vd-ins');
      out += el.outerHTML;
    }
    return { html: out, changes };
  }

  const vs = { sel: -1, compare: true };
  const fmtWhen = t => {
    const d = new Date(t), now = new Date(), day = 864e5;
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Aujourd’hui, ' + hm;
    if (d.toDateString() === new Date(now - day).toDateString()) return 'Hier, ' + hm;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + hm;
  };

  function openVersions() {
    if (!edDoc || READONLY) return;
    commitEditor();
    hideTools();
    const list = (edDoc.history && edDoc.history.list) || [];
    vs.sel = list.length - 1;
    $('#versions').hidden = false;
    renderVersions();
    sound.pop();
  }
  function closeVersions() { $('#versions').hidden = true; sound.nav(); }

  function renderVersions() {
    const list = (edDoc.history && edDoc.history.list) || [];
    const cur = wordsOf(edDoc.html);
    $('#vsList').innerHTML = `<button class="vs-item now${vs.sel < 0 ? ' on' : ''}" data-i="-1"><b>Maintenant</b><span>${plural(cur, 'mot')}</span></button>`
      + list.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => {
        const d = cur - v.words;
        return `<button class="vs-item${vs.sel === i ? ' on' : ''}" data-i="${i}"><b>${esc(fmtWhen(v.t))}${v.keep ? ' <i title="Version gardée">★</i>' : ''}</b><span>${plural(v.words, 'mot')}${d ? `, <em class="${d > 0 ? 'up' : 'down'}" title="Différence avec la page actuelle">${d > 0 ? '+' : '−'}${plural(Math.abs(d), 'mot')} depuis</em>` : ''}${v.why ? ', ' + esc(v.why) : ''}</span></button>`;
      }).join('')
      + (list.length ? '' : '<p class="sc-hint vs-empty">Pas encore d’autre version. Elles se créent seules pendant que vous écrivez, au plus toutes les cinq minutes.</p>');
    renderVersionPreview();
  }

  function renderVersionPreview() {
    const list = (edDoc.history && edDoc.history.list) || [];
    const v = list[vs.sel], box = $('#vsPreview'), bar = $('#vsActions');
    if (!v) {
      box.innerHTML = `<article class="page vs-page"><h1 class="vs-title">${esc(edDoc.title || 'Sans titre')}</h1><div class="prose">${edDoc.html}</div></article>`;
      bar.innerHTML = '<span class="vs-note">La page telle qu’elle est maintenant</span><span class="sc-sp"></span><button class="btn ghost" data-keep>☆ Garder cet état</button>';
      return;
    }
    const old = unpackHTML(edDoc, v.html);
    let body = old, note = 'La page telle qu’elle était';
    if (vs.compare) {
      const d = diffHTML(old, edDoc.html);
      body = d.html;
      note = d.changes < 0 ? 'Page trop longue pour comparer en détail' : d.changes ? '<ins>Ajouté</ins> et <del>retiré</del> depuis cette version' : 'Aucune différence de texte avec la page actuelle';
    }
    const titleChanged = vs.compare && v.title !== edDoc.title;
    box.innerHTML = `<article class="page vs-page"><h1 class="vs-title">${titleChanged ? `<del>${esc(v.title || 'Sans titre')}</del> <ins>${esc(edDoc.title || 'Sans titre')}</ins>` : esc(v.title || 'Sans titre')}</h1><div class="prose">${body}</div></article>`;
    bar.innerHTML = `<label class="vs-compare"><input type="checkbox" ${vs.compare ? 'checked' : ''}> Comparer avec maintenant</label><span class="vs-note">${note}</span><span class="sc-sp"></span>`
      + `<button class="btn ghost" data-keep>${v.keep ? '★ Gardée' : '☆ Garder'}</button><button class="btn" data-restore>Restaurer cette version</button>`;
  }

  function restoreVersion(i) {
    const v = edDoc.history.list[i];
    if (!v) return;
    // l'état actuel devient lui-même une version : la restauration peut toujours être annulée
    snapshot(edDoc, { force: true, why: 'avant restauration' });
    edDoc.html = unpackHTML(edDoc, v.html);
    edDoc.title = v.title;
    edDoc.updatedAt = Date.now();
    persist(true);
    const id = edDoc.id;
    closeVersions();
    openDoc(id);
    toast('Version restaurée. L’état précédent reste dans l’historique.');
    sound.saved();
  }

  function bindVersions() {
    $('#edHistory').addEventListener('click', openVersions);
    $('#vsBack').addEventListener('click', closeVersions);
    $('#vsList').addEventListener('click', e => {
      const b = e.target.closest('.vs-item');
      if (!b) return;
      vs.sel = +b.dataset.i;
      sound.tick();
      renderVersions();
    });
    $('#vsActions').addEventListener('change', e => { if (e.target.type === 'checkbox') { vs.compare = e.target.checked; renderVersionPreview(); } });
    $('#vsActions').addEventListener('click', e => {
      if (e.target.closest('[data-restore]')) return restoreVersion(vs.sel);
      if (e.target.closest('[data-keep]')) {
        if (vs.sel < 0) { snapshot(edDoc, { force: true, keep: true, why: 'gardée' }); vs.sel = edDoc.history.list.length - 1; }
        else { const v = edDoc.history.list[vs.sel]; v.keep = !v.keep; }
        persist();
        sound.pop();
        renderVersions();
      }
    });
  }

  function renderScene() {
    $('#scPdf').hidden = scId() !== 'slides';
    const id = scId(), S = scSpec();
    paintMoodButton();
    // la colonne de découpage ne sert plus qu'à l'album : ailleurs, on coupe directement sur la surface de montage
    $('#scene').classList.toggle('no-cuts', !(S && S.cuts) || id !== 'album');
    renderSceneBlocks();
    renderSceneCenter();
    renderSceneInspector();
  }

  // les passages tels que la présentation les montrera : le titre (ou la couverture), puis chaque groupe de blocs
  function sceneUnits() {
    const id = scId(), S = scSpec() || {};
    const head = id === 'slides' ? { key: 'cover', label: 'Couverture' } : { key: 'title', label: 'Titre' };
    return [{ ...head, text: edDoc.title || 'Sans titre', blocks: [] },
      ...scenePieces(groupsOf(edDoc, id)).map(g => ({ key: g.key.split('.')[0], label: `${S.unit || 'Passage'} ${g.n}${g.of > 1 ? ` (${g.part}/${g.of})` : ''}`, text: g.blocks.map(b => b.textContent).join(' ').replace(/\s+/g, ' ').trim() || (g.blocks.some(b => b.tagName === 'IMG' || b.querySelector('img')) ? '▣ Image' : '—'), blocks: g.blocks }))];
  }
  // numérote les passages comme l'auteur les a découpés ; un passage trop long devient « 2 (1/2) », « 2 (2/2) »
  function scenePieces(groups) {
    let n = 0;
    const out = groups.map(g => ({ ...g, n: g.cont ? n : ++n }));
    for (const g of out) { const same = out.filter(x => x.n === g.n); g.of = same.length; g.part = same.indexOf(g) + 1; }
    return out;
  }
  const blockIcon = b => b.matches('[data-ix], details') ? ic('interact') : /^H[1-3]$/.test(b.tagName) ? 'T' : b.tagName === 'BLOCKQUOTE' ? ic('quote') : /^(UL|OL)$/.test(b.tagName) ? ic('bullets')
    : b.tagName === 'IMG' || b.querySelector('img') ? ic('image') : b.tagName === 'PRE' ? '‹›' : b.classList.contains('callout') ? ic('callout') : '¶';
  const blockText = b => (b.textContent.replace(/\s+/g, ' ').trim() || (b.tagName === 'IMG' || b.querySelector('img') ? 'Image' : '—')).slice(0, 110);

  // à gauche : les blocs de la page ; entre deux blocs, de quoi couper (ou recoller) les passages
  function renderSceneBlocks() {
    const S = scSpec(), box = $('#scBlocks');
    if (!S || !S.cuts) { box.innerHTML = ''; return; }
    const all = pageBlocks(edDoc), blocks = all.filter(b => b.tagName !== 'HR'), starts = cutStarts(edDoc, scId(), all, blocks);
    const parts = {};
    for (const g of scenePieces(groupsOf(edDoc, scId()))) parts[g.n] = g.of;
    let n = 0, key = '', html = '';
    blocks.forEach((b, i) => {
      if (i === 0 || starts.has(i)) {
        n++;
        key = blockSig(b);
        const more = parts[n] > 1 ? `<small title="Trop long pour un écran : il se poursuit sur ${parts[n]} ${esc(S.unit.toLowerCase())}s">↳ ${parts[n]} parties</small>` : '';
        html += `<button class="sc-cut on${i === 0 ? ' first' : ''}" data-i="${i}"${i === 0 ? ' disabled' : ' title="Recoller au passage précédent"'}><span>${esc(S.unit)} ${n}</span>${more}</button>`;
      } else html += `<button class="sc-cut" data-i="${i}" title="Commencer ici un nouveau passage"><span>${ic('cut')} Couper ici</span></button>`;
      html += `<div class="sc-block${scn.sel === key ? ' sel' : ''}" data-key="${key}"><i>${blockIcon(b)}</i><span>${esc(blockText(b))}</span></div>`;
    });
    box.innerHTML = html || '<p class="sc-hint">La page est vide.</p>';
    $('#scReset').hidden = !sceneOf(edDoc, scId()).cuts;
  }

  function toggleCut(i) {
    const id = scId(), all = pageBlocks(edDoc), blocks = all.filter(b => b.tagName !== 'HR');
    const starts = cutStarts(edDoc, id, all, blocks), sigs = blocks.map(blockSig);
    if (starts.has(i)) starts.delete(i); else starts.add(i);
    sceneFor(edDoc, id).cuts = [...starts].filter(x => x > 0).sort((a, b) => a - b).map(x => ({ s: sigs[x], i: x }));
    sound.tick();
    haptic('step');
    sceneSaved();
    renderScene();
  }

  // au centre : ce que la présentation montrera
  function renderSceneCenter() {
    const id = scId(), S = scSpec(), box = $('#scCenter'), P = PRESENTS.find(p => p.id === id) || PRESENTS[0];
    box.className = 'sc-center';
    if (!S) {
      box.innerHTML = `<div class="sc-info"><i>${P.icon}</i><b>${esc(P.name)}</b><p>${esc(P.hint)}</p></div>`;
      return;
    }
    if (id === 'album') return renderAlbumBoard(box);
    if (!S.cuts) {
      box.innerHTML = `<div class="sc-info"><i>${P.icon}</i><b>${esc(P.name)}</b><p>${esc(P.hint)}</p></div>`;
      return;
    }
    renderMontage(box);
  }

  /*
   * La surface de montage : chaque passage est une carte habillée comme sa présentation (une porte pour les Portes,
   * une page lignée pour le Carnet, une image de pellicule…). On y coupe entre deux paragraphes, on recolle deux
   * passages, et on glisse un paragraphe d'un passage à l'autre (le texte de la page est réordonné en conséquence).
   */
  function montagePasses() {
    const id = scId(), all = pageBlocks(edDoc), blocks = all.filter(b => b.tagName !== 'HR');
    const starts = cutStarts(edDoc, id, all, blocks), passes = [];
    blocks.forEach((b, i) => { if (!passes.length || starts.has(i)) passes.push({ key: blockSig(b), idx: [] }); passes[passes.length - 1].idx.push(i); });
    return { blocks, passes };
  }

  function montageRow(b, i, extra = '') {
    const img = b.tagName === 'IMG' ? b : b.querySelector('img');
    const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
    return `<div class="mt-row${/^H[1-3]$/.test(b.tagName) ? ' h' : ''}${extra}" data-i="${i}"><i>${blockIcon(b)}</i><div class="mt-t">`
      + (img ? `<img src="${esc(img.getAttribute('src') || '')}" alt="">` : '') + (text ? esc(text.slice(0, 320)) : img ? '' : '—') + '</div></div>';
  }

  function renderMontage(box) {
    const id = scId(), S = scSpec(), { blocks, passes } = montagePasses();
    const parts = {};
    for (const g of scenePieces(groupsOf(edDoc, id))) parts[g.n] = g.of;
    const unit = S.unit.toLowerCase(), fem = /^(Carte|Diapositive|Image|Page|Pièce)$/.test(S.unit);
    box.className = 'sc-center montage';
    let html = `<div class="mt-wrap sc-m-${id}">`;
    if (sceneOf(edDoc, id).cuts) html += `<div class="mt-bar"><button class="pp-link" data-reset>Revenir au découpage automatique</button></div>`;
    // le titre (ou la couverture) ouvre la présentation ; la carte à retourner le porte sur sa première carte
    if (id !== 'flip') {
      const key = id === 'slides' ? 'cover' : 'title';
      html += `<section class="mt-card mt-title${scn.sel === key ? ' sel' : ''}" data-key="${key}"><div class="mt-deco"></div>`
        + `<header><b>${id === 'slides' ? 'Couverture' : 'Titre'}</b></header>${id === 'slides' ? '<div class="mt-shots"></div>' : `<div class="mt-cover">${esc(edDoc.title || 'Sans titre')}</div>`}</section>`;
    }
    passes.forEach((p, n) => {
      if (n) html += `<button class="mt-join" data-i="${p.idx[0]}" title="Recoller à ${fem ? 'la précédente' : 'au précédent'}">${ic('clip')}<span>Recoller</span></button>`;
      const it = sceneItem(edDoc, id, p.key);
      let style = '', front = '', rectoSigs = null;
      if (id === 'portes') style = `--c:${doorColor(it.door) || DOOR_COLORS[n % DOOR_COLORS.length]}`;
      if (id === 'flip') {
        const fs = flipSides(edDoc, p.idx.map(i => blocks[i]), n, p.key), tone = ALL_TONES.find(c => c.id === it.tone);
        const [bg, fg] = tone ? [tone.bg, tone.fg] : colorOf(edDoc);
        rectoSigs = new Set(fs.recto.map(r => r.sig));
        const label = fs.label || fs.recto.map(r => r.title ? r.text : blockText(r.block)).join(' ') || 'Carte ' + (n + 1);
        front = `<div class="mt-front" style="background:${bg};color:${fg}"><small>Recto</small><strong>${esc(label)}</strong></div>`;
      }
      const more = parts[n + 1] > 1 ? `<small title="Trop long pour un écran : il se poursuit sur ${parts[n + 1]} ${esc(unit)}s">se poursuit sur ${parts[n + 1]}</small>` : '';
      html += `<section class="mt-card${scn.sel === p.key ? ' sel' : ''}${it.align ? ' al-' + it.align : ''}" data-key="${p.key}" style="${style}"><div class="mt-deco"></div>`
        + front + `<header><b>${esc(S.unit)} ${n + 1}</b>${more}</header>${id === 'slides' ? '<div class="mt-shots"></div>' : ''}<div class="mt-body">`
        + p.idx.map((i, k) => (k ? `<button class="mt-cut" data-i="${i}" title="Commencer ici ${fem ? 'une nouvelle' : 'un nouveau'} ${esc(unit)}"><span>${ic('cut')} Couper ici</span></button>` : '')
          + montageRow(blocks[i], i, rectoSigs && rectoSigs.has(blockSig(blocks[i])) ? ' recto' : '')).join('')
        + '</div></section>';
    });
    if (!passes.length) html += '<p class="sc-hint">La page est vide.</p>';
    box.innerHTML = html + '</div>';
    if (id === 'slides') slideShots(box);
  }

  /*
   * Le diaporama dans la mise en scène : chaque carte montre la vraie diapositive, fabriquée comme en présentation et
   * posée sur une scène de la taille de l'écran, puis réduite. Une diapositive qui se poursuit montre toutes ses suites.
   * Seuls les blocs interactifs restent inertes ici : ils s'animent en présentation.
   */
  function slideShots(box) {
    const W = innerWidth, H = innerHeight;
    const shot = el => {
      const wrap = document.createElement('div'), stage = document.createElement('div'), track = document.createElement('div');
      wrap.className = 'mt-shot';
      wrap.style.aspectRatio = `${W} / ${H}`;
      stage.className = 'rd-stage rd-slides mt-stage';
      stage.style.width = W + 'px';
      stage.style.height = H + 'px';
      track.className = 'rd-track';
      track.append(el);
      stage.append(track);
      wrap.append(stage);
      if (edDoc.night) wrap.classList.add('night');
      return wrap;
    };
    const pieces = scenePieces(groupsOf(edDoc, 'slides')), slides = [];
    const cover = $('.mt-title .mt-shots', box);
    if (cover) { const c = slideCover(edDoc); slides.push(c); cover.append(shot(c)); }
    $$('.mt-card:not(.mt-title) .mt-shots', box).forEach((holder, k) => {
      for (const part of pieces.filter(p => p.n === k + 1)) { const s = slideOf(edDoc, part); slides.push(s); holder.append(shot(s)); }
    });
    const fit = () => {
      for (const s of $$('.mt-shot', box)) $('.mt-stage', s).style.transform = `scale(${s.clientWidth / W})`;
    };
    fit();
    fitSlideImages(slides);
    $$('.mt-stage', box).forEach(ensureContrast);
    $$('.mt-stage img', box).forEach(im => { if (!im.complete) im.addEventListener('load', () => fitSlideImages(slides), { once: true }); });
    // la mise en scène change de largeur ; l'écran lui-même change (iPad tourné) : les aperçus suivent
    if (scn.shotObs) scn.shotObs.disconnect();
    scn.shotObs = new ResizeObserver(() => {
      if (scId() !== 'slides' || !$('.mt-shot', box)) return;
      if (innerWidth !== W || innerHeight !== H) renderSceneCenter(); else fit();
    });
    scn.shotObs.observe(box);
  }

  // déplace le bloc « from » devant le bloc « to » (ou en fin de page), dans le passage « pass »
  function moveSceneBlock(from, to, pass) {
    const id = scId(), { blocks, passes } = montagePasses();
    const order = [];
    passes.forEach((p, n) => p.idx.forEach(i => order.push({ i, p: n })));
    const at = order.findIndex(o => o.i === from);
    const [m] = order.splice(at, 1);
    m.p = pass;
    let pos = to >= blocks.length ? order.length : order.findIndex(o => o.i === to);
    if (pos < 0) pos = order.length;
    order.splice(pos, 0, m);
    // le texte de la page, réordonné (les lignes vides et les séparateurs restent où ils sont)
    const box = document.createElement('div');
    box.innerHTML = edDoc.html;
    const live = Array.from(box.children).filter(b => b.tagName !== 'HR' && (b.tagName === 'IMG' || b.querySelector('img') || b.textContent.trim()));
    if (live.length !== blocks.length) return toast('Ce paragraphe ne peut pas être déplacé');
    const el = live[from];
    if (pos < order.length - 1) live[order[pos + 1].i].before(el); else live[order[pos - 1].i].after(el);
    // les réglages d'un passage suivent son passage, même si son premier paragraphe a changé
    const sc = sceneFor(edDoc, id), oldKeys = passes.map(p => p.key), items = sc.items || {};
    const firsts = {};
    order.forEach(o => { if (!(o.p in firsts)) firsts[o.p] = blockSig(blocks[o.i]); });
    for (const [n, key] of Object.entries(firsts)) if (key !== oldKeys[n] && items[oldKeys[n]] && !items[key]) items[key] = items[oldKeys[n]];
    sc.cuts = order.map((o, k) => (k > 0 && o.p !== order[k - 1].p ? { s: blockSig(blocks[o.i]), i: k } : null)).filter(Boolean);
    edDoc.html = box.innerHTML;
    edBody().innerHTML = edDoc.html;
    histCommit();
    if (scn.sel === oldKeys[pass]) scn.sel = firsts[pass] || null;
    sound.brush();
    haptic('step');
    sceneSaved();
    renderScene();
  }

  // glisser un paragraphe : une copie suit le pointeur, un trait montre où il va se poser
  function bindMontageDrag(center) {
    let d = null;
    const slotsOf = () => {
      const top = center.getBoundingClientRect().top - center.scrollTop, out = [];
      const cards = $$('.mt-card:not(.mt-title)', center);
      cards.forEach((card, n) => {
        const rows = $$('.mt-row', card), cr = card.getBoundingClientRect();
        rows.forEach((r, k) => {
          const rr = r.getBoundingClientRect();
          out.push({ y: rr.top - top - 3, to: +r.dataset.i, pass: n, x: cr.left + 14, w: cr.width - 28 });
          if (k === rows.length - 1) {
            const next = cards[n + 1];
            out.push({ y: rr.bottom - top + 3, to: next ? +$('.mt-row', next).dataset.i : Infinity, pass: n, x: cr.left + 14, w: cr.width - 28 });
          }
        });
      });
      return out;
    };
    center.addEventListener('pointerdown', e => {
      const row = e.target.closest('.montage .mt-row');
      if (!row || e.button) return;
      d = { row, from: +row.dataset.i, sx: e.clientX, sy: e.clientY, on: false, touch: e.pointerType === 'touch' };
      // au doigt, le paragraphe se saisit après un court appui tenu (avant, le geste fait défiler la surface)
      if (d.touch) { const x = d; x.hold = setTimeout(() => { if (d === x) { x.held = true; haptic('step'); row.classList.add('held'); } }, 320); }
    });
    // une fois le paragraphe saisi, le doigt ne fait plus défiler la page
    document.addEventListener('touchmove', e => { if (d && d.held) e.preventDefault(); }, { passive: false });
    addEventListener('pointermove', e => {
      if (!d) return;
      if (!d.on) {
        if (d.touch && !d.held) { if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) { clearTimeout(d.hold); d = null; } return; }
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
        d.on = true;
        d.slots = slotsOf();
        const r = d.row.getBoundingClientRect();
        d.ghost = d.row.cloneNode(true);
        d.ghost.className += ' mt-ghost';
        Object.assign(d.ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
        d.dx = e.clientX - r.left; d.dy = e.clientY - r.top;
        d.line = document.createElement('div');
        d.line.className = 'mt-ins';
        document.body.append(d.ghost, d.line);
        d.row.classList.add('dragging');
        center.classList.add('dragging');
        sound.tick();
        haptic();
      }
      d.ghost.style.left = (e.clientX - d.dx) + 'px';
      d.ghost.style.top = (e.clientY - d.dy) + 'px';
      // près des bords, la surface défile toute seule
      const cr = center.getBoundingClientRect();
      if (e.clientY < cr.top + 50) center.scrollTop -= 14; else if (e.clientY > cr.bottom - 50) center.scrollTop += 14;
      const y = e.clientY - cr.top + center.scrollTop;
      let best = null;
      for (const s of d.slots) if (!best || Math.abs(s.y - y) < Math.abs(best.y - y)) best = s;
      if (best && d.slot && best !== d.slot) haptic();
      d.slot = best;
      if (best) Object.assign(d.line.style, { left: best.x + 'px', width: best.w + 'px', top: (best.y + cr.top - center.scrollTop) + 'px' });
    });
    const end = e => {
      if (!d) return;
      const x = d;
      d = null;
      clearTimeout(x.hold);
      x.row.classList.remove('held');
      if (!x.on) return;
      x.ghost.remove(); x.line.remove();
      x.row.classList.remove('dragging');
      center.classList.remove('dragging');
      scn.dragged = true;
      setTimeout(() => { scn.dragged = false; }, 0);
      const s = e.type === 'pointerup' && x.slot;
      if (!s) return;
      // reposé exactement où il était : rien à faire
      const { passes } = montagePasses(), own = passes.findIndex(p => p.idx.includes(x.from));
      const next = passes.flatMap(p => p.idx)[passes.flatMap(p => p.idx).indexOf(x.from) + 1];
      if (s.pass === own && (s.to === x.from || s.to === next || (s.to === Infinity && next === undefined))) return;
      moveSceneBlock(x.from, s.to === Infinity ? Infinity : s.to, s.pass);
    };
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  // chaque vignette montre la diapositive entière, réduite, centrée dans sa hauteur
  function fitSlideThumbs() {
    for (const el of $$('#scCenter .sc-slide')) {
      const z = $('.sc-zoom', el), k = el.clientWidth / 1000;
      z.style.transform = `translateY(${Math.max(0, (el.clientHeight - z.offsetHeight * k) / 2).toFixed(1)}px) scale(${k.toFixed(4)})`;
    }
  }

  // l'album : la vraie table, où l'on déplace les souvenirs et les objets
  function renderAlbumBoard(box) {
    const sc = sceneOf(edDoc, 'album'), units = sceneUnits();
    box.className = 'sc-center board';
    box.innerHTML = `<div class="sc-board al-table${sc.table ? ' t-' + sc.table : ''}"><div class="sc-world"></div><div class="sc-tools"><button data-zoom="-1" title="Dézoomer">−</button><button data-zoom="0">Tout voir</button><button data-zoom="1" title="Zoomer">+</button></div><div class="sc-board-hint">Glissez les souvenirs et les objets pour les placer</div></div>`;
    const world = $('.sc-world', box);
    (sc.objects || []).forEach((o, i) => {
      const d = albumObject(o, i);
      if (scn.sel && scn.sel.obj === i) { d.classList.add('sel'); if (scn.newObj) d.classList.add('new'); }
      world.append(d);
    });
    scn.newObj = false;
    const L = albumLayout(edDoc, units.map(u => u.key));
    units.forEach((u, k) => {
      let el;
      if (k === 0) { el = document.createElement('div'); el.className = 'prose pv-title'; el.innerHTML = `<h1 class="rd-title">${esc(u.text)}</h1>`; }
      else { el = document.createElement('div'); el.className = 'prose'; el.append(...u.blocks.map(b => b.cloneNode(true))); }
      const card = albumCard(el, k, L[k]);
      card.classList.add('here');
      if (scn.sel === u.key) card.classList.add('sel');
      world.append(card);
    });
    requestAnimationFrame(() => { if (!scn.view) fitBoard(); else placeBoard(); ghostDecos(); });
  }
  // dans l'atelier, un objet glissé sous un souvenir reste visible (en transparence) et saisissable
  function ghostDecos() {
    const cards = $$('#scCenter .al-item').map(c => c.getBoundingClientRect());
    for (const d of $$('#scCenter .al-deco:not(.over)')) {
      const r = d.getBoundingClientRect();
      d.classList.toggle('ghost', cards.some(c => r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top));
    }
  }
  function placeBoard() {
    const w = $('#scCenter .sc-world');
    if (!w || !scn.view) return;
    w.style.transform = `translate(${scn.view.x}px, ${scn.view.y}px) scale(${scn.view.z})`;
    // les contours et la zone de prise restent à la même taille à l'écran, quel que soit le zoom
    w.style.setProperty('--z', scn.view.z);
  }
  function fitBoard() {
    const board = $('#scCenter .sc-board');
    if (!board) return;
    const els = $$('.al-item, .al-deco', board);
    if (!els.length) { scn.view = { x: board.clientWidth / 2, y: board.clientHeight / 2, z: .6 }; return placeBoard(); }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const el of els) {
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top), hw = el.offsetWidth / 2 + 20, hh = el.offsetHeight / 2 + 20;
      x0 = Math.min(x0, x - hw); x1 = Math.max(x1, x + hw); y0 = Math.min(y0, y - hh); y1 = Math.max(y1, y + hh);
    }
    const z = Math.min(.9, (board.clientWidth - 40) / (x1 - x0), (board.clientHeight - 60) / (y1 - y0));
    scn.view = { z, x: board.clientWidth / 2 - (x0 + x1) / 2 * z, y: board.clientHeight / 2 - (y0 + y1) / 2 * z };
    placeBoard();
  }

  // à droite : les réglages d'ensemble, puis ceux du passage (ou de l'objet) choisi
  function fieldHTML(f, val, scope) {
    const cur = val == null ? (f.type === 'range' ? 0 : f.options[0][0]) : val;
    if (f.type === 'seg') return `<div class="sc-field"><label>${esc(f.label)}</label><div class="pp-seg">${f.options.map(([v, l]) => `<button data-f="${f.key}" data-scope="${scope}" data-v="${v}" class="${cur === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
    if (f.type === 'swatch') return `<div class="sc-field"><label>${esc(f.label)} <small>${esc((f.options.find(o => o[0] === cur) || f.options[0])[1])}</small></label><div class="sc-sw">${f.options.map(([v, l, c]) => `<button data-f="${f.key}" data-scope="${scope}" data-v="${v}" title="${esc(l)}" style="--c:${c}" class="${cur === v ? 'on' : ''}${!v && f.key === 'bg' ? ' auto' : ''}"></button>`).join('')}</div></div>`;
    return `<div class="sc-field"><label>${esc(f.label)} <small>${Math.round(cur)}${f.unit || ''}</small></label><input type="range" data-f="${f.key}" data-scope="${scope}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${cur}"></div>`;
  }

  // pour la carte choisie : chacun de ses éléments, avec son côté
  function flipSidesHTML(key) {
    const groups = groupsOf(edDoc, 'flip'), k = groups.findIndex(g => g.key === key);
    if (k < 0) return '';
    const fs = flipSides(edDoc, groups[k].blocks, k, key);
    // le titre se choisit : laissé vide, la carte garde son titre automatique (affiché en grisé)
    return '<div class="sc-sec">Recto et verso</div>'
      + `<div class="sc-field"><label>Titre de la carte <small>${fs.own ? 'écrit à la main' : 'automatique'}</small></label><input type="text" class="sc-text" data-ftitle="1" maxlength="160" value="${esc(fs.own)}" placeholder="${esc(fs.titleText || fs.auto)}" spellcheck="true"></div>`
      + fs.rows.map(r => `<div class="sc-side"><i>${r.title ? 'T' : blockIcon(r.block)}</i><span>${esc(r.title ? (fs.own ? 'Titre de la carte' : 'Titre de la page') : blockText(r.block))}</span><div class="pp-seg">`
      + [['r', 'Recto'], ['v', 'Verso']].map(([v, l]) => `<button data-side="${r.sig}" data-v="${v}" class="${r.side === v ? 'on' : ''}">${l}</button>`).join('') + '</div></div>').join('');
  }

  function renderSceneInspector() {
    const id = scId(), S = scSpec(), box = $('#scInspector');
    const to = nextCard(edDoc);
    const end = '<div class="sc-sec">À la fin</div>' + (to
      ? `<button class="sc-next" data-next="pick"><small>Puis lire</small><b>${esc(to.title || 'Sans titre')}</b></button><button class="pp-link sc-clear" data-next="">Retirer le lien</button>`
      : '<button class="btn ghost sc-next-add" data-next="pick">Enchaîner sur une carte…</button>');
    if (!S) { box.innerHTML = end; return; }
    const sc = sceneOf(edDoc, id);
    let html = '';
    if (S.global) html += '<div class="sc-sec">Ensemble</div>' + S.global.map(f => fieldHTML(f, sc[f.key], 'g')).join('');
    if (id === 'album') {
      html += '<div class="sc-sec">Poser un objet</div><div class="sc-objs">' + Object.entries(ALBUM_OBJECTS).map(([k, o]) => `<button class="pp-tile" data-add="${k}"><i>${o.icon}</i><span>${esc(o.label)}</span></button>`).join('') + '</div>';
    }
    const sel = scn.sel;
    if (sel && typeof sel === 'object') {
      const o = (sc.objects || [])[sel.obj];
      if (o) {
        html += `<div class="sc-sec">${esc((ALBUM_OBJECTS[o.type] || {}).label || 'Objet')}</div>`
          + fieldHTML({ key: 'rot', label: 'Rotation', type: 'range', min: -180, max: 180, unit: '°' }, o.rot || 0, 'o')
          + fieldHTML({ key: 'scale', label: 'Taille', type: 'range', min: 40, max: 220, unit: ' %' }, Math.round((o.scale || 1) * 100), 'o')
          + fieldHTML({ key: 'layer', label: 'Plan', type: 'seg', options: [['dessous', 'Sous les souvenirs'], ['dessus', 'Sur les souvenirs']] }, objOver(o) ? 'dessus' : 'dessous', 'o')
          + (!objOver(o) && $(`#scCenter .al-deco.ghost[data-obj="${sel.obj}"]`) ? '<p class="sc-hint">Une note le recouvre en partie.</p>' : '')
          + '<button class="btn ghost danger sc-del" data-delobj="1">Retirer l’objet</button>';
      }
    } else if (S.item) {
      const u = sel && sceneUnits().find(x => x.key === sel);
      if (u) {
        const item = sceneItem(edDoc, id, u.key);
        const lay = id === 'album' ? albumLayout(edDoc, sceneUnits().map(x => x.key)).find(l => l.key === u.key) : null;
        const fieldFor = f => (id === 'album' && u.key === 'title' && f.key === 'paper' ? { ...f, options: COVER_PAPERS } : f);
        html += `<div class="sc-sec">${esc(u.label)}</div>` + S.item.map(f => fieldHTML(fieldFor(f), f.key === 'rot' && lay ? lay.rot : item[f.key], 'i')).join('')
          + (id === 'flip' ? flipSidesHTML(u.key) : '')
          + (id === 'slides' ? `<div class="sc-sec">Notes de l’orateur</div><div class="sc-field"><textarea class="sc-text sc-notes" data-fnotes="1" rows="6" placeholder="Ce que vous voulez dire sur cette diapositive. Visible de vous seul, pendant la présentation.">${esc(item.notes || '')}</textarea></div>` : '')
          + (Object.keys(item).length ? '<button class="pp-link sc-clear" data-clear="1">Revenir aux réglages automatiques</button>' : '');
      }
    }
    if (id === 'flip') html += '<div class="sc-sec">Découpage</div><p class="sc-hint">Un intertitre devient le recto</p>';
    box.innerHTML = html + end;
  }

  function setField(el, live) {
    const id = scId(), f = el.dataset.f, scope = el.dataset.scope;
    let v = el.type === 'range' ? +el.value : el.dataset.v;
    if (scope === 'g') { const sc = sceneFor(edDoc, id); if (v === '') delete sc[f]; else sc[f] = v; }
    else if (scope === 'i' && typeof scn.sel === 'string') { const it = sceneItemFor(edDoc, id, scn.sel); if (v === '') delete it[f]; else it[f] = v; }
    else if (scope === 'o' && scn.sel && typeof scn.sel === 'object') {
      const o = sceneFor(edDoc, 'album').objects[scn.sel.obj];
      if (f === 'scale') v = v / 100;
      o[f] = v;
    }
    if (live) {
      // pendant qu'on glisse le curseur : on ne redessine que ce qui bouge
      const lab = el.closest('.sc-field').querySelector('small');
      if (lab) lab.textContent = Math.round(+el.value) + (f === 'rot' ? '°' : ' %');
      const node = scope === 'o' ? $(`#scCenter .al-deco[data-obj="${scn.sel.obj}"]`) : $(`#scCenter .al-item[data-key="${scn.sel}"]`);
      if (node) node.style.setProperty(f === 'rot' ? '--rot' : '--s', f === 'rot' ? v + 'deg' : v);
      return;
    }
    sound.nav();
    sceneSaved(live);
    renderSceneCenter();
    renderSceneInspector();
  }

  function selectScene(sel) {
    scn.sel = sel;
    renderSceneBlocks();
    for (const el of $$('#scCenter [data-key], #scCenter .al-deco')) el.classList.toggle('sel', typeof sel === 'string' ? el.dataset.key === sel : !!sel && +el.dataset.obj === sel.obj && el.classList.contains('al-deco'));
    renderSceneInspector();
  }

  function bindScene() {
    $('#edScene').addEventListener('click', openScene);
    $('#scBack').addEventListener('click', closeScene);
    $('#scPreview').addEventListener('click', () => { commitEditor(); openReader(edDoc, true); });
    $('#scPdf').addEventListener('click', exportSlides);
    $('#scReset').addEventListener('click', () => { delete sceneFor(edDoc, scId()).cuts; sceneSaved(); renderScene(); });
    $('#scBlocks').addEventListener('click', e => {
      const cut = e.target.closest('.sc-cut');
      if (cut && !cut.disabled) return toggleCut(+cut.dataset.i);
      const b = e.target.closest('.sc-block');
      if (b) selectScene(b.dataset.key);
    });
    $('#scInspector').addEventListener('click', async e => {
      const nx = e.target.closest('button[data-next]');
      if (nx) {
        const doc = edDoc;
        if (!nx.dataset.next) delete doc.next;
        else {
          const to = await pickPage('Enchaîner sur quelle carte ?');
          if (!to) return;
          if (to.id === doc.id) return toast('Choisissez une autre carte que celle-ci');
          doc.next = to.id;
        }
        sound.nav();
        sceneSaved();
        return renderSceneInspector();
      }
      const f = e.target.closest('button[data-f]');
      if (f) return setField(f);
      const sd = e.target.closest('button[data-side]');
      if (sd && typeof scn.sel === 'string') {
        const it = sceneItemFor(edDoc, 'flip', scn.sel);
        it.side = Object.assign({}, it.side, { [sd.dataset.side]: sd.dataset.v });
        sound.nav();
        sceneSaved();
        renderSceneCenter();
        renderSceneInspector();
        return;
      }
      const add = e.target.closest('[data-add]');
      if (add) {
        const sc = sceneFor(edDoc, 'album'), board = $('#scCenter .sc-board'), v = scn.view || { x: 0, y: 0, z: 1 };
        sc.objects = sc.objects || [];
        // l'objet se pose à côté du souvenir choisi (sinon au milieu de ce qu'on voit), sur la table et non sous une note
        let cx = board ? (board.clientWidth / 2 - v.x) / v.z : 0, cy = board ? (board.clientHeight / 2 - v.y) / v.z : 0;
        const card = typeof scn.sel === 'string' && $(`#scCenter .al-item[data-key="${scn.sel}"]`);
        if (card) { cx = parseFloat(card.style.left) + card.offsetWidth / 2 + 110; cy = parseFloat(card.style.top) - card.offsetHeight / 4; }
        const o = { type: add.dataset.add, html: ALBUM_OBJECTS[add.dataset.add].html(), x: Math.round(cx + (Math.random() - .5) * 80), y: Math.round(cy + (Math.random() - .5) * 80), rot: Math.round((Math.random() - .5) * 40) };
        sc.objects.push(o);
        scn.sel = { obj: sc.objects.length - 1 };
        // on s'approche pour le voir arriver : de loin, un petit objet ne fait que quelques pixels
        if (board) {
          const z = Math.max(v.z, .75);
          scn.view = { z, x: board.clientWidth / 2 - o.x * z, y: board.clientHeight / 2 - o.y * z };
        }
        scn.newObj = true;
        sound.drop();
        sceneSaved();
        renderSceneCenter();
        renderSceneInspector();
        return;
      }
      if (e.target.closest('[data-delobj]')) {
        sceneFor(edDoc, 'album').objects.splice(scn.sel.obj, 1);
        scn.sel = null;
        sound.remove();
        sceneSaved();
        renderSceneCenter();
        renderSceneInspector();
        return;
      }
      if (e.target.closest('[data-clear]')) {
        const sc = sceneFor(edDoc, scId());
        if (sc.items) delete sc.items[scn.sel];
        sceneSaved();
        renderSceneCenter();
        renderSceneInspector();
      }
    });
    $('#scInspector').addEventListener('input', e => {
      if (e.target.type === 'range') return setField(e.target, true);
      // le titre d'une carte : les vignettes suivent la frappe, le panneau se redessine en quittant le champ
      if (e.target.dataset.fnotes && typeof scn.sel === 'string') {
        const it = sceneItemFor(edDoc, 'slides', scn.sel);
        if (e.target.value.trim()) it.notes = e.target.value; else delete it.notes;
        return sceneSaved(true);
      }
      if (e.target.dataset.ftitle && typeof scn.sel === 'string') {
        const it = sceneItemFor(edDoc, 'flip', scn.sel), v = e.target.value.trim();
        if (v) it.title = e.target.value; else delete it.title;
        sceneSaved(true);
        renderSceneCenter();
      }
    });
    $('#scInspector').addEventListener('change', e => { if (e.target.type === 'range') setField(e.target); else if (e.target.dataset.ftitle) renderSceneInspector(); });
    $('#scInspector').addEventListener('keydown', e => { if (e.target.dataset.ftitle && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

    // au centre : choisir, et sur la table de l'album, déplacer ou faire glisser la vue
    const center = $('#scCenter');
    center.addEventListener('click', e => {
      if (e.target.closest('.sc-tools')) {
        const z = e.target.closest('[data-zoom]');
        if (!z) return;
        const d = +z.dataset.zoom;
        if (!d) fitBoard();
        else {
          const board = $('.sc-board', center), k = d > 0 ? 1.25 : .8, v = scn.view;
          const cx = board.clientWidth / 2, cy = board.clientHeight / 2;
          scn.view = { z: v.z * k, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
          placeBoard();
        }
        return;
      }
      if (scId() === 'album' || scn.dragged) return;
      const cut = e.target.closest('.mt-cut, .mt-join');
      if (cut) return toggleCut(+cut.dataset.i);
      if (e.target.closest('[data-reset]')) { delete sceneFor(edDoc, scId()).cuts; sceneSaved(); return renderScene(); }
      const el = e.target.closest('[data-key]');
      if (el) selectScene(el.dataset.key);
    });
    bindMontageDrag(center);
    // au doigt, pincer la table de l'album pour zoomer (deux doigts) ; un doigt la fait glisser comme avant
    const pinch = new Map();
    let pinch0 = null;
    center.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || scId() !== 'album' || !e.target.closest('.sc-board')) return;
      pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.size === 2 && scn.view) {
        const [a, b] = [...pinch.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), z: scn.view.z, x: scn.view.x, y: scn.view.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      }
    }, true);
    center.addEventListener('pointermove', e => {
      if (!pinch.has(e.pointerId)) return;
      pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.size !== 2 || !pinch0) return;
      e.stopImmediatePropagation();
      const [a, b] = [...pinch.values()], board = $('.sc-board', center), r = board.getBoundingClientRect();
      const z = Math.max(.12, Math.min(2, pinch0.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d));
      const cx = pinch0.cx - r.left, cy = pinch0.cy - r.top, k = z / pinch0.z;
      scn.view = { z, x: cx - (cx - pinch0.x) * k, y: cy - (cy - pinch0.y) * k };
      placeBoard();
    }, true);
    const unpinch = e => { pinch.delete(e.pointerId); if (pinch.size < 2) pinch0 = null; };
    center.addEventListener('pointerup', unpinch, true);
    center.addEventListener('pointercancel', unpinch, true);
    let drag = null;
    center.addEventListener('pointerdown', e => {
      if (scId() !== 'album' || e.target.closest('.sc-tools') || e.button) return;
      const board = e.target.closest('.sc-board');
      if (!board) return;
      const card = e.target.closest('.al-item'), obj = e.target.closest('.al-deco');
      const el = card || obj;
      if (el) {
        const sel = card ? card.dataset.key : { obj: +obj.dataset.obj };
        selectScene(sel);
        drag = { el, sel, sx: e.clientX, sy: e.clientY, x: parseFloat(el.style.left), y: parseFloat(el.style.top), moved: false };
      } else drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: scn.view.x, vy: scn.view.y };
      board.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    center.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (drag.pan) { scn.view.x = drag.vx + dx; scn.view.y = drag.vy + dy; placeBoard(); return; }
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag.el.style.left = (drag.x + dx / scn.view.z) + 'px';
      drag.el.style.top = (drag.y + dy / scn.view.z) + 'px';
      const under = drag.el.classList.contains('ghost');
      ghostDecos();
      if (drag.el.classList.contains('ghost') !== under) haptic();
    });
    const drop = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.pan || !d.moved) return;
      const x = Math.round(parseFloat(d.el.style.left)), y = Math.round(parseFloat(d.el.style.top));
      if (typeof d.sel === 'string') {
        const it = sceneItemFor(edDoc, 'album', d.sel);
        // la première fois qu'on la déplace, la note garde l'inclinaison qu'elle avait
        if (it.rot == null) it.rot = Math.round(parseFloat(getComputedStyle(d.el).getPropertyValue('--rot')) || 0);
        it.x = x; it.y = y;
      } else Object.assign(sceneFor(edDoc, 'album').objects[d.sel.obj], { x, y });
      sound.brush();
      haptic('step');
      sceneSaved();
      ghostDecos();
      renderSceneInspector();
    };
    center.addEventListener('pointerup', drop);
    center.addEventListener('pointercancel', drop);
    center.addEventListener('wheel', e => {
      if (scId() !== 'album' || !scn.view || !e.target.closest('.sc-board')) return;
      e.preventDefault();
      const board = $('.sc-board', center), r = board.getBoundingClientRect(), k = Math.exp(-e.deltaY * .0015), v = scn.view;
      const cx = e.clientX - r.left, cy = e.clientY - r.top, z = Math.max(.12, Math.min(2, v.z * k)), kk = z / v.z;
      scn.view = { z, x: cx - (cx - v.x) * kk, y: cy - (cy - v.y) * kk };
      placeBoard();
    }, { passive: false });
    addEventListener('resize', () => { if ($('#scene').hidden) return; if (scId() === 'album') fitBoard(); if (scId() === 'slides') fitSlideThumbs(); });
  }

  // 12. Pellicule : le texte défile image par image, avec le grain et le cliquetis du projecteur
  function presentFilm(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    stage.innerHTML = '<div class="fm-strip"><div class="fm-track"></div></div><div class="fm-flicker"></div><div class="fm-scratch"></div><div class="rd-progress"><i></i></div>';
    const track = $('.fm-track', stage), scratch = $('.fm-scratch', stage);
    for (const u of units) { const f = document.createElement('div'); f.className = 'fm-frame'; f.append(u); track.append(f); scrollHint(u); }
    const frames = $$('.fm-frame', track);
    // rayures et poussières, tirées au hasard à chaque image
    const iv = setInterval(() => {
      scratch.innerHTML = Array.from({ length: Math.floor(Math.random() * 3) }, () => `<i style="left:${Math.random() * 100}%;opacity:${.15 + Math.random() * .3}"></i>`).join('')
        + (Math.random() < .3 ? `<b style="left:${Math.random() * 100}%;top:${Math.random() * 100}%"></b>` : '');
    }, 90);
    let clat = null;
    stepper(stage, frames.length, (i, d) => {
      const f = frames[i];
      track.style.transform = `translateY(${-(f.offsetTop + f.offsetHeight / 2)}px)`;
      frames.forEach((x, j) => x.classList.toggle('here', j === i));
      if (d) {
        track.classList.add('moving');
        setTimeout(() => track.classList.remove('moving'), 550);
        clearInterval(clat);
        let n = 0;
        clat = setInterval(() => { sound.tick(.6); if (++n > 13) clearInterval(clat); }, 38);
      }
      progress(stage, i, frames.length);
    });
    reader.cleanup.push(() => { clearInterval(iv); clearInterval(clat); });
  }

  // 13. Carnet de voyage : un carnet ouvert dont on tourne les pages
  function presentNotebook(doc, stage) {
    const src = passages(doc).map(u => u.innerHTML);
    const pages = ['__cover__', ...src];
    if (pages.length % 2) pages.push('');
    stage.innerHTML = '<div class="nb-book"><div class="nb-page nb-left"></div><div class="nb-page nb-right"></div><div class="nb-turn"><div class="nb-page nb-front"></div><div class="nb-page nb-back"></div></div></div><div class="rd-nav"><button class="rd-prev">‹</button><span class="rd-count"></span><button class="rd-next">›</button></div>';
    const book = $('.nb-book', stage), L = $('.nb-left', stage), Rt = $('.nb-right', stage), turn = $('.nb-turn', stage), front = $('.nb-front', stage), back = $('.nb-back', stage);
    const stamps = ['ESPACES', 'VU', 'ARRIVÉE', 'SOUVENIR', 'PASSAGE'];
    const fill = (el, k) => {
      el.innerHTML = '';
      const c = pages[k];
      if (c === '__cover__') {
        el.innerHTML = '<div class="nb-cover"><div class="nb-k">Carnet de voyage</div><h1 class="rd-title"></h1><div class="nb-stamp">' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) + '</div></div>';
        $('.rd-title', el).textContent = doc.title || 'Sans titre';
      } else if (c) {
        const p = document.createElement('div');
        p.className = 'prose';
        p.innerHTML = c;
        hydrate(p, doc);
        el.append(p);
        scrollHint(p);
        if (k % 3 === 2) { const s = document.createElement('div'); s.className = 'nb-stamp small'; s.textContent = stamps[k % stamps.length]; s.style.setProperty('--r', ((k * 37) % 30 - 15) + 'deg'); el.append(s); }
      }
      const n = document.createElement('div');
      n.className = 'nb-num';
      n.textContent = k ? k : '';
      el.append(n);
    };
    const spreads = pages.length / 2;
    let s = 0, busy = false;
    const paint = () => { fill(L, s * 2); fill(Rt, s * 2 + 1); $('.rd-count', stage).textContent = `${s + 1} / ${spreads}`; $('.rd-prev', stage).disabled = s === 0; $('.rd-next', stage).disabled = s === spreads - 1; readerEnd(s === spreads - 1); };
    const go = d => {
      const t = s + d;
      if (busy || t < 0 || t >= spreads) return;
      busy = true;
      sound.brush();
      setTimeout(() => sound.brush(), 380);
      if (d > 0) {
        fill(front, s * 2 + 1); fill(back, t * 2);
        fill(Rt, t * 2 + 1);
        turn.className = 'nb-turn fwd';
      } else {
        fill(front, t * 2 + 1); fill(back, s * 2);
        fill(L, t * 2);
        turn.className = 'nb-turn bwd';
      }
      void turn.offsetWidth;
      turn.classList.add('go');
      setTimeout(() => { s = t; turn.className = 'nb-turn'; busy = false; paint(); }, 1050);
    };
    paint();
    $('.rd-prev', stage).onclick = e => { e.stopPropagation(); go(-1); };
    $('.rd-next', stage).onclick = e => { e.stopPropagation(); go(1); };
    book.onclick = e => { if (!isControl(e)) go(e.clientX < innerWidth / 2 ? -1 : 1); };
    reader.onKey = e => { if (NEXT_KEYS.includes(e.key)) { go(1); return true; } if (PREV_KEYS.includes(e.key)) { go(-1); return true; } };
  }

  /*
   * 22. Lettre : une enveloppe arrive. On la retourne, on brise le cachet, la lettre sort et se déplie
   * en trois, puis on la lit sur un papier qui garde la trace de ses deux plis.
   */
  function presentLetter(doc, stage) {
    const sc = sceneOf(doc, 'lettre');
    const env = LETTER_ENVS.find(e => e[0] === (sc.env || '')) || LETTER_ENVS[0];
    const seal = (LETTER_SEALS.find(e => e[0] === (sc.seal || '')) || LETTER_SEALS[0])[2];
    const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    stage.innerHTML = `<div class="lt-desk${sc.paper ? ' pa-' + sc.paper : ''}" style="--env:${env[2]};--env-ink:${env[3]};--seal:${seal}">
      <div class="lt-env">
        <div class="lt-face lt-front">
          <div class="al-stamp" style="--sc:${seal}"><span>Espaces</span><b>1,20</b></div>
          <div class="al-postmark"><span>${esc(today.split(' ').slice(1).join(' '))}</span></div>
          <div class="lt-address"><small>Pour vous</small><b></b><i></i><i></i></div>
        </div>
        <div class="lt-face lt-back">
          <div class="lt-inside"></div>
          <div class="lt-slip"></div>
          <svg class="lt-pocket" viewBox="0 0 100 62" preserveAspectRatio="none"><path class="s" d="M0 0L50 34L0 62Z"/><path class="s r" d="M100 0L50 34L100 62Z"/><path class="b" d="M0 62L50 27L100 62Z"/></svg>
          <div class="lt-flap"><svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M0 0H100L50 40Z"/></svg></div>
          <button class="lt-seal" aria-label="Briser le cachet"><i class="l"></i><i class="r"></i><span>${ic('rosette')}</span></button>
        </div>
      </div>
      <div class="lt-fold"><div class="lt-p mid"><i class="f"></i></div><div class="lt-p top"><i class="f"></i><i class="b"></i></div><div class="lt-p bot"><i class="f"></i><i class="b"></i></div></div>
      <div class="lt-sheet"><div class="lt-in"><div class="lt-head"><h1 class="rd-title"></h1><span class="lt-date">${esc(today)}</span></div><div class="prose"></div><div class="lt-end">${ic('rosette')}</div></div></div>
    </div>`;
    const desk = $('.lt-desk', stage), envEl = $('.lt-env', stage), sheet = $('.lt-sheet', stage), fold = $('.lt-fold', stage), slip = $('.lt-slip', stage);
    // la lettre se lit toujours sur un papier clair : la nuit ne change que la table autour
    if ($('#reader').classList.contains('night')) { desk.classList.add('dark'); $('#reader').classList.remove('night'); }
    $('.lt-address b', stage).textContent = doc.title || 'Sans titre';
    $('.rd-title', sheet).textContent = doc.title || 'Sans titre';
    const prose = $('.prose', sheet);
    prose.innerHTML = doc.html;
    for (const a of $$('a:not([data-goto])', prose)) { a.target = '_blank'; a.rel = 'noopener'; }
    for (const el of $$('[contenteditable]', prose)) el.removeAttribute('contenteditable');
    hydrate(prose, doc);

    // chaque pan de la lettre pliée porte son tiers de la vraie page : le texte et les blocs se déplient avec le papier
    const inner = $('.lt-in', sheet);
    const slice = (face, k, mirror) => {
      const c = inner.cloneNode(true);
      c.classList.add('lt-slice');
      c.style.setProperty('--k', k);
      if (mirror) c.classList.add('ghost');
      face.append(c);
    };
    slice($('.lt-p.top .f', fold), 0);
    slice($('.lt-p.mid .f', fold), 1);
    slice($('.lt-p.bot .f', fold), 2);
    // au dos des pans, l'écriture transparaît à peine, à l'envers, comme sur un vrai papier
    slice($('.lt-p.top .b', fold), 0, true);
    slice($('.lt-p.bot .b', fold), 2, true);

    // les étapes : 0 enveloppe de face, 1 retournée (cachet), 2 ouverture et dépliage, 3 lecture
    let stepN = 0, busy = false;
    const hints = ['Cliquez pour retourner l’enveloppe', 'Brisez le cachet pour ouvrir', '', ''];
    const paint = () => { $('#rdHint').textContent = hints[stepN]; desk.dataset.step = stepN; };
    const later = (f, ms) => { const t = setTimeout(f, ms); reader.cleanup.push(() => clearTimeout(t)); };
    // dans l'enveloppe, la lettre a déjà la forme de la lettre pliée : rien ne saute quand elle en sort
    const fitSlip = () => {
      const w = slip.offsetWidth, h = w * fold.offsetHeight / fold.offsetWidth, eh = envEl.offsetHeight;
      slip.style.height = h + 'px';
      slip.style.top = (eh * .9 - h) + 'px';
      // assez haut pour sortir aux trois quarts
      slip.style.setProperty('--rise', -(eh * .9 - h + h * .78) + 'px');
    };
    fitSlip();
    // la lettre quitte l'enveloppe là où elle est, se soulève vers le lecteur en suivant une courbe, et se pose au milieu
    const lift = () => {
      const a = slip.getBoundingClientRect(), b = fold.getBoundingClientRect();
      const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2), k = a.width / b.width;
      desk.classList.add('folded');
      if (fold.animate) fold.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${k}) rotate(-2.5deg)` },
        { transform: `translate(${dx * .35}px, ${dy * .5 - 40}px) scale(${(k + 1) / 2 * 1.06}) rotate(1.5deg)`, offset: .55 },
        { transform: 'none' }
      ], { duration: 1400, easing: 'cubic-bezier(.33, .1, .2, 1)' });
    };
    function next() {
      if (busy || stepN >= 2) return;
      if (stepN === 0) { stepN = 1; envEl.classList.add('flipped'); sound.brush(); paint(); return; }
      busy = true;
      stepN = 2;
      paint();
      desk.classList.add('broken');
      sound.drop();
      later(() => { desk.classList.add('opened'); sound.woosh(.7, 1); }, 450);
      later(() => { desk.classList.add('out'); sound.brush(); }, 1200);
      later(() => { lift(); desk.classList.add('away'); sound.woosh(.5, 1); }, 2500);
      later(() => { fold.classList.add('open-top'); sound.brush(); }, 4000);
      later(() => { fold.classList.add('open-bot'); sound.brush(); }, 4800);
      // dépliée, la lettre devient la page qu'on lit : même mise en page, au pixel près, puis elle s'allonge
      later(() => {
        desk.classList.add('reading');
        scrollHint(sheet);
        stepN = 3; busy = false; paint(); contrastSoon();
      }, 5800);
    }
    paint();
    stage.onclick = e => { if (stepN < 2 && !rdControl(e, ', .lt-sheet')) next(); };
    $('.lt-seal', stage).onclick = e => { e.stopPropagation(); if (stepN < 2) next(); };
    reader.onKey = e => {
      if (stepN < 2 && NEXT_KEYS.includes(e.key)) { next(); return true; }
      if (stepN === 3 && (NEXT_KEYS.includes(e.key) || PREV_KEYS.includes(e.key))) {
        sheet.scrollBy({ top: (NEXT_KEYS.includes(e.key) ? 1 : -1) * sheet.clientHeight * .8, behavior: 'smooth' });
        return true;
      }
    };
  }

  // 14. Mémoire qui s'efface : ce qui est déjà lu se brouille, seul le présent reste net
  function presentMemory(doc, stage) {
    const page = readerPage(doc);
    stage.append(page);
    const items = [$('.rd-title', page), ...$('.prose', page).children];
    let raf = 0;
    const upd = () => {
      raf = 0;
      const mid = innerHeight * .42;
      for (const el of items) {
        const r = el.getBoundingClientRect(), c = (r.top + r.bottom) / 2, d = (mid - c) / innerHeight;
        const past = Math.max(0, d - .1), fut = Math.max(0, -d - .3);
        el.style.filter = past ? `blur(${Math.min(8, past * 16).toFixed(1)}px) grayscale(${Math.min(1, past * 2.5).toFixed(2)})` : fut ? `blur(${Math.min(2, fut * 5).toFixed(1)}px)` : 'none';
        el.style.opacity = (past ? Math.max(.1, 1 - past * 1.8) : fut ? Math.max(.35, 1 - fut * 1.4) : 1).toFixed(2);
      }
    };
    page.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(upd); });
    for (const el of items) el.style.transition = 'filter .6s ease, opacity .6s ease';
    upd();
    $('#rdHint').textContent = 'Faites défiler';
    page.addEventListener('scroll', () => { $('#rdHint').textContent = ''; }, { once: true });
  }

  // 16. Planète : les passages sont posés sur une petite planète qu'on fait tourner
  function presentPlanet(doc, stage) {
    const units = [titleUnit(doc), ...passages(doc)];
    const n = units.length, RAD = Math.PI / 180, P = 1400;
    const Rad = Math.round(Math.min(innerHeight * .23, 210));
    const [tint] = colorOf(doc);
    const set = sceneOf(doc, 'planete'), surface = ['ocean', 'lune'].includes(set.surface) ? set.surface : 'grille';
    stage.innerHTML = `<div class="pl-scene ps-${surface}" style="--R:${Rad}px;--tint:${tint}">${surface === 'grille' ? '<div class="pl-sphere"></div>' : '<canvas class="pl-gl"></canvas>'}<div class="pl-globe"></div><div class="pl-pins"></div></div><div class="pl-panel"></div><div class="rd-progress"><i></i></div>`;
    const globe = $('.pl-globe', stage), pins = $('.pl-pins', stage), panel = $('.pl-panel', stage);
    // la lumière vient d'en haut à gauche ; sur la Lune, elle rase davantage pour creuser les cratères
    const L = (v => { const k = Math.hypot(...v); return v.map(c => c / k); })(surface === 'lune' ? [-.82, -.36, .45] : [-.55, -.5, .67]);
    let gl = null;
    if (surface === 'grille') {
      for (let k = 0; k < 6; k++) { const r = document.createElement('div'); r.className = 'pl-ring'; r.style.transform = `rotateY(${k * 30}deg)`; globe.append(r); }
      for (const lat of [-60, -30, 0, 30, 60]) { const r = document.createElement('div'); r.className = 'pl-ring'; r.style.transform = `rotateX(90deg) translateZ(${(Rad * Math.sin(lat * RAD)).toFixed(1)}px) scale(${Math.cos(lat * RAD).toFixed(3)})`; globe.append(r); }
    } else {
      const cv = $('.pl-gl', stage), S = Math.ceil(Rad * 2.7), dpr = Math.min(1.5, window.devicePixelRatio || 1);
      cv.width = cv.height = Math.round(S * dpr);
      cv.style.cssText = `width:${S}px;height:${S}px;left:${-S / 2}px;top:${-S / 2}px`;
      gl = glQuad(cv, PLANET_FRAG, { alpha: true });
      if (gl) {
        gl.set('uRes', [cv.width, cv.height]); gl.set('uDpr', dpr); gl.set('uR', Rad); gl.set('uP', P);
        gl.set('uKind', surface === 'lune' ? 1 : 0); gl.set('uSeed', seedOf(doc.id)); gl.set('uL', L);
        reader.cleanup.push(() => gl.lose());
      } else cv.replaceWith(Object.assign(document.createElement('div'), { className: 'pl-sphere' }));
    }
    // positions réparties sur la sphère (spirale de Fibonacci)
    const pos = units.map((_, k) => {
      const y = n === 1 ? 0 : 1 - (k / (n - 1)) * 2, lat = Math.asin(y * .8) * 180 / Math.PI, lon = (k * 137.5) % 360;
      return { lat, lon };
    });
    const keys = units.map((u, k) => (k ? u.dataset.key : 'title'));
    const sc = Rad / 120;
    const marks = pos.map((p, k) => {
      const kind = [sceneItem(doc, 'planete', keys[k]).mark, set.mark].find(v => v && v in PLANET_MARKS) || 'point';
      const frame = M3.mul(M3.ry(p.lon * RAD), M3.rx(p.lat * RAD));
      let obj = null, faces = [];
      // l'objet se tient debout sur le sol : son repère est celui du lieu, redressé d'un quart de tour
      if (PLANET_MARKS[kind]) {
        obj = document.createElement('div');
        obj.className = 'pl-obj';
        obj.style.transform = `rotateY(${p.lon}deg) rotateX(${p.lat}deg) translateZ(${Rad}px) rotateX(-90deg) scale(${sc.toFixed(3)})`;
        obj.innerHTML = PLANET_MARKS[kind];
        globe.append(obj);
        faces = $$('[data-n]', obj).map(el => { const v = el.dataset.n.split(',').map(Number); return { el, n: v.slice(0, 3), two: v[3] === 2 }; });
      }
      // la pastille, à plat sur l'écran, suit le lieu : c'est elle qu'on touche, et elle porte le numéro
      const pin = document.createElement('button');
      pin.className = 'pl-pin pk-' + kind;
      pin.innerHTML = `${kind === 'point' ? '<b></b>' : ''}<span>${k === 0 ? ic('dot') : k}</span>`;
      if (kind !== 'point') pin.style.setProperty('--oh', (34 * sc).toFixed(1) + 'px');
      pin.onclick = e => { e.stopPropagation(); to(k); };
      pins.append(pin);
      return { obj, faces, pin, frame, up: M3.mul(frame, M3.rx(-90 * RAD)), normal: M3.app(frame, [0, 0, 1]), lift: (kind === 'point' ? 3 : 16) * sc };
    });

    let rx = 0, ry = 0, tx = 0, ty = 0, raf = 0, drag = null, touched = performance.now(), drawn = '', lastDraw = 0, frontMark = -1;
    // en rotation automatique, la planète reprend doucement sa course quand on la laisse un moment
    const spin = set.spin === 'auto';
    const smooth = v => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); };
    const loop = now => {
      raf = requestAnimationFrame(loop);
      if (spin && !drag && now - touched > 5000) ty -= .07;
      if (!drag) { rx += (tx - rx) * .06; ry += (ty - ry) * .06; }
      globe.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      const M = M3.mul(M3.rx(rx * RAD), M3.ry(ry * RAD));
      // la surface n'est repeinte que si elle a bougé (ou, lentement, pour faire dériver les nuages)
      const key = rx.toFixed(2) + ',' + ry.toFixed(2);
      if (gl && (key !== drawn || (surface === 'ocean' && now - lastDraw > 90))) {
        gl.set('uM', M3.gl(M)); gl.set('uTime', now / 1000); gl.draw();
        drawn = key; lastDraw = now;
      }
      let front = -1, best = .9;
      marks.forEach((m, j) => { const z = M3.app(M, m.normal)[2]; if (z > best) { best = z; front = j; } });
      if (drag && front >= 0 && front !== frontMark) haptic();
      frontMark = front;
      for (const m of marks) {
        const nz = M3.app(M, m.normal)[2], vis = smooth((nz - .04) / .2);
        const v = M3.app(M, m.normal.map(c => c * (Rad + m.lift))), s = P / (P - v[2]);
        m.pin.style.transform = `translate(${(v[0] * s).toFixed(1)}px, ${(v[1] * s).toFixed(1)}px)`;
        m.pin.style.opacity = vis.toFixed(3);
        m.pin.style.visibility = vis < .02 ? 'hidden' : 'visible';
        if (!m.obj) continue;
        m.obj.style.setProperty('--vis', vis.toFixed(3));
        m.obj.style.visibility = vis < .02 ? 'hidden' : 'visible';
        if (vis < .02) continue;
        // chaque face prend la lumière selon son orientation du moment ; du côté de la nuit, l'objet s'éteint avec le sol
        const B = M3.mul(M, m.up), nv = M3.app(M, m.normal);
        const day = smooth((nv[0] * L[0] + nv[1] * L[1] + nv[2] * L[2] + .1) / .4);
        for (const f of m.faces) {
          const fn = M3.app(B, f.n), d = fn[0] * L[0] + fn[1] * L[1] + fn[2] * L[2];
          f.el.style.setProperty('--dk', Math.min(.86, 1 - (.58 + .42 * Math.max(0, f.two ? Math.abs(d) : d)) * (.22 + .78 * day)).toFixed(3));
        }
      }
    };
    raf = requestAnimationFrame(loop);
    let cur = -1;
    const show = k => {
      cur = k;
      touched = performance.now();
      const p = pos[k];
      // tourner la planète pour amener ce lieu vers le haut du globe, par le plus court chemin :
      // l'objet qui s'y dresse se découpe alors sur le ciel, au lieu d'être vu par-dessus
      let y = -p.lon;
      while (y - ry > 180) y -= 360;
      while (y - ry < -180) y += 360;
      ty = y; tx = -p.lat + 48;
      marks.forEach((m, j) => m.pin.classList.toggle('on', j === k));
      panel.classList.remove('in');
      setTimeout(() => { panel.innerHTML = ''; panel.append(units[k]); panel.classList.remove('rd-scrolly'); units[k].classList.remove('rd-scrolly'); scrollHint(units[k]); panel.classList.add('in'); }, 350);
      sound.woosh(.9, 1);
      progress(stage, k, n);
    };
    const to = k => { k = (k + n) % n; if (k !== cur) show(k); };
    show(0);
    stage.onpointerdown = e => { if (e.target.closest('.pl-panel, .pl-pin, a, button')) return; drag = { x: e.clientX, y: e.clientY, rx, ry }; touched = performance.now(); };
    stage.onpointermove = e => { if (!drag) return; ry = drag.ry + (e.clientX - drag.x) * .35; rx = drag.rx - (e.clientY - drag.y) * .25; tx = rx; ty = ry; };
    stage.onpointerup = () => { if (drag) touched = performance.now(); drag = null; };
    reader.onKey = e => { if (NEXT_KEYS.includes(e.key)) { to(cur + 1); return true; } if (PREV_KEYS.includes(e.key)) { to(cur - 1); return true; } };
    $('#rdHint').textContent = 'Touchez un lieu';
    reader.cleanup.push(() => cancelAnimationFrame(raf));
  }

  // 20. Apesanteur : les phrases dérivent ; le lecteur les attrape une à une pour les lire
  function presentFloat(doc, stage) {
    const split = t => (t.replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["»”’)\]]*|$)/g) || []).map(s => s.trim()).filter(Boolean);
    const bits = [];
    for (const b of pageBlocks(doc)) {
      if (b.tagName === 'HR' || b.matches('[data-ix], details')) continue;
      for (const x of $$('.ix-blank', b)) x.textContent = '______';
      const img = b.tagName === 'IMG' ? b : b.querySelector('img');
      if (img) bits.push({ img: img.getAttribute('src') });
      const parts = /^(UL|OL)$/.test(b.tagName) ? Array.from(b.children).map(li => li.textContent) : [b.textContent];
      for (const p of parts) for (const s of split(p)) bits.push({ text: s, head: /^H[1-3]$/.test(b.tagName) });
    }
    stage.innerHTML = '<div class="fl-space"></div><div class="fl-count"></div>';
    const space = $('.fl-space', stage), count = $('.fl-count', stage);
    const W = innerWidth, H = innerHeight, R = (a, b) => a + Math.random() * (b - a);
    const title = document.createElement('div');
    title.className = 'fl-title';
    title.textContent = doc.title || 'Sans titre';
    space.append(title);
    // pas plus de phrases à la fois que l'écran n'en laisse lire : les suivantes attendent leur tour, dans l'ordre du texte
    const room = Math.max(6, Math.min(14, Math.round(W * H / 75000)));
    const items = bits.map((b, k) => {
      const el = document.createElement('div');
      el.className = 'fl-item' + (b.head ? ' head' : '') + (b.img ? ' pic' : '') + (k < room ? '' : ' waiting');
      if (b.img) { const im = document.createElement('img'); im.src = b.img; el.append(im); } else el.textContent = b.text;
      space.append(el);
      return { el, x: R(40, W - 320), y: R(80, H - 120), vx: R(-18, 18), vy: R(-12, 12), r: R(-12, 12), vr: R(-4, 4), held: false, read: false, out: k >= room };
    });
    // une phrase lue s'éloigne ; la suivante du texte entre à sa place
    const nextIn = () => {
      const it = items.find(i => i.out && !i.read && !i.gone);
      if (!it) return;
      it.out = false;
      it.el.classList.remove('waiting');
      it.el.classList.add('entering');
      setTimeout(() => it.el.classList.remove('entering'), 900);
    };
    let held = null, raf = 0, last = performance.now();
    const paintCount = () => { count.textContent = `${items.filter(i => i.read).length} / ${items.length} attrapées`; };
    const loop = now => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      for (const it of items) {
        if (it.held || it.out) continue;
        it.x += it.vx * dt; it.y += it.vy * dt; it.r += it.vr * dt;
        const w = it.el.offsetWidth, h = it.el.offsetHeight;
        if (it.x < 10 || it.x + w > W - 10) { it.vx *= -1; it.x = Math.max(10, Math.min(W - 10 - w, it.x)); }
        if (it.y < 60 || it.y + h > H - 40) { it.vy *= -1; it.y = Math.max(60, Math.min(H - 40 - h, it.y)); }
        it.el.style.transform = `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px) rotate(${it.r.toFixed(1)}deg)`;
      }
    };
    raf = requestAnimationFrame(loop);
    const release = () => {
      if (!held) return;
      const it = held;
      held = null;
      space.classList.remove('dim');
      it.el.classList.remove('held');
      it.read = true;
      it.el.classList.add('read');
      it.x = W / 2 - it.el.offsetWidth / 2; it.y = H / 2 - it.el.offsetHeight / 2;
      it.vx = R(-24, 24); it.vy = R(-18, 18); it.vr = R(-5, 5);
      setTimeout(() => { it.el.style.transition = ''; it.held = false; }, 700);
      it.el.style.transition = 'transform .7s ease';
      if (items.some(i => i.out && !i.read && !i.gone)) {
        setTimeout(() => { it.el.classList.add('gone'); it.gone = true; nextIn(); }, 900);
        setTimeout(() => { it.out = true; it.el.classList.add('waiting'); }, 2100);
      }
      paintCount();
      sound.woosh(.6, it.vx > 0 ? 1 : -1);
    };
    const catchIt = it => {
      if (held) release();
      held = it;
      it.held = true;
      space.classList.add('dim');
      it.el.classList.add('held');
      it.el.style.transition = 'transform .9s cubic-bezier(.2,.75,.2,1)';
      const w = it.el.offsetWidth, h = it.el.offsetHeight;
      it.el.style.transform = `translate(${(W / 2 - w / 2).toFixed(1)}px, ${(H / 2 - h / 2).toFixed(1)}px) rotate(0deg) scale(1.7)`;
      sound.chime(items.indexOf(it));
    };
    space.onclick = e => {
      const el = e.target.closest('.fl-item');
      if (el) { const it = items.find(i => i.el === el); if (it === held) release(); else catchIt(it); }
      else release();
    };
    reader.onKey = e => {
      if ([' ', 'Enter', 'ArrowRight'].includes(e.key)) { const nxt = items.find(i => !i.read && !i.out && i !== held) || items.find(i => !i.out && !i.gone && i !== held); if (nxt) catchIt(nxt); return true; }
      if (e.key === 'ArrowLeft') { release(); return true; }
    };
    paintCount();
    $('#rdHint').textContent = 'Attrapez une phrase pour la lire';
    reader.cleanup.push(() => cancelAnimationFrame(raf));
  }

  /* ───────────── Interrupteur Éditeur / Lecteur ───────────── */

  function setReaderMode(on) {
    readerMode = on;
    document.body.classList.toggle('reader-mode', on);
    for (const b of $$('#modeSwitch button')) b.classList.toggle('on', (b.dataset.mode === 'read') === on);
    if (view === 'space') { renderRing(); renderChrome(); }
    sound.pop();
    toast(on ? 'Mode lecteur : l’espace tel que le verront vos lecteurs' : 'Mode éditeur');
  }

  function bindModeSwitch() {
    const sw = $('#modeSwitch');
    if (READONLY) { sw.hidden = true; return; }
    sw.addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (b) setReaderMode(b.dataset.mode === 'read');
    });
  }

  /* ───────────── Divers ───────────── */

  // Grain de pellicule : à chaque image, un tirage, une position et une orientation au hasard.
  let grainTiles = [];
  function startGrain() {
    const el = $('.grain');
    let last = 0;
    const flips = ['', 'scaleX(-1)', 'scaleY(-1)', 'scale(-1, -1)'];
    const step = now => {
      requestAnimationFrame(step);
      if (document.hidden || now - last < 70 + Math.random() * 40) return;
      last = now;
      el.style.backgroundImage = grainTiles[Math.floor(Math.random() * grainTiles.length)];
      el.style.backgroundPosition = `${Math.floor(Math.random() * 256)}px ${Math.floor(Math.random() * 256)}px`;
      el.style.transform = flips[Math.floor(Math.random() * flips.length)];
    };
    requestAnimationFrame(step);
  }

  /*
   * La lumière du jour : la couleur de la lumière qui tombe sur les espaces, et celle de l'ombre qui monte du bas,
   * suivent l'heure. Matin rosé, midi blanc, fin d'après-midi dorée, crépuscule mauve, nuit bleutée.
   */
  const DAYLIGHT = [
    // heure, lumière, ombre, force de l'ombre
    [0, [200, 208, 255], [18, 22, 70], 2.4],
    [5, [204, 210, 255], [18, 22, 70], 2.2],
    [7, [255, 230, 222], [70, 30, 44], 1.6],
    [9.5, [255, 247, 236], [40, 26, 10], 1.15],
    [12.5, [255, 255, 255], [0, 0, 0], 1],
    [16, [255, 249, 236], [30, 18, 0], 1.15],
    [18.5, [255, 224, 182], [80, 40, 0], 1.8],
    [20, [246, 208, 226], [56, 20, 64], 2],
    [21.5, [206, 212, 255], [18, 22, 70], 2.3],
    [24, [200, 208, 255], [18, 22, 70], 2.4]
  ];
  function daylight() {
    const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
    let k = 0;
    while (DAYLIGHT[k + 1][0] <= h) k++;
    const [h0, l0, s0, f0] = DAYLIGHT[k], [h1, l1, s1, f1] = DAYLIGHT[k + 1];
    // un fondu doux d'une heure de référence à la suivante
    const t = (h - h0) / (h1 - h0), e = t * t * (3 - 2 * t);
    const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * e)).join(' ');
    const root = document.documentElement.style;
    root.setProperty('--sun-rgb', mix(l0, l1));
    root.setProperty('--shade-rgb', mix(s0, s1));
    root.setProperty('--shade-k', (f0 + (f1 - f0) * e).toFixed(2));
  }

  /*
   * Le papier de l'interface : des nuages de pâte à peine plus denses ou plus clairs, puis des fibres,
   * courtes et légèrement courbes, tirées au hasard à chaque lancement. Tout se raccorde sur les bords (la tuile se répète).
   */
  // k : l'intensité (1 pour les fenêtres, moins pour la page où l'on écrit)
  function paperTexture(S = 512, k = 1) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), R = (a, b) => a + Math.random() * (b - a);
    // chaque tracé est répété de l'autre côté du bord qu'il dépasse
    const wrap = draw => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { g.save(); g.translate(dx, dy); draw(); g.restore(); } };
    for (let i = 0; i < 90; i++) {
      const x = R(0, S), y = R(0, S), r = R(30, 120), dark = Math.random() < .55;
      wrap(() => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        // le dégradé finit dans sa propre couleur, transparente : sinon il passe par un gris qui fait des halos
        const tint = dark ? '80, 60, 70' : '255, 255, 255';
        gr.addColorStop(0, `rgba(${tint}, ${(dark ? .022 : .35) * k})`);
        gr.addColorStop(1, `rgba(${tint}, 0)`);
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      });
    }
    g.lineCap = 'round';
    for (let i = 0, n = Math.round(1400 * Math.min(1, k * 1.3)); i < n; i++) {
      const x = R(0, S), y = R(0, S), a = R(0, Math.PI * 2), len = R(4, 26), bend = R(-6, 6), dark = Math.random() < .7;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      const mx = (x + x2) / 2 - Math.sin(a) * bend, my = (y + y2) / 2 + Math.cos(a) * bend;
      g.strokeStyle = dark ? `rgba(70, 50, 60, ${(R(.035, .075) * k).toFixed(3)})` : `rgba(255, 255, 255, ${(R(.3, .6) * k).toFixed(2)})`;
      g.lineWidth = R(.35, .9);
      wrap(() => { g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(mx, my, x2, y2); g.stroke(); });
    }
    return `url(${c.toDataURL()})`;
  }

  // un curseur se remplit jusqu'à sa poignée : sa position, en pourcentage, passe au CSS
  function paintRange(el) {
    const min = +el.min || 0, max = el.max === '' ? 100 : +el.max, p = max > min ? (el.value - min) / (max - min) : 0;
    // la poignée (18 px) ne va pas jusqu'aux bords : le remplissage s'arrête en son milieu
    el.style.setProperty('--p', `calc(${(p * 100).toFixed(2)}% + ${(9 - p * 18).toFixed(1)}px)`);
  }
  function watchRanges() {
    document.addEventListener('input', e => {
      const el = e.target;
      if (el.type !== 'range') return;
      paintRange(el);
      const min = +el.min || 0, max = el.max === '' ? 100 : +el.max, b = Math.round((el.value - min) / (max - min) * 10);
      if (b !== el.hapticBucket) { if (el.hapticBucket != null) haptic(b === 0 || b === 10 || (min < 0 && +el.value === 0) ? 'step' : 'tick'); el.hapticBucket = b; }
    }, true);
    // au survol, un effleurement : seulement en arrivant sur un nouvel élément qu'on peut actionner, jamais pendant
    // un glisser, et pas quand le pointeur file à travers l'écran (on ne sentirait qu'un grésillement)
    const HOVERABLE = 'button:not(:disabled), a[href], select, input[type="range"], [role="button"], .card, .pp-tile, .mt-row, .mt-card, .sc-card, .sc-block, .cm-item, .vs-item, .sr, .pl-pin';
    let hovered = null, lastMove = { x: 0, y: 0, t: 0 }, speed = 0;
    document.addEventListener('pointermove', e => {
      const dt = e.timeStamp - lastMove.t;
      if (dt > 0) speed = Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / dt;
      lastMove = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    }, { passive: true });
    document.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const el = e.target.closest && e.target.closest(HOVERABLE);
      if (el === hovered) return;
      hovered = el;
      if (el && speed < 1.6 && performance.now() - (haptic.hover || 0) > 90) { haptic.hover = performance.now(); haptic('hover'); }
    }, true);
    // interrupteurs et choix à segments : la bascule se sent sous le doigt
    document.addEventListener('change', e => { if (e.target.closest('.sw')) haptic('step'); }, true);
    document.addEventListener('click', e => {
      if (e.target.closest('.pp-switch')) haptic('step');
      else if (e.target.closest('.pp-seg button, .mode-switch button, .pp-tile')) haptic();
    }, true);
    const paintIn = n => { if (n.nodeType !== 1) return; if (n.type === 'range') paintRange(n); else if (n.firstElementChild) for (const r of n.querySelectorAll('input[type="range"]')) paintRange(r); };
    new MutationObserver(list => { for (const m of list) m.addedNodes.forEach(paintIn); }).observe(document.body, { childList: true, subtree: true });
    for (const r of $$('input[type="range"]')) paintRange(r);
  }

  // Textures générées une fois : grain fin, pour le fond et les cartes.
  function makeTextures() {
    const root = document.documentElement.style;
    const grain = (alpha, size = 160) => {
      const s = size;
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      const img = g.createImageData(s, s);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255 | 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = alpha;
      }
      g.putImageData(img, 0, 0);
      return `url(${c.toDataURL()})`;
    };
    // plusieurs tirages de grain plus grands, pour que rien ne se répète à l'œil
    grainTiles = [0, 1, 2, 3, 4, 5].map(() => grain(46, 256));
    root.setProperty('--grain', grainTiles[0]);
    root.setProperty('--grain-soft', grain(16));
    root.setProperty('--paper-tex', paperTexture());
    root.setProperty('--paper-tex-soft', paperTexture(512, .42));

  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function bindKeys() {
    document.addEventListener('keydown', e => {
      if (!$('#ask').hidden || !$('#search').hidden || !$('#ixModal').hidden) return;
      const typing = e.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
      if (view === 'editor' && e.key === 'Escape') {
        if (!$('#pagePop').hidden) { $('#pagePop').hidden = true; return; }
        if (!$('#scene').hidden) { closeScene(); return; }
        if (!$('#versions').hidden) { closeVersions(); return; }
        if (!$('#linkPop').hidden || !$('#imgTools').hidden) { hideTools(); return; }
        leaveEditor();
        return;
      }
      if (typing || view !== 'space') return;
      touch();
      if (e.key === 'ArrowRight') { ring.target = Math.round(ring.target / ring.step - 1) * ring.step; e.preventDefault(); }
      if (e.key === 'ArrowLeft') { ring.target = Math.round(ring.target / ring.step + 1) * ring.step; e.preventDefault(); }
      if (e.key === 'ArrowUp') { switchSibling(-1); e.preventDefault(); }
      if (e.key === 'ArrowDown') { switchSibling(1); e.preventDefault(); }
      if (e.key === 'Escape' && !READONLY) goUp();
      if (e.key === 'Escape' && READONLY && parentOf(space())) goUp();
      if (e.key === 'Enter') { const i = focusIndex(); if (i >= 0) openItem(ring.items[i]); }
      if (!asReader() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); createAndOpen(); }
    });
  }


  /* ───────────── Fichier .espace : partager un espace vers une autre app Espaces ───────────── */

  /*
   * Un .espace emporte l'espace choisi et ses sous-espaces, tels quels : textes, images, mises en scène,
   * versions. Il porte son numéro de format (schema), le plus ancien format capable de le lire (minSchema)
   * et la liste de ce qu'il utilise (présentations, atmosphères, blocs) : une app plus ancienne l'ouvre quand
   * même et dit ce qu'elle ne sait pas encore afficher ; une app plus récente le remet à niveau (migrate).
   */
  const ESPACE_MIN_SCHEMA = 1;
  const KNOWN_BLOCKS = ['callout', 'todo', 'ix-fold', 'ix-hide', 'ix-blank', 'ix-note', 'ix-goto', ...Object.keys(IX).map(k => 'ix-' + k)];

  function usesOf(spaces) {
    const presents = new Set(), weathers = new Set(), blocks = new Set();
    for (const s of spaces) for (const d of s.docs || []) {
      if (d.present) presents.add(d.present);
      if (d.weather) weathers.add(d.weather);
      for (const m of (d.html || '').matchAll(/data-ix="([a-z-]+)"/g)) blocks.add('ix-' + m[1]);
      for (const m of (d.html || '').matchAll(/class="(callout|todo|ix-fold|ix-hide|ix-blank|ix-note|ix-goto)\b/g)) blocks.add(m[1]);
    }
    return { presents: [...presents], weathers: [...weathers], blocks: [...blocks] };
  }

  async function exportEspaceFile() {
    const sp = space();
    if (!sp || READONLY) return;
    if (view === 'editor') commitEditor();
    const tree = [sp, ...descendants(sp)];
    const spaces = tree.map(s => Object.assign({}, s, s === sp ? { parent: null } : {}));
    const data = JSON.stringify({ format: 'espace', schema: SCHEMA, minSchema: ESPACE_MIN_SCHEMA, app: APP_VERSION, exportedAt: Date.now(), root: sp.id, uses: usesOf(spaces), spaces });
    const name = (sp.title || 'Espace').replace(/[/:\\]/g, '-');
    try {
      if (NATIVE) {
        const saved = await call('exportEspace', { name, data });
        if (saved) { toast('Prêt à partager : ' + saved); sound.saved(); }
        return;
      }
      // dans un navigateur : un simple téléchargement
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      a.download = name + '.espace';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      toast('Partage impossible : ' + (e.message || e));
    }
  }

  async function openEspaceFile() {
    if (READONLY) return;
    try {
      if (NATIVE) { const text = await call('openEspace'); if (text) importEspaceText(text); return; }
      const [f] = await browserPick('.espace,application/json', false);
      if (f) importEspaceText(await f.text());
    } catch (e) {
      toast('Ouverture impossible : ' + (e.message || e));
    }
  }

  function importEspaceText(text) {
    let f = null;
    try { f = JSON.parse(text); } catch (e) { /* illisible */ }
    if (!f || f.format !== 'espace' || !Array.isArray(f.spaces) || !f.spaces.length) return toast('Ce fichier n’est pas un espace lisible par Espaces');
    const newer = (f.schema || 0) > SCHEMA;
    f = migrate(f);
    // de nouveaux identifiants : rien ne se mélange avec la bibliothèque, même en ouvrant deux fois le même fichier
    const ids = new Map();
    for (const s of f.spaces) { ids.set(s.id, uid()); for (const d of s.docs || []) ids.set(d.id, uid()); }
    const sw = id => ids.get(id) || id;
    // les liens d'une carte à l'autre suivent leurs cartes
    const relink = html => (html || '').replace(/data-(goto|to)="([^"]*)"/g, (m, k, id) => `data-${k}="${esc(sw(id))}"`);
    const spaces = f.spaces.map(s => Object.assign({}, s, {
      id: sw(s.id),
      parent: s.parent && ids.has(s.parent) ? sw(s.parent) : null,
      docs: (s.docs || []).map(d => {
        const c = Object.assign({}, d, { id: sw(d.id), html: relink(d.html) });
        if (c.history && Array.isArray(c.history.list)) c.history = Object.assign({}, c.history, { list: c.history.list.map(v => Object.assign({}, v, { html: relink(v.html) })) });
        return c;
      })
    }));
    const root = spaces.find(s => s.id === sw(f.root)) || spaces.find(s => !s.parent) || spaces[0];
    root.parent = null;
    if (topSpaces().some(t => t.title === root.title)) root.title = (root.title || 'Espace') + ' (reçu)';
    state.spaces.push(...spaces);
    state.current = root.id;
    persist(true);
    // ce que cette version d'Espaces ne sait pas encore afficher : on le dit, la page s'affiche au plus simple
    const u = f.uses || usesOf(spaces);
    const missing = [
      ...(u.presents || []).filter(p => !PRESENTS.some(x => x.id === p)).map(p => 'la présentation « ' + p + ' »'),
      ...(u.weathers || []).filter(w => !WEATHERS.some(x => x.id === w)).map(w => 'l’atmosphère « ' + w + ' »'),
      ...(u.blocks || []).filter(b => !KNOWN_BLOCKS.includes(b)).map(b => 'le bloc « ' + b.replace(/^ix-/, '') + ' »')
    ];
    if (view === 'editor') closeEditor();
    if (!$('#reader').hidden) closeReader();
    enterSpace(root.id, { instant: true });
    sound.create();
    const n = spaces.reduce((k, s) => k + (s.docs || []).length, 0);
    let msg = `« ${root.title} » est ouvert : ${plural(n, 'texte')}${spaces.length > 1 ? ', ' + plural(spaces.length - 1, 'sous-espace') : ''}`;
    if (missing.length) msg += `. Créé avec une version plus récente d’Espaces : ${missing.join(', ')} s’afficheront après la mise à jour (le reste est intact).`;
    else if (newer) msg += '. Créé avec une version plus récente d’Espaces : mettez à jour l’app pour en profiter pleinement.';
    toast(msg);
  }

  // l'app macOS transmet un .espace ouvert d'un double-clic, ou choisi dans le menu Fichier
  let markReady;
  const appReady = new Promise(r => { markReady = r; });
  window.__openEspace = text => appReady.then(() => importEspaceText(text));
  window.__menu = cmd => appReady.then(() => { if (READONLY) return; if (cmd === 'open') openEspaceFile(); if (cmd === 'share') exportEspaceFile(); });

  /*
   * Dans un navigateur (Chrome, Edge… sur PC) : Espaces s'installe comme une app, avec son icône, et marche hors ligne.
   * L'entrée « Installer Espaces sur cet ordinateur… » du menu Fichier n'apparaît que quand le navigateur le permet.
   */
  let installPrompt = null;
  function bindInstall() {
    if (bridge || READONLY || !location.protocol.startsWith('http')) return;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.error(e));
    const item = $('#filePop [data-action="install"]');
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; item.hidden = false; });
    addEventListener('appinstalled', () => { installPrompt = null; item.hidden = true; toast('Espaces est installé : il est dans vos applications'); });
  }
  async function installApp() {
    if (!installPrompt) return toast('Pour installer : menu du navigateur › Installer Espaces (ou l’icône à droite de la barre d’adresse)');
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('#filePop [data-action="install"]').hidden = true;
  }

  async function boot() {
    document.body.classList.toggle('native', NATIVE);
    document.body.classList.toggle('readonly', READONLY);
    makeTextures();
    watchRanges();
    daylight();
    setInterval(daylight, 5 * 60 * 1000);
    startGrain();
    bindWelcome();
    bindSpace();
    bindEditor();
    bindSlash();
    bindBlocks();
    bindStructure();
    bindContextMenu();
    bindIconPop();
    bindPagePop();
    bindScene();
    bindVersions();
    bindModeSwitch();
    bindReader();
    bindSearch();
    bindHistory();
    bindSpell();
    bindInk();
    bindVoice();
    bindInstall();
    bindQuick();
    bindSound();
    bindKeys();
    state = await load();
    if (PHONE) { document.body.classList.add('phone'); ink.finger = true; ensureQuick(); }
    if (READONLY) document.title = space().title + ' — Espaces';
    route();
    requestAnimationFrame(frame);
    sound.unlock();
    if (READONLY) showEnter();
    bindEspaceFiles();
    markReady();
    startSync();
    bindPresence();
    bindA4();
  }

  // partager, ouvrir, ou déposer un .espace sur la fenêtre
  function bindEspaceFiles() {
    if (READONLY) return;
    addEventListener('dragover', e => { if (Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) e.preventDefault(); });
    addEventListener('drop', async e => {
      const f = Array.from(e.dataTransfer.files || []).find(x => /\.espace$/i.test(x.name));
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      importEspaceText(await f.text());
    }, true);
  }

  // Espace exporté : un écran d'entrée, dont le clic autorise aussi le son dans le navigateur.
  function showEnter() {
    const el = $('#enter');
    $('#enterTitle').textContent = space().title;
    el.hidden = false;
    $('#enterBtn').addEventListener('click', () => {
      sound.unlock();
      el.classList.add('gone');
      gust(1, 1);
      setTimeout(() => { el.hidden = true; }, 700);
    });
  }

  boot();
})();
