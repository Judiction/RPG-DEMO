// App flow: title screen, hosting/joining, the game loop, prediction, events → effects/sounds.
//
// Networking model (host-authoritative, peer-to-peer via PeerJS):
//   - The host's browser runs the real simulation (game.js): enemies, damage, money, territory, vehicles.
//   - Each player moves their own character (or drives their own vehicle) locally and sends position + aim + buttons.
//   - The host sends each friend a snapshot ~20x/s with what is near them, plus events (shots, hits...).
//   - The city is generated from a seed + map options, so the host never sends the map.

import {
  TILE, WEAPONS, ABILITIES, randomLook, LOOK_KEYS, LOOK_OPTIONS, GANG_COLORS, NAME_COLORS, VEHICLES, VEHICLE_IDS,
  TURRET_IDS, MAP_SIZES, FACTIONS, GANG_DEFAULT_NAMES, RECOIL, BAR_ROOM, ITEMS, WANTED, isMech, DOWN, WITHDRAW, VERSION,
  GRENADES, GRENADE_IDS, GREN_RANGE,
} from './data.js';
import { randomSeed } from './rng.js';
import { generateWorld, moveBox, regionAt, rayCast, opaqueAt } from './world.js';
import * as G from './game.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createUI, seedCode } from './ui.js';
import { initAudio, sfx, setListener, setVolume, setEngine } from './audio.js';
import { createMusic } from './music.js';
import { PROTOCOL, makeCode, cleanCode, send, receiver, hostRoom, joinRoom, errorText } from './net.js';

const OLD_SAVE_KEY = 'neonquebrada.save.v1';
const SLOTS_KEY = 'neonquebrada.slots.v2';
const SLOT_KEY = (i) => 'neonquebrada.slot.' + i;
const PREFS_KEY = 'neonquebrada.prefs.v1';
const PKEY = 'neonquebrada.pkey';
const STEP = 1 / 60;
const MAX_PLAYERS = 6;
const AUTOSAVE = 60;              // seconds between autosaves (also saves on captures, losses and leaves)
const STALE = 2.5;                // a connection silent for this long can be taken over by a rejoining player
const TIMEOUT = 15;               // drop clients silent for this long

// ------------------------------------------------------------------ prefs / storage
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const prefs = Object.assign({ name: '', look: randomLook(), gangName: '', gangColor: GANG_COLORS[0], color: NAME_COLORS[0], music: 0.6, sfx: 0.8, quality: 'high', blood: true }, store.get(PREFS_KEY) || {});
for (const k of LOOK_KEYS) if (!(prefs.look[k] >= 0 && prefs.look[k] < LOOK_OPTIONS[k].length)) prefs.look[k] = 0;
if (!NAME_COLORS.includes(prefs.color)) prefs.color = NAME_COLORS[0];
if (!GANG_COLORS.includes(prefs.gangColor)) prefs.gangColor = GANG_COLORS[0];
let playerKey = store.get(PKEY);
if (!playerKey) { playerKey = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set(PKEY, playerKey); }
setVolume('music', prefs.music); setVolume('sfx', prefs.sfx);

// save slots: a small index + one key per slot
function slotsMeta() {
  let meta = store.get(SLOTS_KEY);
  if (!Array.isArray(meta)) meta = [null, null, null, null, null];
  const old = store.get(OLD_SAVE_KEY);
  if (old && old.v === 1 && !meta.some(Boolean)) {
    // first version's single save becomes slot 1 (coastal, medium, PvE)
    old.mode = 'pve'; old.map = { type: 'coastal', size: 'M' };
    if (store.set(SLOT_KEY(0), old)) { meta[0] = metaOf(old); store.set(SLOTS_KEY, meta); store.del(OLD_SAVE_KEY); }
  }
  return meta;
}
const metaOf = (s) => ({ mode: s.king ? 'king' : s.mode || 'pve', map: s.map || { type: 'coastal', size: 'M' }, gangName: s.gangName, owned: s.owned, total: s.total, savedAt: s.savedAt });

// ------------------------------------------------------------------ app state
const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
renderer.quality = prefs.quality === 'low' ? 'low' : 'high';
renderer.bloodOn = prefs.blood !== false;
const input = createInput(canvas);
window.addEventListener('resize', () => renderer.resize());

const app = {
  mode: 'title',            // title | host | client
  world: null, game: null, myId: 'host', roomCode: null, slot: 0, mapOpts: null,
  local: { x: 0, y: 0, aim: 0, dashT: 0, dashX: 0, dashY: 0, moving: false, vx: 0, vy: 0, ix: 0, iy: 0, wx: 0, wy: 0, lastDx: 0, lastDy: 1, bar: -1, bx: 0, by: 0, barT: 0 },
  menuOpen: false, typing: false, music: null, musicOn: true, grenSel: 'impact',
  titleCam: { t: 0 }, saveT: 0, sendT: 0, snapT: 0, acc: 0, intensityT: 0, trackKey: '',
  chats: new Map(),
};
const host = { peer: null, clients: new Map() };
const client = {
  peer: null, conn: null, players: new Map(), enemies: new Map(), allies: new Map(), pickups: new Map(), turrets: new Map(), vehicles: new Map(), civs: new Map(), pcars: new Map(), helis: new Map(), pets: new Map(), ufo: null, projectiles: [],
  me: null, prof: null, rg: null, roster: new Map(), day: 0.3, cd: { L: 0, R: 0 }, radar: [], broken: new Set(), mode: 'pve', seed: 0,
};

const ui = createUI(document.getElementById('menus'), {
  prefs,
  savePrefs: () => store.set(PREFS_KEY, prefs),
  sound: (n) => sfx(n),
  onHost: (o) => { unlockAudio(); startHost(o); },
  onLoad: (i) => { unlockAudio(); loadSlot(i); },
  onDeleteSave: (i) => { const m = slotsMeta(); m[i] = null; store.set(SLOTS_KEY, m); store.del(SLOT_KEY(i)); ui.showSaves(m); },
  onJoin: (code) => { unlockAudio(); startJoin(code); },
  onAction: (a) => sendAction(a),
  onChat: (text) => sendChat(text),
  onSwitchGang: () => requestGangSwitch(),
  setTyping: (v) => { app.typing = v; input.typing = v; },
  setMenuOpen: (v) => { app.menuOpen = v; },
  copyInvite,
  onVolume: (k, v) => { setVolume(k, v); prefs[k] = v; store.set(PREFS_KEY, prefs); },
  onSetting: (k) => {
    if (k === 'invite') copyInvite();
    if (k === 'leave') leaveGame();
    if (k === 'save') { saveNow(); ui.toast('Game saved.', 'good'); }
    if (k === 'blood') { prefs.blood = renderer.bloodOn = !renderer.bloodOn; if (!renderer.bloodOn) renderer.stains.length = 0; store.set(PREFS_KEY, prefs); ui.toast(`Blood: ${renderer.bloodOn ? 'ON' : 'OFF'}`, 'good'); ui.togglePause(); ui.togglePause(); }
    if (k === 'stats') { sendAction({ t: 'stats' }); ui.showStats(null); }
    if (k === 'menu') { ui.closeModal(); ui.togglePause(); }
    if (k === 'quality') { prefs.quality = renderer.quality = renderer.quality === 'low' ? 'high' : 'low'; store.set(PREFS_KEY, prefs); ui.toast(`Graphics: ${renderer.quality.toUpperCase()}`, 'good'); }
  },
});

// first interaction unlocks audio and starts the music
function unlockAudio() {
  const ac = initAudio();
  if (!ac) return;
  if (!app.music) { app.music = createMusic(randomSeed()); }
  if (app.music && app.musicOn && !app.music.playing) app.music.start();
}
window.addEventListener('pointerdown', unlockAudio, { once: false });
window.addEventListener('keydown', unlockAudio, { once: false });

// ------------------------------------------------------------------ title
function setupTitle() {
  app.mode = 'title';
  app.world = generateWorld(randomSeed());
  renderer.setWorld(app.world);
  const C = app.world.regions[app.world.baseId].compound;
  app.titleCam = { t: 0, x: (C.coreX + 0.5) * TILE, y: (C.coreY + 0.5) * TILE, a: Math.random() * 6.28 };
  renderer.snapCam = true;
  ui.showTitle();
  ui.showSaves(slotsMeta());
  setEngine(0);
  if (app.music) app.music.setTrack('volt', 12345);
  const room = cleanCode(new URLSearchParams(location.search).get('room'));
  if (room.length === 4) { ui.setCode(room); ui.status(`Invite for room ${room} — pick a name and press JOIN.`); }
  else ui.status('');
}

// ------------------------------------------------------------------ hosting
async function startHost(o) {
  ui.status('Building the city...');
  await new Promise((r) => setTimeout(r, 20));
  const king = o.mode === 'king';
  const mode = king ? 'pvp' : o.mode;
  const bases = mode === 'pvp' ? MAP_SIZES[o.size].bases : 1;
  const world = o.world && o.world.seed === o.seed ? o.world : generateWorld(o.seed, { type: o.type, size: o.size, bases, king });
  const game = G.createGame(world, { mode, gangIdx: o.gangIdx, gangName: o.gangName, king, kingTime: o.kingTime });
  app.slot = o.slot;
  beginHosting(world, game, { type: o.type, size: o.size, bases, king: king || undefined }, o.gangIdx);
}

async function loadSlot(i) {
  const s = store.get(SLOT_KEY(i));
  if (!s) { ui.status('That save could not be read.', true); return; }
  ui.status('Loading the city...');
  await new Promise((r) => setTimeout(r, 20));
  const mode = s.mode || 'pve';
  const map = s.map || { type: 'coastal', size: 'M' };
  const bases = mode === 'pvp' ? MAP_SIZES[map.size].bases : 1;
  const world = generateWorld(s.seed, { type: map.type, size: map.size, bases, king: !!map.king });
  const game = G.createGame(world, { mode, save: s, king: !!s.king, kingTime: (s.kingGoal || 600) / 60 });
  app.slot = i;
  beginHosting(world, game, { type: map.type, size: map.size, bases, king: map.king || undefined }, null);
}

async function beginHosting(world, game, mapOpts, gangIdx) {
  app.mode = 'host'; app.world = world; app.game = game; app.myId = 'host'; app.mapOpts = mapOpts;
  app.saveT = 0;
  renderer.setWorld(world);
  renderer.snapCam = true;
  const join = (idx) => {
    const p = G.addPlayer(game, { id: 'host', key: playerKey, name: prefs.name || 'Mano', look: { ...prefs.look }, color: prefs.color, gang: idx, gangName: prefs.gangName || undefined });
    if (typeof p === 'string') { ui.showGangPicker(G.gangChoices(game), 'PICK YOUR GANG', join); return; }
    app.local.x = p.x; app.local.y = p.y;
    renderer.snapCam = true;
    saveNow();
  };
  ui.showHUD(world);
  join(game.mode === 'pvp' ? gangIdx ?? undefined : undefined);
  game.events = game.events.filter((e) => e.t === 'msg' && e.to === 'host');
  const main = [...game.gangs.values()][0];
  ui.log(game.king ? `<b>REI DA BOCA!</b> Fight your way to the BOCA KING in the middle of the city and hold it for ${Math.round(game.kingGoal / 60)} minutes in total to win. The factions want it too.` : game.mode === 'pvp' ? '<b>Gang war!</b> Friends pick their gang color when they join. Take rival bases or 60% of the city.' : `Welcome to <b>${escapeHtml(main ? main.name : '')}</b>. Take the city, one district at a time.`, 'gold');
  ui.log('Kill the garrison of a nearby district, then stand on its core. Press <b>V</b> near a flying vehicle to drive it.', 'info');
  // open the online room
  const code = makeCode();
  try {
    host.peer = await hostRoom(code);
    app.roomCode = code;
    host.peer.on('connection', onConnection);
    host.peer.on('disconnected', () => { try { host.peer.reconnect(); } catch { /* ignore */ } });
    ui.log(`Room <b>${code}</b> is open. Press ESC → copy invite link for your friends.`, 'info');
  } catch (err) {
    app.roomCode = null;
    ui.log(`Online room failed (${escapeHtml(errorText(err))}). Playing solo.`, 'warn');
  }
}

function onConnection(conn) {
  conn.on('open', () => {
    host.clients.set(conn.peer, { conn, joined: false, outbox: [], rosterVer: 0, regionVer: 0, brokeVer: 0, rgT: 0, last: performance.now() / 1000 });
  });
  conn.on('data', receiver((msg) => onClientMsg(conn.peer, msg)));
  conn.on('close', () => dropClient(conn.peer));
  conn.on('error', () => dropClient(conn.peer));
}

function dropClient(id) {
  const c = host.clients.get(id);
  if (!c) return;
  host.clients.delete(id);
  try { c.conn.close(); } catch { /* ignore */ }
  if (c.joined && app.game) { G.removePlayer(app.game, id); saveNow(); }
}

function onClientMsg(id, msg) {
  const c = host.clients.get(id);
  const game = app.game;
  if (!c || !game || !msg) return;
  c.last = performance.now() / 1000;
  if (msg.t === 'hello') {
    if (msg.proto !== PROTOCOL || msg.ver !== VERSION) { send(c.conn, { t: 'err', text: `Version mismatch: the host runs v${VERSION}, you run v${msg.ver || '?'}. Refresh the page (Ctrl+F5) so you both have the same version.` }); return; }
    let key = String(msg.key || id).slice(0, 60);
    const name = String(msg.name || 'Mano').slice(0, 14);
    const now = performance.now() / 1000;
    // Someone rejoining after closing their tab: take over their old (stale) connection so they keep their character.
    for (const [cid, c2] of [...host.clients]) {
      if (cid === id || !c2.joined) continue;
      const p2 = game.players.get(cid);
      if (!p2) continue;
      const sameKey = p2.key === key, sameName = p2.name.toLowerCase() === name.toLowerCase();
      if ((sameKey || sameName) && now - c2.last > STALE) dropClient(cid);
    }
    const hostP = game.players.get('host');
    if ([...game.players.values()].some((p) => p.key === key) || (hostP && hostP.key === key)) key += '-' + id.slice(0, 4);
    if (game.players.size >= MAX_PLAYERS) { send(c.conn, { t: 'full' }); setTimeout(() => c.conn.close(), 300); return; }
    c.hello = { key, name, look: msg.look && typeof msg.look === 'object' ? msg.look : randomLook(), color: msg.color, gangName: msg.gangName };
    tryJoin(id, c, undefined);
    return;
  }
  if (msg.t === 'gang' && c.hello && !c.joined) { tryJoin(id, c, msg.idx | 0); return; }
  if (msg.t === 'gangs?') { send(c.conn, { t: 'pick', choices: G.gangChoices(game), sw: true }); return; }
  if (!c.joined) return;
  if (msg.t === 'i') G.setInput(game, id, msg);
  else if (msg.t === 'ab') G.useAbility(game, id, msg.k);
  else if (msg.t === 'act') G.handleAction(game, id, msg.a);
  else if (msg.t === 'chat') {
    const p = game.players.get(id);
    if (p) G.emit(game, { t: 'chat', id, name: p.name, text: String(msg.text).slice(0, 80), g: game.mode === 'pvp' && msg.team ? p.gang : undefined });
  }
}

function tryJoin(id, c, gang) {
  const game = app.game;
  const h = c.hello;
  const p = G.addPlayer(game, { id, key: h.key, name: h.name, look: h.look, color: h.color, gang, gangName: h.gangName });
  if (typeof p === 'string') { send(c.conn, { t: 'pick', choices: G.gangChoices(game) }); return; }
  c.joined = true;
  send(c.conn, {
    t: 'welcome', id, seed: game.seed, map: app.mapOpts, mode: game.mode, rg: G.regionState(game), ro: G.roster(game), prof: G.profile(p), me: G.privateState(game, p),
    x: p.x, y: p.y, day: game.dayT, seedCode: seedCode(app.mapOpts.type, app.mapOpts.size, game.seed),
  });
  c.rosterVer = game.rosterVer; c.regionVer = game.regionVer; c.brokeVer = game.brokeVer;
}

function hostTick(dt) {
  const game = app.game;
  G.setInput(game, 'host', { x: app.local.x, y: app.local.y, aim: app.local.aim, fireL: app.fireL, fireR: app.fireR, bx: app.local.bx, by: app.local.by, rev: app.revHeld });
  app.acc += dt;
  let steps = 0;
  while (app.acc >= STEP && steps < 5) { G.step(game, STEP); app.acc -= STEP; steps++; }
  if (steps >= 5) app.acc = 0;
  // events
  const evs = game.events;
  game.events = [];
  let saveSoon = false;
  for (const ev of evs) {
    if (!ev.to || ev.to === 'host') handleEvent(ev);
    for (const [id, c] of host.clients) if (c.joined && (!ev.to || ev.to === id)) c.outbox.push(ev);
    if (ev.t === 'cap' || ev.t === 'lost' || ev.t === 'gangout' || ev.t === 'win') saveSoon = true;
  }
  // drop silent clients
  const now = performance.now() / 1000;
  for (const [id, c] of host.clients) if (now - c.last > TIMEOUT) dropClient(id);
  // snapshots
  app.snapT += dt;
  if (app.snapT >= 0.05) {
    app.snapT = 0;
    for (const [id, c] of host.clients) {
      if (!c.joined) continue;
      const p = game.players.get(id);
      if (!p) continue;
      const snap = G.buildSnapshot(game, id);
      const vx = 34 * TILE, vy = 24 * TILE;
      snap.ev = c.outbox.filter((e) => e.x === undefined || (Math.abs(e.x - p.x) < vx && Math.abs(e.y - p.y) < vy));
      c.outbox = [];
      if (c.rosterVer !== game.rosterVer) { snap.ro = G.roster(game); c.rosterVer = game.rosterVer; }
      c.rgT += 0.05;
      if (((c.regionVer !== game.regionVer || c.brokeVer !== game.brokeVer) && c.rgT > 0.25) || c.rgT > 2) { snap.rg = G.regionState(game); c.regionVer = game.regionVer; c.brokeVer = game.brokeVer; c.rgT = 0; }
      if (p.dirty) { snap.prof = G.profile(p); p.dirty = false; }
      send(c.conn, snap);
    }
  }
  app.saveT += dt;
  if (app.saveT > AUTOSAVE || (saveSoon && app.saveT > 5)) { app.saveT = 0; saveNow(true); }
}

function saveNow(auto = false) {
  if (app.mode !== 'host' || !app.game) return;
  const s = G.serialize(app.game);
  if (store.set(SLOT_KEY(app.slot), s)) {
    const m = slotsMeta(); m[app.slot] = metaOf(s); store.set(SLOTS_KEY, m);
    ui.saved();
    if (auto) sfx('save');
  }
}

// ------------------------------------------------------------------ joining
async function startJoin(raw) {
  const code = cleanCode(raw);
  if (code.length !== 4) { ui.status('Type the 4-letter room code.', true); return; }
  ui.status(`Connecting to room ${code}...`);
  try {
    const { peer, conn } = await joinRoom(code);
    client.peer = peer; client.conn = conn;
    conn.on('data', receiver(onHostMsg));
    conn.on('close', () => { if (app.mode === 'client' || client.conn === conn) hostLost('The host closed the game.'); });
    send(conn, { t: 'hello', proto: PROTOCOL, ver: VERSION, name: prefs.name || 'Mano', look: prefs.look, key: playerKey, color: prefs.color, gangName: prefs.gangName || undefined });
    app.roomCode = code;
    ui.status('Joining...');
  } catch (err) {
    ui.status(errorText(err), true);
  }
}

function hostLost(text) {
  if (app.mode !== 'client') { if (client.peer) { client.peer.destroy(); client.peer = null; } return; }
  cleanupClient();
  setupTitle();
  ui.status(text, true);
}

function cleanupClient() {
  try { client.conn && client.conn.close(); } catch { /* ignore */ }
  try { client.peer && client.peer.destroy(); } catch { /* ignore */ }
  client.peer = null; client.conn = null;
  for (const m of [client.players, client.enemies, client.allies, client.pickups, client.turrets, client.vehicles, client.civs, client.pcars, client.helis, client.pets]) m.clear();
  client.ufo = null;
  client.projectiles = [];
  client.me = null; client.prof = null; client.rg = null;
}

function onHostMsg(msg) {
  if (!msg) return;
  if (msg.t === 'full') { hostLost('That room is full (6 players max).'); return; }
  if (msg.t === 'err') { hostLost(msg.text); return; }
  if (msg.t === 'pick') {
    const title = msg.sw ? 'JOIN ANOTHER GANG' : 'PICK YOUR GANG';
    if (msg.sw) ui.showGangPicker(msg.choices, title, (idx) => send(client.conn, { t: 'act', a: { t: 'switchGang', idx, name: prefs.gangName || undefined } }));
    else { ui.status('Pick your gang...'); ui.showGangPicker(msg.choices, title, (idx) => send(client.conn, { t: 'gang', idx })); }
    return;
  }
  if (msg.t === 'welcome') {
    app.mode = 'client';
    app.myId = msg.id;
    app.mapOpts = msg.map;
    app.seedCode = msg.seedCode;
    app.world = generateWorld(msg.seed, msg.map || {});
    client.seed = msg.seed;
    client.mode = msg.mode;
    renderer.setWorld(app.world);
    renderer.snapCam = true;
    app.local.x = msg.x; app.local.y = msg.y;
    client.rg = unpackRegions(msg.rg);
    client.roster = new Map(msg.ro.map((r) => [r.id, r]));
    client.prof = msg.prof; client.me = msg.me; client.day = msg.day;
    ui.showHUD(app.world);
    const g = client.rg.gangs.find((x) => x.idx === msg.me.g);
    ui.log(`Joined <b>${escapeHtml(g ? g.name : 'the gang')}</b>! ${msg.mode === 'pvp' ? 'Gang war — rival gangs are enemies.' : 'Take the city together.'}`, 'gold');
    return;
  }
  if (app.mode !== 'client') return;
  if (msg.t === 's') applySnapshot(msg);
}

function unpackRegions(rg) {
  return {
    mode: rg.mode,
    rs: rg.rs.map((a) => {
      const r = {
        owner: G.ownerFromCode(a[0]), garrison: a[1], garrisonMax: a[2], capture: a[3] / 100, guards: a[4], hqUnlocked: !!(a[5] & 1), bossDefeated: !!(a[5] & 2), atk: !!(a[5] & 4), shield: !!(a[5] & 8),
        capBy: a[6] === 99 ? 'raid' : a[6] >= 0 ? G.ownerFromCode(a[6]) : null,
      };
      if (a[7]) { r.up = { level: a[7][0], walls: a[7][1], barracks: a[7][2], medic: a[7][3], pad: a[7][4], radar: a[7][5], boca: a[7][6] || 0 }; r.slots = a[8].map((x) => (x ? { type: TURRET_IDS[x[0]], mk: x[1], hpf: (x[2] ?? 100) / 100 } : null)); r.extra = a[9] || 0; }
      return r;
    }),
    raids: rg.raids.map((a) => ({ target: a[0], f: a[1], state: a[2] ? 'active' : 'warn', t: a[3], g: a[4] >= 0 ? a[4] : null, size: a[5], kind: a[6] ?? -1 })).filter((r) => r.kind < 0),
    squads: rg.raids.filter((a) => a[6] >= 0 && a[6] < 10).map((a) => ({ target: a[0], by: a[6], t: a[3], size: a[5] })), king: rg.king || null,
    gangs: rg.gangs, def: rg.def, win: rg.win, broken: new Set(rg.br || []),
  };
}

function syncMap(map, rows, make, upd) {
  const seen = new Set();
  for (const r of rows) {
    seen.add(r[0]);
    let o = map.get(r[0]);
    if (!o) { o = make(r); map.set(r[0], o); }
    upd(o, r);
  }
  for (const k of map.keys()) if (!seen.has(k)) map.delete(k);
}

function applySnapshot(s) {
  client.day = s.day;
  const prevVeh = client.me ? client.me.veh : 0;
  client.me = s.me;
  if (s.prof) client.prof = s.prof;
  if (s.ro) client.roster = new Map(s.ro.map((r) => [r.id, r]));
  if (s.rg) client.rg = unpackRegions(s.rg);
  client.radar = s.rc || [];
  syncMap(client.players, s.P, (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => {
    o.tx = r[1]; o.ty = r[2]; o.aim = r[3]; o.hp = r[4]; o.maxHp = r[5];
    o.dead = !!(r[6] & 1); o.cloak = !!(r[6] & 2); o.shield = !!(r[6] & 4); o.inv = !!(r[6] & 8); o.burn = !!(r[6] & 16); o.out = !!(r[6] & 32);
    o.level = r[7]; o.veh = r[8] || 0; o.seat = r[9];
    o.ghost = !!(r[6] & 64); o.cops = !!(r[6] & 128);
    o.bar = r[10] ?? -1; o.tbx = r[11]; o.tby = r[12]; o.emote = r[13] || 0; o.stars = r[14] || 0;
    o.down = !!(r[6] & 256); o.revP = (r[15] || 0) / 100; o.downT = r[16] || 0;
    if (o.bx === undefined || o.bar !== o.lastBar) { o.bx = o.tbx; o.by = o.tby; o.lastBar = o.bar; }
  });
  syncMap(client.enemies, s.E, (r) => ({ id: r[0], x: r[2], y: r[3] }), (o, r) => {
    o.faction = Math.floor(r[1] / 10); const t = r[1] % 10; o.boss = t === 6; o.tier = o.boss ? 5 : t;
    o.tx = r[2]; o.ty = r[3]; o.hp = r[4]; o.maxHp = r[5];
    o.windup = r[6] & 1; o.flash = r[6] & 2 ? 0.1 : 0; o.raid = !!(r[6] & 4); o.moving = !!(r[6] & 8); o.burn = !!(r[6] & 16);
    o.stars = r[7]; o.aim = r[8]; o.atk = G.ATTACK_KEYS[r[9]]; o.stunT = r[6] & 32 ? 1 : 0;
  });
  syncMap(client.allies, s.A, (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => {
    o.tx = r[1]; o.ty = r[2]; o.hp = r[3]; o.maxHp = r[4]; o.flash = r[5] & 2 ? 0.1 : 0; o.moving = !!(r[5] & 8); o.aim = r[6];
    o.team = r[7]; o.follow = r[8] || null; o.tier = r[9]; o.civ = r[10] || 0; o.melee = !!r[11]; o.lvl = r[12] || 1; o.rev = !!r[13]; o.emote = r[14] || 0;
  });
  syncMap(client.turrets, s.T || [], (r) => ({ id: r[0] }), (o, r) => {
    o.x = r[1]; o.y = r[2]; o.aim = r[3]; o.hp = r[4]; o.maxHp = r[5]; o.type = TURRET_IDS[r[6]]; o.mk = r[7]; o.team = r[8]; o.dead = !!(r[9] & 1); o.flash = !!(r[9] & 2);
  });
  syncMap(client.vehicles, s.V || [], (r) => ({ id: r[0], x: r[2], y: r[3] }), (o, r) => {
    o.type = VEHICLE_IDS[r[1]]; o.tx = r[2]; o.ty = r[3]; o.hp = r[4]; o.maxHp = r[5]; o.charge = r[6]; o.dir = r[7];
    o.flying = !!(r[8] & 1); o.flash = !!(r[8] & 2); o.charging = !!(r[8] & 4); o.civ = r[8] & 8 ? 1 : 0; o.team = r[9]; o.seats = r.slice(10).map((x) => x || null);
  });
  syncMap(client.civs, s.C || [], (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => {
    o.tx = r[1]; o.ty = r[2]; o.seed = r[3]; o.flee = !!(r[4] & 1); o.flash = !!(r[4] & 2); o.moving = !!(r[4] & 4); o.aim = r[5]; o.hpPct = r[6];
  });
  syncMap(client.pickups, s.K, (r) => ({ id: r[0] }), (o, r) => { o.type = ['cash', 'heal', 'ufo'][r[1]] || 'heal'; o.x = r[2]; o.y = r[3]; });
  syncMap(client.pets, s.PT || [], (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => { o.tx = r[1]; o.ty = r[2]; o.kind = r[3] ? 'cat' : 'dog'; o.seed = r[4]; o.moving = !!(r[5] & 1); o.flee = !!(r[5] & 2); o.happy = !!(r[5] & 4); o.sit = !!(r[5] & 8); o.aim = r[6]; });
  if (s.U) { const u = client.ufo && client.ufo.id === s.U[4] ? client.ufo : { id: s.U[4], x: s.U[0], y: s.U[1] }; u.tx = s.U[0]; u.ty = s.U[1]; u.state = ['warn', 'beam', 'hover', 'leave'][s.U[2]]; u.t = s.U[3]; client.ufo = u; } else client.ufo = null;
  syncMap(client.pcars, s.PC || [], (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => { o.tx = r[1]; o.ty = r[2]; o.dir = r[3]; o.state = r[4]; });
  syncMap(client.helis, s.HE || [], (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => { o.tx = r[1]; o.ty = r[2]; o.aim = r[3]; o.kind = r[4] ? 'rocket' : 'mg'; o.atk = !!r[5]; });
  if (client.me.veh && client.me.veh !== prevVeh) { const v = client.vehicles.get(client.me.veh); if (v) { app.local.x = v.tx; app.local.y = v.ty; app.local.vx = app.local.vy = 0; } }
  if (s.ev) for (const ev of s.ev) handleEvent(ev);
}

function clientTick(dt) {
  // interpolate others
  const k = Math.min(1, dt * 14);
  for (const o of client.players.values()) if (o.tbx !== undefined && o.bx !== undefined) { o.bx += (o.tbx - o.bx) * k; o.by += (o.tby - o.by) * k; }
  for (const m of [client.players, client.enemies, client.allies, client.vehicles, client.civs, client.pcars, client.helis, client.pets]) for (const o of m.values()) {
    if (o.tx === undefined) continue;
    if (Math.abs(o.tx - o.x) > 160 || Math.abs(o.ty - o.y) > 160) { o.x = o.tx; o.y = o.ty; }
    o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
  }
  if (client.ufo) { const u = client.ufo; u.x += (u.tx - u.x) * k; u.y += (u.ty - u.y) * k; u.t = Math.max(0, u.t - dt); }
  // cosmetic projectiles
  const keep = [];
  for (const p of client.projectiles) {
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0 || opaqueAt(app.world, p.x, p.y)) continue;
    if (p.local) {
      let hit = false;
      for (const e of client.enemies.values()) if (Math.abs(e.x - p.x) < 8 && Math.abs(e.y - 6 - p.y) < 10) { hit = true; break; }
      if (hit) continue;
    }
    keep.push(p);
  }
  client.projectiles = keep;
  // send input ~30 Hz (also acts as the heartbeat)
  app.sendT += dt;
  if (app.sendT >= 0.033 && client.conn) {
    app.sendT = 0;
    const inp = { t: 'i', x: +app.local.x.toFixed(1), y: +app.local.y.toFixed(1), aim: +app.local.aim.toFixed(3), fireL: app.fireL, fireR: app.fireR, rev: app.revHeld };
    if (app.local.bar >= 0) { inp.bx = +app.local.bx.toFixed(1); inp.by = +app.local.by.toFixed(1); }
    send(client.conn, inp);
  }
  // local predicted attacks (visual only; the host decides hits)
  if (client.me && !client.me.dead && client.prof && !(client.me.veh && client.me.seat === 0)) {
    for (const slot of ['L', 'R']) {
      client.cd[slot] -= dt;
      const firing = slot === 'L' ? app.fireL : app.fireR;
      if (firing && client.cd[slot] <= 0) {
        const wid = client.prof.equip[slot];
        client.cd[slot] = WEAPONS[wid].cd * (client.prof.rof || 1);
        predictFire(slot, wid);
      }
    }
  }
}

function kick(a, k) { app.local.ix -= Math.cos(a) * k; app.local.iy -= Math.sin(a) * k; }

function predictFire(slot, wid) {
  const Wp = WEAPONS[wid];
  const L = app.local, a = L.aim;
  if (RECOIL[wid] && !myVehicle()) kick(a, RECOIL[wid]);
  if (Wp.kind === 'ranged' || Wp.kind === 'rocket' || Wp.kind === 'beam') renderer.light(L.x + Math.cos(a) * 12, L.y - 8 + Math.sin(a) * 12, wid === 'shotgun' || wid === 'rocket' || wid === 'rail' ? 90 : 60, '#ffd08a', 0.07, 1.4);
  const lift = myVehicle() && myVehicle().flying ? 12 : 0;
  const ox = L.x + Math.cos(a) * 6, oy = L.y - 8 - lift + Math.sin(a) * 6;
  const key = 'p' + app.myId;
  if (Wp.kind === 'melee') {
    renderer.swing(key, slot, a, wid);
    renderer.effect({ k: 'arc', x: L.x, y: L.y - 7 - lift, a, arc: Wp.arc, r: Wp.range * 0.8, c: wid === 'blade' ? '#ff3fa4' : '#c9d3df', life: 0.12 });
    sfx(wid === 'blade' ? 'slash' : 'punch');
  } else if (Wp.kind === 'ranged') {
    const n = Wp.pellets || 1;
    for (let i = 0; i < n; i++) {
      const sa = a + (n > 1 ? (i / (n - 1) - 0.5) * Wp.spread : (Math.random() - 0.5) * Wp.spread);
      const sp = Wp.speed * (n > 1 ? 0.85 + Math.random() * 0.3 : 1);
      client.projectiles.push({ x: ox, y: oy, vx: Math.cos(sa) * sp, vy: Math.sin(sa) * sp, life: Wp.life, kind: Wp.proj, local: true });
    }
    renderer.recoil(key, slot);
    muzzle(ox + Math.cos(a) * 10, oy + Math.sin(a) * 10, a, wid === 'shotgun');
    if (wid === 'shotgun') renderer.addShake(1.5);
    sfx(Wp.proj === 'pellet' ? 'shotgun' : Wp.proj === 'smart' ? 'smg' : 'pistol');
  } else if (Wp.kind === 'flame') {
    renderer.flame(ox + Math.cos(a) * 8, oy + Math.sin(a) * 8, a, Wp.range);
    renderer.recoil(key, slot);
    sfx('flame');
  } else if (Wp.kind === 'whip') {
    const len = rayCast(app.world, ox, oy, a, Wp.range);
    renderer.swing(key, slot, a, 'whip', 0.15);
    renderer.effect({ k: 'whip', x: ox, y: oy, x2: ox + Math.cos(a) * len, y2: oy + Math.sin(a) * len, life: 0.16 });
    sfx('whip');
  } else if (Wp.kind === 'slam') {
    renderer.swing(key, slot, a, 'hammer', 0.25);
    const cx = L.x + Math.cos(a) * 16, cy = L.y - 4 - lift + Math.sin(a) * 16;
    renderer.effect({ k: 'ring', x: cx, y: cy, r: Wp.radius, c: '#ffd23f', life: 0.3 });
    renderer.burst(cx, cy, ['#8a7f78', '#c8b8a0', '#ffd23f'], 14, 70, 0.5);
    renderer.addShake(3);
    sfx('slam');
  } else if (Wp.kind === 'rocket') {
    client.projectiles.push({ x: ox, y: oy, vx: Math.cos(a) * Wp.speed, vy: Math.sin(a) * Wp.speed, life: Wp.life, kind: 'rocket', local: true });
    renderer.recoil(key, slot);
    sfx('rocket');
  } else if (Wp.kind === 'chain') {
    renderer.recoil(key, slot);
    renderer.light(ox, oy, 70, '#9af0ff', 0.08, 1.4);
    sfx('zap');
  } else if (Wp.kind === 'beam') {
    const len = rayCast(app.world, ox, oy, a, Wp.range);
    renderer.effect({ k: 'beam', x: ox, y: oy, x2: ox + Math.cos(a) * len, y2: oy + Math.sin(a) * len, c: '#22e5ff', life: 0.22 });
    renderer.recoil(key, slot);
    renderer.addShake(2);
    sfx('beam');
  }
}

function muzzle(x, y, a, big = false) { renderer.effect({ k: 'muzzle', x, y, a, life: big ? 0.07 : 0.05, big }); }

// ------------------------------------------------------------------ events → effects, sounds, UI
const SHOT_SFX = { pulse: 'pistol', pellet: 'shotgun', smart: 'smg', rocket: 'rocket', ebullet: 'ebullet', eball: 'ebullet', erocket: 'rocket', tbullet: 'tmg', eplasma: 'plasma' };

function myGangId() { return 'g' + myGangIdx(); }
function myGangIdx() {
  if (app.mode === 'host') { const p = app.game.players.get('host'); return p ? G.gangIdx(p.gang) : 0; }
  return client.me ? client.me.g : 0;
}
function currentMode() { return app.mode === 'host' ? app.game.mode : client.mode; }

function handleEvent(ev) {
  const isHost = app.mode === 'host';
  const myKey = 'p' + app.myId;
  const mine = !isHost && ev.o === myKey;
  const me = currentMe();
  const near = (x, y, d = 200) => me && Math.abs(x - app.local.x) < d && Math.abs(y - app.local.y) < d;
  const pvp = currentMode() === 'pvp';
  // gang-only events (PvP): skip the ones for other gangs
  if (ev.g !== undefined && pvp && ev.t !== 'win' && ev.t !== 'gangout' && ev.t !== 'gangnew') {
    const g = typeof ev.g === 'number' ? 'g' + ev.g : ev.g;
    if (g !== myGangId() && !['cap', 'lost'].includes(ev.t)) return;
  }
  switch (ev.t) {
    case 'shot': {
      if (!isHost && !(ev.o === app.myId)) {
        client.projectiles.push({ id: ev.i, x: ev.x, y: ev.y, vx: Math.cos(ev.a) * ev.s, vy: Math.sin(ev.a) * ev.s, life: ev.l, kind: ev.k, team: ev.tm });
      }
      if (isHost || ev.o !== app.myId) {
        sfx(SHOT_SFX[ev.k] || 'pistol', ev.x, ev.y, ev.tm === 'e' ? 0.7 : 0.8);
        if (ev.o && typeof ev.o === 'string' && ev.o[0] !== 't') renderer.recoil('p' + ev.o, 'R');
        muzzle(ev.x, ev.y, ev.a, ev.k === 'pellet' || ev.k === 'rocket' || ev.k === 'erocket');
        renderer.light(ev.x, ev.y, ev.k === 'rocket' || ev.k === 'erocket' ? 90 : 56, ev.tm === 'e' ? '#ff8a6a' : '#ffd08a', 0.06, 1.3);
      }
      break;
    }
    case 'hitp': client.projectiles = client.projectiles.filter((p) => p.id !== ev.i); break;
    case 'spark':
      if (!isHost) client.projectiles = client.projectiles.filter((p) => p.id !== ev.i);
      renderer.burst(ev.x, ev.y, ['#ffd23f', '#ffffff', '#ff8a3d'], 4, 40, 0.25, 0, true);
      sfx('spark', ev.x, ev.y, 0.5);
      break;
    case 'dmg': {
      const col = { hit: '#ffffff', crit: '#ffd23f', player: '#ff3b5c', heal: '#3ddc84', ally: '#ff9ab8', burn: '#ff8a3d', veh: '#c8c0ff', civ: '#c8c0d8', poison: '#a6ff3f' }[ev.c] || '#fff';
      renderer.text(ev.x + (Math.random() - 0.5) * 6, ev.y, (ev.c === 'heal' ? '+' : '') + ev.v + (ev.c === 'crit' ? '!' : ''), col);
      if (ev.c === 'hit' || ev.c === 'crit') { renderer.burst(ev.x, ev.y + 8, ['#ffffff', '#ffd23f', '#9af0ff'], 4, 50, 0.25); sfx('hit', ev.x, ev.y, 0.6); }
      if (ev.fy !== undefined && near(ev.x, ev.fy, 420)) renderer.bleed(ev.x, ev.fy - 10, ev.v * (ev.c === 'crit' ? 1.5 : 1), ev.d, ev.m === 2 ? 'alien' : !!ev.m, ev.fy);
      break;
    }
    case 'hurt':
      if (ev.id === app.myId) { renderer.screenFlash('#ff0030', 0.25); renderer.addShake(2.5); sfx('hurt'); }
      break;
    case 'knock':
      if (ev.id === app.myId && !myVehicle()) { app.local.ix += ev.x; app.local.iy += ev.y; }
      break;
    case 'kick':
      if (isHost && ev.id === app.myId) kick(ev.a, ev.k);
      break;
    case 'recruit':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#ffd23f', life: 0.6 });
      if (ev.id === app.myId) { sfx('follower'); ui.toast(`"Tô contigo!" A local joins your crew with ${ev.melee ? 'a machete' : 'a pistol'}.`, 'good'); }
      break;
    case 'swing':
      if (mine) break;
      renderer.swing(ev.o, ev.s, ev.a, ev.k);
      if (ev.o[0] === 'p') {
        const ent = entityByKey(ev.o);
        if (ent) renderer.effect({ k: 'arc', x: ent.x, y: ent.y - 7, a: ev.a, arc: WEAPONS[ev.k] ? WEAPONS[ev.k].arc : 1.6, r: WEAPONS[ev.k] ? WEAPONS[ev.k].range * 0.8 : 16, c: ev.k === 'blade' ? '#ff3fa4' : '#c9d3df', life: 0.12 });
        if (ent) sfx(ev.k === 'blade' ? 'slash' : 'punch', ent.x, ent.y);
      } else {
        const ent = entityByKey(ev.o);
        if (ent) { renderer.effect({ k: 'arc', x: ent.x, y: ent.y - 8, a: ev.a, arc: 1.8, r: 14 + 4 * (ent.tier || 1), c: '#ff3b5c', life: 0.14 }); sfx('slash', ent.x, ent.y, 0.6); }
      }
      break;
    case 'flame':
      if (mine) break;
      renderer.flame(ev.x + Math.cos(ev.a) * 8, ev.y + Math.sin(ev.a) * 8, ev.a, ev.r);
      sfx('flame', ev.x, ev.y, 0.7);
      break;
    case 'zap':
      renderer.effect({ k: 'zap', x: ev.x, y: ev.y, x2: ev.x2, y2: ev.y2, c: '#9af0ff', life: 0.18 });
      renderer.burst(ev.x2, ev.y2, ['#9af0ff', '#ffffff'], 5, 50, 0.25, 0, true);
      sfx('zap', ev.x, ev.y);
      break;
    case 'whip':
      if (mine) break;
      renderer.swing(ev.o, ev.s, Math.atan2(ev.y2 - ev.y, ev.x2 - ev.x), 'whip', 0.15);
      renderer.effect({ k: 'whip', x: ev.x, y: ev.y, x2: ev.x2, y2: ev.y2, life: 0.16 });
      sfx('whip', ev.x, ev.y);
      break;
    case 'slam':
      if (ev.o && ev.o[0] === 'p') { if (mine) break; renderer.swing(ev.o, ev.s, ev.a, 'hammer', 0.25); }
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y, r: ev.r, c: ev.o && ev.o[0] === 'e' ? '#ff3b5c' : '#ffd23f', life: 0.3 });
      renderer.burst(ev.x, ev.y, ['#8a7f78', '#c8b8a0', '#5a5050'], 16, 80, 0.5);
      if (near(ev.x, ev.y)) renderer.addShake(4);
      sfx('slam', ev.x, ev.y);
      break;
    case 'beam':
      if (mine) break;
      renderer.effect({ k: 'beam', x: ev.x, y: ev.y, x2: ev.x2, y2: ev.y2, c: ev.c, life: 0.22 });
      sfx('beam', ev.x, ev.y);
      break;
    case 'boom': {
      renderer.explosion(ev.x, ev.y, ev.r);
      const d = me ? Math.hypot(ev.x - app.local.x, ev.y - app.local.y) : 999;
      if (d < 320) renderer.addShake(9 * (1 - d / 320) + 1);
      if (d < 140) renderer.screenFlash('#fff2d0', 0.18 * (1 - d / 140) + 0.04);
      sfx('boom', ev.x, ev.y);
      break;
    }
    case 'brk':
      if (ev.k === 'zap') {
        renderer.explosion(ev.x, ev.y, ev.r * 0.8, 'zap');
        for (let i = 0; i < 5; i++) renderer.effect({ k: 'zap', x: ev.x, y: ev.y, x2: ev.x + (Math.random() - 0.5) * ev.r * 2, y2: ev.y + (Math.random() - 0.5) * ev.r * 1.5, life: 0.25 });
        sfx('zapboom', ev.x, ev.y);
      } else for (let i = 0; i < 4; i++) renderer.flame(ev.x, ev.y, Math.random() * 6.28, 30);
      if (!isHost) client.rg && client.rg.broken.add(ev.i);
      break;
    case 'tele': renderer.effect({ k: 'tele', x: ev.x, y: ev.y, r: ev.r, d: ev.d }); sfx('tele', ev.x, ev.y, 0.6); break;
    case 'die': {
      const cols = ev.f >= 0 ? ['#ffffff', '#ffd23f', '#9aa6b8', '#56606e', ['#c9c05a', '#3ad0ff', '#a66bff', '#5a8aff', '#7dff4a'][ev.f]] : ev.f === -2 ? ['#c83a3a', '#8a2a2a', '#ffffff'] : ['#ffffff', '#ff9ab8'];
      renderer.burst(ev.x, ev.y - 6, cols, 10 + Math.round(ev.b * 8), 70 * ev.b, 0.7, 120);
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 6, r: 10 * ev.b, c: '#ffffff', life: 0.2 });
      sfx(ev.b > 1.4 ? 'bigdie' : 'die', ev.x, ev.y);
      if (ev.boss) { renderer.addShake(8); renderer.effect({ k: 'boom', x: ev.x, y: ev.y, r: 60, life: 0.8 }); }
      renderer.pool(ev.x, ev.y, 8 + (ev.b || 1) * 4, ev.f === 4 ? 'alien' : ev.f >= 0 && isMech(ev.f, ev.tr, ev.boss));
      break;
    }
    case 'pdie':
      renderer.burst(ev.x, ev.y - 6, ['#ff3b5c', '#ffffff', '#aeb9c9'], 24, 90, 0.9, 120);
      renderer.pool(ev.x, ev.y, 11, false);
      if (ev.id === app.myId) { sfx('death'); renderer.screenFlash('#ff0030', 0.5); ui.deathLoss(ev.loss || 0, ev.xp || 0); ui.log(`You died (<b>${escapeHtml(ev.by)}</b>). Lost <b class="gold">R$${ev.loss || 0}</b> and <b>${ev.xp || 0} XP</b>.`, 'bad'); }
      else { sfx('die', ev.x, ev.y); ui.log(`<b>${escapeHtml(ev.name)}</b> died (${escapeHtml(ev.by)}).`, 'bad'); }
      break;
    case 'pkill': ui.log(`<b>${escapeHtml(ev.k)}</b> took out <b>${escapeHtml(ev.v)}</b>!`, 'gold'); break;
    case 'eup':
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 10, r: 26, c: '#ff3b5c', life: 0.5 });
      renderer.text(ev.x, ev.y - 40, 'LEVEL UP!', '#ff3b5c', 1.4, -16);
      sfx('enemyup', ev.x, ev.y);
      ui.log(`The ${escapeHtml(ev.name)} who killed ${escapeHtml(ev.victim)} grew stronger!`, 'bad');
      break;
    case 'lvl':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#ffd23f', life: 0.9 });
      renderer.burst(ev.x, ev.y - 10, ['#ffd23f', '#ffffff'], 20, 60, 0.9, 0, true);
      if (ev.id === app.myId) { sfx('levelup'); renderer.text(app.local.x, app.local.y - 34, `LEVEL ${ev.l}!`, '#ffd23f', 1.6, -14); ui.toast(`LEVEL UP! You are now level ${ev.l}`, 'gold'); }
      break;
    case 'cash':
      if (ev.id === app.myId) { renderer.text(ev.x, ev.y, `+R$${ev.v}`, '#7dff9a', 1.0, -18); sfx('cash', undefined, undefined, 0.5); }
      break;
    case 'pick':
      renderer.burst(ev.x, ev.y - 4, ev.k === 'cash' ? ['#7dff9a', '#ffd23f'] : ['#3ddc84', '#ffffff'], 8, 40, 0.4);
      if (ev.id === app.myId) sfx('pickup');
      break;
    case 'fx': {
      if (ev.k === 'dash') { sfx('dash', ev.x, ev.y); renderer.burst(ev.x, ev.y, ['#c8c0d8', '#ffffff'], 8, 50, 0.3); }
      if (ev.k === 'heal') { sfx('heal', ev.x, ev.y); renderer.burst(ev.x, ev.y - 8, ['#3ddc84', '#a0ffc0', '#ffffff'], 16, 40, 0.8, 0, true); renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 6, r: 16, c: '#3ddc84', life: 0.4 }); }
      if (ev.k === 'cloak') { sfx('cloak', ev.x, ev.y); renderer.burst(ev.x, ev.y - 8, ['#22e5ff', '#a66bff'], 18, 50, 0.6, 0, true); }
      if (ev.k === 'uncloak') renderer.burst(ev.x, ev.y - 8, ['#22e5ff', '#ffffff'], 10, 40, 0.4, 0, true);
      if (ev.k === 'shield') { sfx('shield', ev.x, ev.y); renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 8, r: 18, c: '#4fc3ff', life: 0.4 }); }
      if (ev.k === 'shieldbreak') renderer.burst(ev.x, ev.y - 8, ['#4fc3ff', '#ffffff'], 14, 70, 0.4, 0, true);
      if (ev.k === 'cheat') { sfx('cheat', ev.x, ev.y); renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#ff9ad8', life: 1 }); renderer.burst(ev.x, ev.y - 10, ['#ff9ad8', '#ffffff', '#ffd23f'], 30, 90, 1, 0, true); if (ev.id === app.myId) ui.alert('<b>DOCE</b> kicked in — you cheated death!', 'good'); }
      break;
    }
    case 'tp':
      if (ev.id === app.myId) {
        app.local.x = ev.x; app.local.y = ev.y; app.local.vx = app.local.vy = 0;
        renderer.snapCam = !ev.quiet;
        if (!ev.quiet) { sfx('respawn'); renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#22e5ff', life: 0.7 }); }
      }
      break;
    case 'venter': sfx('venter', ev.x, ev.y); if (ev.id === app.myId) { app.local.vx = app.local.vy = 0; ui.toast(ev.seat === 0 ? 'Driving! WASD to fly over the city. [V] to get out.' : 'Gunner seat: shoot with LMB / RMB. [V] to get out.', 'good'); } break;
    case 'vexit': sfx('vexit', ev.x, ev.y); break;
    case 'vland': sfx('land', ev.x, ev.y); renderer.burst(ev.x, ev.y, ['#8a8494', '#c8c0d8'], 14, 60, 0.6); break;
    case 'vboom':
      renderer.explosion(ev.x, ev.y - 10, 60);
      renderer.burst(ev.x, ev.y - 10, ['#22e5ff', '#9af0ff', '#3a3646'], 30, 160, 0.9, 120, true);
      if (near(ev.x, ev.y, 300)) { renderer.addShake(10); renderer.screenFlash('#fff2d0', 0.2); }
      sfx('vboom', ev.x, ev.y);
      break;
    case 'follower':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#3ddc84', life: 0.8 });
      if (ev.id === app.myId) { sfx('follower'); ui.toast(`A local soldier joins your crew! (tier ${ev.tier})`, 'good'); ui.log('The people sent a soldier to follow you. If they die, they are gone for good.', 'good'); }
      break;
    case 'fdie': if (ev.id === app.myId) { ui.log('One of your crew fell. Capture more districts to recruit again.', 'bad'); } break;
    case 'cap': {
      renderer.capture(ev.r, ev.f, ev.g);
      const R = app.world.regions[ev.r];
      const C = R.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      const gcol = GANG_COLORS[G.gangIdx(ev.g)] || '#fff';
      const ours = ev.g === myGangId();
      renderer.effect({ k: 'ring', x, y, r: 60, c: gcol, life: 0.8 });
      renderer.burst(x, y - 30, [gcol, '#ffffff', '#ffd23f'], 40, 110, 1.2, 80, true);
      if (ours) {
        sfx('capture');
        ui.alert(`<b>${escapeHtml(R.name)}</b> is ours! The people join the gang.`, 'good');
        ui.log(`Captured <b>${escapeHtml(R.name)}</b>. Guards are posted and income flows to the vault. Upgrade it with <b>B</b> at the core or from the map.`, 'good');
      } else if (ev.pg === myGangId()) {
        sfx('lost'); ui.alert(`A rival gang took <b>${escapeHtml(R.name)}</b>!`, 'raid');
      } else if (pvp) ui.log(`${gangLabel(ev.g)} took <b>${escapeHtml(R.name)}</b>.`, 'info');
      break;
    }
    case 'cleared': ui.log(`Garrison of <b>${escapeHtml(app.world.regions[ev.r].name)}</b> wiped out. Take the core!`, 'good'); break;
    case 'lost':
      renderer.capture(ev.r, ev.g, ev.f);
      if (ev.g !== myGangId() && pvp) { ui.log(`${factionName(ev.f)} retook <b>${escapeHtml(app.world.regions[ev.r].name)}</b> from ${gangLabel(ev.g)}.`, 'info'); break; }
      sfx('lost'); ui.alert(`We lost <b>${escapeHtml(app.world.regions[ev.r].name)}</b> to ${factionName(ev.f)}!`, 'raid'); ui.log(`${factionName(ev.f)} retook <b>${escapeHtml(app.world.regions[ev.r].name)}</b>.`, 'bad');
      break;
    case 'raid': sfx('alarm'); ui.alert(`⚠ ${factionName(ev.f)} will raid <b>${escapeHtml(app.world.regions[ev.r].name)}</b> in ${ev.eta}s! (${ev.n} raiders)`, 'raid', 7000); ui.log(`Raid incoming on <b>${escapeHtml(app.world.regions[ev.r].name)}</b> (${factionName(ev.f)}). Defend the core!`, 'bad'); break;
    case 'gthrow': renderer.grenade(ev); sfx('whip', ev.x, ev.y, 0.5); break;
    case 'gstick': renderer.burst(ev.x, ev.y - 8, ['#3ddc84', '#ffffff'], 6, 30, 0.3, 0, true); sfx('click', ev.x, ev.y); break;
    case 'gboom': renderer.grenadeBoom(ev); sfx(ev.k === 'impact' || ev.k === 'sticky' ? 'boom' : ev.k === 'emp' ? 'zapboom' : ev.k === 'flash' ? 'beam' : 'flame', ev.x, ev.y); if ((ev.k === 'impact' || ev.k === 'sticky') && near(ev.x, ev.y, 260)) renderer.addShake(7); if (ev.k === 'flash' && near(ev.x, ev.y, 200)) renderer.screenFlash('#ffffff', 0.25); break;
    case 'flashed': if (ev.id === app.myId) { renderer.screenFlash('#ffffff', 1.4); sfx('beam'); } break;
    case 'heli': if (ev.id === app.myId) { sfx('siren'); ui.alert(`<b>POLICE HELICOPTER</b> ${ev.k === 'rocket' ? 'with rockets' : 'with a machine gun'}! It can't be shot down — get to cover or lose them.`, 'raid', 5000); } break;
    case 'steal': sfx('venter', ev.x, ev.y); renderer.burst(ev.x, ev.y, ['#ffffff', '#c8c0d8'], 8, 50, 0.4); if (ev.id === app.myId) ui.toast('Car stolen! The driver ran off screaming.', 'warn'); break;
    case 'tdown': if (ev.g === myGangId()) { sfx('lost', ev.x, ev.y); ui.log(`A turret was destroyed at <b>${escapeHtml(app.world.regions[ev.r].name)}</b>. Buy a new one in the compound menu.`, 'bad'); } break;
    case 'fraid': if (near(corePos(ev.r).x, corePos(ev.r).y, 900)) ui.log(`${factionName(ev.f)} is attacking ${factionName(ev.d)} at <b>${escapeHtml(app.world.regions[ev.r].name)}</b>.`, 'info'); break;
    case 'fcap':
      renderer.capture(ev.r, ev.pf, ev.f);
      ui.log(`${factionName(ev.f)} took <b>${escapeHtml(app.world.regions[ev.r].name)}</b> from ${factionName(ev.pf)}.`, 'info');
      break;
    case 'squad':
      if (ev.g === myGangId()) { sfx('alarm', undefined, undefined, 0.5); ui.alert(`<b>${escapeHtml(ev.by)}</b> sent a squad of ${ev.n} against <b>${escapeHtml(app.world.regions[ev.r].name)}</b>!`, 'good', 5000); }
      else if (ev.f === myGangId()) { sfx('alarm'); ui.alert(`⚠ A rival squad is attacking <b>${escapeHtml(app.world.regions[ev.r].name)}</b>!`, 'raid', 6000); }
      break;
    case 'king': {
      const o = ev.o;
      const who = typeof o === 'string' ? gangLabel(o) : factionName(o);
      sfx(o === myGangId() ? 'capture' : 'alarm');
      ui.alert(`${who} holds the <b>BOCA KING</b>!${o === myGangId() ? ' Hold it to win.' : ''}`, o === myGangId() ? 'good' : 'raid', 6000);
      break;
    }
    case 'raidgo': if (ev.kind) break; ui.alert(`⚠ The raid on <b>${escapeHtml(app.world.regions[ev.r].name)}</b> has begun!`, 'raid'); break;
    case 'raidend':
      if (ev.kind === 'g') { if (ev.g === myGangId()) { if (ev.win) { sfx('capture'); ui.alert(`Your squad took <b>${escapeHtml(app.world.regions[ev.r].name)}</b>!`, 'good'); } else ui.alert(`Your squad at <b>${escapeHtml(app.world.regions[ev.r].name)}</b> ${ev.retreat ? 'gave up and went home' : 'was wiped out'}.`, 'raid'); } break; }
      if (ev.kind === 'f') break;
      ui.toast(ev.retreat ? 'The raiders retreated.' : `Raid on ${escapeHtml(app.world.regions[ev.r].name)} defeated!`, 'good'); if (!ev.retreat) ui.log('Raid defeated! Bonus to the vault.', 'good'); break;
    case 'hq': sfx('alarm'); ui.alert(`${factionName(ev.f)} HQ is now open: <b>${escapeHtml(app.world.regions[ev.r].name)}</b>`, 'warn', 7000); ui.log(`You weakened ${factionName(ev.f)} enough — their HQ <b>${escapeHtml(app.world.regions[ev.r].name)}</b> can be attacked.`, 'warn'); break;
    case 'boss': sfx('boss'); ui.alert(`<b>${escapeHtml(ev.name)}</b> appears!`, 'raid', 5000); break;
    case 'bossdown': sfx('capture'); ui.alert(`The boss of ${factionName(ev.f)} has fallen! Capture the HQ!`, 'good', 6000); break;
    case 'fdown': ui.alert(`${factionName(ev.f)} is finished in this city!`, 'good', 7000); break;
    case 'gangnew': ui.log(`A new gang appears: <b style="color:${GANG_COLORS[ev.g]}">${escapeHtml(ev.name)}</b>.`, 'info'); break;
    case 'gangout': sfx('lost'); ui.alert(`<b style="color:${GANG_COLORS[ev.g]}">${escapeHtml(ev.name)}</b> has been wiped out!`, ev.g === myGangIdx() ? 'raid' : 'good', 7000); break;
    case 'win': {
      const mineWin = ev.g === myGangId();
      sfx(mineWin ? 'levelup' : 'lost');
      const name = ev.f !== undefined ? FACTIONS[ev.f].name : gangName(ev.g);
      const text = ev.why === 'king'
        ? (mineWin ? `${name} held the BOCA KING long enough. You are the REI DA BOCA!` : `${name} held the BOCA KING long enough and won the city.`)
        : currentMode() === 'pvp'
        ? (mineWin ? `${name} rules the city${ev.why === 'share' ? ' (60% of the districts)' : ' — every rival gang is gone'}!` : `${name} won the gang war${ev.why === 'share' ? ' by holding 60% of the city' : ''}.`)
        : `All three faction HQs have fallen. ${name} runs the city now.`;
      setTimeout(() => ui.showVictory({ mine: mineWin, text, stats: app.mode === 'host' ? app.game.stats : null }), 1500);
      break;
    }
    case 'buy': if (ev.id !== undefined && ev.id !== app.myId) break; sfx('buy'); ui.toast(escapeHtml(ev.text), 'gold'); break;
    case 'down':
      renderer.pool(ev.x, ev.y, 9, false);
      if (ev.id === app.myId) { sfx('death'); renderer.screenFlash('#ff0030', 0.5); renderer.addShake(6); ui.alert('<b>VOCÊ CAIU!</b> Crawl to cover. A gang-mate can revive you (hold E) — or your crew will try.', 'raid', 6000); }
      else if (G.gangIdx(ev.g) === myGangIdx()) { sfx('alarm', ev.x, ev.y, 0.6); ui.alert(`<b>${escapeHtml(ev.name)}</b> is down! Get to them and hold <b>E</b> to revive.`, 'raid', 5000); }
      break;
    case 'revived':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#3ddc84', life: 0.9 });
      renderer.burst(ev.x, ev.y - 10, ['#3ddc84', '#a0ffc0', '#ffffff'], 22, 60, 0.9, 0, true);
      sfx('heal', ev.x, ev.y);
      if (ev.id === app.myId) ui.alert(`Back on your feet${ev.by === 'crew' ? ' — your crew pulled you up' : ` — thanks, <b>${escapeHtml(ev.by)}</b>`}!`, 'good');
      else if (near(ev.x, ev.y, 300)) ui.log(`<b>${escapeHtml(ev.name)}</b> is back up${ev.by === 'crew' ? ' (crew)' : ` (${escapeHtml(ev.by)})`}.`, 'good');
      break;
    case 'xploss':
      if (ev.id === app.myId) { renderer.text(ev.x, ev.y, `-${ev.v} XP`, '#ff3b5c', 1.4, -14); if (ev.cop) ui.toast('Killing cops at 3+ stars costs you XP.', 'warn'); }
      break;
    case 'sale':
      if (near(ev.x, ev.y, 260)) { renderer.text(ev.x, ev.y, `+R$${ev.v}`, '#7dff5a', 1.1, -16); sfx('cash', ev.x, ev.y, 0.35); }
      break;
    case 'vroll':
      sfx('venter', ev.x, ev.y);
      renderer.light(ev.x, ev.y, 110, '#ff8a3d', 0.8, 1.6);
      renderer.burst(ev.x, ev.y, ['#ff8a3d', '#ffd23f', '#c8c0d8'], 14, 50, 0.6);
      break;
    case 'flvl':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#ffd23f', life: 0.9 });
      renderer.burst(ev.x, ev.y - 12, ['#ffd23f', '#ffffff'], 16, 60, 0.8, 0, true);
      renderer.text(ev.x, ev.y - 30, `LEVEL ${ev.lvl}!`, '#ffd23f', 1.4, -14);
      if (ev.id === app.myId) { sfx('levelup', ev.x, ev.y, 0.7); ui.toast(`A crew member reached <b>level ${ev.lvl}</b> — tougher, harder hitting, faster.`, 'good'); }
      break;
    case 'wanted':
      if (ev.id !== app.myId) break;
      if (ev.stars > 0) { sfx('siren'); ui.alert(`${'★'.repeat(ev.stars)} <b>WANTED</b> — the police are coming! Run (lose them), fight (beat the response) or pay them off at the QG.`, 'raid', 5000); }
      else if (ev.why === 'beat') { sfx('capture'); ui.alert('You beat the police response. Wanted level cleared!', 'good'); }
      else if (ev.why === 'escaped') { sfx('cup'); ui.alert('You lost the police. Wanted level cleared.', 'good'); }
      else if (ev.why === 'bribe') { sfx('cash'); ui.alert('Paid off. The police forget about you... for now.', 'good'); }
      break;
    case 'siren': sfx('siren', ev.x, ev.y); break;
    case 'copsdrop':
      sfx('copsdrop', ev.x, ev.y);
      renderer.burst(ev.x, ev.y, ['#8a8494', '#c8c0d8'], 16, 70, 0.6);
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y, r: 26, c: '#5a8aff', life: 0.5 });
      break;
    case 'useitem': {
      const I = ITEMS[ev.item];
      sfx(I && I.price >= 600 ? 'stim' : 'drink', ev.x, ev.y);
      renderer.burst(ev.x, ev.y - 14, [I ? I.c : '#fff', '#ffffff'], 12, 40, 0.6, 0, true);
      if (ev.id === app.myId && I) {
        ui.toast(`${escapeHtml(I.name)}: ${escapeHtml(I.desc)}`, 'good');
        if (ev.bad) { sfx('poison'); ui.alert('<b>BATIZADO!</b> Bad batch — you are poisoned (it will not kill you). A Água de Coco cures it.', 'raid', 5000); }
      }
      break;
    }
    case 'buffend': if (ev.id === app.myId) ui.toast(`${escapeHtml(ev.k)} wore off.`, 'warn'); break;
    case 'emote': sfx('dance', ev.x, ev.y); renderer.burst(ev.x, ev.y - 20, ['#ff3fa4', '#22e5ff', '#ffd23f'], 10, 40, 0.8, 0, true); break;
    // ---- v0.62
    case 'battack': {
      if (ev.g !== myGangId()) break;
      const R = app.world.regions[ev.r];
      const who = ev.k === 'player' ? `<b>${escapeHtml(ev.w)}</b>` : ev.k === 'squad' || ev.k === 'gang' ? `a squad of ${gangLabel('g' + ev.w)}` : ev.k === 'alien' ? '<b style="color:#7dff4a">the ETs</b>' : ev.k === 'police' ? 'the police' : ev.w !== null && ev.w !== undefined ? factionName(ev.w) : 'enemies';
      sfx('alarm');
      renderer.screenFlash('#ff0030', 0.15);
      ui.alert(`⚠ <b>${ev.base ? 'YOUR BASE' : 'BASE'} UNDER ATTACK</b> — ${who} at <b>${escapeHtml(R.name)}</b>! Follow the red arrow.`, 'raid', 7000);
      ui.log(`<b>${escapeHtml(R.name)}</b> is under attack by ${who}. Go defend it!`, 'bad');
      break;
    }
    case 'ufo':
      if (ev.s === 'warn') {
        sfx('ufo');
        if (ev.id === app.myId) { renderer.screenFlash('#7dff4a', 0.35); ui.alert('<b style="color:#7dff4a">OVNI!</b> A flying saucer is coming <b>for you</b>! ETs are about to land around you — get ready.', 'raid', 8000); }
        else ui.alert(`<b style="color:#7dff4a">OVNI!</b> A flying saucer is coming for <b>${escapeHtml(ev.name)}</b>${ev.vg === myGangIdx() ? ' — help them!' : '.'}`, 'raid', 7000);
        ui.log(`A flying saucer was seen over the city, heading for <b>${escapeHtml(ev.name)}</b>.`, 'bad');
      } else if (ev.s === 'beam') { sfx('ufo', ev.x, ev.y); if (near(ev.x, ev.y, 300)) renderer.addShake(4); }
      else if (ev.s === 'leave') { sfx('ufo', ev.x, ev.y, 0.6); ui.log('The flying saucer is leaving... the ETs stay behind.', 'info'); }
      break;
    case 'beamdown':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#7dff4a', life: 0.8 });
      renderer.burst(ev.x, ev.y - 8, ['#7dff4a', '#ffffff', '#b8ffd0'], 10, 50, 0.6, 0, true);
      renderer.light(ev.x, ev.y, 90, '#7dff4a', 0.5, 1.4);
      sfx('beamdown', ev.x, ev.y);
      break;
    case 'ufolast':
      sfx('levelup', ev.x, ev.y);
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#7dff4a', life: 1.2 });
      ui.alert(ev.by ? `The last ET is down! <b>${escapeHtml(ev.by)}</b> takes the <b style="color:#7dff4a">Varginha Ray</b>.` : 'The last ET is down! It dropped a <b style="color:#7dff4a">strange green arm</b> — grab it!', 'good', 7000);
      break;
    case 'pet': {
      const dog = ev.kind === 'dog';
      sfx(dog ? 'bark' : 'meow', ev.x, ev.y);
      renderer.text(ev.x, ev.y - 16, dog ? (Math.random() < 0.5 ? 'AU AU!' : 'AU!') : (Math.random() < 0.5 ? 'MIAU!' : 'MIAAU~'), dog ? '#ffd23f' : '#ff9ab8', 1.1, -14);
      renderer.burst(ev.x, ev.y - 12, ['#ff3fa4', '#ff9ab8'], 4, 24, 0.7, -20, true);
      break;
    }
    case 'stats': if (ev.to === app.myId || app.mode === 'host') ui.showStats(ev.st); break;
    case 'barin':
      sfx('door', ev.x, ev.y);
      if (ev.id === app.myId) {
        const bar = app.world.bars[ev.bar];
        enterBarLocal(ev.bar);
        ui.closeModal();
        ui.toast(`<b>${escapeHtml(bar.name)}</b> — [B] at the counter for drinks${bar.dealer ? ', or talk to the dealer in the back' : ''}. Walk out the door to leave.`, 'gold');
      }
      break;
    case 'barout': sfx('door', ev.x, ev.y); if (ev.id === app.myId) { app.local.bar = -1; app.trackKey = ''; ui.closeModal(); } break;
    case 'cup': sfx('cup'); ui.log(escapeHtml(ev.text), 'gold'); break;
    case 'income': break;
    case 'msg':
      if (ev.c === 'warn' && ev.to) { sfx('error'); ui.toast(escapeHtml(ev.text), 'warn'); }
      else if (ev.to && ev.c === 'good') { ui.toast(escapeHtml(ev.text), 'good'); }
      else ui.log(escapeHtml(ev.text), ev.c || '');
      break;
    case 'chat':
      app.chats.set(ev.id, { text: ev.text, t: renderer.time + 5 });
      ui.log(`<b class="chatname">${escapeHtml(ev.name)}:</b> ${escapeHtml(ev.text)}`, 'chat');
      sfx('click');
      break;
  }
}

function corePos(r) { const C = app.world.regions[r].compound; return { x: (C.coreX + 0.5) * TILE, y: (C.coreY + 0.5) * TILE }; }
function factionName(f) { return ['<span style="color:#c9c05a">Milícia</span>', '<span style="color:#3ad0ff">NeoBrás</span>', '<span style="color:#a66bff">Comando Cromo</span>', '<span style="color:#5a8aff">the police</span>', '<span style="color:#7dff4a">the ETs</span>'][f] || 'Enemies'; }
function gangsList() { return app.mode === 'host' ? [...app.game.gangs.values()].map((g) => ({ idx: g.idx, name: g.name })) : client.rg ? client.rg.gangs : []; }
function gangName(id) { const i = G.gangIdx(id); const g = gangsList().find((x) => x.idx === i); return g ? g.name : GANG_DEFAULT_NAMES[i] || 'A gang'; }
function gangLabel(id) { return `<b style="color:${GANG_COLORS[G.gangIdx(id)]}">${escapeHtml(gangName(id))}</b>`; }

function entityByKey(k) {
  const id = k.slice(1);
  if (k[0] === 'p') {
    if (id === app.myId) return app.local;
    return app.mode === 'host' ? app.game.players.get(id) : client.players.get(id);
  }
  const n = Number(id);
  if (k[0] === 'a') return app.mode === 'host' ? app.game.allies.get(n) : client.allies.get(n);
  return app.mode === 'host' ? app.game.enemies.get(n) : client.enemies.get(n);
}

function currentMe() {
  if (app.mode === 'host') return app.game.players.get('host');
  if (app.mode === 'client') return client.me;
  return null;
}

function myVehicle() {
  const me = myPrivate();
  if (!me || !me.veh) return null;
  if (app.mode === 'host') return app.game.vehicles.get(me.veh) || null;
  return client.vehicles.get(me.veh) || null;
}

// ------------------------------------------------------------------ actions, chat, abilities
function sendAction(a) {
  if (app.mode === 'host') G.handleAction(app.game, 'host', a);
  else if (client.conn) send(client.conn, { t: 'act', a });
}
function sendChat(text) {
  if (text.startsWith('/')) return;
  if (app.mode === 'host') { const p = app.game.players.get('host'); G.emit(app.game, { t: 'chat', id: 'host', name: p.name, text }); }
  else if (client.conn) send(client.conn, { t: 'chat', text });
}
function requestGangSwitch() {
  if (app.mode === 'host') ui.showGangPicker(G.gangChoices(app.game), 'JOIN ANOTHER GANG', (idx) => G.handleAction(app.game, 'host', { t: 'switchGang', idx, name: prefs.gangName || undefined }));
  else if (client.conn) send(client.conn, { t: 'gangs?' });
}

function myProfile() {
  if (app.mode === 'host') { const p = app.game.players.get('host'); return p ? G.profile(p) : null; }
  return client.prof;
}
function myPrivate() {
  if (app.mode === 'host') { const p = app.game.players.get('host'); return p ? G.privateState(app.game, p) : null; }
  return client.me;
}

function useAbility(k) {
  const prof = myProfile(), me = myPrivate();
  if (!prof || !me || me.dead) return;
  if (me.veh && (k === 'Q' || k === 'R')) return;
  if (me.bar >= 0 || me.emo > 0 || me.down) return;
  const A = ABILITIES[k];
  const lvl = prof.mods[A.mod] || 0;
  if (lvl < 1) { ui.toast(`${A.name} needs the ${A.mod === 'legs' ? 'Leg Servos' : A.mod === 'nanite' ? 'Nanite Regen' : A.mod === 'optic' ? 'Optical Camo' : 'Kinetic Shield'} mod (Clínica at the QG).`, 'warn'); sfx('error'); return; }
  if ((me.cd[k] || 0) > 0.15) { sfx('error'); return; }
  if (k === 'Q') {
    // dash in the direction you are moving (8 directions, diagonals included); if standing still, toward the mouse
    const ax = input.axis();
    let dx = ax.x, dy = ax.y;
    if (!dx && !dy) { dx = Math.cos(app.local.aim); dy = Math.sin(app.local.aim); }
    const l = Math.hypot(dx, dy) || 1;
    app.local.dashT = 0.17; app.local.dashX = dx / l; app.local.dashY = dy / l;
    if (app.mode === 'client') { sfx('dash'); client.me.cd.Q = prof.dash ? 1 : A.cd(lvl); }
  }
  if (app.mode === 'host') G.useAbility(app.game, 'host', k);
  else send(client.conn, { t: 'ab', k });
}

function copyInvite() {
  if (!app.roomCode) { ui.toast('No online room (playing solo).', 'warn'); return; }
  const link = `${location.origin}${location.pathname}?room=${app.roomCode}`;
  const done = () => ui.toast(`Invite link copied! Room ${app.roomCode}`, 'good');
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => ui.toast(link));
  else ui.toast(link);
}

function leaveGame() {
  if (app.mode === 'host') {
    saveNow();
    for (const c of host.clients.values()) { try { c.conn.close(); } catch { /* ignore */ } }
    host.clients.clear();
    if (host.peer) { try { host.peer.destroy(); } catch { /* ignore */ } host.peer = null; }
    app.game = null;
  } else if (app.mode === 'client') {
    app.mode = 'title';
    cleanupClient();
  }
  app.roomCode = null;
  setupTitle();
}

window.addEventListener('beforeunload', () => saveNow());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

// ------------------------------------------------------------------ frame
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  try {
    if (app.mode === 'title') titleFrame(dt);
    else gameFrame(dt, t);
  } catch (e) {
    console.error(e);
  }
  ui.tickPreview(dt);
  requestAnimationFrame(frame);
}

function titleFrame(dt) {
  const c = app.titleCam;
  c.t += dt;
  c.a += dt * 0.05;
  const r = 40 * TILE;
  const C = app.world.regions[app.world.baseId].compound;
  const view = {
    world: app.world, me: { x: (C.coreX + 0.5) * TILE + Math.cos(c.a) * r, y: (C.coreY + 0.5) * TILE + Math.sin(c.a * 1.3) * r * 0.6, dead: true },
    players: [], enemies: [], allies: [], pickups: [], projectiles: [], turrets: [], vehicles: [], rs: app.world.regions.map((R) => ({ owner: R.base ? 'g' + Math.max(0, GANG_COLORS.indexOf(prefs.gangColor)) : R.faction, capture: 0 })),
    gangColor: prefs.gangColor, dayT: 0.02, raids: [], mode: 'pve', myGang: 0,
  };
  renderer.draw(view, dt);
}

function gameFrame(dt, now) {
  const world = app.world;
  const isHost = app.mode === 'host';
  const meCheck = isHost ? app.game.players.get('host') : client.me;
  if (!meCheck) { renderer.draw({ world, me: null, players: [], enemies: [], allies: [], pickups: [], projectiles: [], turrets: [], vehicles: [], rs: [], dayT: 0.3, raids: [] }, dt); if (isHost) hostTick(dt); return; }
  const me = myPrivate();
  const prof = myProfile();
  const veh = myVehicle();
  // ---- keys
  for (const code of input.take()) {
    if (code === 'Escape') { if (ui.isOpen()) ui.closeModal(); else ui.togglePause(); }
    else if (code === 'Tab') ui.toggleMap();
    else if (code === 'Enter' || code === 'NumpadEnter') { if (!ui.chatOpen()) ui.openChat(); }
    else if (code === 'KeyM') { app.musicOn = !app.musicOn; if (app.music) app.musicOn ? app.music.start() : app.music.stop(); ui.toast(app.musicOn ? 'Music on' : 'Music off'); }
    else if (code === 'KeyB') {
      const spot = contextSpot();
      if (ui.isOpen() === 'base' || ui.isOpen() === 'compound' || ui.isOpen() === 'shop') ui.closeModal();
      else if (spot && spot.shop) ui.openShop(spot.shop, spot.bar);
      else if (me && me.bar >= 0) ui.toast('Walk up to the counter (drinks) or the dealer in the back to buy.', 'warn');
      else if (spot && spot.tab) ui.toggleBase(spot.tab);
      else if (spot && spot.boca !== undefined) ui.openCompound(spot.boca);
      else if (inBaseLocal()) ui.toggleBase();
      else if (nearOwnCompound() >= 0) ui.openCompound(nearOwnCompound());
      else ui.toast('B opens the base menu at your QG, or the upgrades of a compound you own (stand near its core).', 'warn');
    } else if (ui.isOpen()) continue;
    else if (code === 'KeyV') { if (!(me && me.bar >= 0)) sendAction({ t: 'veh' }); }
    else if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Numpad1' || code === 'Numpad2' || code === 'Numpad3') useBelt(Number(code.slice(-1)) - 1);
    else if (code === 'KeyT') { if (me && !me.dead && !me.veh && !(me.emo > 0)) sendAction({ t: 'emote' }); }
    else if (code === 'KeyZ') throwGrenade();
    else if (code === 'KeyC') cycleGrenade();
    else if (code === 'KeyG') { sendAction({ t: 'recruit' }); }
    else if (code === 'KeyQ' || code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight') useAbility('Q');
    else if (code === 'KeyX' && me && me.down) { sendAction({ t: 'giveup' }); }
    else if (code === 'KeyE') {
      if (downedMateNear()) continue;
      const spot = contextSpot();
      if (spot && spot.door !== undefined) enterBar();
      else if (spot && spot.shop) ui.openShop(spot.shop, spot.bar);
      else useAbility('E');
    }
    else if (code === 'KeyR') useAbility('R');
    else if (code === 'KeyF') useAbility('F');
  }
  // ---- local movement (prediction)
  const L = app.local;
  const blocked = app.menuOpen && ui.isOpen() !== 'map';
  let speed = prof ? prof.speed || 72 : 72;
  if (me && me.bar >= 0 && L.bar !== me.bar) enterBarLocal(me.bar);
  if (me && !(me.bar >= 0) && L.bar >= 0 && performance.now() / 1000 - L.barT > 1.5) L.bar = -1;
  const dancing = me && me.emo > 0;
  if (me && !me.dead && !app.typing && L.bar >= 0) {
    // inside a bar: walk around the room (local coordinates), walk out the door to leave
    const ax = blocked || dancing ? { x: 0, y: 0 } : input.axis();
    const ox = L.bx, oy = L.by;
    moveInRoom(L, ax.x * speed * dt, ax.y * speed * dt);
    L.moving = Math.abs(L.bx - ox) + Math.abs(L.by - oy) > 0.01;
    if (L.by > BAR_ROOM.h - 7 && performance.now() / 1000 - L.barT > 0.6) { L.barT = performance.now() / 1000; sendAction({ t: 'barout' }); }
    setEngine(0);
  } else if (me && !me.dead && !app.typing) {
    const ax = blocked || dancing ? { x: 0, y: 0 } : input.axis();
    if (!veh && (ax.x || ax.y) && ax.y < 0) { const spot = contextSpot(); if (spot && spot.door !== undefined && spot.close) enterBar(); }
    if (veh && me.seat === 0) {
      // driving: flying ignores buildings; out of charge = slow ground crawl with collisions
      const V = VEHICLES[veh.type];
      const sp = veh.flying ? V.speed : V.crawl;
      const k = Math.min(1, dt * (veh.flying ? 3.5 : 8));
      L.vx += (ax.x * sp - L.vx) * k; L.vy += (ax.y * sp - L.vy) * k;
      const ox = L.x, oy = L.y;
      if (veh.flying) {
        L.x = Math.max(12, Math.min(world.W * TILE - 12, L.x + L.vx * dt));
        L.y = Math.max(12, Math.min(world.H * TILE - 12, L.y + L.vy * dt));
      } else moveBox(world, L, L.vx * dt, L.vy * dt, 6);
      L.moving = Math.abs(L.x - ox) + Math.abs(L.y - oy) > 0.01;
      setEngine(Math.min(1, 0.25 + Math.hypot(L.vx, L.vy) / sp * 0.75) * (veh.flying ? 1 : 0.5), veh.type === 'car' ? 0.8 : 1.1);
    } else if (veh) {
      L.x = veh.x; L.y = veh.y; L.moving = false;
      setEngine(0.3, veh.type === 'car' ? 0.8 : 1.1);
    } else {
      setEngine(0);
      if (ax.x || ax.y) { L.lastDx = ax.x; L.lastDy = ax.y; }
      // light momentum: quick acceleration, short slide when stopping
      const tvx = ax.x * speed, tvy = ax.y * speed;
      const acc = 1 - Math.exp(-dt * (ax.x || ax.y ? 16 : 11));
      L.wx += (tvx - L.wx) * acc; L.wy += (tvy - L.wy) * acc;
      let mx, my;
      if (dancing) L.dashT = 0;
      if (L.dashT > 0) {
        L.dashT -= dt;
        mx = L.dashX * 300 * dt; my = L.dashY * 300 * dt;
        L.wx = L.dashX * speed; L.wy = L.dashY * speed;
        if (Math.random() < 0.7) renderer.ghost(L.x, L.y, currentSpriteGuess());
      } else { mx = L.wx * dt; my = L.wy * dt; }
      // recoil and knockback impulses
      mx += L.ix * dt; my += L.iy * dt;
      const dec = Math.exp(-dt * 6.5);
      L.ix *= dec; L.iy *= dec;
      if (Math.abs(L.ix) < 2) L.ix = 0; if (Math.abs(L.iy) < 2) L.iy = 0;
      const ox = L.x, oy = L.y;
      moveBox(world, L, mx, my, G.PLAYER_R);
      L.moving = Math.abs(L.x - ox) + Math.abs(L.y - oy) > 0.01;
    }
  } else { L.moving = false; L.wx = L.wy = L.ix = L.iy = 0; setEngine(0); }
  const mw = renderer.screenToWorld(input.mouse.x, input.mouse.y);
  const lift = veh && veh.flying ? 12 : 0;
  if (L.bar >= 0 && renderer.interiorOff) L.aim = Math.atan2(input.mouse.y - renderer.interiorOff.y - (L.by - 8), input.mouse.x - renderer.interiorOff.x - L.bx);
  else L.aim = Math.atan2(mw.y - (L.y - 8 - lift), mw.x - L.x);
  renderer.mouse.x = input.mouse.x; renderer.mouse.y = input.mouse.y;
  const mate = me && !me.dead && !me.down && !veh ? downedMateNear() : null;
  app.revHeld = !!(mate && !app.typing && input.keys.has('KeyE'));
  const fireOk = me && !me.dead && !app.menuOpen && !app.typing && !(veh && me.seat === 0) && !(L.bar >= 0) && !dancing && !me.safe && !me.down && !app.revHeld;
  app.fireL = !!(fireOk && input.mouse.L);
  app.fireR = !!(fireOk && input.mouse.R);
  setListener(L.x, L.y);

  // ---- simulate / sync
  if (isHost) hostTick(dt); else clientTick(dt);

  // ---- build the view
  const view = buildView();
  renderer.draw(view, dt);

  // ---- music: each district has its own track (style by owner)
  const rid = regionAt(world, L.x, L.y);
  app.intensityT -= dt;
  if (app.intensityT <= 0 && app.music) {
    app.intensityT = 1;
    let lvl = 0;
    for (const e of view.enemies) if (Math.abs(e.x - L.x) < 14 * TILE && Math.abs(e.y - L.y) < 10 * TILE) lvl = Math.max(lvl, e.boss ? 2 : 1);
    if (view.raids.some((r) => (r.state === 'active' || r.state === 1) && (view.mode !== 'pvp' || r.g === view.myGang))) lvl = 2;
    app.music.setIntensity(lvl);
    if (L.bar >= 0) {
      const bar = world.bars[L.bar];
      if (app.trackKey !== 'club' + bar.id) { app.trackKey = 'club' + bar.id; app.music.setTrack('club', bar.seed >>> 0); }
      app.music.setIntensity(0);
    } else if (rid >= 0 && view.rs[rid]) {
      const o = view.rs[rid].owner;
      const style = typeof o === 'number' ? ['bruxaria', 'melody', 'f150'][o] : 'volt';
      const key = style + rid;
      if (key !== app.trackKey) { app.trackKey = key; app.music.setTrack(style, ((world.seed ^ (rid * 2654435761)) >>> 0) + (typeof o === 'string' ? 77 : 0)); }
    }
  }

  // ---- HUD
  const myG = view.myGang;
  const pvp = view.mode === 'pvp';
  const hostileNear = (x, y) => Math.abs(x - L.x) < 22 * TILE && Math.abs(y - L.y) < 22 * TILE;
  const players = view.players.map((p) => {
    const hostile = pvp && p.gang !== myG;
    return { x: p.x, y: p.y, name: p.name, me: p.id === app.myId, color: p.color, hostile, hidden: hostile && !hostileNear(p.x, p.y) || p.dead };
  });
  const enemiesNear = view.enemies.filter((e) => hostileNear(e.x, e.y)).map((e) => ({ x: e.x, y: e.y, boss: e.boss }));
  const st = isHost ? app.game : null;
  const gangs = isHost ? [...st.gangs.values()].map((g) => ({ idx: g.idx, name: g.name, base: g.base, vault: g.vault, up: g.upgrades, out: g.out, owned: G.ownedCount(st, g.id) })) : client.rg.gangs;
  const myGangObj = gangs.find((g) => g.idx === myG) || gangs[0] || { name: '', vault: 0, up: {} };
  let nearVehicle = null;
  if (me && !me.dead && !me.veh) {
    for (const v of view.vehicles) {
      if (Math.abs(v.x - L.x) < 24 && Math.abs(v.y - L.y) < 24 && v.seats.some((s) => !s)) {
        const V = VEHICLES[v.type];
        const free = v.seats[0] ? 'Ride as gunner in' : 'Drive';
        nearVehicle = `${free} the ${V.name} (charge ${Math.round(v.charge)}%)${v.charge < 30 && me.bat ? ' — your battery cell will recharge it' : ''}`;
        break;
      }
    }
  }
  ui.update({
    me, prof, myName: prefs.name || 'Mano', myColor: prefs.color,
    vault: myGangObj.vault, up: myGangObj.up || {}, gangs, mode: view.mode, myGang: myG,
    squads: isHost ? app.game.raids.filter((r) => r.kind === 'g').map((r) => ({ target: r.target })) : client.rg.squads,
    rs: view.rs, raids: view.raids.map((r) => ({ target: r.target, f: r.f, state: r.state === 'warn' ? 0 : 1, t: Math.max(0, Math.round(r.t)), g: r.g })),
    gangName: myGangObj.name, gangColor: GANG_COLORS[myG], regionId: rid,
    blood: renderer.bloodOn, grenSel: app.grenSel,
    king: isHost ? (st.king ? { r: world.kingId, goal: st.kingGoal, hold: Object.entries(st.kingHold).map(([k, v]) => [k, Math.floor(v)]) } : null) : client.rg.king,
    inBase: inBaseLocal(), nearCompound: nearOwnCompound(), nearVehicle, civPrompt: L.bar >= 0 ? 0 : view.civPrompt, petPrompt: L.bar >= 0 ? '' : view.petPrompt ? view.petKind : '', quality: renderer.quality, ctxHint: contextHint(),
    barName: L.bar >= 0 ? world.bars[L.bar].name : '',
    roomCode: app.roomCode, isHost, playerCount: view.players.length, players, enemiesNear, radar: isHost ? st.radar[myGangId()] || [] : client.radar,
    vehicles: view.vehicles.map((v) => ({ x: v.x, y: v.y, charge: v.charge, type: v.type })),
    vehicle: veh ? { type: veh.type, hp: veh.hp, maxHp: veh.maxHp, charge: Math.round(veh.charge), flying: veh.flying, charging: veh.charging, seat: me.seat } : null,
    waypoints: view.waypoints, defeated: isHost ? st.defeated : client.rg.def, meX: L.x, meY: L.y,
    musicName: app.music && app.music.playing ? app.music.styleName() : '',
    seedCode: isHost ? seedCode(app.mapOpts.type, app.mapOpts.size, app.game.seed) : app.seedCode,
  }, now);
}

// ------------------------------------------------------------------ bars, belt, base buildings
function useBelt(i) {
  const me = myPrivate();
  if (!me || me.dead || !me.belt || !me.belt[i]) { sfx('error'); return; }
  sendAction({ t: 'use', s: i });
}
function enterBar() {
  const L = app.local, now = performance.now() / 1000;
  if (now - L.barT < 1) return;
  L.barT = now;
  sendAction({ t: 'barin' });
}
function enterBarLocal(id) {
  const L = app.local;
  L.bar = id; L.bx = BAR_ROOM.door.x; L.by = BAR_ROOM.door.y - 18; L.barT = performance.now() / 1000;
  L.wx = L.wy = L.ix = L.iy = 0; L.dashT = 0;
}
// player vs the room's furniture (axis-separated box collision, radius 5)
function moveInRoom(L, dx, dy) {
  const r = 5;
  const hit = (x, y) => {
    if (x < r || x > BAR_ROOM.w - r || y < r) return true;
    if (y > BAR_ROOM.h - r && !(x > BAR_ROOM.door.x - 14 && x < BAR_ROOM.door.x + 14)) return true;
    for (const b of BAR_ROOM.solids) if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return true;
    return false;
  };
  if (!hit(L.bx + dx, L.by)) L.bx += dx;
  if (!hit(L.bx, L.by + dy)) L.by += dy;
  L.by = Math.min(BAR_ROOM.h + 4, L.by);
}
// ------------------------------------------------------------------ grenades (Z throws at the cursor, C switches type)
function cycleGrenade() {
  const me = myPrivate();
  const have = GRENADE_IDS.filter((k) => me && me.gren && me.gren[k] > 0);
  if (!have.length) { ui.toast('No grenades. Buy them at the Arsenal (QG).', 'warn'); sfx('error'); return; }
  const i = have.indexOf(app.grenSel);
  app.grenSel = have[(i + 1) % have.length];
  sfx('click');
  ui.toast(`Grenade: <b>${GRENADES[app.grenSel].name}</b> (${me.gren[app.grenSel]})`, 'good');
}
function throwGrenade() {
  const me = myPrivate();
  if (!me || me.dead || me.down || app.local.bar >= 0) return;
  if (!me.gren || !(me.gren[app.grenSel] > 0)) {
    const k = GRENADE_IDS.find((x) => me.gren && me.gren[x] > 0);
    if (!k) { ui.toast('No grenades. Buy them at the Arsenal (QG).', 'warn'); sfx('error'); return; }
    app.grenSel = k;
  }
  const mw = renderer.screenToWorld(input.mouse.x, input.mouse.y);
  sendAction({ t: 'throw', k: app.grenSel, x: Math.round(mw.x), y: Math.round(mw.y) });
}

// a downed gang-mate close enough to revive
function downedMateNear() {
  const L = app.local, myG = myGangIdx();
  let best = null, bd = DOWN.reviveRange - 2;
  const list = app.mode === 'host' ? [...app.game.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, down: p.down, name: p.name, g: G.gangIdx(p.gang) }))
    : [...client.players.values()].map((o) => ({ id: o.id, x: o.x, y: o.y, down: o.down, name: (client.roster.get(o.id) || {}).name || '?', g: (client.roster.get(o.id) || {}).g }));
  for (const p of list) {
    if (p.id === app.myId || !p.down || p.g !== myG) continue;
    const d = Math.hypot(p.x - L.x, p.y - L.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// what can I interact with here? (bar door, counter, dealer, a base building)
function contextSpot() {
  const me = myPrivate();
  if (!me || me.dead || me.veh) return null;
  const L = app.local, world = app.world;
  if (L.bar >= 0) {
    const bar = world.bars[L.bar];
    const K = BAR_ROOM.counter;
    if (L.bx < K.x + K.w + 40 && L.by > K.y - 6 && L.by < K.y + K.h + 6) return { shop: 'drinks', bar };
    if (bar.dealer && Math.hypot(L.bx - BAR_ROOM.dealer.x, L.by - BAR_ROOM.dealer.y) < 40) return { shop: 'stims', bar };
    if (L.by > BAR_ROOM.h - 46 && Math.abs(L.bx - BAR_ROOM.door.x) < 30) return { exit: true, bar };
    return null;
  }
  for (const b of world.bars) {
    const d = Math.hypot(b.doorX - L.x, b.doorY - L.y);
    if (d < 22) return { door: b.id, bar: b, close: d < 14 };
  }
  {
    const r = regionAt(world, L.x, L.y);
    const rs = r >= 0 ? (app.mode === 'host' ? app.game.rs : client.rg ? client.rg.rs : [])[r] : null;
    const B = r >= 0 ? world.regions[r].compound.boca : null;
    if (B && rs && rs.owner === myGangId() && Math.hypot(B.x - L.x, B.y - L.y) < 22) return { boca: r, lvl: rs.up ? rs.up.boca || 0 : 0 };
  }
  if (inBaseLocal()) {
    const r = regionAt(world, L.x, L.y);
    const C = world.regions[r].compound;
    for (const st of C.stations || []) {
      const x = (st.x + 0.5) * TILE, y = (st.y + 0.5) * TILE;
      if (Math.abs(x - L.x) < (st.kind === 'garage' ? 2.5 : 1.8) * TILE && Math.abs(y - L.y) < 1.6 * TILE) return { tab: st.kind };
    }
  }
  return null;
}
const SPOT_NAME = { arsenal: 'ARSENAL — buy & upgrade arms', clinic: 'CLÍNICA — body mods', locker: 'ARMÁRIO — equip arms', vault: 'COFRE — gang vault', garage: 'GARAGEM — vehicles' };
function contextHint() {
  const me = myPrivate();
  if (me && me.down) return `YOU ARE DOWN — crawl to cover, a gang-mate can revive you · [X] give up`;
  const mate = me && !me.dead ? downedMateNear() : null;
  if (mate) return me.rv > 0 ? `REVIVING ${mate.name.toUpperCase()}... ${Math.round(me.rv * 100)}%` : `[HOLD E] Revive ${mate.name}`;
  const s = contextSpot();
  if (me && me.emo > 0) return '♪ DANÇANDO... ♪';
  if (!s) return me && me.bar >= 0 ? 'Walk out through the door (bottom) to leave' : '';
  if (s.shop === 'drinks') return `[B] BALCÃO — buy drinks (${s.bar.name})`;
  if (s.shop === 'stims') return '[B] Talk to the dealer — cyber stims (risky)';
  if (s.exit) return 'Walk through the door to go back outside';
  if (s.door !== undefined) return `[E] Enter ${s.bar.name}${s.bar.dealer ? ' · bar + dealer' : ' · bar'}`;
  if (s.tab) return `[B] ${SPOT_NAME[s.tab]}`;
  if (s.boca !== undefined) return `[B] BOCA DE FUMO (level ${s.lvl + 1}/4) — upgrade it for more customers`;
  return '';
}

function inBaseLocal() {
  const r = regionAt(app.world, app.local.x, app.local.y);
  if (r < 0 || !app.world.regions[r].base) return false;
  const rs = app.mode === 'host' ? app.game.rs : client.rg ? client.rg.rs : null;
  return !!rs && rs[r].owner === myGangId();
}
function nearOwnCompound() {
  const r = regionAt(app.world, app.local.x, app.local.y);
  if (r < 0) return -1;
  const rs = app.mode === 'host' ? app.game.rs : client.rg ? client.rg.rs : null;
  if (!rs || rs[r].owner !== myGangId()) return -1;
  const C = app.world.regions[r].compound;
  return Math.abs((C.coreX + 0.5) * TILE - app.local.x) < 5 * TILE && Math.abs((C.coreY + 0.5) * TILE - app.local.y) < 5 * TILE ? r : -1;
}

let spriteGuess = null;
function currentSpriteGuess() {
  if (!spriteGuess) {
    const c = document.createElement('canvas'); c.width = 12; c.height = 22;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(3, 0, 6, 6); g.fillRect(2, 6, 8, 9); g.fillRect(3, 15, 6, 7);
    c.ax = 6; c.ay = 21; spriteGuess = c;
  }
  return spriteGuess;
}

function buildView() {
  const isHost = app.mode === 'host';
  const L = app.local;
  const chatOf = (id) => { const c = app.chats.get(id); return c && c.t > renderer.time ? c : null; };
  let players, enemies, allies, pickups, projectiles, turrets, vehicles, civs, rs, raids, dayT, broken, mode, waypointsSrc, pcars, helis, pets, ufo;
  const myG = myGangIdx();
  if (isHost) {
    const g = app.game;
    mode = g.mode;
    players = [...g.players.values()].map((p) => ({
      id: p.id, x: p.id === 'host' ? L.x : p.x, y: p.id === 'host' ? L.y : p.y, aim: p.id === 'host' ? L.aim : p.aim,
      hp: p.hp, maxHp: p.maxHp, dead: p.dead, out: p.out, cloak: p.cloakT > 0, shield: p.shieldHp > 0, inv: p.invulnT > 0, burn: p.burnT > 0,
      name: p.name, look: p.look, equip: p.equip, mods: p.mods, level: p.level, chat: chatOf(p.id), color: p.color, gang: G.gangIdx(p.gang),
      veh: p.veh || 0, seat: p.seat,
      down: !!p.down, revP: p.revP || 0, downT: p.downT || 0,
      bar: p.inBar, bx: p.id === 'host' ? L.bx : p.bx, by: p.id === 'host' ? L.by : p.by, emote: p.emoteT > 0 ? p.emote + 1 : 0, ...(() => { const pf = G.profile(p); return { ghost: !!pf.ghost, fury: pf.fury }; })(),
    }));
    enemies = [...g.enemies.values()].map((e) => ({ ...e, burn: e.burnT > 0 }));
    allies = [...g.allies.values()].filter((a) => !a.hidden).map((a) => ({ id: a.id, x: a.x, y: a.y, hp: a.hp, maxHp: a.maxHp, flash: a.flash, moving: a.moving, aim: a.aim, team: G.gangIdx(a.team), follow: a.follow, tier: a.tier, civ: a.civ, melee: a.melee, lvl: a.lvl || 1, rev: a.revT > 0, emote: a.emoteT > 0 ? a.emote + 1 : 0 }));
    pets = [...g.pets.values()].map((a) => ({ id: a.id, x: a.x, y: a.y, kind: a.kind, seed: a.seed, moving: a.moving, flee: a.flee > 0, happy: a.happyT > 0, sit: a.sit, aim: a.aim }));
    ufo = g.ufo ? { id: g.ufo.id, x: g.ufo.x, y: g.ufo.y, state: g.ufo.state, t: g.ufo.t } : null;
    turrets = [...g.turrets.values()].map((t) => ({ id: t.id, x: t.x, y: t.y, aim: t.aim, hp: t.hp, maxHp: t.maxHp, type: t.type, mk: t.mk, team: G.gangIdx(t.team), dead: t.deadT > 0, flash: t.flash > 0 }));
    vehicles = [...g.vehicles.values()].map((v) => ({ id: v.id, type: v.type, x: v.x, y: v.y, hp: v.hp, maxHp: v.maxHp, charge: v.charge, dir: v.dir, flying: v.flying, flash: v.flash > 0, charging: v.charging, team: G.gangIdx(v.team), seats: v.seats, civ: v.civ ? 1 : 0 }));
    pickups = [...g.pickups.values()]; projectiles = g.projectiles;
    civs = [...g.civs.values()].map((c) => ({ id: c.id, x: c.x, y: c.y, seed: c.seed, flee: c.flee > 0, flash: c.flash > 0, moving: c.moving, aim: c.aim, hpPct: Math.round(100 * c.hp / c.maxHp) }));
    rs = g.rs; raids = g.raids.filter((r) => !r.kind).map((r) => ({ ...r, g: G.gangIdx(r.gang) })); dayT = g.dayT;
    broken = new Set([...g.brk.entries()].filter(([, s]) => s.deadT > 0).map(([k]) => k));
    waypointsSrc = [...g.players.values()].map((p) => ({ name: p.name, color: p.color, wp: p.wp, g: G.gangIdx(p.gang), me: p.id === 'host' }));
    pcars = [...g.pcars.values()].map((c) => ({ x: c.x, y: c.y, dir: c.dir, state: c.state === 'in' ? 0 : c.state === 'drop' ? 1 : 2 }));
    helis = [...g.helis.values()].map((h) => ({ x: h.x, y: h.y, aim: h.aim, kind: h.kind, atk: h.state === 'atk' }));
  } else {
    mode = client.mode;
    players = [];
    for (const o of client.players.values()) {
      const r = client.roster.get(o.id) || {};
      const mine = o.id === app.myId;
      players.push({
        id: o.id, x: mine ? L.x : o.x, y: mine ? L.y : o.y, aim: mine ? L.aim : o.aim, hp: mine ? client.me.hp : o.hp, maxHp: mine ? client.me.maxHp : o.maxHp,
        dead: mine ? client.me.dead : o.dead, out: o.out, cloak: o.cloak, shield: o.shield, inv: o.inv, burn: o.burn,
        name: r.name || '?', look: r.look || {}, equip: mine && client.prof ? client.prof.equip : r.equip, mods: mine && client.prof ? client.prof.mods : r.mods, level: o.level, chat: chatOf(o.id),
        color: r.color, gang: r.g ?? 0, veh: o.veh, seat: o.seat,
        down: o.down, revP: o.revP, downT: o.downT,
        bar: mine ? client.me.bar : o.bar, bx: mine ? L.bx : o.bx, by: mine ? L.by : o.by, emote: o.emote, ghost: mine && client.prof ? !!client.prof.ghost : o.ghost, fury: mine && client.prof ? client.prof.fury : false,
      });
    }
    enemies = [...client.enemies.values()]; allies = [...client.allies.values()]; pickups = [...client.pickups.values()]; projectiles = client.projectiles;
    turrets = [...client.turrets.values()]; vehicles = [...client.vehicles.values()]; civs = [...client.civs.values()];
    rs = client.rg.rs; raids = client.rg.raids; dayT = client.day; broken = client.rg.broken;
    waypointsSrc = [...client.roster.values()].map((r) => ({ name: r.name, color: r.color, wp: r.wp, g: r.g, me: r.id === app.myId }));
    pcars = [...client.pcars.values()]; helis = [...client.helis.values()];
    pets = [...client.pets.values()]; ufo = client.ufo;
  }
  // my own vehicle follows my local prediction when I drive
  const me0 = myPrivate();
  if (me0 && me0.veh && me0.seat === 0) {
    const v = vehicles.find((x) => x.id === me0.veh);
    if (v) { const i = vehicles.indexOf(v); vehicles[i] = { ...v, x: L.x, y: L.y, dir: Math.abs(L.vx) + Math.abs(L.vy) > 8 ? (Math.abs(L.vx) > Math.abs(L.vy) * 0.9 ? (L.vx > 0 ? 2 : 1) : (L.vy > 0 ? 0 : 3)) : v.dir }; }
  }
  const waypoints = waypointsSrc.filter((w) => w.wp && (mode !== 'pvp' || w.g === myG)).map((w) => ({ x: w.wp.x, y: w.wp.y, color: w.color || '#fff', name: w.name, mine: w.me }));
  const meP = players.find((p) => p.id === app.myId);
  if (meP && meP.veh) { const v = vehicles.find((x) => x.id === meP.veh); if (v) meP.alt = v.flying ? 11 : 1; }
  let civPrompt = 0;
  let petPrompt = 0, petKind = '';
  if (meP && !meP.dead && !meP.veh) {
    let bd = 24 * 24; for (const c of civs) { const d = (c.x - L.x) ** 2 + (c.y - L.y) ** 2; if (d < bd && !c.flee) { bd = d; civPrompt = c.id; } }
    let pd = 22 * 22; for (const a of pets) { const d = (a.x - L.x) ** 2 + (a.y - L.y) ** 2; if (d < pd && d <= bd && !a.flee) { pd = d; petPrompt = a.id; petKind = a.kind; } }
    if (petPrompt) civPrompt = 0;
  }
  if (meP && L.bar >= 0) meP.bar = L.bar;
  let interior = null;
  if (meP && L.bar >= 0) {
    const bar = app.world.bars[L.bar];
    const inside = players.filter((p) => p.bar === L.bar && !p.dead).map((p) => (p.id === app.myId ? { ...p, x: L.bx, y: L.by, moving: L.moving } : { ...p, x: p.bx, y: p.by }));
    const spot = contextSpot();
    let prompt = null;
    if (spot && spot.shop) prompt = { text: spot.shop === 'stims' ? '[B] FALA AI' : '[B] BALCAO', x: L.bx, y: L.by - 40 };
    interior = { bar, me: { x: L.bx, y: L.by }, players: inside, prompt };
  }
  const prof = myProfile();
  return { world: app.world, me: meP, meMoving: L.moving, players, enemies, allies, pickups, projectiles, turrets, vehicles, civs, civPrompt, petPrompt, petKind, pets, ufo, rs, raids, gangColor: GANG_COLORS[myG], myGang: myG, mode, dayT, broken, waypoints, pcars, helis, interior, sway: !!(prof && prof.sway) };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ------------------------------------------------------------------ go
setupTitle();
requestAnimationFrame(frame);
window.__app = app;
window.__G = G;
window.__client = client;
window.__renderer = renderer;
void FACTIONS;
