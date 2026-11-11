// DOM user interface: title screen, new-game setup with map preview, save slots, character creator, HUD,
// base menu, compound upgrades, map with waypoints, gang picker (PvP), settings.

import {
  GAME_NAME, VERSION, KING_TIMES, WEAPONS, WEAPON_IDS, MODS, MOD_IDS, ABILITIES, VAULT_UPGRADES, FACTIONS, LOOK_OPTIONS, LOOK_KEYS,
  GANG_COLORS, GANG_COLOR_NAMES, GANG_DEFAULT_NAMES, NAME_COLORS, BIOME_LABEL, MAX_WEAPON_LVL, weaponMult, weaponUpgradePrice,
  TILE, randomLook, MAP_TYPES, MAP_TYPE_IDS, MAP_SIZES, VEHICLES, VEHICLE_IDS, BATTERY_PRICE, TURRETS, TURRET_IDS,
  TURRET_MAX_MK, turretMult, turretUpgradePrice, COMPOUND_UPS, COMPOUND_UP_IDS, PVP_WIN_SHARE, FOLLOWER_MAX,
  DRINKS, STIMS, ITEMS, BELT_SIZE, WANTED, BAD_BATCH, BOCA, WITHDRAW, DOWN,
  GRENADES, GRENADE_IDS, GREN_MAX, SQUADS, EXTRA_SOLDIERS, TURRET_REPAIR_K,
} from './data.js';
import { T, generateWorld, mapImageData } from './world.js';
import { charSprite, armSprite, playerSpec, mk, turretHead, vehicleSprite } from './sprites.js';
import { getVolume } from './audio.js';
import { randomSeed } from './rng.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => 'R$' + Math.floor(v).toLocaleString('pt-BR');
const isGang = (o) => typeof o === 'string' && o[0] === 'g';
const gIdx = (o) => (isGang(o) ? Number(o.slice(1)) : -1);
const TYPE_CH = { coastal: 'C', island: 'I', lakes: 'L', river: 'R', archipelago: 'A' };
const CH_TYPE = Object.fromEntries(Object.entries(TYPE_CH).map(([k, v]) => [v, k]));
export const seedCode = (type, size, seed) => `${TYPE_CH[type] || 'C'}${size}-${(seed >>> 0).toString(36).toUpperCase()}`;
export function parseSeedCode(code) {
  const m = /^([CILRA])([SML])-([0-9A-Z]{1,8})$/.exec(String(code || '').trim().toUpperCase());
  if (!m) return null;
  return { type: CH_TYPE[m[1]], size: m[2], seed: parseInt(m[3], 36) >>> 0 };
}

export function createUI(root, cb) {
  const U = { cb, state: null, world: null, open: null, iconCache: new Map(), lastUpdate: 0, regionShown: -2, compoundR: -1, mapSel: -1 };

  root.innerHTML = `
  <div id="title" class="screen">
    <div class="title-wrap">
      <h1 class="logo" data-text="${GAME_NAME}">${GAME_NAME}</h1>
      <div class="tagline">Guerra de território · Brazilian cyberpunk turf RPG <span class="version">v${VERSION}</span></div>
      <div class="title-grid">
        <div class="panel creator">
          <div class="panel-title">YOUR CHARACTER</div>
          <div class="creator-body">
            <canvas id="preview" width="34" height="34"></canvas>
            <div class="look-rows"></div>
          </div>
          <label class="field">NAME <input id="name" maxlength="14" spellcheck="false" autocomplete="off"></label>
          <div class="field">NAME COLOR <span id="name-colors" class="swatches"></span></div>
          <label class="field">GANG NAME <input id="gang" maxlength="18" spellcheck="false" autocomplete="off" placeholder="used when you start a gang"></label>
          <button class="btn small" id="randomize">RANDOMIZE LOOK</button>
        </div>
        <div class="panel play">
          <div class="panel-title">PLAY</div>
          <div class="play-body">
            <button class="btn big" id="btn-new">NEW GAME</button>
            <div id="saves-box" class="hidden"><div class="sub-title">LOAD A SAVED GAME</div><div id="saves"></div></div>
            <div class="sep">— or join a friend —</div>
            <div class="join-box">
              <input id="code" maxlength="4" placeholder="CODE" spellcheck="false" autocomplete="off">
              <button class="btn big" id="btn-join">JOIN</button>
            </div>
            <div class="status" id="status"></div>
          </div>
        </div>
      </div>
      <div class="controls-help">
        <b>WASD</b> move · <b>MOUSE</b> aim · <b>LMB / RMB</b> left / right arm · <b>Q E R F</b> body mods · <b>V</b> vehicle · <b>G</b> recruit ·
        <b>B</b> base / compound · <b>1 2 3</b> drinks · <b>T</b> dance · <b>TAB</b> map + waypoints · <b>ENTER</b> chat · <b>ESC</b> menu
      </div>
    </div>
  </div>

  <div id="hud" class="hidden">
    <div class="hud-tl panel slim">
      <div class="who"><span id="h-name"></span> <span class="lvl">LV <b id="h-lvl">1</b></span></div>
      <div class="bar hp"><div class="fill" id="h-hp"></div><div class="bar-shield" id="h-sh"></div><span id="h-hpt"></span></div>
      <div class="bar xp"><div class="fill" id="h-xp"></div><span id="h-xpt"></span></div>
      <div class="cash-row"><span class="cash" id="h-cash">R$0</span><span class="vault" title="Gang vault (compound income)">COFRE <b id="h-vault">R$0</b></span></div>
      <div class="extra-row" id="h-extra"></div>
      <div class="wanted" id="wanted"></div>
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
      <div class="veh-panel panel slim hidden" id="veh"></div>
      <div class="belt-row"><div class="buffs" id="buffs"></div><div class="belt" id="belt"></div><div class="pouch" id="pouch"></div></div>
      <div class="hotbar" id="hotbar"></div>
      <div class="hint" id="hint"></div>
    </div>
    <div class="hud-bl">
      <div id="log"></div>
      <input id="chat" class="hidden" maxlength="80" placeholder="Say something... (Enter)" autocomplete="off">
    </div>
    <div class="hud-br" id="room"></div>
    <div id="downed" class="hidden"><div class="death-title">CAÍDO!</div><div id="downed-t"></div><div class="bar downbar"><div class="fill" id="downed-bar"></div></div><div class="bar revbar"><div class="fill" id="downed-rev"></div></div><div id="downed-help">Crawl to cover. A gang-mate can hold <b>E</b> next to you to revive you · your crew will try too.</div><button class="btn small" id="btn-giveup">[X] GIVE UP</button></div>
    <div id="death" class="hidden"><div class="death-title" id="death-title">VOCÊ CAIU</div><div id="death-sub"></div><div id="death-t"></div><button class="btn big hidden" id="btn-switch">JOIN ANOTHER GANG</button></div>
  </div>

  <div id="modal" class="hidden"><div class="modal-inner panel" id="modal-inner"></div></div>
  <div id="toast"></div>
  `;

  // ---------------------------------------------------------------- title / creator
  const prefs = cb.prefs;
  const look = prefs.look;
  $('#name').value = prefs.name;
  $('#gang').value = prefs.gangName;
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
  swatchRow($('#name-colors'), NAME_COLORS, () => prefs.color, (c) => { prefs.color = c; cb.savePrefs(); refreshNamePreview(); });
  function refreshNamePreview() { $('#name').style.color = prefs.color || '#fff'; }
  refreshNamePreview();

  function swatchRow(el, colors, get, set) {
    el.innerHTML = '';
    for (const c of colors) {
      const s = document.createElement('button');
      s.className = 'gswatch' + (c === get() ? ' on' : '');
      s.style.background = c;
      s.onclick = (ev) => { ev.preventDefault(); set(c); el.querySelectorAll('.gswatch').forEach((x) => x.classList.toggle('on', x === s)); cb.sound('click'); };
      el.appendChild(s);
    }
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
    const spec = playerSpec(look, {}, prefs.gangColor);
    const frame = 1 + (Math.floor(pvT * 8) % 4);
    const s = charSprite(spec, [0, 2, 3, 1][pvDir], frame);
    pvc.clearRect(0, 0, 34, 34);
    pvc.drawImage(s, Math.round(17 - s.ax), Math.round(30 - s.ay));
    const arm = armSprite(pvDir === 1 ? 'fist' : 'pistol');
    const ang = [Math.PI / 2, 0, -Math.PI / 2, Math.PI][pvDir];
    pvc.save(); pvc.translate(17 + (pvDir === 0 ? -s.shX : pvDir === 2 ? s.shX : 0), 30 - s.shY); pvc.rotate(ang); if (Math.cos(ang) < -0.1) pvc.scale(1, -1);
    pvc.drawImage(arm, 0, -4); pvc.restore();
  };

  const readName = () => { const n = $('#name').value.trim() || 'Mano'; prefs.name = n; prefs.gangName = $('#gang').value.trim(); cb.savePrefs(); return n; };
  $('#btn-new').onclick = () => { readName(); openNewGame(); cb.sound('click'); };
  $('#btn-join').onclick = () => { readName(); cb.onJoin($('#code').value); };
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('#name').addEventListener('input', readName);
  $('#gang').addEventListener('input', readName);

  // ---------------------------------------------------------------- save slots
  U.showSaves = (slots) => {
    U.slots = slots;
    const box = $('#saves-box');
    const used = slots.filter(Boolean);
    box.classList.toggle('hidden', !used.length);
    $('#saves').innerHTML = slots.map((s, i) => !s ? '' : `
      <div class="save-row">
        <button class="btn save-load" data-load="${i}"><span class="sl-mode ${s.mode}">${s.mode === 'king' ? 'REI' : s.mode === 'pvp' ? 'PVP' : 'PVE'}</span> ${esc(s.gangName || 'Gang')}</button>
        <div class="save-meta">${esc(MAP_TYPES[s.map?.type]?.name || 'Coastal')} ${esc(s.map?.size || 'M')} · turf ${s.owned}/${s.total} · ${new Date(s.savedAt).toLocaleDateString()} ${new Date(s.savedAt).toLocaleTimeString().slice(0, 5)}</div>
        <button class="btn tiny danger" data-del="${i}" title="Delete this save">✕</button>
      </div>`).join('');
  };
  $('#saves').addEventListener('click', (e) => {
    const l = e.target.closest('[data-load]');
    if (l) { readName(); cb.onLoad(Number(l.dataset.load)); return; }
    const d = e.target.closest('[data-del]');
    if (d) {
      if (d.dataset.armed) { cb.onDeleteSave(Number(d.dataset.del)); return; }
      d.dataset.armed = '1'; d.textContent = 'DELETE?'; setTimeout(() => { if (d.isConnected) { delete d.dataset.armed; d.textContent = '✕'; } }, 2500);
    }
  });

  // ---------------------------------------------------------------- new game setup + map preview
  const ng = { mode: 'pve', kingTime: 10, type: 'coastal', size: 'M', seed: randomSeed(), gangIdx: Math.max(0, GANG_COLORS.indexOf(prefs.gangColor)), slot: 0, world: null, genT: null };
  function openNewGame() {
    const slots = U.slots || [];
    let free = slots.findIndex((s) => !s);
    if (free < 0) { let old = 0; slots.forEach((s, i) => { if (s && s.savedAt < slots[old].savedAt) old = i; }); free = old; }
    ng.slot = free < 0 ? 0 : free;
    openModal('newgame', `<div class="panel-title">NEW GAME <span class="close" data-close>✕</span></div>
      <div class="ng-body">
        <div class="ng-left">
          <div class="ng-row"><span class="ng-label">MODE</span>
            <div class="seg" id="ng-mode"><button data-v="pve">PVE · CAMPAIGN</button><button data-v="pvp">PVP · GANG WAR</button><button data-v="king">REI DA BOCA</button></div></div>
          <div class="ng-desc" id="ng-mode-desc"></div>
          <div class="ng-row" id="ng-king-row"><span class="ng-label">HOLD TIME</span><div class="seg" id="ng-king">${KING_TIMES.map((m) => `<button data-v="${m}">${m} MIN</button>`).join('')}</div></div>
          <div class="ng-row"><span class="ng-label">MAP</span><div class="seg wrap" id="ng-type">${MAP_TYPE_IDS.map((t) => `<button data-v="${t}">${MAP_TYPES[t].name.toUpperCase()}</button>`).join('')}</div></div>
          <div class="ng-desc" id="ng-type-desc"></div>
          <div class="ng-row"><span class="ng-label">SIZE</span><div class="seg" id="ng-size">${Object.keys(MAP_SIZES).map((s) => `<button data-v="${s}">${MAP_SIZES[s].name.toUpperCase()}</button>`).join('')}</div></div>
          <div class="ng-row"><span class="ng-label">SEED</span><input id="ng-seed" spellcheck="false" autocomplete="off"><button class="btn small" id="ng-roll">🎲 REROLL</button></div>
          <div class="ng-row"><span class="ng-label">YOUR GANG</span><span id="ng-colors" class="swatches"></span></div>
          <div class="ng-row"><span class="ng-label">SAVE SLOT</span><div class="seg" id="ng-slot">${[0, 1, 2, 3, 4].map((i) => `<button data-v="${i}">${i + 1}${slots[i] ? '*' : ''}</button>`).join('')}</div></div>
          <div class="ng-desc" id="ng-slot-desc"></div>
          <button class="btn big" id="ng-start">START GAME</button>
        </div>
        <div class="ng-right"><canvas id="ng-map" width="320" height="320"></canvas><div class="ng-map-info" id="ng-info">Generating...</div></div>
      </div>`);
    swatchRow($('#ng-colors'), GANG_COLORS, () => GANG_COLORS[ng.gangIdx], (c) => { ng.gangIdx = GANG_COLORS.indexOf(c); prefs.gangColor = c; cb.savePrefs(); drawPreview(); });
    refreshNG(true);
  }
  function refreshNG(regen) {
    const set = (id, v) => $('#' + id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    set('ng-mode', ng.mode); set('ng-type', ng.type); set('ng-size', ng.size); set('ng-slot', ng.slot); set('ng-king', ng.kingTime);
    $('#ng-king-row').style.display = ng.mode === 'king' ? '' : 'none';
    $('#ng-mode-desc').textContent = ng.mode === 'king'
      ? `King of the hill: every gang starts at the edge of the city. Conquer your way to the BOCA KING in the middle and hold it for ${ng.kingTime} minutes in total (the timer pauses while someone else has it). The NPC factions can win too!`
      : ng.mode === 'pve'
      ? 'Everyone is in one gang. Take the city from the three factions and beat their bosses.'
      : `Gang war: players pick a gang color when they join. Each gang starts at its own base. Capture rival bases or hold ${Math.round(PVP_WIN_SHARE * 100)}% of the city to win. Up to ${MAP_SIZES[ng.size].bases} gangs on this size.`;
    $('#ng-type-desc').textContent = MAP_TYPES[ng.type].desc;
    $('#ng-seed').value = seedCode(ng.type, ng.size, ng.seed);
    const sl = (U.slots || [])[ng.slot];
    $('#ng-slot-desc').innerHTML = sl ? `<span class="warn">Slot ${ng.slot + 1} has a save (${esc(sl.gangName)}). It will be replaced.</span>` : `Saves to slot ${ng.slot + 1}.`;
    if (regen) {
      $('#ng-info').textContent = 'Generating city...';
      clearTimeout(ng.genT);
      ng.genT = setTimeout(() => {
        const t0 = performance.now();
        ng.world = generateWorld(ng.seed, { type: ng.type, size: ng.size, bases: ng.mode !== 'pve' ? MAP_SIZES[ng.size].bases : 1, king: ng.mode === 'king' });
        ng.world._ms = performance.now() - t0;
        drawPreview();
      }, 30);
    } else drawPreview();
  }
  function drawPreview() {
    const c = $('#ng-map');
    if (!c || !ng.world) return;
    const w = ng.world;
    drawWorldMap(c, w, (R) => (R.base ? (ng.mode === 'pve' ? GANG_COLORS[ng.gangIdx] : '#ffffff') : R.king ? '#ffd23f' : FACTIONS[R.faction].color), { bases: true, mode: ng.mode === 'king' ? 'pvp' : ng.mode, gangColor: GANG_COLORS[ng.gangIdx] });
    const n = w.regions.length;
    const bi = {};
    for (const R of w.regions) bi[R.biome] = (bi[R.biome] || 0) + 1;
    $('#ng-info').innerHTML = `${n} districts · ${w.W}×${w.H} tiles · ${Object.entries(bi).filter(([k]) => k !== 'base').map(([k, v]) => `${v} ${BIOME_LABEL[k].toLowerCase()}`).join(', ')}${ng.mode !== 'pve' ? ` · ${w.bases.length} gang bases (white)` : ''}${ng.mode === 'king' ? ' · BOCA KING (gold)' : ''}`;
  }
  $('#modal').addEventListener('click', (e) => {
    if (U.open !== 'newgame') return;
    const b = e.target.closest('.seg button');
    if (b) {
      const seg = b.parentElement.id, v = b.dataset.v;
      if (seg === 'ng-mode') { ng.mode = v; refreshNG(true); }
      if (seg === 'ng-king') { ng.kingTime = Number(v); refreshNG(false); }
      if (seg === 'ng-type') { ng.type = v; refreshNG(true); }
      if (seg === 'ng-size') { ng.size = v; refreshNG(true); }
      if (seg === 'ng-slot') { ng.slot = Number(v); refreshNG(false); }
      cb.sound('click');
      return;
    }
    if (e.target.id === 'ng-roll') { ng.seed = randomSeed(); refreshNG(true); cb.sound('click'); }
    if (e.target.id === 'ng-start') {
      if (!ng.world) return;
      readName();
      cb.onHost({ mode: ng.mode, kingTime: ng.kingTime, type: ng.type, size: ng.size, seed: ng.seed, gangIdx: ng.gangIdx, gangName: prefs.gangName || GANG_DEFAULT_NAMES[ng.gangIdx], slot: ng.slot, world: ng.world });
    }
  });
  $('#modal').addEventListener('change', (e) => {
    if (e.target.id !== 'ng-seed') return;
    const p = parseSeedCode(e.target.value);
    if (!p) { e.target.value = seedCode(ng.type, ng.size, ng.seed); U.toast('Seed codes look like CM-1A2B3C', 'warn'); return; }
    Object.assign(ng, p);
    refreshNG(true);
  });

  // Draws a whole world as a map: terrain + owner tint per region + borders + markers.
  function drawWorldMap(c, w, colorOf, opts = {}) {
    const g = c.getContext('2d');
    const img = mapImageData(w, new ImageData(w.W, w.H));
    const d = img.data;
    const cache = {};
    for (let i = 0; i < w.W * w.H; i++) {
      const r = w.region[i];
      if (r < 0) continue;
      const col = colorOf(w.regions[r]);
      let cc = cache[col];
      if (!cc) cc = cache[col] = [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)];
      const x = i % w.W, y = (i / w.W) | 0;
      const edge = (x > 0 && w.region[i - 1] !== r) || (y > 0 && w.region[i - w.W] !== r);
      const a = edge ? 0.9 : 0.28;
      d[i * 4] = d[i * 4] * (1 - a) + cc[0] * a; d[i * 4 + 1] = d[i * 4 + 1] * (1 - a) + cc[1] * a; d[i * 4 + 2] = d[i * 4 + 2] * (1 - a) + cc[2] * a;
    }
    const tmp = mk(w.W, w.H);
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0d1a2a'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(tmp, 0, 0, c.width, c.height);
    const k = c.width / w.W;
    for (const R of w.regions) {
      const C = R.compound;
      const x = (C.coreX + 0.5) * k, y = (C.coreY + 0.5) * k;
      g.fillStyle = '#000'; g.fillRect(x - 4, y - 4, 8, 8);
      g.fillStyle = colorOf(R); g.fillRect(x - 3, y - 3, 6, 6);
      if (R.hq) { g.strokeStyle = '#ffd23f'; g.lineWidth = 2; g.strokeRect(x - 6, y - 6, 12, 12); g.lineWidth = 1; }
      if (R.base && opts.bases) { g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.strokeRect(x - 7, y - 7, 14, 14); g.lineWidth = 1; }
    }
  }

  U.setCode = (c) => { $('#code').value = c; };
  U.status = (text, err = false) => { const s = $('#status'); s.textContent = text; s.classList.toggle('err', err); };
  U.showTitle = () => { $('#title').classList.remove('hidden'); $('#hud').classList.add('hidden'); U.closeModal(); };
  U.showHUD = (world) => {
    U.world = world;
    $('#title').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    U.closeModal();
    $('#log').innerHTML = '';
    U.regionShown = -2;
    buildMapLayers(world);
  };

  // ---------------------------------------------------------------- gang picker (PvP)
  U.showGangPicker = (choices, title, onPick) => {
    openModal('gangs', `<div class="panel-title">${esc(title || 'PICK YOUR GANG')}</div>
      <div class="gang-body"><p class="tab-intro">Players with the same color are in the same gang. A new color starts a new gang at its own base.</p>
      <div class="gang-grid">${choices.map((c) => `
        <button class="gang-card ${c.open ? '' : 'closed'}" data-gang="${c.idx}" ${c.open ? '' : 'disabled'} style="--gc:${c.color}">
          <i class="gdot"></i><b>${esc(c.name)}</b>
          <small>${c.exists ? (c.out ? 'ELIMINATED' : `${c.members.length} online${c.members.length ? ': ' + esc(c.members.join(', ')) : ''}`) : (c.open ? 'New gang — free base' : 'No free base')}</small>
        </button>`).join('')}</div></div>`);
    U.onGangPick = onPick;
  };
  $('#modal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gang]');
    if (!b || b.disabled || U.open !== 'gangs') return;
    const f = U.onGangPick; U.onGangPick = null;
    U.closeModal();
    if (f) f(Number(b.dataset.gang));
  });

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
    while (t.children.length > 4) t.removeChild(t.firstChild);
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
  U.saved = () => { U.savedAt = performance.now(); };
  const chat = $('#chat');
  U.openChat = () => { chat.classList.remove('hidden'); chat.value = ''; chat.focus(); cb.setTyping(true); };
  chat.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = chat.value.trim(); if (v) cb.onChat(v); closeChat(); e.preventDefault(); }
    if (e.key === 'Escape') { closeChat(); e.preventDefault(); }
    e.stopPropagation();
  });
  function closeChat() { chat.blur(); chat.classList.add('hidden'); cb.setTyping(false); }
  U.chatOpen = () => !chat.classList.contains('hidden');
  $('#btn-switch').onclick = () => cb.onSwitchGang();

  // ---------------------------------------------------------------- icons
  function weaponIcon(id) {
    let u = U.iconCache.get('w' + id);
    if (u) return u;
    const c = mk(66, 30), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(armSprite(id), 0, 0, 22, 9, 0, 2, 66, 27);
    u = c.toDataURL();
    U.iconCache.set('w' + id, u);
    return u;
  }
  function turretIcon(id, color = '#ff3f8e') {
    const key = 't' + id + color;
    let u = U.iconCache.get(key);
    if (u) return u;
    const s = turretHead(id, color);
    const c = mk(66, 36), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(s, 0, 0, s.width, s.height, 0, 0, s.width * 3, s.height * 3);
    u = c.toDataURL();
    U.iconCache.set(key, u);
    return u;
  }
  function vehicleIcon(id, color) {
    const key = 'v' + id + color;
    let u = U.iconCache.get(key);
    if (u) return u;
    const s = vehicleSprite(id, 2, color, 0);
    const c = mk(s.width * 3, s.height * 3), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(s, 0, 0, s.width * 3, s.height * 3);
    u = c.toDataURL();
    U.iconCache.set(key, u);
    return u;
  }
  const ABIL_ICON = { Q: '»', E: '+', R: '◌', F: '⬡' };
  const itemIcons = new Map();
  // tiny pixel art for each drink / stim
  function itemIcon(id) {
    if (itemIcons.has(id)) return itemIcons.get(id);
    const I = ITEMS[id];
    const c = mk(16, 16), g = c.getContext('2d');
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const col = I.c, glass = 'rgba(200,232,255,0.55)', rim = '#e8f4ff';
    switch (id) {
      case 'caipirinha': P(4, 5, 8, 9, glass); P(5, 8, 6, 5, col); P(4, 5, 8, 1, rim); P(9, 3, 4, 3, '#3ddc84'); P(10, 4, 2, 1, '#a0ffc0'); P(6, 9, 2, 2, '#ffffff'); break;
      case 'guarana': P(5, 2, 6, 12, col); P(5, 2, 6, 1, '#c8c8d0'); P(5, 13, 6, 1, '#8a8a96'); P(6, 6, 4, 3, '#3ddc84'); P(7, 7, 2, 1, '#ffd23f'); break;
      case 'acai': P(3, 8, 10, 5, '#5a3424'); P(3, 7, 10, 2, col); P(5, 6, 2, 2, '#ffffff'); P(9, 6, 2, 1, '#ff3fa4'); P(4, 13, 8, 1, '#3a2016'); break;
      case 'cerveja': P(6, 1, 4, 3, '#3a2a10'); P(5, 4, 6, 10, '#8a5a10'); P(6, 7, 4, 4, col); P(6, 4, 1, 9, '#c88a30'); break;
      case 'chopp': P(3, 4, 8, 10, col); P(3, 3, 8, 2, '#ffffff'); P(11, 6, 2, 6, glass); P(4, 6, 1, 7, '#ffe0a0'); break;
      case 'coco': P(3, 6, 10, 8, '#3ddc84'); P(4, 5, 8, 2, '#5aef9a'); P(7, 2, 1, 5, '#ff3fa4'); P(8, 2, 3, 1, '#ff3fa4'); P(4, 9, 2, 2, '#2aa860'); break;
      case 'porosa': P(4, 4, 8, 10, 'rgba(230,230,240,0.7)'); P(5, 8, 6, 5, col); P(4, 4, 8, 1, '#ff3b5c'); P(6, 9, 2, 1, '#ffffff'); break;
      case 'balao': P(4, 2, 8, 8, col); P(5, 1, 6, 1, col); P(5, 10, 6, 1, col); P(5, 3, 2, 2, '#ffffff'); P(7, 11, 2, 1, '#8a8a96'); P(8, 12, 1, 3, '#c8c8d0'); break;
      case 'pedra': P(5, 4, 6, 8, col); P(4, 6, 8, 4, col); P(6, 5, 2, 2, '#c8e8ff'); P(9, 9, 2, 2, '#2a3a8a'); break;
      case 'lolo': P(5, 2, 6, 2, '#c8c8d0'); P(4, 4, 8, 10, 'rgba(255,220,120,0.6)'); P(5, 8, 6, 5, col); P(4, 4, 8, 1, rim); P(1, 10, 4, 4, '#f2f2f2'); break;
      case 'bala': P(3, 5, 5, 6, col); P(8, 5, 5, 6, '#ffffff'); P(4, 4, 8, 1, '#ffd0a0'); P(4, 11, 8, 1, '#c8c8d0'); P(5, 6, 2, 1, '#ffffff'); break;
      default: P(3, 3, 10, 10, col); P(4, 4, 8, 8, '#2aa860'); P(6, 6, 4, 4, '#ffd23f'); P(7, 7, 2, 2, '#ff3fa4'); break;
    }
    const url = c.toDataURL();
    itemIcons.set(id, url);
    return url;
  }
  const fmtT = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : `${Math.ceil(t)}s`);

  // ---------------------------------------------------------------- HUD update
  U.update = (s, now) => {
    U.state = s;
    if (!s || !s.me) return;
    if (now - U.lastUpdate < 66) return;
    U.lastUpdate = now;
    const me = s.me;
    $('#h-name').textContent = s.myName;
    $('#h-name').style.color = s.myColor || '#fff';
    $('#h-lvl').textContent = me.lvl;
    $('#h-hp').style.width = (100 * me.hp / me.maxHp).toFixed(1) + '%';
    $('#h-hp').className = 'fill ' + (me.hp / me.maxHp > 0.6 ? 'ok' : me.hp / me.maxHp > 0.3 ? 'mid' : 'low');
    $('#h-sh').style.width = Math.min(100, 100 * me.sh / me.maxHp).toFixed(1) + '%';
    $('#h-hpt').textContent = `${me.hp} / ${me.maxHp}`;
    $('#h-xp').style.width = (100 * me.xp / me.xn).toFixed(1) + '%';
    $('#h-xpt').textContent = `XP ${me.xp} / ${me.xn}`;
    $('#h-cash').textContent = money(me.cash);
    $('#h-vault').textContent = money(s.vault);
    const extra = `<span title="Crew: follower bots from captured districts">CREW <b>${me.fol || 0}/${FOLLOWER_MAX}</b></span>${me.bat ? '<span class="bat" title="You carry a battery cell. Get in a vehicle with low charge to use it.">🔋 CELL</span>' : ''}${s.mode === 'pvp' ? `<span style="color:${GANG_COLORS[s.myGang]}">${esc(s.gangName)}</span>` : ''}`;
    const ex = $('#h-extra'); if (ex._h !== extra) { ex.innerHTML = extra; ex._h = extra; }
    // hotbar
    const prof = s.prof;
    if (prof) {
      const eq = prof.equip;
      let html = '';
      for (const slot of ['L', 'R']) {
        const id = eq[slot];
        const lvl = prof.armory[id] || 1;
        html += `<div class="slot weapon ${s.vehicle && s.vehicle.seat === 0 ? 'locked' : ''}"><img src="${weaponIcon(id)}"><span class="key">${slot === 'L' ? 'LMB' : 'RMB'}</span><span class="wname">${esc(WEAPONS[id].name)} <i>Mk${lvl}</i></span></div>`;
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
      hb.classList.toggle('hidden', !!s.barName);
    }
    // belt (3 slots) and active effects
    const belt = me.belt || [];
    let bh = '';
    for (let i = 0; i < BELT_SIZE; i++) {
      const id = belt[i];
      bh += id ? `<div class="bslot" title="${esc(ITEMS[id].name)}: ${esc(ITEMS[id].desc)}" style="border-color:${ITEMS[id].c}"><img src="${itemIcon(id)}"><span class="key">${i + 1}</span></div>` : `<div class="bslot empty"><span class="key">${i + 1}</span></div>`;
    }
    const be = $('#belt'); if (be._h !== bh) { be.innerHTML = bh; be._h = bh; }
    // grenade pouch: the selected type big, the others small
    const gr = me.gren || {};
    const sel = GRENADES[s.grenSel] && gr[s.grenSel] > 0 ? s.grenSel : GRENADE_IDS.find((k) => gr[k] > 0) || s.grenSel;
    let ph = `<div class="gsel" style="border-color:${GRENADES[sel].c}" title="Z: throw ${esc(GRENADES[sel].name)} · C: switch"><i style="background:${GRENADES[sel].c}"></i><span class="key">Z</span><b>${gr[sel] || 0}</b></div><div class="gall">`;
    for (const k of GRENADE_IDS) if (gr[k] > 0 && k !== sel) ph += `<span style="color:${GRENADES[k].c}">${GRENADES[k].name[0]}${gr[k]}</span>`;
    ph += '</div>';
    const pe = $('#pouch'); if (pe._h !== ph) { pe.innerHTML = ph; pe._h = ph; }
    let fh = '';
    for (const [id, t] of me.buffs || []) { const I = ITEMS[id]; if (I) fh += `<div class="buff" style="border-color:${I.c}" title="${esc(I.name)}: ${esc(I.desc)}"><img src="${itemIcon(id)}"><span>${fmtT(t)}</span></div>`; }
    if (me.poison > 0) fh += `<div class="buff poison" title="Bad batch: losing HP (never below 1). Água de Coco cures it."><span class="pz">☠</span><span>${Math.ceil(me.poison)}s</span></div>`;
    const bf = $('#buffs'); if (bf._h !== fh) { bf.innerHTML = fh; bf._h = fh; }
    // wanted level: full stars + the next one filling up
    const heat = me.heat || 0;
    let wh = '';
    if (heat > 0 || me.cops > 0) {
      const full = Math.floor(heat / 100), part = (heat % 100) / 100;
      let st = '';
      for (let i = 0; i < 5; i++) st += i < full ? '<i class="st on">★</i>' : i === full && part > 0 ? `<i class="st part" style="--p:${Math.round(part * 100)}%">★</i>` : '<i class="st">★</i>';
      let sub = '';
      if (me.bar >= 0) sub = 'hiding in the bar — the cops wait outside';
      else if (me.safe) sub = 'safe at the QG — pay them off in the base menu (B)';
      else if (me.cops > 0) sub = me.esc > 0 ? `losing them... ${Math.round(100 * me.esc / WANTED.escapeTime)}%` : 'police response — fight or run';
      else sub = 'witnesses saw you';
      wh = `<div class="wstars ${me.cops > 0 ? 'hot' : ''}">${st}</div><div class="wsub">${sub}</div>`;
      if (me.cops > 0 && me.esc > 0) wh += `<div class="bar esc"><div class="fill" style="width:${Math.min(100, 100 * me.esc / WANTED.escapeTime).toFixed(0)}%"></div></div>`;
    } else if (me.safe) wh = '<div class="wsub safe">SAFE ZONE — weapons holstered</div>';
    const we = $('#wanted'); if (we._h !== wh) { we.innerHTML = wh; we._h = wh; }
    // vehicle panel
    const vp = $('#veh');
    if (s.vehicle) {
      const v = s.vehicle, V = VEHICLES[v.type];
      const role = v.seat === 0 ? 'DRIVER — WASD to fly' : 'GUNNER — shoot with LMB / RMB';
      const h = `<b>${esc(V.name)}</b> <small>${role}</small>
        <div class="vrow"><span>HULL</span><div class="bar vh"><div class="fill" style="width:${(100 * v.hp / v.maxHp).toFixed(0)}%"></div></div></div>
        <div class="vrow"><span>CHARGE</span><div class="bar vc ${v.charge < 25 ? 'low' : ''}"><div class="fill" style="width:${v.charge}%"></div></div></div>
        <small>${v.flying ? 'Flying over the city' : '<span class="bad">OUT OF CHARGE — ground crawl</span>'}${v.charging ? ' · <span class="good">charging</span>' : ''} · [V] get out</small>`;
      if (vp._h !== h) { vp.innerHTML = h; vp._h = h; }
      vp.classList.remove('hidden');
    } else vp.classList.add('hidden');
    // region banner
    const rid = s.regionId;
    if (rid !== U.regionShown && rid >= 0) {
      U.regionShown = rid;
      showBanner(s, rid);
    }
    let hint = s.hint || '';
    if (!U.open) {
      if (s.ctxHint) hint = s.ctxHint;
      else if (s.nearVehicle) hint = `[V] ${s.nearVehicle}`;
      else if (s.petPrompt) hint = s.petPrompt === 'dog' ? '[G] Pet the dog' : '[G] Pet the cat';
      else if (s.civPrompt) hint = '[G] Talk to this local: recruit them into your crew';
      else if (s.inBase) hint = '[B] BASE MENU — or walk up to a building: Arsenal · Clínica · Armário · Cofre · Garagem';
      else if (s.nearCompound >= 0) hint = '[B] COMPOUND UPGRADES — turrets, walls, guards...';
    }
    $('#hint').textContent = hint;
    $('#hint').classList.toggle('show', !!hint);
    updateTurf(s);
    drawMinimap(s);
    // downed
    const dn = $('#downed');
    if (me.down > 0 && !me.dead) {
      dn.classList.remove('hidden');
      $('#downed-t').textContent = `Bleeding out in ${Math.floor(me.down / 60)}:${String(Math.floor(me.down % 60)).padStart(2, '0')}`;
      $('#downed-bar').style.width = (100 * me.down / DOWN.time).toFixed(1) + '%';
      $('#downed-rev').style.width = (100 * (me.rvd || 0)).toFixed(1) + '%';
      $('#downed-rev').parentElement.style.visibility = me.rvd > 0 ? 'visible' : 'hidden';
    } else dn.classList.add('hidden');
    // death
    const dd = $('#death');
    if (me.dead) {
      dd.classList.remove('hidden');
      if (me.out) { $('#death-title').textContent = 'GANG ELIMINADA'; $('#death-t').textContent = 'Your gang lost all its turf.'; $('#btn-switch').classList.remove('hidden'); }
      else { $('#death-title').textContent = 'VOCÊ MORREU'; $('#death-t').textContent = `Respawning in ${Math.ceil(me.rt)}...`; $('#death-sub').innerHTML = U.lastLoss ? `Lost <b>R$${U.lastLoss.cash}</b> and <b>${U.lastLoss.xp} XP</b>` : ''; $('#btn-switch').classList.add('hidden'); }
    } else dd.classList.add('hidden');
    // room badge
    const savedRecently = U.savedAt && performance.now() - U.savedAt < 2500;
    $('#room').innerHTML = (s.roomCode ? `ROOM <b>${s.roomCode}</b> · ${s.playerCount} online${s.isHost ? ' <button class="btn tiny" id="copy-link">COPY INVITE</button>' : ''}` : (s.isHost ? 'OFFLINE (solo)' : '')) + (savedRecently ? ' <span class="saved">SAVED ✓</span>' : '');
    const cl = $('#copy-link');
    if (cl) cl.onclick = () => cb.copyInvite();
    if (U.open === 'base') renderBase(false);
    if (U.open === 'compound') renderCompound(false);
    if (U.open === 'shop') renderShop(false);
    if (U.open === 'map') drawBigMap();
  };

  const ownerColor = (o) => (isGang(o) ? GANG_COLORS[gIdx(o)] : FACTIONS[o] ? FACTIONS[o].color : '#888');
  function ownerName(s, o) {
    if (isGang(o)) { const g = s.gangs.find((x) => x.idx === gIdx(o)); return g ? g.name : 'Gang'; }
    return FACTIONS[o] ? FACTIONS[o].short : '?';
  }

  function showBanner(s, rid) {
    const R = U.world.regions[rid];
    const rs = s.rs[rid];
    const b = $('#banner');
    const col = ownerColor(rs.owner);
    let sub;
    const mine = rs.owner === 'g' + s.myGang;
    if (R.base && mine) sub = 'Your gang\'s headquarters. Shops, garage, storage, safety.';
    else if (isGang(rs.owner)) sub = `Controlled by ${esc(ownerName(s, rs.owner))} · ${rs.guards} guards${mine ? '' : ' · <b class="bad">RIVAL TURF</b>'}`;
    else sub = `${FACTIONS[rs.owner].name} · threat ${'▮'.repeat(Math.min(6, R.tier))} · garrison ${rs.garrison}`;
    b.innerHTML = `<div class="b-name" style="color:${col}">${esc(R.name.toUpperCase())}</div><div class="b-sub">${BIOME_LABEL[R.biome]}${R.hq ? ' · <b>FACTION HQ</b>' : ''} — ${sub}</div>${s.musicName ? `<div class="b-music">♪ ${esc(s.musicName)}</div>` : ''}`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  function updateTurf(s) {
    const total = U.world.regions.length;
    const my = 'g' + s.myGang;
    let html = '';
    if (s.king) {
      // Rei da Boca: who holds the BOCA KING, and everyone's time
      const K = s.king, kr = s.rs[K.r];
      const holder = kr ? kr.owner : null;
      const nameOf = (o) => (isGang(o) ? (s.gangs.find((g) => g.idx === gIdx(o)) || {}).name || 'Gang' : FACTIONS[o] ? FACTIONS[o].short : '?');
      const colOf = (o) => ownerColor(o);
      const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      html += `<div class="king-box"><div class="king-title">👑 BOCA KING · ${fmt(K.goal)}</div><div class="turf-row"><small>Held by</small> <b style="color:${colOf(holder)}">${esc(nameOf(holder))}</b></div>`;
      const hold = K.hold.slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
      for (const [k, t] of hold) {
        const o = k[0] === 'g' ? k : Number(k);
        html += `<div class="turf-row"><span style="color:${colOf(o)}">${esc(nameOf(o))}</span><span>${fmt(t)}</span></div><div class="bar cap"><div class="fill" style="width:${Math.min(100, 100 * t / K.goal).toFixed(1)}%;background:${colOf(o)}"></div></div>`;
      }
      html += '</div>';
    }
    if (s.mode === 'pvp') {
      const gangs = s.gangs.slice().sort((a, b) => b.owned - a.owned);
      if (!s.king) html += `<div class="turf-row"><small>WIN: ${Math.ceil(total * PVP_WIN_SHARE)} districts or last gang</small></div>`;
      for (const g of gangs) html += `<div class="turf-row"><b style="color:${GANG_COLORS[g.idx]}">${g.idx === s.myGang ? '▶ ' : ''}${esc(g.name)}</b> <span>${g.out ? '<span class="bad">OUT</span>' : `${g.owned}/${total}`}</span></div>`;
    } else {
      const owned = s.rs.filter((r) => r.owner === my).length;
      html += `<div class="turf-row"><b style="color:${s.gangColor}">${esc(s.gangName)}</b> <span>${owned}/${total}</span></div>`;
    }
    const rid = s.regionId;
    if (rid >= 0 && s.me && s.me.rep !== undefined) {
      const r = s.me.rep;
      const [lbl, cls] = r >= 60 ? ['Friendly', 'good'] : r >= 30 ? ['Neutral', 'warn'] : ['Hostile', 'bad'];
      html += `<div class="turf-row"><small>Locals</small> <span class="${cls}">${lbl} ${r}</span></div>`;
    }
    if (rid >= 0) {
      const rs = s.rs[rid], R = U.world.regions[rid];
      if (rs.owner !== my) {
        const adj = R.neighbors.some((n) => s.rs[n].owner === my);
        let st;
        if (!adj) st = '<span class="bad">Too far from our turf</span>';
        else if (isGang(rs.owner)) st = R.base ? '<span class="warn">Rival base! Clear defenders, hold the core</span>' : '<span class="warn">Rival turf: clear defenders, hold the core</span>';
        else if (R.hq && !rs.hqUnlocked) st = '<span class="bad">HQ locked</span>';
        else if (R.hq && !rs.bossDefeated) st = '<span class="warn">Defeat the boss</span>';
        else if (rs.garrison > 0) st = `Garrison <b>${rs.garrison}</b>/${rs.garrisonMax}`;
        else st = '<span class="good">Stand on the core to capture!</span>';
        html += `<div class="turf-here">${st}</div>`;
        if (rs.capture > 0) html += `<div class="bar cap"><div class="fill" style="width:${rs.capture * 100}%;background:${rs.capBy === my ? s.gangColor : '#ff3b5c'}"></div></div>`;
      } else if (rs.capture > 0) html += `<div class="turf-here bad">Core under attack!</div><div class="bar cap"><div class="fill" style="width:${rs.capture * 100}%;background:#ff3b5c"></div></div>`;
    }
    for (let f = 0; f < 3; f++) {
      const list = U.world.factionRegions[f];
      if (!list.length) continue;
      const owned = s.rs.filter((r) => r.owner === f).length;
      const hq = U.world.hqs[f];
      const st = s.defeated[f] ? '<span class="good">OUT</span>' : s.rs[hq] && s.rs[hq].owner === f && !s.rs[hq].hqUnlocked && s.mode !== 'pvp' ? `HQ at ${Math.ceil(list.filter((r) => r !== hq).length / 2)}` : 'districts';
      html += `<div class="turf-row f"><span style="color:${FACTIONS[f].color}">${FACTIONS[f].short}</span> <span>${owned}</span> <small>${st}</small></div>`;
    }
    for (const r of s.raids) {
      if (s.mode === 'pvp' && r.g !== s.myGang) continue;
      html += `<div class="turf-row raid">⚠ RAID ${esc(U.world.regions[r.target].name)} ${r.state === 0 ? `in ${r.t}s` : 'NOW'}</div>`;
    }
    const myId = 'g' + s.myGang;
    s.rs.forEach((rs, i) => { if (rs.atk && rs.owner === myId) html += `<div class="turf-row raid">⚠ UNDER ATTACK: ${esc(U.world.regions[i].name)}</div>`; });
    const el = $('#turf');
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
  }

  // ---------------------------------------------------------------- minimap & big map
  let mapBase = null, ownerLayer = null, ownerVer = '';
  function buildMapLayers(world) {
    mapBase = mk(world.W, world.H);
    const g = mapBase.getContext('2d');
    g.putImageData(mapImageData(world, g.createImageData(world.W, world.H)), 0, 0);
    ownerLayer = mk(world.W, world.H);
    ownerVer = '';
  }
  function updateOwnerLayer(s) {
    const ver = s.rs.map((r) => r.owner).join(',');
    if (ver === ownerVer) return;
    ownerVer = ver;
    const world = U.world;
    const g = ownerLayer.getContext('2d');
    const img = g.createImageData(world.W, world.H);
    const d = img.data;
    const cache = {};
    for (let i = 0; i < world.W * world.H; i++) {
      const r = world.region[i];
      if (r < 0) continue;
      const col = ownerColor(s.rs[r].owner);
      let c = cache[col];
      if (!c) c = cache[col] = [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)];
      const x = i % world.W, y = (i / world.W) | 0;
      const edge = (x > 0 && world.region[i - 1] !== r) || (y > 0 && world.region[i - world.W] !== r);
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = edge ? 230 : (isGang(s.rs[r].owner) ? 90 : 55);
    }
    g.putImageData(img, 0, 0);
  }
  const MM_ZOOM = 2;
  function drawMinimap(s) {
    if (!mapBase) return;
    updateOwnerLayer(s);
    const c = $('#minimap'), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const span = c.width / MM_ZOOM;
    const px = s.meX / TILE, py = s.meY / TILE;
    const sx = px - span / 2, sy = py - span / 2;
    U.mm = { sx, sy };
    g.fillStyle = '#0d1a2a'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(mapBase, sx, sy, span, span, 0, 0, c.width, c.height);
    g.drawImage(ownerLayer, sx, sy, span, span, 0, 0, c.width, c.height);
    const toM = (wx, wy) => [(wx / TILE - sx) * MM_ZOOM, (wy / TILE - sy) * MM_ZOOM];
    for (const R of U.world.regions) {
      const C = R.compound;
      const x = (C.coreX - sx) * MM_ZOOM, y = (C.coreY - sy) * MM_ZOOM;
      if (x < -4 || y < -4 || x > c.width + 4 || y > c.height + 4) continue;
      g.fillStyle = '#000'; g.fillRect(x - 3, y - 3, 6, 6);
      g.fillStyle = ownerColor(s.rs[R.id].owner); g.fillRect(x - 2, y - 2, 4, 4);
      if (R.hq) { g.strokeStyle = '#ffd23f'; g.strokeRect(x - 4.5, y - 4.5, 9, 9); }
    }
    const blink = Math.floor(performance.now() / 250) % 2;
    if (blink) for (const R of U.world.regions) {
      const rs = s.rs[R.id];
      if (!rs || !rs.atk || rs.owner !== 'g' + s.myGang) continue;
      const C = R.compound;
      const x = (C.coreX - sx) * MM_ZOOM, y = (C.coreY - sy) * MM_ZOOM;
      g.fillStyle = '#ff3b5c'; g.fillRect(x - 5, y - 5, 10, 10); g.fillStyle = '#ffffff'; g.fillRect(x - 1, y - 1, 2, 2);
    }
    for (const r of s.raids) {
      if (s.mode === 'pvp' && r.g !== s.myGang) continue;
      const C = U.world.regions[r.target].compound;
      const x = (C.coreX - sx) * MM_ZOOM, y = (C.coreY - sy) * MM_ZOOM;
      if (blink) { g.strokeStyle = '#ff3b5c'; g.lineWidth = 2; g.strokeRect(x - 6, y - 6, 12, 12); g.lineWidth = 1; }
    }
    // vehicles (empty ones are useful to find)
    for (const v of s.vehicles || []) {
      const [x, y] = toM(v.x, v.y);
      if (x < 0 || y < 0 || x > c.width || y > c.height) continue;
      g.fillStyle = '#000'; g.fillRect(x - 2, y - 2, 5, 4);
      g.fillStyle = v.charge > 25 ? '#9af0ff' : '#ff8a3d'; g.fillRect(x - 1, y - 1, 3, 2);
    }
    // enemies close to you, plus radar contacts
    g.fillStyle = '#ff8a3d';
    for (const [x0, y0] of s.radar || []) { const [x, y] = toM(x0, y0); if (x > 0 && y > 0 && x < c.width && y < c.height) g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); }
    for (const e of s.enemiesNear || []) {
      const [x, y] = toM(e.x, e.y);
      g.fillStyle = e.boss ? '#ffd23f' : '#ff3b5c';
      g.fillRect(Math.round(x) - (e.boss ? 2 : 1), Math.round(y) - (e.boss ? 2 : 1), e.boss ? 4 : 2, e.boss ? 4 : 2);
    }
    // waypoints
    for (const w of s.waypoints || []) {
      let [x, y] = toM(w.x, w.y);
      x = Math.max(4, Math.min(c.width - 4, x)); y = Math.max(4, Math.min(c.height - 4, y));
      g.fillStyle = '#000'; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.fill();
      g.fillStyle = w.color; g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x + 4, y); g.lineTo(x, y + 4); g.lineTo(x - 4, y); g.fill();
    }
    for (const p of s.players) {
      if (p.hidden) continue;
      const [x, y] = toM(p.x, p.y);
      g.fillStyle = '#000'; g.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
      g.fillStyle = p.hostile ? '#ff3b5c' : p.color || '#fff';
      g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
      if (p.me) { g.strokeStyle = '#fff'; g.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7); }
    }
    const R = s.regionId >= 0 ? U.world.regions[s.regionId] : null;
    $('#mm-label').textContent = R ? R.name : '';
  }
  // minimap clicks place / clear your waypoint
  $('#minimap').addEventListener('mousedown', (e) => {
    if (!U.mm) return;
    e.preventDefault(); e.stopPropagation();
    const c = e.currentTarget, rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * c.width, y = (e.clientY - rect.top) / rect.height * c.height;
    if (e.button === 2) cb.onAction({ t: 'wp', clear: true });
    else cb.onAction({ t: 'wp', x: (U.mm.sx + x / MM_ZOOM) * TILE, y: (U.mm.sy + y / MM_ZOOM) * TILE });
    cb.sound('wp');
  });
  $('#minimap').addEventListener('contextmenu', (e) => e.preventDefault());

  function drawBigMap() {
    const s = U.state;
    const c = $('#bigmap');
    if (!c || !s) return;
    updateOwnerLayer(s);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const k = c.width / U.world.W;
    g.drawImage(mapBase, 0, 0, c.width, c.height);
    g.drawImage(ownerLayer, 0, 0, c.width, c.height);
    g.font = `${Math.max(9, Math.round(k * 3.4))}px Silkscreen, monospace`;
    g.textAlign = 'center';
    for (const R of U.world.regions) {
      const C = R.compound, rs = s.rs[R.id];
      const x = (C.coreX + 0.5) * k, y = (C.coreY + 0.5) * k;
      g.fillStyle = '#000'; g.fillRect(x - 5, y - 5, 10, 10);
      g.fillStyle = ownerColor(rs.owner); g.fillRect(x - 4, y - 4, 8, 8);
      if (R.hq) { g.strokeStyle = '#ffd23f'; g.lineWidth = 2; g.strokeRect(x - 7, y - 7, 14, 14); g.lineWidth = 1; }
      if (R.id === U.mapSel) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x - 9, y - 9, 18, 18); g.lineWidth = 1; }
      const label = R.name.toUpperCase();
      g.fillStyle = 'rgba(8,4,20,0.75)';
      const w = g.measureText(label).width;
      g.fillRect(x - w / 2 - 3, y + 7, w + 6, 12);
      g.fillStyle = '#fff';
      g.fillText(label, x, y + 16);
    }
    for (const r of s.raids) {
      if (s.mode === 'pvp' && r.g !== s.myGang) continue;
      const C = U.world.regions[r.target].compound;
      g.strokeStyle = '#ff3b5c'; g.lineWidth = 3;
      g.beginPath(); g.arc((C.coreX + 0.5) * k, (C.coreY + 0.5) * k, 16 + (performance.now() / 100) % 8, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1;
    }
    for (const R of U.world.regions) {
      const rs = s.rs[R.id];
      if (!rs || !rs.atk || rs.owner !== 'g' + s.myGang) continue;
      const C = R.compound;
      const x = (C.coreX + 0.5) * k, y = (C.coreY + 0.5) * k;
      g.strokeStyle = Math.floor(performance.now() / 250) % 2 ? '#ff3b5c' : '#ffffff'; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, 12 + (performance.now() / 70) % 12, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1;
      const tw = g.measureText('UNDER ATTACK').width;
      g.fillStyle = 'rgba(8,4,20,0.85)'; g.fillRect(x - tw / 2 - 3, y - 33, tw + 6, 13);
      g.fillStyle = '#ff3b5c'; g.fillText('UNDER ATTACK', x, y - 23);
    }
    for (const v of s.vehicles || []) { g.fillStyle = '#000'; g.fillRect(v.x / TILE * k - 3, v.y / TILE * k - 2, 7, 5); g.fillStyle = '#9af0ff'; g.fillRect(v.x / TILE * k - 2, v.y / TILE * k - 1, 5, 3); }
    for (const w of s.waypoints || []) {
      const x = w.x / TILE * k, y = w.y / TILE * k;
      g.fillStyle = '#000'; g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 8, y); g.lineTo(x, y + 8); g.lineTo(x - 8, y); g.fill();
      g.fillStyle = w.color; g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.fill();
      g.fillStyle = w.color; g.fillText(w.name, x, y - 10);
    }
    for (const p of s.players) {
      if (p.hidden) continue;
      const x = p.x / TILE * k, y = p.y / TILE * k;
      g.fillStyle = '#000'; g.fillRect(x - 4, y - 4, 8, 8);
      g.fillStyle = p.hostile ? '#ff3b5c' : p.color || '#fff'; g.fillRect(x - 3, y - 3, 6, 6);
      g.fillStyle = p.color || '#fff'; g.fillText(p.name, x, y - 7);
    }
  }

  // ---------------------------------------------------------------- modals
  U.deathLoss = (cash, xp) => { U.lastLoss = { cash, xp }; };
  $('#btn-giveup').addEventListener('click', () => cb.onAction({ t: 'giveup' }));
  U.closeModal = () => { $('#modal').classList.add('hidden'); U.open = null; cb.setMenuOpen(false); };
  function openModal(kind, html) {
    U.open = kind;
    $('#modal-inner').innerHTML = html;
    $('#modal-inner').className = 'modal-inner panel ' + kind;
    $('#modal').classList.remove('hidden');
    cb.setMenuOpen(true);
  }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && U.open !== 'gangs') U.closeModal(); });

  U.toggleMap = () => {
    if (U.open === 'map') return U.closeModal();
    const size = Math.min(window.innerHeight * 0.8, window.innerWidth * 0.6) | 0;
    U.mapSel = -1;
    openModal('map', `<div class="panel-title">TERRITORY MAP <span class="close" data-close>✕</span></div>
      <div class="map-body"><canvas id="bigmap" width="${size}" height="${size}"></canvas>
      <div class="map-legend">
        <p><b>Click the map</b> to place your waypoint (everyone in your gang sees it). <b>Right-click</b> clears it.</p>
        <p><b>Click a district square</b> to see it. Your districts can be upgraded from here.</p>
        <div id="map-sel"></div>
        <button class="btn small" data-wpclear>CLEAR MY WAYPOINT</button>
        <div class="legend">${U.state && U.state.mode === 'pvp' ? (U.state.gangs || []).map((g) => `<div class="legend-row"><i style="background:${GANG_COLORS[g.idx]}"></i> ${esc(g.name)}</div>`).join('') : `<div class="legend-row"><i style="background:${U.state ? U.state.gangColor : '#f0f'}"></i> ${esc(U.state ? U.state.gangName : '')}</div>`}
        ${FACTIONS.filter((f) => !f.alien).map((f) => `<div class="legend-row"><i style="background:${f.color}"></i> ${esc(f.name)}</div>`).join('')}
        <div class="legend-row"><i style="background:#9af0ff"></i> Flying vehicle</div></div>
      </div></div>`);
    drawBigMap();
    renderMapSel();
  };
  // raid buttons for a district you could attack (from the map)
  function squadBox(s, r) {
    const R = U.world.regions[r], rs = s.rs[r];
    if (!R.neighbors.some((n) => s.rs[n].owner === 'g' + s.myGang)) return '<br><small>Not touching your turf: no squads.</small>';
    if (s.mode === 'pve' && rs.owner === 3) return '';
    let soldiers = 0;
    for (const x of s.rs) if (x.owner === 'g' + s.myGang) soldiers += x.guards || 0;
    const cd = s.me.sq || 0;
    const busy = (s.squads || []).some((q) => q.target === r);
    let h = `<div class="squad-box"><b>SEND A RAID</b> <small>${soldiers} soldiers in your compounds · vault ${money(s.vault)}</small>`;
    if (cd > 0) h += `<div class="warn">Next raid in ${Math.floor(cd / 60)}:${String(cd % 60).padStart(2, '0')}</div>`;
    else if (busy) h += '<div class="warn">A squad is already attacking here.</div>';
    h += '<div class="squad-btns">';
    SQUADS.forEach((S, i) => { h += `<button class="btn small" data-a="squad" data-r="${r}" data-size="${i}" ${cd > 0 || busy || soldiers < S.soldiers || s.vault < S.price ? 'disabled' : ''}>${S.name.toUpperCase()} · ${S.n} fighters<br><small>${S.soldiers} soldiers + ${money(S.price)}</small></button>`; });
    return h + '</div></div>';
  }
  function renderMapSel() {
    const el = $('#map-sel');
    if (!el) return;
    const s = U.state;
    if (U.mapSel < 0 || !s) { el.innerHTML = ''; return; }
    const R = U.world.regions[U.mapSel], rs = s.rs[U.mapSel];
    const mine = rs.owner === 'g' + s.myGang;
    el.innerHTML = `<div class="sel-box" style="border-color:${ownerColor(rs.owner)}"><b style="color:${ownerColor(rs.owner)}">${esc(R.name)}</b><br>
      ${BIOME_LABEL[R.biome]} · threat T${R.tier}${R.hq ? ' · <span class="warn">FACTION HQ</span>' : ''}<br>
      ${isGang(rs.owner) ? `${esc(ownerName(s, rs.owner))} · ${rs.guards} guards${rs.up ? ` · ${(rs.slots || []).filter(Boolean).length} turrets` : ''}` : `${FACTIONS[rs.owner].short} · garrison ${rs.garrison}/${rs.garrisonMax}`}
      ${mine ? `<br><button class="btn small" data-upgrades="${U.mapSel}">UPGRADE COMPOUND</button>` : squadBox(s, U.mapSel)}</div>`;
  }
  $('#modal').addEventListener('mousedown', (e) => {
    if (U.open !== 'map' || e.target.id !== 'bigmap') return;
    e.preventDefault();
    const c = e.target, rect = c.getBoundingClientRect();
    const k = c.width / U.world.W;
    const x = (e.clientX - rect.left) / rect.width * c.width, y = (e.clientY - rect.top) / rect.height * c.height;
    if (e.button === 2) { cb.onAction({ t: 'wp', clear: true }); cb.sound('click'); return; }
    // clicked a district square?
    for (const R of U.world.regions) {
      const C = R.compound;
      if (Math.abs((C.coreX + 0.5) * k - x) < 9 && Math.abs((C.coreY + 0.5) * k - y) < 9) { U.mapSel = R.id; renderMapSel(); drawBigMap(); cb.sound('click'); return; }
    }
    cb.onAction({ t: 'wp', x: x / k * TILE, y: y / k * TILE });
    cb.sound('wp');
  });
  $('#modal').addEventListener('contextmenu', (e) => { if (U.open === 'map') e.preventDefault(); });

  // ---------------------------------------------------------------- base menu
  let baseTab = 'arsenal';
  U.toggleBase = (tab) => {
    if (U.open === 'base' && !tab) return U.closeModal();
    if (tab) baseTab = tab;
    openModal('base', '');
    renderBase(true);
  };
  function cardPips(lvl, max) { return `<div class="pips">${Array.from({ length: max }, (_, i) => `<i class="pip ${i < lvl ? 'on' : ''}"></i>`).join('')}</div>`; }
  function renderBase(force) {
    const s = U.state;
    if (!s || !s.prof) return;
    const prof = s.prof, cash = s.me.cash;
    const pm = 1 - 0.08 * ((s.up && s.up.market) || 0);
    const baseR = s.regionId;
    const key = JSON.stringify([baseTab, prof, cash, s.vault, s.up, s.inBase, s.me.bat, s.me.gren, baseTab === 'defense' ? s.rs[baseR] : 0, (s.vehicles || []).length, Math.ceil((s.me.heat || 0) / 100), s.me.wd > 0]);
    const inner = $('#modal-inner');
    if (!force && inner._key === key) return;
    inner._key = key;
    const tabs = [['arsenal', 'ARSENAL', 'Arm weapons'], ['clinic', 'CLÍNICA', 'Body mods'], ['locker', 'ARMÁRIO', 'Equip arms'], ['garage', 'GARAGEM', 'Vehicles'], ['vault', 'COFRE', 'Gang vault'], ['defense', 'DEFESA', 'Base turrets']];
    let body = '';
    if (baseTab === 'arsenal') {
      const gr = s.me.gren || {};
      let gh = `<p class="tab-intro">GRANADAS — carry up to ${GREN_MAX} of each. <b>Z</b> throws at the cursor, <b>C</b> switches type.</p><div class="cards gcards">`;
      for (const k of GRENADE_IDS) {
        const G0 = GRENADES[k], price = Math.round(G0.price * pm), n = gr[k] || 0;
        gh += `<div class="card gcard"><div class="c-name" style="color:${G0.c}"><i class="gdot" style="background:${G0.c}"></i>${esc(G0.name)} <i>${n}/${GREN_MAX}</i></div><div class="c-pt">${esc(G0.pt)}</div><div class="c-desc">${esc(G0.desc)}</div><button class="btn" data-a="buyG" data-k="${k}" ${n >= GREN_MAX || cash < price ? 'disabled' : ''}>${n >= GREN_MAX ? 'FULL' : 'BUY · ' + money(price)}</button></div>`;
      }
      gh += '</div>';
      body = gh + `<p class="tab-intro">Your arms are your weapons. Buy new cyber-arms here, then equip them in the <b>Armário</b>.${pm < 1 ? ` <b>Black Market: -${Math.round((1 - pm) * 100)}%</b>` : ''}</p><div class="cards">`;
      for (const id of WEAPON_IDS) {
        const Wp = WEAPONS[id];
        const lvl = prof.armory[id];
        if (Wp.rare && !lvl) continue;
        const stats = Wp.kind === 'flame' ? `${Math.round(Wp.dmg * weaponMult(lvl || 1) / Wp.cd)} dmg/s + burn` : `${Math.round(Wp.dmg * weaponMult(lvl || 1))}${Wp.pellets ? '×' + Wp.pellets : ''} dmg · ${(1 / Wp.cd).toFixed(1)}/s`;
        let btn;
        if (!lvl) {
          const locked = prof.level < Wp.lvl;
          const price = Math.round(Wp.price * pm);
          btn = `<button class="btn" data-a="buyW" data-w="${id}" ${locked || cash < price ? 'disabled' : ''}>${locked ? 'LV ' + Wp.lvl : 'BUY ' + money(price)}</button>`;
        } else if (lvl < MAX_WEAPON_LVL) {
          const p = Math.round(weaponUpgradePrice(id, lvl) * pm);
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
        const price = lvl < max ? Math.round(M.prices[lvl] * pm) : 0;
        const btn = lvl >= max ? '<button class="btn" disabled>MAXED</button>' : `<button class="btn" data-a="buyM" data-m="${id}" ${cash < price ? 'disabled' : ''}>${lvl ? 'UPGRADE' : 'INSTALL'} · ${money(price)}</button>`;
        body += `<div class="card mod ${lvl ? 'owned' : ''}"><div class="c-name">${esc(M.name)}</div><div class="c-pt">${esc(M.pt)}</div>${cardPips(lvl, max)}<div class="c-desc">${esc(M.desc(Math.max(1, lvl + (lvl < max ? 1 : 0))))}</div>${btn}</div>`;
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
      body += `</div><p class="tab-intro small">Kills: ${prof.kills} · Deaths: ${prof.deaths}${s.mode === 'pvp' ? ` · Rival kills: ${prof.pvpKills || 0}` : ''}</p>`;
    } else if (baseTab === 'garage') {
      const bp = Math.round(BATTERY_PRICE * pm);
      body = `<p class="tab-intro">Flying vehicles fly over buildings. Flying uses <b>charge</b>: when it runs out the vehicle can only crawl on the ground. Park at the QG (or a compound with a <b>Charge Pad</b>) to recharge and repair. Wrecked vehicles come back somewhere in the city after a while.</p><div class="cards">
        <div class="card mod"><div class="c-name">Battery Cell</div><div class="c-pt">Célula de Bateria</div><div class="c-desc">Carry one with you. Getting into a vehicle with low charge installs it: +60% charge on the spot. (Your money)</div><button class="btn" data-a="battery" ${s.me.bat || cash < bp ? 'disabled' : ''}>${s.me.bat ? 'CARRYING ONE' : 'BUY · ' + money(bp)}</button></div>`;
      for (const id of VEHICLE_IDS) {
        const V = VEHICLES[id];
        body += `<div class="card"><img class="vimg" src="${vehicleIcon(id, s.gangColor)}"><div class="c-name">${esc(V.name)}</div><div class="c-pt">${esc(V.pt)}</div><div class="c-desc">${esc(V.desc)} Hull ${V.hp}.</div><button class="btn" data-a="buyV" data-v="${id}" ${s.vault < V.price ? 'disabled' : ''}>BUY FOR THE GANG · ${money(V.price)}</button></div>`;
      }
      body += `</div><p class="tab-intro small">Vehicles in the city: ${(s.vehicles || []).length}. Gang vehicles are bought with the gang vault.</p>`;
    } else if (baseTab === 'vault') {
      body = `<p class="tab-intro">The gang vault fills with compound income (every 10s per district you hold). Anyone can spend it on upgrades for the whole gang, on vehicles, or on <b>compound defenses</b> (B at a compound, or from the TAB map).</p>
        <div class="vault-amount">${money(s.vault)}</div>
        <div class="row2 donate">${(() => { const mx = Math.floor(s.vault * WITHDRAW.share), cd = s.me.wd || 0; return `<button class="btn on" data-a="withdraw" data-v="${Math.floor(s.vault * 0.1)}" ${!s.inBase || cd > 0 || s.vault < 10 ? 'disabled' : ''}>TAKE R$${Math.floor(s.vault * 0.1)}</button><button class="btn on" data-a="withdraw" data-v="${mx}" ${!s.inBase || cd > 0 || mx < 1 ? 'disabled' : ''}>${cd > 0 ? `LOCKED ${cd}s` : `TAKE R$${mx} (MAX)`}</button>`; })()}</div>
        <p class="tab-intro small">Anyone can take up to ${Math.round(WITHDRAW.share * 100)}% of the vault, once a minute. The gang sees who took what.</p>
        <div class="row2 donate"><button class="btn" data-a="donate" data-v="100" ${cash < 100 ? 'disabled' : ''}>DONATE R$100</button><button class="btn" data-a="donate" data-v="500" ${cash < 500 ? 'disabled' : ''}>DONATE R$500</button><button class="btn" data-a="donate" data-v="${Math.floor(cash / 2)}" ${cash < 2 ? 'disabled' : ''}>DONATE HALF</button></div><div class="cards">`;
      for (const id in VAULT_UPGRADES) {
        const V = VAULT_UPGRADES[id];
        const lvl = s.up[id] || 0;
        const max = V.prices.length;
        const btn = lvl >= max ? '<button class="btn" disabled>MAXED</button>' : `<button class="btn" data-a="vault" data-u="${id}" ${s.vault < V.prices[lvl] ? 'disabled' : ''}>BUY · ${money(V.prices[lvl])}</button>`;
        body += `<div class="card mod"><div class="c-name">${esc(V.name)}</div>${cardPips(lvl, max)}<div class="c-desc">${esc(V.desc)}</div>${btn}</div>`;
      }
      body += '</div>';
    } else {
      body = compoundBody(baseR);
    }
    inner.innerHTML = `<div class="panel-title">${esc(baseR >= 0 ? U.world.regions[baseR].name.toUpperCase() : 'QG')} — BASE <span class="money-top">${money(cash)}</span><span class="close" data-close>✕</span></div>
      <div class="tabs">${tabs.map(([k, n, d]) => `<button class="tab ${k === baseTab ? 'on' : ''}" data-tab="${k}">${n}<small>${d}</small></button>`).join('')}</div>
      ${s.inBase ? '' : '<div class="warnbar">You are away from the base — go back to the QG to buy or change arms.</div>'}
      ${s.me.heat > 0 ? `<div class="warnbar cops">★ WANTED ${'★'.repeat(Math.ceil(s.me.heat / 100 - 0.001))} — pay the police to forget you <button class="btn small" data-a="bribe" ${!s.inBase || cash < Math.ceil(s.me.heat / 100 - 0.001) * WANTED.bribe ? 'disabled' : ''}>PAY OFF · ${money(Math.ceil(s.me.heat / 100 - 0.001) * WANTED.bribe)}</button></div>` : ''}
      <div class="tab-body">${body}</div>`;
  }

  // ---------------------------------------------------------------- bar shops (drinks at the counter, stims from the dealer)
  U.openShop = (kind, bar) => {
    U.shopKind = kind; U.shopBar = bar;
    openModal('shop', '');
    renderShop(true);
  };
  function renderShop(force) {
    const s = U.state;
    if (!s || !s.me) return;
    const kind = U.shopKind, bar = U.shopBar;
    const cash = s.me.cash, belt = s.me.belt || [];
    const key = JSON.stringify([kind, cash, belt]);
    const inner = $('#modal-inner');
    if (!force && inner._key === key) return;
    inner._key = key;
    const list = kind === 'stims' ? STIMS : DRINKS;
    const full = !belt.includes(null);
    let body = kind === 'stims'
      ? `<p class="tab-intro">"Psiu... quer algo mais forte?" Street cyber stims: stronger and longer than any drink, but <b>${Math.round(BAD_BATCH.chance * 100)}% are a bad batch</b> (poison for ${BAD_BATCH.t}s; it never kills you).</p>`
      : '<p class="tab-intro">Drinks go on your <b>belt</b> (3 slots, kept when you die). Use them any time with <b>1 2 3</b>. Different effects stack; the same one refreshes.</p>';
    body += `<div class="beltview">BELT ${belt.map((id, i) => (id ? `<span class="bv" style="border-color:${ITEMS[id].c}"><img src="${itemIcon(id)}">${i + 1}</span>` : `<span class="bv empty">${i + 1}</span>`)).join('')}</div><div class="cards">`;
    for (const id in list) {
      const I = list[id];
      const dur = I.t ? fmtT(I.t) : 'instant';
      body += `<div class="card item ${kind}"><img class="iimg" src="${itemIcon(id)}"><div class="c-name" style="color:${I.c}">${esc(I.name)}</div><div class="c-desc">${esc(I.desc)}</div><div class="c-stats">${dur}</div>
        <button class="btn" data-a="buy" data-item="${id}" ${full || cash < I.price ? 'disabled' : ''}>${full ? 'BELT FULL' : 'BUY · ' + money(I.price)}</button></div>`;
    }
    body += '</div>';
    const title = kind === 'stims' ? 'DEALER — STIMS' : `${esc((bar && bar.name ? bar.name : 'BAR').toUpperCase())} — BALCÃO`;
    inner.innerHTML = `<div class="panel-title">${title} <span class="money-top">${money(cash)}</span><span class="close" data-close>✕</span></div><div class="tab-body">${body}</div>`;
  }

  // ---------------------------------------------------------------- compound upgrades
  U.openCompound = (r) => {
    U.compoundR = r;
    openModal('compound', '');
    renderCompound(true);
  };
  function compoundBody(r) {
    const s = U.state;
    const rs = s.rs[r];
    if (!rs || rs.owner !== 'g' + s.myGang || !rs.up) return '<p class="tab-intro">Your gang does not control this district.</p>';
    const up = rs.up, slots = rs.slots || [];
    const gc = s.gangColor;
    const nSlots = 2 + up.level;
    const bl = up.boca || 0, bs = BOCA.spend[bl];
    const perMin = Math.round((60 / BOCA.interval[bl]) * (bs[0] + bs[1]) / 2);
    const extraCap = EXTRA_SOLDIERS.base + EXTRA_SOLDIERS.perBarracks * (up.barracks || 0) + (U.world.regions[r].base ? EXTRA_SOLDIERS.mainBase : 0);
    const here = s.regionId === r;
    let html = `<div class="soldier-box"><b>SOLDIERS</b> ${rs.guards || 0} on duty · recruits ${rs.extra || 0}/${extraCap} <small>(recruit locals with G in your turf when your crew is full)</small>
      <button class="btn small" data-a="take" data-r="${r}" ${!here || !(rs.guards > 0) || (s.me.fol || 0) >= FOLLOWER_MAX ? 'disabled' : ''} title="${here ? '' : 'Go to this compound first'}">TAKE ONE AS CREW</button></div>
      <div class="boca-box"><b>BOCA DE FUMO</b> · level ${bl + 1}/4 · about <b>R$${perMin}/min</b> into the vault (more when the locals like you). Upgrade it below for more customers.</div>
      <p class="tab-intro">Spend the <b>gang vault</b> (${money(s.vault)}) on this compound's defenses. Turrets shoot raiders and rival gangs, and come back online ${60}s after being destroyed. Upgrades are lost if the district falls.</p><div class="slot-grid">`;
    for (let i = 0; i < 4; i++) {
      const sl = slots[i];
      if (i >= nSlots) { html += `<div class="tslot locked"><div class="c-name">SLOT ${i + 1}</div><div class="c-desc">Locked — buy <b>Fortify</b></div></div>`; continue; }
      if (!sl) {
        html += `<div class="tslot"><div class="c-name">SLOT ${i + 1} · EMPTY</div><div class="tchoices">${TURRET_IDS.map((t) => `<button class="btn tbtn" data-a="turret" data-r="${r}" data-s="${i}" data-type="${t}" ${s.vault < TURRETS[t].price ? 'disabled' : ''} title="${esc(TURRETS[t].desc)}"><img src="${turretIcon(t, gc)}"><span>${esc(TURRETS[t].name)}</span><small>${money(TURRETS[t].price)}</small></button>`).join('')}</div></div>`;
      } else {
        const T = TURRETS[sl.type];
        const upP = sl.mk < TURRET_MAX_MK ? turretUpgradePrice(sl.type, sl.mk) : 0;
        const hpf = sl.hpf ?? 1, rep = Math.ceil((1 - hpf) * T.price * TURRET_REPAIR_K / 10) * 10;
        html += `<div class="tslot built"><img class="timg" src="${turretIcon(sl.type, gc)}"><div class="c-name">${esc(T.name)} <i>Mk${sl.mk}</i></div><div class="c-desc">${esc(T.desc)} ${Math.round(T.dmg * turretMult(sl.mk))} dmg · range ${Math.round(T.range / TILE)}</div>
          <div class="bar thp"><div class="fill" style="width:${Math.round(hpf * 100)}%;background:${hpf > 0.6 ? '#3ddc84' : hpf > 0.3 ? '#ffd23f' : '#ff3b5c'}"></div><span>${Math.round(hpf * 100)}%</span></div>
          ${hpf < 1 ? `<button class="btn tiny" data-a="trep" data-r="${r}" data-s="${i}" ${s.vault < rep ? 'disabled' : ''}>REPAIR · ${money(rep)}</button>` : ''}
          <div class="row2">${sl.mk < TURRET_MAX_MK ? `<button class="btn" data-a="tup" data-r="${r}" data-s="${i}" ${s.vault < upP ? 'disabled' : ''}>Mk${sl.mk + 1} · ${money(upP)}</button>` : '<button class="btn" disabled>MAXED</button>'}</div>
          <div class="tchoices small">${TURRET_IDS.filter((t) => t !== sl.type).map((t) => `<button class="btn tiny" data-a="turret" data-r="${r}" data-s="${i}" data-type="${t}" ${s.vault < TURRETS[t].price ? 'disabled' : ''}>→ ${esc(TURRETS[t].name)} ${money(TURRETS[t].price)}</button>`).join('')}</div></div>`;
      }
    }
    html += '</div><div class="cards">';
    for (const id of COMPOUND_UP_IDS) {
      const U2 = COMPOUND_UPS[id];
      const lvl = up[id] || 0, max = U2.prices.length;
      const btn = lvl >= max ? '<button class="btn" disabled>MAXED</button>' : `<button class="btn" data-a="cup" data-r="${r}" data-u="${id}" ${s.vault < U2.prices[lvl] ? 'disabled' : ''}>BUY · ${money(U2.prices[lvl])}</button>`;
      html += `<div class="card mod"><div class="c-name">${esc(U2.name)}</div>${cardPips(lvl, max)}<div class="c-desc">${esc(U2.desc)}</div>${btn}</div>`;
    }
    return html + '</div>';
  }
  function renderCompound(force) {
    const s = U.state;
    if (!s) return;
    const r = U.compoundR;
    const key = JSON.stringify([r, s.vault, s.rs[r], s.regionId === r, s.me.fol]);
    const inner = $('#modal-inner');
    if (!force && inner._key === key) return;
    inner._key = key;
    const R = U.world.regions[r];
    inner.innerHTML = `<div class="panel-title">${esc(R.name.toUpperCase())} — COMPOUND <span class="money-top">COFRE ${money(s.vault)}</span><span class="close" data-close>✕</span></div>
      <div class="tab-body">${compoundBody(r)}</div>`;
  }

  $('#modal').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return U.closeModal();
    if (e.target.closest('[data-wpclear]')) { cb.onAction({ t: 'wp', clear: true }); cb.sound('click'); return; }
    const upg = e.target.closest('[data-upgrades]');
    if (upg) { U.openCompound(Number(upg.dataset.upgrades)); cb.sound('click'); return; }
    const t = e.target.closest('[data-tab]');
    if (t) { baseTab = t.dataset.tab; renderBase(true); cb.sound('click'); return; }
    const b = e.target.closest('[data-a]');
    if (b && !b.disabled) {
      const d = b.dataset;
      const a = { t: d.a };
      if (d.w) a.w = d.w; if (d.m) a.m = d.m; if (d.u) a.u = d.u; if (d.slot) a.slot = d.slot; if (d.v) a.v = d.a === 'buyV' ? d.v : Number(d.v);
      if (d.r) a.r = Number(d.r); if (d.s) a.s = Number(d.s); if (d.type) a.type = d.type; if (d.item) a.item = d.item; if (d.k) a.k = d.k; if (d.size) a.size = Number(d.size);
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
        ${s && s.seedCode ? `<div class="invite small">Map seed <b class="seed">${esc(s.seedCode)}</b></div>` : ''}
        <label class="vol">MUSIC <input type="range" min="0" max="100" value="${Math.round(getVolume('music') * 100)}" data-vol="music"></label>
        <label class="vol">SOUND FX <input type="range" min="0" max="100" value="${Math.round(getVolume('sfx') * 100)}" data-vol="sfx"></label>
        <div class="invite small">Neon Quebrada <b>v${VERSION}</b> — everyone in a room needs the same version</div>
        <div class="help">
          <p><b>Z</b> throw a grenade at the cursor · <b>C</b> switch grenade type · <b>TAB</b> map → click a district next to your turf to <b>send a raid</b></p>
          <p><b>WASD</b> move · <b>Mouse</b> aim · <b>LMB/RMB</b> left/right arm weapon</p>
          <p><b>Q / Space / Shift</b> dash · <b>E</b> nano-heal · <b>R</b> cloak · <b>F</b> shield</p>
          <p><b>V</b> get in / out of a flying vehicle · <b>G</b> recruit a local (or pet a cat / dog) · <b>B</b> base or compound menu (stand at a QG building to open its shop)</p>
          <p>At 0 HP you go <b>down</b>: crawl and wait for a gang-mate to hold <b>E</b> next to you (1:30 before you die, <b>X</b> to give up). Dying costs 25% of your cash and part of your XP.</p>
          <p><b>E</b> at a bar door to go in · <b>B</b> at the counter or the dealer · <b>1 2 3</b> use belt items · <b>T</b> dance</p>
          <p>Crimes that people see raise your <b>wanted stars</b>. Lose the cops, beat their response, or pay them off at the QG. Inside the QG walls nobody can shoot.</p>
          <p><b>TAB</b> map + waypoints · <b>Enter</b> chat · <b>M</b> mute music</p>
        </div>
        <button class="btn" data-set="stats">GAME STATS</button>
        <button class="btn" data-set="quality">GRAPHICS: ${s && s.quality === 'low' ? 'LOW (faster)' : 'HIGH'}</button>
        <button class="btn" data-set="blood">BLOOD: ${s && s.blood === false ? 'OFF' : 'ON'}</button>
        ${s && s.isHost ? '<button class="btn" data-set="save">SAVE NOW</button>' : ''}
        <button class="btn danger" data-set="leave">${s && s.isHost ? 'SAVE & QUIT TO TITLE' : 'LEAVE GAME'}</button>
      </div>`);
  };

  // ESC → GAME STATS: your numbers for the whole game (saved with your character)
  U.showStats = (st) => {
    if (!st) {
      openModal('stats', '<div class="panel-title">GAME STATS <span class="close" data-close>✕</span></div><div class="stats-body"><p class="small">Loading...</p></div>');
      return;
    }
    if (U.open !== 'stats') return;
    const n = (v) => Math.round(v || 0).toLocaleString('en-US');
    const time = (v) => { v = Math.round(v || 0); const h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60; return h ? `${h}h ${m}m` : `${m}m ${v % 60}s`; };
    const acc = st.shots > 0 ? Math.round(100 * Math.min(1, st.hits / st.shots)) + '%' : '—';
    const kd = st.deaths > 0 ? (st.kills / st.deaths).toFixed(2) : st.kills > 0 ? '∞' : '—';
    const groups = [
      ['COMBAT', [['Kills', n(st.kills)], ['Bosses', n(st.bosses)], ['Rival players', n(st.rivals)], ['Cops', n(st.cops)], ['ETs', n(st.aliens)], ['Kills / deaths', kd], ['Damage dealt', n(st.dmgOut)], ['Damage taken', n(st.dmgIn)], ['Gun accuracy', acc], ['Grenades thrown', n(st.gren)]]],
      ['SURVIVAL', [['Times down', n(st.downs)], ['Deaths', n(st.deaths)], ['Gang-mates revived', n(st.revives)], ['Highest wanted', st.maxStars ? '★'.repeat(st.maxStars) : '—']]],
      ['TURF', [['Districts taken', n(st.captures)], ['Raids beaten', n(st.raidsWon)], ['Squads sent', n(st.squads)], ['Locals recruited', n(st.recruits)], ['Crew lost', n(st.crewLost)], ['Crew now', n(st.crew)]]],
      ['STREETS', [['Time played', time(st.time)], ['Distance walked', n(st.dist) + ' m'], ['Money earned', 'R$' + n(st.earned)], ['Money spent', 'R$' + n(st.spent)], ['Cash now', 'R$' + n(st.cash)], ['Cars stolen', n(st.steals)], ['Drinks & stims bought', n(st.drinks)], ['Pets petted', n(st.pets)], ['Level', n(st.level)]]],
    ];
    const html = groups.map(([t, rows]) => `<div class="stats-group"><div class="stats-h">${t}</div>${rows.map(([k, v]) => `<div class="stats-row"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`).join('');
    openModal('stats', `<div class="panel-title">GAME STATS <span class="close" data-close>✕</span></div>
      <div class="stats-body"><div class="stats-grid">${html}</div>
      <p class="small">Your numbers for this whole game. They are kept in the save with your character.</p>
      <button class="btn" data-set="menu">BACK</button></div>`);
  };

  U.showVictory = (o) => {
    openModal('victory', `<div class="panel-title">${o.mine ? 'A CIDADE É NOSSA!' : 'FIM DE JOGO'}</div>
      <div class="victory-body"><p>${esc(o.text)}</p>
      ${o.stats ? `<p>Kills ${o.stats.kills} · Captures ${o.stats.captures} · Bosses ${o.stats.bosses} · Raids beaten ${o.stats.raidsBeaten || 0} · Deaths ${o.stats.deaths}</p>` : ''}
      <p class="small">Keep playing to hold the city, or start a new game from the title screen for a brand-new map.</p>
      <button class="btn big" data-close>KEEP PLAYING</button></div>`);
  };

  U.isOpen = () => U.open;
  return U;
}
