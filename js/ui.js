// DOM user interface: title screen, character creator, HUD, base menu, map, settings.

import {
  GAME_NAME, WEAPONS, WEAPON_IDS, MODS, MOD_IDS, ABILITIES, VAULT_UPGRADES, FACTIONS, LOOK_OPTIONS, LOOK_KEYS,
  GANG_COLORS, BIOME_LABEL, MAX_WEAPON_LVL, weaponMult, weaponUpgradePrice, TILE, randomLook,
} from './data.js';
import { W, H, T } from './world.js';
import { charSprite, armSprite, playerSpec, mk } from './sprites.js';
import { getVolume } from './audio.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => 'R$' + Math.floor(v).toLocaleString('pt-BR');

export function createUI(root, cb) {
  const U = { cb, state: null, world: null, open: null, logLines: [], iconCache: new Map(), lastUpdate: 0, regionShown: -2, banner: null };

  root.innerHTML = `
  <div id="title" class="screen">
    <div class="title-wrap">
      <h1 class="logo" data-text="${GAME_NAME}">${GAME_NAME}</h1>
      <div class="tagline">Guerra de território · Brazilian cyberpunk turf RPG</div>
      <div class="title-grid">
        <div class="panel creator">
          <div class="panel-title">YOUR CHARACTER</div>
          <div class="creator-body">
            <canvas id="preview" width="34" height="34"></canvas>
            <div class="look-rows"></div>
          </div>
          <label class="field">NAME <input id="name" maxlength="14" spellcheck="false" autocomplete="off"></label>
          <button class="btn small" id="randomize">RANDOMIZE</button>
        </div>
        <div class="panel play">
          <div class="panel-title">PLAY</div>
          <div id="continue-box" class="hidden">
            <button class="btn big" id="btn-continue">CONTINUE CAMPAIGN</button>
            <div class="save-info" id="save-info"></div>
          </div>
          <div class="host-box">
            <label class="field">GANG NAME <input id="gang" maxlength="18" spellcheck="false" autocomplete="off"></label>
            <div class="field">GANG COLOR <span id="gang-colors"></span></div>
            <button class="btn big" id="btn-host">HOST NEW GAME</button>
          </div>
          <div class="sep">— or join a friend —</div>
          <div class="join-box">
            <input id="code" maxlength="4" placeholder="CODE" spellcheck="false" autocomplete="off">
            <button class="btn big" id="btn-join">JOIN</button>
          </div>
          <div class="status" id="status"></div>
        </div>
      </div>
      <div class="controls-help">
        <b>WASD</b> move · <b>MOUSE</b> aim · <b>LMB / RMB</b> left / right arm · <b>Q E R F</b> body mods ·
        <b>B</b> base menu (at HQ) · <b>TAB</b> map · <b>ENTER</b> chat · <b>ESC</b> menu
      </div>
    </div>
  </div>

  <div id="hud" class="hidden">
    <div class="hud-tl panel slim">
      <div class="who"><span id="h-name"></span> <span class="lvl">LV <b id="h-lvl">1</b></span></div>
      <div class="bar hp"><div class="fill" id="h-hp"></div><div class="bar-shield" id="h-sh"></div><span id="h-hpt"></span></div>
      <div class="bar xp"><div class="fill" id="h-xp"></div><span id="h-xpt"></span></div>
      <div class="cash-row"><span class="cash" id="h-cash">R$0</span><span class="vault" title="Gang vault (compound income)">COFRE <b id="h-vault">R$0</b></span></div>
    </div>
    <div class="hud-tr">
      <div class="panel slim mm-wrap"><canvas id="minimap" width="150" height="150"></canvas><div class="mm-label" id="mm-label"></div></div>
      <div class="panel slim turf" id="turf"></div>
    </div>
    <div class="hud-top">
      <div id="banner" class="banner"></div>
      <div id="alerts"></div>
    </div>
    <div class="hud-bottom">
      <div class="hotbar" id="hotbar"></div>
      <div class="hint" id="hint"></div>
    </div>
    <div class="hud-bl">
      <div id="log"></div>
      <input id="chat" class="hidden" maxlength="80" placeholder="Say something... (Enter)" autocomplete="off">
    </div>
    <div class="hud-br" id="room"></div>
    <div id="death" class="hidden"><div class="death-title">VOCÊ CAIU</div><div id="death-sub"></div><div id="death-t"></div></div>
  </div>

  <div id="modal" class="hidden"><div class="modal-inner panel" id="modal-inner"></div></div>
  <div id="toast"></div>
  `;

  // ---------------------------------------------------------------- title / creator
  const prefs = cb.prefs;
  const look = prefs.look;
  $('#name').value = prefs.name;
  $('#gang').value = prefs.gangName;
  let gangColor = prefs.gangColor;
  const rows = $('.look-rows');
  const LABEL = { skin: 'SKIN', hair: 'HAIR', hairColor: 'HAIR COLOR', jacket: 'JACKET', pants: 'PANTS' };
  for (const k of LOOK_KEYS) {
    const r = document.createElement('div');
    r.className = 'look-row';
    r.innerHTML = `<button class="arrow" data-k="${k}" data-d="-1">◀</button><span class="look-name">${LABEL[k]}</span><span class="look-val" id="lv-${k}"></span><button class="arrow" data-k="${k}" data-d="1">▶</button>`;
    rows.appendChild(r);
  }
  rows.addEventListener('click', (e) => {
    const b = e.target.closest('.arrow');
    if (!b) return;
    const k = b.dataset.k, n = LOOK_OPTIONS[k].length;
    look[k] = (look[k] + Number(b.dataset.d) + n) % n;
    refreshLook();
    cb.sound('click');
  });
  $('#randomize').onclick = () => { Object.assign(look, randomLook()); refreshLook(); cb.sound('click'); };
  function refreshLook() {
    for (const k of LOOK_KEYS) {
      const el = $('#lv-' + k);
      const v = LOOK_OPTIONS[k][look[k]];
      el.innerHTML = v.startsWith('#') ? `<i class="swatch" style="background:${v}"></i>` : esc(v.toUpperCase());
    }
    cb.savePrefs();
  }
  refreshLook();
  const gc = $('#gang-colors');
  for (const c of GANG_COLORS) {
    const s = document.createElement('button');
    s.className = 'gswatch' + (c === gangColor ? ' on' : '');
    s.style.background = c;
    s.onclick = () => { gangColor = c; prefs.gangColor = c; gc.querySelectorAll('.gswatch').forEach((x) => x.classList.toggle('on', x === s)); cb.savePrefs(); };
    gc.appendChild(s);
  }
  // animated preview
  let pvDir = 0, pvT = 0;
  const pv = $('#preview');
  const pvc = pv.getContext('2d');
  pvc.imageSmoothingEnabled = false;
  U.tickPreview = (dt) => {
    if ($('#title').classList.contains('hidden')) return;
    pvT += dt;
    if (pvT > 1.2) { pvT = 0; pvDir = (pvDir + 1) % 4; }
    const spec = playerSpec(look, {}, gangColor);
    const frame = 1 + (Math.floor(pvT * 8) % 4);
    const s = charSprite(spec, [0, 2, 3, 1][pvDir], frame);
    pvc.clearRect(0, 0, 34, 34);
    pvc.drawImage(s, Math.round(17 - s.ax), Math.round(30 - s.ay));
    const arm = armSprite(pvDir === 1 ? 'fist' : 'pistol');
    const ang = [Math.PI / 2, 0, -Math.PI / 2, Math.PI][pvDir];
    pvc.save(); pvc.translate(17 + (pvDir === 0 ? -s.shX : pvDir === 2 ? s.shX : 0), 30 - s.shY); pvc.rotate(ang); if (Math.cos(ang) < -0.1) pvc.scale(1, -1);
    pvc.drawImage(arm, 0, -4); pvc.restore();
  };

  const readName = () => { const n = $('#name').value.trim() || 'Mano'; prefs.name = n; prefs.gangName = $('#gang').value.trim() || 'Bonde Neon'; cb.savePrefs(); return n; };
  $('#btn-host').onclick = () => { readName(); cb.onHost({ gangName: prefs.gangName, gangColor }); };
  $('#btn-continue').onclick = () => { readName(); cb.onContinue(); };
  $('#btn-join').onclick = () => { readName(); cb.onJoin($('#code').value); };
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('#name').addEventListener('input', readName);
  $('#gang').addEventListener('input', readName);

  U.showSave = (info) => {
    const box = $('#continue-box');
    if (!info) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const d = new Date(info.savedAt);
    $('#save-info').innerHTML = `${esc(info.gangName)} · turf ${info.owned}/${info.total} · ${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
  };
  U.setCode = (c) => { $('#code').value = c; };
  U.status = (text, err = false) => { const s = $('#status'); s.textContent = text; s.classList.toggle('err', err); };
  U.showTitle = () => { $('#title').classList.remove('hidden'); $('#hud').classList.add('hidden'); U.closeModal(); };
  U.showHUD = (world) => {
    U.world = world;
    $('#title').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    U.logLines = [];
    $('#log').innerHTML = '';
    U.regionShown = -2;
    buildMapLayers(world);
  };

  // ---------------------------------------------------------------- log / chat / toasts
  U.log = (text, cls = '') => {
    const el = document.createElement('div');
    el.className = 'line ' + cls;
    el.innerHTML = text;
    const log = $('#log');
    log.appendChild(el);
    while (log.children.length > 9) log.removeChild(log.firstChild);
    setTimeout(() => el.classList.add('old'), 9000);
  };
  U.toast = (text, cls = '') => {
    const t = $('#toast');
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.innerHTML = text;
    t.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
  };
  U.alert = (text, cls = 'raid', life = 5000) => {
    const a = $('#alerts');
    const el = document.createElement('div');
    el.className = 'alert ' + cls;
    el.innerHTML = text;
    a.appendChild(el);
    while (a.children.length > 3) a.removeChild(a.firstChild);
    setTimeout(() => el.classList.add('out'), life);
    setTimeout(() => el.remove(), life + 600);
  };
  const chat = $('#chat');
  U.openChat = () => { chat.classList.remove('hidden'); chat.value = ''; chat.focus(); cb.setTyping(true); };
  chat.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = chat.value.trim(); if (v) cb.onChat(v); closeChat(); e.preventDefault(); }
    if (e.key === 'Escape') { closeChat(); e.preventDefault(); }
    e.stopPropagation();
  });
  function closeChat() { chat.blur(); chat.classList.add('hidden'); cb.setTyping(false); }
  U.chatOpen = () => !chat.classList.contains('hidden');

  // ---------------------------------------------------------------- icons
  function weaponIcon(id) {
    let u = U.iconCache.get(id);
    if (u) return u;
    const c = mk(66, 30), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(armSprite(id), 0, 0, 22, 9, 0, 2, 66, 27);
    u = c.toDataURL();
    U.iconCache.set(id, u);
    return u;
  }
  const ABIL_ICON = { Q: '»', E: '+', R: '◌', F: '⬡' };

  // ---------------------------------------------------------------- HUD update
  U.update = (s, now) => {
    U.state = s;
    if (!s || !s.me) return;
    if (now - U.lastUpdate < 66) return;
    U.lastUpdate = now;
    const me = s.me;
    $('#h-name').textContent = s.myName;
    $('#h-lvl').textContent = me.lvl;
    $('#h-hp').style.width = (100 * me.hp / me.maxHp).toFixed(1) + '%';
    $('#h-hp').className = 'fill ' + (me.hp / me.maxHp > 0.6 ? 'ok' : me.hp / me.maxHp > 0.3 ? 'mid' : 'low');
    $('#h-sh').style.width = Math.min(100, 100 * me.sh / me.maxHp).toFixed(1) + '%';
    $('#h-hpt').textContent = `${me.hp} / ${me.maxHp}`;
    $('#h-xp').style.width = (100 * me.xp / me.xn).toFixed(1) + '%';
    $('#h-xpt').textContent = `XP ${me.xp} / ${me.xn}`;
    $('#h-cash').textContent = money(me.cash);
    $('#h-vault').textContent = money(s.vault);
    // hotbar
    const prof = s.prof;
    if (prof) {
      const eq = prof.equip;
      let html = '';
      for (const slot of ['L', 'R']) {
        const id = eq[slot];
        const lvl = prof.armory[id] || 1;
        html += `<div class="slot weapon"><img src="${weaponIcon(id)}"><span class="key">${slot === 'L' ? 'LMB' : 'RMB'}</span><span class="wname">${esc(WEAPONS[id].name)} <i>Mk${lvl}</i></span></div>`;
      }
      html += '<div class="slot-gap"></div>';
      for (const k of ['Q', 'E', 'R', 'F']) {
        const A = ABILITIES[k];
        const l = prof.mods[A.mod] || 0;
        const cd = me.cd[k] || 0;
        const tot = A.cd(Math.max(1, l));
        const pct = l ? Math.min(100, (cd / tot) * 100) : 100;
        html += `<div class="slot abil ${l ? '' : 'locked'} ${k === 'R' && me.cl > 0 ? 'active' : ''}"><span class="aicon">${l ? ABIL_ICON[k] : '🔒'}</span><div class="cdmask" style="height:${pct}%"></div><span class="key">${k}</span><span class="aname">${A.name}</span>${cd > 0 && l ? `<span class="cdnum">${Math.ceil(cd)}</span>` : ''}</div>`;
      }
      const hb = $('#hotbar');
      if (hb._html !== html) { hb.innerHTML = html; hb._html = html; }
    }
    // region banner
    const rid = s.regionId;
    if (rid !== U.regionShown && rid >= 0) {
      U.regionShown = rid;
      showBanner(s, rid);
    }
    $('#hint').textContent = s.inBase && !U.open ? '[B] BASE MENU — Arsenal · Clínica · Armário · Cofre' : s.hint || '';
    $('#hint').classList.toggle('show', !!(s.inBase && !U.open) || !!s.hint);
    // turf panel
    updateTurf(s);
    drawMinimap(s);
    // death
    const dd = $('#death');
    if (me.dead) { dd.classList.remove('hidden'); $('#death-t').textContent = `Respawning at the QG in ${Math.ceil(me.rt)}...`; }
    else dd.classList.add('hidden');
    // room badge
    $('#room').innerHTML = s.roomCode ? `ROOM <b>${s.roomCode}</b> · ${s.playerCount} online${s.isHost ? ' <button class="btn tiny" id="copy-link">COPY INVITE</button>' : ''}` : (s.isHost ? 'OFFLINE (solo)' : '');
    const cl = $('#copy-link');
    if (cl) cl.onclick = () => cb.copyInvite();
    if (U.open === 'base') renderBase(false);
    if (U.open === 'map') drawBigMap();
  };

  function ownerName(s, o) { return o === 'g' || o === 9 ? s.gangName : FACTIONS[o].short; }
  function ownerColor(s, o) { return o === 'g' || o === 9 ? s.gangColor : FACTIONS[o].color; }
  const isGang = (o) => o === 'g' || o === 9;

  function showBanner(s, rid) {
    const R = U.world.regions[rid];
    const rs = s.rs[rid];
    const b = $('#banner');
    const col = ownerColor(s, rs.owner);
    let sub;
    if (R.base) sub = 'Your gang\'s headquarters. Shops, storage, safety.';
    else if (isGang(rs.owner)) sub = `Controlled by ${esc(s.gangName)} · ${rs.guards} guards`;
    else sub = `${FACTIONS[rs.owner].name} · threat ${'▮'.repeat(Math.min(6, R.tier))} · garrison ${rs.garrison}`;
    b.innerHTML = `<div class="b-name" style="color:${col}">${esc(R.name.toUpperCase())}</div><div class="b-sub">${BIOME_LABEL[R.biome]}${R.hq ? ' · <b>FACTION HQ</b>' : ''} — ${sub}</div>`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  function updateTurf(s) {
    const total = U.world.regions.length;
    const owned = s.rs.filter((r) => isGang(r.owner)).length;
    let html = `<div class="turf-row"><b style="color:${s.gangColor}">${esc(s.gangName)}</b> <span>${owned}/${total}</span></div>`;
    const rid = s.regionId;
    if (rid >= 0 && !U.world.regions[rid].base) {
      const rs = s.rs[rid], R = U.world.regions[rid];
      if (!isGang(rs.owner)) {
        const adj = R.neighbors.some((n) => isGang(s.rs[n].owner));
        let st;
        if (!adj) st = '<span class="bad">Too far from our turf</span>';
        else if (R.hq && !rs.hqUnlocked) st = '<span class="bad">HQ locked</span>';
        else if (R.hq && !rs.bossDefeated) st = '<span class="warn">Defeat the boss</span>';
        else if (rs.garrison > 0) st = `Garrison <b>${rs.garrison}</b>/${rs.garrisonMax}`;
        else st = '<span class="good">Stand on the core to capture!</span>';
        html += `<div class="turf-here">${st}</div>`;
        if (rs.capture > 0) html += `<div class="bar cap"><div class="fill" style="width:${rs.capture * 100}%;background:${s.gangColor}"></div></div>`;
      } else if (rs.capture > 0) html += `<div class="turf-here bad">Core under attack!</div><div class="bar cap"><div class="fill" style="width:${rs.capture * 100}%;background:#ff3b5c"></div></div>`;
    }
    for (let f = 0; f < 3; f++) {
      const list = U.world.factionRegions[f];
      const held = list.filter((r) => isGang(s.rs[r].owner)).length;
      const hq = U.world.hqs[f];
      const st = s.defeated[f] ? '<span class="good">DEFEATED</span>' : s.rs[hq] && s.rs[hq].hqUnlocked ? '<span class="warn">HQ OPEN</span>' : `HQ at ${Math.ceil(list.filter((r) => r !== hq).length / 2)}`;
      html += `<div class="turf-row f"><span style="color:${FACTIONS[f].color}">${FACTIONS[f].short}</span> <span>${held}/${list.length}</span> <small>${st}</small></div>`;
    }
    for (const r of s.raids) {
      html += `<div class="turf-row raid">⚠ RAID ${esc(U.world.regions[r.target].name)} ${r.state === 0 ? `in ${r.t}s` : 'NOW'}</div>`;
    }
    const el = $('#turf');
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
  }

  // ---------------------------------------------------------------- minimap & big map
  let mapBase = null, ownerLayer = null, ownerVer = '';
  const BIOME_COL = { base: '#6a6478', beach: '#4a8a4a', favela: '#9a5a3a', downtown: '#5a5a70', suburb: '#3f7f43', industrial: '#4f5866', jungle: '#2a6a32' };
  function buildMapLayers(world) {
    mapBase = mk(W, H);
    const g = mapBase.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const cols = {};
    for (const k in BIOME_COL) cols[k] = hex(BIOME_COL[k]);
    for (let i = 0; i < W * H; i++) {
      const t = world.tiles[i];
      let c;
      if (t === T.WATER) c = [16, 60, 100];
      else if (t === T.SAND) c = [214, 190, 130];
      else if (t === T.CALCADAO) c = [200, 200, 190];
      else if (t === T.ROAD) c = [34, 32, 44];
      else if (t === T.SIDEWALK || t === T.STAIRS) c = [110, 106, 120];
      else if (t === T.BUILD) c = [70, 62, 84];
      else if (t === T.WALL) c = [180, 176, 196];
      else if (t === T.TREE) c = [24, 80, 34];
      else c = cols[world.regions[world.region[i]].biome] || [80, 80, 80];
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    ownerLayer = mk(W, H);
    ownerVer = '';
  }
  function updateOwnerLayer(s) {
    const ver = s.rs.map((r) => (isGang(r.owner) ? 'g' : r.owner)).join('') + s.gangColor;
    if (ver === ownerVer) return;
    ownerVer = ver;
    const g = ownerLayer.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const cache = {};
    const world = U.world;
    for (let i = 0; i < W * H; i++) {
      const r = world.region[i];
      if (r < 0) continue;
      const col = ownerColor(s, s.rs[r].owner);
      let c = cache[col];
      if (!c) c = cache[col] = [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)];
      const x = i % W, y = (i / W) | 0;
      const edge = (x > 0 && world.region[i - 1] !== r) || (y > 0 && world.region[i - W] !== r);
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = edge ? 230 : (isGang(s.rs[r].owner) ? 90 : 55);
    }
    g.putImageData(img, 0, 0);
  }
  function drawMinimap(s) {
    if (!mapBase) return;
    updateOwnerLayer(s);
    const c = $('#minimap'), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const zoom = 2, span = c.width / zoom;
    const px = s.meX / TILE, py = s.meY / TILE;
    const sx = px - span / 2, sy = py - span / 2;
    g.fillStyle = '#0d1a2a'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(mapBase, sx, sy, span, span, 0, 0, c.width, c.height);
    g.drawImage(ownerLayer, sx, sy, span, span, 0, 0, c.width, c.height);
    for (const R of U.world.regions) {
      const C = R.compound;
      const x = (C.coreX - sx) * zoom, y = (C.coreY - sy) * zoom;
      if (x < -4 || y < -4 || x > c.width + 4 || y > c.height + 4) continue;
      g.fillStyle = '#000'; g.fillRect(x - 3, y - 3, 6, 6);
      g.fillStyle = ownerColor(s, s.rs[R.id].owner); g.fillRect(x - 2, y - 2, 4, 4);
      if (R.hq) { g.strokeStyle = '#ffd23f'; g.strokeRect(x - 4.5, y - 4.5, 9, 9); }
    }
    for (const r of s.raids) {
      const C = U.world.regions[r.target].compound;
      const x = (C.coreX - sx) * zoom, y = (C.coreY - sy) * zoom;
      if (Math.floor(now() / 250) % 2) { g.strokeStyle = '#ff3b5c'; g.lineWidth = 2; g.strokeRect(x - 6, y - 6, 12, 12); g.lineWidth = 1; }
    }
    for (const p of s.players) {
      const x = (p.x / TILE - sx) * zoom, y = (p.y / TILE - sy) * zoom;
      g.fillStyle = p.me ? '#ffffff' : s.gangColor;
      g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
    }
    const R = s.regionId >= 0 ? U.world.regions[s.regionId] : null;
    $('#mm-label').textContent = R ? R.name : '';
  }
  const now = () => performance.now();

  function drawBigMap() {
    const s = U.state;
    const c = $('#bigmap');
    if (!c || !s) return;
    updateOwnerLayer(s);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const k = c.width / W;
    g.drawImage(mapBase, 0, 0, c.width, c.height);
    g.drawImage(ownerLayer, 0, 0, c.width, c.height);
    g.font = `${Math.max(9, Math.round(k * 4))}px Silkscreen, monospace`;
    g.textAlign = 'center';
    for (const R of U.world.regions) {
      const C = R.compound, rs = s.rs[R.id];
      const x = (C.coreX + 0.5) * k, y = (C.coreY + 0.5) * k;
      g.fillStyle = '#000'; g.fillRect(x - 5, y - 5, 10, 10);
      g.fillStyle = ownerColor(s, rs.owner); g.fillRect(x - 4, y - 4, 8, 8);
      if (R.hq) { g.strokeStyle = '#ffd23f'; g.lineWidth = 2; g.strokeRect(x - 7, y - 7, 14, 14); g.lineWidth = 1; }
      const label = R.name.toUpperCase();
      g.fillStyle = 'rgba(8,4,20,0.75)';
      const w = g.measureText(label).width;
      g.fillRect(x - w / 2 - 3, y + 7, w + 6, 13);
      g.fillStyle = '#fff';
      g.fillText(label, x, y + 17);
      const sub = R.base ? 'QG' : isGang(rs.owner) ? `${rs.guards} guards` : `${R.hq ? (rs.hqUnlocked ? 'HQ OPEN' : 'HQ LOCKED') + ' · ' : ''}T${R.tier} · ${rs.garrison}`;
      g.fillStyle = R.hq ? '#ffd23f' : '#c8c0d8';
      g.fillText(sub, x, y + 29);
    }
    for (const r of s.raids) {
      const C = U.world.regions[r.target].compound;
      g.strokeStyle = '#ff3b5c'; g.lineWidth = 3;
      g.beginPath(); g.arc((C.coreX + 0.5) * k, (C.coreY + 0.5) * k, 16 + (now() / 100) % 8, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1;
    }
    for (const p of s.players) {
      g.fillStyle = '#000'; g.fillRect(p.x / TILE * k - 4, p.y / TILE * k - 4, 8, 8);
      g.fillStyle = p.me ? '#fff' : s.gangColor; g.fillRect(p.x / TILE * k - 3, p.y / TILE * k - 3, 6, 6);
      g.fillStyle = '#fff'; g.fillText(p.name, p.x / TILE * k, p.y / TILE * k - 7);
    }
  }

  // ---------------------------------------------------------------- modals
  U.closeModal = () => { $('#modal').classList.add('hidden'); U.open = null; cb.setMenuOpen(false); };
  function openModal(kind, html) {
    U.open = kind;
    $('#modal-inner').innerHTML = html;
    $('#modal-inner').className = 'modal-inner panel ' + kind;
    $('#modal').classList.remove('hidden');
    cb.setMenuOpen(true);
  }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') U.closeModal(); });

  U.toggleMap = () => {
    if (U.open === 'map') return U.closeModal();
    const size = Math.min(window.innerHeight * 0.8, window.innerWidth * 0.62) | 0;
    openModal('map', `<div class="panel-title">TERRITORY MAP <span class="close" data-close>✕</span></div>
      <div class="map-body"><canvas id="bigmap" width="${size}" height="${size}"></canvas>
      <div class="map-legend">
        <p>Conquer districts that border your turf. Kill the garrison, then stand on the <b>core</b> to capture it.</p>
        <p>Each compound pays income into the <b>gang vault</b> and gets <b>guards</b>.</p>
        <p>Take half of a faction's districts to unlock its <b>HQ</b> (yellow square). Beat the boss there and capture all three HQs to win the city.</p>
        <div class="legend-row"><i style="background:${U.state ? U.state.gangColor : '#f0f'}"></i> ${esc(U.state ? U.state.gangName : '')}</div>
        ${FACTIONS.map((f) => `<div class="legend-row"><i style="background:${f.color}"></i> ${esc(f.name)}</div>`).join('')}
      </div></div>`);
    $('#modal-inner').querySelector('[data-close]').onclick = U.closeModal;
    drawBigMap();
  };

  let baseTab = 'arsenal';
  U.toggleBase = (tab) => {
    if (U.open === 'base' && !tab) return U.closeModal();
    if (tab) baseTab = tab;
    openModal('base', '');
    renderBase(true);
  };
  function renderBase(force) {
    const s = U.state;
    if (!s || !s.prof) return;
    const prof = s.prof, cash = s.me.cash;
    const key = JSON.stringify([baseTab, prof, cash, s.vault, s.up, s.inBase]);
    const inner = $('#modal-inner');
    if (!force && inner._key === key) return;
    inner._key = key;
    const tabs = [['arsenal', 'ARSENAL', 'Arm weapons'], ['clinic', 'CLÍNICA', 'Body mods'], ['locker', 'ARMÁRIO', 'Equip arms'], ['vault', 'COFRE', 'Gang vault']];
    let body = '';
    if (baseTab === 'arsenal') {
      body = `<p class="tab-intro">Your arms are your weapons. Buy new cyber-arms here, then equip them in the <b>Armário</b>.</p><div class="cards">`;
      for (const id of WEAPON_IDS) {
        const Wp = WEAPONS[id];
        const lvl = prof.armory[id];
        const stats = `${Math.round(Wp.dmg * weaponMult(lvl || 1))}${Wp.pellets ? '×' + Wp.pellets : ''} dmg · ${(1 / Wp.cd).toFixed(1)}/s`;
        let btn;
        if (!lvl) {
          const locked = prof.level < Wp.lvl;
          btn = `<button class="btn" data-a="buyW" data-w="${id}" ${locked || cash < Wp.price ? 'disabled' : ''}>${locked ? 'LV ' + Wp.lvl : 'BUY ' + money(Wp.price)}</button>`;
        } else if (lvl < MAX_WEAPON_LVL) {
          const p = weaponUpgradePrice(id, lvl);
          btn = `<button class="btn" data-a="upW" data-w="${id}" ${cash < p ? 'disabled' : ''}>UPGRADE Mk${lvl + 1} · ${money(p)}</button>`;
        } else btn = '<button class="btn" disabled>MAXED</button>';
        body += `<div class="card ${lvl ? 'owned' : ''}"><img src="${weaponIcon(id)}"><div class="c-name">${esc(Wp.name)} ${lvl ? `<i>Mk${lvl}</i>` : ''}</div><div class="c-pt">${esc(Wp.pt)}</div><div class="c-desc">${esc(Wp.desc)}</div><div class="c-stats">${stats}</div>${btn}</div>`;
      }
      body += '</div>';
    } else if (baseTab === 'clinic') {
      body = `<p class="tab-intro">Body modifications. Each one changes how you look and play, and some unlock abilities (<b>Q E R F</b>).</p><div class="cards">`;
      for (const id of MOD_IDS) {
        const M = MODS[id];
        const lvl = prof.mods[id] || 0;
        const max = M.prices.length;
        const pips = Array.from({ length: max }, (_, i) => `<i class="pip ${i < lvl ? 'on' : ''}"></i>`).join('');
        const btn = lvl >= max ? '<button class="btn" disabled>MAXED</button>' : `<button class="btn" data-a="buyM" data-m="${id}" ${cash < M.prices[lvl] ? 'disabled' : ''}>${lvl ? 'UPGRADE' : 'INSTALL'} · ${money(M.prices[lvl])}</button>`;
        body += `<div class="card mod ${lvl ? 'owned' : ''}"><div class="c-name">${esc(M.name)}</div><div class="c-pt">${esc(M.pt)}</div><div class="pips">${pips}</div><div class="c-desc">${esc(M.desc(Math.max(1, lvl + (lvl < max ? 1 : 0))))}</div>${btn}</div>`;
      }
      body += '</div>';
    } else if (baseTab === 'locker') {
      body = `<p class="tab-intro">Choose what goes on each arm. <b>LMB</b> fires the left arm, <b>RMB</b> the right arm. Same weapon on both arms works too.</p><div class="cards">`;
      for (const id of WEAPON_IDS) {
        const lvl = prof.armory[id];
        if (!lvl) continue;
        const eqL = prof.equip.L === id, eqR = prof.equip.R === id;
        body += `<div class="card ${eqL || eqR ? 'owned' : ''}"><img src="${weaponIcon(id)}"><div class="c-name">${esc(WEAPONS[id].name)} <i>Mk${lvl}</i></div><div class="c-desc">${esc(WEAPONS[id].desc)}</div>
          <div class="row2"><button class="btn ${eqL ? 'on' : ''}" data-a="equip" data-slot="L" data-w="${id}">${eqL ? '✓ ' : ''}LEFT</button><button class="btn ${eqR ? 'on' : ''}" data-a="equip" data-slot="R" data-w="${id}">${eqR ? '✓ ' : ''}RIGHT</button></div></div>`;
      }
      body += `</div><p class="tab-intro small">Kills: ${prof.kills} · Deaths: ${prof.deaths}</p>`;
    } else {
      body = `<p class="tab-intro">The gang vault fills with compound income (every 10s per district you hold). Anyone can spend it on upgrades for the whole gang.</p>
        <div class="vault-amount">${money(s.vault)}</div>
        <div class="row2 donate"><button class="btn" data-a="donate" data-v="100" ${cash < 100 ? 'disabled' : ''}>DONATE R$100</button><button class="btn" data-a="donate" data-v="500" ${cash < 500 ? 'disabled' : ''}>DONATE R$500</button><button class="btn" data-a="donate" data-v="${Math.floor(cash / 2)}" ${cash < 2 ? 'disabled' : ''}>DONATE HALF</button></div><div class="cards">`;
      for (const id in VAULT_UPGRADES) {
        const V = VAULT_UPGRADES[id];
        const lvl = s.up[id] || 0;
        const max = V.prices.length;
        const pips = Array.from({ length: max }, (_, i) => `<i class="pip ${i < lvl ? 'on' : ''}"></i>`).join('');
        const btn = lvl >= max ? '<button class="btn" disabled>MAXED</button>' : `<button class="btn" data-a="vault" data-u="${id}" ${s.vault < V.prices[lvl] ? 'disabled' : ''}>BUY · ${money(V.prices[lvl])}</button>`;
        body += `<div class="card mod"><div class="c-name">${esc(V.name)}</div><div class="pips">${pips}</div><div class="c-desc">${esc(V.desc)}</div>${btn}</div>`;
      }
      body += '</div>';
    }
    inner.innerHTML = `<div class="panel-title">QG DA LAJE — BASE <span class="money-top">${money(cash)}</span><span class="close" data-close>✕</span></div>
      <div class="tabs">${tabs.map(([k, n, d]) => `<button class="tab ${k === baseTab ? 'on' : ''}" data-tab="${k}">${n}<small>${d}</small></button>`).join('')}</div>
      ${s.inBase ? '' : '<div class="warnbar">You are away from the base — go back to the QG to buy or change arms.</div>'}
      <div class="tab-body">${body}</div>`;
  }
  $('#modal').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return U.closeModal();
    const t = e.target.closest('[data-tab]');
    if (t) { baseTab = t.dataset.tab; renderBase(true); cb.sound('click'); return; }
    const b = e.target.closest('[data-a]');
    if (b && !b.disabled) {
      const d = b.dataset;
      const a = { t: d.a };
      if (d.w) a.w = d.w; if (d.m) a.m = d.m; if (d.u) a.u = d.u; if (d.slot) a.slot = d.slot; if (d.v) a.v = Number(d.v);
      cb.onAction(a);
      cb.sound('click');
    }
    const st = e.target.closest('[data-set]');
    if (st) cb.onSetting(st.dataset.set);
  });
  $('#modal').addEventListener('input', (e) => {
    if (e.target.dataset.vol) cb.onVolume(e.target.dataset.vol, Number(e.target.value) / 100);
  });

  U.togglePause = () => {
    if (U.open) return U.closeModal();
    const s = U.state;
    openModal('pause', `<div class="panel-title">MENU <span class="close" data-close>✕</span></div>
      <div class="pause-body">
        ${s && s.roomCode ? `<div class="invite">Room code <b>${s.roomCode}</b><br><button class="btn" data-set="invite">COPY INVITE LINK</button></div>` : ''}
        <label class="vol">MUSIC <input type="range" min="0" max="100" value="${Math.round(getVolume('music') * 100)}" data-vol="music"></label>
        <label class="vol">SOUND FX <input type="range" min="0" max="100" value="${Math.round(getVolume('sfx') * 100)}" data-vol="sfx"></label>
        <div class="help">
          <p><b>WASD</b> move · <b>Mouse</b> aim · <b>LMB/RMB</b> left/right arm weapon</p>
          <p><b>Q</b> dash · <b>E</b> nano-heal · <b>R</b> cloak · <b>F</b> shield (install mods at the Clínica)</p>
          <p><b>B</b> base menu (at the QG) · <b>TAB</b> map · <b>Enter</b> chat · <b>M</b> mute music</p>
        </div>
        <button class="btn" data-set="newtrack">NEW MUSIC TRACK</button>
        <button class="btn danger" data-set="leave">${s && s.isHost ? 'SAVE & QUIT TO TITLE' : 'LEAVE GAME'}</button>
      </div>`);
  };

  U.showVictory = (stats) => {
    openModal('victory', `<div class="panel-title">A CIDADE É NOSSA!</div>
      <div class="victory-body"><p>All three faction HQs have fallen. ${esc(U.state ? U.state.gangName : '')} runs the city now.</p>
      <p>Kills ${stats.kills} · Captures ${stats.captures} · Bosses ${stats.bosses} · Deaths ${stats.deaths}</p>
      <p class="small">Keep playing to hold the city, or start a new game from the title screen for a brand-new map.</p>
      <button class="btn big" data-close>KEEP PLAYING</button></div>`);
  };

  U.isOpen = () => U.open;
  return U;
}
