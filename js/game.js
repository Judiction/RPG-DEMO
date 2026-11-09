// The game simulation. Only the HOST runs this; clients just render what the host sends.
// No DOM here. Player positions come from each player's own browser (smooth movement);
// everything else (enemies, damage, money, territory) is decided here.

import {
  TILE, WEAPONS, MODS, ABILITIES, TIERS, ATTACKS, FACTIONS, BASE_HP, BASE_SPEED, xpForLevel, MAX_LEVEL,
  RESPAWN_TIME, DEATH_CASH_LOSS, VAULT_UPGRADES, BASE_GUARDS, COMPOUND_INCOME, weaponMult, weaponUpgradePrice,
  MAX_WEAPON_LVL, WEAPON_IDS,
} from './data.js';
import { W, moveBox, lineOfSight, rayCast, bfsField, fieldDir, regionAt, opaqueAt } from './world.js';

export const GANG = 'g';
export const PLAYER_R = 5;
export const DAY_LEN = 420;               // seconds per day/night cycle
export const ATTACK_KEYS = Object.keys(ATTACKS);
const RAID_WARN = 30;

const rand = Math.random;
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return Math.abs(d); };
const pick = (arr) => arr[(rand() * arr.length) | 0];
const gauss = () => (rand() + rand() + rand() - 1.5) / 0.5;

// ------------------------------------------------------------------ creation / saving
export function createGame(world, { gangName = 'Bonde Neon', gangColor = '#ff3f8e', save = null } = {}) {
  const game = {
    world, seed: world.seed, gangName, gangColor,
    time: 0, dayT: 0.66,
    players: new Map(), enemies: new Map(), allies: new Map(), pickups: new Map(),
    projectiles: [], events: [], nextId: 1,
    rs: [], vault: 0, upgrades: { training: 0, count: 0, income: 0 },
    raids: [], raidT: 200, incomeT: 0, regionT: 0,
    defeated: [false, false, false], victory: false,
    stats: { kills: 0, deaths: 0, captures: 0, lost: 0, bosses: 0 },
    saved: {},                  // characters of players who are not connected, by key
    pfields: new Map(), cfields: new Map(),
    maxTier: Math.max(...world.regions.map((r) => r.tier)),
    rosterVer: 1, regionVer: 1,
  };
  for (const R of world.regions) {
    game.rs.push({
      owner: R.base ? GANG : R.faction, garrison: 0, garrisonMax: 0, spawned: 0, idleT: 99, regenT: 0,
      capture: 0, guards: R.base ? 0 : 0, gspawned: 0, guardT: 0, hqUnlocked: false, bossDefeated: false, bossSpawned: false,
      hintT: 0,
    });
    const rs = game.rs[R.id];
    rs.garrisonMax = R.base ? 0 : Math.round(7 + R.tier * 2.5 + (R.hq ? 8 : 0));
    rs.garrison = rs.garrisonMax;
  }
  if (save) loadSave(game, save);
  return game;
}

function loadSave(game, s) {
  game.gangName = s.gangName ?? game.gangName;
  game.gangColor = s.gangColor ?? game.gangColor;
  game.time = s.time || 0; game.dayT = s.dayT ?? 0.3;
  game.vault = s.vault || 0;
  Object.assign(game.upgrades, s.upgrades || {});
  game.defeated = s.defeated || game.defeated;
  game.victory = !!s.victory;
  game.raidT = s.raidT ?? 200;
  Object.assign(game.stats, s.stats || {});
  game.saved = s.chars || {};
  (s.rs || []).forEach((r, i) => {
    const rs = game.rs[i];
    if (!rs) return;
    rs.owner = r.o; rs.garrison = r.g; rs.guards = r.gu; rs.hqUnlocked = !!r.hu; rs.bossDefeated = !!r.bd;
  });
}

export function serialize(game) {
  const chars = { ...game.saved };
  for (const p of game.players.values()) chars[p.key] = charData(p);
  return {
    v: 1, seed: game.seed, gangName: game.gangName, gangColor: game.gangColor, time: game.time, dayT: game.dayT,
    vault: Math.floor(game.vault), upgrades: game.upgrades, defeated: game.defeated, victory: game.victory,
    raidT: Math.max(60, game.raidT), stats: game.stats,
    rs: game.rs.map((r) => ({ o: r.owner, g: r.garrison, gu: r.guards, hu: r.hqUnlocked, bd: r.bossDefeated })),
    chars, savedAt: Date.now(),
    owned: ownedCount(game), total: game.world.regions.length,
  };
}

const charData = (p) => ({
  name: p.name, look: p.look, level: p.level, xp: p.xp, cash: Math.floor(p.cash),
  armory: p.armory, equip: p.equip, mods: p.mods, kills: p.kills, deaths: p.deaths,
});

export function emit(game, ev) { game.events.push(ev); }

// ------------------------------------------------------------------ players
export function addPlayer(game, { id, key, name, look }) {
  const C = game.world.regions[game.world.baseId].compound;
  const saved = game.saved[key];
  const p = {
    id, key, name: String(name || 'Mano').slice(0, 14), look,
    x: (C.coreX + 0.5) * TILE + (rand() - 0.5) * 30, y: (C.coreY + 2.5) * TILE,
    aim: 0, input: { fireL: false, fireR: false },
    level: 1, xp: 0, cash: 120, armory: { fist: 1, pistol: 1 }, equip: { L: 'fist', R: 'pistol' },
    mods: { armor: 0, legs: 0, nanite: 0, optic: 0, shield: 0 },
    hp: BASE_HP, maxHp: BASE_HP, dead: false, respawnT: 0, kills: 0, deaths: 0,
    cd: { L: 0, R: 0, Q: 0, E: 0, R2: 0, F: 0 }, cloakT: 0, shieldHp: 0, shieldT: 0, invulnT: 0, lastHurt: -99,
    dirty: true, swing: 0,
  };
  if (saved) {
    Object.assign(p, {
      name: saved.name || p.name, look: saved.look || look, level: saved.level, xp: saved.xp, cash: saved.cash,
      armory: saved.armory, equip: saved.equip, mods: { ...p.mods, ...saved.mods }, kills: saved.kills || 0, deaths: saved.deaths || 0,
    });
    if (name) p.name = String(name).slice(0, 14);
    if (look) p.look = look;
    delete game.saved[key];
  }
  recalc(p);
  p.hp = p.maxHp;
  game.players.set(id, p);
  game.rosterVer++;
  emit(game, { t: 'msg', text: `${p.name} joined the gang.`, c: 'join' });
  return p;
}

export function removePlayer(game, id) {
  const p = game.players.get(id);
  if (!p) return;
  game.saved[p.key] = charData(p);
  game.players.delete(id);
  game.pfields.delete(id);
  game.rosterVer++;
  emit(game, { t: 'msg', text: `${p.name} left.`, c: 'leave' });
}

export function recalc(p) {
  const a = p.mods.armor || 0, l = p.mods.legs || 0, n = p.mods.nanite || 0;
  p.maxHp = BASE_HP + (p.level - 1) * 10 + a * 20;
  p.speed = BASE_SPEED * (1 + 0.07 * l);
  p.regen = n * 0.8;
  p.armorRed = a * 0.06;
  p.dmgMult = 1 + 0.05 * (p.level - 1);
  p.hp = Math.min(p.hp, p.maxHp);
}

export function setInput(game, id, inp) {
  const p = game.players.get(id);
  if (!p) return;
  if (Number.isFinite(inp.x) && Number.isFinite(inp.y) && !p.dead) { p.x = inp.x; p.y = inp.y; }
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
  const lvl = p.mods[A.mod] || 0;
  const ck = key === 'R' ? 'R2' : key;
  if (lvl < 1 || p.cd[ck] > 0.15) return;
  p.cd[ck] = A.cd(lvl);
  if (key === 'Q') { p.invulnT = 0.3; emit(game, { t: 'fx', k: 'dash', id: p.id, x: p.x, y: p.y }); }
  if (key === 'E') {
    const heal = p.maxHp * (0.25 + 0.05 * lvl);
    p.hp = Math.min(p.maxHp, p.hp + heal);
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

export function inBase(game, p) {
  return regionAt(game.world, p.x, p.y) === game.world.baseId;
}

export function handleAction(game, id, a) {
  const p = game.players.get(id);
  if (!p || !a) return;
  if (a.t === 'equip') {
    if (!inBase(game, p)) return tell(game, id, 'Go back to the base to swap arms.');
    if ((a.slot === 'L' || a.slot === 'R') && p.armory[a.w]) { p.equip[a.slot] = a.w; p.dirty = true; game.rosterVer++; }
    return;
  }
  if (a.t === 'donate') {
    const v = Math.min(Math.floor(p.cash), Math.max(0, a.v | 0));
    if (v <= 0) return;
    p.cash -= v; game.vault += v; p.dirty = true;
    emit(game, { t: 'msg', text: `${p.name} put R$${v} in the gang vault.`, c: 'gold' });
    return;
  }
  if (!inBase(game, p)) return tell(game, id, 'Shops only work at the base (QG).');
  if (a.t === 'buyW') {
    const Wp = WEAPONS[a.w];
    if (!Wp || p.armory[a.w]) return;
    if (p.level < Wp.lvl) return tell(game, id, `Needs level ${Wp.lvl}.`);
    if (p.cash < Wp.price) return tell(game, id, 'Not enough cash.');
    p.cash -= Wp.price; p.armory[a.w] = 1; p.dirty = true;
    emit(game, { t: 'buy', id, text: `Bought ${Wp.name}!` });
  } else if (a.t === 'upW') {
    const lvl = p.armory[a.w];
    if (!lvl || lvl >= MAX_WEAPON_LVL) return;
    const price = weaponUpgradePrice(a.w, lvl);
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.armory[a.w] = lvl + 1; p.dirty = true;
    emit(game, { t: 'buy', id, text: `${WEAPONS[a.w].name} upgraded to Mk${lvl + 1}!` });
  } else if (a.t === 'buyM') {
    const M = MODS[a.m];
    if (!M) return;
    const lvl = p.mods[a.m] || 0;
    if (lvl >= M.prices.length) return;
    const price = M.prices[lvl];
    if (p.cash < price) return tell(game, id, 'Not enough cash.');
    p.cash -= price; p.mods[a.m] = lvl + 1; recalc(p); p.dirty = true; game.rosterVer++;
    emit(game, { t: 'buy', id, text: `${M.name} installed (Lv ${lvl + 1})!` });
  } else if (a.t === 'vault') {
    const U = VAULT_UPGRADES[a.u];
    if (!U) return;
    const lvl = game.upgrades[a.u] || 0;
    if (lvl >= U.prices.length) return;
    const price = U.prices[lvl];
    if (game.vault < price) return tell(game, id, 'Not enough in the gang vault.');
    game.vault -= price; game.upgrades[a.u] = lvl + 1;
    emit(game, { t: 'msg', text: `${p.name} bought ${U.name} ${lvl + 1} for the gang!`, c: 'gold' });
    if (a.u === 'training') for (const al of game.allies.values()) applyAllyStats(game, al);
  }
}

// ------------------------------------------------------------------ helpers
export function ownedCount(game) { return game.rs.filter((r) => r.owner === GANG).length; }

function adjacentToGang(game, i) {
  return game.world.regions[i].neighbors.some((n) => game.rs[n].owner === GANG);
}

function corePos(game, i) {
  const C = game.world.regions[i].compound;
  return { x: (C.coreX + 0.5) * TILE, y: (C.coreY + 0.5) * TILE };
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

const bodyY = (e) => e.y - 6 * (e.bulk || 1);

function rollTier(game, R, bonus = 0) {
  const d = R.tier / Math.max(1, game.maxTier);
  const heat = ownedCount(game) / game.world.regions.length;
  const avg = 1 + d * 3.3 + heat * 0.6 + bonus;
  return Math.max(1, Math.min(5, Math.round(avg + gauss() * 0.6)));
}

export function enemyName(e) {
  if (e.boss) return FACTIONS[e.faction].boss;
  return FACTIONS[e.faction].tiers[e.tier - 1];
}

// ------------------------------------------------------------------ spawning
function spawnEnemy(game, f, tier, x, y, home, opts = {}) {
  const T = TIERS[tier];
  const R = home >= 0 ? game.world.regions[home] : null;
  const rt = R ? R.tier : 1;
  const hpMul = (1 + 0.1 * rt) * (opts.boss ? 1 + 0.25 * game.players.size : 1);
  const e = {
    id: game.nextId++, k: 'e', faction: f, tier, x, y,
    hp: 0, maxHp: 0, dmg: T.dmg * (1 + 0.06 * rt), speed: T.speed * (0.9 + rand() * 0.2), bulk: T.bulk,
    r: Math.min(7, 4.2 * T.bulk), home, hx: x, hy: y, state: opts.raid ? 'raid' : 'idle', target: null,
    atk: pick(T.attacks), atkCd: 1 + rand(), windup: 0, windAng: 0, thinkT: rand() * 0.2, mvx: 0, mvy: 0, kx: 0, ky: 0,
    stars: 0, boss: tier === 6, flash: 0, aim: rand() * 6.28, raid: opts.raid || null, wanderT: rand() * 3,
    burst: 0, burstT: 0, phase: 0, garrison: !!opts.garrison, moving: false,
  };
  e.maxHp = e.hp = Math.round(T.hp * hpMul);
  if (f === 1 && tier === 1) { e.atk = 'gun'; e.speed = 62; }
  if (f === 2 && tier === 4) { e.atk = 'melee'; e.speed = 88; e.dmg *= 1.2; }
  if (e.boss) { e.r = 7; e.atk = 'boss'; }
  game.enemies.set(e.id, e);
  return e;
}

function promoteEnemy(game, e, victim) {
  e.stars++;
  if (!e.boss && e.tier < 5) {
    const old = e.tier;
    e.tier++;
    const T = TIERS[e.tier];
    const frac = 1;
    e.maxHp = Math.round(e.maxHp * (T.hp / TIERS[old].hp));
    e.hp = e.maxHp * frac;
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
  emit(game, { t: 'eup', x: e.x, y: e.y, name: enemyName(e), victim: victim.name, f: e.faction });
}

function pickSpawnTile(game, region, nearCore) {
  const list = game.world.spawnTiles[region];
  if (!list.length) return null;
  const core = corePos(game, region);
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
  const L = game.upgrades.training || 0;
  const frac = al.maxHp ? al.hp / al.maxHp : 1;
  al.maxHp = 80 + 55 * L;
  al.hp = al.maxHp * frac;
  al.dmg = 7 + 5 * L;
}

function spawnAlly(game, region) {
  const C = game.world.regions[region].compound;
  let x = 0, y = 0;
  for (let a = 0; a < 20; a++) {
    x = (C.x + 2 + rand() * (C.w - 4)) * TILE; y = (C.y + 2 + rand() * (C.h - 4)) * TILE;
    if (!opaqueAt(game.world, x, y)) break;
  }
  const al = { id: game.nextId++, k: 'a', region, x, y, px: x, py: y, hp: 1, maxHp: 1, dmg: 7, speed: 62, r: 4.5, target: null, atkCd: rand(), thinkT: rand() * 0.3, aim: rand() * 6.28, flash: 0, mvx: 0, mvy: 0, moving: false };
  applyAllyStats(game, al);
  al.hp = al.maxHp;
  game.allies.set(al.id, al);
  return al;
}

// ------------------------------------------------------------------ combat
function spawnProj(game, o) {
  const p = {
    id: game.nextId++, x: o.x, y: o.y, vx: Math.cos(o.a) * o.speed, vy: Math.sin(o.a) * o.speed, life: o.life,
    dmg: o.dmg, team: o.team, owner: o.owner ?? null, src: o.src || null, kind: o.kind, r: o.r || 3, aoe: o.aoe || 0,
    homing: o.homing || 0, knock: o.knock || 0, crit: !!o.crit,
  };
  game.projectiles.push(p);
  emit(game, { t: 'shot', i: p.id, x: Math.round(p.x), y: Math.round(p.y), a: +o.a.toFixed(3), s: o.speed, l: o.life, k: o.kind, tm: o.team, o: p.owner, px: p.x, py: p.y });
  return p;
}

function damageEnemy(game, e, dmg, src, kx = 0, ky = 0) {
  if (!game.enemies.has(e.id)) return;
  let crit = false;
  if (src && src.k === 'p' && rand() < 0.1) { dmg *= 1.6; crit = true; }
  e.hp -= dmg;
  e.flash = 0.12;
  if (kx || ky) { const m = e.boss ? 0.15 : 1 / e.bulk; e.kx += kx * m; e.ky += ky * m; }
  emit(game, { t: 'dmg', x: e.x, y: e.y - 14 * e.bulk - 6, v: Math.round(dmg), c: crit ? 'crit' : 'hit' });
  if (src && (!e.target || e.state === 'idle') && e.state !== 'return') {
    e.target = { k: src.k, id: src.id };
    if (e.state === 'idle') e.state = 'chase';
  }
  if (e.hp <= 0) killEnemy(game, e, src);
}

function killEnemy(game, e, src) {
  game.enemies.delete(e.id);
  game.stats.kills++;
  emit(game, { t: 'die', x: e.x, y: e.y, tr: e.tier, f: e.faction, b: e.bulk, boss: e.boss });
  const T = TIERS[e.tier];
  const cash = T.cash * (1 + e.stars * 0.5) * (0.85 + rand() * 0.3);
  const xp = T.xp * (1 + e.stars * 0.5);
  if (src && src.k === 'p') {
    const p = game.players.get(src.id);
    if (p) {
      p.kills++;
      addCash(game, p, cash, e.x, e.y - 10);
      addXp(game, p, xp);
      for (const o of game.players.values()) {
        if (o === p || o.dead || dist2(o.x, o.y, e.x, e.y) > (14 * TILE) ** 2) continue;
        addCash(game, o, cash * 0.4, o.x, o.y - 26);
        addXp(game, o, xp * 0.6);
      }
    }
  } else if (src && src.k === 'a') {
    game.vault += cash * 0.5;
  }
  if (e.raid) {
    const raid = game.raids.find((r) => r.id === e.raid);
    if (raid) raid.alive--;
  } else if (e.garrison && e.home >= 0) {
    const rs = game.rs[e.home];
    rs.garrison = Math.max(0, rs.garrison - 1);
    rs.spawned = Math.max(0, rs.spawned - 1);
    game.regionVer++;
    if (rs.garrison === 0 && rs.owner !== GANG) emit(game, { t: 'cleared', r: e.home });
  }
  if (e.boss) {
    const rs = game.rs[e.home];
    rs.bossDefeated = true; rs.bossSpawned = false;
    game.stats.bosses++;
    game.regionVer++;
    emit(game, { t: 'bossdown', f: e.faction, r: e.home, x: e.x, y: e.y });
    for (const p of game.players.values()) { addCash(game, p, 1500, p.x, p.y - 26); addXp(game, p, 800); }
  }
  if (rand() < 0.07 || (e.tier >= 4 && rand() < 0.4)) spawnPickup(game, 'heal', e.x, e.y, 25);
}

function spawnPickup(game, type, x, y, amount) {
  const k = { id: game.nextId++, type, x, y, amount, life: type === 'cash' ? 120 : 40 };
  game.pickups.set(k.id, k);
}

function hurtPlayer(game, p, dmg, src) {
  if (p.dead || p.invulnT > 0) return;
  dmg *= 1 - p.armorRed;
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
  if (p.hp <= 0) killPlayer(game, p, src);
}

function killPlayer(game, p, src) {
  p.hp = 0; p.dead = true; p.respawnT = RESPAWN_TIME; p.deaths++;
  p.cloakT = 0; p.shieldHp = 0;
  game.stats.deaths++;
  const loss = Math.floor(p.cash * DEATH_CASH_LOSS);
  if (loss > 0) { p.cash -= loss; spawnPickup(game, 'cash', p.x, p.y, loss); }
  const killer = src && src.k === 'e' ? game.enemies.get(src.id) : null;
  emit(game, { t: 'pdie', id: p.id, name: p.name, by: killer ? enemyName(killer) : 'the streets', loss, x: p.x, y: p.y });
  if (killer) promoteEnemy(game, killer, p);
  for (const e of game.enemies.values()) if (e.target && e.target.k === 'p' && e.target.id === p.id) e.target = null;
  p.dirty = true;
}

function hurtAlly(game, al, dmg) {
  al.hp -= dmg;
  al.flash = 0.12;
  emit(game, { t: 'dmg', x: al.x, y: al.y - 20, v: Math.round(dmg), c: 'ally' });
  if (al.hp <= 0) {
    game.allies.delete(al.id);
    const rs = game.rs[al.region];
    rs.guards = Math.max(0, rs.guards - 1);
    rs.gspawned = Math.max(0, rs.gspawned - 1);
    emit(game, { t: 'die', x: al.x, y: al.y, tr: 1, f: -1, b: 1 });
    for (const e of game.enemies.values()) if (e.target && e.target.k === 'a' && e.target.id === al.id) e.target = null;
  }
}

function explode(game, x, y, r, dmg, team, src) {
  emit(game, { t: 'boom', x, y, r });
  if (team === 'g') {
    for (const e of [...game.enemies.values()]) {
      const d = Math.sqrt(dist2(x, y, e.x, bodyY(e)));
      if (d < r + e.r) { const f = 1 - 0.5 * Math.min(1, d / r); const a = Math.atan2(bodyY(e) - y, e.x - x); damageEnemy(game, e, dmg * f, src, Math.cos(a) * 160, Math.sin(a) * 160); }
    }
  } else {
    for (const p of game.players.values()) {
      const d = Math.sqrt(dist2(x, y, p.x, p.y - 6));
      if (d < r + 4) hurtPlayer(game, p, dmg * (1 - 0.5 * Math.min(1, d / r)), src);
    }
    for (const al of [...game.allies.values()]) if (dist2(x, y, al.x, al.y - 6) < (r + 4) ** 2) hurtAlly(game, al, dmg * 0.7);
  }
}

function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l));
  return dist2(px, py, x1 + dx * t, y1 + dy * t);
}

function fireWeapon(game, p, slot) {
  const wid = p.equip[slot];
  const Wp = WEAPONS[wid];
  if (!Wp) return;
  const lvl = p.armory[wid] || 1;
  let mult = weaponMult(lvl) * p.dmgMult;
  if (p.cloakT > 0) { mult *= 2; p.cloakT = 0; emit(game, { t: 'fx', k: 'uncloak', id: p.id, x: p.x, y: p.y }); }
  p.cd[slot] = Wp.cd;
  const a = p.aim;
  const ox = p.x + Math.cos(a) * 6, oy = p.y - 8 + Math.sin(a) * 6;
  const src = { k: 'p', id: p.id };
  const dmg = Wp.dmg * mult;
  if (Wp.kind === 'melee') {
    emit(game, { t: 'swing', o: 'p' + p.id, s: slot, a: +a.toFixed(2), k: wid });
    for (const e of [...game.enemies.values()]) {
      const d = Math.sqrt(dist2(p.x, p.y - 6, e.x, bodyY(e)));
      if (d > Wp.range + e.r + 2) continue;
      const ea = Math.atan2(bodyY(e) - (p.y - 6), e.x - p.x);
      if (d > 8 && angDiff(ea, a) > Wp.arc / 2) continue;
      damageEnemy(game, e, dmg, src, Math.cos(a) * Wp.knock * 3, Math.sin(a) * Wp.knock * 3);
    }
  } else if (Wp.kind === 'ranged') {
    const n = Wp.pellets || 1;
    for (let i = 0; i < n; i++) {
      const sa = a + (n > 1 ? (i / (n - 1) - 0.5) * Wp.spread : (rand() - 0.5) * Wp.spread);
      spawnProj(game, { x: ox, y: oy, a: sa, speed: Wp.speed * (n > 1 ? 0.85 + rand() * 0.3 : 1), life: Wp.life, dmg, team: 'g', owner: p.id, src, kind: Wp.proj, homing: Wp.homing || 0, knock: Wp.knock || 20 });
    }
  } else if (Wp.kind === 'whip') {
    const len = rayCast(game.world, ox, oy, a, Wp.range);
    const x2 = ox + Math.cos(a) * len, y2 = oy + Math.sin(a) * len;
    emit(game, { t: 'whip', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), s: slot });
    for (const e of [...game.enemies.values()]) {
      if (segDist2(e.x, bodyY(e), ox, oy, x2, y2) < (e.r + 5) ** 2) damageEnemy(game, e, dmg, src, Math.cos(a) * 60, Math.sin(a) * 60);
    }
  } else if (Wp.kind === 'slam') {
    const cx = p.x + Math.cos(a) * 16, cy = p.y - 4 + Math.sin(a) * 16;
    emit(game, { t: 'slam', o: 'p' + p.id, x: Math.round(cx), y: Math.round(cy), r: Wp.radius, s: slot, a: +a.toFixed(2) });
    for (const e of [...game.enemies.values()]) {
      const d = Math.sqrt(dist2(cx, cy, e.x, bodyY(e)));
      if (d < Wp.radius + e.r) { const ka = Math.atan2(bodyY(e) - cy, e.x - cx); damageEnemy(game, e, dmg, src, Math.cos(ka) * Wp.knock, Math.sin(ka) * Wp.knock); }
    }
  } else if (Wp.kind === 'rocket') {
    const pr = spawnProj(game, { x: ox, y: oy, a, speed: Wp.speed, life: Wp.life, dmg, team: 'g', owner: p.id, src, kind: 'rocket', aoe: Wp.radius, r: 4 });
    pr.aoe = Wp.radius;
  } else if (Wp.kind === 'beam') {
    const len = rayCast(game.world, ox, oy, a, Wp.range);
    const x2 = ox + Math.cos(a) * len, y2 = oy + Math.sin(a) * len;
    emit(game, { t: 'beam', o: 'p' + p.id, x: Math.round(ox), y: Math.round(oy), x2: Math.round(x2), y2: Math.round(y2), c: '#22e5ff' });
    for (const e of [...game.enemies.values()]) {
      if (segDist2(e.x, bodyY(e), ox, oy, x2, y2) < (e.r + 4) ** 2) damageEnemy(game, e, dmg, src, Math.cos(a) * 40, Math.sin(a) * 40);
    }
  }
}

// ------------------------------------------------------------------ the main step
export function step(game, dt) {
  game.time += dt;
  game.dayT = (game.dayT + dt / DAY_LEN) % 1;
  for (const p of game.players.values()) updatePlayer(game, p, dt);
  for (const e of [...game.enemies.values()]) updateEnemy(game, e, dt);
  for (const al of [...game.allies.values()]) updateAlly(game, al, dt);
  updateProjectiles(game, dt);
  updatePickups(game, dt);
  game.regionT += dt;
  if (game.regionT >= 0.5) { updateRegions(game, game.regionT); game.regionT = 0; }
  updateRaids(game, dt);
  game.incomeT += dt;
  if (game.incomeT >= 10) {
    game.incomeT = 0;
    let inc = 0;
    for (let i = 0; i < game.rs.length; i++) {
      const R = game.world.regions[i];
      if (game.rs[i].owner === GANG && !R.base) inc += COMPOUND_INCOME + R.tier * 2;
    }
    inc *= 1 + 0.25 * (game.upgrades.income || 0);
    if (inc > 0) { game.vault += inc; emit(game, { t: 'income', v: Math.round(inc) }); }
  }
}

function updatePlayer(game, p, dt) {
  for (const k in p.cd) if (p.cd[k] > 0) p.cd[k] -= dt;
  if (p.dead) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) {
      const C = game.world.regions[game.world.baseId].compound;
      p.dead = false; p.hp = p.maxHp; p.invulnT = 2;
      p.x = (C.coreX + 0.5) * TILE + (rand() - 0.5) * 24; p.y = (C.coreY + 2.5) * TILE;
      emit(game, { t: 'tp', id: p.id, x: p.x, y: p.y });
      p.dirty = true;
    }
    return;
  }
  if (p.invulnT > 0) p.invulnT -= dt;
  if (p.cloakT > 0) { p.cloakT -= dt; if (p.cloakT <= 0) emit(game, { t: 'fx', k: 'uncloak', id: p.id, x: p.x, y: p.y }); }
  if (p.shieldT > 0) { p.shieldT -= dt; if (p.shieldT <= 0) p.shieldHp = 0; }
  let regen = p.regen;
  if (game.time - p.lastHurt > 6) regen += 1 + p.maxHp * 0.01;
  if (inBase(game, p)) regen += p.maxHp * 0.08;
  p.hp = Math.min(p.maxHp, p.hp + regen * dt);
  if (p.input.fireL && p.cd.L <= 0) fireWeapon(game, p, 'L');
  if (p.input.fireR && p.cd.R <= 0) fireWeapon(game, p, 'R');
}

function targetEntity(game, t) {
  if (!t) return null;
  if (t.k === 'p') { const p = game.players.get(t.id); return p && !p.dead && p.cloakT <= 0 ? p : null; }
  return game.allies.get(t.id) || null;
}

function updateEnemy(game, e, dt) {
  const world = game.world;
  if (e.flash > 0) e.flash -= dt;
  e.atkCd -= dt;
  if (Math.abs(e.kx) + Math.abs(e.ky) > 1) {
    moveBox(world, e, e.kx * dt, e.ky * dt, e.r);
    e.kx *= 0.86; e.ky *= 0.86;
  } else { e.kx = 0; e.ky = 0; }
  if (e.burst > 0) {
    e.burstT -= dt;
    if (e.burstT <= 0) {
      e.burst--; e.burstT = 0.12;
      const tgt = targetEntity(game, e.target);
      const a = tgt ? Math.atan2(tgt.y - 6 - bodyY(e), tgt.x - e.x) : e.windAng;
      spawnProj(game, { x: e.x, y: bodyY(e), a: a + (rand() - 0.5) * 0.12, speed: ATTACKS.burst.speed, life: 1.2, dmg: e.dmg * 0.6, team: 'e', kind: 'ebullet', src: { k: 'e', id: e.id } });
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
  if (e.mvx || e.mvy) {
    const ox = e.x, oy = e.y;
    moveBox(world, e, e.mvx * e.speed * dt, e.mvy * e.speed * dt, e.r);
    e.moving = Math.abs(e.x - ox) + Math.abs(e.y - oy) > 0.05;
    if (!e.moving) e.stuck = (e.stuck || 0) + dt;
    else e.stuck = 0;
  } else e.moving = false;
  // attack
  const tgt = targetEntity(game, e.target);
  if (tgt && e.atkCd <= 0) {
    const A = ATTACKS[e.atk];
    const d = Math.sqrt(dist2(e.x, e.y, tgt.x, tgt.y));
    const range = e.atk === 'melee' ? A.range + e.r + 4 : e.atk === 'slam' ? A.radius * 0.8 + e.r : A.range;
    if (d <= range && lineOfSight(world, e.x, bodyY(e), tgt.x, tgt.y - 6)) {
      e.windup = A.windup * (e.boss ? 0.8 : 1);
      e.windAng = Math.atan2(tgt.y - 6 - bodyY(e), tgt.x - e.x);
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
  if (!tgt && e.state !== 'return') {
    let best = null, bd = (e.state === 'raid' ? 6 * TILE : aggro) ** 2;
    for (const p of game.players.values()) {
      if (p.dead || p.cloakT > 0) continue;
      const d = dist2(e.x, e.y, p.x, p.y);
      if (d < bd && lineOfSight(world, e.x, bodyY(e), p.x, p.y - 6)) { bd = d; best = { k: 'p', id: p.id }; }
    }
    for (const al of game.allies.values()) {
      const d = dist2(e.x, e.y, al.x, al.y);
      if (d < bd * 0.7 && lineOfSight(world, e.x, bodyY(e), al.x, al.y - 6)) { bd = d; best = { k: 'a', id: al.id }; }
    }
    if (best) { e.target = best; tgt = targetEntity(game, best); if (e.state === 'idle') e.state = 'chase'; }
  }
  // leash
  if (!e.raid && e.state !== 'return' && dist2(e.x, e.y, e.hx, e.hy) > (26 * TILE) ** 2) { e.state = 'return'; e.target = null; tgt = null; }
  let mx = 0, my = 0;
  if (tgt) {
    const d = Math.sqrt(dist2(e.x, e.y, tgt.x, tgt.y));
    e.aim = Math.atan2(tgt.y - e.y, tgt.x - e.x);
    const A = ATTACKS[e.atk];
    const prefer = e.atk === 'melee' || e.atk === 'slam' ? 6 : A.range * 0.6;
    const los = lineOfSight(world, e.x, bodyY(e), tgt.x, tgt.y - 6);
    if (d > prefer || !los) {
      if (los) { mx = (tgt.x - e.x) / d; my = (tgt.y - e.y) / d; }
      else {
        const f = tgt.key !== undefined ? playerField(game, tgt) : coreField(game, tgt.region ?? e.home);
        const dir = f ? fieldDir(world, f, e.x, e.y) : null;
        if (dir && !dir.done) { mx = dir.x; my = dir.y; } else { mx = (tgt.x - e.x) / d; my = (tgt.y - e.y) / d; }
      }
    } else if (e.atk !== 'melee' && e.atk !== 'slam') {
      // strafe a bit
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
    const d = Math.sqrt(dist2(e.x, e.y, e.hx, e.hy));
    if (d < 2 * TILE) { e.state = 'idle'; e.hp = e.maxHp; }
    else {
      let dir = null;
      if (e.home >= 0) dir = fieldDir(world, coreField(game, e.home), e.x, e.y);
      if (dir && !dir.done && !lineOfSight(world, e.x, e.y, e.hx, e.hy)) { mx = dir.x; my = dir.y; }
      else { mx = (e.hx - e.x) / d; my = (e.hy - e.y) / d; }
      if (e.stuck > 1.5) { e.x = e.hx; e.y = e.hy; e.stuck = 0; }
    }
  } else {
    // idle wander
    e.wanderT -= 0.2;
    if (e.wanderT <= 0) {
      e.wanderT = 2 + rand() * 4;
      if (rand() < 0.6) { const a = rand() * 6.28, r = rand() * 4 * TILE; e.wx = e.hx + Math.cos(a) * r; e.wy = e.hy + Math.sin(a) * r; }
      else e.wx = undefined;
    }
    if (e.wx !== undefined) {
      const d = Math.sqrt(dist2(e.x, e.y, e.wx, e.wy));
      if (d > 4 && e.stuck < 0.6) { mx = (e.wx - e.x) / d * 0.45; my = (e.wy - e.y) / d * 0.45; e.aim = Math.atan2(my, mx); }
      else e.wx = undefined;
    }
  }
  // separation
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
  const src = { k: 'e', id: e.id };
  const by = bodyY(e);
  e.atkCd = A.cd * (0.8 + rand() * 0.4);
  switch (e.atk) {
    case 'melee': {
      emit(game, { t: 'swing', o: 'e' + e.id, s: 'R', a: +a.toFixed(2), k: 'claw' });
      const reach = A.range + e.r + 8;
      for (const p of game.players.values()) {
        if (p.dead) continue;
        const d = Math.sqrt(dist2(e.x, by, p.x, p.y - 6));
        if (d < reach && (d < 8 || angDiff(Math.atan2(p.y - 6 - by, p.x - e.x), a) < 1.2)) hurtPlayer(game, p, e.dmg, src);
      }
      for (const al of [...game.allies.values()]) if (dist2(e.x, by, al.x, al.y - 6) < reach * reach) hurtAlly(game, al, e.dmg);
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
      for (const p of game.players.values()) if (!p.dead && dist2(e.x, e.y, p.x, p.y) < (r + 4) ** 2) hurtPlayer(game, p, e.dmg * 1.3, src);
      for (const al of [...game.allies.values()]) if (dist2(e.x, e.y, al.x, al.y) < (r + 4) ** 2) hurtAlly(game, al, e.dmg * 1.3);
      break;
    }
    case 'rocket': {
      const pr = spawnProj(game, { x: e.x, y: by, a, speed: A.speed, life: 2, dmg: e.dmg * 1.4, team: 'e', kind: 'erocket', src, r: 4 });
      pr.aoe = A.radius;
      break;
    }
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
    for (const p of game.players.values()) if (!p.dead && dist2(e.x, e.y, p.x, p.y) < (r + 4) ** 2) hurtPlayer(game, p, e.dmg * 1.5, src);
    for (const al of [...game.allies.values()]) if (dist2(e.x, e.y, al.x, al.y) < (r + 4) ** 2) hurtAlly(game, al, e.dmg);
  }
}

function updateAlly(game, al, dt) {
  const world = game.world;
  if (al.flash > 0) al.flash -= dt;
  al.atkCd -= dt;
  al.thinkT -= dt;
  if (al.thinkT <= 0) {
    al.thinkT = 0.25 + rand() * 0.1;
    let tgt = al.target ? game.enemies.get(al.target) : null;
    if (tgt && dist2(al.x, al.y, tgt.x, tgt.y) > (14 * TILE) ** 2) tgt = null;
    if (!tgt) {
      let bd = (10 * TILE) ** 2;
      for (const e of game.enemies.values()) {
        const d = dist2(al.x, al.y, e.x, e.y);
        if (d < bd && lineOfSight(world, al.x, al.y - 6, e.x, bodyY(e))) { bd = d; tgt = e; }
      }
    }
    al.target = tgt ? tgt.id : null;
    let mx = 0, my = 0;
    if (tgt) {
      const d = Math.sqrt(dist2(al.x, al.y, tgt.x, tgt.y));
      al.aim = Math.atan2(bodyY(tgt) - (al.y - 6), tgt.x - al.x);
      const los = lineOfSight(world, al.x, al.y - 6, tgt.x, bodyY(tgt));
      if (d > 90 || !los) { mx = (tgt.x - al.x) / d; my = (tgt.y - al.y) / d; }
      if (los && al.atkCd <= 0 && d < 150) {
        al.atkCd = 0.9 + rand() * 0.4;
        spawnProj(game, { x: al.x + Math.cos(al.aim) * 6, y: al.y - 8, a: al.aim + (rand() - 0.5) * 0.1, speed: 260, life: 0.7, dmg: al.dmg, team: 'g', kind: 'pulse', src: { k: 'a', id: al.id } });
      }
      if (dist2(al.x, al.y, al.px, al.py) > (12 * TILE) ** 2) { mx = (al.px - al.x); my = (al.py - al.y); const l = Math.hypot(mx, my); mx /= l; my /= l; al.target = null; }
    } else {
      const d = Math.sqrt(dist2(al.x, al.y, al.px, al.py));
      if (d > 20) {
        const dir = fieldDir(world, coreField(game, al.region), al.x, al.y);
        if (dir && !dir.done && d > 3 * TILE) { mx = dir.x; my = dir.y; } else { mx = (al.px - al.x) / d; my = (al.py - al.y) / d; }
        al.aim = Math.atan2(my, mx);
      } else if (rand() < 0.05) { al.px = al.px + (rand() - 0.5) * 30; al.py = al.py + (rand() - 0.5) * 30; }
    }
    al.mvx = mx; al.mvy = my;
  }
  if (al.mvx || al.mvy) {
    const ox = al.x, oy = al.y;
    moveBox(world, al, al.mvx * al.speed * dt, al.mvy * al.speed * dt, al.r);
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
      for (const e of game.enemies.values()) { const d = dist2(pr.x, pr.y, e.x, bodyY(e)); if (d < bd) { bd = d; best = e; } }
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
    if (!dead && opaqueAt(world, pr.x, pr.y)) {
      dead = true;
      if (pr.aoe) explode(game, pr.x - pr.vx * dt, pr.y - pr.vy * dt, pr.aoe, pr.dmg, pr.team, pr.src);
      else emit(game, { t: 'spark', x: Math.round(pr.x), y: Math.round(pr.y), i: pr.id });
    }
    if (!dead && pr.team === 'g') {
      for (const e of game.enemies.values()) {
        if (dist2(pr.x, pr.y, e.x, bodyY(e)) < (e.r + pr.r + 2) ** 2) {
          dead = true;
          if (pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, 'g', pr.src);
          else { const a = Math.atan2(pr.vy, pr.vx); damageEnemy(game, e, pr.dmg, pr.src, Math.cos(a) * pr.knock * 3, Math.sin(a) * pr.knock * 3); }
          break;
        }
      }
    } else if (!dead) {
      for (const p of game.players.values()) {
        if (p.dead) continue;
        if (dist2(pr.x, pr.y, p.x, p.y - 6) < (PLAYER_R + pr.r + 1) ** 2) {
          dead = true;
          if (pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, 'e', pr.src);
          else hurtPlayer(game, p, pr.dmg, pr.src);
          break;
        }
      }
      if (!dead) for (const al of game.allies.values()) {
        if (dist2(pr.x, pr.y, al.x, al.y - 6) < (al.r + pr.r + 1) ** 2) {
          dead = true;
          if (pr.aoe) explode(game, pr.x, pr.y, pr.aoe, pr.dmg, 'e', pr.src);
          else hurtAlly(game, al, pr.dmg);
          break;
        }
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
      if (p.dead || dist2(p.x, p.y, k.x, k.y) > 14 * 14) continue;
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
function updateRegions(game, dt) {
  const world = game.world;
  const players = [...game.players.values()].filter((p) => !p.dead);
  const guardCap = BASE_GUARDS + (game.upgrades.count || 0);
  for (let i = 0; i < game.rs.length; i++) {
    const R = world.regions[i];
    if (R.base) continue;
    const rs = game.rs[i];
    const core = corePos(game, i);
    let near = false, onCore = 0;
    for (const p of players) {
      const d = dist2(p.x, p.y, core.x, core.y);
      if (d < (34 * TILE) ** 2) near = true;
      if (d < (2.6 * TILE) ** 2) onCore++;
    }
    if (rs.hintT > 0) rs.hintT -= dt;
    if (rs.owner !== GANG) {
      // ---------------- enemy-held region
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
      // capture by the gang
      const adj = adjacentToGang(game, i);
      const capturable = rs.garrison <= 0 && adj && (!R.hq || rs.bossDefeated);
      let enemiesNear = false;
      for (const e of game.enemies.values()) if (dist2(e.x, e.y, core.x, core.y) < (3.5 * TILE) ** 2) { enemiesNear = true; break; }
      const prev = rs.capture;
      if (capturable && onCore > 0 && !enemiesNear) rs.capture = Math.min(1, rs.capture + dt * (0.16 + 0.07 * (onCore - 1)));
      else rs.capture = Math.max(0, rs.capture - dt * 0.08);
      if (rs.capture !== prev) game.regionVer++;
      if (onCore > 0 && !capturable && rs.hintT <= 0) {
        rs.hintT = 6;
        let text;
        if (!adj) text = 'Too far from our turf! Take a neighboring district first.';
        else if (R.hq && !rs.hqUnlocked) text = `HQ locked: control half of ${FACTIONS[rs.owner].short} territory first.`;
        else if (R.hq && !rs.bossDefeated) text = `Defeat ${FACTIONS[rs.owner].boss} to take this HQ!`;
        else text = `Kill the garrison first: ${rs.garrison} left.`;
        for (const p of players) if (dist2(p.x, p.y, core.x, core.y) < (2.6 * TILE) ** 2) tell(game, p.id, text);
      }
      if (rs.capture >= 1) captureRegion(game, i);
    } else {
      // ---------------- gang-held region
      const cap = guardCap + (R.hq ? 2 : 0);
      rs.guardT += dt;
      if (rs.guards < cap && rs.guardT > 20) { rs.guardT = 0; rs.guards++; game.regionVer++; }
      const raid = game.raids.find((r) => r.target === i && r.state === 'active');
      const active = near || !!raid;
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
      if (raid) {
        let raidersNear = 0, defenders = 0;
        for (const e of game.enemies.values()) if (e.raid === raid.id && dist2(e.x, e.y, core.x, core.y) < (2.8 * TILE) ** 2) raidersNear++;
        for (const p of players) if (dist2(p.x, p.y, core.x, core.y) < (5 * TILE) ** 2) defenders++;
        for (const al of game.allies.values()) if (al.region === i && dist2(al.x, al.y, core.x, core.y) < (5 * TILE) ** 2) defenders++;
        const prev = rs.capture;
        if (raidersNear > 0 && defenders === 0) rs.capture = Math.min(1, rs.capture + dt * 0.1);
        else rs.capture = Math.max(0, rs.capture - dt * 0.15);
        if (prev !== rs.capture) game.regionVer++;
        if (rs.capture >= 1) loseRegion(game, i, raid);
      } else if (rs.capture > 0) { rs.capture = Math.max(0, rs.capture - dt * 0.15); game.regionVer++; }
    }
  }
}

function captureRegion(game, i) {
  const R = game.world.regions[i];
  const rs = game.rs[i];
  const prevOwner = rs.owner;
  rs.owner = GANG; rs.capture = 0; rs.garrison = 0; rs.spawned = 0;
  rs.guards = BASE_GUARDS + (game.upgrades.count || 0); rs.gspawned = 0; rs.guardT = 0;
  for (const e of game.enemies.values()) if (e.home === i && !e.raid) { e.garrison = false; }
  game.stats.captures++;
  game.regionVer++;
  emit(game, { t: 'cap', r: i, f: prevOwner });
  for (const p of game.players.values()) {
    addCash(game, p, 100 + 60 * R.tier, p.x, p.y - 26);
    addXp(game, p, 40 * R.tier + 30);
  }
  game.vault += 100;
  if (R.hq) {
    game.defeated[prevOwner] = true;
    emit(game, { t: 'fdown', f: prevOwner });
    if (game.defeated.every(Boolean) && !game.victory) { game.victory = true; emit(game, { t: 'win' }); }
  }
  checkHqUnlocks(game);
  if (game.raidT > 200) game.raidT = 200;
}

function checkHqUnlocks(game) {
  const w = game.world;
  for (let f = 0; f < 3; f++) {
    const hq = w.hqs[f];
    if (hq < 0 || game.rs[hq].hqUnlocked) continue;
    const list = w.factionRegions[f].filter((r) => r !== hq);
    const owned = list.filter((r) => game.rs[r].owner === GANG).length;
    if (list.length === 0 || owned / list.length >= 0.5) {
      game.rs[hq].hqUnlocked = true;
      game.regionVer++;
      emit(game, { t: 'hq', f, r: hq });
    }
  }
}

function loseRegion(game, i, raid) {
  const rs = game.rs[i];
  rs.owner = raid.f; rs.capture = 0; rs.guards = 0; rs.gspawned = 0;
  for (const al of [...game.allies.values()]) if (al.region === i) game.allies.delete(al.id);
  let n = 0;
  const C = game.world.regions[i].compound;
  for (const e of game.enemies.values()) if (e.raid === raid.id) {
    e.raid = null; e.state = 'idle'; e.home = i; e.garrison = true;
    e.hx = (C.coreX + 0.5) * TILE + (rand() - 0.5) * 60; e.hy = (C.coreY + 0.5) * TILE + (rand() - 0.5) * 50; n++;
  }
  rs.spawned = n;
  rs.garrison = n + 4;
  rs.idleT = 0;
  game.stats.lost++;
  game.regionVer++;
  game.raids = game.raids.filter((r) => r !== raid);
  emit(game, { t: 'lost', r: i, f: raid.f });
}

function updateRaids(game, dt) {
  const owned = ownedCount(game);
  if (owned > 1) game.raidT -= dt;
  const maxRaids = owned > 10 ? 2 : 1;
  if (game.raidT <= 0) {
    const interval = Math.max(70, 170 - owned * 6);
    game.raidT = interval * (0.8 + rand() * 0.4);
    if (game.raids.length < maxRaids) startRaid(game);
  }
  for (const raid of [...game.raids]) {
    if (raid.state === 'warn') {
      raid.t -= dt;
      if (raid.t <= 0) spawnRaid(game, raid);
    } else {
      raid.t -= dt;
      if (raid.alive <= 0) {
        game.raids = game.raids.filter((r) => r !== raid);
        game.vault += 150;
        for (const p of game.players.values()) addXp(game, p, 60);
        emit(game, { t: 'raidend', r: raid.target, win: true });
        game.regionVer++;
      } else if (raid.t <= 0 || game.rs[raid.target].owner !== GANG) {
        for (const e of [...game.enemies.values()]) if (e.raid === raid.id) game.enemies.delete(e.id);
        game.raids = game.raids.filter((r) => r !== raid);
        emit(game, { t: 'raidend', r: raid.target, win: true, retreat: true });
        game.regionVer++;
      }
    }
  }
}

function startRaid(game) {
  const w = game.world;
  const cands = [];
  for (let i = 0; i < game.rs.length; i++) {
    if (game.rs[i].owner !== GANG || w.regions[i].base) continue;
    if (game.raids.some((r) => r.target === i)) continue;
    for (const n of w.regions[i].neighbors) {
      const o = game.rs[n].owner;
      if (o !== GANG && !game.defeated[o]) cands.push({ target: i, src: n, f: o });
    }
  }
  if (!cands.length) { game.raidT = 40; return; }
  const c = pick(cands);
  const owned = ownedCount(game);
  const raid = { id: game.nextId++, f: c.f, target: c.target, src: c.src, state: 'warn', t: RAID_WARN, size: Math.min(12, 3 + Math.floor(owned * 0.6)), alive: 0 };
  game.raids.push(raid);
  game.regionVer++;
  emit(game, { t: 'raid', r: c.target, f: c.f, eta: RAID_WARN });
}

function spawnRaid(game, raid) {
  const w = game.world;
  const core = corePos(game, raid.target);
  const list = w.spawnTiles[raid.src];
  let best = null, bd = Infinity;
  for (let k = 0; k < list.length; k += 3) {
    const i = list[k];
    const x = (i % W + 0.5) * TILE, y = ((i / W | 0) + 0.5) * TILE;
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
    spawnEnemy(game, raid.f, rollTier(game, R, 0.6), x, y, raid.src, { raid: raid.id });
    raid.alive++;
  }
  raid.state = 'active';
  raid.t = 160;
  emit(game, { t: 'raidgo', r: raid.target, f: raid.f });
}

// ------------------------------------------------------------------ network snapshots
const r1 = (v) => Math.round(v * 10) / 10;

export function regionState(game) {
  return {
    rs: game.rs.map((r) => [typeof r.owner === 'number' ? r.owner : 9, r.garrison, r.garrisonMax, Math.round(r.capture * 100), r.guards, (r.hqUnlocked ? 1 : 0) | (r.bossDefeated ? 2 : 0)]),
    raids: game.raids.map((r) => [r.target, r.f, r.state === 'warn' ? 0 : 1, Math.max(0, Math.round(r.t))]),
    vault: Math.floor(game.vault), up: game.upgrades, def: game.defeated, win: game.victory, gang: game.gangName, gc: game.gangColor,
  };
}

export function roster(game) {
  return [...game.players.values()].map((p) => ({ id: p.id, name: p.name, look: p.look, equip: p.equip, mods: p.mods, level: p.level }));
}

export function privateState(p) {
  return {
    hp: Math.ceil(p.hp), maxHp: p.maxHp, sh: Math.ceil(p.shieldHp), lvl: p.level, xp: Math.floor(p.xp), xn: xpForLevel(p.level),
    cash: Math.floor(p.cash), dead: p.dead, rt: r1(Math.max(0, p.respawnT)), cl: r1(Math.max(0, p.cloakT)),
    cd: { Q: r1(Math.max(0, p.cd.Q)), E: r1(Math.max(0, p.cd.E)), R: r1(Math.max(0, p.cd.R2)), F: r1(Math.max(0, p.cd.F)) },
    inv: p.invulnT > 0,
  };
}

export function profile(p) {
  return { armory: p.armory, equip: p.equip, mods: p.mods, level: p.level, kills: p.kills, deaths: p.deaths, speed: p.speed };
}

export function buildSnapshot(game, pid) {
  const me = game.players.get(pid);
  if (!me) return null;
  const vx = 30 * TILE, vy = 20 * TILE;
  const near = (x, y) => Math.abs(x - me.x) < vx && Math.abs(y - me.y) < vy;
  const P = [];
  for (const p of game.players.values()) {
    P.push([p.id, r1(p.x), r1(p.y), +p.aim.toFixed(2), Math.ceil(p.hp), p.maxHp, (p.dead ? 1 : 0) | (p.cloakT > 0 ? 2 : 0) | (p.shieldHp > 0 ? 4 : 0) | (p.invulnT > 0 ? 8 : 0), p.level]);
  }
  const E = [];
  for (const e of game.enemies.values()) {
    if (!near(e.x, e.y)) continue;
    E.push([e.id, e.faction * 10 + (e.boss ? 6 : e.tier), r1(e.x), r1(e.y), Math.ceil(e.hp), e.maxHp, (e.windup > 0 ? 1 : 0) | (e.flash > 0 ? 2 : 0) | (e.raid ? 4 : 0) | (e.moving ? 8 : 0), e.stars, +e.aim.toFixed(2), ATTACK_KEYS.indexOf(e.atk)]);
  }
  const A = [];
  for (const al of game.allies.values()) {
    if (!near(al.x, al.y)) continue;
    A.push([al.id, r1(al.x), r1(al.y), Math.ceil(al.hp), al.maxHp, (al.flash > 0 ? 2 : 0) | (al.moving ? 8 : 0), +al.aim.toFixed(2)]);
  }
  const K = [];
  for (const k of game.pickups.values()) if (near(k.x, k.y)) K.push([k.id, k.type === 'cash' ? 0 : 1, Math.round(k.x), Math.round(k.y), k.amount]);
  return { t: 's', tm: +game.time.toFixed(2), day: +game.dayT.toFixed(4), P, E, A, K, me: privateState(me) };
}

export { WEAPON_IDS };

// Debug helper (used for testing from the browser console): spawns an enemy next to a position.
export function debugSpawn(game, f, tier, x, y) {
  const e = spawnEnemy(game, f, tier, x, y, game.world.baseId, {});
  e.hx = x; e.hy = y;
  return e;
}
export function debugAlly(game, region) { return spawnAlly(game, region); }
