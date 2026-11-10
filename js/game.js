// The game simulation. Only the HOST runs this; clients just render what the host sends.
// No DOM here. Player positions come from each player's own browser (smooth movement);
// everything else (enemies, damage, money, territory, vehicles) is decided here.
//
// Teams: bot factions are team 'e'. Player gangs are 'g0'..'g5' (index into GANG_COLORS).
// PvE has one gang. PvP has one gang per color; gangs fight each other and the bots.

import {
  TILE, WEAPONS, MODS, ABILITIES, TIERS, ATTACKS, FACTIONS, BASE_HP, BASE_SPEED, xpForLevel, MAX_LEVEL,
  RESPAWN_TIME, DEATH_CASH_LOSS, VAULT_UPGRADES, BASE_GUARDS, COMPOUND_INCOME, weaponMult, weaponUpgradePrice,
  MAX_WEAPON_LVL, WEAPON_IDS, GANG_COLORS, GANG_DEFAULT_NAMES, NAME_COLORS, FOLLOWER_MAX, VEHICLES, VEHICLE_IDS,
  BATTERY_PRICE, BATTERY_CHARGE, MAX_VEHICLES, VEHICLE_RESPAWN, TURRETS, TURRET_IDS, TURRET_MAX_MK, turretMult,
  turretUpgradePrice, TURRET_REPAIR, COMPOUND_UPS, RAID_WARN, RAID_INTERVAL, RAID_SIZE, PVP_WIN_SHARE, BREAK_INFO,
  MAP_SIZES, RECOIL, EXPLOSION_PUSH, CIV, ITEMS, STIMS, BELT_SIZE, BAD_BATCH, WANTED, POLICE_WAVES, BAR_ROOM,
} from './data.js';
import { moveBox, lineOfSight, rayCast, bfsField, fieldDir, regionAt, opaqueAt, nearestOpen, boxHits } from './world.js';

export const PLAYER_R = 5;
export const DAY_LEN = 420;               // seconds per day/night cycle
export const ATTACK_KEYS = Object.keys(ATTACKS);
export const gangId = (idx) => 'g' + idx;
export const isGang = (o) => typeof o === 'string' && o[0] === 'g';
export const gangIdx = (id) => (isGang(id) ? Number(id.slice(1)) : -1);
export const ownerCode = (o) => (isGang(o) ? 10 + gangIdx(o) : o);
export const ownerFromCode = (c) => (c >= 10 ? gangId(c - 10) : c);

const rand = Math.random;
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return Math.abs(d); };
const pick = (arr) => arr[(rand() * arr.length) | 0];
const gauss = () => (rand() + rand() + rand() - 1.5) / 0.5;
const freshUps = () => ({ level: 0, walls: 0, barracks: 0, medic: 0, pad: 0, radar: 0 });
const freshGangUps = () => { const u = {}; for (const k in VAULT_UPGRADES) u[k] = 0; return u; };

// ------------------------------------------------------------------ creation / saving
// opts: { mode: 'pve'|'pvp', gangIdx, gangName, save }
export function createGame(world, opts = {}) {
  const mode = opts.mode === 'pvp' ? 'pvp' : 'pve';
  const game = {
    world, seed: world.seed, mode, mapOpts: { type: world.type, size: world.size },
    time: 0, dayT: 0.66,
    players: new Map(), enemies: new Map(), allies: new Map(), pickups: new Map(), turrets: new Map(), vehicles: new Map(),
    projectiles: [], events: [], nextId: 1,
    rs: [], gangs: new Map(), gangsEver: 0,
    raids: [], raidT: 240, incomeT: 0, regionT: 0, radarT: 0, radar: {},
    defeated: [false, false, false], victory: null,
    stats: { kills: 0, deaths: 0, captures: 0, lost: 0, bosses: 0, raidsBeaten: 0 },
    saved: {},                  // characters of players who are not connected, by key
    pfields: new Map(), cfields: new Map(),
    maxTier: Math.max(...world.regions.map((r) => r.tier)),
    rosterVer: 1, regionVer: 1,
    brk: new Map(), brokeVer: 1, vehQueue: [],
    civs: new Map(), civT: 0, danger: [], rep: {}, repT: 0, pcars: new Map(),
  };
  for (let f = 0; f < 3; f++) if (world.hqs[f] < 0) game.defeated[f] = true;
  for (const R of world.regions) {
    let owner = R.faction;
    if (R.base) {
      // unclaimed base sites belong to the faction of a neighbor
      const nb = R.neighbors.map((n) => world.regions[n].faction).find((f) => f >= 0);
      owner = nb ?? 0;
    }
    const rs = {
      owner, garrison: 0, garrisonMax: 0, spawned: 0, idleT: 99, regenT: 0, capture: 0, capBy: null,
      guards: 0, gspawned: 0, guardT: 0, hqUnlocked: mode === 'pvp', bossDefeated: false, bossSpawned: false, hintT: 0,
      up: freshUps(), slots: [null, null, null, null],
    };
    rs.garrisonMax = Math.round(7 + R.tier * 2.5 + (R.hq ? 8 : 0));
    rs.garrison = rs.garrisonMax;
    game.rs.push(rs);
  }
  if (opts.save) loadSave(game, opts.save);
  else {
    if (mode === 'pve') makeGang(game, opts.gangIdx ?? 0, opts.gangName, world.baseId);
    spawnInitialVehicles(game);
  }
  return game;
}

function makeGang(game, idx, name, base) {
  const id = gangId(idx);
  const gang = {
    id, idx, name: String(name || GANG_DEFAULT_NAMES[idx]).slice(0, 18), color: GANG_COLORS[idx], base,
    vault: 0, upgrades: freshGangUps(), out: false,
  };
  game.gangs.set(id, gang);
  game.gangsEver++;
  if (base >= 0) {
    const rs = game.rs[base];
    rs.owner = id; rs.garrison = 0; rs.garrisonMax = 0; rs.spawned = 0; rs.capture = 0;
    for (const e of [...game.enemies.values()]) if (e.home === base && !e.raid) game.enemies.delete(e.id);
  }
  game.regionVer++;
  return gang;
}

function spawnInitialVehicles(game) {
  const n = { S: 5, M: 7, L: 9 }[game.world.size] || 7;
  for (let i = 0; i < n; i++) spawnVehicle(game, i % 3 === 2 ? 'car' : 'moto');
  for (const g of game.gangs.values()) spawnVehicleAtBase(game, g, 'moto');
}

function loadSave(game, s) {
  game.time = s.time || 0; game.dayT = s.dayT ?? 0.3;
  game.raidT = s.raidT ?? 240;
  Object.assign(game.stats, s.stats || {});
  game.saved = s.chars || {};
  game.rep = s.rep || {};
  if (s.v === 1) {
    // first version: a single gang, owner 'g'
    let idx = GANG_COLORS.indexOf(s.gangColor);
    if (idx < 0) idx = 0;
    const gang = makeGang(game, idx, s.gangName, game.world.baseId);
    gang.vault = s.vault || 0;
    Object.assign(gang.upgrades, s.upgrades || {});
    game.defeated = s.defeated || game.defeated;
    if (s.victory) game.victory = gang.id;
    (s.rs || []).forEach((r, i) => {
      const rs = game.rs[i];
      if (!rs) return;
      rs.owner = r.o === 'g' ? gang.id : r.o; rs.garrison = r.g; rs.guards = r.gu; rs.hqUnlocked = !!r.hu; rs.bossDefeated = !!r.bd;
    });
    for (const k in game.saved) { game.saved[k].gang = idx; }
    spawnInitialVehicles(game);
  } else {
    for (const g of s.gangs || []) {
      const gang = makeGang(game, g.idx, g.name, g.base);
      gang.vault = g.vault || 0; Object.assign(gang.upgrades, g.upgrades || {}); gang.out = !!g.out;
    }
    game.gangsEver = s.gangsEver || game.gangs.size;
    game.defeated = s.defeated || game.defeated;
    game.victory = s.victory || null;
    (s.rs || []).forEach((r, i) => {
      const rs = game.rs[i];
      if (!rs) return;
      rs.owner = r.o; rs.garrison = r.g; rs.guards = r.gu; rs.hqUnlocked = !!r.hu || game.mode === 'pvp'; rs.bossDefeated = !!r.bd;
      if (isGang(rs.owner)) { rs.garrisonMax = rs.garrisonMax || 0; rs.up = Object.assign(freshUps(), r.up || {}); rs.slots = (r.sl || [null, null, null, null]).map((x) => (x ? { type: x[0], mk: x[1] } : null)); }
    });
    for (const v of s.vehicles || []) {
      const o = nearestOpen(game.world, v.x, v.y, 8);           // the map may have new buildings where it was parked
      const veh = spawnVehicle(game, v.type, o.x, o.y);
      if (veh) { veh.hp = Math.min(veh.maxHp, v.hp ?? veh.maxHp); veh.charge = v.charge ?? 100; veh.team = v.team || null; }
    }
    if (!(s.vehicles || []).length) spawnInitialVehicles(game);
  }
  // safety: in a campaign the gang always owns its QG
  if (game.mode === 'pve' && game.gangs.size) { const g = [...game.gangs.values()][0]; const b = game.rs[game.world.baseId]; if (b.owner !== g.id) { b.owner = g.id; b.garrison = b.garrisonMax = 0; } g.base = game.world.baseId; }
  for (let i = 0; i < game.rs.length; i++) syncTurrets(game, i);
}

export function serialize(game) {
  const chars = { ...game.saved };
  for (const p of game.players.values()) chars[p.key] = charData(game, p);
  const main = [...game.gangs.values()][0];
  return {
    v: 2, mode: game.mode, map: game.mapOpts, seed: game.seed, time: game.time, dayT: game.dayT,
    gangs: [...game.gangs.values()].map((g) => ({ idx: g.idx, name: g.name, base: g.base, vault: Math.floor(g.vault), upgrades: g.upgrades, out: g.out })),
    gangsEver: game.gangsEver,
    defeated: game.defeated, victory: game.victory, raidT: Math.max(80, game.raidT), stats: game.stats,
    rs: game.rs.map((r) => ({
      o: r.owner, g: r.garrison, gu: r.guards, hu: r.hqUnlocked, bd: r.bossDefeated,
      up: isGang(r.owner) ? r.up : undefined, sl: isGang(r.owner) ? r.slots.map((x) => (x ? [x.type, x.mk] : null)) : undefined,
    })),
    vehicles: [...game.vehicles.values()].map((v) => ({ type: v.type, x: Math.round(v.x), y: Math.round(v.y), hp: Math.round(v.hp), charge: Math.round(v.charge), team: v.team })),
    chars, rep: game.rep, savedAt: Date.now(),
    gangName: main ? main.name : '', gangColor: main ? main.color : GANG_COLORS[0],
    owned: main ? ownedCount(game, main.id) : 0, total: game.world.regions.length,
  };
}

function charData(game, p) {
  const followers = [...game.allies.values()].filter((a) => a.follow === p.id).map((a) => ({ tier: a.tier, hpf: +(a.hp / a.maxHp).toFixed(2), civ: a.civ || 0, melee: a.melee }));
  return {
    name: p.name, look: p.look, color: p.color, gang: gangIdx(p.gang), level: p.level, xp: p.xp, cash: Math.floor(p.cash),
    armory: p.armory, equip: p.equip, mods: p.mods, kills: p.kills, deaths: p.deaths, pvpKills: p.pvpKills,
    followers, battery: p.battery, belt: p.belt,
  };
}

export function emit(game, ev) { game.events.push(ev); }

// ------------------------------------------------------------------ gangs (PvP)
export function gangChoices(game) {
  const freeSites = game.world.bases.filter((b) => ![...game.gangs.values()].some((g) => g.base === b) && !isGang(game.rs[b].owner)).length;
  return GANG_COLORS.map((color, idx) => {
    const g = game.gangs.get(gangId(idx));
    const members = [...game.players.values()].filter((p) => p.gang === gangId(idx)).map((p) => p.name);
    return { idx, color, name: g ? g.name : GANG_DEFAULT_NAMES[idx], exists: !!g, out: g ? g.out : false, members, open: g ? !g.out : freeSites > 0 };
  });
}

// Finds a saved character for a joining player: same key first, then the same name.
export function findSaved(game, key, name) {
  if (game.saved[key]) return { key, data: game.saved[key] };
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  for (const k in game.saved) if (String(game.saved[k].name || '').trim().toLowerCase() === n) return { key: k, data: game.saved[k] };
  return null;
}

// Makes sure the gang exists (PvP: claims a free base site). Returns the gang or null if impossible.
export function ensureGang(game, idx, name) {
  const id = gangId(idx);
  let g = game.gangs.get(id);
  if (g) return g.out ? null : g;
  if (game.mode === 'pve') return null;
  const taken = new Set([...game.gangs.values()].map((x) => x.base));
  const sites = game.world.bases.filter((b) => !taken.has(b) && !isGang(game.rs[b].owner));
  if (!sites.length) return null;
  // farthest free site from the existing gang bases
  const W = game.world.regions;
  let best = sites[0], bd = -1;
  for (const s of sites) {
    let m = Infinity;
    for (const og of game.gangs.values()) if (og.base >= 0) m = Math.min(m, Math.hypot(W[s].cx - W[og.base].cx, W[s].cy - W[og.base].cy));
    if (m === Infinity) m = rand() * 1000;
    if (m > bd) { bd = m; best = s; }
  }
  g = makeGang(game, idx, name, best);
  spawnVehicleAtBase(game, g, 'moto');
  syncTurrets(game, best);
  emit(game, { t: 'gangnew', g: idx, name: g.name });
  return g;
}

// ------------------------------------------------------------------ players
// o: { id, key, name, look, color, gang (index), gangName }. Returns the player or a string error.
export function addPlayer(game, o) {
  const found = findSaved(game, o.key, o.name);
  const saved = found ? found.data : null;
  let gIdx = o.gang;
  if (game.mode === 'pve') gIdx = [...game.gangs.values()][0].idx;
  else if (gIdx === undefined || gIdx === null) gIdx = saved && saved.gang >= 0 ? saved.gang : null;
  if (gIdx === null || gIdx === undefined) return 'pick-gang';
  const gang = ensureGang(game, gIdx, o.gangName);
  if (!gang) return 'gang-unavailable';
  const p = {
    id: o.id, k: 'p', key: o.key, name: String(o.name || 'Mano').slice(0, 14), look: o.look, color: NAME_COLORS.includes(o.color) ? o.color : NAME_COLORS[0],
    gang: gang.id, x: 0, y: 0, aim: 0, input: { fireL: false, fireR: false },
    level: 1, xp: 0, cash: 120, armory: { fist: 1, pistol: 1 }, equip: { L: 'fist', R: 'pistol' },
    mods: { armor: 0, legs: 0, nanite: 0, optic: 0, shield: 0 },
    hp: BASE_HP, maxHp: BASE_HP, dead: false, out: false, respawnT: 0, kills: 0, deaths: 0, pvpKills: 0,
    cd: { L: 0, R: 0, Q: 0, E: 0, R2: 0, F: 0 }, cloakT: 0, shieldHp: 0, shieldT: 0, invulnT: 0, lastHurt: -99,
    burnT: 0, burnDps: 0, burnSrc: null, dirty: true, veh: null, seat: -1, battery: false, wp: null,
    belt: [null, null, null], buffs: {}, poisonT: 0, heat: 0, copLevel: 0, escapeT: 0, inBar: -1, bx: 0, by: 0, emoteT: 0, emote: 0,
  };
  if (saved) {
    Object.assign(p, {
      look: saved.look || o.look, level: saved.level || 1, xp: saved.xp || 0, cash: saved.cash ?? 120,
      armory: saved.armory || p.armory, equip: saved.equip || p.equip, mods: { ...p.mods, ...saved.mods },
      kills: saved.kills || 0, deaths: saved.deaths || 0, pvpKills: saved.pvpKills || 0, battery: !!saved.battery,
      belt: Array.isArray(saved.belt) ? saved.belt.slice(0, BELT_SIZE).map((x) => (ITEMS[x] ? x : null)) : [null, null, null],
    });
    for (const s of ['L', 'R']) if (!WEAPONS[p.equip[s]] || !p.armory[p.equip[s]]) p.equip[s] = s === 'L' ? 'fist' : 'pistol';
    if (o.look) p.look = o.look;
    delete game.saved[found.key];
  }
  recalc(p);
  p.hp = p.maxHp;
  const sp = spawnPoint(game, p) || corePosOf(game, game.world.baseId);
  p.x = sp.x + (rand() - 0.5) * 30; p.y = sp.y + 2 * TILE;
  game.players.set(p.id, p);
  if (saved && saved.followers) for (const f of saved.followers.slice(0, FOLLOWER_MAX)) {
    const al = spawnFollower(game, p, f.tier || 1, { civ: f.civ, melee: f.melee });
    al.hp = Math.max(1, al.maxHp * (f.hpf ?? 1));
  }
  game.rosterVer++;
  emit(game, { t: 'msg', text: `${p.name} ${saved ? 'is back' : 'joined'}${game.mode === 'pvp' ? ` (${gang.name})` : ''}.`, c: 'join' });
  if (saved) emit(game, { t: 'msg', to: p.id, text: `Welcome back! Level ${p.level} restored.`, c: 'gold' });
  return p;
}

export function removePlayer(game, id) {
  const p = game.players.get(id);
  if (!p) return;
  if (p.veh) leaveVehicle(game, p, true);
  game.saved[p.key] = charData(game, p);
  for (const al of [...game.allies.values()]) if (al.follow === p.id) game.allies.delete(al.id);
  game.players.delete(id);
  game.pfields.delete(id);
  game.rosterVer++;
  emit(game, { t: 'msg', text: `${p.name} left.`, c: 'leave' });
}

export function recalc(p) {
  const a = p.mods.armor || 0, l = p.mods.legs || 0, n = p.mods.nanite || 0;
  p.maxHp = BASE_HP + (p.level - 1) * 10 + a * 20;
  p.speed = BASE_SPEED * (1 + 0.07 * l) * buff(p, 'speed', 1);
  p.regen = n * 0.8;
  p.armorRed = a * 0.06;
  p.dmgMult = 1 + 0.05 * (p.level - 1);
  p.hp = Math.min(p.hp, p.maxHp);
}

export function setInput(game, id, inp) {
  const p = game.players.get(id);
  if (!p) return;
  const ok = Number.isFinite(inp.x) && Number.isFinite(inp.y) && inp.x > 0 && inp.y > 0 && inp.x < game.world.W * TILE && inp.y < game.world.H * TILE;
  if (p.veh) {
    const v = game.vehicles.get(p.veh);
    if (v && p.seat === 0 && ok) { v.x = inp.x; v.y = inp.y; p.x = v.x; p.y = v.y; }
  } else if (p.inBar >= 0) { if (Number.isFinite(inp.bx) && Number.isFinite(inp.by)) { p.bx = inp.bx; p.by = inp.by; } }
  else if (ok && !p.dead && !(p.emoteT > 0)) { p.x = inp.x; p.y = inp.y; }
  if (Number.isFinite(inp.aim)) p.aim = inp.aim;
  p.input.fireL = !!inp.fireL;
  p.input.fireR = !!inp.fireR;
}

export function abilityCooldown(p, key) {
  const A = ABILITIES[key];
  return A.cd(p.mods[A.mod] || 0);
}

export function useAbility(game, id, key) {
  const p = game.players.get(id);
  if (!p || p.dead) return;
  const A = ABILITIES[key];
  if (!A) return;
  if ((p.veh && (key === 'Q' || key === 'R')) || p.emoteT > 0 || p.inBar >= 0) return;
  const lvl = p.mods[A.mod] || 0;
  const ck = key === 'R' ? 'R2' : key;
  if (lvl < 1 || p.cd[ck] > 0.15) return;
  p.cd[ck] = A.cd(lvl);
  if (key === 'Q' && buff(p, 'dash', 0)) p.cd.Q = 1;
  if (key === 'Q') { p.invulnT = 0.3; emit(game, { t: 'fx', k: 'dash', id: p.id, x: p.x, y: p.y }); }
  if (key === 'E') {
    const heal = p.maxHp * (0.25 + 0.05 * lvl);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    p.burnT = 0;
    emit(game, { t: 'fx', k: 'heal', id: p.id, x: p.x, y: p.y });
    emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: Math.round(heal), c: 'heal' });
  }
  if (key === 'R') {
    p.cloakT = 3 + lvl;
    for (const e of game.enemies.values()) if (e.target && e.target.id === p.id && e.target.k === 'p') e.target = null;
    emit(game, { t: 'fx', k: 'cloak', id: p.id, x: p.x, y: p.y });
  }
  if (key === 'F') { p.shieldHp = 30 + lvl * 25; p.shieldT = 5; emit(game, { t: 'fx', k: 'shield', id: p.id, x: p.x, y: p.y }); }
}

function addXp(game, p, amt) {
  if (p.level >= MAX_LEVEL) return;
  p.xp += amt;
  while (p.level < MAX_LEVEL && p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level);
    p.level++;
    recalc(p);
    p.hp = p.maxHp;
    p.dirty = true;
    game.rosterVer++;
    emit(game, { t: 'lvl', id: p.id, l: p.level, x: p.x, y: p.y });
  }
}

function addCash(game, p, amt, x, y) {
  p.cash += amt;
  emit(game, { t: 'cash', id: p.id, v: Math.round(amt), x, y });
}

// ------------------------------------------------------------------ shop / base actions
const tell = (game, id, text, c = 'warn') => emit(game, { t: 'msg', to: id, text, c });
export const priceMult = (gang) => 1 - 0.08 * ((gang && gang.upgrades.market) || 0);

export function inBase(game, p) {
  const r = regionAt(game.world, p.x, p.y);
  return r >= 0 && game.world.regions[r].base && game.rs[r].owner === p.gang;
}

// Safe zone: inside the walls of your own QG nobody fires and nobody gets hurt (unless that base is being raided).
export function inSafe(game, p) {
  if (p.veh) return false;
  const W = game.world;
  for (const g of game.gangs.values()) {
    if (g.id !== p.gang || g.base === undefined || g.base < 0) continue;
    const Rg = W.regions[g.base];
    if (!Rg || game.rs[g.base].owner !== p.gang) continue;
    const C = Rg.compound;
    const tx = p.x / TILE, ty = p.y / TILE;
    if (tx <= C.x || ty <= C.y || tx >= C.x + C.w || ty >= C.y + C.h) continue;
    if (game.raids.some((r) => r.target === g.base && r.state === 'active')) return false;
    return true;
  }
  return false;
}

export function handleAction(game, id, a) {
  const p = game.players.get(id);
  if (!p || !a) return;
  const gang = game.gangs.get(p.gang);
  if (a.t === 'veh') return toggleVehicle(game, p);
  if (a.t === 'recruit') return recruitCiv(game, p);
  if (a.t === 'barin' || a.t === 'barout' || a.t === 'buy') return barAction(game, p, a);
  if (a.t === 'use') return useItem(game, p, a.s | 0);
  if (a.t === 'emote') return startEmote(game, p);
  if (a.t === 'bribe') {
    const stars = Math.ceil(p.heat / 100);
    if (stars <= 0) return;
    if (!inBase(game, p)) return tell(game, p.id, 'Pay off the police at your base (QG).');
    const price = stars * WANTED.bribe;
    if (p.cash < price) return tell(game, p.id, `You need R$${price} to pay off the police.`);
    p.cash -= price;
    clearWanted(game, p, 'bribe');
    return;
  }
  if (a.t === 'wp') {
    p.wp = a.clear || !Number.isFinite(a.x) || !Number.isFinite(a.y) ? null : { x: Math.round(a.x), y: Math.round(a.y) };
    game.rosterVer++;
    return;
  }
  if (a.t === 'switchGang') {
    if (!p.out || game.mode !== 'pvp') return;
    const g = ensureGang(game, a.idx, a.name);
    if (!g) return tell(game, id, 'That gang is not available.');
    p.gang = g.id; p.out = false; p.dead = true; p.respawnT = 1; p.dirty = true; game.rosterVer++;
    emit(game, { t: 'msg', text: `${p.name} joined ${g.name}.`, c: 'join' });
    return;
  }
  if (!gang) return;
  if (a.t === 'cup' || a.t === 'turret' || a.t === 'tup') return compoundAction(game, p, gang, a);
  if (a.t === 'equip') {
    if (!inBase(game, p)) return tell(game, id, 'Go back to the base to swap arms.');
    if ((a.slot === 'L' || a.slot === 'R') && p.armory[a.w]) { p.equip[a.slot] = a.w; p.dirty = true; game.rosterVer++; }
    return;
  }
  if (a.t === 'donate') {
    const v = Math.min(Math.floor(p.cash), Math.max(0, a.v | 0));
    if (v <= 0) return;
    p.cash -= v; gang.vault += v; p.dirty = true;
    emit(game, { t: 'msg', text: `${p.name} put R$${v} in the gang vault.`, c: 'gold', g: gang.id });
    return;
  }
  if (a.t === 'vault') {
    const U = VAULT_UPGRADES[a.u];
    if (!U) return;
    const lvl = gang.upgrades[a.u] || 0;
    if (lvl >= U.prices.length) return;
    const price = U.prices[lvl];
    if (gang.vault < price) return tell(game, id, 'Not enough in the gang vault.');
    gang.vault -= price; gang.upgrades[a.u] = lvl + 1;
    emit(game, { t: 'msg', text: `${p.name} bought ${U.name} ${lvl + 1} for the gang!`, c: 'gold', g: gang.id });
    if (a.u === 'training') for (const al of game.allies.values()) if (al.team === gang.id) applyAllyStats(game, al);
    game.regionVer++;
    return;
  }
  if (!inBase(game, p)) return tell(game, id, 'Shops only work at your base (QG).');
  const pm = priceMult(gang);
  if (a.t === 'buyW') {
    const Wp = WEAPONS[a.w];
    if (!Wp || p.armory[a.w]) return;
    const price = Math.round(Wp.price * pm);
    if (p.level < Wp.lvl) return tell(game, id, `Needs level ${Wp.lvl}.`);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.armory[a.w] = 1; p.dirty = true;
    emit(game, { t: 'buy', id, text: `Bought ${Wp.name}!` });
  } else if (a.t === 'upW') {
    const lvl = p.armory[a.w];
    if (!lvl || lvl >= MAX_WEAPON_LVL) return;
    const price = Math.round(weaponUpgradePrice(a.w, lvl) * pm);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.armory[a.w] = lvl + 1; p.dirty = true;
    emit(game, { t: 'buy', id, text: `${WEAPONS[a.w].name} upgraded to Mk${lvl + 1}!` });
  } else if (a.t === 'buyM') {
    const M = MODS[a.m];
    if (!M) return;
    const lvl = p.mods[a.m] || 0;
    if (lvl >= M.prices.length) return;
    const price = Math.round(M.prices[lvl] * pm);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.mods[a.m] = lvl + 1; recalc(p); p.dirty = true; game.rosterVer++;
    emit(game, { t: 'buy', id, text: `${M.name} installed (Lv ${lvl + 1})!` });
  } else if (a.t === 'battery') {
    const price = Math.round(BATTERY_PRICE * pm);
    if (p.battery) return tell(game, id, 'You already carry a battery cell.');
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.battery = true; p.dirty = true;
    emit(game, { t: 'buy', id, text: 'Battery cell bought. Get in an empty vehicle to recharge it.' });
  } else if (a.t === 'buyV') {
    const V = VEHICLES[a.v];
    if (!V) return;
    if (game.vehicles.size >= MAX_VEHICLES) return tell(game, id, 'The city is full of vehicles already.');
    if (gang.vault < V.price) return tell(game, id, 'Not enough in the gang vault.');
    gang.vault -= V.price;
    spawnVehicleAtBase(game, gang, a.v, regionAt(game.world, p.x, p.y));
    emit(game, { t: 'msg', text: `${p.name} bought a ${V.name} for the gang!`, c: 'gold', g: gang.id });
  }
}

function compoundAction(game, p, gang, a) {
  const i = a.r | 0;
  const rs = game.rs[i];
  if (!rs || rs.owner !== gang.id) return tell(game, p.id, 'Your gang does not control that district.');
  const pay = (price, what) => {
    if (gang.vault < price) { tell(game, p.id, 'Not enough in the gang vault.'); return false; }
    gang.vault -= price;
    emit(game, { t: 'cup', r: i, text: `${p.name} bought ${what} at ${game.world.regions[i].name}.`, g: gang.id });
    game.regionVer++;
    return true;
  };
  if (a.t === 'cup') {
    const U = COMPOUND_UPS[a.u];
    if (!U) return;
    const lvl = rs.up[a.u] || 0;
    if (lvl >= U.prices.length) return;
    if (!pay(U.prices[lvl], `${U.name}${U.prices.length > 1 ? ' ' + (lvl + 1) : ''}`)) return;
    rs.up[a.u] = lvl + 1;
    syncTurrets(game, i);
  } else if (a.t === 'turret') {
    const s = a.s | 0, T = TURRETS[a.type];
    if (!T || s < 0 || s >= 2 + rs.up.level) return;
    if (rs.slots[s] && rs.slots[s].type === a.type) return;
    if (!pay(T.price, T.name)) return;
    rs.slots[s] = { type: a.type, mk: 1 };
    syncTurrets(game, i);
  } else if (a.t === 'tup') {
    const s = a.s | 0, sl = rs.slots[s];
    if (!sl || sl.mk >= TURRET_MAX_MK) return;
    if (!pay(turretUpgradePrice(sl.type, sl.mk), `${TURRETS[sl.type].name} Mk${sl.mk + 1}`)) return;
    sl.mk++;
    syncTurrets(game, i);
  }
}

// ------------------------------------------------------------------ helpers
export function ownedCount(game, g) { let n = 0; for (const r of game.rs) if (r.owner === g) n++; return n; }

function adjacentTo(game, i, g) {
  return game.world.regions[i].neighbors.some((n) => game.rs[n].owner === g);
}

function corePosOf(game, i) {
  const C = game.world.regions[i].compound;
  return { x: (C.coreX + 0.5) * TILE, y: (C.coreY + 0.5) * TILE };
}

// Where a player (re)spawns: the gang's main base if it still holds it, else the nearest compound it owns.
function spawnPoint(game, p) {
  const gang = game.gangs.get(p.gang);
  if (!gang) return null;
  if (gang.base >= 0 && game.rs[gang.base].owner === gang.id) return corePosOf(game, gang.base);
  let best = null, bd = Infinity;
  for (let i = 0; i < game.rs.length; i++) {
    if (game.rs[i].owner !== gang.id) continue;
    const c = corePosOf(game, i);
    const d = dist2(c.x, c.y, p.x, p.y) - (game.world.regions[i].base ? 1e7 : 0);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function coreField(game, i) {
  let f = game.cfields.get(i);
  if (!f) {
    const C = game.world.regions[i].compound;
    f = bfsField(game.world, C.coreX, C.coreY, 56);
    game.cfields.set(i, f);
  }
  return f;
}

function playerField(game, p) {
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  let pf = game.pfields.get(p.id);
  if (!pf || ((pf.f.cx !== tx || pf.f.cy !== ty) && game.time - pf.t > 0.3) || game.time - pf.t > 2) {
    pf = { f: bfsField(game.world, tx, ty, 22), t: game.time };
    game.pfields.set(p.id, pf);
  }
  return pf.f;
}

// body center (where bullets hit) and hit radius for any damageable entity
function bodyY(o) {
  if (o.k === 'e') return o.y - 6 * (o.bulk || 1);
  if (o.k === 't') return o.y - 7;
  if (o.k === 'v') return o.y - (o.flying ? 12 : 6);
  return o.y - 6;
}
function radiusOf(o) {
  if (o.k === 'e') return o.r;
  if (o.k === 'v') return VEHICLES[o.type].r;
  if (o.k === 't') return 7;
  if (o.k === 'a') return 4.5;
  return PLAYER_R;
}

// Calls fn(target) for everything hostile to `team` that can be damaged.
function forTargets(game, team, fn, civs = false) {
  if (civs) for (const c of game.civs.values()) fn(c);
  if (team !== 'e') for (const e of game.enemies.values()) fn(e);
  for (const p of game.players.values()) if (p.gang !== team && !p.dead && !p.veh && p.inBar < 0 && !p.safe) fn(p);
  for (const a of game.allies.values()) if (a.team !== team && !a.hidden) fn(a);
  for (const t of game.turrets.values()) if (t.team !== team && t.deadT <= 0) fn(t);
  for (const v of game.vehicles.values()) if (v.team && v.team !== team && v.seats.some(Boolean)) fn(v);
}

// like forTargets, but also civilians (stray bullets and blasts hurt them; nobody aims at them)
const forHits = (game, team, fn) => forTargets(game, team, fn, true);

function alive(game, o) {
  if (!o) return false;
  if (o.k === 'e') return game.enemies.has(o.id);
  if (o.k === 'p') return !o.dead && !o.veh && game.players.has(o.id);
  if (o.k === 'a') return game.allies.has(o.id) && !o.hidden;
  if (o.k === 't') return o.deadT <= 0 && game.turrets.has(o.id);
  if (o.k === 'v') return game.vehicles.has(o.id) && o.seats.some(Boolean);
  return false;
}

function damage(game, o, dmg, src, kx = 0, ky = 0) {
  if (o.k === 'e') damageEnemy(game, o, dmg, src, kx, ky);
  else if (o.k === 'p') hurtPlayer(game, o, dmg, src, kx, ky);
  else if (o.k === 'a') hurtAlly(game, o, dmg, src, kx, ky);
  else if (o.k === 't') hurtTurret(game, o, dmg, src);
  else if (o.k === 'v') hurtVehicle(game, o, dmg, src);
  else if (o.k === 'c') hurtCiv(game, o, dmg, src, kx, ky);
}

function rollTier(game, R, bonus = 0) {
  const d = R.tier / Math.max(1, game.maxTier);
  let heat = 0;
  for (const g of game.gangs.values()) heat = Math.max(heat, ownedCount(game, g.id) / game.world.regions.length);
  const avg = 1 + d * 3.3 + heat * 0.6 + bonus;
  return Math.max(1, Math.min(5, Math.round(avg + gauss() * 0.6)));
}

export function enemyName(e) {
  if (e.boss) return FACTIONS[e.faction].boss;
  return FACTIONS[e.faction].tiers[e.tier - 1];
}

function srcName(game, src) {
  if (!src) return 'the streets';
  if (src.k === 'e') { const e = game.enemies.get(src.id); return e ? enemyName(e) : 'a thug'; }
  if (src.k === 'p') { const p = game.players.get(src.id); return p ? p.name : 'a rival'; }
  if (src.k === 't') return 'a turret';
  if (src.k === 'a') return 'a rival soldier';
  if (src.k === 'x') return 'an explosion';
  return 'the streets';
}

// ------------------------------------------------------------------ spawning
function spawnEnemy(game, f, tier, x, y, home, opts = {}) {
  const T = TIERS[tier];
  const R = home >= 0 ? game.world.regions[home] : null;
  const rt = R ? R.tier : 1;
  const hpMul = (1 + 0.1 * rt) * (opts.boss ? 1 + 0.25 * game.players.size : 1);
  const e = {
    id: game.nextId++, k: 'e', faction: f, tier, x, y,
    hp: 0, maxHp: 0, dmg: T.dmg * (1 + 0.06 * rt) * (opts.raid ? 1.15 : 1), speed: T.speed * (0.9 + rand() * 0.2), bulk: T.bulk,
    r: Math.min(7, 4.2 * T.bulk), home, hx: x, hy: y, state: opts.raid ? 'raid' : 'idle', target: null,
    atk: pick(T.attacks), atkCd: 1 + rand(), windup: 0, windAng: 0, thinkT: rand() * 0.2, mvx: 0, mvy: 0, kx: 0, ky: 0,
    stars: 0, boss: tier === 6, flash: 0, aim: rand() * 6.28, raid: opts.raid || null, wanderT: rand() * 3,
    burst: 0, burstT: 0, phase: 0, garrison: !!opts.garrison, moving: false, burnT: 0, burnDps: 0, burnSrc: null, burnTick: 0,
  };
  e.maxHp = e.hp = Math.round(T.hp * hpMul);
  if (f === 1 && tier === 1) { e.atk = 'gun'; e.speed = 62; }
  if (f === 2 && tier === 4) { e.atk = 'melee'; e.speed = 88; e.dmg *= 1.2; }
  if (e.boss) { e.r = 7; e.atk = 'boss'; }
  game.enemies.set(e.id, e);
  return e;
}

function promoteEnemy(game, e, victimName) {
  if (!e || !game.enemies.has(e.id)) return;
  e.stars++;
  if (!e.boss && e.tier < 5) {
    const old = e.tier;
    e.tier++;
    const T = TIERS[e.tier];
    e.maxHp = Math.round(e.maxHp * (T.hp / TIERS[old].hp));
    e.hp = e.maxHp;
    e.dmg *= T.dmg / TIERS[old].dmg;
    e.bulk = T.bulk;
    e.r = Math.min(7, 4.2 * T.bulk);
    e.speed = T.speed;
    e.atk = pick(T.attacks);
    if (e.faction === 2 && e.tier === 4) { e.atk = 'melee'; e.speed = 88; }
  } else {
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.3);
    e.dmg *= 1.1;
  }
  emit(game, { t: 'eup', x: e.x, y: e.y, name: enemyName(e), victim: victimName, f: e.faction });
}

function pickSpawnTile(game, region, nearCore) {
  const list = game.world.spawnTiles[region];
  if (!list.length) return null;
  const W = game.world.W;
  const core = corePosOf(game, region);
  let best = null, bestScore = -Infinity;
  for (let a = 0; a < 14; a++) {
    const i = list[(rand() * list.length) | 0];
    const x = (i % W + 0.5) * TILE, y = ((i / W | 0) + 0.5) * TILE;
    let minP = Infinity;
    for (const p of game.players.values()) minP = Math.min(minP, Math.sqrt(dist2(x, y, p.x, p.y)));
    let score = Math.min(minP, 300);
    if (minP < 230) score -= 1000;
    if (nearCore) score -= Math.sqrt(dist2(x, y, core.x, core.y)) * 0.5;
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return best;
}

function applyAllyStats(game, al) {
  const gang = game.gangs.get(al.team);
  const L = gang ? gang.upgrades.training || 0 : 0;
  const frac = al.maxHp ? al.hp / al.maxHp : 1;
  if (al.civ) { al.maxHp = 140 + 35 * L; al.dmg = (al.melee ? 17 : 9) + 4 * L; }
  else if (al.follow) { al.maxHp = 90 + 25 * al.tier + 30 * L; al.dmg = 7 + 2.5 * al.tier + 4 * L; }
  else { al.maxHp = 80 + 55 * L; al.dmg = 7 + 5 * L; }
  al.hp = al.maxHp * frac;
}

function spawnAlly(game, region) {
  const C = game.world.regions[region].compound;
  let x = 0, y = 0;
  for (let a = 0; a < 20; a++) {
    x = (C.x + 2 + rand() * (C.w - 4)) * TILE; y = (C.y + 2 + rand() * (C.h - 4)) * TILE;
    if (!opaqueAt(game.world, x, y)) break;
  }
  const al = {
    id: game.nextId++, k: 'a', region, team: game.rs[region].owner, x, y, px: x, py: y, hp: 1, maxHp: 1, dmg: 7, speed: 62, r: 4.5,
    target: null, atkCd: rand(), thinkT: rand() * 0.3, aim: rand() * 6.28, flash: 0, mvx: 0, mvy: 0, moving: false, follow: null, tier: 1, kx: 0, ky: 0, svx: 0, svy: 0,
  };
  applyAllyStats(game, al);
  al.hp = al.maxHp;
  game.allies.set(al.id, al);
  return al;
}

function spawnFollower(game, p, tier, extra = {}) {
  const al = {
    id: game.nextId++, k: 'a', region: -1, team: p.gang, x: p.x + (rand() - 0.5) * 16, y: p.y + (rand() - 0.5) * 16, px: p.x, py: p.y,
    hp: 1, maxHp: 1, dmg: 7, speed: 70, r: 4.5, target: null, atkCd: rand(), thinkT: rand() * 0.3, aim: rand() * 6.28, flash: 0,
    mvx: 0, mvy: 0, moving: false, follow: p.id, tier: Math.max(1, Math.min(6, tier)), hidden: !!p.veh, kx: 0, ky: 0, svx: 0, svy: 0,
    civ: extra.civ || 0, melee: !!extra.melee,
  };
  if (extra.x !== undefined) { al.x = extra.x; al.y = extra.y; }
  const o = nearestOpen(game.world, al.x, al.y, 4); al.x = o.x; al.y = o.y;
  applyAllyStats(game, al);
  al.hp = al.maxHp;
  game.allies.set(al.id, al);
  return al;
}
export const followerCount = (game, pid) => { let n = 0; for (const a of game.allies.values()) if (a.follow === pid) n++; return n; };

// ------------------------------------------------------------------ vehicles
function spawnVehicle(game, type, x, y) {
  const V = VEHICLES[type];
  if (!V) return null;
  if (x === undefined) {
    const list = game.world.roadTiles;
    if (!list.length) return null;
    let best = null, bd = -1;
    for (let a = 0; a < 12; a++) {
      const i = list[(rand() * list.length) | 0];
      const px = (i % game.world.W + 0.5) * TILE, py = ((i / game.world.W | 0) + 0.5) * TILE;
      let m = Infinity;
      for (const v of game.vehicles.values()) m = Math.min(m, dist2(px, py, v.x, v.y));
      for (const p of game.players.values()) if (dist2(px, py, p.x, p.y) < (12 * TILE) ** 2) m = 0;
      if (m > bd) { bd = m; best = { x: px, y: py }; }
    }
    x = best.x; y = best.y;
  }
  const v = {
    id: game.nextId++, k: 'v', type, x, y, px: x, py: y, hp: V.hp, maxHp: V.hp, charge: V.charge, flying: true,
    seats: new Array(V.seats).fill(null), dir: (rand() * 4) | 0, team: null, flash: 0, lastMove: -99,
  };
  game.vehicles.set(v.id, v);
  return v;
}

function spawnVehicleAtBase(game, gang, type, region) {
  const r = region >= 0 && game.world.regions[region] && game.world.regions[region].base ? region : gang.base;
  if (r < 0) return null;
  const C = game.world.regions[r].compound;
  const gx = C.garage ? C.garage.x : (C.coreX + 0.5) * TILE, gy = C.garage ? C.garage.y : (C.coreY + 2.5) * TILE;
  let x = gx, y = gy;
  for (let a = 0; a < 8; a++) {
    const tx = gx + (a % 3) * 22, ty = gy + (Math.floor(a / 3) - 1) * 18;
    if ([...game.vehicles.values()].every((v) => dist2(v.x, v.y, tx, ty) > 18 * 18)) { x = tx; y = ty; break; }
  }
  const v = spawnVehicle(game, type, x, y);
  if (v) v.team = gang.id;
  return v;
}

function toggleVehicle(game, p) {
  if (p.dead) return;
  if (p.veh) return leaveVehicle(game, p);
  let best = null, bd = 26 * 26;
  for (const v of game.vehicles.values()) {
    const d = dist2(v.x, v.y, p.x, p.y);
    if (d < bd && v.seats.some((s) => s === null)) {
      if (v.seats.some((s) => s && game.players.get(s) && game.players.get(s).gang !== p.gang)) continue;
      bd = d; best = v;
    }
  }
  if (!best) return tell(game, p.id, 'No free vehicle close enough.');
  const seat = best.seats.indexOf(null);
  best.seats[seat] = p.id;
  best.team = p.gang;
  p.veh = best.id; p.seat = seat; p.cloakT = 0;
  p.x = best.x; p.y = best.y;
  const V = VEHICLES[best.type];
  if (p.battery && best.charge < V.charge * 0.6) {
    best.charge = Math.min(V.charge, best.charge + BATTERY_CHARGE);
    p.battery = false;
    emit(game, { t: 'msg', to: p.id, text: 'Battery cell installed: +60% charge.', c: 'good' });
  }
  for (const al of game.allies.values()) if (al.follow === p.id) al.hidden = true;
  p.dirty = true;
  game.rosterVer++;
  emit(game, { t: 'venter', id: p.id, v: best.id, seat, x: best.x, y: best.y });
}

function leaveVehicle(game, p, silent = false) {
  const v = game.vehicles.get(p.veh);
  if (v) {
    const i = v.seats.indexOf(p.id);
    if (i >= 0) v.seats[i] = null;
    const o = nearestOpen(game.world, v.x + (p.seat % 2 ? 10 : -10), v.y + 6, PLAYER_R);
    p.x = o.x; p.y = o.y;
  }
  p.veh = null; p.seat = -1; p.invulnT = Math.max(p.invulnT, 0.6);
  for (const al of game.allies.values()) if (al.follow === p.id && al.hidden) { al.hidden = false; const o = nearestOpen(game.world, p.x + (rand() - 0.5) * 20, p.y + (rand() - 0.5) * 20, 4); al.x = o.x; al.y = o.y; }
  p.dirty = true;
  game.rosterVer++;
  if (!silent) emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y, quiet: true });
  emit(game, { t: 'vexit', id: p.id, x: p.x, y: p.y });
}

function hurtVehicle(game, v, dmg, src) {
  v.hp -= dmg;
  v.flash = 0.1;
  emit(game, { t: 'dmg', x: v.x, y: v.y - 26, v: Math.round(dmg), c: 'veh' });
  if (v.hp <= 0) wreckVehicle(game, v, src);
}

function wreckVehicle(game, v) {
  game.vehicles.delete(v.id);
  emit(game, { t: 'vboom', x: v.x, y: v.y, type: v.type });
  const team = v.team;
  for (const pid of v.seats) {
    const p = pid && game.players.get(pid);
    if (!p) continue;
    p.veh = null; p.seat = -1; p.invulnT = 1.5;
    const o = nearestOpen(game.world, v.x + (rand() - 0.5) * 24, v.y + (rand() - 0.5) * 24, PLAYER_R);
    p.x = o.x; p.y = o.y; p.dirty = true;
    emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y, quiet: true });
    for (const al of game.allies.values()) if (al.follow === p.id) { al.hidden = false; al.x = p.x; al.y = p.y; }
  }
  game.rosterVer++;
  // the blast hurts nearby hostiles, never the riders
  forHits(game, team, (o) => { const d = Math.sqrt(dist2(v.x, v.y, o.x, bodyY(o))); if (d < 46 + radiusOf(o)) damage(game, o, 40, { k: 'x', team }); });
  game.vehQueue.push({ t: VEHICLE_RESPAWN, type: v.type });
}

function updateVehicle(game, v, dt) {
  const V = VEHICLES[v.type];
  if (v.flash > 0) v.flash -= dt;
  const moved = Math.hypot(v.x - v.px, v.y - v.py);
  if (moved > 0.02) {
    const dx = v.x - v.px, dy = v.y - v.py;
    v.dir = Math.abs(dx) > Math.abs(dy) * 0.9 ? (dx > 0 ? 2 : 1) : (dy > 0 ? 0 : 3);
    v.lastMove = game.time;
    if (v.flying) v.charge = Math.max(0, v.charge - (Math.min(moved, V.speed * dt * 1.5) / V.speed) * V.drain);
  }
  if (v.flying && v.charge <= 0) {
    v.flying = false;
    if (boxHits(game.world, v.x, v.y, 6)) {
      const o = nearestOpen(game.world, v.x, v.y, 7);
      v.x = o.x; v.y = o.y;
      for (const pid of v.seats) if (pid) emit(game, { t: 'tp', id: pid, x: v.x, y: v.y, quiet: true });
    }
    emit(game, { t: 'vland', id: v.id, x: v.x, y: v.y });
    for (const pid of v.seats) if (pid) tell(game, pid, 'Out of charge! Crawl back to the QG, find a Charge Pad, or bring a battery cell.');
  } else if (!v.flying && v.charge > 1) v.flying = true;
  // recharge + repair: parked at your gang's base or at a compound with a charge pad
  if (game.time - v.lastMove > 0.6 && v.team) {
    const r = regionAt(game.world, v.x, v.y);
    if (r >= 0 && game.rs[r].owner === v.team && (game.world.regions[r].base || game.rs[r].up.pad)) {
      if (v.charge < V.charge || v.hp < v.maxHp) {
        v.charge = Math.min(V.charge, v.charge + 9 * dt);
        v.hp = Math.min(v.maxHp, v.hp + 22 * dt);
        v.charging = true;
      } else v.charging = false;
    } else v.charging = false;
  } else v.charging = false;
  for (let s = 0; s < v.seats.length; s++) {
    const pid = v.seats[s];
    if (!pid) continue;
    const p = game.players.get(pid);
    if (!p || p.veh !== v.id) { v.seats[s] = null; continue; }
    p.x = v.x; p.y = v.y;
  }
  v.px = v.x; v.py = v.y;
}

// ------------------------------------------------------------------ turrets
function syncTurrets(game, i) {
  for (const t of [...game.turrets.values()]) if (t.region === i) game.turrets.delete(t.id);
  const rs = game.rs[i];
  if (!isGang(rs.owner)) return;
  const C = game.world.regions[i].compound;
  const gang = game.gangs.get(rs.owner);
  const L = gang ? gang.upgrades.training || 0 : 0;
  for (let s = 0; s < 2 + rs.up.level && s < 4; s++) {
    const sl = rs.slots[s];
    if (!sl || !TURRETS[sl.type]) continue;
    const T = TURRETS[sl.type];
    const id = 100000 + i * 4 + s;
    const hp = Math.round(T.hp * turretMult(sl.mk) * (1 + 0.15 * L));
    game.turrets.set(id, {
      id, k: 't', region: i, slot: s, type: sl.type, mk: sl.mk, team: rs.owner, x: C.slots[s].x, y: C.slots[s].y + 4,
      hp, maxHp: hp, aim: -Math.PI / 2, cd: rand(), thinkT: rand() * 0.3, target: null, deadT: 0, flash: 0,
      mult: turretMult(sl.mk) * (1 + 0.15 * L),
    });
  }
}

function hurtTurret(game, t, dmg, src) {
  const walls = game.rs[t.region].up.walls || 0;
  dmg *= 1 - 0.12 * walls;
  t.hp -= dmg;
  t.flash = 0.1;
  emit(game, { t: 'dmg', x: t.x, y: t.y - 20, v: Math.round(dmg), c: 'ally' });
  if (t.hp <= 0) {
    t.hp = 0; t.deadT = TURRET_REPAIR; t.target = null;
    emit(game, { t: 'boom', x: t.x, y: t.y - 6, r: 22 });
    emit(game, { t: 'msg', text: `A turret went down at ${game.world.regions[t.region].name}!`, c: 'bad', g: t.team });
    if (src && src.k === 'e') promoteEnemy(game, game.enemies.get(src.id), 'a turret');
  }
}

function updateTurret(game, t, dt) {
  if (t.flash > 0) t.flash -= dt;
  if (t.deadT > 0) { t.deadT -= dt; if (t.deadT <= 0) { t.hp = t.maxHp; emit(game, { t: 'msg', text: `Turret back online at ${game.world.regions[t.region].name}.`, c: 'good', g: t.team }); } return; }
  const T = TURRETS[t.type];
  t.cd -= dt;
  t.thinkT -= dt;
  if (t.thinkT <= 0) {
    t.thinkT = 0.25;
    let best = null, bd = T.range * T.range;
    forTargets(game, t.team, (o) => {
      const d = dist2(t.x, t.y - 8, o.x, bodyY(o));
      if (d < bd && lineOfSight(game.world, t.x, t.y - 10, o.x, bodyY(o))) { bd = d; best = o; }
    });
    t.target = best;
  }
  const o = t.target;
  if (!alive(game, o)) { t.target = null; return; }
  const want = Math.atan2(bodyY(o) - (t.y - 8), o.x - t.x);
  let d = want - t.aim; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
  t.aim += Math.max(-dt * 6, Math.min(dt * 6, d));
  if (t.cd > 0 || Math.abs(d) > 0.35) return;
  t.cd = T.cd;
  const src = { k: 't', id: t.id, team: t.team };
  const dmg = T.dmg * t.mult;
  const ox = t.x + Math.cos(t.aim) * 10, oy = t.y - 8 + Math.sin(t.aim) * 10;
  if (t.type === 'mg') spawnProj(game, { x: ox, y: oy, a: t.aim + (rand() - 0.5) * 0.08, speed: 320, life: T.range / 320, dmg, team: t.team, kind: 'tbullet', src, owner: 't' + t.id });
  else if (t.type === 'rocket') spawnProj(game, { x: ox, y: oy, a: t.aim, speed: 170, life: T.range / 170 + 0.2, dmg, team: t.team, kind: 'rocket', src, aoe: T.aoe, r: 4 });
  else if (t.type === 'tesla') {
    let from = { x: t.x, y: t.y - 12 }, hit = new Set(), cur = o;
    for (let n = 0; n < T.chain && cur; n++) {
      hit.add(cur);
      emit(game, { t: 'zap', x: Math.round(from.x), y: Math.round(from.y), x2: Math.round(cur.x), y2: Math.round(bodyY(cur)) });
      damage(game, cur, dmg, src);
      from = { x: cur.x, y: bodyY(cur) };
      let nb = null, nd = 60 * 60;
      forTargets(game, t.team, (q) => { if (hit.has(q)) return; const dd = dist2(from.x, from.y, q.x, bodyY(q)); if (dd < nd) { nd = dd; nb = q; } });
      cur = nb;
    }
  } else if (t.type === 'flamer') {
    emit(game, { t: 'flame', o: 't' + t.id, x: Math.round(ox), y: Math.round(oy), a: +t.aim.toFixed(2), r: T.range });
    forHits(game, t.team, (q) => {
      const dd = Math.sqrt(dist2(ox, oy, q.x, bodyY(q)));
      if (dd > T.range + radiusOf(q) || angDiff(Math.atan2(bodyY(q) - oy, q.x - ox), t.aim) > 0.45) return;
      damage(game, q, dmg, src);
      ignite(q, 5 * t.mult, 2, src);
    });
  } else {
    const len = rayCast(game.world, ox, oy, t.aim, T.range);
    const x2 = ox + Math.cos(t.aim) * len, y2 = oy + Math.sin(t.aim) * len;
    emit(game, { t: 'beam', o: 't' + t.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), c: '#22e5ff' });
    forHits(game, t.team, (q) => { if (segDist2(q.x, bodyY(q), ox, oy, x2, y2) < (radiusOf(q) + 4) ** 2) damage(game, q, dmg, src); });
  }
}

// ------------------------------------------------------------------ combat
function spawnProj(game, o) {
  const p = {
    id: game.nextId++, x: o.x, y: o.y, vx: Math.cos(o.a) * o.speed, vy: Math.sin(o.a) * o.speed, life: o.life,
    dmg: o.dmg, team: o.team, owner: o.owner ?? null, src: o.src || null, kind: o.kind, r: o.r || 3, aoe: o.aoe || 0,
    homing: o.homing || 0, knock: o.knock || 0, crit: !!o.crit,
  };
  game.projectiles.push(p);
  markDanger(game, o.x, o.y);
  emit(game, { t: 'shot', i: p.id, x: Math.round(p.x), y: Math.round(p.y), a: +o.a.toFixed(3), s: o.speed, l: o.life, k: o.kind, tm: o.team, o: p.owner });
  return p;
}

function ignite(o, dps, t, src) {
  if (o.k !== 'e' && o.k !== 'p') return;
  o.burnT = Math.max(o.burnT || 0, t);
  o.burnDps = Math.max(o.burnDps || 0, dps);
  o.burnSrc = src;
}

function damageEnemy(game, e, dmg, src, kx = 0, ky = 0, quiet = false) {
  if (!game.enemies.has(e.id)) return;
  let crit = false;
  if (src && src.k === 'p' && !quiet && rand() < 0.1 + (game.players.get(src.id) ? buff(game.players.get(src.id), 'crit', 0) : 0)) { dmg *= 1.6; crit = true; }
  if (src && src.k === 'p' && e.police) crime(game, game.players.get(src.id), WANTED.hitCop * (e.hitT > game.time ? 0 : 1), e.x, e.y, true, 'cop'), (e.hitT = game.time + 1);
  e.hp -= dmg;
  e.flash = 0.12;
  if (src && src.k === 'p') { const pl = game.players.get(src.id); if (pl && buff(pl, 'knock', 0)) { kx *= 2.2; ky *= 2.2; } }
  if (kx || ky) { const m = e.boss ? 0.15 : 1 / e.bulk; e.kx += kx * m; e.ky += ky * m; }
  if (!quiet) emit(game, { t: 'dmg', x: e.x, y: e.y - 14 * e.bulk - 6, v: Math.round(dmg), c: crit ? 'crit' : 'hit' });
  if (src && (src.k === 'p' || src.k === 'a' || src.k === 't') && (!e.target || e.state === 'idle') && e.state !== 'return') {
    e.target = { k: src.k, id: src.id };
    if (e.state === 'idle') e.state = 'chase';
  }
  if (e.hp <= 0) killEnemy(game, e, src);
}

function killEnemy(game, e, src) {
  if (e.police) crimeBy(game, src, WANTED.killCop, e.x, e.y, true, 'cop');
  game.enemies.delete(e.id);
  game.stats.kills++;
  emit(game, { t: 'die', x: e.x, y: e.y, tr: e.tier, f: e.faction, b: e.bulk, boss: e.boss });
  const T = TIERS[e.tier];
  let cash = T.cash * (1 + e.stars * 0.5) * (0.85 + rand() * 0.3);
  const xp = T.xp * (1 + e.stars * 0.5);
  const gang = src && src.team ? game.gangs.get(src.team) : null;
  if (gang) cash *= 1 + 0.15 * (gang.upgrades.bounty || 0);
  let killer = src && src.k === 'p' ? game.players.get(src.id) : null;
  if (!killer && src && src.k === 'a') { const al = game.allies.get(src.id); if (al && al.follow) killer = game.players.get(al.follow); if (killer) { addCash(game, killer, cash * 0.5, e.x, e.y - 10); addXp(game, killer, xp * 0.5); killer = null; } else if (gang) gang.vault += cash * 0.5; }
  else if (!killer && gang) gang.vault += cash * 0.5;
  if (killer) {
    killer.kills++;
    addCash(game, killer, cash, e.x, e.y - 10);
    addXp(game, killer, xp);
    for (const o of game.players.values()) {
      if (o === killer || o.dead || o.gang !== killer.gang || dist2(o.x, o.y, e.x, e.y) > (14 * TILE) ** 2) continue;
      addCash(game, o, cash * 0.4, o.x, o.y - 26);
      addXp(game, o, xp * 0.6);
    }
  }
  if (e.raid) {
    const raid = game.raids.find((r) => r.id === e.raid);
    if (raid) raid.alive--;
  } else if (e.garrison && e.home >= 0) {
    const rs = game.rs[e.home];
    rs.garrison = Math.max(0, rs.garrison - 1);
    rs.spawned = Math.max(0, rs.spawned - 1);
    game.regionVer++;
    if (rs.garrison === 0 && !isGang(rs.owner)) emit(game, { t: 'cleared', r: e.home });
  }
  if (e.boss) {
    const rs = game.rs[e.home];
    rs.bossDefeated = true; rs.bossSpawned = false;
    game.stats.bosses++;
    game.regionVer++;
    emit(game, { t: 'bossdown', f: e.faction, r: e.home, x: e.x, y: e.y });
    for (const p of game.players.values()) {
      if (gang && p.gang !== gang.id && game.mode === 'pvp') continue;
      addCash(game, p, 1500, p.x, p.y - 26); addXp(game, p, 800);
    }
  }
  if (rand() < 0.07 || (e.tier >= 4 && rand() < 0.4)) spawnPickup(game, 'heal', e.x, e.y, 25);
}

function spawnPickup(game, type, x, y, amount) {
  const k = { id: game.nextId++, type, x, y, amount, life: type === 'cash' ? 120 : 40 };
  game.pickups.set(k.id, k);
}

function hurtPlayer(game, p, dmg, src, kx = 0, ky = 0) {
  if (p.veh) { const v = game.vehicles.get(p.veh); if (v) hurtVehicle(game, v, dmg, src); return; }
  if (p.dead) return;
  if ((kx || ky) && Math.hypot(kx, ky) > 50) emit(game, { t: 'knock', id: p.id, x: kx * 0.6, y: ky * 0.6, to: p.id });
  if (p.invulnT > 0) return;
  dmg *= (1 - p.armorRed) * buff(p, 'armor', 1);
  if (p.shieldHp > 0) {
    const a = Math.min(p.shieldHp, dmg);
    p.shieldHp -= a; dmg -= a;
    if (p.shieldHp <= 0) emit(game, { t: 'fx', k: 'shieldbreak', id: p.id, x: p.x, y: p.y });
  }
  if (dmg <= 0) return;
  p.hp -= dmg;
  p.lastHurt = game.time;
  emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: Math.round(dmg), c: 'player' });
  emit(game, { t: 'hurt', id: p.id });
  if (p.hp <= 0 && buff(p, 'cheat', 0)) {
    for (const id in p.buffs) if (p.buffs[id].eff.cheat) delete p.buffs[id];
    p.hp = p.maxHp * 0.5; p.invulnT = 1.5; p.dirty = true;
    emit(game, { t: 'fx', k: 'cheat', id: p.id, x: p.x, y: p.y });
    return;
  }
  if (p.hp <= 0) killPlayer(game, p, src);
}

function killPlayer(game, p, src) {
  const gang = game.gangs.get(p.gang);
  p.hp = 0; p.dead = true; p.respawnT = Math.max(1.5, RESPAWN_TIME - 1.5 * ((gang && gang.upgrades.rescue) || 0)); p.deaths++;
  p.cloakT = 0; p.shieldHp = 0; p.burnT = 0; p.poisonT = 0; p.emoteT = 0;
  if (p.heat > 0 || p.copLevel > 0) clearWanted(game, p, null);
  game.stats.deaths++;
  const loss = Math.floor(p.cash * DEATH_CASH_LOSS);
  if (loss > 0) { p.cash -= loss; spawnPickup(game, 'cash', p.x, p.y, loss); }
  emit(game, { t: 'pdie', id: p.id, name: p.name, by: srcName(game, src), loss, x: p.x, y: p.y });
  if (src && src.k === 'e') promoteEnemy(game, game.enemies.get(src.id), p.name);
  if (src && src.k === 'p') {
    const k = game.players.get(src.id);
    if (k && k.gang !== p.gang) {
      k.pvpKills++;
      addCash(game, k, 40 + 12 * p.level, k.x, k.y - 26);
      addXp(game, k, 25 * p.level);
      emit(game, { t: 'pkill', k: k.name, v: p.name });
    }
  }
  for (const e of game.enemies.values()) if (e.target && e.target.k === 'p' && e.target.id === p.id) e.target = null;
  p.dirty = true;
}

function hurtAlly(game, al, dmg, src, kx = 0, ky = 0) {
  if (kx || ky) { al.kx = (al.kx || 0) + kx * 0.7; al.ky = (al.ky || 0) + ky * 0.7; }
  if (al.region >= 0 && game.rs[al.region]) dmg *= 1 - 0.12 * (game.rs[al.region].up.walls || 0);
  al.hp -= dmg;
  al.flash = 0.12;
  emit(game, { t: 'dmg', x: al.x, y: al.y - 20, v: Math.round(dmg), c: 'ally' });
  if (al.hp <= 0) {
    game.allies.delete(al.id);
    if (al.follow) {
      const owner = game.players.get(al.follow);
      emit(game, { t: 'fdie', id: al.follow, x: al.x, y: al.y });
      if (owner) owner.dirty = true;
    } else if (al.region >= 0) {
      const rs = game.rs[al.region];
      rs.guards = Math.max(0, rs.guards - 1);
      rs.gspawned = Math.max(0, rs.gspawned - 1);
    }
    emit(game, { t: 'die', x: al.x, y: al.y, tr: 1, f: -1, b: 1 });
    for (const e of game.enemies.values()) if (e.target && e.target.k === 'a' && e.target.id === al.id) e.target = null;
    if (src && src.k === 'e') promoteEnemy(game, game.enemies.get(src.id), al.follow ? 'a crew member' : 'a guard');
  }
}

// x, y, radius, damage. Hurts everything hostile to `team` (and breakables).
function explode(game, x, y, r, dmg, team, src) {
  emit(game, { t: 'boom', x, y, r });
  markDanger(game, x, y, 2);
  if (src && (src.k === 'p' || src.k === 'a')) crimeBy(game, src, WANTED.boomSeen, x, y);
  forHits(game, team, (o) => {
    const d = Math.sqrt(dist2(x, y, o.x, bodyY(o)));
    if (d < r + radiusOf(o)) {
      const f = 1 - 0.5 * Math.min(1, d / r);
      const a = Math.atan2(bodyY(o) - y, o.x - x);
      damage(game, o, dmg * f, src, Math.cos(a) * EXPLOSION_PUSH * f, Math.sin(a) * EXPLOSION_PUSH * f);
    }
  });
  // the blast also shoves friendly players and crew around (no damage)
  for (const p of game.players.values()) {
    if (p.dead || p.veh || p.gang !== team) continue;
    const d = Math.sqrt(dist2(x, y, p.x, p.y - 6));
    if (d < r * 1.3) { const a = Math.atan2(p.y - 6 - y, p.x - x); const f = 0.55 * (1 - d / (r * 1.3)); emit(game, { t: 'knock', id: p.id, x: Math.cos(a) * EXPLOSION_PUSH * f, y: Math.sin(a) * EXPLOSION_PUSH * f, to: p.id }); }
  }
  for (const al of game.allies.values()) {
    if (al.team !== team || al.hidden) continue;
    const d = Math.sqrt(dist2(x, y, al.x, al.y - 6));
    if (d < r * 1.3) { const a = Math.atan2(al.y - 6 - y, al.x - x); const f = 0.5 * (1 - d / (r * 1.3)); al.kx += Math.cos(a) * EXPLOSION_PUSH * f; al.ky += Math.sin(a) * EXPLOSION_PUSH * f; }
  }
  hitBreakables(game, x, y, r, dmg, src);
}

function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l));
  return dist2(px, py, x1 + dx * t, y1 + dy * t);
}

// ------------------------------------------------------------------ breakables (barrels, gas tanks, cars...)
function breakablesNear(game, x, y, r, fn) {
  const w = game.world;
  const cs = 16 * TILE;
  const gx0 = Math.max(0, Math.floor((x - r) / cs)), gx1 = Math.min(w.gridW - 1, Math.floor((x + r) / cs));
  const gy0 = Math.max(0, Math.floor((y - r) / cs)), gy1 = Math.min(w.gridH - 1, Math.floor((y + r) / cs));
  for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const b of w.breakGrid[gy * w.gridW + gx]) {
    const st = game.brk.get(b.id);
    if (st && st.deadT > 0) continue;
    if (dist2(x, y, b.x, b.y - 5) < (r + (b.type === 'car' ? 12 : 5)) ** 2) fn(b);
  }
}
function hitBreakables(game, x, y, r, dmg, src) {
  const hits = [];
  breakablesNear(game, x, y, r, (b) => hits.push(b));
  for (const b of hits) damageBreakable(game, b, dmg, src);
}
function damageBreakable(game, b, dmg, src) {
  let st = game.brk.get(b.id);
  if (!st) { st = { hp: BREAK_INFO[b.type].hp, deadT: 0 }; game.brk.set(b.id, st); }
  if (st.deadT > 0) return;
  st.hp -= dmg;
  if (st.hp > 0) return;
  const I = BREAK_INFO[b.type];
  st.deadT = 90 + rand() * 40;
  game.brokeVer++;
  emit(game, { t: 'brk', i: b.id, x: b.x, y: b.y - 6, k: I.kind, r: I.r });
  const team = src && src.team ? src.team : 'e';
  explode(game, b.x, b.y - 6, I.r, I.dmg, team, src ? { ...src, k: src.k === 'p' ? 'p' : src.k } : { k: 'x', team });
}

// ------------------------------------------------------------------ player weapons
function fireWeapon(game, p, slot) {
  const wid = p.equip[slot];
  const Wp = WEAPONS[wid];
  if (!Wp) return;
  const lvl = p.armory[wid] || 1;
  let mult = weaponMult(lvl) * p.dmgMult;
  mult *= buff(p, 'dmg', 1);
  if (p.cloakT > 0) { mult *= 2; p.cloakT = 0; emit(game, { t: 'fx', k: 'uncloak', id: p.id, x: p.x, y: p.y }); }
  p.cd[slot] = Wp.cd * buff(p, 'rof', 1);
  const a = p.aim;
  const v = p.veh ? game.vehicles.get(p.veh) : null;
  const lift = v && v.flying ? 12 : 0;
  const ox = p.x + Math.cos(a) * 6, oy = p.y - 8 - lift + Math.sin(a) * 6;
  const src = { k: 'p', id: p.id, team: p.gang };
  const dmg = Wp.dmg * mult;
  if (Wp.kind === 'ranged' || Wp.kind === 'rocket' || Wp.kind === 'beam' || Wp.kind === 'flame') { if (!p._shotT || p._shotT < game.time) { p._shotT = game.time + 0.4; crime(game, p, WANTED.shotSeen, p.x, p.y, false, 'shot'); } }
  const T = p.gang;
  if (p.id === 'host' && RECOIL[wid] && !p.veh) emit(game, { t: 'kick', id: p.id, a, k: RECOIL[wid], to: 'host' });
  if (Wp.kind === 'melee') {
    emit(game, { t: 'swing', o: 'p' + p.id, s: slot, a: +a.toFixed(2), k: wid });
    const cy = p.y - 6 - lift;
    forHits(game, T, (e) => {
      const d = Math.sqrt(dist2(p.x, cy, e.x, bodyY(e)));
      if (d > Wp.range + radiusOf(e) + 2) return;
      const ea = Math.atan2(bodyY(e) - cy, e.x - p.x);
      if (d > 8 && angDiff(ea, a) > Wp.arc / 2) return;
      damage(game, e, dmg, src, Math.cos(a) * Wp.knock * 3, Math.sin(a) * Wp.knock * 3);
    });
    hitBreakables(game, p.x + Math.cos(a) * Wp.range * 0.6, cy + Math.sin(a) * Wp.range * 0.6, Wp.range * 0.5, dmg, src);
  } else if (Wp.kind === 'ranged') {
    const n = Wp.pellets || 1;
    for (let i = 0; i < n; i++) {
      const sa = a + (n > 1 ? (i / (n - 1) - 0.5) * Wp.spread : (rand() - 0.5) * Wp.spread);
      spawnProj(game, { x: ox, y: oy, a: sa, speed: Wp.speed * (n > 1 ? 0.85 + rand() * 0.3 : 1), life: Wp.life, dmg, team: T, owner: p.id, src, kind: Wp.proj, homing: Wp.homing || 0, knock: Wp.knock || 20 });
    }
  } else if (Wp.kind === 'flame') {
    emit(game, { t: 'flame', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), a: +a.toFixed(2), r: Wp.range });
    forHits(game, T, (e) => {
      const d = Math.sqrt(dist2(ox, oy, e.x, bodyY(e)));
      if (d > Wp.range + radiusOf(e) || angDiff(Math.atan2(bodyY(e) - oy, e.x - ox), a) > Wp.arc / 2 + 0.1) return;
      damage(game, e, dmg, src);
      ignite(e, Wp.burn * weaponMult(lvl), Wp.burnT, src);
    });
    if (rand() < 0.5) hitBreakables(game, ox + Math.cos(a) * Wp.range * 0.6, oy + Math.sin(a) * Wp.range * 0.6, Wp.range * 0.4, dmg * 2, src);
  } else if (Wp.kind === 'whip') {
    const len = rayCast(game.world, ox, oy, a, Wp.range);
    const x2 = ox + Math.cos(a) * len, y2 = oy + Math.sin(a) * len;
    emit(game, { t: 'whip', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), s: slot });
    forHits(game, T, (e) => { if (segDist2(e.x, bodyY(e), ox, oy, x2, y2) < (radiusOf(e) + 5) ** 2) damage(game, e, dmg, src, Math.cos(a) * 60, Math.sin(a) * 60); });
    hitBreakables(game, x2, y2, 10, dmg, src);
  } else if (Wp.kind === 'slam') {
    const cx = p.x + Math.cos(a) * 16, cy = p.y - 4 - lift + Math.sin(a) * 16;
    emit(game, { t: 'slam', o: 'p' + p.id, x: Math.round(cx), y: Math.round(cy), r: Wp.radius, s: slot, a: +a.toFixed(2) });
    forHits(game, T, (e) => {
      const d = Math.sqrt(dist2(cx, cy, e.x, bodyY(e)));
      if (d < Wp.radius + radiusOf(e)) { const ka = Math.atan2(bodyY(e) - cy, e.x - cx); damage(game, e, dmg, src, Math.cos(ka) * Wp.knock, Math.sin(ka) * Wp.knock); }
    });
    hitBreakables(game, cx, cy, Wp.radius, dmg, src);
  } else if (Wp.kind === 'rocket') {
    spawnProj(game, { x: ox, y: oy, a, speed: Wp.speed, life: Wp.life, dmg, team: T, owner: p.id, src, kind: 'rocket', aoe: Wp.radius, r: 4 });
  } else if (Wp.kind === 'beam') {
    const len = rayCast(game.world, ox, oy, a, Wp.range);
    const x2 = ox + Math.cos(a) * len, y2 = oy + Math.sin(a) * len;
    emit(game, { t: 'beam', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), c: '#22e5ff' });
    forHits(game, T, (e) => { if (segDist2(e.x, bodyY(e), ox, oy, x2, y2) < (radiusOf(e) + 4) ** 2) damage(game, e, dmg, src, Math.cos(a) * 40, Math.sin(a) * 40); });
    for (let d = 20; d < len; d += 20) hitBreakables(game, ox + Math.cos(a) * d, oy + Math.sin(a) * d, 8, dmg, src);
  }
}

// ------------------------------------------------------------------ the main step
export function step(game, dt) {
  game.time += dt;
  game.dayT = (game.dayT + dt / DAY_LEN) % 1;
  for (const v of [...game.vehicles.values()]) updateVehicle(game, v, dt);
  for (const p of game.players.values()) updatePlayer(game, p, dt);
  for (const e of [...game.enemies.values()]) updateEnemy(game, e, dt);
  for (const al of [...game.allies.values()]) updateAlly(game, al, dt);
  for (const t of game.turrets.values()) updateTurret(game, t, dt);
  updateCivs(game, dt);
  updatePolice(game, dt);
  updateProjectiles(game, dt);
  updatePickups(game, dt);
  game.regionT += dt;
  if (game.regionT >= 0.5) { updateRegions(game, game.regionT); updateBreakables(game, game.regionT); game.regionT = 0; }
  updateRaids(game, dt);
  game.incomeT += dt;
  if (game.incomeT >= 10) { game.incomeT = 0; payIncome(game); }
  for (const q of game.vehQueue) q.t -= dt;
  while (game.vehQueue.length && game.vehQueue[0].t <= 0) { const q = game.vehQueue.shift(); if (game.vehicles.size < MAX_VEHICLES) { spawnVehicle(game, q.type); emit(game, { t: 'msg', text: `A new ${VEHICLES[q.type].name} is parked somewhere in the city.`, c: 'info' }); } }
}

function payIncome(game) {
  for (const g of game.gangs.values()) {
    let inc = 0;
    for (let i = 0; i < game.rs.length; i++) {
      if (game.rs[i].owner !== g.id) continue;
      const R = game.world.regions[i];
      inc += R.base ? (g.base === i ? 0 : 12) : COMPOUND_INCOME + R.tier * 2;
    }
    inc *= 1 + 0.25 * (g.upgrades.income || 0);
    if (inc > 0) { g.vault += inc; emit(game, { t: 'income', v: Math.round(inc), g: g.id }); }
  }
}

function updateBreakables(game, dt) {
  for (const [id, st] of game.brk) {
    if (st.deadT > 0) { st.deadT -= dt; if (st.deadT <= 0) { game.brk.delete(id); game.brokeVer++; } }
  }
}

function updatePlayer(game, p, dt) {
  for (const k in p.cd) if (p.cd[k] > 0) p.cd[k] -= dt;
  if (p.dead) {
    if (p.out) return;
    p.respawnT -= dt;
    if (p.respawnT <= 0) {
      const sp = spawnPoint(game, p);
      if (!sp) { p.out = true; p.dirty = true; return; }
      p.dead = false; p.hp = p.maxHp; p.invulnT = 2;
      p.x = sp.x + (rand() - 0.5) * 24; p.y = sp.y + 2 * TILE;
      const o = nearestOpen(game.world, p.x, p.y, PLAYER_R); p.x = o.x; p.y = o.y;
      emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y });
      for (const al of game.allies.values()) if (al.follow === p.id && dist2(al.x, al.y, p.x, p.y) > (25 * TILE) ** 2) { al.x = p.x + (rand() - 0.5) * 20; al.y = p.y + 10; }
      p.dirty = true;
    }
    return;
  }
  if (p.invulnT > 0) p.invulnT -= dt;
  if (p.cloakT > 0) { p.cloakT -= dt; if (p.cloakT <= 0) emit(game, { t: 'fx', k: 'uncloak', id: p.id, x: p.x, y: p.y }); }
  if (p.shieldT > 0) { p.shieldT -= dt; if (p.shieldT <= 0) p.shieldHp = 0; }
  if (p.burnT > 0) {
    p.burnT -= dt;
    p.burnTick = (p.burnTick || 0) + dt;
    if (p.burnTick >= 0.5) { p.burnTick = 0; hurtPlayer(game, p, p.burnDps * 0.5, p.burnSrc); if (p.dead) return; }
  }
  updateBuffs(game, p, dt);
  if (p.emoteT > 0) p.emoteT -= dt;
  let regen = p.regen;
  if (game.time - p.lastHurt > 6) regen += 1 + p.maxHp * 0.01;
  if (inBase(game, p)) regen += p.maxHp * 0.08;
  p.hp = Math.min(p.maxHp, p.hp + regen * dt);
  p.safe = inSafe(game, p);
  const canFire = (!p.veh || p.seat > 0) && p.inBar < 0 && !(p.emoteT > 0) && !p.safe;
  if (canFire && p.input.fireL && p.cd.L <= 0) fireWeapon(game, p, 'L');
  if (canFire && p.input.fireR && p.cd.R <= 0) fireWeapon(game, p, 'R');
}

function targetEntity(game, t) {
  if (!t) return null;
  if (t.k === 'p') {
    const p = game.players.get(t.id);
    if (!p || p.dead || p.cloakT > 0 || p.inBar >= 0) return null;
    if (p.veh) return game.vehicles.get(p.veh) || null;
    return p;
  }
  if (t.k === 't') { const tu = game.turrets.get(t.id); return tu && tu.deadT <= 0 ? tu : null; }
  if (t.k === 'v') { const v = game.vehicles.get(t.id); return v && v.seats.some(Boolean) ? v : null; }
  const a = game.allies.get(t.id);
  return a && !a.hidden ? a : null;
}

function updateEnemy(game, e, dt) {
  const world = game.world;
  if (e.flash > 0) e.flash -= dt;
  e.atkCd -= dt;
  if (e.burnT > 0) {
    e.burnT -= dt;
    e.burnTick += dt;
    const d = e.burnDps * dt;
    e.hp -= d;
    if (e.burnTick > 0.5) { e.burnTick = 0; emit(game, { t: 'dmg', x: e.x, y: e.y - 14 * e.bulk - 6, v: Math.round(e.burnDps * 0.5), c: 'burn' }); }
    if (e.hp <= 0) { killEnemy(game, e, e.burnSrc); return; }
  }
  if (Math.abs(e.kx) + Math.abs(e.ky) > 1) {
    moveBox(world, e, e.kx * dt, e.ky * dt, e.r);
    e.kx *= 0.86; e.ky *= 0.86;
  } else { e.kx = 0; e.ky = 0; }
  if (e.burst > 0) {
    e.burstT -= dt;
    if (e.burstT <= 0) {
      e.burst--; e.burstT = 0.12;
      const tgt = targetEntity(game, e.target);
      const a = tgt ? Math.atan2(bodyY(tgt) - bodyY(e), tgt.x - e.x) : e.windAng;
      spawnProj(game, { x: e.x, y: bodyY(e), a: a + (rand() - 0.5) * 0.12, speed: ATTACKS.burst.speed, life: 1.2, dmg: e.dmg * 0.6, team: 'e', kind: 'ebullet', src: { k: 'e', id: e.id, team: 'e' } });
    }
  }
  if (e.windup > 0) {
    e.windup -= dt;
    e.moving = false;
    if (e.windup <= 0) executeAttack(game, e);
    return;
  }
  e.thinkT -= dt;
  if (e.thinkT <= 0) { e.thinkT = 0.15 + rand() * 0.1; thinkEnemy(game, e); }
  const ek = Math.min(1, dt * (8 / Math.max(1, e.bulk)));
  e.svx = (e.svx || 0) + (e.mvx - (e.svx || 0)) * ek; e.svy = (e.svy || 0) + (e.mvy - (e.svy || 0)) * ek;
  if (Math.abs(e.svx) + Math.abs(e.svy) > 0.02) {
    const ox = e.x, oy = e.y;
    moveBox(world, e, e.svx * e.speed * dt, e.svy * e.speed * dt, e.r);
    e.moving = Math.abs(e.x - ox) + Math.abs(e.y - oy) > 0.05;
    if (!e.moving) e.stuck = (e.stuck || 0) + dt;
    else e.stuck = 0;
  } else e.moving = false;
  // attack
  const tgt = targetEntity(game, e.target);
  if (tgt && e.atkCd <= 0) {
    const A = ATTACKS[e.atk];
    const d = Math.sqrt(dist2(e.x, e.y, tgt.x, tgt.y));
    const range = e.atk === 'melee' ? A.range + e.r + 4 + (tgt.k === 'v' ? 8 : 0) : e.atk === 'slam' ? A.radius * 0.8 + e.r : A.range;
    if (d <= range && lineOfSight(world, e.x, bodyY(e), tgt.x, bodyY(tgt))) {
      e.windup = A.windup * (e.boss ? 0.8 : 1);
      e.windAng = Math.atan2(bodyY(tgt) - bodyY(e), tgt.x - e.x);
      e.aim = e.windAng;
      e.mvx = e.mvy = 0;
      if (e.atk === 'slam' || (e.boss && e.phase % 4 === 3)) emit(game, { t: 'tele', x: Math.round(e.x), y: Math.round(e.y), r: e.boss ? 56 : A.radius * (e.bulk / 1.4), d: e.windup });
    }
  }
}

function thinkEnemy(game, e) {
  const world = game.world;
  let tgt = targetEntity(game, e.target);
  const T = TIERS[e.tier];
  const aggro = T.aggro * TILE;
  if (tgt && dist2(e.x, e.y, tgt.x, tgt.y) > (aggro * 2) ** 2) { e.target = null; tgt = null; }
  if (tgt && e.target.k === 'p' && (tgt.safe || tgt.inBar >= 0)) { e.target = null; tgt = null; }
  if (!tgt && e.state !== 'return') {
    let best = null, bd = (e.state === 'raid' ? 7 * TILE : aggro) ** 2;
    const consider = (o, w, k) => {
      if ((e.police || e.leaving) && k !== 'p' && k !== 'v') return;
      const d = dist2(e.x, e.y, o.x, o.y) * w;
      if (d < bd && lineOfSight(world, e.x, bodyY(e), o.x, bodyY(o))) { bd = d; best = { k, id: o.id }; }
    };
    for (const p of game.players.values()) {
      if (p.dead || p.cloakT > 0 || p.inBar >= 0 || p.safe) continue;
      if (e.police && p.heat < 100 && p.copLevel <= 0) continue;
      if (e.leaving) continue;
      if (buff(p, 'ghost', 0) && dist2(e.x, e.y, p.x, p.y) > (3 * TILE) ** 2) continue;
      if (p.veh) { const v = game.vehicles.get(p.veh); if (v) consider(v, 1, 'v'); } else consider(p, e.police && e.police === p.id ? 0.4 : 1, 'p');
    }
    for (const al of game.allies.values()) if (!al.hidden) consider(al, e.raid ? 0.6 : 0.7, 'a');
    for (const t of game.turrets.values()) if (t.deadT <= 0) consider(t, e.raid ? 0.5 : 0.85, 't');
    if (best) { e.target = best; tgt = targetEntity(game, best); if (e.state === 'idle') e.state = 'chase'; }
  }
  // leash
  if (!e.raid && !e.police && e.state !== 'return' && dist2(e.x, e.y, e.hx, e.hy) > (26 * TILE) ** 2) { e.state = 'return'; e.target = null; tgt = null; }
  if (e.leaving) { e.target = null; tgt = null; let nx = 0, ny = 0; for (const p of game.players.values()) { nx += e.x - p.x; ny += e.y - p.y; } const l = Math.hypot(nx, ny) || 1; e.mvx = nx / l; e.mvy = ny / l; return; }
  let mx = 0, my = 0;
  if (tgt) {
    const d = Math.sqrt(dist2(e.x, e.y, tgt.x, tgt.y)) || 1;
    e.aim = Math.atan2(tgt.y - e.y, tgt.x - e.x);
    const A = ATTACKS[e.atk];
    const prefer = e.atk === 'melee' || e.atk === 'slam' ? 6 : A.range * 0.6;
    const los = lineOfSight(world, e.x, bodyY(e), tgt.x, bodyY(tgt));
    if (d > prefer || !los) {
      if (los) { mx = (tgt.x - e.x) / d; my = (tgt.y - e.y) / d; }
      else {
        const f = tgt.k === 'p' ? playerField(game, tgt) : tgt.k === 't' ? coreField(game, tgt.region) : tgt.k === 'a' && tgt.region >= 0 ? coreField(game, tgt.region) : null;
        const dir = f ? fieldDir(world, f, e.x, e.y) : null;
        if (dir && !dir.done) { mx = dir.x; my = dir.y; } else { mx = (tgt.x - e.x) / d; my = (tgt.y - e.y) / d; }
      }
    } else if (e.atk !== 'melee' && e.atk !== 'slam') {
      const s = Math.sin(game.time * 1.3 + e.id) > 0 ? 1 : -1;
      mx = -Math.sin(e.aim) * s * 0.5; my = Math.cos(e.aim) * s * 0.5;
    }
  } else if (e.state === 'raid') {
    const raid = game.raids.find((r) => r.id === e.raid);
    if (raid) {
      const dir = fieldDir(world, coreField(game, raid.target), e.x, e.y);
      if (dir && !dir.done) { mx = dir.x; my = dir.y; e.aim = Math.atan2(my, mx); }
    }
  } else if (e.state === 'return') {
    const d = Math.sqrt(dist2(e.x, e.y, e.hx, e.hy)) || 1;
    if (d < 2 * TILE) { e.state = 'idle'; e.hp = e.maxHp; }
    else {
      let dir = null;
      if (e.home >= 0) dir = fieldDir(world, coreField(game, e.home), e.x, e.y);
      if (dir && !dir.done && !lineOfSight(world, e.x, e.y, e.hx, e.hy)) { mx = dir.x; my = dir.y; }
      else { mx = (e.hx - e.x) / d; my = (e.hy - e.y) / d; }
      if (e.stuck > 1.5) { e.x = e.hx; e.y = e.hy; e.stuck = 0; }
    }
  } else {
    e.wanderT -= 0.2;
    if (e.wanderT <= 0) {
      e.wanderT = 2 + rand() * 4;
      if (rand() < 0.6) { const a = rand() * 6.28, r = rand() * 4 * TILE; e.wx = e.hx + Math.cos(a) * r; e.wy = e.hy + Math.sin(a) * r; }
      else e.wx = undefined;
    }
    if (e.wx !== undefined) {
      const d = Math.sqrt(dist2(e.x, e.y, e.wx, e.wy));
      if (d > 4 && (e.stuck || 0) < 0.6) { mx = (e.wx - e.x) / d * 0.45; my = (e.wy - e.y) / d * 0.45; e.aim = Math.atan2(my, mx); }
      else e.wx = undefined;
    }
  }
  for (const o of game.enemies.values()) {
    if (o === e) continue;
    const dx = e.x - o.x, dy = e.y - o.y;
    const md = (e.r + o.r) * 1.4;
    if (Math.abs(dx) < md && Math.abs(dy) < md) {
      const d = Math.hypot(dx, dy) || 1;
      if (d < md) { mx += dx / d * 0.6; my += dy / d * 0.6; }
    }
  }
  const l = Math.hypot(mx, my);
  if (l > 1) { mx /= l; my /= l; }
  e.mvx = mx; e.mvy = my;
}

function executeAttack(game, e) {
  const A = ATTACKS[e.atk];
  const a = e.windAng;
  const src = { k: 'e', id: e.id, team: 'e' };
  const by = bodyY(e);
  e.atkCd = A.cd * (0.8 + rand() * 0.4);
  switch (e.atk) {
    case 'melee': {
      emit(game, { t: 'swing', o: 'e' + e.id, s: 'R', a: +a.toFixed(2), k: 'claw' });
      const reach = A.range + e.r + 8;
      forHits(game, 'e', (o) => {
        const d = Math.sqrt(dist2(e.x, by, o.x, bodyY(o)));
        if (d < reach + radiusOf(o) - 4 && (d < 8 || angDiff(Math.atan2(bodyY(o) - by, o.x - e.x), a) < 1.2)) damage(game, o, e.dmg, src, Math.cos(a) * (60 + e.bulk * 40), Math.sin(a) * (60 + e.bulk * 40));
      });
      break;
    }
    case 'gun':
      spawnProj(game, { x: e.x, y: by, a, speed: A.speed, life: 1.3, dmg: e.dmg, team: 'e', kind: 'ebullet', src });
      break;
    case 'shotgun':
      for (let i = 0; i < A.pellets; i++) spawnProj(game, { x: e.x, y: by, a: a + (i / (A.pellets - 1) - 0.5) * 0.55, speed: A.speed, life: 0.6, dmg: e.dmg * 0.55, team: 'e', kind: 'ebullet', src });
      break;
    case 'burst':
      e.burst = A.shots; e.burstT = 0;
      break;
    case 'slam': {
      const r = A.radius * (e.bulk / 1.4);
      emit(game, { t: 'slam', o: 'e' + e.id, x: Math.round(e.x), y: Math.round(e.y), r });
      forHits(game, 'e', (o) => { if (dist2(e.x, e.y, o.x, o.y) < (r + radiusOf(o)) ** 2) { const ka = Math.atan2(o.y - e.y, o.x - e.x); damage(game, o, e.dmg * 1.3, src, Math.cos(ka) * 220, Math.sin(ka) * 220); } });
      hitBreakables(game, e.x, e.y, r, e.dmg, src);
      break;
    }
    case 'rocket':
      spawnProj(game, { x: e.x, y: by, a, speed: A.speed, life: 2, dmg: e.dmg * 1.4, team: 'e', kind: 'erocket', src, r: 4, aoe: A.radius });
      break;
    case 'boss': bossAttack(game, e, a, src, by); break;
  }
}

function bossAttack(game, e, a, src, by) {
  const enraged = e.hp < e.maxHp * 0.5;
  e.atkCd = enraged ? 1.1 : 1.6;
  const phase = e.phase++ % 4;
  if (phase === 0) {
    const n = enraged ? 22 : 16, off = rand() * 6.28;
    for (let i = 0; i < n; i++) spawnProj(game, { x: e.x, y: by, a: off + (i / n) * Math.PI * 2, speed: 120, life: 2.2, dmg: e.dmg * 0.6, team: 'e', kind: 'eball', src });
  } else if (phase === 1) {
    for (let i = 0; i < 7; i++) spawnProj(game, { x: e.x, y: by, a: a + (i / 6 - 0.5) * 0.9, speed: 170, life: 1.6, dmg: e.dmg * 0.6, team: 'e', kind: 'ebullet', src });
  } else if (phase === 2) {
    const n = enraged ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const ang = rand() * 6.28;
      const add = spawnEnemy(game, e.faction, 2 + (rand() < 0.4 ? 1 : 0), e.x + Math.cos(ang) * 24, e.y + Math.sin(ang) * 24, e.home, {});
      add.state = 'chase';
    }
    emit(game, { t: 'msg', text: `${enemyName(e)} calls for backup!`, c: 'warn' });
  } else {
    const r = 56;
    emit(game, { t: 'slam', o: 'e' + e.id, x: Math.round(e.x), y: Math.round(e.y), r });
    forHits(game, 'e', (o) => { if (dist2(e.x, e.y, o.x, o.y) < (r + radiusOf(o)) ** 2) damage(game, o, e.dmg * (o.k === 'p' ? 1.5 : 1), src); });
  }
}

function updateAlly(game, al, dt) {
  if (al.hidden) return;
  const world = game.world;
  if (al.flash > 0) al.flash -= dt;
  al.atkCd -= dt;
  al.thinkT -= dt;
  const owner = al.follow ? game.players.get(al.follow) : null;
  if (al.follow && !owner) { game.allies.delete(al.id); return; }
  if (al.thinkT <= 0) {
    al.thinkT = 0.25 + rand() * 0.1;
    // home point: guards stay at their post, followers stay around their owner
    const hx = owner ? owner.x : al.px, hy = owner ? owner.y : al.py;
    const leash = owner ? 8 * TILE : 12 * TILE;
    if (owner && !owner.dead && dist2(al.x, al.y, owner.x, owner.y) > (30 * TILE) ** 2) {
      const o = nearestOpen(world, owner.x + (rand() - 0.5) * 24, owner.y + (rand() - 0.5) * 24, 4);
      al.x = o.x; al.y = o.y;
    }
    let tgt = al.target;
    if (tgt && (!alive(game, tgt) || tgt.team === al.team || dist2(al.x, al.y, tgt.x, tgt.y) > (14 * TILE) ** 2)) tgt = null;
    if (!tgt) {
      let bd = (10 * TILE) ** 2;
      forTargets(game, al.team, (o) => {
        const d = dist2(al.x, al.y, o.x, o.y);
        if (d < bd && lineOfSight(world, al.x, al.y - 6, o.x, bodyY(o))) { bd = d; tgt = o; }
      });
    }
    al.target = tgt;
    let mx = 0, my = 0;
    if (tgt) {
      const d = Math.sqrt(dist2(al.x, al.y, tgt.x, tgt.y)) || 1;
      al.aim = Math.atan2(bodyY(tgt) - (al.y - 6), tgt.x - al.x);
      const los = lineOfSight(world, al.x, al.y - 6, tgt.x, bodyY(tgt));
      if (al.melee) {
        if (d > 12) { mx = (tgt.x - al.x) / d; my = (tgt.y - al.y) / d; }
        if (d < 18 + radiusOf(tgt) && al.atkCd <= 0) {
          al.atkCd = 0.65 + rand() * 0.2;
          emit(game, { t: 'swing', o: 'a' + al.id, s: 'R', a: +al.aim.toFixed(2), k: 'claw' });
          damage(game, tgt, al.dmg, { k: 'a', id: al.id, team: al.team }, Math.cos(al.aim) * 90, Math.sin(al.aim) * 90);
        }
      } else if (d > 90 || !los) { mx = (tgt.x - al.x) / d; my = (tgt.y - al.y) / d; }
      if (!al.melee && los && al.atkCd <= 0 && d < 150) {
        al.atkCd = (al.civ ? 0.45 : al.follow ? 0.7 : 0.9) + rand() * (al.civ ? 0.25 : 0.4);
        spawnProj(game, { x: al.x + Math.cos(al.aim) * 6, y: al.y - 8, a: al.aim + (rand() - 0.5) * 0.1, speed: 260, life: 0.7, dmg: al.dmg, team: al.team, kind: al.follow ? 'smart' : 'pulse', src: { k: 'a', id: al.id, team: al.team } });
      }
      if (dist2(al.x, al.y, hx, hy) > leash * leash) { mx = (hx - al.x); my = (hy - al.y); const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; al.target = null; }
    } else {
      const d = Math.sqrt(dist2(al.x, al.y, hx, hy));
      const stay = owner ? 26 : 20;
      if (d > stay) {
        const f = owner ? playerField(game, owner) : coreField(game, al.region);
        const dir = f ? fieldDir(world, f, al.x, al.y) : null;
        if (dir && !dir.done && d > 3 * TILE) { mx = dir.x; my = dir.y; } else { mx = (hx - al.x) / d; my = (hy - al.y) / d; }
        al.aim = Math.atan2(my, mx);
      } else if (!owner && rand() < 0.05) { al.px += (rand() - 0.5) * 30; al.py += (rand() - 0.5) * 30; }
    }
    for (const o of game.allies.values()) {
      if (o === al || o.hidden) continue;
      const dx = al.x - o.x, dy = al.y - o.y;
      if (Math.abs(dx) < 9 && Math.abs(dy) < 9) { const dd = Math.hypot(dx, dy) || 1; mx += dx / dd * 0.5; my += dy / dd * 0.5; }
    }
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    al.mvx = mx; al.mvy = my;
  }
  if (Math.abs(al.kx) + Math.abs(al.ky) > 1) { moveBox(world, al, al.kx * dt, al.ky * dt, al.r); al.kx *= 0.86; al.ky *= 0.86; } else { al.kx = 0; al.ky = 0; }
  const kk = Math.min(1, dt * 10);
  al.svx += (al.mvx - al.svx) * kk; al.svy += (al.mvy - al.svy) * kk;
  if (Math.abs(al.svx) + Math.abs(al.svy) > 0.02) {
    const ox = al.x, oy = al.y;
    const sp = owner && dist2(al.x, al.y, owner.x, owner.y) > (6 * TILE) ** 2 ? al.speed * 1.35 : al.speed;
    moveBox(world, al, al.svx * sp * dt, al.svy * sp * dt, al.r);
    al.moving = Math.abs(al.x - ox) + Math.abs(al.y - oy) > 0.05;
  } else al.moving = false;
}

function updateProjectiles(game, dt) {
  const world = game.world;
  const keep = [];
  for (const pr of game.projectiles) {
    pr.life -= dt;
    if (pr.homing) {
      let best = null, bd = 90 * 90;
      forTargets(game, pr.team, (o) => { const d = dist2(pr.x, pr.y, o.x, bodyY(o)); if (d < bd) { bd = d; best = o; } });
      if (best) {
        const cur = Math.atan2(pr.vy, pr.vx), want = Math.atan2(bodyY(best) - pr.y, best.x - pr.x);
        let d = want - cur; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
        const na = cur + Math.max(-pr.homing * dt, Math.min(pr.homing * dt, d));
        const sp = Math.hypot(pr.vx, pr.vy);
        pr.vx = Math.cos(na) * sp; pr.vy = Math.sin(na) * sp;
      }
    }
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    let dead = pr.life <= 0;
    if (dead && pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, pr.team, pr.src);
    if (!dead && opaqueAt(world, pr.x, pr.y)) {
      dead = true;
      if (pr.aoe) explode(game, pr.x - pr.vx * dt, pr.y - pr.vy * dt, pr.aoe, pr.dmg, pr.team, pr.src);
      else emit(game, { t: 'spark', x: Math.round(pr.x), y: Math.round(pr.y), i: pr.id });
    }
    if (!dead) {
      let hit = null;
      forHits(game, pr.team, (o) => {
        if (hit) return;
        const by = bodyY(o), rr = radiusOf(o) + pr.r + 1;
        if (Math.abs(o.x - pr.x) > rr || Math.abs(by - pr.y) > rr) return;
        if (dist2(pr.x, pr.y, o.x, by) < rr * rr) hit = o;
      });
      if (hit) {
        dead = true;
        if (pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, pr.team, pr.src);
        else { const a = Math.atan2(pr.vy, pr.vx); damage(game, hit, pr.dmg, pr.src, Math.cos(a) * pr.knock * 3, Math.sin(a) * pr.knock * 3); }
      } else {
        let bh = null;
        breakablesNear(game, pr.x, pr.y, 2, (b) => { if (!bh) bh = b; });
        if (bh) { dead = true; if (pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, pr.team, pr.src); else { damageBreakable(game, bh, pr.dmg, pr.src); emit(game, { t: 'spark', x: Math.round(pr.x), y: Math.round(pr.y), i: pr.id }); } }
      }
    }
    if (dead) { if (pr.life > 0) emit(game, { t: 'hitp', i: pr.id }); }
    else keep.push(pr);
  }
  game.projectiles = keep;
}

function updatePickups(game, dt) {
  for (const k of [...game.pickups.values()]) {
    k.life -= dt;
    if (k.life <= 0) { game.pickups.delete(k.id); continue; }
    for (const p of game.players.values()) {
      if (p.dead || p.veh || dist2(p.x, p.y, k.x, k.y) > 14 * 14) continue;
      if (k.type === 'heal' && p.hp >= p.maxHp) continue;
      game.pickups.delete(k.id);
      if (k.type === 'cash') addCash(game, p, k.amount, k.x, k.y - 8);
      else { p.hp = Math.min(p.maxHp, p.hp + k.amount); emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: k.amount, c: 'heal' }); }
      emit(game, { t: 'pick', i: k.id, id: p.id, k: k.type, x: k.x, y: k.y });
      break;
    }
  }
}

// ------------------------------------------------------------------ territory
const guardCapOf = (game, i) => {
  const rs = game.rs[i], R = game.world.regions[i];
  const g = game.gangs.get(rs.owner);
  return BASE_GUARDS + (g ? g.upgrades.count || 0 : 0) + (rs.up.barracks || 0) + (R.hq ? 2 : 0) + (R.base ? 2 : 0);
};

function updateRegions(game, dt) {
  const world = game.world;
  const players = [...game.players.values()].filter((p) => !p.dead);
  for (let i = 0; i < game.rs.length; i++) {
    const R = world.regions[i];
    const rs = game.rs[i];
    const core = corePosOf(game, i);
    let near = false;
    const onCore = new Map();           // gang id -> players on the core
    for (const p of players) {
      const d = dist2(p.x, p.y, core.x, core.y);
      if (d < (34 * TILE) ** 2) near = true;
      if (d < (2.6 * TILE) ** 2 && !p.veh) onCore.set(p.gang, (onCore.get(p.gang) || 0) + 1);
    }
    if (rs.hintT > 0) rs.hintT -= dt;
    if (!isGang(rs.owner)) {
      // ---------------- bot-held region
      if (near) {
        rs.idleT = 0;
        const desired = Math.min(rs.garrison, 5 + Math.round(R.tier * 1.5) + (R.hq ? 4 : 0));
        let budget = 3;
        while (rs.spawned < desired && budget-- > 0) {
          const pos = pickSpawnTile(game, i, rand() < 0.35);
          if (!pos) break;
          spawnEnemy(game, rs.owner, rollTier(game, R, R.hq ? 0.6 : 0), pos.x, pos.y, i, { garrison: true });
          rs.spawned++;
        }
        if (R.hq && rs.hqUnlocked && !rs.bossDefeated && !rs.bossSpawned) {
          const b = spawnEnemy(game, rs.owner, 6, core.x, core.y + 8, i, { boss: true });
          rs.bossSpawned = true;
          emit(game, { t: 'boss', f: rs.owner, r: i, name: enemyName(b) });
        }
      } else {
        rs.idleT += dt;
        if (rs.idleT > 12 && (rs.spawned > 0 || rs.bossSpawned)) {
          for (const e of [...game.enemies.values()]) {
            if (e.home !== i || e.raid) continue;
            if (e.boss) { game.enemies.delete(e.id); rs.bossSpawned = false; continue; }
            if (e.garrison && (e.state === 'idle' || e.state === 'return')) { game.enemies.delete(e.id); rs.spawned = Math.max(0, rs.spawned - 1); }
          }
        }
        if (!game.defeated[rs.owner] && rs.garrison < rs.garrisonMax) {
          rs.regenT += dt;
          if (rs.regenT > 14) { rs.regenT = 0; rs.garrison++; game.regionVer++; }
        }
      }
      let enemiesNear = false;
      for (const e of game.enemies.values()) if (dist2(e.x, e.y, core.x, core.y) < (3.5 * TILE) ** 2) { enemiesNear = true; break; }
      const gangsOn = [...onCore.keys()];
      const prev = rs.capture;
      let progressing = false;
      if (gangsOn.length === 1) {
        const g = gangsOn[0];
        const capturable = rs.garrison <= 0 && adjacentTo(game, i, g) && (!R.hq || rs.bossDefeated);
        if (capturable && !enemiesNear) {
          progressing = true;
          if (rs.capBy !== g && rs.capture > 0) rs.capture = Math.max(0, rs.capture - dt * 0.3);
          else { rs.capBy = g; rs.capture = Math.min(1, rs.capture + dt * (0.16 + 0.07 * (onCore.get(g) - 1))); }
        }
      }
      if (!progressing) rs.capture = Math.max(0, rs.capture - dt * 0.08);
      if (rs.capture !== prev) game.regionVer++;
      for (const g of gangsOn) {
        if (progressing || rs.hintT > 0) continue;
        rs.hintT = 6;
        let text;
        if (!adjacentTo(game, i, g)) text = 'Too far from your turf! Take a neighboring district first.';
        else if (R.hq && !rs.hqUnlocked) text = `HQ locked: control half of ${FACTIONS[rs.owner].short} territory first.`;
        else if (R.hq && !rs.bossDefeated) text = `Defeat ${FACTIONS[rs.owner].boss} to take this HQ!`;
        else if (rs.garrison > 0) text = `Kill the garrison first: ${rs.garrison} left.`;
        else if (gangsOn.length > 1) text = 'Contested! A rival gang is on the core.';
        else text = 'Enemies near the core stop the capture!';
        for (const p of players) if (p.gang === g && dist2(p.x, p.y, core.x, core.y) < (2.6 * TILE) ** 2) tell(game, p.id, text);
      }
      if (rs.capture >= 1 && rs.capBy) captureRegion(game, i, rs.capBy);
    } else {
      // ---------------- gang-held region
      const own = rs.owner;
      const cap = guardCapOf(game, i);
      rs.guardT += dt;
      if (rs.guards < cap && rs.guardT > 20) { rs.guardT = 0; rs.guards++; game.regionVer++; }
      const raid = game.raids.find((r) => r.target === i && r.state === 'active');
      const rivals = [...onCore.keys()].filter((g) => g !== own);
      let rivalNear = false;
      for (const p of players) if (p.gang !== own && dist2(p.x, p.y, core.x, core.y) < (20 * TILE) ** 2) { rivalNear = true; break; }
      const active = near || !!raid || rivalNear;
      if (active) {
        rs.idleT = 0;
        while (rs.gspawned < rs.guards) { spawnAlly(game, i); rs.gspawned++; }
      } else {
        rs.idleT += dt;
        if (rs.idleT > 10 && rs.gspawned > 0) {
          for (const al of [...game.allies.values()]) if (al.region === i) game.allies.delete(al.id);
          rs.gspawned = 0;
        }
      }
      // medic post
      if (rs.up.medic) {
        const C = R.compound;
        const inside = (o) => o.x > C.x * TILE && o.x < (C.x + C.w) * TILE && o.y > C.y * TILE && o.y < (C.y + C.h) * TILE;
        for (const p of players) if (p.gang === own && inside(p) && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 6 * dt);
        for (const al of game.allies.values()) if (al.team === own && inside(al) && al.hp < al.maxHp) al.hp = Math.min(al.maxHp, al.hp + 6 * dt);
      }
      // defenders near the core
      let defenders = 0;
      for (const p of players) if (p.gang === own && dist2(p.x, p.y, core.x, core.y) < (5 * TILE) ** 2) defenders++;
      for (const al of game.allies.values()) if (al.team === own && !al.hidden && dist2(al.x, al.y, core.x, core.y) < (5 * TILE) ** 2) defenders++;
      for (const t of game.turrets.values()) if (t.region === i && t.deadT <= 0) defenders++;
      const wallK = 1 - 0.25 * (rs.up.walls || 0);
      const prev = rs.capture;
      let attacker = null, rate = 0;
      if (raid) {
        let raidersNear = 0;
        for (const e of game.enemies.values()) if (e.raid === raid.id && dist2(e.x, e.y, core.x, core.y) < (2.8 * TILE) ** 2) raidersNear++;
        if (raidersNear > 0 && defenders === 0) { attacker = 'raid'; rate = 0.1 * wallK; }
      }
      if (!attacker && rivals.length === 1 && defenders === 0 && adjacentTo(game, i, rivals[0])) {
        attacker = rivals[0];
        rate = (R.base ? 0.05 : 0.11) * wallK * (1 + 0.3 * (onCore.get(attacker) - 1));
      }
      if (attacker) {
        if (rs.capBy !== attacker && rs.capture > 0) rs.capture = Math.max(0, rs.capture - dt * 0.3);
        else { rs.capBy = attacker; rs.capture = Math.min(1, rs.capture + dt * rate); }
      } else rs.capture = Math.max(0, rs.capture - dt * 0.15);
      if (prev !== rs.capture) game.regionVer++;
      if (rs.capture >= 1) {
        if (rs.capBy === 'raid' && raid) loseRegion(game, i, raid);
        else if (isGang(rs.capBy)) captureRegion(game, i, rs.capBy);
      }
    }
  }
  // radar: hostiles inside districts with a radar tower, per gang
  game.radarT += dt;
  if (game.radarT >= 1) {
    game.radarT = 0;
    game.radar = {};
    for (let i = 0; i < game.rs.length; i++) {
      const rs = game.rs[i];
      if (!isGang(rs.owner) || !rs.up.radar) continue;
      const list = game.radar[rs.owner] || (game.radar[rs.owner] = []);
      for (const e of game.enemies.values()) if (regionAt(world, e.x, e.y) === i) list.push([Math.round(e.x), Math.round(e.y)]);
      for (const p of game.players.values()) if (!p.dead && p.gang !== rs.owner && regionAt(world, p.x, p.y) === i) list.push([Math.round(p.x), Math.round(p.y)]);
    }
  }
}

function captureRegion(game, i, g) {
  const R = game.world.regions[i];
  const rs = game.rs[i];
  const prevOwner = rs.owner;
  const gang = game.gangs.get(g);
  if (!gang) return;
  setOwner(game, i, g);
  for (const e of game.enemies.values()) if (e.home === i && !e.raid) e.garrison = false;
  game.stats.captures++;
  emit(game, { t: 'cap', r: i, f: prevOwner, g, pg: isGang(prevOwner) ? prevOwner : null });
  const core = corePosOf(game, i);
  for (const p of game.players.values()) {
    if (p.gang !== g) continue;
    addCash(game, p, 100 + 60 * R.tier, p.x, p.y - 26);
    addXp(game, p, 40 * R.tier + 30);
    // the people send a soldier to follow whoever took the core
    if (!p.dead && !p.veh && dist2(p.x, p.y, core.x, core.y) < (4 * TILE) ** 2 && followerCount(game, p.id) < FOLLOWER_MAX && !R.base) {
      spawnFollower(game, p, Math.max(1, R.tier));
      emit(game, { t: 'follower', id: p.id, x: p.x, y: p.y, tier: Math.max(1, R.tier) });
    }
  }
  gang.vault += 100;
  if (R.hq && !isGang(prevOwner)) {
    game.defeated[prevOwner] = true;
    emit(game, { t: 'fdown', f: prevOwner });
    if (game.mode === 'pvp') gang.vault += 2000;
  }
  checkHqUnlocks(game);
  checkEndgame(game);
  if (game.raidT > 200) game.raidT = 200;
}

// Changes a district's owner and resets its local state (guards, turrets, upgrades).
function setOwner(game, i, owner) {
  const rs = game.rs[i];
  rs.owner = owner; rs.capture = 0; rs.capBy = null;
  rs.up = freshUps(); rs.slots = [null, null, null, null];
  for (const al of [...game.allies.values()]) if (al.region === i) game.allies.delete(al.id);
  rs.gspawned = 0; rs.guardT = 0;
  if (isGang(owner)) { rs.garrison = 0; rs.spawned = 0; rs.guards = guardCapOf(game, i) - (game.world.regions[i].hq ? 2 : 0); }
  else rs.guards = 0;
  syncTurrets(game, i);
  game.regionVer++;
}

function checkHqUnlocks(game) {
  if (game.mode === 'pvp') return;
  const w = game.world;
  const g = [...game.gangs.values()][0];
  for (let f = 0; f < 3; f++) {
    const hq = w.hqs[f];
    if (hq < 0 || game.rs[hq].hqUnlocked) continue;
    const list = w.factionRegions[f].filter((r) => r !== hq);
    const owned = list.filter((r) => game.rs[r].owner === g.id).length;
    if (list.length === 0 || owned / list.length >= 0.5) {
      game.rs[hq].hqUnlocked = true;
      game.regionVer++;
      emit(game, { t: 'hq', f, r: hq });
    }
  }
}

function checkEndgame(game) {
  if (game.mode === 'pve') {
    if (game.defeated.every(Boolean) && !game.victory) { game.victory = [...game.gangs.values()][0].id; emit(game, { t: 'win', g: game.victory }); }
    return;
  }
  const total = game.world.regions.length;
  for (const g of game.gangs.values()) {
    if (g.out) continue;
    const owned = ownedCount(game, g.id);
    if (owned === 0) {
      g.out = true;
      emit(game, { t: 'gangout', g: g.idx, name: g.name });
      for (const p of game.players.values()) if (p.gang === g.id) { p.out = true; p.dead = true; p.dirty = true; if (p.veh) leaveVehicle(game, p, true); }
      game.regionVer++;
    } else if (g.base >= 0 && game.rs[g.base].owner !== g.id && !g.baseLost) {
      g.baseLost = true;
      emit(game, { t: 'msg', text: `${g.name} lost their main base!`, c: 'bad' });
    } else if (g.base >= 0 && game.rs[g.base].owner === g.id) g.baseLost = false;
  }
  if (game.victory) return;
  const alive = [...game.gangs.values()].filter((g) => !g.out);
  for (const g of alive) {
    if (ownedCount(game, g.id) / total >= PVP_WIN_SHARE) { game.victory = g.id; emit(game, { t: 'win', g: g.id, why: 'share' }); return; }
  }
  if (game.gangsEver >= 2 && alive.length === 1) { game.victory = alive[0].id; emit(game, { t: 'win', g: alive[0].id, why: 'last' }); }
}

function loseRegion(game, i, raid) {
  const rs = game.rs[i];
  const prev = rs.owner;
  setOwner(game, i, raid.f);
  let n = 0;
  const C = game.world.regions[i].compound;
  for (const e of game.enemies.values()) if (e.raid === raid.id) {
    e.raid = null; e.state = 'idle'; e.home = i; e.garrison = true;
    e.hx = (C.coreX + 0.5) * TILE + (rand() - 0.5) * 60; e.hy = (C.coreY + 0.5) * TILE + (rand() - 0.5) * 50; n++;
  }
  rs.spawned = n;
  rs.garrison = n + 4;
  rs.garrisonMax = Math.max(rs.garrisonMax, rs.garrison);
  rs.idleT = 0;
  game.stats.lost++;
  game.raids = game.raids.filter((r) => r !== raid);
  emit(game, { t: 'lost', r: i, f: raid.f, g: prev });
  checkEndgame(game);
}

function updateRaids(game, dt) {
  let maxOwned = 0;
  for (const g of game.gangs.values()) if (!g.out) maxOwned = Math.max(maxOwned, ownedCount(game, g.id));
  if (maxOwned > 1) game.raidT -= dt;
  const maxRaids = maxOwned > 10 ? 2 : 1;
  if (game.raidT <= 0) {
    game.raidT = RAID_INTERVAL(maxOwned) * (0.8 + rand() * 0.4);
    if (game.raids.length < maxRaids + (game.mode === 'pvp' ? 1 : 0)) startRaid(game);
  }
  for (const raid of [...game.raids]) {
    raid.t -= dt;
    if (raid.state === 'warn') {
      if (raid.t <= 0) spawnRaid(game, raid);
    } else if (raid.alive <= 0) {
      game.raids = game.raids.filter((r) => r !== raid);
      const gang = game.gangs.get(raid.gang);
      if (gang) gang.vault += 250;
      for (const p of game.players.values()) if (p.gang === raid.gang) addXp(game, p, 80);
      game.stats.raidsBeaten++;
      emit(game, { t: 'raidend', r: raid.target, win: true, g: raid.gang });
      game.regionVer++;
    } else if (raid.t <= 0 || game.rs[raid.target].owner !== raid.gang) {
      for (const e of [...game.enemies.values()]) if (e.raid === raid.id) game.enemies.delete(e.id);
      game.raids = game.raids.filter((r) => r !== raid);
      emit(game, { t: 'raidend', r: raid.target, win: true, retreat: true, g: raid.gang });
      game.regionVer++;
    }
  }
}

function startRaid(game) {
  const w = game.world;
  const cands = [];
  for (let i = 0; i < game.rs.length; i++) {
    const own = game.rs[i].owner;
    if (!isGang(own) || w.regions[i].base) continue;
    if (game.raids.some((r) => r.target === i)) continue;
    for (const n of w.regions[i].neighbors) {
      const o = game.rs[n].owner;
      if (!isGang(o) && !game.defeated[o]) cands.push({ target: i, src: n, f: o, gang: own });
    }
  }
  if (!cands.length) { game.raidT = 40; return; }
  const c = pick(cands);
  const gang = game.gangs.get(c.gang);
  const owned = ownedCount(game, c.gang);
  let size = RAID_SIZE(owned);
  if (game.mode === 'pvp') size = Math.max(4, Math.round(size * 0.7));
  const warn = RAID_WARN + 15 * ((gang && gang.upgrades.intel) || 0) + (game.rs[c.target].up.radar ? 15 : 0);
  const raid = { id: game.nextId++, f: c.f, target: c.target, src: c.src, gang: c.gang, state: 'warn', t: warn, size, alive: 0 };
  game.raids.push(raid);
  game.regionVer++;
  emit(game, { t: 'raid', r: c.target, f: c.f, eta: Math.round(warn), g: c.gang, n: size });
}

function spawnRaid(game, raid) {
  const w = game.world;
  const core = corePosOf(game, raid.target);
  const list = w.spawnTiles[raid.src];
  let best = null, bd = Infinity;
  for (let k = 0; k < list.length; k += 3) {
    const i = list[k];
    const x = (i % w.W + 0.5) * TILE, y = ((i / w.W | 0) + 0.5) * TILE;
    const d = dist2(x, y, core.x, core.y);
    if (d < bd && d > (12 * TILE) ** 2) { bd = d; best = { x, y }; }
  }
  if (!best) { game.raids = game.raids.filter((r) => r !== raid); return; }
  const R = w.regions[raid.target];
  const f = coreField(game, raid.target);
  for (let n = 0; n < raid.size; n++) {
    let x = best.x, y = best.y;
    for (let a = 0; a < 8; a++) {
      const tx = best.x + (rand() - 0.5) * 60, ty = best.y + (rand() - 0.5) * 60;
      if (fieldDir(w, f, tx, ty)) { x = tx; y = ty; break; }
    }
    const lieutenant = n === 0 && raid.size >= 10;
    const e = spawnEnemy(game, raid.f, lieutenant ? 5 : rollTier(game, R, 0.9), x, y, raid.src, { raid: raid.id });
    if (lieutenant) { e.stars = 1; e.maxHp = e.hp = Math.round(e.maxHp * 1.3); }
    raid.alive++;
  }
  raid.state = 'active';
  raid.t = 200;
  emit(game, { t: 'raidgo', r: raid.target, f: raid.f, g: raid.gang });
}

// ------------------------------------------------------------------ civilians
// People living in the city. They wander, run from gunfire, and can be recruited (G) if your gang has a good
// reputation in the district. Hurting or killing them lowers that reputation.
export function repOf(game, g, r) {
  if (r < 0 || !g) return CIV.repStart;
  const v = game.rep[g + ':' + r] ?? CIV.repStart;
  return Math.max(0, Math.min(100, v + (game.rs[r] && game.rs[r].owner === g ? CIV.repOwnBonus : 0)));
}
function changeRep(game, g, r, d) {
  if (r < 0 || !isGang(g)) return;
  const k = g + ':' + r;
  const before = repOf(game, g, r);
  game.rep[k] = Math.max(-40, Math.min(100, (game.rep[k] ?? CIV.repStart) + d));
  const after = repOf(game, g, r);
  if (before >= CIV.repNeed && after < CIV.repNeed) emit(game, { t: 'msg', text: `The people of ${game.world.regions[r].name} turned against your gang.`, c: 'bad', g });
}
function markDanger(game, x, y, w = 1) {
  const d = game.danger;
  if (d.length && d[d.length - 1].t === game.time && Math.abs(d[d.length - 1].x - x) < 40) return;
  d.push({ x, y, t: game.time, w });
  if (d.length > 40) d.shift();
}

const CIV_GROUND = new Set([5, 10, 6, 2, 3, 7, 1, 14, 11]);   // sidewalk, stairs, calçadão, grass, dirt, concrete, sand, bridge, metal
function spawnCiv(game, x, y) {
  const c = {
    id: game.nextId++, k: 'c', x, y, hp: CIV.hp, maxHp: CIV.hp, seed: (rand() * 100000) | 0, aim: rand() * 6.28,
    mvx: 0, mvy: 0, svx: 0, svy: 0, kx: 0, ky: 0, flee: 0, fx: 0, fy: 0, wanderT: rand() * 3, wx: x, wy: y, flash: 0, moving: false, r: 4, stuck: 0,
  };
  game.civs.set(c.id, c);
  return c;
}

function updateCivs(game, dt) {
  game.civT -= dt;
  if (game.civT <= 0) {
    game.civT = 1;
    const w = game.world;
    const players = [...game.players.values()].filter((p) => !p.out);
    for (const c of [...game.civs.values()]) {
      if (!players.some((p) => dist2(p.x, p.y, c.x, c.y) < (42 * TILE) ** 2)) game.civs.delete(c.id);
    }
    for (const p of players) {
      if (game.civs.size >= CIV.max) break;
      let n = 0;
      for (const c of game.civs.values()) if (dist2(p.x, p.y, c.x, c.y) < (28 * TILE) ** 2) n++;
      for (let tries = 0; tries < 6 && n < CIV.perPlayer; tries++) {
        const a = rand() * 6.28, d = (17 + rand() * 9) * TILE;
        const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
        const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
        if (tx < 1 || ty < 1 || tx >= w.W - 1 || ty >= w.H - 1) continue;
        const i = ty * w.W + tx;
        if (!w.reach[i] || !CIV_GROUND.has(w.tiles[i])) continue;
        spawnCiv(game, (tx + 0.5) * TILE, (ty + 0.5) * TILE);
        n++;
      }
    }
    // reputation slowly heals toward neutral
    game.repT += 1;
    if (game.repT >= 10) { game.repT = 0; for (const k in game.rep) { const v = game.rep[k]; if (v < CIV.repStart) game.rep[k] = v + 2; } }
  }
  const world = game.world;
  for (const c of game.civs.values()) {
    if (c.flash > 0) c.flash -= dt;
    if (Math.abs(c.kx) + Math.abs(c.ky) > 1) { moveBox(world, c, c.kx * dt, c.ky * dt, c.r); c.kx *= 0.86; c.ky *= 0.86; } else { c.kx = 0; c.ky = 0; }
    // danger nearby? run the other way
    for (let i = game.danger.length - 1; i >= 0; i--) {
      const d = game.danger[i];
      if (game.time - d.t > 1.2) break;
      if (dist2(c.x, c.y, d.x, d.y) < (9 * TILE * d.w) ** 2) { c.flee = 3 + rand() * 2.5; c.fx = d.x; c.fy = d.y; break; }
    }
    let mx = 0, my = 0, sp = CIV.speed;
    if (c.flee > 0) {
      c.flee -= dt;
      const dx = c.x - c.fx, dy = c.y - c.fy, l = Math.hypot(dx, dy) || 1;
      mx = dx / l; my = dy / l; sp = CIV.fleeSpeed;
      if (c.stuck > 0.4) { const a = Math.atan2(my, mx) + (c.id % 2 ? 1.4 : -1.4); mx = Math.cos(a); my = Math.sin(a); }
    } else {
      c.wanderT -= dt;
      if (c.wanderT <= 0) {
        c.wanderT = 2 + rand() * 5;
        if (rand() < 0.65) { const a = rand() * 6.28, r = (1 + rand() * 4) * TILE; c.wx = c.x + Math.cos(a) * r; c.wy = c.y + Math.sin(a) * r; }
        else { c.wx = c.x; c.wy = c.y; }
      }
      const dx = c.wx - c.x, dy = c.wy - c.y, l = Math.hypot(dx, dy);
      if (l > 3 && c.stuck < 0.5) { mx = dx / l; my = dy / l; } else if (c.stuck >= 0.5) { c.wanderT = 0; c.stuck = 0; }
    }
    const k = Math.min(1, dt * 8);
    c.svx += (mx - c.svx) * k; c.svy += (my - c.svy) * k;
    if (Math.abs(c.svx) + Math.abs(c.svy) > 0.05) {
      const ox = c.x, oy = c.y;
      moveBox(world, c, c.svx * sp * dt, c.svy * sp * dt, c.r);
      c.moving = Math.abs(c.x - ox) + Math.abs(c.y - oy) > 0.05;
      c.stuck = c.moving ? 0 : c.stuck + dt;
      if (c.moving) c.aim = Math.atan2(c.svy, c.svx);
    } else c.moving = false;
  }
}

function hurtCiv(game, c, dmg, src, kx = 0, ky = 0) {
  if (!game.civs.has(c.id)) return;
  c.hp -= dmg;
  c.flash = 0.12;
  c.flee = 4; c.fx = c.x - (kx || 1); c.fy = c.y - (ky || 0);
  if (kx || ky) { c.kx += kx; c.ky += ky; }
  emit(game, { t: 'dmg', x: c.x, y: c.y - 20, v: Math.round(dmg), c: 'civ' });
  const team = src && src.team;
  const r = regionAt(game.world, c.x, c.y);
  if (c.hp <= 0) {
    game.civs.delete(c.id);
    emit(game, { t: 'die', x: c.x, y: c.y, tr: 1, f: -2, b: 0.9 });
    crimeBy(game, src, WANTED.killCiv, c.x, c.y, true);
    if (isGang(team)) {
      changeRep(game, team, r, -CIV.repKill);
      for (const o of game.civs.values()) if (dist2(o.x, o.y, c.x, c.y) < (10 * TILE) ** 2) { o.flee = 5; o.fx = c.x; o.fy = c.y; }
      if (src.k === 'p') emit(game, { t: 'msg', to: src.id, text: 'You killed a civilian. The locals will not trust your gang here for a while.', c: 'warn' });
    }
  } else { crimeBy(game, src, WANTED.hurtCiv, c.x, c.y, true); if (isGang(team)) changeRep(game, team, r, -CIV.repHurt); }
}

function recruitCiv(game, p) {
  if (p.dead || p.veh) return;
  let best = null, bd = 26 * 26;
  for (const c of game.civs.values()) { const d = dist2(c.x, c.y, p.x, p.y); if (d < bd) { bd = d; best = c; } }
  if (!best) return tell(game, p.id, 'Nobody close enough to talk to.');
  if (followerCount(game, p.id) >= FOLLOWER_MAX) return tell(game, p.id, `Your crew is full (${FOLLOWER_MAX}).`);
  const r = regionAt(game.world, best.x, best.y);
  const rp = repOf(game, p.gang, r);
  if (rp < CIV.repNeed) { best.flee = 3; best.fx = p.x; best.fy = p.y; return tell(game, p.id, `"Sai fora!" The locals don't trust your gang here (respect ${Math.round(rp)}/${CIV.repNeed}). Don't hurt civilians, take the district.`); }
  if (best.flee > 0.5) return tell(game, p.id, 'They are too scared right now.');
  game.civs.delete(best.id);
  const al = spawnFollower(game, p, 1, { civ: best.seed || 1, melee: rand() < 0.45, x: best.x, y: best.y });
  changeRep(game, p.gang, r, 2);
  emit(game, { t: 'recruit', id: p.id, x: al.x, y: al.y, melee: al.melee });
  p.dirty = true;
}

// ------------------------------------------------------------------ buffs (bar drinks and stims)
// Active items are kept per item (so two damage drinks stack). Multipliers multiply, bonuses add up, flags are on/off.
const MULT_EFF = { dmg: 1, speed: 1, armor: 1, rof: 1 };
function buff(p, k, def) {
  if (!p.buffs) return def;
  let v = MULT_EFF[k] ? 1 : 0, any = false;
  for (const id in p.buffs) {
    const b = p.buffs[id];
    if (b.t <= 0 || b.eff[k] === undefined) continue;
    any = true;
    if (MULT_EFF[k]) v *= b.eff[k]; else v += b.eff[k];
  }
  return any ? v : def;
}

function useItem(game, p, slot) {
  if (p.dead || slot < 0 || slot >= BELT_SIZE) return;
  const id = p.belt[slot];
  const I = id && ITEMS[id];
  if (!I) return;
  p.belt[slot] = null;
  const isStim = !!STIMS[id];
  for (const k in I.eff) {
    const v = I.eff[k];
    if (k === 'heal') { const h = p.maxHp * v; p.hp = Math.min(p.maxHp, p.hp + h); emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: Math.round(h), c: 'heal' }); }
    else if (k === 'cure') { p.poisonT = 0; p.burnT = 0; }
  }
  if (I.t > 0) p.buffs[id] = { t: I.t, eff: I.eff };
  let bad = false;
  if (isStim && rand() < BAD_BATCH.chance) { bad = true; p.poisonT = BAD_BATCH.t; }
  recalc(p); p.dirty = true;
  emit(game, { t: 'useitem', id: p.id, item: id, bad, x: p.x, y: p.y });
}

function updateBuffs(game, p, dt) {
  let changed = false;
  for (const k in p.buffs) {
    const b = p.buffs[k];
    b.t -= dt;
    if (b.t <= 0) { delete p.buffs[k]; changed = true; emit(game, { t: 'buffend', id: p.id, k: ITEMS[k] ? ITEMS[k].name : k, to: p.id }); }
  }
  if (changed) { recalc(p); p.dirty = true; }
  const reg = buff(p, 'regen', 0);
  if (reg) p.hp = Math.min(p.maxHp, p.hp + reg * dt);
  if (p.poisonT > 0) {
    p.poisonT -= dt;
    p.poisonTick = (p.poisonTick || 0) + dt;
    if (p.poisonTick >= 1) {
      p.poisonTick = 0;
      // bad batch: drains health, but never kills by itself
      const d = Math.min(BAD_BATCH.dps, Math.max(0, p.hp - 1));
      if (d > 0) { p.hp -= d; emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: Math.round(d), c: 'poison' }); }
    }
  }
}

// ------------------------------------------------------------------ bars
function nearBar(game, p) {
  for (const b of game.world.bars) if (dist2(p.x, p.y, b.doorX, b.doorY) < 26 * 26) return b;
  return null;
}
export function barAction(game, p, a) {
  if (a.t === 'barin') {
    if (p.dead || p.veh || p.inBar >= 0) return;
    const b = nearBar(game, p);
    if (!b) return;
    p.inBar = b.id; p.bx = BAR_ROOM.door.x; p.by = BAR_ROOM.door.y - 10;
    p.x = b.doorX; p.y = b.doorY + 2; p.cloakT = 0;
    for (const al of game.allies.values()) if (al.follow === p.id) al.hidden = true;
    for (const e of game.enemies.values()) if (e.target && e.target.k === 'p' && e.target.id === p.id) e.target = null;
    p.dirty = true; game.rosterVer++;
    emit(game, { t: 'barin', id: p.id, bar: b.id, x: b.doorX, y: b.doorY });
    return;
  }
  if (a.t === 'barout') {
    if (p.inBar < 0) return;
    const b = game.world.bars[p.inBar];
    p.inBar = -1;
    const o = nearestOpen(game.world, b.doorX, b.doorY + 10, PLAYER_R);
    p.x = o.x; p.y = o.y;
    for (const al of game.allies.values()) if (al.follow === p.id && al.hidden && !p.veh) { al.hidden = false; const q = nearestOpen(game.world, p.x + (rand() - 0.5) * 20, p.y + 10, 4); al.x = q.x; al.y = q.y; }
    p.dirty = true; game.rosterVer++;
    emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y, quiet: true });
    emit(game, { t: 'barout', id: p.id, x: p.x, y: p.y });
    return;
  }
  if (a.t === 'buy') {
    if (p.inBar < 0) return tell(game, p.id, 'You can only buy that inside a bar.');
    const I = ITEMS[a.item];
    if (!I) return;
    if (STIMS[a.item] && !game.world.bars[p.inBar].dealer) return tell(game, p.id, 'No dealer in this bar.');
    const slot = p.belt.indexOf(null);
    if (slot < 0) return tell(game, p.id, 'Your belt is full (3 items). Use something first (1/2/3).');
    if (p.cash < I.price) return tell(game, p.id, 'Not enough cash.');
    p.cash -= I.price; p.belt[slot] = a.item; p.dirty = true;
    emit(game, { t: 'buy', id: p.id, text: `${I.name} → slot ${slot + 1}` });
  }
}

// ------------------------------------------------------------------ police
// Crimes seen by civilians raise a player's heat (100 = 1 star). Police respond in patrol cars.
function witnesses(game, x, y) {
  const r2 = (WANTED.witnessRange * TILE) ** 2;
  for (const c of game.civs.values()) if (dist2(c.x, c.y, x, y) < r2) return true;
  for (const e of game.enemies.values()) if (e.police && dist2(e.x, e.y, x, y) < r2) return true;
  return false;
}
function crime(game, p, amount, x, y, seen = false, kind = '') {
  if (!p || p.dead || p.inBar >= 0) return;
  if (p.copLevel > 0 && (kind === 'shot' || kind === 'cop')) return;   // fighting the response doesn't make it bigger
  if (!seen && !witnesses(game, x ?? p.x, y ?? p.y)) return;
  const before = Math.floor(p.heat / 100);
  if (p.copLevel > 0) amount *= 0.5;
  p.heat = Math.min(500, p.heat + amount);
  const after = Math.floor(p.heat / 100);
  if (after > before) { p.dirty = true; emit(game, { t: 'wanted', id: p.id, stars: after, to: p.id }); }
}
function crimeBy(game, src, amount, x, y, seen = false, kind = '') {
  if (!src) return;
  if (src.k === 'p') crime(game, game.players.get(src.id), amount, x, y, seen, kind);
  else if (src.k === 'a') { const al = game.allies.get(src.id); if (al && al.follow) crime(game, game.players.get(al.follow), amount * 0.5, x, y, seen, kind); }
}

function clearWanted(game, p, why) {
  p.heat = 0; p.copLevel = 0; p.escapeT = 0; p.dirty = true;
  for (const e of game.enemies.values()) if (e.police === p.id) { e.leaving = true; e.target = null; }
  for (const c of game.pcars.values()) if (c.pid === p.id && c.state === 'in') c.state = 'out';
  if (why) emit(game, { t: 'wanted', id: p.id, stars: 0, why, to: p.id });
}

function dispatchPolice(game, p, units) {
  const W = game.world;
  for (let i = 0; i < units.length; i += 3) {
    const load = units.slice(i, i + 3);
    const a = rand() * 6.28;
    const sx = Math.max(TILE, Math.min(W.W * TILE - TILE, p.x + Math.cos(a) * 26 * TILE)), sy = Math.max(TILE, Math.min(W.H * TILE - TILE, p.y + Math.sin(a) * 26 * TILE));
    const t = nearestOpen(W, p.x + Math.cos(a) * (7 + rand() * 3) * TILE, p.y + Math.sin(a) * (7 + rand() * 3) * TILE, 7);
    const c = { id: game.nextId++, pid: p.id, x: sx, y: sy, ox: sx, oy: sy, tx: t.x, ty: t.y, units: load, state: 'in', t: 0, dir: 0 };
    game.pcars.set(c.id, c);
  }
  emit(game, { t: 'siren', id: p.id, x: p.x, y: p.y });
}

const POLICE_ATK = [null, 'gun', 'shotgun', 'burst', 'burst', 'rocket'];
function updatePolice(game, dt) {
  // patrol cars: fly in, drop cops, fly away
  for (const c of [...game.pcars.values()]) {
    const sp = 230 * dt;
    if (c.state === 'in') {
      const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
      if (d < sp + 2) {
        c.state = 'drop'; c.t = 0.8;
        for (const tier of c.units) {
          const o = nearestOpen(game.world, c.tx + (rand() - 0.5) * 30, c.ty + (rand() - 0.5) * 30, 5);
          const e = spawnEnemy(game, 3, tier, o.x, o.y, -1, {});
          e.police = c.pid; e.state = 'chase'; e.target = { k: 'p', id: c.pid }; e.atk = POLICE_ATK[tier]; e.hx = o.x; e.hy = o.y;
          if (tier === 4) { e.flyer = true; e.speed = 70; }
        }
        emit(game, { t: 'copsdrop', x: c.tx, y: c.ty });
      } else { c.x += dx / d * sp; c.y += dy / d * sp; c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 1) : (dy > 0 ? 0 : 3); }
    } else if (c.state === 'drop') { c.t -= dt; if (c.t <= 0) c.state = 'out'; }
    else {
      const dx = c.ox - c.x, dy = c.oy - c.y, d = Math.hypot(dx, dy);
      if (d < sp + 2) game.pcars.delete(c.id);
      else { c.x += dx / d * sp; c.y += dy / d * sp; c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 1) : (dy > 0 ? 0 : 3); }
    }
  }
  for (const p of game.players.values()) {
    if (p.dead || p.out) continue;
    const stars = Math.floor(p.heat / 100);
    if (stars > p.copLevel && p.inBar < 0) {
      const prev = p.copLevel ? POLICE_WAVES[p.copLevel].length : 0;
      dispatchPolice(game, p, POLICE_WAVES[stars].slice(prev));
      p.copLevel = stars; p.copSeen = true; p.dirty = true;
    }
    if (p.copLevel <= 0) { if (p.heat > 0 && !p.safe) p.heat = Math.max(0, p.heat - WANTED.decay * dt); continue; }
    let cops = 0, near = false;
    for (const e of game.enemies.values()) if (e.police === p.id && !e.leaving) { cops++; if (dist2(e.x, e.y, p.x, p.y) < (WANTED.escapeRange * TILE) ** 2) near = true; }
    const incoming = [...game.pcars.values()].some((c) => c.pid === p.id && c.state === 'in');
    if (!incoming && cops === 0) { clearWanted(game, p, 'beat'); continue; }
    if (p.inBar >= 0 || p.safe) continue;             // stars don't drop while hiding in a bar or at the QG
    if (!near || buff(p, 'ghost', 0)) {
      p.escapeT += dt;
      p.heat = Math.max(stars * 100 - 99, p.heat - WANTED.decay * dt);
      if (p.escapeT >= WANTED.escapeTime) clearWanted(game, p, 'escaped');
    } else p.escapeT = 0;
  }
  // cops that gave up walk off and vanish when nobody sees them
  for (const e of [...game.enemies.values()]) {
    if (!e.leaving) continue;
    let seen = false;
    for (const p of game.players.values()) if (dist2(p.x, p.y, e.x, e.y) < (22 * TILE) ** 2) { seen = true; break; }
    e.leaveT = (e.leaveT || 0) + dt;
    if (!seen || e.leaveT > 12) game.enemies.delete(e.id);
  }
}

// ------------------------------------------------------------------ emote (dance)
function startEmote(game, p) {
  if (p.dead || p.veh || p.emoteT > 0) return;
  p.emoteT = 3.2; p.emote = (rand() * 3) | 0;
  emit(game, { t: 'emote', id: p.id, e: p.emote, x: p.x, y: p.y });
}

// ------------------------------------------------------------------ network packing
const r1 = (v) => Math.round(v * 10) / 10;

export function regionState(game) {
  return {
    mode: game.mode,
    rs: game.rs.map((r) => {
      const row = [ownerCode(r.owner), r.garrison, r.garrisonMax, Math.round(r.capture * 100), r.guards, (r.hqUnlocked ? 1 : 0) | (r.bossDefeated ? 2 : 0), r.capBy === 'raid' ? 99 : r.capBy ? ownerCode(r.capBy) : -1];
      if (isGang(r.owner)) row.push([r.up.level, r.up.walls, r.up.barracks, r.up.medic, r.up.pad, r.up.radar], r.slots.map((s) => (s ? [TURRET_IDS.indexOf(s.type), s.mk] : 0)));
      return row;
    }),
    raids: game.raids.map((r) => [r.target, r.f, r.state === 'warn' ? 0 : 1, Math.max(0, Math.round(r.t)), gangIdx(r.gang), r.size]),
    gangs: [...game.gangs.values()].map((g) => ({ idx: g.idx, name: g.name, base: g.base, vault: Math.floor(g.vault), up: g.upgrades, out: g.out, owned: ownedCount(game, g.id) })),
    def: game.defeated, win: game.victory,
    br: [...game.brk.entries()].filter(([, s]) => s.deadT > 0).map(([k]) => k),
  };
}

export function roster(game) {
  return [...game.players.values()].map((p) => ({ id: p.id, name: p.name, look: p.look, equip: p.equip, mods: p.mods, level: p.level, color: p.color, g: gangIdx(p.gang), wp: p.wp }));
}

export function privateState(game, p) {
  return {
    hp: Math.ceil(p.hp), maxHp: p.maxHp, sh: Math.ceil(p.shieldHp), lvl: p.level, xp: Math.floor(p.xp), xn: xpForLevel(p.level),
    cash: Math.floor(p.cash), dead: p.dead, out: p.out, rt: r1(Math.max(0, p.respawnT)), cl: r1(Math.max(0, p.cloakT)),
    cd: { Q: r1(Math.max(0, p.cd.Q)), E: r1(Math.max(0, p.cd.E)), R: r1(Math.max(0, p.cd.R2)), F: r1(Math.max(0, p.cd.F)) },
    inv: p.invulnT > 0, veh: p.veh || 0, seat: p.seat, bat: p.battery, fol: followerCount(game, p.id), g: gangIdx(p.gang),
    belt: p.belt, buffs: Object.entries(p.buffs).map(([k, b]) => [k, Math.ceil(b.t)]), poison: Math.ceil(p.poisonT), heat: Math.round(p.heat), stars: Math.min(5, Math.ceil(p.heat / 100 - 0.001)), cops: p.copLevel, esc: r1(p.escapeT),
    bar: p.inBar, emo: r1(Math.max(0, p.emoteT)), safe: !!p.safe,
    rep: Math.round(repOf(game, p.gang, regionAt(game.world, p.x, p.y))),
  };
}

export function profile(p) {
  return { armory: p.armory, equip: p.equip, mods: p.mods, level: p.level, kills: p.kills, deaths: p.deaths, pvpKills: p.pvpKills, speed: p.speed, rof: buff(p, 'rof', 1), dash: buff(p, 'dash', 0), sway: buff(p, 'sway', 0), ghost: buff(p, 'ghost', 0), radar: buff(p, 'radar', 0), fury: buff(p, 'dmg', 1) > 1.3 };
}

export function vehicleRows(game) {
  const V = [];
  for (const v of game.vehicles.values()) {
    V.push([v.id, VEHICLE_IDS.indexOf(v.type), r1(v.x), r1(v.y), Math.ceil(v.hp), v.maxHp, Math.round(v.charge), v.dir, (v.flying ? 1 : 0) | (v.flash > 0 ? 2 : 0) | (v.charging ? 4 : 0), gangIdx(v.team), ...v.seats.map((s) => s || 0)]);
  }
  return V;
}

function radarFor(game, me) {
  const base = game.radar[me.gang] || [];
  if (!buff(me, 'radar', 0)) return base;
  const out = base.slice();
  for (const e of game.enemies.values()) if (dist2(e.x, e.y, me.x, me.y) < (34 * TILE) ** 2) out.push([Math.round(e.x), Math.round(e.y)]);
  return out;
}

export function buildSnapshot(game, pid) {
  const me = game.players.get(pid);
  if (!me) return null;
  const vx = 30 * TILE, vy = 20 * TILE;
  const near = (x, y) => Math.abs(x - me.x) < vx && Math.abs(y - me.y) < vy;
  const P = [];
  for (const p of game.players.values()) {
    P.push([p.id, r1(p.x), r1(p.y), +p.aim.toFixed(2), Math.ceil(p.hp), p.maxHp, (p.dead ? 1 : 0) | (p.cloakT > 0 ? 2 : 0) | (p.shieldHp > 0 ? 4 : 0) | (p.invulnT > 0 ? 8 : 0) | (p.burnT > 0 ? 16 : 0) | (p.out ? 32 : 0) | (buff(p, 'ghost', 0) ? 64 : 0) | (p.copLevel > 0 ? 128 : 0), p.level, p.veh || 0, p.seat, p.inBar, r1(p.bx), r1(p.by), p.emoteT > 0 ? p.emote + 1 : 0, Math.min(5, Math.ceil(p.heat / 100 - 0.001))]);
  }
  const E = [];
  for (const e of game.enemies.values()) {
    if (!near(e.x, e.y)) continue;
    E.push([e.id, e.faction * 10 + (e.boss ? 6 : e.tier), r1(e.x), r1(e.y), Math.ceil(e.hp), e.maxHp, (e.windup > 0 ? 1 : 0) | (e.flash > 0 ? 2 : 0) | (e.raid ? 4 : 0) | (e.moving ? 8 : 0) | (e.burnT > 0 ? 16 : 0), e.stars, +e.aim.toFixed(2), ATTACK_KEYS.indexOf(e.atk)]);
  }
  const A = [];
  for (const al of game.allies.values()) {
    if (al.hidden || !near(al.x, al.y)) continue;
    A.push([al.id, r1(al.x), r1(al.y), Math.ceil(al.hp), al.maxHp, (al.flash > 0 ? 2 : 0) | (al.moving ? 8 : 0), +al.aim.toFixed(2), gangIdx(al.team), al.follow || 0, al.tier, al.civ || 0, al.melee ? 1 : 0]);
  }
  const Tu = [];
  for (const t of game.turrets.values()) {
    if (!near(t.x, t.y)) continue;
    Tu.push([t.id, t.x, t.y, +t.aim.toFixed(2), Math.ceil(t.hp), t.maxHp, TURRET_IDS.indexOf(t.type), t.mk, gangIdx(t.team), (t.deadT > 0 ? 1 : 0) | (t.flash > 0 ? 2 : 0)]);
  }
  const Cv = [];
  for (const c of game.civs.values()) if (near(c.x, c.y)) Cv.push([c.id, r1(c.x), r1(c.y), c.seed, (c.flee > 0 ? 1 : 0) | (c.flash > 0 ? 2 : 0) | (c.moving ? 4 : 0), +c.aim.toFixed(2), Math.round(100 * c.hp / c.maxHp)]);
  const K = [];
  for (const k of game.pickups.values()) if (near(k.x, k.y)) K.push([k.id, k.type === 'cash' ? 0 : 1, Math.round(k.x), Math.round(k.y), k.amount]);
  return { t: 's', tm: +game.time.toFixed(2), day: +game.dayT.toFixed(4), P, E, A, T: Tu, V: vehicleRows(game), C: Cv, K, rc: radarFor(game, me), PC: [...game.pcars.values()].map((c) => [c.id, r1(c.x), r1(c.y), c.dir, c.state === 'in' ? 0 : c.state === 'drop' ? 1 : 2]), me: privateState(game, me) };
}

export { WEAPON_IDS, MAP_SIZES };

// Debug helpers (used for testing from the browser console)
export function debugSpawn(game, f, tier, x, y) {
  const e = spawnEnemy(game, f, tier, x, y, game.world.baseId, {});
  e.hx = x; e.hy = y;
  return e;
}
export function debugAlly(game, region) { return spawnAlly(game, region); }
export function debugFollower(game, pid, tier = 2) { const p = game.players.get(pid); return p ? spawnFollower(game, p, tier) : null; }
export function debugCapture(game, i, g) { captureRegion(game, i, g); }
export function debugRaid(game) { game.raidT = 0.01; }
