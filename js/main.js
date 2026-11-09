// App flow: title screen, hosting/joining, the game loop, prediction, events → effects/sounds.
//
// Networking model (host-authoritative, peer-to-peer via PeerJS):
//   - The host's browser runs the real simulation (game.js): enemies, damage, money, territory.
//   - Each player moves their own character locally (instant, smooth) and sends position + aim + buttons.
//   - The host sends each friend a snapshot ~20x/s with what is near them, plus events (shots, hits...).
//   - The city is generated from a seed, so the host only sends the seed, never the map.

import { TILE, WEAPONS, ABILITIES, randomLook, LOOK_KEYS, LOOK_OPTIONS, GANG_COLORS } from './data.js';
import { randomSeed } from './rng.js';
import { generateWorld, moveBox, regionAt, rayCast, opaqueAt, W, H } from './world.js';
import * as G from './game.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { initAudio, sfx, setListener, setVolume, getVolume } from './audio.js';
import { createMusic } from './music.js';
import { PROTOCOL, makeCode, cleanCode, send, receiver, hostRoom, joinRoom, errorText } from './net.js';

const SAVE_KEY = 'neonquebrada.save.v1';
const PREFS_KEY = 'neonquebrada.prefs.v1';
const PKEY = 'neonquebrada.pkey';
const STEP = 1 / 60;
const MAX_PLAYERS = 6;

// ------------------------------------------------------------------ prefs / storage
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const prefs = Object.assign({ name: '', look: randomLook(), gangName: 'Bonde Neon', gangColor: GANG_COLORS[0], music: 0.6, sfx: 0.8 }, store.get(PREFS_KEY) || {});
for (const k of LOOK_KEYS) if (!(prefs.look[k] >= 0 && prefs.look[k] < LOOK_OPTIONS[k].length)) prefs.look[k] = 0;
let playerKey = store.get(PKEY);
if (!playerKey) { playerKey = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set(PKEY, playerKey); }
setVolume('music', prefs.music); setVolume('sfx', prefs.sfx);

// ------------------------------------------------------------------ app state
const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const input = createInput(canvas);
window.addEventListener('resize', () => renderer.resize());

const app = {
  mode: 'title',            // title | host | client
  world: null, game: null, myId: 'host', roomCode: null,
  local: { x: 0, y: 0, aim: 0, dashT: 0, dashX: 0, dashY: 0, moving: false },
  menuOpen: false, typing: false, music: null, musicOn: true,
  titleCam: { t: 0 }, saveT: 0, sendT: 0, snapT: 0, acc: 0, intensityT: 0,
  chats: new Map(),
};
const host = { peer: null, clients: new Map() };
const client = {
  peer: null, conn: null, players: new Map(), enemies: new Map(), allies: new Map(), pickups: new Map(), projectiles: [],
  me: null, prof: null, rg: null, roster: new Map(), day: 0.3, cd: { L: 0, R: 0 }, lastSnap: 0,
};

const ui = createUI(document.getElementById('menus'), {
  prefs,
  savePrefs: () => store.set(PREFS_KEY, prefs),
  sound: (n) => sfx(n),
  onHost: (o) => { unlockAudio(); startHost(null, o); },
  onContinue: () => { unlockAudio(); const s = store.get(SAVE_KEY); if (s) startHost(s, { gangName: s.gangName, gangColor: s.gangColor }); },
  onJoin: (code) => { unlockAudio(); startJoin(code); },
  onAction: (a) => sendAction(a),
  onChat: (text) => sendChat(text),
  setTyping: (v) => { app.typing = v; input.typing = v; },
  setMenuOpen: (v) => { app.menuOpen = v; },
  copyInvite,
  onVolume: (k, v) => { setVolume(k, v); prefs[k] = v; store.set(PREFS_KEY, prefs); },
  onSetting: (k) => {
    if (k === 'invite') copyInvite();
    if (k === 'leave') leaveGame();
    if (k === 'newtrack' && app.music) { app.music.reseed(randomSeed()); ui.toast('New track rolling...'); }
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
  const s = store.get(SAVE_KEY);
  ui.showSave(s && s.v === 1 ? s : null);
  const room = cleanCode(new URLSearchParams(location.search).get('room'));
  if (room.length === 4) { ui.setCode(room); ui.status(`Invite for room ${room} — pick a name and press JOIN.`); }
  else ui.status('');
}

// ------------------------------------------------------------------ hosting
async function startHost(save, opts) {
  ui.status('Building the city...');
  await new Promise((r) => setTimeout(r, 30));
  const seed = save ? save.seed : randomSeed();
  const world = generateWorld(seed);
  const game = G.createGame(world, { gangName: opts.gangName, gangColor: opts.gangColor, save });
  app.mode = 'host'; app.world = world; app.game = game; app.myId = 'host';
  const p = G.addPlayer(game, { id: 'host', key: playerKey, name: prefs.name || 'Mano', look: { ...prefs.look } });
  app.local.x = p.x; app.local.y = p.y;
  game.events.length = 0;
  renderer.setWorld(world);
  renderer.snapCam = true;
  ui.showHUD(world);
  ui.log(`Welcome to <b>${escapeHtml(game.gangName)}</b>. Take the city, one district at a time.`, 'gold');
  ui.log('Kill the garrison of a nearby district, then stand on its core.', 'info');
  if (app.music) app.music.reseed(seed);
  saveNow();
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
    if (app.game.players.size >= MAX_PLAYERS) { send(conn, { t: 'full' }); setTimeout(() => conn.close(), 300); return; }
    host.clients.set(conn.peer, { conn, joined: false, outbox: [], rosterVer: 0, regionVer: 0, rgT: 0 });
  });
  conn.on('data', receiver((msg) => onClientMsg(conn.peer, msg)));
  conn.on('close', () => dropClient(conn.peer));
  conn.on('error', () => dropClient(conn.peer));
}

function dropClient(id) {
  const c = host.clients.get(id);
  if (!c) return;
  host.clients.delete(id);
  if (c.joined && app.game) G.removePlayer(app.game, id);
}

function onClientMsg(id, msg) {
  const c = host.clients.get(id);
  const game = app.game;
  if (!c || !game || !msg) return;
  if (msg.t === 'hello') {
    if (msg.proto !== PROTOCOL) { send(c.conn, { t: 'err', text: 'Game version mismatch — refresh the page.' }); return; }
    if ([...game.players.values()].some((p) => p.key === msg.key)) msg.key += '-' + id.slice(0, 4);
    const look = msg.look && typeof msg.look === 'object' ? msg.look : randomLook();
    const p = G.addPlayer(game, { id, key: String(msg.key || id).slice(0, 60), name: String(msg.name || 'Mano').slice(0, 14), look });
    c.joined = true;
    send(c.conn, {
      t: 'welcome', id, seed: game.seed, rg: G.regionState(game), ro: G.roster(game), prof: G.profile(p), me: G.privateState(p),
      x: p.x, y: p.y, day: game.dayT,
    });
    c.rosterVer = game.rosterVer; c.regionVer = game.regionVer;
    return;
  }
  if (!c.joined) return;
  if (msg.t === 'i') G.setInput(game, id, msg);
  else if (msg.t === 'ab') G.useAbility(game, id, msg.k);
  else if (msg.t === 'act') G.handleAction(game, id, msg.a);
  else if (msg.t === 'chat') {
    const p = game.players.get(id);
    if (p) G.emit(game, { t: 'chat', id, name: p.name, text: String(msg.text).slice(0, 80) });
  }
}

function hostTick(dt) {
  const game = app.game;
  G.setInput(game, 'host', { x: app.local.x, y: app.local.y, aim: app.local.aim, fireL: app.fireL, fireR: app.fireR });
  app.acc += dt;
  let steps = 0;
  while (app.acc >= STEP && steps < 5) { G.step(game, STEP); app.acc -= STEP; steps++; }
  if (steps >= 5) app.acc = 0;
  // events
  const evs = game.events;
  game.events = [];
  for (const ev of evs) {
    if (!ev.to || ev.to === 'host') handleEvent(ev);
    for (const [id, c] of host.clients) if (c.joined && (!ev.to || ev.to === id)) c.outbox.push(ev);
  }
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
      if ((c.regionVer !== game.regionVer && c.rgT > 0.25) || c.rgT > 2) { snap.rg = G.regionState(game); c.regionVer = game.regionVer; c.rgT = 0; }
      if (p.dirty) { snap.prof = G.profile(p); p.dirty = false; }
      send(c.conn, snap);
    }
  }
  app.saveT += dt;
  if (app.saveT > 30) { app.saveT = 0; saveNow(); }
}

function saveNow() {
  if (app.mode !== 'host' || !app.game) return;
  store.set(SAVE_KEY, G.serialize(app.game));
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
    send(conn, { t: 'hello', proto: PROTOCOL, name: prefs.name || 'Mano', look: prefs.look, key: playerKey });
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
  client.players.clear(); client.enemies.clear(); client.allies.clear(); client.pickups.clear(); client.projectiles = [];
  client.me = null; client.prof = null; client.rg = null;
}

function onHostMsg(msg) {
  if (!msg) return;
  if (msg.t === 'full') { hostLost('That room is full (6 players max).'); return; }
  if (msg.t === 'err') { hostLost(msg.text); return; }
  if (msg.t === 'welcome') {
    app.mode = 'client';
    app.myId = msg.id;
    app.world = generateWorld(msg.seed);
    renderer.setWorld(app.world);
    renderer.snapCam = true;
    app.local.x = msg.x; app.local.y = msg.y;
    client.rg = unpackRegions(msg.rg);
    client.roster = new Map(msg.ro.map((r) => [r.id, r]));
    client.prof = msg.prof; client.me = msg.me; client.day = msg.day;
    ui.showHUD(app.world);
    ui.log(`Joined <b>${escapeHtml(client.rg.gang)}</b>! Take the city together.`, 'gold');
    if (app.music) app.music.reseed(msg.seed);
    return;
  }
  if (app.mode !== 'client') return;
  if (msg.t === 's') applySnapshot(msg);
}

function unpackRegions(rg) {
  return {
    rs: rg.rs.map((a) => ({ owner: a[0] === 9 ? 'g' : a[0], garrison: a[1], garrisonMax: a[2], capture: a[3] / 100, guards: a[4], hqUnlocked: !!(a[5] & 1), bossDefeated: !!(a[5] & 2) })),
    raids: rg.raids.map((a) => ({ target: a[0], f: a[1], state: a[2] ? 'active' : 'warn', t: a[3] })),
    vault: rg.vault, up: rg.up, def: rg.def, win: rg.win, gang: rg.gang, gc: rg.gc,
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
  client.me = s.me;
  if (s.prof) client.prof = s.prof;
  if (s.ro) client.roster = new Map(s.ro.map((r) => [r.id, r]));
  if (s.rg) client.rg = unpackRegions(s.rg);
  syncMap(client.players, s.P, (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => {
    o.tx = r[1]; o.ty = r[2]; o.aim = r[3]; o.hp = r[4]; o.maxHp = r[5];
    o.dead = !!(r[6] & 1); o.cloak = !!(r[6] & 2); o.shield = !!(r[6] & 4); o.inv = !!(r[6] & 8); o.level = r[7];
  });
  syncMap(client.enemies, s.E, (r) => ({ id: r[0], x: r[2], y: r[3] }), (o, r) => {
    o.faction = Math.floor(r[1] / 10); const t = r[1] % 10; o.boss = t === 6; o.tier = o.boss ? 5 : t;
    o.tx = r[2]; o.ty = r[3]; o.hp = r[4]; o.maxHp = r[5];
    o.windup = r[6] & 1; o.flash = r[6] & 2 ? 0.1 : 0; o.raid = !!(r[6] & 4); o.moving = !!(r[6] & 8);
    o.stars = r[7]; o.aim = r[8]; o.atk = G.ATTACK_KEYS[r[9]];
  });
  syncMap(client.allies, s.A, (r) => ({ id: r[0], x: r[1], y: r[2] }), (o, r) => {
    o.tx = r[1]; o.ty = r[2]; o.hp = r[3]; o.maxHp = r[4]; o.flash = r[5] & 2 ? 0.1 : 0; o.moving = !!(r[5] & 8); o.aim = r[6];
  });
  syncMap(client.pickups, s.K, (r) => ({ id: r[0] }), (o, r) => { o.type = r[1] ? 'heal' : 'cash'; o.x = r[2]; o.y = r[3]; });
  if (s.ev) for (const ev of s.ev) handleEvent(ev);
}

function clientTick(dt) {
  // interpolate others
  const k = Math.min(1, dt * 14);
  for (const m of [client.players, client.enemies, client.allies]) for (const o of m.values()) {
    if (o.tx === undefined) continue;
    if (Math.abs(o.tx - o.x) > 120 || Math.abs(o.ty - o.y) > 120) { o.x = o.tx; o.y = o.ty; }
    o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k;
  }
  // cosmetic projectiles
  const keep = [];
  for (const p of client.projectiles) {
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0 || opaqueAt(app.world, p.x, p.y)) continue;
    if (p.local && p.team === 'g') {
      let hit = false;
      for (const e of client.enemies.values()) if (Math.abs(e.x - p.x) < 8 && Math.abs(e.y - 6 - p.y) < 10) { hit = true; break; }
      if (hit) continue;
    }
    keep.push(p);
  }
  client.projectiles = keep;
  // send input ~30 Hz
  app.sendT += dt;
  if (app.sendT >= 0.033 && client.conn) {
    app.sendT = 0;
    send(client.conn, { t: 'i', x: +app.local.x.toFixed(1), y: +app.local.y.toFixed(1), aim: +app.local.aim.toFixed(3), fireL: app.fireL, fireR: app.fireR });
  }
  // local predicted attacks (visual only; the host decides hits)
  if (client.me && !client.me.dead && client.prof) {
    for (const slot of ['L', 'R']) {
      client.cd[slot] -= dt;
      const firing = slot === 'L' ? app.fireL : app.fireR;
      if (firing && client.cd[slot] <= 0) {
        const wid = client.prof.equip[slot];
        client.cd[slot] = WEAPONS[wid].cd;
        predictFire(slot, wid);
      }
    }
  }
}

function predictFire(slot, wid) {
  const Wp = WEAPONS[wid];
  const L = app.local, a = L.aim;
  const ox = L.x + Math.cos(a) * 6, oy = L.y - 8 + Math.sin(a) * 6;
  const key = 'p' + app.myId;
  if (Wp.kind === 'melee') {
    renderer.swing(key, slot, a, wid);
    renderer.effect({ k: 'arc', x: L.x, y: L.y - 7, a, arc: Wp.arc, r: Wp.range * 0.8, c: wid === 'blade' ? '#ff3fa4' : '#c9d3df', life: 0.12 });
    sfx(wid === 'blade' ? 'slash' : 'punch');
  } else if (Wp.kind === 'ranged') {
    const n = Wp.pellets || 1;
    for (let i = 0; i < n; i++) {
      const sa = a + (n > 1 ? (i / (n - 1) - 0.5) * Wp.spread : (Math.random() - 0.5) * Wp.spread);
      const sp = Wp.speed * (n > 1 ? 0.85 + Math.random() * 0.3 : 1);
      client.projectiles.push({ x: ox, y: oy, vx: Math.cos(sa) * sp, vy: Math.sin(sa) * sp, life: Wp.life, kind: Wp.proj, team: 'g', local: true });
    }
    renderer.recoil(key, slot);
    muzzle(ox + Math.cos(a) * 10, oy + Math.sin(a) * 10, a);
    sfx(Wp.proj === 'pellet' ? 'shotgun' : Wp.proj === 'smart' ? 'smg' : 'pistol');
  } else if (Wp.kind === 'whip') {
    const len = rayCast(app.world, ox, oy, a, Wp.range);
    renderer.swing(key, slot, a, 'whip', 0.15);
    renderer.effect({ k: 'whip', x: ox, y: oy, x2: ox + Math.cos(a) * len, y2: oy + Math.sin(a) * len, life: 0.16 });
    sfx('whip');
  } else if (Wp.kind === 'slam') {
    renderer.swing(key, slot, a, 'hammer', 0.25);
    const cx = L.x + Math.cos(a) * 16, cy = L.y - 4 + Math.sin(a) * 16;
    renderer.effect({ k: 'ring', x: cx, y: cy, r: Wp.radius, c: '#ffd23f', life: 0.3 });
    renderer.burst(cx, cy, ['#8a7f78', '#c8b8a0', '#ffd23f'], 14, 70, 0.5);
    renderer.addShake(3);
    sfx('slam');
  } else if (Wp.kind === 'rocket') {
    client.projectiles.push({ x: ox, y: oy, vx: Math.cos(a) * Wp.speed, vy: Math.sin(a) * Wp.speed, life: Wp.life, kind: 'rocket', team: 'g', local: true });
    renderer.recoil(key, slot);
    sfx('rocket');
  } else if (Wp.kind === 'beam') {
    const len = rayCast(app.world, ox, oy, a, Wp.range);
    renderer.effect({ k: 'beam', x: ox, y: oy, x2: ox + Math.cos(a) * len, y2: oy + Math.sin(a) * len, c: '#22e5ff', life: 0.22 });
    renderer.recoil(key, slot);
    renderer.addShake(2);
    sfx('beam');
  }
}

function muzzle(x, y, a) { renderer.effect({ k: 'muzzle', x, y, a, life: 0.05 }); }

// ------------------------------------------------------------------ events → effects, sounds, UI
const SHOT_SFX = { pulse: 'pistol', pellet: 'shotgun', smart: 'smg', rocket: 'rocket', ebullet: 'ebullet', eball: 'ebullet', erocket: 'rocket' };

function handleEvent(ev) {
  const isHost = app.mode === 'host';
  const myKey = 'p' + app.myId;
  const mine = !isHost && ev.o === myKey;
  const me = currentMe();
  const near = (x, y, d = 200) => me && Math.abs(x - app.local.x) < d && Math.abs(y - app.local.y) < d;
  switch (ev.t) {
    case 'shot': {
      if (!isHost && !(ev.tm === 'g' && ev.o === app.myId)) {
        client.projectiles.push({ id: ev.i, x: ev.x, y: ev.y, vx: Math.cos(ev.a) * ev.s, vy: Math.sin(ev.a) * ev.s, life: ev.l, kind: ev.k, team: ev.tm });
      }
      if (isHost || ev.o !== app.myId) {
        sfx(SHOT_SFX[ev.k] || 'pistol', ev.x, ev.y, ev.tm === 'e' ? 0.7 : 0.8);
        if (ev.o && typeof ev.o === 'string') renderer.recoil('p' + ev.o, 'R');
        muzzle(ev.x, ev.y, ev.a);
      }
      break;
    }
    case 'hitp': client.projectiles = client.projectiles.filter((p) => p.id !== ev.i); break;
    case 'spark':
      if (!isHost) client.projectiles = client.projectiles.filter((p) => p.id !== ev.i);
      renderer.burst(ev.x, ev.y, ['#ffd23f', '#ffffff', '#ff8a3d'], 4, 40, 0.25);
      sfx('spark', ev.x, ev.y, 0.5);
      break;
    case 'dmg': {
      const col = { hit: '#ffffff', crit: '#ffd23f', player: '#ff3b5c', heal: '#3ddc84', ally: '#ff9ab8' }[ev.c] || '#fff';
      renderer.text(ev.x + (Math.random() - 0.5) * 6, ev.y, (ev.c === 'heal' ? '+' : '') + ev.v + (ev.c === 'crit' ? '!' : ''), col);
      if (ev.c === 'hit' || ev.c === 'crit') { renderer.burst(ev.x, ev.y + 8, ['#ffffff', '#ffd23f', '#9af0ff'], 4, 50, 0.25); sfx('hit', ev.x, ev.y, 0.6); }
      break;
    }
    case 'hurt':
      if (ev.id === app.myId) { renderer.screenFlash('#ff0030', 0.25); renderer.addShake(2.5); sfx('hurt'); }
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
    case 'boom':
      renderer.effect({ k: 'boom', x: ev.x, y: ev.y, r: ev.r, life: 0.45 });
      renderer.burst(ev.x, ev.y, ['#ffd23f', '#ff6a2b', '#ff3b5c', '#5a4a5a'], 26, 120, 0.7);
      if (near(ev.x, ev.y, 260)) renderer.addShake(6);
      sfx('boom', ev.x, ev.y);
      break;
    case 'tele': renderer.effect({ k: 'tele', x: ev.x, y: ev.y, r: ev.r, d: ev.d }); sfx('tele', ev.x, ev.y, 0.6); break;
    case 'die': {
      const cols = ev.f >= 0 ? ['#ffffff', '#ffd23f', '#9aa6b8', '#56606e', ['#c9c05a', '#3ad0ff', '#a66bff'][ev.f]] : ['#ffffff', '#ff9ab8'];
      renderer.burst(ev.x, ev.y - 6, cols, 10 + Math.round(ev.b * 8), 70 * ev.b, 0.7, 120);
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 6, r: 10 * ev.b, c: '#ffffff', life: 0.2 });
      sfx(ev.b > 1.4 ? 'bigdie' : 'die', ev.x, ev.y);
      if (ev.boss) { renderer.addShake(8); renderer.effect({ k: 'boom', x: ev.x, y: ev.y, r: 60, life: 0.8 }); }
      break;
    }
    case 'pdie':
      renderer.burst(ev.x, ev.y - 6, ['#ff3b5c', '#ffffff', '#aeb9c9'], 24, 90, 0.9, 120);
      if (ev.id === app.myId) { sfx('death'); renderer.screenFlash('#ff0030', 0.5); ui.log(`You went down to <b>${escapeHtml(ev.by)}</b>${ev.loss ? ` and dropped <b class="gold">R$${ev.loss}</b>` : ''}.`, 'bad'); }
      else { sfx('die', ev.x, ev.y); ui.log(`<b>${escapeHtml(ev.name)}</b> went down to ${escapeHtml(ev.by)}!`, 'bad'); }
      break;
    case 'eup':
      renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 10, r: 26, c: '#ff3b5c', life: 0.5 });
      renderer.text(ev.x, ev.y - 40, 'LEVEL UP!', '#ff3b5c', 1.4, -16);
      sfx('enemyup', ev.x, ev.y);
      ui.log(`The ${escapeHtml(ev.name)} who killed ${escapeHtml(ev.victim)} grew stronger!`, 'bad');
      break;
    case 'lvl':
      renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#ffd23f', life: 0.9 });
      renderer.burst(ev.x, ev.y - 10, ['#ffd23f', '#ffffff'], 20, 60, 0.9);
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
      const ent = entityByKey('p' + ev.id);
      if (ev.k === 'dash') { sfx('dash', ev.x, ev.y); renderer.burst(ev.x, ev.y, ['#c8c0d8', '#ffffff'], 8, 50, 0.3); }
      if (ev.k === 'heal') { sfx('heal', ev.x, ev.y); renderer.burst(ev.x, ev.y - 8, ['#3ddc84', '#a0ffc0', '#ffffff'], 16, 40, 0.8); renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 6, r: 16, c: '#3ddc84', life: 0.4 }); }
      if (ev.k === 'cloak') { sfx('cloak', ev.x, ev.y); renderer.burst(ev.x, ev.y - 8, ['#22e5ff', '#a66bff'], 18, 50, 0.6); }
      if (ev.k === 'uncloak') renderer.burst(ev.x, ev.y - 8, ['#22e5ff', '#ffffff'], 10, 40, 0.4);
      if (ev.k === 'shield') { sfx('shield', ev.x, ev.y); renderer.effect({ k: 'ring', x: ev.x, y: ev.y - 8, r: 18, c: '#4fc3ff', life: 0.4 }); }
      if (ev.k === 'shieldbreak') renderer.burst(ev.x, ev.y - 8, ['#4fc3ff', '#ffffff'], 14, 70, 0.4);
      void ent;
      break;
    }
    case 'tp':
      if (ev.id === app.myId) { app.local.x = ev.x; app.local.y = ev.y; renderer.snapCam = true; sfx('respawn'); renderer.effect({ k: 'pillar', x: ev.x, y: ev.y, c: '#22e5ff', life: 0.7 }); }
      break;
    case 'cap': {
      const R = app.world.regions[ev.r];
      const C = R.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      renderer.effect({ k: 'ring', x, y, r: 60, c: gangColor(), life: 0.8 });
      renderer.burst(x, y - 30, [gangColor(), '#ffffff', '#ffd23f'], 40, 110, 1.2, 80);
      sfx('capture');
      ui.alert(`<b>${escapeHtml(R.name)}</b> is ours! The people join the gang.`, 'good');
      ui.log(`Captured <b>${escapeHtml(R.name)}</b>. Guards are posted and income flows to the vault.`, 'good');
      break;
    }
    case 'cleared': ui.log(`Garrison of <b>${escapeHtml(app.world.regions[ev.r].name)}</b> wiped out. Take the core!`, 'good'); break;
    case 'lost': sfx('lost'); ui.alert(`We lost <b>${escapeHtml(app.world.regions[ev.r].name)}</b> to ${factionName(ev.f)}!`, 'raid'); ui.log(`${factionName(ev.f)} retook <b>${escapeHtml(app.world.regions[ev.r].name)}</b>.`, 'bad'); break;
    case 'raid': sfx('alarm'); ui.alert(`⚠ ${factionName(ev.f)} will raid <b>${escapeHtml(app.world.regions[ev.r].name)}</b> in ${ev.eta}s!`, 'raid', 7000); ui.log(`Raid incoming on <b>${escapeHtml(app.world.regions[ev.r].name)}</b> (${factionName(ev.f)}). Defend the core!`, 'bad'); break;
    case 'raidgo': ui.alert(`⚠ The raid on <b>${escapeHtml(app.world.regions[ev.r].name)}</b> has begun!`, 'raid'); break;
    case 'raidend': ui.toast(ev.retreat ? 'The raiders retreated.' : `Raid on ${escapeHtml(app.world.regions[ev.r].name)} defeated!`, 'good'); if (!ev.retreat) ui.log('Raid defeated! Bonus to the vault.', 'good'); break;
    case 'hq': sfx('alarm'); ui.alert(`${factionName(ev.f)} HQ is now open: <b>${escapeHtml(app.world.regions[ev.r].name)}</b>`, 'warn', 7000); ui.log(`You weakened ${factionName(ev.f)} enough — their HQ <b>${escapeHtml(app.world.regions[ev.r].name)}</b> can be attacked.`, 'warn'); break;
    case 'boss': sfx('boss'); ui.alert(`<b>${escapeHtml(ev.name)}</b> appears!`, 'raid', 5000); break;
    case 'bossdown': sfx('capture'); ui.alert(`The boss of ${factionName(ev.f)} has fallen! Capture the HQ!`, 'good', 6000); break;
    case 'fdown': ui.alert(`${factionName(ev.f)} is finished in this city!`, 'good', 7000); break;
    case 'win': sfx('levelup'); setTimeout(() => ui.showVictory(app.mode === 'host' ? app.game.stats : { kills: '?', captures: '?', bosses: 3, deaths: '?' }), 1500); break;
    case 'buy': sfx('buy'); ui.toast(escapeHtml(ev.text), 'gold'); break;
    case 'msg':
      if (ev.c === 'warn' && ev.to) { sfx('error'); ui.toast(escapeHtml(ev.text), 'warn'); }
      else ui.log(escapeHtml(ev.text), ev.c || '');
      break;
    case 'chat':
      app.chats.set(ev.id, { text: ev.text, t: renderer.time + 5 });
      ui.log(`<b class="chatname">${escapeHtml(ev.name)}:</b> ${escapeHtml(ev.text)}`, 'chat');
      sfx('click');
      break;
  }
}

function factionName(f) { return ['<span style="color:#c9c05a">Milícia</span>', '<span style="color:#3ad0ff">NeoBrás</span>', '<span style="color:#a66bff">Comando Cromo</span>'][f] || 'Enemies'; }
function gangColor() { return app.mode === 'host' ? app.game.gangColor : client.rg ? client.rg.gc : '#ff3f8e'; }

function entityByKey(k) {
  const id = k.slice(1);
  if (k[0] === 'p') {
    if (id === app.myId) return app.local;
    return app.mode === 'host' ? app.game.players.get(id) : client.players.get(id);
  }
  const n = Number(id);
  return app.mode === 'host' ? app.game.enemies.get(n) : client.enemies.get(n);
}

function currentMe() {
  if (app.mode === 'host') return app.game.players.get('host');
  if (app.mode === 'client') return client.me;
  return null;
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

function myProfile() {
  if (app.mode === 'host') return G.profile(app.game.players.get('host'));
  return client.prof;
}
function myPrivate() {
  if (app.mode === 'host') return G.privateState(app.game.players.get('host'));
  return client.me;
}

function useAbility(k) {
  const prof = myProfile(), me = myPrivate();
  if (!prof || !me || me.dead) return;
  const A = ABILITIES[k];
  const lvl = prof.mods[A.mod] || 0;
  if (lvl < 1) { ui.toast(`${A.name} needs the ${A.mod === 'legs' ? 'Leg Servos' : A.mod === 'nanite' ? 'Nanite Regen' : A.mod === 'optic' ? 'Optical Camo' : 'Kinetic Shield'} mod (Clínica at the QG).`, 'warn'); sfx('error'); return; }
  if ((me.cd[k] || 0) > 0.15) { sfx('error'); return; }
  if (k === 'Q') {
    const ax = input.axis();
    let dx = ax.x, dy = ax.y;
    if (!dx && !dy) { dx = Math.cos(app.local.aim); dy = Math.sin(app.local.aim); }
    const l = Math.hypot(dx, dy) || 1;
    app.local.dashT = 0.16; app.local.dashX = dx / l; app.local.dashY = dy / l;
    if (app.mode === 'client') { sfx('dash'); client.me.cd.Q = A.cd(lvl); }
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
    players: [], enemies: [], allies: [], pickups: [], projectiles: [], rs: app.world.regions.map((R) => ({ owner: R.base ? 'g' : R.faction, capture: 0 })),
    gangColor: prefs.gangColor, dayT: 0.02, raids: [],
  };
  renderer.draw(view, dt);
}

function gameFrame(dt, now) {
  const world = app.world;
  const isHost = app.mode === 'host';
  if (!isHost && !client.me) { renderer.draw({ world, me: null, players: [], enemies: [], allies: [], pickups: [], projectiles: [], rs: [], dayT: 0.3, raids: [] }, dt); return; }
  const me = myPrivate();
  const prof = myProfile();
  // ---- keys
  for (const code of input.take()) {
    if (code === 'Escape') { if (ui.isOpen()) ui.closeModal(); else ui.togglePause(); }
    else if (code === 'Tab') ui.toggleMap();
    else if (code === 'Enter' || code === 'NumpadEnter') { if (!ui.chatOpen()) ui.openChat(); }
    else if (code === 'KeyM') { app.musicOn = !app.musicOn; if (app.music) app.musicOn ? app.music.start() : app.music.stop(); ui.toast(app.musicOn ? 'Music on' : 'Music off'); }
    else if (code === 'KeyB') { if (inBaseLocal() || ui.isOpen() === 'base') ui.toggleBase(); else ui.toast('The base menu only opens at the QG (your HQ).', 'warn'); }
    else if (ui.isOpen()) continue;
    else if (code === 'KeyQ' || code === 'Space') useAbility('Q');
    else if (code === 'KeyE') useAbility('E');
    else if (code === 'KeyR') useAbility('R');
    else if (code === 'KeyF') useAbility('F');
  }
  // ---- local movement (prediction)
  const L = app.local;
  const blocked = app.menuOpen && ui.isOpen() !== 'map';
  const speed = prof ? prof.speed || 72 : 72;
  let mx = 0, my = 0;
  if (me && !me.dead && !app.typing) {
    const ax = blocked ? { x: 0, y: 0 } : input.axis();
    if (L.dashT > 0) {
      L.dashT -= dt;
      mx = L.dashX * 300 * dt; my = L.dashY * 300 * dt;
      if (Math.random() < 0.7) renderer.ghost(L.x, L.y, currentSpriteGuess());
    } else { mx = ax.x * speed * dt; my = ax.y * speed * dt; }
    const ox = L.x, oy = L.y;
    moveBox(world, L, mx, my, G.PLAYER_R);
    L.moving = Math.abs(L.x - ox) + Math.abs(L.y - oy) > 0.01;
  } else L.moving = false;
  const mw = renderer.screenToWorld(input.mouse.x, input.mouse.y);
  L.aim = Math.atan2(mw.y - (L.y - 8), mw.x - L.x);
  const fireOk = me && !me.dead && !app.menuOpen && !app.typing;
  app.fireL = !!(fireOk && input.mouse.L);
  app.fireR = !!(fireOk && input.mouse.R);
  setListener(L.x, L.y);

  // ---- simulate / sync
  if (isHost) hostTick(dt); else clientTick(dt);

  // ---- build the view
  const view = buildView();
  renderer.draw(view, dt);

  // ---- music intensity
  app.intensityT -= dt;
  if (app.intensityT <= 0 && app.music) {
    app.intensityT = 1;
    let lvl = 0;
    for (const e of view.enemies) {
      if (Math.abs(e.x - L.x) < 14 * TILE && Math.abs(e.y - L.y) < 10 * TILE) { lvl = Math.max(lvl, e.boss ? 2 : 1); }
    }
    if (view.raids.some((r) => r.state === 'active' || r.state === 1)) lvl = 2;
    app.music.setIntensity(lvl);
  }

  // ---- HUD
  const rid = regionAt(world, L.x, L.y);
  const players = view.players.map((p) => ({ x: p.x, y: p.y, name: p.name, me: p.id === app.myId }));
  const st = isHost ? app.game : null;
  ui.update({
    me, prof, myName: prefs.name || 'Mano',
    vault: isHost ? st.vault : client.rg.vault, up: isHost ? st.upgrades : client.rg.up,
    rs: view.rs, raids: view.raids.map((r) => ({ target: r.target, f: r.f, state: r.state === 'warn' ? 0 : 1, t: Math.max(0, Math.round(r.t)) })),
    gangName: isHost ? st.gangName : client.rg.gang, gangColor: view.gangColor, regionId: rid,
    inBase: rid === world.baseId, roomCode: app.roomCode, isHost, playerCount: view.players.length, players,
    defeated: isHost ? st.defeated : client.rg.def, meX: L.x, meY: L.y,
  }, now);
}

function inBaseLocal() { return regionAt(app.world, app.local.x, app.local.y) === app.world.baseId; }

let spriteGuess = null;
function currentSpriteGuess() {
  // A rough silhouette for dash after-images.
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
  let players, enemies, allies, pickups, projectiles, rs, raids, gc, dayT;
  if (isHost) {
    const g = app.game;
    players = [...g.players.values()].map((p) => ({
      id: p.id, x: p.id === 'host' ? L.x : p.x, y: p.id === 'host' ? L.y : p.y, aim: p.id === 'host' ? L.aim : p.aim,
      hp: p.hp, maxHp: p.maxHp, dead: p.dead, cloak: p.cloakT > 0, shield: p.shieldHp > 0, inv: p.invulnT > 0,
      name: p.name, look: p.look, equip: p.equip, mods: p.mods, level: p.level, chat: chatOf(p.id),
    }));
    enemies = g.enemies.values(); allies = g.allies.values(); pickups = g.pickups.values(); projectiles = g.projectiles;
    rs = g.rs; raids = g.raids; gc = g.gangColor; dayT = g.dayT;
    enemies = [...enemies]; allies = [...allies]; pickups = [...pickups];
  } else {
    players = [];
    for (const o of client.players.values()) {
      const r = client.roster.get(o.id) || {};
      const mine = o.id === app.myId;
      players.push({
        id: o.id, x: mine ? L.x : o.x, y: mine ? L.y : o.y, aim: mine ? L.aim : o.aim, hp: mine ? client.me.hp : o.hp, maxHp: mine ? client.me.maxHp : o.maxHp,
        dead: mine ? client.me.dead : o.dead, cloak: o.cloak, shield: o.shield, inv: o.inv,
        name: r.name || '?', look: r.look || {}, equip: mine && client.prof ? client.prof.equip : r.equip, mods: mine && client.prof ? client.prof.mods : r.mods, level: o.level, chat: chatOf(o.id),
      });
    }
    enemies = [...client.enemies.values()]; allies = [...client.allies.values()]; pickups = [...client.pickups.values()]; projectiles = client.projectiles;
    rs = client.rg.rs; raids = client.rg.raids; gc = client.rg.gc; dayT = client.day;
  }
  const meP = players.find((p) => p.id === app.myId);
  return { world: app.world, me: meP, meMoving: L.moving, players, enemies, allies, pickups, projectiles, rs, raids, gangColor: gc, dayT };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ------------------------------------------------------------------ go
setupTitle();
requestAnimationFrame(frame);
window.__app = app;
window.__G = G;
