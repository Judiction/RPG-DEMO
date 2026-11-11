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
  BOCA, CREW_LVL, isMech,
  DEATH_XP_LOSS, DOWN, ENEMY_LVL_KILLS, COP_XP_LOSS, WITHDRAW, CREW_KILL, CREW_WEAPONS,
  EXTRA_SOLDIERS, SQUADS, SQUAD_COOLDOWN, TURRET_HP_MULT, TURRET_REPAIR_K, FACTION_UPGRADE_T,
  GRENADES, GREN_MAX, GREN_RANGE, GREN_CD,
  HELI, CIV_CARS,
  AGGRO, GUARD, WALL_TURRET_RANGE, BASE_ALARM, PETS, ALIENS, AURA, CHURCH, JAIL, JAIL_ID, JAIL_ROOM, PATROL,
} from './data.js';
import { moveBox, lineOfSight, rayCast, bfsField, fieldDir, regionAt, opaqueAt, solidAt, nearestOpen, boxHits } from './world.js';

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
const freshUps = () => ({ level: 0, walls: 0, barracks: 0, medic: 0, pad: 0, radar: 0, boca: 0 });
const freshGangUps = () => { const u = {}; for (const k in VAULT_UPGRADES) u[k] = 0; return u; };
// per-player game stats (ESC menu), kept in the save with the character
export const freshStats = () => ({
  time: 0, dist: 0, kills: 0, bosses: 0, cops: 0, aliens: 0, rivals: 0, deaths: 0, downs: 0, revives: 0, captures: 0, raidsWon: 0,
  dmgOut: 0, dmgIn: 0, shots: 0, hits: 0, earned: 0, spent: 0, gren: 0, maxStars: 0, recruits: 0, crewLost: 0, steals: 0, pets: 0, drinks: 0, squads: 0,
  arrests: 0, fines: 0, jail: 0, prayers: 0, aura: 0,
});
function stat(p, k, v = 1) { if (p && p.st) p.st[k] = (p.st[k] || 0) + v; }
function statDmg(game, src, d) { if (src && src.k === 'p' && d > 0) stat(game.players.get(src.id), 'dmgOut', d); }
function spend(p, v) { p.cash -= v; stat(p, 'spent', v); }

// ------------------------------------------------------------------ creation / saving
// opts: { mode: 'pve'|'pvp', gangIdx, gangName, save }
export function createGame(world, opts = {}) {
  const mode = opts.mode === 'pvp' ? 'pvp' : 'pve';
  const king = mode === 'pvp' && world.kingId >= 0 && !!opts.king;
  const game = {
    world, seed: world.seed, mode, mapOpts: { type: world.type, size: world.size, king: world.kingId >= 0 || undefined },
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
    civs: new Map(), civT: 0, danger: [], rep: {}, repT: 0, pcars: new Map(), grenades: [], smokes: [], fires: [], helis: new Map(), squadsSent: 0,
    pets: new Map(), petT: 0, gfields: new Map(), patrol: {},
    ufo: null, ufoN: 0, ufoMax: rand() < ALIENS.chance2 ? 2 : 1, ufoT: ALIENS.first[0] + rand() * (ALIENS.first[1] - ALIENS.first[0]), alienLeft: {},
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
    rs.garrisonMax = Math.round(7 + R.tier * 2.5 + (R.hq ? 8 : 0) + (R.king ? 14 : 0));
    rs.garrison = rs.garrisonMax;
    game.rs.push(rs);
  }
  if (opts.save) loadSave(game, opts.save);
  else {
    if (mode === 'pve') makeGang(game, opts.gangIdx ?? 0, opts.gangName, world.baseId);
    game.king = king; game.kingGoal = Math.max(60, (opts.kingTime || 10) * 60); game.kingHold = {};
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
  if (s.fvault) game.fvault = s.fvault;
  if (s.ufoT !== undefined) { game.ufoT = s.ufoT; game.ufoN = s.ufoN || 0; game.ufoMax = s.ufoMax || 1; }
  if (s.king && game.world.kingId >= 0) { game.king = true; game.kingGoal = s.kingGoal || 600; game.kingHold = s.kingHold || {}; game.kingMoved = !!s.kingMoved; game.kingOwner = s.kingOwner; }
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
      gang.vault = g.vault || 0; Object.assign(gang.upgrades, g.upgrades || {}); gang.out = !!g.out; if (g.into) gang.into = g.into;
    }
    game.gangsEver = s.gangsEver || game.gangs.size;
    game.defeated = s.defeated || game.defeated;
    game.victory = s.victory || null;
    (s.rs || []).forEach((r, i) => {
      const rs = game.rs[i];
      if (!rs) return;
      rs.owner = r.o; rs.garrison = r.g; rs.guards = r.gu; rs.hqUnlocked = !!r.hu || game.mode === 'pvp'; rs.bossDefeated = !!r.bd;
      rs.up = Object.assign(freshUps(), r.up || {}); rs.slots = (r.sl || [null, null, null, null]).map((x) => (x ? { type: x[0], mk: x[1], hpf: x[2] ?? 1 } : null)); rs.extra = r.ex || 0;
      if (isGang(rs.owner)) rs.garrisonMax = rs.garrisonMax || 0;
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
    gangs: [...game.gangs.values()].map((g) => ({ idx: g.idx, name: g.name, base: g.base, vault: Math.floor(g.vault), upgrades: g.upgrades, out: g.out, into: g.into })),
    gangsEver: game.gangsEver,
    defeated: game.defeated, victory: game.victory, raidT: Math.max(80, game.raidT), stats: game.stats,
    rs: game.rs.map((r) => ({
      o: r.owner, g: r.garrison, gu: r.guards, hu: r.hqUnlocked, bd: r.bossDefeated,
      up: r.up, sl: r.slots.map((x) => (x ? [x.type, x.mk, +(x.hpf ?? 1).toFixed(2)] : null)), ex: r.extra || 0,
    })),
    vehicles: [...game.vehicles.values()].filter((v) => !v.civ).map((v) => ({ type: v.type, x: Math.round(v.x), y: Math.round(v.y), hp: Math.round(v.hp), charge: Math.round(v.charge), team: v.team })),
    chars, rep: game.rep, savedAt: Date.now(), fvault: game.fvault, ufoT: Math.max(60, Math.round(game.ufoT)), ufoN: game.ufoN + (game.ufo ? 1 : 0), ufoMax: game.ufoMax, king: game.king, kingGoal: game.kingGoal, kingHold: game.kingHold, kingMoved: !!game.kingMoved, kingOwner: game.kingOwner,
    gangName: main ? main.name : '', gangColor: main ? main.color : GANG_COLORS[0],
    owned: main ? ownedCount(game, main.id) : 0, total: game.world.regions.length,
  };
}

function charData(game, p) {
  const followers = [...game.allies.values()].filter((a) => a.follow === p.id).map((a) => ({ tier: a.tier, hpf: +(a.hp / a.maxHp).toFixed(2), civ: a.civ || 0, melee: a.melee, lvl: a.lvl || 1, kills: a.kills || 0, grow: +(a.grow || 0).toFixed(2), heal: a.healer ? 1 : 0 }));
  return {
    name: p.name, look: p.look, color: p.color, gang: gangIdx(p.gang), level: p.level, xp: p.xp, cash: Math.floor(p.cash),
    armory: p.armory, equip: p.equip, mods: p.mods, kills: p.kills, deaths: p.deaths, pvpKills: p.pvpKills,
    followers, battery: p.battery, belt: p.belt, gren: p.gren, st: p.st,
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
  for (let k = 0, g0 = game.gangs.get(gangId(gIdx)); k < 6 && g0 && g0.into; k++) { gIdx = gangIdx(g0.into); g0 = game.gangs.get(g0.into); }
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
    belt: [null, null, null], gren: {}, grenSel: 'impact', buffs: {}, poisonT: 0, heat: 0, copLevel: 0, escapeT: 0, inBar: -1, bx: 0, by: 0, emoteT: 0, emote: 0,
    st: freshStats(),
  };
  if (saved) {
    Object.assign(p, {
      look: saved.look || o.look, level: saved.level || 1, xp: saved.xp || 0, cash: saved.cash ?? 120,
      armory: saved.armory || p.armory, equip: saved.equip || p.equip, mods: { ...p.mods, ...saved.mods },
      kills: saved.kills || 0, deaths: saved.deaths || 0, pvpKills: saved.pvpKills || 0, battery: !!saved.battery,
      belt: Array.isArray(saved.belt) ? saved.belt.slice(0, BELT_SIZE).map((x) => (ITEMS[x] ? x : null)) : [null, null, null],
      st: Object.assign(freshStats(), saved.st && typeof saved.st === 'object' ? saved.st : {}),
      gren: saved.gren && typeof saved.gren === 'object' ? Object.fromEntries(Object.entries(saved.gren).filter(([k, v]) => GRENADES[k] && v > 0).map(([k, v]) => [k, Math.min(GREN_MAX, v | 0)])) : {},
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
    const al = spawnFollower(game, p, f.tier || 1, { civ: f.civ, melee: f.melee, lvl: f.lvl, kills: f.kills, grow: f.grow });
    al.hp = Math.max(1, al.maxHp * (f.hpf ?? 1));
    if (f.heal) { al.healer = true; al.melee = false; al.healT = CHURCH.healEvery; }
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
  p.speed = p.down ? BASE_SPEED * DOWN.crawl : BASE_SPEED * (1 + 0.07 * l) * buff(p, 'speed', 1);
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
  p.input.rev = !!inp.rev;
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
  if ((p.veh && (key === 'Q' || key === 'R')) || p.emoteT > 0 || p.inBar >= 0 || p.down) return;
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
  if (amt > 0) stat(p, 'earned', amt);
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

// Safe zone: inside the walls of your own QG you can't get hurt (unless that base is being raided or hostiles are near).
// You can still shoot there (target practice).
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
    // hostiles in or near the walls: the defenders may shoot
    const x0 = (C.x - 6) * TILE, x1 = (C.x + C.w + 6) * TILE, y0 = (C.y - 6) * TILE, y1 = (C.y + C.h + 6) * TILE;
    const inArea = (o) => o.x > x0 && o.x < x1 && o.y > y0 && o.y < y1;
    for (const e of game.enemies.values()) if (!e.leaving && inArea(e) && copFoe(game, e, p.gang)) return false;
    for (const o of game.players.values()) if (o.gang !== p.gang && !o.dead && inArea(o)) return false;
    for (const a of game.allies.values()) if (a.team !== p.gang && !a.hidden && inArea(a)) return false;
    return true;
  }
  return false;
}

export function handleAction(game, id, a) {
  const p = game.players.get(id);
  if (!p || !a) return;
  if (a.t === 'stats') { emit(game, { t: 'stats', to: p.id, st: { ...p.st, level: p.level, cash: Math.floor(p.cash), crew: followerCount(game, p.id) } }); return; }
  if (p.down) { if (a.t === 'giveup') killPlayer(game, p, p.downSrc); return; }
  const gang = game.gangs.get(p.gang);
  if (a.t === 'veh') return toggleVehicle(game, p);
  if (a.t === 'recruit') return petOrRecruit(game, p);
  if (p.inBar === JAIL_ID && a.t !== 'emote' && a.t !== 'wp') return;      // nothing to do in a cell but wait (and dance)
  if (a.t === 'barin' || a.t === 'barout' || a.t === 'buy') return barAction(game, p, a);
  if (a.t === 'use') return useItem(game, p, a.s | 0);
  if (a.t === 'throw') return throwGrenade(game, p, a);
  if (a.t === 'emote') return startEmote(game, p);
  if (a.t === 'ally') return allyRequest(game, p, a);
  if (a.t === 'allyans') return allyAnswer(game, p, a);
  if (a.t === 'bribe') {
    const stars = Math.ceil(p.heat / 100);
    if (stars <= 0) return;
    if (!inBase(game, p)) return tell(game, p.id, 'Pay off the police at your base (QG).');
    const price = stars * WANTED.bribe;
    if (p.cash < price) return tell(game, p.id, `You need R$${price} to pay off the police.`);
    spend(p, price);
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
  if (a.t === 'cup' || a.t === 'turret' || a.t === 'tup' || a.t === 'trep' || a.t === 'take') return compoundAction(game, p, gang, a);
  if (a.t === 'squad') return sendSquad(game, p, gang, a);
  if (a.t === 'equip') {
    if (!inBase(game, p)) return tell(game, id, 'Go back to the base to swap arms.');
    if ((a.slot === 'L' || a.slot === 'R') && p.armory[a.w]) { p.equip[a.slot] = a.w; p.dirty = true; game.rosterVer++; }
    return;
  }
  if (a.t === 'donate') {
    const v = Math.min(Math.floor(p.cash), Math.max(0, a.v | 0));
    if (v <= 0) return;
    p.cash -= v; gang.vault += v; p.dirty = true;
    emit(game, { t: 'msg', to: p.id, text: `You put R$${v} in the gang vault.`, c: 'gold' });
    return;
  }
  if (a.t === 'withdraw') {
    if (!inBase(game, p)) return tell(game, id, 'Take money out at the Cofre in your QG.');
    if (game.time < (p.wdT || 0)) return tell(game, id, `The cofre is locked for ${Math.ceil(p.wdT - game.time)}s more.`);
    const v = Math.min(Math.floor(gang.vault * WITHDRAW.share), Math.max(0, a.v | 0));
    if (v <= 0) return tell(game, id, 'The vault is empty.');
    gang.vault -= v; p.cash += v; p.wdT = game.time + WITHDRAW.cd; p.dirty = true;
    emit(game, { t: 'msg', text: `${p.name} took R$${v} from the gang vault.`, c: 'gold', g: gang.id });
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
    emit(game, { t: 'msg', to: p.id, text: `You bought ${U.name} ${lvl + 1} for the gang.`, c: 'gold' });
    if (a.u === 'training') for (const al of game.allies.values()) if (al.team === gang.id) applyAllyStats(game, al);
    game.regionVer++;
    return;
  }
  if (!inBase(game, p)) return tell(game, id, 'Shops only work at your base (QG).');
  const pm = priceMult(gang);
  if (a.t === 'buyW') {
    const Wp = WEAPONS[a.w];
    if (!Wp || Wp.rare || p.armory[a.w]) return;
    const price = Math.round(Wp.price * pm);
    if (p.level < Wp.lvl) return tell(game, id, `Needs level ${Wp.lvl}.`);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    spend(p, price); p.armory[a.w] = 1; p.dirty = true;
    emit(game, { t: 'buy', to: id, id, text: `Bought ${Wp.name}!` });
  } else if (a.t === 'upW') {
    const lvl = p.armory[a.w];
    if (!lvl || lvl >= MAX_WEAPON_LVL) return;
    const price = Math.round(weaponUpgradePrice(a.w, lvl) * pm);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    spend(p, price); p.armory[a.w] = lvl + 1; p.dirty = true;
    emit(game, { t: 'buy', to: id, id, text: `${WEAPONS[a.w].name} upgraded to Mk${lvl + 1}!` });
  } else if (a.t === 'buyM') {
    const M = MODS[a.m];
    if (!M) return;
    const lvl = p.mods[a.m] || 0;
    if (lvl >= M.prices.length) return;
    const price = Math.round(M.prices[lvl] * pm);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    spend(p, price); p.mods[a.m] = lvl + 1; recalc(p); p.dirty = true; game.rosterVer++;
    emit(game, { t: 'buy', to: id, id, text: `${M.name} installed (Lv ${lvl + 1})!` });
  } else if (a.t === 'buyG') {
    const G0 = GRENADES[a.k];
    if (!G0) return;
    p.gren = p.gren || {};
    if ((p.gren[a.k] || 0) >= GREN_MAX) return tell(game, id, `You already carry ${GREN_MAX}.`);
    const price = Math.round(G0.price * pm);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    spend(p, price); p.gren[a.k] = (p.gren[a.k] || 0) + 1; p.dirty = true;
    emit(game, { t: 'buy', to: id, id, text: `${G0.name} grenade (${p.gren[a.k]}/${GREN_MAX})` });
  } else if (a.t === 'battery') {
    const price = Math.round(BATTERY_PRICE * pm);
    if (p.battery) return tell(game, id, 'You already carry a battery cell.');
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    spend(p, price); p.battery = true; p.dirty = true;
    emit(game, { t: 'buy', to: id, id, text: 'Battery cell bought. Get in an empty vehicle to recharge it.' });
  } else if (a.t === 'buyV') {
    const V = VEHICLES[a.v];
    if (!V) return;
    if ([...game.vehicles.values()].filter((v) => !v.civ).length >= MAX_VEHICLES) return tell(game, id, 'The city is full of vehicles already.');
    if (gang.vault < V.price) return tell(game, id, 'Not enough in the gang vault.');
    gang.vault -= V.price;
    spawnVehicleAtBase(game, gang, a.v, regionAt(game.world, p.x, p.y));
    emit(game, { t: 'msg', to: p.id, text: `You bought a ${V.name} for the gang. It's rolling out of the garage.`, c: 'gold' });
  }
}

// send a squad of soldiers + vault money against a district touching your turf (one per player every 3 min)
function sendSquad(game, p, gang, a) {
  const S = SQUADS[a.size | 0];
  const i = a.r | 0;
  const w = game.world;
  if (!S || !w.regions[i]) return;
  const rs = game.rs[i];
  if (rs.owner === gang.id) return tell(game, p.id, 'That district is already yours.');
  if (game.mode === 'pve' && rs.owner === 3) return;
  if (!adjacentTo(game, i, gang.id)) return tell(game, p.id, 'Squads can only attack a district touching your turf.');
  if (game.time < (p.squadT || 0)) return tell(game, p.id, `You can send another raid in ${Math.ceil(p.squadT - game.time)}s.`);
  if (game.raids.some((r) => r.target === i && r.kind === 'g')) return tell(game, p.id, 'A squad is already attacking there.');
  if (gang.vault < S.price) return tell(game, p.id, `Not enough in the gang vault (R$${S.price}).`);
  let soldiers = 0;
  for (let k = 0; k < game.rs.length; k++) if (game.rs[k].owner === gang.id) soldiers += game.rs[k].guards;
  if (soldiers < S.soldiers) return tell(game, p.id, `You need ${S.soldiers} soldiers in your compounds (you have ${soldiers}). Recruit locals in your turf.`);
  // take the soldiers from the compounds with the most of them
  let need = S.soldiers;
  while (need > 0) {
    let best = -1;
    for (let k = 0; k < game.rs.length; k++) if (game.rs[k].owner === gang.id && game.rs[k].guards > 0 && (best < 0 || game.rs[k].guards > game.rs[best].guards)) best = k;
    if (best < 0) break;
    const b = game.rs[best];
    b.guards--; if (b.extra > 0) b.extra--;
    for (const al of game.allies.values()) if (al.region === best) { game.allies.delete(al.id); b.gspawned = Math.max(0, b.gspawned - 1); break; }
    need--;
  }
  gang.vault -= S.price;
  p.squadT = game.time + SQUAD_COOLDOWN; p.dirty = true; stat(p, 'squads');
  if (game.world.regions[i].base && isGang(rs.owner) && ownedCount(game, rs.owner) > 1) tell(game, p.id, 'Their main base is SHIELDED while they hold other districts: your squad can only hit its guards and turrets.', 'warn');
  // march from our district next to the target
  const src = w.regions[i].neighbors.find((n) => game.rs[n].owner === gang.id);
  const start = corePosOf(game, src);
  const raid = { id: game.nextId++, kind: 'g', f: gang.id, target: i, src, gang: isGang(rs.owner) ? rs.owner : null, def: rs.owner, state: 'active', t: 260, size: S.n, alive: 0 };
  game.raids.push(raid);
  const L = gang.upgrades.training || 0;
  for (let n = 0; n < S.n; n++) {
    const o = nearestOpen(w, start.x + (rand() - 0.5) * 50, start.y + 30 + (rand() - 0.5) * 30, 5);
    const al = {
      id: game.nextId++, k: 'a', region: -1, team: gang.id, x: o.x, y: o.y, px: o.x, py: o.y, hp: 1, maxHp: 1, dmg: 7, speed: 66, r: 4.5,
      target: null, atkCd: rand(), thinkT: rand() * 0.3, aim: 0, flash: 0, mvx: 0, mvy: 0, moving: false, follow: null, tier: S.tier + (n === 0 ? 1 : 0), kx: 0, ky: 0, svx: 0, svy: 0,
      squad: raid.id, melee: rand() < 0.25,
    };
    al.maxHp = al.hp = Math.round((110 + 45 * al.tier) * (1 + 0.2 * L));
    al.dmg = (8 + 3.5 * al.tier) * (1 + 0.15 * L);
    game.allies.set(al.id, al);
    raid.alive++;
  }
  game.regionVer++;
  emit(game, { t: 'squad', r: i, g: gang.id, n: S.n, by: p.name, f: rs.owner });
}

function compoundAction(game, p, gang, a) {
  const i = a.r | 0;
  const rs = game.rs[i];
  if (!rs || rs.owner !== gang.id) return tell(game, p.id, 'Your gang does not control that district.');
  const pay = (price, what) => {
    if (gang.vault < price) { tell(game, p.id, 'Not enough in the gang vault.'); return false; }
    gang.vault -= price;
    emit(game, { t: 'cup', r: i, to: p.id, text: `You bought ${what} at ${game.world.regions[i].name}.` });
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
  } else if (a.t === 'trep') {
    const s = a.s | 0, sl = rs.slots[s];
    if (!sl || (sl.hpf ?? 1) >= 1) return;
    if (!pay(turretRepairPrice(sl), `repairs on the ${TURRETS[sl.type].name}`)) return;
    sl.hpf = 1;
    syncTurrets(game, i);
  } else if (a.t === 'take') {
    // take a soldier from this compound to follow you
    if (followerCount(game, p.id) >= FOLLOWER_MAX) return tell(game, p.id, `Your crew is full (${FOLLOWER_MAX}).`);
    if (rs.guards <= 0) return tell(game, p.id, 'No soldiers left in this compound.');
    if (regionAt(game.world, p.x, p.y) !== i) return tell(game, p.id, 'Go to that compound to pick up a soldier.');
    rs.guards--; if (rs.extra > 0) rs.extra--;
    for (const al of game.allies.values()) if (al.region === i) { game.allies.delete(al.id); rs.gspawned = Math.max(0, rs.gspawned - 1); break; }
    const al = spawnFollower(game, p, Math.max(1, game.world.regions[i].tier));
    emit(game, { t: 'follower', id: p.id, x: al.x, y: al.y, tier: al.tier });
    p.dirty = true; game.regionVer++;
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
  // gangs fight every enemy; normal enemies only fight raiders of another faction; raiders fight everyone else
  if (team === 'e') { for (const e of game.enemies.values()) if (e.team !== 'e') fn(e); }
  else for (const e of game.enemies.values()) if (e.team !== team && (civs || copFoe(game, e, team))) fn(e);
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
  if (src.k === 'h') return 'a police helicopter';
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
    stars: 0, boss: tier === 6, flash: 0, aim: rand() * 6.28, raid: opts.raid || null, wanderT: rand() * 3, team: 'e',
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
  e.kills = (e.kills || 0) + 1;
  if (e.kills < ENEMY_LVL_KILLS) return;
  e.kills = 0;
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
    if (e.alien) e.atk = e.tier === 4 ? 'slam' : 'plasma';
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
  if (al.follow && al.lvl > 1) { al.maxHp = Math.round(al.maxHp * (1 + CREW_LVL.hp * (al.lvl - 1))); al.dmg *= 1 + CREW_LVL.dmg * (al.lvl - 1); }
  if (al.follow && al.grow) al.maxHp = Math.round(al.maxHp * (1 + al.grow));
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
    civ: extra.civ || 0, melee: !!extra.melee, lvl: Math.max(1, Math.min(5, extra.lvl || 1)), kills: extra.kills || 0, grow: extra.grow || 0,
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
  if (C.garageB) {
    // roll out through the door, then park in the bay
    const b = C.garageB, slot = [...game.vehicles.values()].filter((o) => o.team === gang.id && dist2(o.x, o.y, gx, gy) < (3 * TILE) ** 2).length;
    const v = spawnVehicle(game, type, (b.x + b.w / 2) * TILE, (b.y + 0.4) * TILE);
    if (v) { v.team = gang.id; v.roll = { x: gx + ((slot % 3) - 1) * 22, y: gy - Math.floor(slot / 3) * 18, t: 1.6 }; v.dir = 0; v.lastMove = game.time; emit(game, { t: 'vroll', x: v.x, y: v.y }); }
    return v;
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
  if (best.civ) {
    // car theft: the driver jumps out and runs
    const c = spawnCiv(game, best.x + 8, best.y + 4);
    c.flee = 6; c.fx = p.x; c.fy = p.y; c.seed = best.civ;
    best.civ = 0;
    crime(game, p, CIV_CARS.theft, best.x, best.y, false, 'steal');
    stat(p, 'steals');
    emit(game, { t: 'steal', id: p.id, x: best.x, y: best.y });
  }
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
  statDmg(game, src, dmg);
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
  if (v.civ) { v.dir = Math.abs(v.tx - v.x) > Math.abs(v.ty - v.y) ? (v.tx > v.x ? 2 : 1) : (v.ty > v.y ? 0 : 3); v.px = v.x; v.py = v.y; return; }
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
  if (v.roll) {
    const dx = v.roll.x - v.x, dy = v.roll.y - v.y, d = Math.hypot(dx, dy), sp = 30 * dt;
    v.roll.t -= dt;
    if (d <= sp || v.roll.t <= 0 || v.seats.some(Boolean)) { if (!v.seats.some(Boolean)) { v.x = v.roll.x; v.y = v.roll.y; } v.roll = null; }
    else { v.x += dx / d * sp; v.y += dy / d * sp; v.lastMove = game.time; }
  }
  // recharge + repair: parked at your gang's base or at a compound with a charge pad (fastest in the garage bay)
  if (game.time - v.lastMove > 0.6 && v.team) {
    const r = regionAt(game.world, v.x, v.y);
    if (r >= 0 && game.rs[r].owner === v.team && (game.world.regions[r].base || game.rs[r].up.pad)) {
      if (v.charge < V.charge || v.hp < v.maxHp) {
        const C = game.world.regions[r].compound;
        const bay = C.garageB && dist2(v.x, v.y, C.garage.x, C.garage.y) < (3.5 * TILE) ** 2 ? 2.5 : 1;
        v.charge = Math.min(V.charge, v.charge + 9 * bay * dt);
        v.hp = Math.min(v.maxHp, v.hp + 22 * bay * dt);
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
  if (rs.owner === undefined || rs.owner === null) return;
  const C = game.world.regions[i].compound;
  const gang = game.gangs.get(rs.owner);
  const L = gang ? gang.upgrades.training || 0 : 0;
  for (let s = 0; s < 2 + rs.up.level && s < 4; s++) {
    const sl = rs.slots[s];
    if (!sl || !TURRETS[sl.type]) continue;
    const T = TURRETS[sl.type];
    const id = 100000 + i * 4 + s;
    const hp = Math.round(T.hp * TURRET_HP_MULT * turretMult(sl.mk) * (1 + 0.15 * L));
    game.turrets.set(id, {
      id, k: 't', region: i, slot: s, type: sl.type, mk: sl.mk, team: isGang(rs.owner) ? rs.owner : 'e', x: C.slots[s].x, y: C.slots[s].y + 4,
      hp: Math.max(1, Math.round(hp * (sl.hpf ?? 1))), maxHp: hp, wall: !!C.slots[s].wall, aim: -Math.PI / 2, cd: rand(), thinkT: rand() * 0.3, target: null, deadT: 0, flash: 0,
      mult: turretMult(sl.mk) * (1 + 0.15 * L),
    });
  }
}

// ------------------------------------------------------------------ aggro (who NPCs fight)
// Like most action games: an NPC hits back at whoever hurt it lately (the one dealing the most damage first),
// otherwise it fights the closest enemy it can see. It sticks with its target unless someone else is clearly closer
// or hurting it more, so it doesn't flicker between targets.
function noteHit(game, o, src, dmg) {
  if (!src || !src.k || src.k === 'x' || src.k === 'h' || src.id === undefined) return;
  if (src.team !== undefined && src.team === o.team) return;
  const m = o.thr || (o.thr = []);
  let r = null;
  for (const x of m) if (x.k === src.k && x.id === src.id) r = x;
  if (!r) { if (m.length >= 4) m.shift(); r = { k: src.k, id: src.id, d: 0, t: game.time }; m.push(r); }
  r.d = r.d * Math.max(0, 1 - (game.time - r.t) / AGGRO.memory) + dmg; r.t = game.time;
  o.retarget = true;
}
// < 1 when this candidate has been hurting us lately (smaller = hurt us more)
function aggroMul(game, self, k, id, obj) {
  const m = self.thr;
  if (!m || !m.length) return 1;
  let tot = 0, mine = 0;
  for (const r of m) {
    const age = game.time - r.t;
    if (age > AGGRO.memory) continue;
    const w = r.d * (1 - age / AGGRO.memory);
    tot += w;
    if ((r.k === k && r.id === id) || (k === 'v' && r.k === 'p' && obj && obj.seats && obj.seats.includes(r.id))) mine += w;
  }
  if (mine <= 0 || tot <= 0) return 1;
  return AGGRO.attackerK / (0.5 + mine / tot);
}

function hurtTurret(game, t, dmg, src) {
  statDmg(game, src, dmg);
  noteHit(game, t, src, dmg);
  { const rsH = game.rs[t.region]; if (rsH && src && src.team !== t.team) { rsH.hitT = game.time; rsH.hitBy = src; } }
  const walls = game.rs[t.region].up.walls || 0;
  dmg *= 1 - 0.12 * walls;
  t.hp -= dmg;
  t.flash = 0.1;
  const rs0 = game.rs[t.region], sl0 = rs0.slots[t.slot];
  if (sl0) sl0.hpf = Math.max(0, t.hp / t.maxHp);
  emit(game, { t: 'dmg', x: t.x, y: t.y - 20, v: Math.round(dmg), c: 'ally' });
  if (t.hp <= 0) {
    // destroyed for good: the slot is empty until someone buys a new turret
    game.turrets.delete(t.id);
    rs0.slots[t.slot] = null;
    game.regionVer++;
    emit(game, { t: 'boom', x: t.x, y: t.y - 6, r: 30 });
    emit(game, { t: 'tdown', x: t.x, y: t.y, r: t.region, g: isGang(t.team) ? t.team : undefined });
    if (src && src.k === 'e') promoteEnemy(game, game.enemies.get(src.id), 'a turret');
  }
}

export const turretRepairPrice = (sl) => Math.ceil((1 - (sl.hpf ?? 1)) * TURRETS[sl.type].price * TURRET_REPAIR_K / 10) * 10;
function updateTurret(game, t, dt) {
  if (t.flash > 0) t.flash -= dt;
  if (t.stunT > 0) { t.stunT -= dt; return; }
  const T = TURRETS[t.type];
  t.cd -= dt;
  t.thinkT -= dt;
  if (t.thinkT <= 0) {
    t.thinkT = 0.25;
    const range = T.range * (t.wall ? WALL_TURRET_RANGE : 1);
    let best = null, bs = Infinity;
    forTargets(game, t.team, (o) => {
      const d = Math.sqrt(dist2(t.x, t.y - 8, o.x, bodyY(o)));
      if (d > range) return;
      const sc = d * aggroMul(game, t, o.k, o.id, o) * (o === t.target ? AGGRO.stickK : 1);
      if (sc < bs && lineOfSight(game.world, t.x, t.y - 10, o.x, bodyY(o))) { bs = sc; best = o; }
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
  const rng = T.range * (t.wall ? WALL_TURRET_RANGE : 1);
  if (t.type === 'mg') spawnProj(game, { x: ox, y: oy, a: t.aim + (rand() - 0.5) * 0.08, speed: 320, life: rng / 320, dmg, team: t.team, kind: 'tbullet', src, owner: 't' + t.id });
  else if (t.type === 'rocket') spawnProj(game, { x: ox, y: oy, a: t.aim, speed: 170, life: rng / 170 + 0.2, dmg, team: t.team, kind: 'rocket', src, aoe: T.aoe, r: 4 });
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
    const len = rayCast(game.world, ox, oy, t.aim, rng);
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
  if (o.src && o.src.k === 'p') stat(game.players.get(o.src.id), 'shots');
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
  statDmg(game, src, dmg);
  noteHit(game, e, src, dmg);
  if (src && src.k === 'p') { const pl = game.players.get(src.id); if (pl && buff(pl, 'knock', 0)) { kx *= 2.2; ky *= 2.2; } }
  if (kx || ky) { const m = e.boss ? 0.15 : 1 / e.bulk; e.kx += kx * m; e.ky += ky * m; }
  if (!quiet) emit(game, { t: 'dmg', x: e.x, y: e.y - 14 * e.bulk - 6, v: Math.round(dmg), c: crit ? 'crit' : 'hit', fy: Math.round(e.y), d: kx || ky ? +Math.atan2(ky, kx).toFixed(2) : undefined, m: e.alien ? 2 : isMech(e.faction, e.tier, e.boss) ? 1 : 0 });
  if (src && e.state === 'idle' && src.team !== e.team && (src.k === 'p' || src.k === 'a' || src.k === 't' || src.k === 'e')) {
    // hurt while standing around: fight back right away
    const k = src.k === 'p' && game.players.get(src.id) && game.players.get(src.id).veh ? 'v' : src.k;
    e.target = { k, id: k === 'v' ? game.players.get(src.id).veh : src.id };
    e.state = 'chase';
  }
  if (e.hp <= 0) killEnemy(game, e, src);
}

// crew members level up with their kills: tougher, harder hitting, faster (up to level 5)
function crewKill(game, al) {
  if (!al || !al.follow) return;
  al.kills = (al.kills || 0) + 1;
  al.grow = Math.min(1, (al.grow || 0) + CREW_KILL.grow);
  applyAllyStats(game, al);
  al.hp = Math.min(al.maxHp, al.hp + al.maxHp * CREW_KILL.heal);
  emit(game, { t: 'dmg', x: al.x, y: al.y - 20, v: Math.round(al.maxHp * CREW_KILL.heal), c: 'heal' });
  const L = al.lvl || 1;
  if (L < 5 && al.kills >= CREW_LVL.kills[L]) {
    al.lvl = L + 1;
    applyAllyStats(game, al);
    al.hp = al.maxHp;
    emit(game, { t: 'flvl', id: al.follow, lvl: al.lvl, x: al.x, y: al.y });
    const owner = game.players.get(al.follow);
    if (owner) owner.dirty = true;
  }
}

function killEnemy(game, e, src) {
  if (e.police) crimeBy(game, src, WANTED.killCop, e.x, e.y, true, 'cop');
  game.enemies.delete(e.id);
  game.stats.kills++;
  emit(game, { t: 'die', x: e.x, y: e.y, tr: e.tier, f: e.faction, b: e.bulk, boss: e.boss });
  const T = TIERS[e.tier];
  let cash = T.cash * (1 + e.stars * 0.5) * (0.85 + rand() * 0.3);
  let xp = e.police ? 0 : T.xp * (1 + e.stars * 0.5);
  if (e.alien) { cash *= ALIENS.reward; xp *= ALIENS.reward; alienDown(game, e, src); }
  {
    const kp = src && src.k === 'p' ? game.players.get(src.id) : null;
    if (kp) { stat(kp, 'kills'); if (e.boss) stat(kp, 'bosses'); if (e.police) stat(kp, 'cops'); if (e.alien) stat(kp, 'aliens'); }
  }
  if (e.police && src && src.k === 'p') {
    const k = game.players.get(src.id);
    if (k && Math.floor(k.heat / 100) >= 3) {
      const loss = Math.min(k.xp, Math.round(xpForLevel(k.level) * COP_XP_LOSS));
      if (loss > 0) { k.xp -= loss; k.dirty = true; emit(game, { t: 'xploss', id: k.id, to: k.id, v: loss, x: k.x, y: k.y - 28, cop: 1 }); }
    }
  }
  const gang = src && src.team ? game.gangs.get(src.team) : null;
  if (gang) cash *= 1 + 0.15 * (gang.upgrades.bounty || 0);
  let killer = src && src.k === 'p' ? game.players.get(src.id) : null;
  if (src && src.k === 'a' && !e.police) crewKill(game, game.allies.get(src.id));
  if (!killer && src && src.k === 'a') {
    // crew and soldiers: the money goes to the gang vault (the boss still learns from it)
    const al = game.allies.get(src.id);
    if (gang) gang.vault += cash * (al && al.follow ? 1 : 0.5);
    if (al && al.follow) { const o = game.players.get(al.follow); if (o && xp) addXp(game, o, xp * 0.5); }
  }
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
  if (p.down) {
    if (isCopSrc(game, src)) { arrestPlayer(game, p, src); return; }   // cops cuff you where you lie
    // finishing a downed player: every hit takes time off the bleed-out timer
    p.downT -= dmg * DOWN.dmgToTime;
    emit(game, { t: 'dmg', x: p.x, y: p.y - 10, v: Math.round(dmg), c: 'player', fy: Math.round(p.y), d: kx || ky ? +Math.atan2(ky, kx).toFixed(2) : undefined });
    if (p.downT <= 0) killPlayer(game, p, src || p.downSrc);
    p.dirty = true;
    return;
  }
  p.hp -= dmg;
  p.lastHurt = game.time;
  stat(p, 'dmgIn', dmg);
  if (!src || src.team !== p.gang) statDmg(game, src, dmg);
  emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: Math.round(dmg), c: 'player', fy: Math.round(p.y), d: kx || ky ? +Math.atan2(ky, kx).toFixed(2) : undefined });
  emit(game, { t: 'hurt', id: p.id });
  if (p.hp <= 0 && buff(p, 'cheat', 0)) {
    for (const id in p.buffs) if (p.buffs[id].eff.cheat) delete p.buffs[id];
    p.hp = p.maxHp * 0.5; p.invulnT = 1.5; p.dirty = true;
    emit(game, { t: 'fx', k: 'cheat', id: p.id, x: p.x, y: p.y });
    return;
  }
  if (p.prayT > 0) stopPrayer(game, p);
  if (p.hp <= 0) { if (isCopSrc(game, src)) arrestPlayer(game, p, src); else downPlayer(game, p, src); }
}

// ------------------------------------------------------------------ prison
// The cops put you down: cuffs, a fine per star, a minute in the cell block, then you walk out at your main base.
function arrestPlayer(game, p, src) {
  if (p.veh) leaveVehicle(game, p, true);
  const stars = Math.max(1, Math.min(5, Math.ceil(p.heat / 100 - 0.001)));
  const fine = Math.min(Math.floor(p.cash), stars * JAIL.finePerStar);
  p.cash -= fine;
  stat(p, 'arrests'); stat(p, 'fines', fine);
  clearWanted(game, p, null);
  p.down = false; p.downT = 0; p.revP = 0; p.crewRev = 0; p.revT = 0; p.revId = null;
  p.hp = p.maxHp; p.cloakT = 0; p.shieldHp = 0; p.burnT = 0; p.poisonT = 0; p.emoteT = 0; p.prayT = 0;
  p.inBar = JAIL_ID; p.jailT = JAIL.time;
  p.bx = JAIL_ROOM.spawn.x + (rand() - 0.5) * 40; p.by = JAIL_ROOM.spawn.y + (rand() - 0.5) * 16;
  recalc(p);
  for (const al of game.allies.values()) if (al.follow === p.id) { al.hidden = true; al.emoteT = 0; }
  for (const e of game.enemies.values()) if (e.target && e.target.k === 'p' && e.target.id === p.id) e.target = null;
  p.dirty = true; game.rosterVer++;
  emit(game, { t: 'jail', id: p.id, name: p.name, fine, stars, t: JAIL.time, x: Math.round(p.x), y: Math.round(p.y), g: p.gang });
}
function releaseJail(game, p) {
  p.inBar = -1; p.jailT = 0;
  const sp = spawnPoint(game, p) || corePosOf(game, game.world.baseId);
  const o = nearestOpen(game.world, sp.x + (rand() - 0.5) * 24, sp.y + 2 * TILE, PLAYER_R);
  p.x = o.x; p.y = o.y; p.invulnT = 2; p.hp = p.maxHp;
  for (const al of game.allies.values()) if (al.follow === p.id) { al.hidden = false; const q = nearestOpen(game.world, p.x + (rand() - 0.5) * 24, p.y + 12, 4); al.x = q.x; al.y = q.y; }
  p.dirty = true; game.rosterVer++;
  emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y });
  emit(game, { t: 'jailout', id: p.id, name: p.name, x: p.x, y: p.y });
}

// 0 HP: you go down. Crawl, bleed, and wait for a gang-mate (or your crew) to pick you up.
function downPlayer(game, p, src) {
  p.down = true; p.downT = DOWN.time; p.downSrc = src || null; p.revP = 0; p.crewRev = 0;
  stat(p, 'downs');
  p.hp = 0; p.cloakT = 0; p.shieldHp = 0; p.emoteT = 0; p.revT = 0; p.revId = null;
  recalc(p); p.dirty = true;
  emit(game, { t: 'down', id: p.id, name: p.name, by: srcName(game, src), x: p.x, y: p.y, g: p.gang });
  if (src && src.k === 'e') promoteEnemy(game, game.enemies.get(src.id), p.name);
  for (const e of game.enemies.values()) if (e.target && e.target.k === 'p' && e.target.id === p.id && rand() < 0.5) e.target = null;
}
function revivePlayer(game, p, by) {
  if (!p.down) return;
  p.down = false; p.downT = 0; p.revP = 0; p.crewRev = 0;
  recalc(p);
  p.hp = p.maxHp * DOWN.reviveHp; p.invulnT = 1.5; p.lastHurt = game.time; p.dirty = true;
  emit(game, { t: 'revived', id: p.id, name: p.name, by, x: p.x, y: p.y, g: p.gang });
}

function killPlayer(game, p, src) {
  const gang = game.gangs.get(p.gang);
  if (!src && p.downSrc) src = p.downSrc;
  p.down = false; p.downT = 0; p.revP = 0;
  p.hp = 0; p.dead = true; p.respawnT = Math.max(1.5, RESPAWN_TIME - 1.5 * ((gang && gang.upgrades.rescue) || 0)); p.deaths++;
  stat(p, 'deaths');
  recalc(p);
  p.cloakT = 0; p.shieldHp = 0; p.burnT = 0; p.poisonT = 0; p.emoteT = 0;
  if (p.copLevel > 0) loseCops(game, p, null);
  p.prayT = 0;
  game.stats.deaths++;
  // dying costs: a quarter of your cash (gone for good) and part of your progress toward the next level
  const loss = Math.floor(p.cash * DEATH_CASH_LOSS);
  if (loss > 0) p.cash -= loss;
  const xpLoss = Math.floor(p.xp * DEATH_XP_LOSS);
  if (xpLoss > 0) p.xp -= xpLoss;
  emit(game, { t: 'pdie', id: p.id, name: p.name, by: srcName(game, src), loss, xp: xpLoss, x: p.x, y: p.y });
  if (src && src.k === 'a') {
    const al = game.allies.get(src.id);
    const g2 = al && game.gangs.get(al.team);
    if (g2 && al.team !== p.gang) g2.vault += 40 + 12 * p.level;
  }
  if (src && src.k === 'p') {
    const k = game.players.get(src.id);
    if (k && k.gang !== p.gang) {
      k.pvpKills++; stat(k, 'rivals');
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
  al.emoteT = 0;
  statDmg(game, src, dmg);
  noteHit(game, al, src, dmg);
  if (al.region >= 0 && !al.follow && !al.squad && src && src.team !== al.team) { const rsH = game.rs[al.region]; rsH.hitT = game.time; rsH.hitBy = src; }
  al.flash = 0.12;
  emit(game, { t: 'dmg', x: al.x, y: al.y - 20, v: Math.round(dmg), c: 'ally', fy: Math.round(al.y), d: kx || ky ? +Math.atan2(ky, kx).toFixed(2) : undefined });
  if (al.hp <= 0) {
    game.allies.delete(al.id);
    if (al.squad) { const raid = game.raids.find((r) => r.id === al.squad); if (raid) raid.alive--; }
    if (al.follow) {
      const owner = game.players.get(al.follow);
      emit(game, { t: 'fdie', id: al.follow, x: al.x, y: al.y });
      if (owner) { owner.dirty = true; stat(owner, 'crewLost'); }
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
  if (Wp.kind === 'ranged' || Wp.kind === 'rocket' || Wp.kind === 'beam' || Wp.kind === 'flame' || Wp.kind === 'chain') { if (!p._shotT || p._shotT < game.time) { p._shotT = game.time + 0.4; crime(game, p, WANTED.shotSeen, p.x, p.y, false, 'shot'); } }
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
  } else if (Wp.kind === 'chain') {
    // find the first target in front of us, then jump to the closest ones nearby
    let cur = null, bd = Wp.range * Wp.range;
    forTargets(game, T, (o) => {
      const d = dist2(ox, oy, o.x, bodyY(o));
      if (d > bd) return;
      if (angDiff(Math.atan2(bodyY(o) - oy, o.x - ox), a) > 0.42) return;
      if (!lineOfSight(game.world, ox, oy, o.x, bodyY(o))) return;
      bd = d; cur = o;
    });
    const src = { k: 'p', id: p.id, team: T };
    if (!cur) { const len = rayCast(game.world, ox, oy, a, Wp.range * 0.6); emit(game, { t: 'zap', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(ox + Math.cos(a) * len), y2: Math.round(oy + Math.sin(a) * len) }); return; }
    const hit = new Set();
    let from = { x: ox, y: oy }, dmg = Wp.dmg * mult;
    for (let j = 0; j <= Wp.jumps && cur; j++) {
      hit.add(cur);
      emit(game, { t: 'zap', o: 'p' + p.id, x: Math.round(from.x), y: Math.round(from.y), x2: Math.round(cur.x), y2: Math.round(bodyY(cur)) });
      if (cur.k === 'e' && isMech(cur.faction, cur.tier, cur.boss)) cur.stunT = Math.max(cur.stunT || 0, 0.8);
      const tx = cur.x, ty = bodyY(cur);
      damage(game, cur, dmg, src, Math.cos(a) * 60, Math.sin(a) * 60);
      from = { x: tx, y: ty };
      dmg *= 0.82;
      let next = null, nd = Wp.jumpR * Wp.jumpR;
      forTargets(game, T, (o) => { if (hit.has(o)) return; const d = dist2(tx, ty, o.x, bodyY(o)); if (d < nd) { nd = d; next = o; } });
      cur = next;
    }
  } else if (Wp.kind === 'beam') {
    const len = rayCast(game.world, ox, oy, a, Wp.range);
    const x2 = ox + Math.cos(a) * len, y2 = oy + Math.sin(a) * len;
    emit(game, { t: 'beam', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), c: Wp.color || '#22e5ff' });
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
  updatePets(game, dt);
  updateUfo(game, dt);
  updatePolice(game, dt);
  updatePatrol(game, dt);
  updateGrenades(game, dt);
  updateHelis(game, dt);
  updateCivCars(game, dt);
  updateKing(game, dt);
  updateProjectiles(game, dt);
  updatePickups(game, dt);
  game.regionT += dt;
  if (game.regionT >= 0.5) { updateRegions(game, game.regionT); updateBreakables(game, game.regionT); game.regionT = 0; }
  updateRaids(game, dt);
  game.incomeT += dt;
  if (game.incomeT >= 10) { game.incomeT = 0; payIncome(game); }
  updateBocas(game, dt);
  factionUpgrades(game, dt);
  for (const q of game.vehQueue) q.t -= dt;
  while (game.vehQueue.length && game.vehQueue[0].t <= 0) { const q = game.vehQueue.shift(); if (game.vehicles.size < MAX_VEHICLES) { spawnVehicle(game, q.type); emit(game, { t: 'msg', text: `A new ${VEHICLES[q.type].name} is parked somewhere in the city.`, c: 'info' }); } }
}

function updateBocas(game, dt) {
  const W = game.world;
  game.bocaT = game.bocaT || {};
  for (let i = 0; i < game.rs.length; i++) {
    const rs = game.rs[i];
    const B = W.regions[i].compound.boca;
    if (!B || !isGang(rs.owner) || rs.capture > 0) continue;
    const gang = game.gangs.get(rs.owner);
    if (!gang || gang.out) continue;
    const L = Math.min(3, rs.up.boca || 0);
    const rep = repOf(game, rs.owner, i);
    game.bocaT[i] = (game.bocaT[i] ?? BOCA.interval[L] * rand()) - dt * (0.5 + rep / 100);
    if (game.bocaT[i] > 0) continue;
    game.bocaT[i] = BOCA.interval[L] * (0.7 + rand() * 0.6);
    // somebody is watching: a real customer walks in. Nobody near: the sale just happens.
    let seen = false;
    for (const p of game.players.values()) if (!p.out && dist2(p.x, p.y, B.x, B.y) < (30 * TILE) ** 2) { seen = true; break; }
    if (!seen) { bocaSale(game, i, gang, L, false); continue; }
    let walking = 0;
    for (const c of game.civs.values()) if (c.buyer === i) walking++;
    if (walking >= BOCA.maxWalking) { bocaSale(game, i, gang, L, false); continue; }
    const f = bocaField(game, i);
    for (let tries = 0; tries < 12; tries++) {
      const a = rand() * 6.28, d = (11 + rand() * 9) * TILE;
      const tx = Math.floor((B.x + Math.cos(a) * d) / TILE), ty = Math.floor((B.y + Math.sin(a) * d) / TILE);
      if (tx < 1 || ty < 1 || tx >= W.W - 1 || ty >= W.H - 1 || !CIV_GROUND.has(W.tiles[ty * W.W + tx])) continue;
      const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
      if (!fieldDir(W, f, x, y)) continue;
      const c = spawnCiv(game, x, y);
      c.buyer = i; c.buyT = 0;
      break;
    }
  }
}
function bocaField(game, i) {
  game.bocaFields = game.bocaFields || {};
  if (!game.bocaFields[i]) { const B = game.world.regions[i].compound.boca; game.bocaFields[i] = bfsField(game.world, Math.floor(B.x / TILE), Math.floor(B.y / TILE), 26); }
  return game.bocaFields[i];
}
function bocaSale(game, i, gang, L, shown, x, y) {
  const [a, b] = BOCA.spend[L];
  const v = Math.round((a + rand() * (b - a)) * (1 + 0.25 * (gang.upgrades.income || 0)));
  gang.vault += v;
  gang.bocaTotal = (gang.bocaTotal || 0) + v;
  if (shown) emit(game, { t: 'sale', x, y, v, g: gang.id });
}

// NPC factions earn from their districts and spend it on their compounds' defenses
function factionUpgrades(game, dt) {
  game.fUpT = (game.fUpT ?? FACTION_UPGRADE_T) - dt;
  if (game.fUpT > 0) return;
  game.fUpT = FACTION_UPGRADE_T * (0.7 + rand() * 0.6);
  game.fvault = game.fvault || [0, 0, 0];
  for (let f = 0; f < 3; f++) {
    if (game.defeated[f]) continue;
    const mine = [];
    for (let i = 0; i < game.rs.length; i++) if (game.rs[i].owner === f) mine.push(i);
    if (!mine.length) continue;
    // districts on the front line (touching someone else) first
    const front = mine.filter((i) => game.world.regions[i].neighbors.some((n) => game.rs[n].owner !== f));
    const i = pick(front.length ? front : mine);
    const rs = game.rs[i];
    const opts = [];
    const nSlots = 2 + rs.up.level;
    for (let k = 0; k < nSlots && k < 4; k++) if (!rs.slots[k]) opts.push({ k: 'turret', s: k, type: pick(['mg', 'mg', 'rocket', 'tesla', 'flamer', 'rail']) });
    for (let k = 0; k < nSlots && k < 4; k++) if (rs.slots[k] && rs.slots[k].mk < TURRET_MAX_MK) opts.push({ k: 'tup', s: k });
    for (const u of ['walls', 'barracks', 'level', 'radar']) if ((rs.up[u] || 0) < COMPOUND_UPS[u].prices.length) opts.push({ k: 'up', u });
    if (!opts.length) continue;
    const o = pick(opts);
    const price = (o.k === 'turret' ? TURRETS[o.type].price : o.k === 'tup' ? turretUpgradePrice(rs.slots[o.s].type, rs.slots[o.s].mk) : COMPOUND_UPS[o.u].prices[rs.up[o.u] || 0]) * 0.7;
    if (game.fvault[f] < price) continue;
    game.fvault[f] -= price;
    if (o.k === 'turret') rs.slots[o.s] = { type: o.type, mk: 1, hpf: 1 };
    else if (o.k === 'tup') rs.slots[o.s].mk++;
    else { rs.up[o.u] = (rs.up[o.u] || 0) + 1; if (o.u === 'barracks') { rs.garrisonMax += 3; } }
    syncTurrets(game, i);
    game.regionVer++;
  }
}

function payIncome(game) {
  game.fvault = game.fvault || [0, 0, 0];
  for (let i = 0; i < game.rs.length; i++) { const o = game.rs[i].owner; if (typeof o === 'number' && o < 3) game.fvault[o] += COMPOUND_INCOME + game.world.regions[i].tier * 2; }
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
  if (p.inBar === JAIL_ID) {
    // doing time: walk around the cell block, dance if you want, wait for the gate
    if (p.emoteT > 0) p.emoteT -= dt;
    p.jailT -= dt;
    if (p.st) p.st.jail = (p.st.jail || 0) + dt;
    if (p.jailT <= 0) releaseJail(game, p);
    return;
  }
  if (p.down) {
    p.downT -= dt;
    p.safe = inSafe(game, p);
    if (p.downT <= 0) { killPlayer(game, p, p.downSrc); return; }
    // revive progress (from gang-mates holding E, or the crew member kneeling by us)
    let best = 0;
    for (const o of game.players.values()) if (o.revId === p.id) best = Math.max(best, o.revT / DOWN.reviveT);
    let crew = null, cd = Infinity;
    for (const al of game.allies.values()) if (al.follow === p.id && !al.hidden) { const d = dist2(al.x, al.y, p.x, p.y); if (d < cd) { cd = d; crew = al; } if (al.revT) best = Math.max(best, al.revT / DOWN.crewReviveT); }
    p.crewRev = crew ? crew.id : 0;
    p.revP = best;
    return;
  }
  // hold E next to a downed gang-mate to pick them up
  let rv = null;
  if (p.input.rev && !p.veh && p.inBar < 0) for (const o of game.players.values()) if (o !== p && o.down && o.gang === p.gang && dist2(o.x, o.y, p.x, p.y) < DOWN.reviveRange ** 2) { rv = o; break; }
  if (rv) {
    if (p.revId !== rv.id) { p.revId = rv.id; p.revT = 0; }
    p.revT += dt;
    if (p.revT >= DOWN.reviveT) { revivePlayer(game, rv, p.name); stat(p, 'revives'); p.revId = null; p.revT = 0; }
  } else { p.revId = null; p.revT = 0; }
  if (p.cloakT > 0) { p.cloakT -= dt; if (p.cloakT <= 0) emit(game, { t: 'fx', k: 'uncloak', id: p.id, x: p.x, y: p.y }); }
  if (p.shieldT > 0) { p.shieldT -= dt; if (p.shieldT <= 0) p.shieldHp = 0; }
  if (p.burnT > 0) {
    p.burnT -= dt;
    p.burnTick = (p.burnTick || 0) + dt;
    if (p.burnTick >= 0.5) { p.burnTick = 0; hurtPlayer(game, p, p.burnDps * 0.5, p.burnSrc); if (p.dead) return; }
  }
  updateBuffs(game, p, dt);
  if (p.emoteT > 0) p.emoteT -= dt;
  if (p.prayT > 0) { p.prayT -= dt; if (p.prayT <= 0) finishPrayer(game, p); }
  if (p.st) {
    p.st.time += dt;
    if (p.lx !== undefined && !p.veh) { const d = Math.hypot(p.x - p.lx, p.y - p.ly); if (d < 60) p.st.dist += d / TILE; }
    p.lx = p.x; p.ly = p.y;
    const stars = Math.min(5, Math.ceil(p.heat / 100 - 0.001));
    if (stars > p.st.maxStars) p.st.maxStars = stars;
  }
  let regen = p.regen;
  if (game.time - p.lastHurt > 6) regen += 1 + p.maxHp * 0.01;
  if (inBase(game, p)) regen += p.maxHp * 0.08;
  p.hp = Math.min(p.maxHp, p.hp + regen * dt);
  p.safe = inSafe(game, p);
  const canFire = (!p.veh || p.seat > 0) && p.inBar < 0 && !(p.emoteT > 0) && !p.revId;
  if (canFire && p.input.fireL && p.cd.L <= 0) fireWeapon(game, p, 'L');
  if (canFire && p.input.fireR && p.cd.R <= 0) fireWeapon(game, p, 'R');
}

function targetEntity(game, t) {
  if (!t) return null;
  if (t.k === 'c') return game.civs.get(t.id) || null;
  if (t.k === 'p') {
    const p = game.players.get(t.id);
    if (!p || p.dead || p.cloakT > 0 || p.inBar >= 0) return null;
    if (p.veh) return game.vehicles.get(p.veh) || null;
    return p;
  }
  if (t.k === 't') { const tu = game.turrets.get(t.id); return tu && tu.deadT <= 0 ? tu : null; }
  if (t.k === 'e') return game.enemies.get(t.id) || null;
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
  if (e.stunT > 0) { e.stunT -= dt; e.windup = 0; e.burst = 0; e.mvx = e.mvy = 0; e.moving = false; return; }
  if (e.burst > 0) {
    e.burstT -= dt;
    if (e.burstT <= 0) {
      e.burst--; e.burstT = 0.12;
      const tgt = targetEntity(game, e.target);
      const a = tgt ? Math.atan2(bodyY(tgt) - bodyY(e), tgt.x - e.x) : e.windAng;
      spawnProj(game, { x: e.x, y: bodyY(e), a: a + (rand() - 0.5) * 0.12, speed: ATTACKS.burst.speed, life: 1.2, dmg: e.dmg * 0.6, team: e.team, kind: 'ebullet', src: { k: 'e', id: e.id, team: e.team } });
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
  if (e.state !== 'return' && (!tgt || e.retarget || game.time >= (e.reT || 0))) {
    // (re)pick a target: recent attackers first, then the closest one in sight; stick with the current one
    e.retarget = false; e.reT = game.time + AGGRO.rethink * (0.8 + rand() * 0.4);
    const lim = e.state === 'raid' ? 7 * TILE : e.alien ? 12 * TILE : aggro;
    const cur = e.target;
    let best = null, bs = Infinity;
    const consider = (o, w, k, foe = false) => {
      if ((e.police || e.leaving) && k !== 'p' && k !== 'v' && !foe) return;
      const d = Math.sqrt(dist2(e.x, e.y, o.x, o.y));
      const m = aggroMul(game, e, k, o.id, o);
      const isCur = !!cur && cur.k === k && cur.id === o.id;
      if (d > (m < 1 || isCur ? lim * 2 : lim)) return;
      const sc = d * w * m * (isCur ? AGGRO.stickK : 1);
      if (sc < bs && lineOfSight(world, e.x, bodyY(e), o.x, bodyY(o)) && !smokeBlocks(game, e.x, e.y, o.x, o.y)) { bs = sc; best = { k, id: o.id }; }
    };
    for (const p of game.players.values()) {
      if (p.dead || p.cloakT > 0 || p.inBar >= 0 || p.safe) continue;
      if (e.police && p.heat < 100) continue;
      // a wanted player the police lost: only a cop who sees them up close recognizes them
      if (e.police && p.lost && (e.police !== 'patrol' || dist2(e.x, e.y, p.x, p.y) > (PATROL.spot * TILE) ** 2)) continue;
      if (e.leaving) continue;
      if (buff(p, 'ghost', 0) && dist2(e.x, e.y, p.x, p.y) > (3 * TILE) ** 2) continue;
      const w = e.police && e.police === p.id ? 0.4 : e.alien && e.victim === p.id ? 0.7 : 1;
      if (p.veh) { const v = game.vehicles.get(p.veh); if (v) consider(v, w, 'v'); } else consider(p, w, 'p');
    }
    for (const al of game.allies.values()) if (!al.hidden) consider(al, e.raid ? 0.6 : 0.7, 'a');
    for (const t of game.turrets.values()) if (t.deadT <= 0 && t.team !== e.team && !(t.team === 'e' && e.team === 'e')) consider(t, e.raid ? 0.5 : 0.85, 't');
    // faction wars: raiders go for the defenders, defenders go for the raiders of their district. Everyone fights the ETs.
    for (const o of game.enemies.values()) {
      if (o === e || o.leaving) continue;
      if (e.alien) { if (!o.alien) consider(o, 0.9, 'e', true); continue; }
      if (o.alien) { consider(o, 0.8, 'e', true); continue; }
      if (e.police) continue;
      if (e.team !== 'e' ? (o.team === 'e' && o.faction === e.xr) : (o.team !== 'e' && o.xr === e.faction)) consider(o, 0.8, 'e');
    }
    // the ETs shoot anyone they see, civilians too
    if (e.alien) for (const c of game.civs.values()) consider(c, 1.3, 'c', true);
    if (best) {
      e.target = best; tgt = targetEntity(game, best); if (e.state === 'idle') e.state = 'chase';
      if (e.police && (best.k === 'p' || best.k === 'v')) for (const p of game.players.values()) if ((best.k === 'p' && p.id === best.id) || (best.k === 'v' && p.veh === best.id)) spotted(game, p);
    }
  }
  // leash
  if (!e.raid && !e.police && !e.alien && e.state !== 'return' && dist2(e.x, e.y, e.hx, e.hy) > (26 * TILE) ** 2) { e.state = 'return'; e.target = null; tgt = null; }
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
  } else if (e.alien) {
    // the ETs hunt: their victim first, otherwise the closest player around
    let prey = game.players.get(e.victim);
    if (!prey || prey.dead || prey.inBar >= 0 || dist2(prey.x, prey.y, e.x, e.y) > (50 * TILE) ** 2) {
      prey = null; let bd = (50 * TILE) ** 2;
      for (const p of game.players.values()) { if (p.dead || p.inBar >= 0) continue; const d = dist2(p.x, p.y, e.x, e.y); if (d < bd) { bd = d; prey = p; } }
    }
    if (prey) {
      const dir = dist2(prey.x, prey.y, e.x, e.y) < (20 * TILE) ** 2 ? fieldDir(world, playerField(game, prey), e.x, e.y) : null;
      const d = Math.sqrt(dist2(e.x, e.y, prey.x, prey.y)) || 1;
      if (dir && !dir.done) { mx = dir.x; my = dir.y; } else { mx = (prey.x - e.x) / d; my = (prey.y - e.y) / d; }
      if (e.stuck > 1) { const a = Math.atan2(my, mx) + (e.id % 2 ? 1.3 : -1.3); mx = Math.cos(a); my = Math.sin(a); }
      e.aim = Math.atan2(my, mx);
    }
  } else if (e.patrol) {
    // on the beat: walk the sidewalks a few tiles at a time, stop, look around
    e.wanderT -= 0.2;
    if (e.wanderT <= 0) {
      e.wanderT = 3 + rand() * 5;
      e.wx = undefined;
      if (rand() < 0.7) for (let k = 0; k < 6; k++) {
        const a = rand() * 6.28, r = (3 + rand() * 6) * TILE;
        const tx = Math.floor((e.x + Math.cos(a) * r) / TILE), ty = Math.floor((e.y + Math.sin(a) * r) / TILE);
        if (tx < 1 || ty < 1 || tx >= world.W - 1 || ty >= world.H - 1) continue;
        const i = ty * world.W + tx;
        if (!world.reach[i] || !CIV_GROUND.has(world.tiles[i])) continue;
        { const rr = world.region[i], Cc = rr >= 0 ? world.regions[rr].compound : null; if (Cc && tx >= Cc.x - 1 && ty >= Cc.y - 1 && tx <= Cc.x + Cc.w && ty <= Cc.y + Cc.h) continue; }   // the beat stays out of the bases
        if (!lineOfSight(world, e.x, e.y, (tx + 0.5) * TILE, (ty + 0.5) * TILE)) continue;
        e.wx = (tx + 0.5) * TILE; e.wy = (ty + 0.5) * TILE; break;
      }
    }
    if (e.wx !== undefined) {
      const d = Math.sqrt(dist2(e.x, e.y, e.wx, e.wy));
      if (d > 4 && (e.stuck || 0) < 0.6) { mx = (e.wx - e.x) / d * 0.5; my = (e.wy - e.y) / d * 0.5; e.aim = Math.atan2(my, mx); }
      else e.wx = undefined;
    }
    e.hx = e.x; e.hy = e.y;
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
  const src = { k: 'e', id: e.id, team: e.team };
  const by = bodyY(e);
  e.atkCd = A.cd * (0.8 + rand() * 0.4);
  switch (e.atk) {
    case 'melee': {
      emit(game, { t: 'swing', o: 'e' + e.id, s: 'R', a: +a.toFixed(2), k: 'claw' });
      const reach = A.range + e.r + 8;
      forHits(game, e.team, (o) => {
        const d = Math.sqrt(dist2(e.x, by, o.x, bodyY(o)));
        if (d < reach + radiusOf(o) - 4 && (d < 8 || angDiff(Math.atan2(bodyY(o) - by, o.x - e.x), a) < 1.2)) damage(game, o, e.dmg, src, Math.cos(a) * (60 + e.bulk * 40), Math.sin(a) * (60 + e.bulk * 40));
      });
      break;
    }
    case 'gun':
      spawnProj(game, { x: e.x, y: by, a, speed: A.speed, life: 1.3, dmg: e.dmg, team: e.team, kind: 'ebullet', src });
      break;
    case 'shotgun':
      for (let i = 0; i < A.pellets; i++) spawnProj(game, { x: e.x, y: by, a: a + (i / (A.pellets - 1) - 0.5) * 0.55, speed: A.speed, life: 0.6, dmg: e.dmg * 0.55, team: e.team, kind: 'ebullet', src });
      break;
    case 'burst':
      e.burst = A.shots; e.burstT = 0;
      break;
    case 'slam': {
      const r = A.radius * (e.bulk / 1.4);
      emit(game, { t: 'slam', o: 'e' + e.id, x: Math.round(e.x), y: Math.round(e.y), r });
      forHits(game, e.team, (o) => { if (dist2(e.x, e.y, o.x, o.y) < (r + radiusOf(o)) ** 2) { const ka = Math.atan2(o.y - e.y, o.x - e.x); damage(game, o, e.dmg * 1.3, src, Math.cos(ka) * 220, Math.sin(ka) * 220); } });
      hitBreakables(game, e.x, e.y, r, e.dmg, src);
      break;
    }
    case 'rocket':
      spawnProj(game, { x: e.x, y: by, a, speed: A.speed, life: 2, dmg: e.dmg * 1.4, team: e.team, kind: 'erocket', src, r: 4, aoe: A.radius });
      break;
    case 'boss': bossAttack(game, e, a, src, by); break;
    case 'plasma': {
      // ET plasma: one green ball, a spread of three for the stronger ones
      const n = e.tier >= 3 ? 3 : 1;
      for (let i = 0; i < n; i++) spawnProj(game, { x: e.x, y: by, a: a + (n > 1 ? (i - 1) * 0.22 : 0), speed: A.speed, life: 1.4, dmg: e.dmg * (n > 1 ? 0.7 : 1), team: e.team, kind: 'eplasma', src, r: 3 });
      break;
    }
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
  if (al.healer && al.follow) { al.healT = (al.healT ?? CHURCH.healEvery) - dt; if (al.healT <= 0) { al.healT = CHURCH.healEvery; healerPulse(game, al); } }
  if (al.emoteT > 0) {
    // dancing with the boss
    al.emoteT -= dt; al.mvx = al.mvy = 0; al.svx = al.svy = 0; al.moving = false;
    const boss0 = al.follow ? game.players.get(al.follow) : null;
    if (!boss0 || boss0.dead || boss0.down) al.emoteT = 0;
    return;
  }
  al.atkCd -= dt;
  al.thinkT -= dt;
  const boss = al.follow ? game.players.get(al.follow) : null;
  const rescuing = !!(boss && boss.down && boss.crewRev === al.id);
  if (rescuing) {
    const d = Math.sqrt(dist2(al.x, al.y, boss.x, boss.y)) || 1;
    al.target = null;
    if (d < 13) {
      al.mvx = 0; al.mvy = 0; al.revT = (al.revT || 0) + dt; al.aim = Math.atan2(boss.y - al.y, boss.x - al.x);
      if (al.revT >= DOWN.crewReviveT) { al.revT = 0; revivePlayer(game, boss, 'crew'); }
    } else {
      al.revT = 0;
      const dir = fieldDir(world, playerField(game, boss), al.x, al.y);
      if (dir && !dir.done) { al.mvx = dir.x; al.mvy = dir.y; } else { al.mvx = (boss.x - al.x) / d; al.mvy = (boss.y - al.y) / d; }
    }
  } else al.revT = 0;
  const owner = al.follow ? game.players.get(al.follow) : null;
  if (al.follow && !owner) { game.allies.delete(al.id); return; }
  if (al.thinkT <= 0 && !rescuing) {
    al.thinkT = 0.25 + rand() * 0.1;
    // base guards: CALM = walk around outside the walls watching the streets; DEFENSE = hostiles inside, everyone in
    const guard = !owner && !al.squad && al.region >= 0;
    let defense = false, core = null;
    if (guard) {
      const rsG = game.rs[al.region];
      defense = (rsG.inside || 0) > 0 || game.time - (rsG.insideT ?? -99) < GUARD.calmAfter;
      core = corePosOf(game, al.region);
      if (defense !== !!al.def) { al.def = defense; al.waitT = 0; if (!defense) al.target = null; }
    }
    // home point: guards walk their round (or hold the yard), followers stay around their owner
    const hx = owner ? owner.x : guard && defense ? core.x : al.px, hy = owner ? owner.y : guard && defense ? core.y : al.py;
    const leash = owner ? 8 * TILE : guard ? (defense ? 16 : 9) * TILE : 12 * TILE;
    if (owner && !owner.dead && dist2(al.x, al.y, owner.x, owner.y) > (30 * TILE) ** 2) {
      const o = nearestOpen(world, owner.x + (rand() - 0.5) * 24, owner.y + (rand() - 0.5) * 24, 4);
      al.x = o.x; al.y = o.y;
    }
    let tgt = al.target;
    if (tgt && (!alive(game, tgt) || tgt.team === al.team || dist2(al.x, al.y, tgt.x, tgt.y) > (14 * TILE) ** 2)) tgt = null;
    if (al.squad && !game.raids.some((r) => r.id === al.squad)) { game.allies.delete(al.id); return; }
    if (!tgt || al.retarget || game.time >= (al.reT || 0)) {
      // recent attackers first, then the closest enemy in sight; guards in defense go for whoever is inside the walls
      al.retarget = false; al.reT = game.time + AGGRO.rethink * (0.8 + rand() * 0.4);
      const lim = guard ? (defense ? 14 : GUARD.spot) * TILE : 10 * TILE;
      const C = guard ? world.regions[al.region].compound : null;
      const inWalls = (o) => o.x > C.x * TILE && o.x < (C.x + C.w) * TILE && o.y > C.y * TILE && o.y < (C.y + C.h) * TILE;
      let best = null, bs = Infinity;
      forTargets(game, al.team, (o) => {
        const d = Math.sqrt(dist2(al.x, al.y, o.x, o.y));
        const m = aggroMul(game, al, o.k, o.id, o), isCur = o === tgt;
        if (d > (m < 1 || isCur ? lim * 1.4 : lim)) return;
        let sc = d * m * (isCur ? AGGRO.stickK : 1);
        if (guard && defense && inWalls(o)) sc *= 0.6;
        if (sc < bs && lineOfSight(world, al.x, al.y - 6, o.x, bodyY(o))) { bs = sc; best = o; }
      });
      if (best) tgt = best;
    }
    if (al.healer) tgt = null;            // healers don't fight
    al.target = tgt;
    let mx = 0, my = 0;
    if (tgt) {
      const d = Math.sqrt(dist2(al.x, al.y, tgt.x, tgt.y)) || 1;
      al.aim = Math.atan2(bodyY(tgt) - (al.y - 6), tgt.x - al.x);
      const los = lineOfSight(world, al.x, al.y - 6, tgt.x, bodyY(tgt));
      if (al.melee) {
        if (d > 12) { mx = (tgt.x - al.x) / d; my = (tgt.y - al.y) / d; }
        if (d < 18 + radiusOf(tgt) && al.atkCd <= 0) {
          al.atkCd = (0.65 + rand() * 0.2) * (1 - CREW_LVL.rate * ((al.lvl || 1) - 1));
          const mw = al.follow ? CREW_WEAPONS.melee[(al.lvl || 1) - 1] : 'claw';
          const asrc = { k: 'a', id: al.id, team: al.team };
          if (mw === 'hammer') {
            // hammer: slams the ground, hits everything around
            const cx = al.x + Math.cos(al.aim) * 12, cy = al.y + Math.sin(al.aim) * 12;
            emit(game, { t: 'slam', o: 'a' + al.id, x: Math.round(cx), y: Math.round(cy), r: 30 });
            forTargets(game, al.team, (o) => { if (dist2(cx, cy, o.x, o.y) < (30 + radiusOf(o)) ** 2) damage(game, o, al.dmg * 1.3, asrc, Math.cos(al.aim) * 160, Math.sin(al.aim) * 160); });
            al.atkCd *= 1.4;
          } else {
            emit(game, { t: 'swing', o: 'a' + al.id, s: 'R', a: +al.aim.toFixed(2), k: mw });
            damage(game, tgt, al.dmg * (mw === 'blade' ? 1.25 : 1), asrc, Math.cos(al.aim) * 90, Math.sin(al.aim) * 90);
          }
        }
      } else if (d > 90 || !los) { mx = (tgt.x - al.x) / d; my = (tgt.y - al.y) / d; }
      if (!al.melee && los && al.atkCd <= 0 && d < 150) {
        al.atkCd = ((al.civ ? 0.45 : al.follow ? 0.7 : 0.9) + rand() * (al.civ ? 0.25 : 0.4)) * (1 - CREW_LVL.rate * ((al.lvl || 1) - 1));
        const gw = al.follow && !al.civ ? CREW_WEAPONS.gun[(al.lvl || 1) - 1] : al.follow ? CREW_WEAPONS.gun[(al.lvl || 1) - 1] : 'pistol';
        const asrc = { k: 'a', id: al.id, team: al.team }, ox = al.x + Math.cos(al.aim) * 6, oy = al.y - 8;
        const shot = (a, dm, sp = 260) => spawnProj(game, { x: ox, y: oy, a, speed: sp, life: 0.7, dmg: dm, team: al.team, kind: al.follow ? 'smart' : 'pulse', src: asrc });
        if (gw === 'smg') { shot(al.aim + (rand() - 0.5) * 0.16, al.dmg * 0.62); al.atkCd *= 0.5; }
        else if (gw === 'shotgun') { for (let k = 0; k < 5; k++) spawnProj(game, { x: ox, y: oy, a: al.aim + (k / 4 - 0.5) * 0.5, speed: 230 + rand() * 50, life: 0.45, dmg: al.dmg * 0.5, team: al.team, kind: 'pellet', src: asrc }); al.atkCd *= 1.35; }
        else if (gw === 'burst') { for (let k = 0; k < 3; k++) shot(al.aim + (rand() - 0.5) * 0.07, al.dmg * 0.6, 250 + k * 25); al.atkCd *= 1.1; }
        else if (gw === 'rail') {
          // rail beam: instant hit on the target
          const x2 = tgt.x, y2 = bodyY(tgt);
          emit(game, { t: 'beam', o: 'a' + al.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), c: '#22e5ff' });
          damage(game, tgt, al.dmg * 2.2, asrc, Math.cos(al.aim) * 120, Math.sin(al.aim) * 120);
          al.atkCd *= 1.8;
        } else shot(al.aim + (rand() - 0.5) * 0.1, al.dmg);
      }
      if (!al.squad && dist2(al.x, al.y, hx, hy) > leash * leash) { mx = (hx - al.x); my = (hy - al.y); const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; al.target = null; }
    } else if (al.squad) {
      const raid = game.raids.find((r) => r.id === al.squad);
      if (raid) {
        let c = corePosOf(game, raid.target);
        // the core is ours to stand on only when the garrison is gone: hunt the stragglers
        if (game.rs[raid.target].garrison > 0) {
          let best = null, bd = Infinity;
          for (const e of game.enemies.values()) if (e.home === raid.target) { const dd = dist2(al.x, al.y, e.x, e.y); if (dd < bd) { bd = dd; best = e; } }
          if (best) c = best;
        }
        const d = Math.sqrt(dist2(al.x, al.y, c.x, c.y)) || 1;
        const hunting = c.k === 'e';
        if (d > 18) {
          let f = coreField(game, raid.target);
          if (hunting) {
            // a path to the straggler (refreshed now and then)
            game.huntF = game.huntF || new Map();
            if (game.huntF.size > 60) game.huntF.clear();
            let hf = game.huntF.get(c.id);
            if (!hf || game.time - hf.t > 1.5) { hf = { f: bfsField(world, Math.floor(c.x / TILE), Math.floor(c.y / TILE), 34), t: game.time }; game.huntF.set(c.id, hf); }
            f = hf.f;
          }
          const dir = fieldDir(world, f, al.x, al.y);
          if (dir && !dir.done) { mx = dir.x; my = dir.y; } else { mx = (c.x - al.x) / d; my = (c.y - al.y) / d; }
          al.aim = Math.atan2(my, mx);
        }
      }
    } else if (guard) {
      const pts = patrolPts(game, al.region);
      if (!defense && pts.length) {
        // the round outside the walls: walk to the next spot, stop, look out at the street, move on
        if (al.pi === undefined || al.pi >= pts.length) { al.pi = (rand() * pts.length) | 0; al.waitT = 0; }
        const pt = pts[al.pi];
        al.px = pt.x; al.py = pt.y;
        const d = Math.sqrt(dist2(al.x, al.y, pt.x, pt.y)) || 1;
        if (d > 10) {
          const dir = fieldDir(world, patrolField(game, al.region, al.pi), al.x, al.y);
          if (dir && !dir.done) { mx = dir.x * 0.6; my = dir.y * 0.6; } else { mx = (pt.x - al.x) / d * 0.6; my = (pt.y - al.y) / d * 0.6; }
          al.aim = Math.atan2(my, mx);
          if ((al.stuckT = (al.stuckT || 0) + (al.moving ? -0.3 : 0.3)) > 6) { al.stuckT = 0; al.pi = (al.pi + 1) % pts.length; }
          if (al.stuckT < 0) al.stuckT = 0;
        } else {
          al.waitT = (al.waitT || 0) + 0.3;
          if ((al.lookT = (al.lookT || 0) - 0.3) <= 0) { al.lookT = 0.9 + rand() * 1.4; al.aim = Math.atan2(pt.y - core.y, pt.x - core.x) + (rand() - 0.5) * 2.2; }
          if (al.waitT > 4 + rand() * 6) { al.waitT = 0; al.pi = (al.pi + (rand() < 0.5 ? 1 : pts.length - 1)) % pts.length; }
        }
      } else {
        // defense (or no room outside): hold the yard around the core
        const C = world.regions[al.region].compound;
        if ((al.patrolT = (al.patrolT || 0) - 0.3) <= 0 || al.ix === undefined) {
          al.patrolT = 4 + rand() * 6;
          for (let k = 0; k < 6; k++) { const x = (C.x + 1.5 + rand() * (C.w - 3)) * TILE, y = (C.y + 1.5 + rand() * (C.h - 3)) * TILE; if (!opaqueAt(world, x, y) && !solidAt(world, x, y)) { al.ix = x; al.iy = y; break; } }
          if (al.ix === undefined) { al.ix = core.x; al.iy = core.y; }
        }
        const d = Math.sqrt(dist2(al.x, al.y, al.ix, al.iy)) || 1;
        if (d > 12) {
          const dc = Math.sqrt(dist2(al.x, al.y, core.x, core.y));
          const dir = dc > 4 * TILE ? fieldDir(world, coreField(game, al.region), al.x, al.y) : null;
          if (dir && !dir.done) { mx = dir.x; my = dir.y; } else { mx = (al.ix - al.x) / d; my = (al.iy - al.y) / d; }
          al.aim = Math.atan2(my, mx);
        }
      }
    } else {
      const d = Math.sqrt(dist2(al.x, al.y, hx, hy));
      const stay = owner ? 26 : 20;
      if (d > stay) {
        const f = owner ? playerField(game, owner) : coreField(game, al.region);
        const dir = f ? fieldDir(world, f, al.x, al.y) : null;
        if (dir && !dir.done && d > 3 * TILE) { mx = dir.x; my = dir.y; } else { mx = (hx - al.x) / d; my = (hy - al.y) / d; }
        al.aim = Math.atan2(my, mx);
      } else if (!owner && al.region >= 0 && (al.patrolT = (al.patrolT || 0) - 0.3) <= 0) {
        // walk the compound: a new spot inside the walls every few seconds
        al.patrolT = 5 + rand() * 9;
        const C = world.regions[al.region].compound;
        for (let k = 0; k < 6; k++) { const x = (C.x + 1.5 + rand() * (C.w - 3)) * TILE, y = (C.y + 1.5 + rand() * (C.h - 3)) * TILE; if (!opaqueAt(world, x, y) && !solidAt(world, x, y)) { al.px = x; al.py = y; break; } }
      }
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

// spots around a compound, a few tiles outside the walls, reachable on foot: the guards' round
function patrolPts(game, i) {
  let pts = game.patrol[i];
  if (pts) return pts;
  const w = game.world, C = w.regions[i].compound;
  const f = coreField(game, i);
  pts = [];
  const ring = (GUARD.ringMin + GUARD.ringMax) / 2;
  const x0 = C.x - ring, x1 = C.x + C.w + ring, y0 = C.y - ring, y1 = C.y + C.h + ring;
  const per = 2 * (x1 - x0 + y1 - y0);
  const n = Math.max(6, Math.min(14, Math.round(per / 9)));
  for (let k = 0; k < n; k++) {
    let t = (k + 0.5) / n * per, x, y;
    if (t < x1 - x0) { x = x0 + t; y = y0; } else if ((t -= x1 - x0) < y1 - y0) { x = x1; y = y0 + t; } else if ((t -= y1 - y0) < x1 - x0) { x = x1 - t; y = y1; } else { t -= x1 - x0; x = x0; y = y1 - t; }
    const o = nearestOpen(w, x * TILE, y * TILE, 4);
    const tx = o.x / TILE, ty = o.y / TILE;
    if (tx > C.x - 0.5 && tx < C.x + C.w + 0.5 && ty > C.y - 0.5 && ty < C.y + C.h + 0.5) continue;
    if (Math.abs(tx - (C.x + C.w / 2)) > C.w / 2 + GUARD.ringMax + 2 || Math.abs(ty - (C.y + C.h / 2)) > C.h / 2 + GUARD.ringMax + 2) continue;
    if (!fieldDir(w, f, o.x, o.y)) continue;
    pts.push({ x: o.x, y: o.y });
  }
  game.patrol[i] = pts;
  return pts;
}
function patrolField(game, i, k) {
  const key = i * 32 + k;
  let f = game.gfields.get(key);
  if (!f) {
    if (game.gfields.size > 160) game.gfields.clear();
    const pt = game.patrol[i][k];
    f = bfsField(game.world, Math.floor(pt.x / TILE), Math.floor(pt.y / TILE), 46);
    game.gfields.set(key, f);
  }
  return f;
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
        if (pr.src && pr.src.k === 'p') stat(game.players.get(pr.src.id), 'hits');
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
      if (p.dead || p.down || p.veh || dist2(p.x, p.y, k.x, k.y) > 14 * 14) continue;
      if (k.type === 'heal' && p.hp >= p.maxHp) continue;
      game.pickups.delete(k.id);
      if (k.type === 'ufo') giveUfoGun(game, p);
      else if (k.type === 'cash') addCash(game, p, k.amount, k.x, k.y - 8);
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
  return BASE_GUARDS + (g ? g.upgrades.count || 0 : 0) + 2 * (rs.up.barracks || 0) + (R.hq ? 2 : 0) + (R.base ? 4 : 0) + (rs.extra || 0);
};
export const extraCapOf = (game, i) => EXTRA_SOLDIERS.base + EXTRA_SOLDIERS.perBarracks * (game.rs[i].up.barracks || 0) + (game.world.regions[i].base ? EXTRA_SOLDIERS.mainBase : 0);

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
      if (d < (2.6 * TILE) ** 2 && !p.veh && !p.down) onCore.set(p.gang, (onCore.get(p.gang) || 0) + 1);
    }
    if (rs.hintT > 0) rs.hintT -= dt;
    if (!isGang(rs.owner)) {
      // ---------------- bot-held region
      const fraid = game.raids.find((r) => r.target === i && r.state === 'active');
      if (near || fraid) {
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
      let enemiesNear = false, defNear = false, raidersNear = 0;
      for (const e of game.enemies.values()) {
        if (dist2(e.x, e.y, core.x, core.y) >= (3.5 * TILE) ** 2) continue;
        enemiesNear = true;
        if (e.team === 'e' && e.faction === rs.owner) defNear = true;
        if (fraid && e.raid === fraid.id) raidersNear++;
      }
      // our squads standing on the core count like players
      for (const al of game.allies.values()) if (al.squad && dist2(al.x, al.y, core.x, core.y) < (2.6 * TILE) ** 2) onCore.set(al.team, (onCore.get(al.team) || 0) + 1);
      if (fraid && fraid.kind === 'f' && raidersNear > 0 && !defNear && rs.garrison <= 0) {
        rs.capBy = 'raid'; rs.capture = Math.min(1, rs.capture + dt * 0.12 * (1 - 0.25 * (rs.up.walls || 0)));
        game.regionVer++;
        if (rs.capture >= 1) { factionTakes(game, i, fraid); continue; }
      }
      const gangsOn = [...onCore.keys()];
      const prev = rs.capture;
      let progressing = false;
      if (gangsOn.length === 1) {
        const g = gangsOn[0];
        const capturable = rs.garrison <= 0 && adjacentTo(game, i, g) && (!R.hq || rs.bossDefeated);
        if (capturable && !enemiesNear) {
          progressing = true;
          if (rs.capBy !== g && rs.capture > 0) rs.capture = Math.max(0, rs.capture - dt * 0.3);
          else { rs.capBy = g; rs.capture = Math.min(1, rs.capture + dt * (0.16 + 0.07 * (onCore.get(g) - 1)) * (1 - 0.2 * (rs.up.walls || 0))); }
        }
      }
      if (!progressing && rs.capBy !== 'raid') rs.capture = Math.max(0, rs.capture - dt * 0.08);
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
      for (const al of game.allies.values()) if (al.squad && al.team !== own && dist2(al.x, al.y, core.x, core.y) < (2.6 * TILE) ** 2) onCore.set(al.team, (onCore.get(al.team) || 0) + 1);
      const rivals = [...onCore.keys()].filter((g) => g !== own);
      let rivalNear = false;
      for (const p of players) if (p.gang !== own && dist2(p.x, p.y, core.x, core.y) < (20 * TILE) ** 2) { rivalNear = true; break; }
      // who is inside the walls? (the guards switch to defense) and is the base under attack? (the alarm)
      const Cw = R.compound;
      const inRect = (o, m) => o.x > (Cw.x - m) * TILE && o.x < (Cw.x + Cw.w + m) * TILE && o.y > (Cw.y - m) * TILE && o.y < (Cw.y + Cw.h + m) * TILE;
      let inside = 0, akind = null, awho = null;
      for (const e of game.enemies.values()) if (!e.leaving && inRect(e, 0.5) && copFoe(game, e, own)) { inside++; if (!akind || e.alien) { akind = e.alien ? 'alien' : e.police ? 'police' : e.raid ? 'raid' : 'enemy'; awho = e.faction; } }
      for (const al of game.allies.values()) if (al.team !== own && !al.hidden && inRect(al, 0.5)) { inside++; if (akind !== 'player') { akind = al.squad ? 'squad' : 'gang'; awho = gangIdx(al.team); } }
      for (const p of players) if (p.gang !== own && !p.down && !p.veh && inRect(p, 0.5)) { inside++; akind = 'player'; awho = p.name; }
      rs.inside = inside; if (inside) rs.insideT = game.time;
      let atk = inside > 0;
      if (!atk && game.time - (rs.hitT ?? -99) < BASE_ALARM.hitMemory) {
        atk = true;
        const h = rs.hitBy || {};
        if (h.k === 'p') { const hp = game.players.get(h.id); akind = 'player'; awho = hp ? hp.name : 'a rival'; }
        else if (h.k === 'e') { const he = game.enemies.get(h.id); akind = he && he.alien ? 'alien' : he && he.police ? 'police' : 'enemy'; awho = he ? he.faction : null; }
        else if (h.k === 'a') { akind = 'gang'; awho = gangIdx(h.team); }
        else akind = 'enemy';
      }
      if (!atk && raid) for (const e of game.enemies.values()) if (e.raid === raid.id && inRect(e, 8)) { atk = true; akind = 'raid'; awho = raid.f; break; }
      if (!atk) for (const al of game.allies.values()) if (al.squad && al.team !== own && inRect(al, 8)) { atk = true; akind = 'squad'; awho = gangIdx(al.team); break; }
      if (atk !== !!rs.atk) { rs.atk = atk; game.regionVer++; }
      if (atk && (!rs.alarmOn || game.time - (rs.alarmT ?? -99) > BASE_ALARM.repeat)) { rs.alarmT = game.time; emit(game, { t: 'battack', r: i, g: own, k: akind, w: awho, base: R.base ? 1 : 0 }); }
      rs.alarmOn = atk;
      // a main base can't be taken while its gang still holds other districts
      const shield = !!R.base && ownedCount(game, own) > 1;
      if (shield !== !!rs.shield) { rs.shield = shield; game.regionVer++; }
      const active = near || !!raid || rivalNear || inside > 0;
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
      if (shield && attacker) {
        attacker = null;
        if (!(rs.hintT > 0)) {
          rs.hintT = 6;
          const og = game.gangs.get(own);
          for (const p of players) if (p.gang !== own && dist2(p.x, p.y, core.x, core.y) < (4 * TILE) ** 2) tell(game, p.id, `SHIELDED: ${og ? og.name : 'this gang'} still holds ${ownedCount(game, own) - 1} other district(s). Take those first to steal their main base.`);
        }
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
  const sq = game.raids.find((r) => r.kind === 'g' && r.target === i && r.f === g);
  if (sq) {
    let n = 0;
    for (const al of [...game.allies.values()]) if (al.squad === sq.id) { game.allies.delete(al.id); n++; }
    rs.guards = Math.max(rs.guards, Math.min(guardCapOf(game, i), n));
    game.raids = game.raids.filter((r) => r !== sq);
    emit(game, { t: 'raidend', r: i, win: true, kind: 'g', g, f: g });
  }
  game.stats.captures++;
  emit(game, { t: 'cap', r: i, f: prevOwner, g, pg: isGang(prevOwner) ? prevOwner : null });
  const core = corePosOf(game, i);
  for (const p of game.players.values()) {
    if (p.gang !== g) continue;
    if (!p.dead && dist2(p.x, p.y, core.x, core.y) < (10 * TILE) ** 2) stat(p, 'captures');
    addCash(game, p, 100 + 60 * R.tier, p.x, p.y - 26);
    addXp(game, p, 40 * R.tier + 30);
    // the people send a soldier to follow whoever took the core
    if (!p.dead && !p.veh && dist2(p.x, p.y, core.x, core.y) < (4 * TILE) ** 2 && followerCount(game, p.id) < FOLLOWER_MAX && !R.base) {
      spawnFollower(game, p, Math.max(1, R.tier));
      emit(game, { t: 'follower', id: p.id, x: p.x, y: p.y, tier: Math.max(1, R.tier) });
    }
  }
  gang.vault += 100;
  if (R.hq && !isGang(prevOwner) && game.mode === 'pvp') gang.vault += 2000;
  checkFactions(game);
  checkHqUnlocks(game);
  checkEndgame(game);
  if (game.raidT > 200) game.raidT = 200;
}

// Changes a district's owner and resets its local state (guards, turrets, upgrades).
// a faction raid took the district: the survivors become its new garrison
function factionTakes(game, i, raid) {
  const prev = game.rs[i].owner;
  setOwner(game, i, raid.f);
  const rs = game.rs[i];
  let n = 0;
  for (const e of game.enemies.values()) if (e.raid === raid.id) { e.raid = null; e.team = 'e'; e.xr = undefined; e.garrison = true; e.home = i; e.state = 'idle'; e.hx = e.x; e.hy = e.y; n++; }
  for (const e of game.enemies.values()) if (e.home === i && e.faction === prev && e.garrison) { e.garrison = false; e.leaving = true; }
  rs.garrison = rs.spawned = n; rs.garrisonMax = Math.max(rs.garrisonMax || 0, n + 4);
  game.raids = game.raids.filter((r) => r !== raid);
  emit(game, { t: 'fcap', r: i, f: raid.f, pf: prev });
  checkFactions(game);
  checkEndgame(game);
}

function setOwner(game, i, owner) {
  const rs = game.rs[i];
  rs.owner = owner; rs.capture = 0; rs.capBy = null;
  rs.up = Object.assign(freshUps(), rs.up || {}); rs.slots = rs.slots || [null, null, null, null];
  rs.extra = 0;
  for (const al of [...game.allies.values()]) if (al.region === i) game.allies.delete(al.id);
  rs.gspawned = 0; rs.guardT = 0;
  if (isGang(owner)) { rs.garrison = 0; rs.spawned = 0; rs.guards = guardCapOf(game, i) - (game.world.regions[i].hq ? 2 : 0); }
  else { rs.guards = 0; rs.spawned = 0; for (const e of game.enemies.values()) if (e.home === i && e.garrison) rs.spawned++; }
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

// an NPC faction is out of the game only when it holds no district at all
function checkFactions(game) {
  for (let f = 0; f < 3; f++) {
    if (game.defeated[f]) continue;
    if (!game.rs.some((r) => r.owner === f)) {
      game.defeated[f] = true;
      for (const r of game.raids) if (r.f === f && r.kind !== 'g') r.t = 0;
      emit(game, { t: 'fdown', f });
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
    if (!game.king && ownedCount(game, g.id) / total >= PVP_WIN_SHARE) { game.victory = g.id; emit(game, { t: 'win', g: g.id, why: 'share' }); return; }
  }
  const beaten = [...game.gangs.values()].some((g) => g.out && !g.into);
  if (game.gangsEver >= 2 && alive.length === 1 && beaten) { game.victory = alive[0].id; emit(game, { t: 'win', g: alive[0].id, why: 'last' }); }
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
  const botRaids = game.raids.filter((r) => !r.kind).length;
  if (game.raidT <= 0) {
    game.raidT = RAID_INTERVAL(maxOwned) * (0.8 + rand() * 0.4);
    if (botRaids < maxRaids + (game.mode === 'pvp' ? 1 : 0)) startRaid(game);
  }
  // the factions fight each other too
  game.ffT = (game.ffT ?? 150) - dt;
  if (game.ffT <= 0) { game.ffT = 140 + rand() * 90; if (!game.raids.some((r) => r.kind === 'f')) startFactionRaid(game); }
  for (const raid of [...game.raids]) {
    raid.t -= dt;
    if (raid.state === 'warn') {
      if (raid.t <= 0) spawnRaid(game, raid);
    } else if (raid.kind && raid.alive <= 0) {
      // a faction raid or a squad got wiped out
      game.raids = game.raids.filter((r) => r !== raid);
      emit(game, { t: 'raidend', r: raid.target, win: false, kind: raid.kind, f: raid.f, g: raid.kind === 'g' ? raid.f : undefined });
      game.regionVer++;
    } else if (raid.kind && (raid.t <= 0 || game.rs[raid.target].owner !== raid.def)) {
      for (const e of [...game.enemies.values()]) if (e.raid === raid.id) game.enemies.delete(e.id);
      for (const al of [...game.allies.values()]) if (al.squad === raid.id) game.allies.delete(al.id);
      game.raids = game.raids.filter((r) => r !== raid);
      if (game.rs[raid.target].owner !== raid.f) emit(game, { t: 'raidend', r: raid.target, retreat: true, kind: raid.kind, f: raid.f, g: raid.kind === 'g' ? raid.f : undefined });
      game.regionVer++;
    } else if (!raid.kind && raid.alive <= 0) {
      game.raids = game.raids.filter((r) => r !== raid);
      const gang = game.gangs.get(raid.gang);
      if (gang) gang.vault += 250;
      for (const p of game.players.values()) if (p.gang === raid.gang) { addXp(game, p, 80); stat(p, 'raidsWon'); }
      game.stats.raidsBeaten++;
      emit(game, { t: 'raidend', r: raid.target, win: true, g: raid.gang });
      game.regionVer++;
    } else if (!raid.kind && (raid.t <= 0 || game.rs[raid.target].owner !== raid.gang)) {
      for (const e of [...game.enemies.values()]) if (e.raid === raid.id) game.enemies.delete(e.id);
      game.raids = game.raids.filter((r) => r !== raid);
      emit(game, { t: 'raidend', r: raid.target, win: true, retreat: true, g: raid.gang });
      game.regionVer++;
    }
  }
}

// an NPC faction attacks a neighboring district of another NPC faction
function startFactionRaid(game) {
  const w = game.world, cands = [];
  for (let i = 0; i < game.rs.length; i++) {
    const own = game.rs[i].owner;
    if (typeof own !== 'number' || own > 2 || game.raids.some((r) => r.target === i)) continue;
    if (w.regions[i].hq && !game.rs[i].bossDefeated && rand() < 0.7) continue;
    for (const n of w.regions[i].neighbors) {
      const o = game.rs[n].owner;
      if (typeof o === 'number' && o < 3 && o !== own && !game.defeated[o]) cands.push({ target: i, src: n, f: o, def: own, w: w.regions[i].king ? 6 : 1 });
    }
  }
  if (!cands.length) return;
  let tot = 0; for (const c of cands) tot += c.w;
  let r = rand() * tot, c = cands[0];
  for (const x of cands) { r -= x.w; if (r <= 0) { c = x; break; } }
  const size = 5 + Math.round(w.regions[c.target].tier * 1.5 + rand() * 3);
  const raid = { id: game.nextId++, kind: 'f', f: c.f, target: c.target, src: c.src, gang: null, def: c.def, xr: c.def, state: 'warn', t: 20, size, alive: 0 };
  game.raids.push(raid);
  emit(game, { t: 'fraid', r: c.target, f: c.f, d: c.def });
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
  const raid = { id: game.nextId++, f: c.f, target: c.target, src: c.src, gang: c.gang, def: c.gang, state: 'warn', t: warn, size, alive: 0 };
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
    const owned = raid.gang ? ownedCount(game, raid.gang) : 4;
    const lieutenant = n < Math.floor(raid.size / 8) && raid.size >= 8;
    const e = spawnEnemy(game, raid.f, lieutenant ? 5 : rollTier(game, R, 0.9 + Math.min(1.6, owned * 0.06)), x, y, raid.src, { raid: raid.id });
    if (lieutenant || (owned > 14 && rand() < 0.3)) { e.stars = 1; e.maxHp = e.hp = Math.round(e.maxHp * 1.3); e.dmg *= 1.15; }
    if (raid.xr !== undefined) { e.team = 'r' + raid.id; e.xr = raid.xr; }
    raid.alive++;
  }
  raid.state = 'active';
  raid.t = 200;
  emit(game, { t: 'raidgo', r: raid.target, f: raid.f, g: raid.gang, kind: raid.kind });
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
    if (c.danceT > 0) {
      c.danceT -= dt;
      if (c.flee <= 0) { c.moving = false; c.svx = c.svy = 0; continue; }
      c.danceT = 0;
    }
    let mx = 0, my = 0, sp = CIV.speed;
    if (c.buyer !== undefined && c.flee <= 0) {
      const rs = game.rs[c.buyer];
      const B = world.regions[c.buyer].compound.boca;
      if (!isGang(rs.owner)) c.buyer = undefined;
      else if (dist2(c.x, c.y, B.x, B.y) < 11 * 11) {
        c.buyT += dt; c.aim = Math.atan2(B.y - c.y - 8, B.x - c.x);
        if (c.buyT > 1.6) {
          const gang = game.gangs.get(rs.owner);
          if (gang) bocaSale(game, c.buyer, gang, Math.min(3, rs.up.boca || 0), true, B.x, B.y - 18);
          c.buyer = undefined; c.leaveT = 30; c.wanderT = 0;
        }
        c.moving = false;
        continue;
      } else {
        const dir = fieldDir(world, bocaField(game, c.buyer), c.x, c.y);
        if (dir) { const l = Math.hypot(dir.x, dir.y) || 1; mx = dir.x / l; my = dir.y / l; } else c.buyer = undefined;
      }
    }
    if (c.leaveT > 0) { c.leaveT -= dt; if (c.leaveT <= 0) { let seen = false; for (const p of game.players.values()) if (dist2(p.x, p.y, c.x, c.y) < (16 * TILE) ** 2) seen = true; if (!seen) { game.civs.delete(c.id); continue; } c.leaveT = 5; } }
    if (c.buyer !== undefined && c.flee <= 0) { /* walking to the boca */ }
    else if (c.flee > 0) {
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
  statDmg(game, src, dmg);
  c.hp -= dmg;
  c.flash = 0.12;
  c.flee = 4; c.fx = c.x - (kx || 1); c.fy = c.y - (ky || 0);
  if (kx || ky) { c.kx += kx; c.ky += ky; }
  emit(game, { t: 'dmg', x: c.x, y: c.y - 20, v: Math.round(dmg), c: 'civ', fy: Math.round(c.y), d: kx || ky ? +Math.atan2(ky, kx).toFixed(2) : undefined });
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
  const r = regionAt(game.world, best.x, best.y);
  const crewFull = followerCount(game, p.id) >= FOLLOWER_MAX;
  if (crewFull && (r < 0 || game.rs[r].owner !== p.gang)) return tell(game, p.id, `Your crew is full (${FOLLOWER_MAX}). In your own turf, extra recruits join the local compound as soldiers.`);
  const rp = repOf(game, p.gang, r);
  if (rp < CIV.repNeed) { best.flee = 3; best.fx = p.x; best.fy = p.y; return tell(game, p.id, `"Sai fora!" The locals don't trust your gang here (respect ${Math.round(rp)}/${CIV.repNeed}). Don't hurt civilians, take the district.`); }
  if (best.flee > 0.5) return tell(game, p.id, 'They are too scared right now.');
  if (crewFull) {
    const rs = game.rs[r];
    if ((rs.extra || 0) >= extraCapOf(game, r)) return tell(game, p.id, `This compound is full of soldiers (${extraCapOf(game, r)} recruits). Buy Barracks for more.`);
    game.civs.delete(best.id);
    rs.extra = (rs.extra || 0) + 1; rs.guards++; game.regionVer++; stat(p, 'recruits');
    changeRep(game, p.gang, r, 2);
    emit(game, { t: 'msg', to: p.id, text: `A local joined ${game.world.regions[r].name} as a soldier (${rs.extra}/${extraCapOf(game, r)} recruits there).`, c: 'good' });
    emit(game, { t: 'recruit', id: p.id, x: best.x, y: best.y, melee: false });
    return;
  }
  game.civs.delete(best.id);
  stat(p, 'recruits');
  const al = spawnFollower(game, p, 1, { civ: best.seed || 1, melee: rand() < 0.45, x: best.x, y: best.y });
  changeRep(game, p.gang, r, 2);
  emit(game, { t: 'recruit', id: p.id, x: al.x, y: al.y, melee: al.melee });
  p.dirty = true;
}

// ------------------------------------------------------------------ cats and dogs
// They wander around the city, sit, sniff around. Gunshots and explosions scare them away. G next to one: bark / meow.
function updatePets(game, dt) {
  game.petT -= dt;
  const w = game.world;
  if (game.petT <= 0) {
    game.petT = 1.3;
    const players = [...game.players.values()].filter((p) => !p.out && !p.dead);
    for (const a of [...game.pets.values()]) if (!players.some((p) => dist2(p.x, p.y, a.x, a.y) < (44 * TILE) ** 2)) game.pets.delete(a.id);
    for (const p of players) {
      if (game.pets.size >= PETS.max) break;
      let n = 0;
      for (const a of game.pets.values()) if (dist2(p.x, p.y, a.x, a.y) < (30 * TILE) ** 2) n++;
      if (n >= PETS.perPlayer) continue;
      const ang = rand() * 6.28, d = (16 + rand() * 10) * TILE;
      const x = p.x + Math.cos(ang) * d, y = p.y + Math.sin(ang) * d;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (tx < 1 || ty < 1 || tx >= w.W - 1 || ty >= w.H - 1) continue;
      const i = ty * w.W + tx;
      if (!w.reach[i] || !CIV_GROUND.has(w.tiles[i])) continue;
      const id = game.nextId++;
      game.pets.set(id, { id, k: 'pet', kind: rand() < 0.55 ? 'dog' : 'cat', seed: (rand() * 100000) | 0, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, r: 3, aim: rand() * 6.28, svx: 0, svy: 0, wanderT: rand() * 2, wx: x, wy: y, flee: 0, fx: 0, fy: 0, sit: false, happyT: 0, moving: false, stuck: 0 });
    }
  }
  for (const a of game.pets.values()) {
    for (let i = game.danger.length - 1; i >= 0; i--) {
      const d = game.danger[i];
      if (game.time - d.t > 1) break;
      if (dist2(a.x, a.y, d.x, d.y) < (11 * TILE * d.w) ** 2) { a.flee = 2.5 + rand() * 1.8; a.fx = d.x; a.fy = d.y; a.happyT = 0; a.sit = false; break; }
    }
    let mx = 0, my = 0, sp = PETS.speed * (a.kind === 'dog' ? 1.15 : 1);
    if (a.happyT > 0) { a.happyT -= dt; a.moving = false; a.svx = a.svy = 0; continue; }
    if (a.flee > 0) {
      a.flee -= dt; a.sit = false;
      const dx = a.x - a.fx, dy = a.y - a.fy, l = Math.hypot(dx, dy) || 1;
      mx = dx / l; my = dy / l; sp = PETS.fleeSpeed;
      if (a.stuck > 0.3) { const an = Math.atan2(my, mx) + (a.id % 2 ? 1.5 : -1.5); mx = Math.cos(an); my = Math.sin(an); }
    } else {
      a.wanderT -= dt;
      if (a.wanderT <= 0) {
        const lazy = a.kind === 'cat' ? 0.55 : 0.35;
        if (rand() < lazy) { a.wx = a.x; a.wy = a.y; a.sit = rand() < 0.7; a.wanderT = 3 + rand() * 6; }
        else { const an = rand() * 6.28, r = (1.5 + rand() * 4) * TILE; a.wx = a.x + Math.cos(an) * r; a.wy = a.y + Math.sin(an) * r; a.sit = false; a.wanderT = 2 + rand() * 4; }
      }
      const dx = a.wx - a.x, dy = a.wy - a.y, l = Math.hypot(dx, dy);
      if (l > 3 && a.stuck < 0.5) { mx = dx / l; my = dy / l; } else if (a.stuck >= 0.5) { a.wanderT = 0; a.stuck = 0; }
    }
    const k = Math.min(1, dt * 9);
    a.svx += (mx - a.svx) * k; a.svy += (my - a.svy) * k;
    if (Math.abs(a.svx) + Math.abs(a.svy) > 0.05) {
      const ox = a.x, oy = a.y;
      moveBox(w, a, a.svx * sp * dt, a.svy * sp * dt, a.r);
      a.moving = Math.abs(a.x - ox) + Math.abs(a.y - oy) > 0.05;
      a.stuck = a.moving ? 0 : a.stuck + dt;
      if (a.moving) a.aim = Math.atan2(a.svy, a.svx);
    } else a.moving = false;
  }
}
// G: a pet close by gets a pat (bark / meow), otherwise talk to the closest local (recruit)
function petOrRecruit(game, p) {
  if (p.dead || p.veh || p.down) return;
  let pet = null, pd = 24 * 24;
  for (const a of game.pets.values()) { const d = dist2(a.x, a.y, p.x, p.y); if (d < pd) { pd = d; pet = a; } }
  let cd = 26 * 26;
  for (const c of game.civs.values()) cd = Math.min(cd, dist2(c.x, c.y, p.x, p.y));
  if (pet && pd <= cd) {
    if (pet.flee > 0.5) return;
    pet.happyT = 2.4; pet.sit = pet.kind === 'cat'; pet.aim = Math.atan2(p.y - pet.y, p.x - pet.x); pet.flee = 0;
    stat(p, 'pets');
    emit(game, { t: 'pet', id: pet.id, kind: pet.kind, x: Math.round(pet.x), y: Math.round(pet.y), by: p.id });
    return;
  }
  return recruitCiv(game, p);
}

// ------------------------------------------------------------------ alien invasion (random event, once or twice a game)
// A flying saucer comes for one player: it beams a squad of ETs down around them, hovers for a while and leaves.
// The saucer can't be hurt. The ETs fight everyone. Whoever kills the last one gets the Varginha Ray.
function updateUfo(game, dt) {
  if (!game.ufo) {
    if (game.ufoN >= game.ufoMax || game.victory) return;
    game.ufoT -= dt;
    if (game.ufoT > 0) return;
    // they come for the strongest player (most evolved / most kills). If that one can't be reached right now
    // (bar, prison, safe at home), they wait a bit, then settle for the strongest one they can reach.
    const power = (p) => p.level * ALIENS.levelW + (p.kills || 0) + (p.pvpKills || 0) * 2;
    const ok = (p) => !p.dead && !p.down && !p.out && p.inBar < 0 && !p.safe;
    const all = [...game.players.values()].filter((p) => !p.out).sort((a, b) => power(b) - power(a));
    if (!all.length) { game.ufoT = 45; return; }
    let v = all[0];
    if (!ok(v)) {
      game.ufoWait = (game.ufoWait || 0) + 15;
      const alt = all.find(ok);
      if (!alt || game.ufoWait < ALIENS.waitStrongest) { game.ufoT = 15; return; }
      v = alt;
    }
    game.ufoWait = 0;
    game.ufo = { id: game.nextId++, state: 'warn', t: ALIENS.warn, x: v.x, y: v.y, victim: v.id, g: v.gang, n: 0, sp: 0 };
    emit(game, { t: 'ufo', s: 'warn', id: v.id, name: v.name, vg: gangIdx(v.gang), x: Math.round(v.x), y: Math.round(v.y) });
    return;
  }
  const u = game.ufo;
  u.t -= dt;
  if (u.state === 'warn') {
    const v = game.players.get(u.victim);
    if (v && !v.dead && v.inBar < 0) { u.x = v.x; u.y = v.y; }
    if (u.t <= 0) {
      u.state = 'beam'; u.t = ALIENS.beamT; u.n = ALIENS.count(game.players.size); u.sp = 0;
      game.alienLeft[u.id] = 0;
      emit(game, { t: 'ufo', s: 'beam', x: Math.round(u.x), y: Math.round(u.y) });
    }
  } else if (u.state === 'beam') {
    const due = Math.min(u.n, Math.ceil(u.n * (1 - Math.max(0, u.t) / ALIENS.beamT)) + 1);
    while (u.sp < due) spawnAlien(game, u, u.sp++);
    if (u.t <= 0) { u.state = 'hover'; u.t = ALIENS.hoverT; }
  } else if (u.state === 'hover') {
    if (u.t <= 0) { u.state = 'leave'; u.t = 3; emit(game, { t: 'ufo', s: 'leave', x: Math.round(u.x), y: Math.round(u.y) }); }
  } else if (u.t <= 0) {
    game.ufo = null; game.ufoN++;
    game.ufoT = ALIENS.again[0] + rand() * (ALIENS.again[1] - ALIENS.again[0]);
  }
  // ETs left behind with nobody around eventually go home
  game.alienChk = (game.alienChk || 0) + dt;
  if (game.alienChk > 2) {
    for (const e of [...game.enemies.values()]) {
      if (!e.alien) continue;
      let near = false;
      for (const p of game.players.values()) if (!p.dead && dist2(p.x, p.y, e.x, e.y) < (45 * TILE) ** 2) { near = true; break; }
      e.farT = near ? 0 : (e.farT || 0) + game.alienChk;
      if (e.farT > 90) { game.enemies.delete(e.id); if (game.alienLeft[e.alien] > 0) game.alienLeft[e.alien]--; }
    }
    game.alienChk = 0;
  }
}
function spawnAlien(game, u, k) {
  const big = u.n >= 10 ? 2 : 1;
  const tier = k === 0 ? 5 : k <= big ? 4 : 2 + ((rand() * 2) | 0);
  const a = rand() * 6.28, r = 16 + rand() * 44;
  const o = nearestOpen(game.world, u.x + Math.cos(a) * r, u.y + Math.sin(a) * r * 0.7, 5);
  const e = spawnEnemy(game, 4, tier, o.x, o.y, -1, {});
  e.team = 'x'; e.alien = u.id; e.victim = u.victim; e.state = 'chase';
  e.maxHp = e.hp = Math.round(e.maxHp * ALIENS.hp * (1 + 0.15 * Math.max(0, game.players.size - 1)));
  e.dmg *= ALIENS.dmg;
  e.atk = tier === 4 ? 'slam' : 'plasma';
  e.speed *= 1.1;
  if (tier === 5) e.stars = 1;
  game.alienLeft[u.id] = (game.alienLeft[u.id] || 0) + 1;
  emit(game, { t: 'beamdown', x: Math.round(e.x), y: Math.round(e.y) });
}
function alienDown(game, e, src) {
  const left = (game.alienLeft[e.alien] || 1) - 1;
  game.alienLeft[e.alien] = left;
  if (left > 0) return;
  delete game.alienLeft[e.alien];
  // the last one: the alien gun is up for grabs
  const killer = src && src.k === 'p' ? game.players.get(src.id) : null;
  if (killer) giveUfoGun(game, killer);
  else { spawnPickup(game, 'ufo', e.x, e.y, 0); const k = game.pickups.get(game.nextId - 1); if (k) k.life = 240; }
  emit(game, { t: 'ufolast', x: Math.round(e.x), y: Math.round(e.y), by: killer ? killer.name : null });
}
function giveUfoGun(game, p) {
  if (!p.armory.ufo) {
    p.armory.ufo = 1; p.dirty = true; game.rosterVer++;
    emit(game, { t: 'msg', text: `${p.name} took the VARGINHA RAY from the ETs!`, c: 'gold' });
    emit(game, { t: 'msg', to: p.id, text: 'Alien arm unlocked! Equip the Varginha Ray at the Armário (QG).', c: 'gold' });
  } else {
    addCash(game, p, 2500, p.x, p.y - 26);
    emit(game, { t: 'msg', to: p.id, text: 'You already have the Varginha Ray. The ET tech sold for R$2500.', c: 'gold' });
  }
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

// ------------------------------------------------------------------ grenades
function throwGrenade(game, p, a) {
  const k = a.k;
  if (!GRENADES[k] || p.dead || p.down || p.inBar >= 0 || (p.veh && p.seat === 0)) return;
  p.gren = p.gren || {};
  if (!(p.gren[k] > 0)) return tell(game, p.id, `No ${GRENADES[k].name} grenades. Buy them at the Arsenal.`);
  if (game.time < (p.grenT || 0)) return;
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
  stat(p, 'gren');
  p.gren[k]--; p.grenT = game.time + GREN_CD; p.dirty = true;
  let dx = a.x - p.x, dy = a.y - p.y;
  const d = Math.hypot(dx, dy) || 1;
  const L = Math.min(GREN_RANGE, d);
  const len = rayCast(game.world, p.x, p.y - 8, Math.atan2(dy, dx), L);
  const x1 = p.x + dx / d * Math.max(8, len - 4), y1 = p.y + dy / d * Math.max(8, len - 4);
  const T = 0.25 + Math.hypot(x1 - p.x, y1 - p.y) / 190;
  const gr = { id: game.nextId++, k, x0: p.x, y0: p.y - 8, x1, y1, x: p.x, y: p.y, t: 0, T, team: p.gang, src: { k: 'p', id: p.id, team: p.gang }, mult: p.dmgMult, stuck: null, fuse: 0 };
  game.grenades.push(gr);
  crime(game, p, WANTED.shotSeen * 2, p.x, p.y, false, 'shot');
  emit(game, { t: 'gthrow', id: gr.id, k, x: Math.round(gr.x0), y: Math.round(gr.y0), x2: Math.round(x1), y2: Math.round(y1), T: +T.toFixed(2), o: 'p' + p.id });
}

function updateGrenades(game, dt) {
  const keep = [];
  for (const gr of game.grenades) {
    gr.t += dt;
    if (gr.stuck) {
      // stuck to someone: ride along until the fuse burns out
      const o = gr.stuck;
      if (o && (o.hp > 0)) { gr.x = o.x; gr.y = o.y; }
      gr.fuse -= dt;
      if (gr.fuse <= 0) { detonate(game, gr); continue; }
      keep.push(gr); continue;
    }
    if (gr.fuse > 0) { gr.fuse -= dt; if (gr.fuse <= 0) { detonate(game, gr); continue; } keep.push(gr); continue; }
    const u = Math.min(1, gr.t / gr.T);
    gr.x = gr.x0 + (gr.x1 - gr.x0) * u; gr.y = gr.y0 + 8 + (gr.y1 - gr.y0 - 8) * u;
    if (gr.k === 'impact' || gr.k === 'sticky') {
      let hit = null;
      if (u > 0.15) forTargets(game, gr.team, (o) => { if (!hit && dist2(gr.x, gr.y, o.x, o.y) < (radiusOf(o) + 6) ** 2) hit = o; });
      if (hit) {
        if (gr.k === 'impact') { detonate(game, gr); continue; }
        gr.stuck = hit; gr.fuse = 1.4;
        emit(game, { t: 'gstick', id: gr.id, x: Math.round(hit.x), y: Math.round(hit.y) });
        keep.push(gr); continue;
      }
    }
    if (u >= 1) {
      if (gr.k === 'sticky') { gr.fuse = 1.4; keep.push(gr); continue; }
      detonate(game, gr); continue;
    }
    keep.push(gr);
  }
  game.grenades = keep;
  // smoke clouds and fire on the ground
  game.smokes = game.smokes.filter((c) => (c.t -= dt) > 0);
  for (const f of game.fires) {
    f.t -= dt; f.tick = (f.tick || 0) + dt;
    if (f.tick >= 0.5) {
      f.tick = 0;
      forHits(game, f.team, (o) => {
        if (dist2(f.x, f.y, o.x, o.y) > (f.r + radiusOf(o)) ** 2) return;
        damage(game, o, 7 * f.mult, f.src);
        if (o.k === 'e') { o.burnT = 2; o.burnDps = 6; o.burnSrc = f.src; }
        else if (o.k === 'p') { o.burnT = Math.max(o.burnT || 0, 1.5); o.burnDps = 5; o.burnSrc = f.src; }
      });
    }
  }
  game.fires = game.fires.filter((f) => f.t > 0);
}

function detonate(game, gr) {
  const x = gr.x, y = gr.y;
  emit(game, { t: 'gboom', id: gr.id, k: gr.k, x: Math.round(x), y: Math.round(y) });
  const near = (r, fn) => forTargets(game, gr.team, (o) => { if (dist2(x, y, o.x, o.y) < (r + radiusOf(o)) ** 2) fn(o); });
  if (gr.k === 'impact' || gr.k === 'sticky') explode(game, x, y, gr.k === 'sticky' ? 42 : 50, (gr.k === 'sticky' ? 85 : 72) * gr.mult, gr.team, gr.src);
  else if (gr.k === 'flash') {
    near(84, (o) => {
      if (o.k === 'e' && !o.boss) o.stunT = Math.max(o.stunT || 0, 3);
      else if (o.k === 'e') o.stunT = Math.max(o.stunT || 0, 1);
      else if (o.k === 't') o.stunT = 2;
      else if (o.k === 'p') emit(game, { t: 'flashed', id: o.id, to: o.id, x, y });
    });
  } else if (gr.k === 'smoke') game.smokes.push({ x, y, r: 64, t: 8 });
  else if (gr.k === 'emp') {
    near(86, (o) => {
      if (o.k === 'e') { if (isMech(o.faction, o.tier, o.boss)) { o.stunT = Math.max(o.stunT || 0, 4); damage(game, o, 60 * gr.mult, gr.src); } else o.stunT = Math.max(o.stunT || 0, 0.8); }
      else if (o.k === 't') { o.stunT = 5; damage(game, o, 50 * gr.mult, gr.src); }
      else if (o.k === 'v') { o.charge = Math.max(0, o.charge - 45); }
    });
    for (const v of game.vehicles.values()) if (dist2(x, y, v.x, v.y) < 86 * 86) v.charge = Math.max(0, v.charge - 25);
  } else if (gr.k === 'fire') game.fires.push({ x, y, r: 44, t: 6, team: gr.team, src: gr.src, mult: gr.mult });
}

// smoke clouds block sight lines
export function smokeBlocks(game, x0, y0, x1, y1) {
  for (const c of game.smokes) {
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((c.x - x0) * dx + (c.y - y0) * dy) / l2));
    const px = x0 + dx * u, py = y0 + dy * u;
    if ((px - c.x) ** 2 + (py - c.y) ** 2 < c.r * c.r * 0.7) return true;
  }
  return false;
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
    spend(p, I.price); p.belt[slot] = a.item; p.dirty = true; stat(p, 'drinks');
    emit(game, { t: 'buy', to: p.id, id: p.id, text: `${I.name} → slot ${slot + 1}` });
  }
}

// ------------------------------------------------------------------ police
// Crimes seen by civilians raise a player's heat (100 = 1 star). Police respond in patrol cars.
function witnesses(game, x, y) {
  const r2 = (WANTED.witnessRange * TILE) ** 2;
  for (const c of game.civs.values()) if (dist2(c.x, c.y, x, y) < r2) return true;
  for (const e of game.enemies.values()) if (e.police && dist2(e.x, e.y, x, y) < r2) return true;
  for (const c of game.pcars.values()) if (c.cruise && dist2(c.x, c.y, x, y) < r2) return true;
  return false;
}
function crime(game, p, amount, x, y, seen = false, kind = '') {
  if (!p || p.dead || p.inBar >= 0) return;
  if (kind === 'shot' && p.safe) return;                                // target practice at home
  if (p.copLevel > 0 && (kind === 'shot' || kind === 'cop')) return;   // fighting the response doesn't make it bigger
  if (!seen && !witnesses(game, x ?? p.x, y ?? p.y)) return;
  const before = Math.floor(p.heat / 100);
  if (p.copLevel > 0) amount *= 0.5;
  if (kind === 'cop' && p.heat < 100) amount = Math.max(amount, 100 - p.heat);   // attacking a cop: wanted right away
  p.heat = Math.min(500, p.heat + amount);
  const after = Math.floor(p.heat / 100);
  if (p.lost && after > 0) { p.lost = false; p.escapeT = 0; p.dirty = true; emit(game, { t: 'wanted', id: p.id, stars: after, why: 'found', to: p.id }); return; }
  if (after > before) { p.dirty = true; emit(game, { t: 'wanted', id: p.id, stars: after, to: p.id }); }
}
// a cop (or a cruiser) recognized a wanted player the police had lost: the chase is back on
function spotted(game, p) {
  if (!p || !p.lost || p.heat < 100) return;
  p.lost = false; p.escapeT = 0; p.dirty = true;
  emit(game, { t: 'wanted', id: p.id, stars: Math.floor(p.heat / 100), why: 'spotted', to: p.id });
}
// the cops lost you: the ones sent after you go home, new waves pause. The stars stay and fade slowly.
function loseCops(game, p, why) {
  p.lost = true; p.copLevel = 0; p.escapeT = 0; p.reinfT = undefined; p.dirty = true;
  for (const e of game.enemies.values()) {
    if (e.police === p.id) { e.leaving = true; e.target = null; }
    else if (e.patrol && e.target && (e.target.id === p.id || (e.target.k === 'v' && e.target.id === p.veh))) e.target = null;
  }
  for (const c of game.pcars.values()) if (c.pid === p.id && c.state === 'in') c.state = 'out';
  for (const h of game.helis.values()) if (h.pid === p.id) h.state = 'out';
  if (why) emit(game, { t: 'wanted', id: p.id, stars: Math.floor(p.heat / 100), why, to: p.id });
}
// is this damage coming from the police? (cops cuff you instead of killing you)
function isCopSrc(game, src) {
  if (!src) return false;
  if (src.k === 'h' || src.cop) return true;
  if (src.k === 'e') { const e = game.enemies.get(src.id); return !!(e && e.police); }
  return false;
}
// police only fight the gang of whoever they're after (patrol cops on their round are left alone)
function copFoe(game, e, team) {
  if (!e.police) return true;
  const t = e.target;
  let pid = e.police !== 'patrol' ? e.police : null;
  if (!pid && t) {
    if (t.k === 'p') pid = t.id;
    else if (t.k === 'v') { for (const p of game.players.values()) if (p.veh === t.id) { pid = p.id; break; } }
    else if (t.k === 'a') { const a = game.allies.get(t.id); return !!a && a.team === team; }
  }
  const p = pid ? game.players.get(pid) : null;
  return !!p && p.gang === team;
}
function crimeBy(game, src, amount, x, y, seen = false, kind = '') {
  if (!src) return;
  if (src.k === 'p') crime(game, game.players.get(src.id), amount, x, y, seen, kind);
  else if (src.k === 'a') { const al = game.allies.get(src.id); if (al && al.follow) crime(game, game.players.get(al.follow), amount * 0.5, x, y, seen, kind); }
}

function clearWanted(game, p, why) {
  p.heat = 0; p.copLevel = 0; p.escapeT = 0; p.lost = false; p.reinfT = undefined; p.dirty = true;
  for (const e of game.enemies.values()) {
    if (e.police === p.id) { e.leaving = true; e.target = null; }
    else if (e.patrol && e.target && (e.target.id === p.id || (e.target.k === 'v' && e.target.id === p.veh))) e.target = null;
  }
  for (const c of game.pcars.values()) if (c.pid === p.id && c.state === 'in') c.state = 'out';
  for (const h of game.helis.values()) if (h.pid === p.id) h.state = 'out';
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
// ------------------------------------------------------------------ police helicopters (untouchable, they leave after a while)
function spawnHeli(game, p, kind) {
  const a = rand() * 6.28, W = game.world;
  const x = Math.max(TILE, Math.min(W.W * TILE - TILE, p.x + Math.cos(a) * 30 * TILE)), y = Math.max(TILE, Math.min(W.H * TILE - TILE, p.y + Math.sin(a) * 30 * TILE));
  const h = { id: game.nextId++, pid: p.id, kind, x, y, ox: x, oy: y, state: 'in', t: HELI.attackT, ang: a + Math.PI, aim: 0, fireT: 1, shots: 0 };
  game.helis.set(h.id, h);
  emit(game, { t: 'heli', id: p.id, k: kind, x: p.x, y: p.y, to: p.id });
}
function updateHelis(game, dt) {
  for (const h of [...game.helis.values()]) {
    const p = game.players.get(h.pid);
    if (!p || p.dead || p.copLevel <= 0 || p.safe || p.inBar >= 0) if (h.state !== 'out') h.state = 'out';
    const sp = HELI.speed * dt;
    if (h.state === 'out') {
      const dx = h.ox - h.x, dy = h.oy - h.y, d = Math.hypot(dx, dy);
      if (d < sp + 2) { game.helis.delete(h.id); continue; }
      h.x += dx / d * sp; h.y += dy / d * sp; h.aim = Math.atan2(dy, dx);
      continue;
    }
    const tx = p.x, ty = p.y;
    if (h.state === 'in') {
      const dx = tx - h.x, dy = ty - h.y, d = Math.hypot(dx, dy);
      h.aim = Math.atan2(dy, dx);
      if (d < HELI.radius + 10) { h.state = 'atk'; h.ang = Math.atan2(h.y - ty, h.x - tx); }
      else { h.x += dx / d * sp; h.y += dy / d * sp; }
      continue;
    }
    // circle the target and open fire
    h.t -= dt;
    if (h.t <= 0) { h.state = 'out'; continue; }
    h.ang += dt * (h.kind === 'mg' ? 0.55 : 0.35);
    const gx = tx + Math.cos(h.ang) * HELI.radius, gy = ty + Math.sin(h.ang) * HELI.radius * 0.8;
    h.x += (gx - h.x) * Math.min(1, dt * 2); h.y += (gy - h.y) * Math.min(1, dt * 2);
    h.aim = Math.atan2(ty - h.y, tx - h.x);
    h.fireT -= dt;
    if (h.fireT > 0 || p.down) continue;
    const src = { k: 'h', id: h.id, team: 'e' };
    if (h.kind === 'mg') {
      const M = HELI.mg;
      h.shots++;
      h.fireT = h.shots % M.burst === 0 ? M.pause : M.cd;
      const a = h.aim + (rand() - 0.5) * 0.18;
      spawnProj(game, { x: h.x, y: h.y - 6, a, speed: 360, life: 0.8, dmg: M.dmg, team: 'e', kind: 'ebullet', src });
      emit(game, { t: 'shot', i: 'h' + h.id, x: Math.round(h.x), y: Math.round(h.y - 6), a: +a.toFixed(3), s: 360, l: 0.8, k: 'ebullet', tm: 'e', o: 'h' + h.id });
    } else {
      const M = HELI.rocket;
      h.fireT = M.cd;
      spawnProj(game, { x: h.x, y: h.y - 6, a: h.aim, speed: 210, life: 1.6, dmg: M.dmg, team: 'e', kind: 'erocket', src, r: 4, aoe: M.aoe });
      emit(game, { t: 'shot', i: 'h' + h.id, x: Math.round(h.x), y: Math.round(h.y - 6), a: +h.aim.toFixed(3), s: 210, l: 1.6, k: 'erocket', tm: 'e', o: 'h' + h.id });
    }
  }
}

// ------------------------------------------------------------------ civilian flying cars (steal them with V)
function updateCivCars(game, dt) {
  game.civCarT = (game.civCarT || 0) - dt;
  const W = game.world;
  if (game.civCarT <= 0) {
    game.civCarT = 2;
    const players = [...game.players.values()].filter((p) => !p.out);
    let total = 0;
    for (const v of game.vehicles.values()) if (v.civ) {
      if (!players.some((p) => dist2(p.x, p.y, v.x, v.y) < (55 * TILE) ** 2)) game.vehicles.delete(v.id); else total++;
    }
    for (const p of players) {
      if (total >= CIV_CARS.max) break;
      let n = 0;
      for (const v of game.vehicles.values()) if (v.civ && dist2(p.x, p.y, v.x, v.y) < (40 * TILE) ** 2) n++;
      if (n >= CIV_CARS.perPlayer) continue;
      const a = rand() * 6.28, d = (24 + rand() * 10) * TILE;
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      if (x < TILE * 2 || y < TILE * 2 || x > (W.W - 2) * TILE || y > (W.H - 2) * TILE) continue;
      const v = spawnVehicle(game, rand() < 0.6 ? 'car' : 'moto', x, y);
      if (!v) continue;
      v.civ = 1 + ((rand() * 9999) | 0); v.flying = true; v.charge = 100; v.team = null;
      v.civSpeed = CIV_CARS.speed[0] + rand() * (CIV_CARS.speed[1] - CIV_CARS.speed[0]);
      pickCivDest(game, v);
      total++;
    }
  }
  for (const v of game.vehicles.values()) {
    if (!v.civ) continue;
    const dx = v.tx - v.x, dy = v.ty - v.y, d = Math.hypot(dx, dy), sp = v.civSpeed * dt;
    if (d < sp + 4) { pickCivDest(game, v); continue; }
    v.x += dx / d * sp; v.y += dy / d * sp;
  }
}
function pickCivDest(game, v) {
  const W = game.world, list = W.roadTiles;
  for (let k = 0; k < 10; k++) {
    const i = list[(rand() * list.length) | 0];
    const x = (i % W.W + 0.5) * TILE, y = ((i / W.W | 0) + 0.5) * TILE;
    const d = Math.hypot(x - v.x, y - v.y);
    if (d > 20 * TILE && d < 70 * TILE) { v.tx = x; v.ty = y; return; }
  }
  v.tx = v.x + (rand() - 0.5) * 40 * TILE; v.ty = v.y + (rand() - 0.5) * 40 * TILE;
  v.tx = Math.max(TILE * 2, Math.min((W.W - 2) * TILE, v.tx)); v.ty = Math.max(TILE * 2, Math.min((W.H - 2) * TILE, v.ty));
}

// ------------------------------------------------------------------ street patrols (police on the streets even when nobody is wanted)
// A few cops walk the sidewalks and a couple of cruisers fly around each player. A cop who sees a crime adds stars
// at once and joins in. A cop or cruiser who recognizes a wanted player the police had lost restarts the chase.
function updatePatrol(game, dt) {
  const W = game.world;
  game.patT = (game.patT || 0) - dt;
  const players = [...game.players.values()].filter((p) => !p.out && !p.dead && p.inBar < 0);
  if (game.patT <= 0) {
    game.patT = 1.5;
    let cops = 0;
    for (const e of [...game.enemies.values()]) {
      if (!e.patrol) continue;
      if (!players.some((p) => dist2(p.x, p.y, e.x, e.y) < (46 * TILE) ** 2)) { game.enemies.delete(e.id); continue; }
      cops++;
    }
    const inCompound = (tx, ty) => { const r = W.region[ty * W.W + tx]; const C = r >= 0 ? W.regions[r].compound : null; return !!C && tx >= C.x - 1 && ty >= C.y - 1 && tx <= C.x + C.w && ty <= C.y + C.h; };
    for (const p of players) {
      if (cops >= PATROL.maxCops) break;
      let n = 0;
      for (const e of game.enemies.values()) if (e.patrol && dist2(p.x, p.y, e.x, e.y) < (30 * TILE) ** 2) n++;
      if (n >= PATROL.cops) continue;
      for (let tries = 0; tries < 6; tries++) {
        const a = rand() * 6.28, d = (18 + rand() * 8) * TILE;
        const tx = Math.floor((p.x + Math.cos(a) * d) / TILE), ty = Math.floor((p.y + Math.sin(a) * d) / TILE);
        if (tx < 2 || ty < 2 || tx >= W.W - 2 || ty >= W.H - 2) continue;
        const i = ty * W.W + tx;
        if (!W.reach[i] || !CIV_GROUND.has(W.tiles[i]) || inCompound(tx, ty)) continue;
        const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
        const e = spawnEnemy(game, 3, rand() < 0.75 ? 1 : 2, x, y, -1, {});
        e.police = 'patrol'; e.patrol = true; e.atk = POLICE_ATK[e.tier]; e.hx = x; e.hy = y; e.state = 'idle';
        e.maxHp = e.hp = Math.round(e.maxHp * 1.5); e.dmg *= 1.35;
        cops++;
        break;
      }
    }
    let cars = 0;
    for (const c of [...game.pcars.values()]) {
      if (!c.cruise) continue;
      if (!players.some((p) => dist2(p.x, p.y, c.x, c.y) < (60 * TILE) ** 2)) { game.pcars.delete(c.id); continue; }
      cars++;
    }
    for (const p of players) {
      if (cars >= PATROL.maxCars) break;
      let n = 0;
      for (const c of game.pcars.values()) if (c.cruise && dist2(p.x, p.y, c.x, c.y) < (40 * TILE) ** 2) n++;
      if (n >= PATROL.cars) continue;
      const a = rand() * 6.28, d = (26 + rand() * 10) * TILE;
      const x = Math.max(TILE * 2, Math.min((W.W - 2) * TILE, p.x + Math.cos(a) * d)), y = Math.max(TILE * 2, Math.min((W.H - 2) * TILE, p.y + Math.sin(a) * d));
      const c = { id: game.nextId++, pid: null, cruise: true, x, y, ox: x, oy: y, tx: x, ty: y, units: [], state: 'cruise', t: 0, dir: 0 };
      pickCivDest(game, c);
      game.pcars.set(c.id, c);
      cars++;
    }
  }
  const spot2 = (PATROL.spot * TILE) ** 2;
  for (const c of game.pcars.values()) {
    if (!c.cruise) continue;
    const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy), sp = PATROL.carSpeed * dt;
    if (d < sp + 4) { pickCivDest(game, c); continue; }
    c.x += dx / d * sp; c.y += dy / d * sp;
    c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 1) : (dy > 0 ? 0 : 3);
    for (const p of players) if (p.lost && dist2(p.x, p.y, c.x, c.y) < spot2 && !buff(p, 'ghost', 0)) spotted(game, p);
  }
}

// ------------------------------------------------------------------ Rei da Boca: whoever holds the BOCA KING racks up time
function updateKing(game, dt) {
  if (!game.king || game.victory) return;
  const k = game.world.kingId;
  const owner = game.rs[k].owner;
  const key = String(owner);
  if (game.kingOwner === undefined) game.kingOwner = key;
  if (game.kingOwner !== key) { game.kingOwner = key; game.kingMoved = true; emit(game, { t: 'king', r: k, o: owner }); }
  // the faction that starts with it gets no time until someone has taken it at least once
  if (!game.kingMoved) return;
  game.kingHold[key] = (game.kingHold[key] || 0) + dt;
  if (game.kingHold[key] >= game.kingGoal) {
    game.victory = isGang(owner) ? owner : 'f' + owner;
    emit(game, { t: 'win', g: isGang(owner) ? owner : undefined, f: isGang(owner) ? undefined : owner, why: 'king' });
  }
}

function updatePolice(game, dt) {
  // patrol cars: fly in, drop cops, fly away
  for (const c of [...game.pcars.values()]) {
    if (c.cruise) continue;
    const sp = 230 * dt;
    if (c.state === 'in') {
      const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy);
      if (d < sp + 2) {
        c.state = 'drop'; c.t = 0.8;
        const wp = game.players.get(c.pid);
        const st = wp ? Math.max(1, Math.min(5, Math.floor(wp.heat / 100))) : 1;
        for (const tier of c.units) {
          const o = nearestOpen(game.world, c.tx + (rand() - 0.5) * 30, c.ty + (rand() - 0.5) * 30, 5);
          const e = spawnEnemy(game, 3, tier, o.x, o.y, -1, {});
          e.police = c.pid; e.state = 'chase'; e.target = { k: 'p', id: c.pid }; e.atk = POLICE_ATK[tier]; e.hx = o.x; e.hy = o.y;
          // every star makes them tougher
          e.maxHp = e.hp = Math.round(e.maxHp * 1.5 * (1 + WANTED.starHp * (st - 1))); e.dmg *= 1.35 * (1 + WANTED.starDmg * (st - 1)); e.speed *= 1.1 + 0.03 * (st - 1);
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
    if (p.dead || p.out || p.inBar === JAIL_ID) continue;
    const stars = Math.floor(p.heat / 100);
    if (p.lost) {
      // they lost you: the stars fade slowly while nobody sees you (the cops wait outside bars)
      if (p.inBar < 0) p.heat = Math.max(0, p.heat - WANTED.lostDecay * dt);
      const now = Math.floor(p.heat / 100);
      if (now < stars) { p.dirty = true; emit(game, { t: 'wanted', id: p.id, stars: now, why: now ? 'drop' : 'faded', to: p.id }); }
      if (now <= 0) p.lost = false;
      continue;
    }
    if (stars > p.copLevel && p.inBar < 0) {
      const prev = p.copLevel ? POLICE_WAVES[p.copLevel].length : 0;
      dispatchPolice(game, p, POLICE_WAVES[stars].slice(prev));
      if (stars >= 4 && p.copLevel < 4) { spawnHeli(game, p, 'mg'); p.heliT = HELI.back; }
      if (stars >= 5 && p.copLevel < 5) spawnHeli(game, p, 'rocket');
      p.copLevel = stars; p.copSeen = true; p.dirty = true;
    }
    if (p.copLevel >= 4 && !p.safe && p.inBar < 0) {
      p.heliT = (p.heliT ?? HELI.back) - dt;
      if (p.heliT <= 0 && ![...game.helis.values()].some((h) => h.pid === p.id)) { p.heliT = HELI.back; spawnHeli(game, p, p.copLevel >= 5 && rand() < 0.5 ? 'rocket' : 'mg'); }
    }
    if (p.copLevel <= 0) { if (p.heat > 0 && !p.safe) p.heat = Math.max(0, p.heat - WANTED.decay * dt); continue; }
    // the chase: killing the cops doesn't end it (more come). Get away from them for a while and they lose you.
    let cops = 0, near = false;
    const r2 = (WANTED.escapeRange * TILE) ** 2;
    for (const e of game.enemies.values()) {
      if (e.leaving || !e.police) continue;
      const mine = e.police === p.id || (e.target && (e.target.id === p.id && e.target.k === 'p' || (e.target.k === 'v' && e.target.id === p.veh)));
      if (!mine) continue;
      cops++;
      if (dist2(e.x, e.y, p.x, p.y) < r2) near = true;
    }
    const incoming = [...game.pcars.values()].some((c) => c.pid === p.id && c.state === 'in');
    const heliOn = [...game.helis.values()].some((h) => h.pid === p.id && h.state === 'atk');
    if (!incoming && cops === 0) {
      // every cop sent after you is down: reinforcements are on their way
      const st = Math.max(1, Math.min(5, stars));
      if (p.reinfT === undefined) { p.reinfT = WANTED.reinforce[st]; emit(game, { t: 'wanted', id: p.id, stars: st, why: 'reinf', to: p.id }); }
      p.reinfT -= dt;
      if (p.reinfT <= 0 && p.inBar < 0) { p.reinfT = undefined; dispatchPolice(game, p, POLICE_WAVES[st]); p.escapeT = 0; }
    } else p.reinfT = undefined;
    if (p.inBar >= 0 || p.safe) continue;             // hiding in a bar: they wait outside
    if ((!near && !heliOn) || buff(p, 'ghost', 0)) {
      p.escapeT += dt;
      if (p.escapeT >= WANTED.escapeTime) loseCops(game, p, 'lost');
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
// emote styles: 0 passinho, 1 crip walk, 2 rebolado, 3 "6 7!" (next to civilians), 4 praying (next to a priest)
function startEmote(game, p) {
  if (p.dead || p.down || p.veh || p.emoteT > 0) return;
  let kind = (rand() * 3) | 0;
  let civs = [];
  if (p.inBar < 0) {
    const ch = churchNear(game, p);
    if (ch) {
      if (game.time < (p.prayCd || 0)) return tell(game, p.id, `Padre: "Come back a bit later, my child." (${Math.ceil(p.prayCd - game.time)}s)`, 'info');
      return startPrayer(game, p, ch);
    }
    const r2 = (AURA.range * TILE) ** 2;
    for (const c of game.civs.values()) if (c.flee <= 0.5 && c.buyer === undefined && dist2(c.x, c.y, p.x, p.y) < r2) civs.push(c);
    if (civs.length) kind = 3;
  }
  p.emoteT = 3.2; p.emote = kind;
  emit(game, { t: 'emote', id: p.id, e: p.emote, x: p.x, y: p.y });
  // the crew dances with you (if nobody is shooting at them)
  for (const al of game.allies.values()) if (al.follow === p.id && !al.hidden && !(al.target && alive(game, al.target) && dist2(al.x, al.y, al.target.x, al.target.y) < (8 * TILE) ** 2)) { al.emoteT = 3.2; al.emote = p.emote; al.mvx = al.mvy = 0; }
  if (kind === 3) farmAura(game, p, civs);
}
// "farmando aura": the locals dance along, and a gang they don't like gets some respect back (up to neutral)
function farmAura(game, p, civs) {
  for (const c of civs) { c.danceT = 3.4; c.wanderT = 1; c.aim = Math.atan2(p.y - c.y, p.x - c.x); }
  const r = regionAt(game.world, p.x, p.y);
  let gain = 0;
  if (r >= 0 && isGang(p.gang) && game.time >= (p.auraT || 0)) {
    p.auraT = game.time + AURA.cooldown;
    const raw = game.rep[p.gang + ':' + r] ?? CIV.repStart;
    if (raw < CIV.repStart) {
      gain = Math.min(CIV.repStart - raw, AURA.maxPer, AURA.perCiv * civs.length);
      changeRep(game, p.gang, r, gain);
      stat(p, 'aura', gain);
    }
  }
  emit(game, { t: 'aura', id: p.id, x: Math.round(p.x), y: Math.round(p.y), n: civs.length, gain: Math.round(gain), rep: r >= 0 ? Math.round(repOf(game, p.gang, r)) : 0, need: CIV.repNeed, full: r >= 0 && (game.rep[p.gang + ':' + r] ?? CIV.repStart) >= CIV.repStart, rn: r >= 0 ? game.world.regions[r].name : '', civs: civs.slice(0, 12).map((c) => c.id) });
}

// ------------------------------------------------------------------ churches: pray with your crew
function churchNear(game, p) {
  for (const ch of game.world.churches || []) if (dist2(ch.px, ch.py, p.x, p.y) < (3 * TILE) ** 2) return ch;
  return null;
}
function startPrayer(game, p, ch) {
  p.emoteT = CHURCH.prayT; p.emote = 4; p.prayT = CHURCH.prayT;
  emit(game, { t: 'emote', id: p.id, e: 4, x: p.x, y: p.y });
  emit(game, { t: 'pray', id: p.id, name: p.name, x: Math.round(ch.px), y: Math.round(ch.py), d: CHURCH.prayT, ch: ch.id });
  for (const al of game.allies.values()) if (al.follow === p.id && !al.hidden && dist2(al.x, al.y, p.x, p.y) < (CHURCH.range * TILE) ** 2) { al.emoteT = CHURCH.prayT; al.emote = 4; al.mvx = al.mvy = 0; }
}
function stopPrayer(game, p) {
  p.prayT = 0; p.emoteT = 0;
  for (const al of game.allies.values()) if (al.follow === p.id && al.emote === 4) al.emoteT = 0;
  emit(game, { t: 'prayx', id: p.id });
}
function finishPrayer(game, p) {
  p.prayCd = game.time + CHURCH.cooldown;
  stat(p, 'prayers');
  const h = Math.round(p.maxHp * CHURCH.heal);
  p.hp = Math.min(p.maxHp, p.hp + h);
  emit(game, { t: 'dmg', x: p.x, y: p.y - 22, v: h, c: 'heal' });
  const crew = [];
  for (const al of game.allies.values()) {
    if (al.follow !== p.id || al.hidden || dist2(al.x, al.y, p.x, p.y) > (CHURCH.range * TILE) ** 2) continue;
    crew.push(al);
    const ah = Math.round(al.maxHp * CHURCH.heal);
    al.hp = Math.min(al.maxHp, al.hp + ah);
    emit(game, { t: 'dmg', x: al.x, y: al.y - 20, v: ah, c: 'heal' });
  }
  // a small chance the faith gets one of them: they put the gun down and become a healer
  let healer = null;
  const have = [...game.allies.values()].filter((a) => a.follow === p.id && a.healer).length;
  const cands = crew.filter((a) => !a.healer);
  if (cands.length && have < CHURCH.healerMax && rand() < CHURCH.healerChance) {
    healer = pick(cands);
    healer.healer = true; healer.melee = false; healer.healT = CHURCH.healEvery; healer.target = null;
    game.rosterVer++;
  }
  emit(game, { t: 'prayed', id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), n: crew.length, healer: healer ? healer.id : 0 });
  p.dirty = true;
}
// a healer: every 30 s a small heal for the boss and the crew around
function healerPulse(game, al) {
  const owner = game.players.get(al.follow);
  if (!owner || owner.dead || owner.inBar >= 0) return;
  const r2 = (CHURCH.healerRange * TILE) ** 2;
  let n = 0;
  if (!owner.down && dist2(owner.x, owner.y, al.x, al.y) < r2 && owner.hp < owner.maxHp) {
    const h = Math.round(owner.maxHp * CHURCH.healerHeal);
    owner.hp = Math.min(owner.maxHp, owner.hp + h); owner.dirty = true; n++;
    emit(game, { t: 'dmg', x: owner.x, y: owner.y - 22, v: h, c: 'heal' });
  }
  for (const o of game.allies.values()) {
    if (o.follow !== owner.id || o.hidden || o.hp >= o.maxHp || dist2(o.x, o.y, al.x, al.y) > r2) continue;
    const h = Math.round(o.maxHp * CHURCH.healerHeal);
    o.hp = Math.min(o.maxHp, o.hp + h); n++;
    emit(game, { t: 'dmg', x: o.x, y: o.y - 20, v: h, c: 'heal' });
  }
  emit(game, { t: 'healpulse', x: Math.round(al.x), y: Math.round(al.y), r: CHURCH.healerRange * TILE, n });
}

// ------------------------------------------------------------------ alliances (PvP / Rei da Boca)
// A gang asks to join another one. Any member of that gang can accept. For good: players, districts, guards,
// turrets, vehicles and the vault all move to the other gang (its colors). The joiner's main base becomes an outpost.
function allyRequest(game, p, a) {
  if (game.mode !== 'pvp') return tell(game, p.id, 'Alliances are for PvP and Rei da Boca games.');
  const from = game.gangs.get(p.gang), to = game.gangs.get(gangId(a.g | 0));
  if (!from || !to || to === from || to.out || from.out) return tell(game, p.id, 'That gang is not available.');
  if (![...game.players.values()].some((o) => o.gang === to.id && !o.out)) return tell(game, p.id, `Nobody from ${to.name} is online to accept.`);
  game.allyReq = game.allyReq || {};
  const old = game.allyReq[from.id];
  if (old && game.time - old.t < 30) return tell(game, p.id, 'You already asked. Wait for their answer.');
  game.allyReq[from.id] = { to: to.id, by: p.id, t: game.time };
  for (const o of game.players.values()) if (o.gang === to.id) emit(game, { t: 'allyreq', to: o.id, from: from.idx, fname: from.name, by: p.name });
  for (const o of game.players.values()) if (o.gang === from.id) emit(game, { t: 'msg', to: o.id, text: `${p.name} asked to join ${to.name}. If they accept, your gang becomes part of theirs for good.`, c: 'info' });
}
function allyAnswer(game, p, a) {
  const from = game.gangs.get(gangId(a.from | 0));
  const req = game.allyReq && from ? game.allyReq[from.id] : null;
  if (!req || req.to !== p.gang || game.time - req.t > 90 || from.out) return tell(game, p.id, 'That request is no longer valid.');
  delete game.allyReq[from.id];
  const to = game.gangs.get(p.gang);
  if (!a.ok) {
    for (const o of game.players.values()) if (o.gang === from.id) emit(game, { t: 'msg', to: o.id, text: `${to.name} said no to the alliance.`, c: 'warn' });
    return;
  }
  mergeGang(game, from, to);
}
function mergeGang(game, A, B) {
  B.vault += A.vault; A.vault = 0;
  for (const k in A.upgrades) B.upgrades[k] = Math.max(B.upgrades[k] || 0, A.upgrades[k] || 0);
  const regs = [];
  game.rs.forEach((rs, i) => {
    if (rs.owner === A.id) { rs.owner = B.id; regs.push(i); }
    if (rs.capBy === A.id || (rs.capBy === B.id && rs.owner === B.id)) { rs.capBy = null; rs.capture = 0; }
  });
  for (const i of regs) syncTurrets(game, i);
  for (const al of game.allies.values()) if (al.team === A.id) al.team = B.id;
  for (const v of game.vehicles.values()) if (v.team === A.id) v.team = B.id;
  const ids = [];
  for (const p of game.players.values()) if (p.gang === A.id) { p.gang = B.id; p.dirty = true; ids.push(p.id); }
  for (const k in game.saved) if (game.saved[k].gang === A.idx) game.saved[k].gang = B.idx;
  for (const k of Object.keys(game.rep)) {
    if (!k.startsWith(A.id + ':')) continue;
    const kb = B.id + k.slice(A.id.length);
    game.rep[kb] = Math.max(game.rep[kb] ?? CIV.repStart, game.rep[k]);
    delete game.rep[k];
  }
  // squads between the two gangs are called off; the joiner's other squads now fight for the new gang
  const off = new Set();
  for (const r of game.raids) {
    if (r.kind !== 'g') continue;
    if (r.f === A.id) r.f = B.id;
    if (r.f === B.id && game.rs[r.target].owner === B.id) off.add(r.id);
  }
  for (const r of game.raids) if (r.gang === A.id) r.gang = B.id;
  if (off.size) {
    for (const al of [...game.allies.values()]) if (off.has(al.squad)) game.allies.delete(al.id);
    game.raids = game.raids.filter((r) => !off.has(r.id));
  }
  if (game.king) {
    game.kingHold[B.id] = Math.max(game.kingHold[B.id] || 0, game.kingHold[A.id] || 0);
    delete game.kingHold[A.id];
    if (game.kingOwner === A.id) game.kingOwner = B.id;
  }
  if (game.allyReq) for (const k of Object.keys(game.allyReq)) if (k === A.id || game.allyReq[k].to === A.id) delete game.allyReq[k];
  A.out = true; A.into = B.id; A.base = -1;
  game.regionVer++; game.rosterVer++;
  emit(game, { t: 'alliance', a: A.idx, b: B.idx, an: A.name, bn: B.name, regs, ids });
  checkEndgame(game);
}

// ------------------------------------------------------------------ network packing
const r1 = (v) => Math.round(v * 10) / 10;

export function regionState(game) {
  return {
    mode: game.mode,
    rs: game.rs.map((r) => {
      const row = [ownerCode(r.owner), r.garrison, r.garrisonMax, Math.round(r.capture * 100), r.guards, (r.hqUnlocked ? 1 : 0) | (r.bossDefeated ? 2 : 0) | (r.atk ? 4 : 0) | (r.shield ? 8 : 0), r.capBy === 'raid' ? 99 : r.capBy ? ownerCode(r.capBy) : -1];
      row.push([r.up.level, r.up.walls, r.up.barracks, r.up.medic, r.up.pad, r.up.radar, r.up.boca || 0], r.slots.map((s) => (s ? [TURRET_IDS.indexOf(s.type), s.mk, Math.round((s.hpf ?? 1) * 100)] : 0)), r.extra || 0);
      return row;
    }),
    raids: game.raids.map((r) => [r.target, typeof r.f === 'number' ? r.f : 9, r.state === 'warn' ? 0 : 1, Math.max(0, Math.round(r.t)), r.gang ? gangIdx(r.gang) : -1, r.size, r.kind === 'g' ? gangIdx(r.f) : r.kind === 'f' ? 10 + r.def : -1]),
    fv: game.fvault ? game.fvault.map(Math.round) : [0, 0, 0],
    king: game.king ? { r: game.world.kingId, goal: game.kingGoal, hold: Object.entries(game.kingHold).map(([k, v]) => [k, Math.floor(v)]) } : null,
    gangs: [...game.gangs.values()].map((g) => ({ idx: g.idx, name: g.name, base: g.base, vault: Math.floor(g.vault), up: g.upgrades, out: g.out, into: g.into ? gangIdx(g.into) : undefined, owned: ownedCount(game, g.id) })),
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
    gren: p.gren, sq: Math.max(0, Math.ceil((p.squadT || 0) - game.time)), down: p.down ? r1(p.downT) : 0, rvd: p.down ? +p.revP.toFixed(2) : 0, rv: p.revId ? +(p.revT / DOWN.reviveT).toFixed(2) : 0, wd: Math.max(0, Math.ceil((p.wdT || 0) - game.time)),
    rep: Math.round(repOf(game, p.gang, regionAt(game.world, p.x, p.y))),
    jail: p.inBar === JAIL_ID ? Math.max(0, Math.ceil(p.jailT)) : 0, lost: p.lost ? 1 : 0, reinf: p.reinfT !== undefined && p.copLevel > 0 ? Math.max(0, Math.ceil(p.reinfT)) : -1,
    pray: p.prayT > 0 ? r1(p.prayT) : 0, prayCd: Math.max(0, Math.ceil((p.prayCd || 0) - game.time)),
  };
}

export function profile(p) {
  return { armory: p.armory, equip: p.equip, mods: p.mods, level: p.level, kills: p.kills, deaths: p.deaths, pvpKills: p.pvpKills, speed: p.speed, rof: buff(p, 'rof', 1), dash: buff(p, 'dash', 0), sway: buff(p, 'sway', 0), ghost: buff(p, 'ghost', 0), radar: buff(p, 'radar', 0), fury: buff(p, 'dmg', 1) > 1.3 };
}

export function vehicleRows(game) {
  const V = [];
  for (const v of game.vehicles.values()) {
    V.push([v.id, VEHICLE_IDS.indexOf(v.type), r1(v.x), r1(v.y), Math.ceil(v.hp), v.maxHp, Math.round(v.charge), v.dir, (v.flying ? 1 : 0) | (v.flash > 0 ? 2 : 0) | (v.charging ? 4 : 0) | (v.civ ? 8 : 0), gangIdx(v.team), ...v.seats.map((s) => s || 0)]);
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
    P.push([p.id, r1(p.x), r1(p.y), +p.aim.toFixed(2), Math.ceil(p.hp), p.maxHp, (p.dead ? 1 : 0) | (p.cloakT > 0 ? 2 : 0) | (p.shieldHp > 0 ? 4 : 0) | (p.invulnT > 0 ? 8 : 0) | (p.burnT > 0 ? 16 : 0) | (p.out ? 32 : 0) | (buff(p, 'ghost', 0) ? 64 : 0) | (p.copLevel > 0 ? 128 : 0) | (p.down ? 256 : 0), p.level, p.veh || 0, p.seat, p.inBar, r1(p.bx), r1(p.by), p.emoteT > 0 ? p.emote + 1 : 0, Math.min(5, Math.ceil(p.heat / 100 - 0.001)), p.down ? Math.round(p.revP * 100) : 0, p.down ? Math.ceil(p.downT) : 0]);
  }
  const E = [];
  for (const e of game.enemies.values()) {
    if (!near(e.x, e.y)) continue;
    E.push([e.id, e.faction * 10 + (e.boss ? 6 : e.tier), r1(e.x), r1(e.y), Math.ceil(e.hp), e.maxHp, (e.windup > 0 ? 1 : 0) | (e.flash > 0 ? 2 : 0) | (e.raid ? 4 : 0) | (e.moving ? 8 : 0) | (e.burnT > 0 ? 16 : 0) | (e.stunT > 0 ? 32 : 0), e.stars, +e.aim.toFixed(2), ATTACK_KEYS.indexOf(e.atk)]);
  }
  const A = [];
  for (const al of game.allies.values()) {
    if (al.hidden || !near(al.x, al.y)) continue;
    A.push([al.id, r1(al.x), r1(al.y), Math.ceil(al.hp), al.maxHp, (al.flash > 0 ? 2 : 0) | (al.moving ? 8 : 0), +al.aim.toFixed(2), gangIdx(al.team), al.follow || 0, al.tier, al.civ || 0, al.melee ? 1 : 0, al.lvl || 1, al.revT > 0 ? 1 : 0, al.emoteT > 0 ? al.emote + 1 : 0, al.healer ? 1 : 0]);
  }
  const Tu = [];
  for (const t of game.turrets.values()) {
    if (!near(t.x, t.y)) continue;
    Tu.push([t.id, t.x, t.y, +t.aim.toFixed(2), Math.ceil(t.hp), t.maxHp, TURRET_IDS.indexOf(t.type), t.mk, gangIdx(t.team), (t.deadT > 0 ? 1 : 0) | (t.flash > 0 ? 2 : 0)]);
  }
  const Cv = [];
  for (const c of game.civs.values()) if (near(c.x, c.y)) Cv.push([c.id, r1(c.x), r1(c.y), c.seed, (c.flee > 0 ? 1 : 0) | (c.flash > 0 ? 2 : 0) | (c.moving ? 4 : 0) | (c.danceT > 0 ? 8 : 0), +c.aim.toFixed(2), Math.round(100 * c.hp / c.maxHp)]);
  const K = [];
  for (const k of game.pickups.values()) if (near(k.x, k.y)) K.push([k.id, k.type === 'cash' ? 0 : k.type === 'ufo' ? 2 : 1, Math.round(k.x), Math.round(k.y), k.amount]);
  const Pt = [];
  for (const a of game.pets.values()) if (near(a.x, a.y)) Pt.push([a.id, r1(a.x), r1(a.y), a.kind === 'dog' ? 0 : 1, a.seed, (a.moving ? 1 : 0) | (a.flee > 0 ? 2 : 0) | (a.happyT > 0 ? 4 : 0) | (a.sit ? 8 : 0), +a.aim.toFixed(2)]);
  const u = game.ufo;
  return { t: 's', tm: +game.time.toFixed(2), day: +game.dayT.toFixed(4), P, E, A, T: Tu, V: vehicleRows(game), C: Cv, K, rc: radarFor(game, me), PC: [...game.pcars.values()].filter((c) => !c.cruise || near(c.x, c.y)).map((c) => [c.id, r1(c.x), r1(c.y), c.dir, c.state === 'in' ? 0 : c.state === 'drop' ? 1 : c.cruise ? 3 : 2]), HE: [...game.helis.values()].map((h) => [h.id, r1(h.x), r1(h.y), +h.aim.toFixed(2), h.kind === 'mg' ? 0 : 1, h.state === 'atk' ? 1 : 0]), PT: Pt, U: u ? [r1(u.x), r1(u.y), ['warn', 'beam', 'hover', 'leave'].indexOf(u.state), r1(u.t), u.id] : 0, me: privateState(game, me) };
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
export function debugUfo(game) { game.ufoT = 0.01; if (game.ufoN >= game.ufoMax) game.ufoMax = game.ufoN + 1; }
export function debugArrest(game, pid) { const p = game.players.get(pid); if (p) { if (p.heat < 100) p.heat = 150; arrestPlayer(game, p, { k: 'h', id: 0, team: 'e' }); } }
export function debugMerge(game, a, b) { const A = game.gangs.get(gangId(a)), B = game.gangs.get(gangId(b)); if (A && B) mergeGang(game, A, B); }
export function debugHurt(game, pid, dmg, eid) { const p = game.players.get(pid); if (p) hurtPlayer(game, p, dmg, eid ? { k: 'e', id: eid, team: 'e' } : null); }
