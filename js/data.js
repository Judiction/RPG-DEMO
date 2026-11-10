// Game data: weapons (arms), body mods, vehicles, turrets, upgrades, enemy factions and tiers, names, colors.
// Tweak numbers here to rebalance the game.

export const TILE = 16;

export const GAME_NAME = 'NEON QUEBRADA';

// ------------------------------------------------------------------ colors
// Gang colors (PvE: the host's gang color; PvP: players pick their gang by color).
export const GANG_COLORS = ['#ff3f8e', '#3ddc84', '#ff8a3d', '#f2f2f2', '#4f7bff', '#ffd23f'];
export const GANG_COLOR_NAMES = ['Rosa', 'Verde', 'Laranja', 'Branco', 'Azul', 'Ouro'];
export const GANG_DEFAULT_NAMES = ['Bonde Rosa', 'Tropa Verde', 'Família Laranja', 'Comando Branco', 'Bonde Azul', 'Tropa de Ouro'];
// Personal name colors: name tag, map dot and waypoint.
export const NAME_COLORS = ['#ffffff', '#ff3f8e', '#22e5ff', '#ffd23f', '#3ddc84', '#ff8a3d', '#a66bff', '#ff6a6a', '#9af0ff', '#c8ff3f'];

export const FACTIONS = [
  {
    id: 0, name: 'Milícia do Asfalto', short: 'MILÍCIA', color: '#c9c05a',
    uniform: '#59613a', uniform2: '#3d4428', accent: '#c9c05a', skin: ['#c68a5e', '#8d5a3b', '#e0b48c'],
    tiers: ['Olheiro', 'Miliciano', 'Sargento Ciborgue', 'Brutamonte', 'Caveirão'],
    boss: 'Coronel Caveira', biomes: { favela: 4, suburb: 3, jungle: 1 },
  },
  {
    id: 1, name: 'NeoBrás Segurança', short: 'NEOBRÁS', color: '#3ad0ff',
    uniform: '#d8e4ee', uniform2: '#7a8ea3', accent: '#3ad0ff', skin: ['#d9a77f', '#a8714b'],
    tiers: ['Drone Vigia', 'Segurança', 'Agente Cromado', 'Exo-Guarda', 'Mecha Executivo'],
    boss: 'CEO Androide', biomes: { downtown: 5, industrial: 2, suburb: 1 },
  },
  {
    id: 2, name: 'Comando Cromo', short: 'CROMO', color: '#a66bff',
    uniform: '#3a2457', uniform2: '#251639', accent: '#ffd23f', skin: ['#7a4a2e', '#b57a50', '#5c3620'],
    tiers: ['Pivete', 'Bandido Neon', 'Cromado', 'Pitbull Ciborgue', 'Paredão'],
    boss: 'Rei do Baile', biomes: { industrial: 3, favela: 3, suburb: 2, jungle: 1 },
  },
  {
    id: 3, name: 'Polícia Militar 2099', short: 'POLÍCIA', color: '#5a8aff', police: true,
    uniform: '#22306a', uniform2: '#141c44', accent: '#5a8aff', skin: ['#c68a5e', '#e0b48c', '#8d5a3b'],
    tiers: ['Soldado PM', 'Cabo PM', 'Choque', 'Drone PM', 'Mecha Choque'],
    boss: 'Comandante', biomes: {},
  },
];

// ------------------------------------------------------------------ maps
export const MAP_TYPES = {
  coastal: { name: 'Coastal', desc: 'A big city on the ocean, with a long beach and boardwalk.' },
  island: { name: 'Island', desc: 'One big island surrounded by sea. Beaches all around.' },
  lakes: { name: 'Lakes', desc: 'Coastal city dotted with lagoons and lakeside promenades.' },
  river: { name: 'River', desc: 'A wide river cuts the city in two. Bridges are choke points.' },
  archipelago: { name: 'Archipelago', desc: 'Several islands linked by long bridges.' },
};
export const MAP_TYPE_IDS = Object.keys(MAP_TYPES);
export const MAP_SIZES = { S: { n: 192, name: 'Small', bases: 4 }, M: { n: 256, name: 'Medium', bases: 6 }, L: { n: 320, name: 'Large', bases: 6 } };

// ------------------------------------------------------------------ enemy tiers
// bulk = sprite scale. attack: melee | gun | shotgun | burst | slam | rocket
export const TIERS = [
  null,
  { hp: 28, dmg: 5, speed: 54, bulk: 0.85, xp: 7, cash: 8, attacks: ['melee', 'gun'], aggro: 7 },
  { hp: 55, dmg: 8, speed: 56, bulk: 1.0, xp: 14, cash: 16, attacks: ['gun', 'gun', 'melee'], aggro: 8 },
  { hp: 120, dmg: 12, speed: 64, bulk: 1.25, xp: 30, cash: 36, attacks: ['melee', 'shotgun', 'burst'], aggro: 8 },
  { hp: 280, dmg: 18, speed: 50, bulk: 1.55, xp: 65, cash: 85, attacks: ['slam', 'burst'], aggro: 9 },
  { hp: 640, dmg: 26, speed: 44, bulk: 2.0, xp: 160, cash: 210, attacks: ['rocket', 'burst', 'slam'], aggro: 10 },
  // 6 = boss
  { hp: 4200, dmg: 30, speed: 50, bulk: 3.0, xp: 1500, cash: 3000, attacks: ['boss'], aggro: 14 },
];

export const ATTACKS = {
  melee: { range: 16, windup: 0.28, cd: 1.0 },
  gun: { range: 120, windup: 0.15, cd: 1.4, speed: 165 },
  shotgun: { range: 80, windup: 0.3, cd: 1.8, speed: 170, pellets: 4 },
  burst: { range: 130, windup: 0.25, cd: 2.2, speed: 185, shots: 3 },
  slam: { range: 28, windup: 0.6, cd: 2.4, radius: 34 },
  rocket: { range: 170, windup: 0.6, cd: 3.2, speed: 110, radius: 34 },
  boss: { range: 200, windup: 0.5, cd: 1.6 },
};

// ------------------------------------------------------------------ player weapons (arms)
// kind: melee | ranged | whip | slam | rocket | beam | flame
export const WEAPONS = {
  fist: {
    name: 'Cyber Fist', pt: 'Punho Cibernético', kind: 'melee', dmg: 10, cd: 0.34, range: 22, arc: 1.6, knock: 70,
    price: 0, lvl: 1, desc: 'Fast chrome punches. Reliable.',
  },
  pistol: {
    name: 'Pulse Pistol', pt: 'Pistola de Pulso', kind: 'ranged', dmg: 8, cd: 0.3, speed: 320, life: 0.7, spread: 0.05,
    proj: 'pulse', price: 0, lvl: 1, desc: 'Arm-mounted pistol. Medium range.',
  },
  blade: {
    name: 'Mantis Blade', pt: 'Lâmina Louva-a-Deus', kind: 'melee', dmg: 16, cd: 0.36, range: 28, arc: 2.4, knock: 50,
    price: 350, lvl: 2, desc: 'Wide, fast slashes that hit everything in front.',
  },
  shotgun: {
    name: 'Shotgun Arm', pt: 'Escopeta de Braço', kind: 'ranged', dmg: 7, pellets: 6, cd: 0.85, speed: 280, life: 0.36,
    spread: 0.5, proj: 'pellet', knock: 40, price: 650, lvl: 4, desc: 'Devastating up close.',
  },
  whip: {
    name: 'Monowire', pt: 'Monofio', kind: 'whip', dmg: 14, cd: 0.55, range: 64, price: 950, lvl: 6,
    desc: 'Long razor wire. Cuts through lines of enemies.',
  },
  hammer: {
    name: 'Hydraulic Fist', pt: 'Martelo Hidráulico', kind: 'slam', dmg: 34, cd: 1.15, radius: 36, knock: 200,
    price: 1350, lvl: 8, desc: 'Ground slam. Huge knockback, area damage.',
  },
  flamer: {
    name: 'Flamethrower Arm', pt: 'Lança-Chamas', kind: 'flame', dmg: 3.2, cd: 0.08, range: 62, arc: 0.6, burn: 7, burnT: 2.5,
    price: 1500, lvl: 9, desc: 'Sprays fire in a cone and sets targets ablaze. Ignites barrels.',
  },
  smg: {
    name: 'Smart SMG', pt: 'Metralhadora Smart', kind: 'ranged', dmg: 5, cd: 0.09, speed: 300, life: 0.75, spread: 0.12,
    proj: 'smart', homing: 4, price: 1700, lvl: 10, desc: 'Self-guiding bullets. Spray and pray.',
  },
  rocket: {
    name: 'Rocket Arm', pt: 'Lança-Foguete', kind: 'rocket', dmg: 46, cd: 1.5, speed: 190, life: 1.4, radius: 40,
    proj: 'rocket', price: 2300, lvl: 12, desc: 'Explosive rockets. Watch the splash.',
  },
  rail: {
    name: 'Rail Arm', pt: 'Canhão Trilho', kind: 'beam', dmg: 60, cd: 1.5, range: 230, price: 3400, lvl: 15,
    desc: 'Instant piercing beam through every enemy in line.',
  },
};
export const WEAPON_IDS = Object.keys(WEAPONS);
export const MAX_WEAPON_LVL = 5;
export const weaponMult = (lvl) => 1 + 0.3 * (lvl - 1);
export const weaponUpgradePrice = (id, lvl) => Math.round(Math.max(180, WEAPONS[id].price * 0.6) * lvl);

// ------------------------------------------------------------------ body mods
export const MODS = {
  armor: {
    name: 'Subdermal Armor', pt: 'Blindagem', prices: [300, 750, 1400, 2300, 3500],
    desc: (l) => `+${l * 20} max HP, -${l * 6}% damage taken`,
  },
  legs: {
    name: 'Leg Servos', pt: 'Pernas de Mola', prices: [250, 650, 1200, 2000, 3000],
    desc: (l) => `+${l * 7}% speed. Unlocks DASH [Q / SPACE / SHIFT]`,
  },
  nanite: {
    name: 'Nanite Regen', pt: 'Nanorregeneração', prices: [300, 700, 1300, 2100, 3200],
    desc: (l) => `+${(l * 0.8).toFixed(1)} HP/s. Unlocks NANO-HEAL [E]`,
  },
  optic: {
    name: 'Optical Camo', pt: 'Camuflagem Óptica', prices: [500, 1000, 1700, 2600, 3800],
    desc: (l) => `CLOAK [R] for ${3 + l}s. Enemies lose you. 2x damage from stealth`,
  },
  shield: {
    name: 'Kinetic Shield', pt: 'Escudo Cinético', prices: [400, 900, 1500, 2400, 3600],
    desc: (l) => `SHIELD [F] absorbs ${30 + l * 25} damage for 5s`,
  },
};
export const MOD_IDS = Object.keys(MODS);

export const ABILITIES = {
  Q: { mod: 'legs', name: 'Dash', cd: (l) => 3.2 - l * 0.25 },
  E: { mod: 'nanite', name: 'Nano-Heal', cd: (l) => 16 - l },
  R: { mod: 'optic', name: 'Cloak', cd: (l) => 22 - l * 2 },
  F: { mod: 'shield', name: 'Shield', cd: () => 18 },
};

// ------------------------------------------------------------------ player progression
export const BASE_HP = 100;
export const BASE_SPEED = 72;            // px / s
export const xpForLevel = (lvl) => Math.round(40 * Math.pow(lvl, 1.65));
export const MAX_LEVEL = 40;
export const RESPAWN_TIME = 5;
export const DEATH_CASH_LOSS = 0.25;
export const FOLLOWER_MAX = 4;           // followers per player in total (crew from captures + recruited civilians)

// Recoil impulse (px/s) pushed into the shooter when firing. Negative = lunge forward (melee).
export const RECOIL = { fist: -30, pistol: 32, blade: -40, shotgun: 120, whip: 24, hammer: -70, flamer: 10, smg: 14, rocket: 150, rail: 180 };
export const EXPLOSION_PUSH = 300;       // knockback (px/s) at the center of an explosion

// ------------------------------------------------------------------ civilians
export const CIV = {
  perPlayer: 9,          // civilians kept around each player
  max: 46,               // in the whole city at once
  hp: 45, speed: 26, fleeSpeed: 78,
  repStart: 45,          // starting reputation of a gang in a district (0..100)
  repOwnBonus: 25,       // extra reputation in your own districts
  repNeed: 30,           // reputation needed to recruit
  repHurt: 6, repKill: 25,
};

// ------------------------------------------------------------------ vehicles
// Flying vehicles fly over buildings. Charge drains while flying; empty = slow crawl on the ground.
export const VEHICLES = {
  moto: {
    name: 'Flying Moto', pt: 'Moto Voadora', seats: 2, gunners: [1], hp: 180, speed: 178, crawl: 34, charge: 100,
    drain: 0.8, r: 9, price: 1500, desc: '2 seats: a driver and a gunner behind.',
  },
  car: {
    name: 'Flying Car', pt: 'Carro Voador', seats: 4, gunners: [1, 2, 3], hp: 380, speed: 150, crawl: 28, charge: 100,
    drain: 0.65, r: 12, price: 3000, desc: '4 seats: a driver and 3 gunners.',
  },
};
export const VEHICLE_IDS = Object.keys(VEHICLES);
export const BATTERY_PRICE = 80;         // a battery cell bought at the QG
export const BATTERY_CHARGE = 60;
export const MAX_VEHICLES = 18;
export const VEHICLE_RESPAWN = 150;      // seconds until a wreck is replaced somewhere in the city

// ------------------------------------------------------------------ gang vault upgrades (whole gang)
export const VAULT_UPGRADES = {
  training: { name: 'Guard Training', desc: 'Guards, crew and turrets get tougher and hit harder', prices: [800, 1800, 3500, 6000, 9000] },
  count: { name: 'More Recruits', desc: '+1 guard at every compound', prices: [1000, 2600, 5200] },
  income: { name: 'Business Network', desc: '+25% compound income', prices: [1200, 3000, 6500] },
  bounty: { name: 'Bounty Board', desc: '+15% cash from kills', prices: [1200, 3000, 6000] },
  market: { name: 'Black Market', desc: '-8% prices on arms, mods and battery cells', prices: [1500, 3500, 7000] },
  intel: { name: 'Informants', desc: '+15s warning before raids', prices: [1000, 2500] },
  rescue: { name: 'Rescue Squad', desc: '-1.5s respawn time', prices: [900, 2200] },
};
export const BASE_GUARDS = 2;
export const COMPOUND_INCOME = 6;        // R$ per income tick (every 10 s) per compound, + tier

// ------------------------------------------------------------------ compound (district) upgrades
export const TURRETS = {
  mg: { name: 'Machine Gun', pt: 'Metralhadora', price: 600, range: 135, cd: 0.16, dmg: 5, hp: 260, desc: 'Fast bullets. Good all-rounder.' },
  rocket: { name: 'Rocket Pod', pt: 'Lança-Mísseis', price: 1200, range: 180, cd: 2.4, dmg: 42, aoe: 36, hp: 300, desc: 'Slow explosive rockets. Shreds groups.' },
  tesla: { name: 'Tesla Coil', pt: 'Bobina Tesla', price: 1000, range: 80, cd: 1.0, dmg: 20, chain: 3, hp: 280, desc: 'Zaps up to 3 targets close by.' },
  flamer: { name: 'Flame Turret', pt: 'Torre de Fogo', price: 900, range: 62, cd: 0.12, dmg: 3.5, hp: 340, desc: 'Short range fire cone. Burns.' },
  rail: { name: 'Rail Sentry', pt: 'Sentinela Trilho', price: 1800, range: 235, cd: 2.6, dmg: 75, hp: 240, desc: 'Long range piercing beam.' },
};
export const TURRET_IDS = Object.keys(TURRETS);
export const TURRET_MAX_MK = 3;
export const turretMult = (mk) => 1 + 0.4 * (mk - 1);
export const turretUpgradePrice = (id, mk) => Math.round(TURRETS[id].price * 0.7 * mk);
export const TURRET_REPAIR = 60;         // seconds for a destroyed turret to come back online

export const COMPOUND_UPS = {
  level: { name: 'Fortify', desc: '+1 turret slot (2 → 4)', prices: [1200, 3000] },
  walls: { name: 'Armored Walls', desc: 'Raiders capture 25% slower per level; guards and turrets here take 12% less damage', prices: [700, 1600, 3200] },
  barracks: { name: 'Barracks', desc: '+1 guard here per level', prices: [800, 2000] },
  medic: { name: 'Medic Post', desc: 'Heals your players, guards and crew inside the compound', prices: [900] },
  pad: { name: 'Charge Pad', desc: 'Recharges and repairs flying vehicles parked here', prices: [700] },
  radar: { name: 'Radar Tower', desc: 'Shows hostiles in this district on your minimap; +15s raid warning here', prices: [600] },
  boca: { name: 'Boca de Fumo', desc: 'More customers come, and they spend more. The money goes to the gang vault', prices: [900, 2400, 5000] },
};
// the boca de fumo in every gang compound: locals walk in and buy (money → gang vault). Index = upgrade level.
export const BOCA = {
  interval: [14, 10, 7.5, 5.5],                    // seconds between customers (better reputation = more often)
  spend: [[10, 18], [15, 25], [20, 34], [28, 46]],  // R$ per customer
  maxWalking: 4,                                    // customers on their way at once (per boca)
};
// crew (followers) level up with kills
export const CREW_LVL = { kills: [0, 3, 8, 15, 25], hp: 0.25, dmg: 0.2, rate: 0.08 };
export const COMPOUND_UP_IDS = Object.keys(COMPOUND_UPS);

// ------------------------------------------------------------------ raids
export const RAID_WARN = 30;
export const RAID_INTERVAL = (owned) => Math.max(130, 260 - owned * 6);
export const RAID_SIZE = (owned) => Math.min(18, 5 + Math.floor(owned * 0.8));

// ------------------------------------------------------------------ PvP
export const PVP_WIN_SHARE = 0.6;        // hold 60% of the city to win
export const PVP_BASE_NAMES = ['QG da Laje', 'QG do Morro', 'QG da Orla', 'QG do Porto', 'QG do Viaduto', 'QG da Quebrada'];

// ------------------------------------------------------------------ customization
export const LOOK_OPTIONS = {
  skin: ['#f1c9a5', '#e0ac7e', '#c68a5e', '#a8714b', '#7a4a2e', '#4e2e1c'],
  hair: ['buzz', 'afro', 'braids', 'mohawk', 'long', 'cap', 'bald', 'bun'],
  hairColor: ['#1a1414', '#4a2c1a', '#e3c16f', '#ff3fa4', '#22e5ff', '#3ddc84', '#f2f2f2', '#ff6a2b', '#d01e2e', '#8a2a1a', '#a66bff', '#ffd23f', '#3a5aff', '#8a8a96'],
  jacket: ['#ff3f8e', '#22e5ff', '#ffd23f', '#3ddc84', '#ff8a3d', '#a66bff', '#f2f2f2', '#2b2b3a', '#d01e2e', '#7a1424', '#3a5a8c', '#5a3a2a', '#ff9ad8', '#c8ff3f', '#1e6a4a', '#e8d8a0'],
  pants: ['#23243a', '#3a5a8c', '#6b4b2a', '#1d1d1d', '#5a2a4a', '#a01e2a', '#c8c0b0', '#2a4a3a', '#e8e4d8', '#4a4a56'],
};
export const LOOK_KEYS = Object.keys(LOOK_OPTIONS);

export function randomLook() {
  const look = {};
  for (const k of LOOK_KEYS) look[k] = Math.floor(Math.random() * LOOK_OPTIONS[k].length);
  return look;
}

// ------------------------------------------------------------------ names
export const NAME_PARTS = {
  beach: [['Praia do', 'Orla do', 'Posto', 'Praia da'], ['Coqueiro', 'Neon', 'Sol', 'Leme', 'Arpoador', 'Silício', 'Plasma', 'Farol']],
  favela: [['Morro do', 'Complexo do', 'Morro da', 'Vila', 'Comunidade'], ['Silício', 'Cromo', 'Pixel', 'Dendê', 'Caju', 'Laser', 'Byte', 'Açaí', 'Antena', 'Gato-Net']],
  downtown: [['Centro', 'Largo do', 'Av.', 'Torres do', 'Distrito'], ['Holograma', 'Quasar', 'Vidro', 'Ômega', 'Cristal', 'Ouro', 'Néon', 'Turbo']],
  suburb: [['Jardim', 'Vila', 'Parque', 'Conjunto', 'Bairro'], ['Esperança', 'Circuito', 'Samba', 'Aurora', 'Primavera', 'Cobre', 'Satélite', 'Batuque']],
  industrial: [['Porto', 'Cais do', 'Zona', 'Galpões do', 'Docas do'], ['Ferro', 'Óleo', 'Contêiner', 'Ferrugem', 'Diesel', 'Carga', 'Reator']],
  jungle: [['Mata do', 'Parque', 'Selva do', 'Reserva'], ['Tucano', 'Cipó', 'Jacaré', 'Mico', 'Bromélia', 'Orvalho']],
};

export const BIOME_LABEL = {
  base: 'Gang HQ', beach: 'Beach', favela: 'Favela', downtown: 'Downtown', suburb: 'Suburb',
  industrial: 'Docks', jungle: 'Jungle',
};

// ------------------------------------------------------------------ fake brands for neon signs, billboards and holograms
// logo: a small pixel icon drawn in sprites.js. cat: which buildings use it.
export const BRANDS = [
  { name: 'ZAP COLA', c: '#ff3b5c', c2: '#ffffff', logo: 'bottle', cat: 'food' },
  { name: 'GUARANA VOLT', c: '#3ddc84', c2: '#ff3b3b', logo: 'bolt', cat: 'food' },
  { name: 'ACAI.EXE', c: '#b06bff', c2: '#ff7ad8', logo: 'bowl', cat: 'food' },
  { name: 'NEOBRAS', c: '#3ad0ff', c2: '#ffffff', logo: 'tri', cat: 'corp' },
  { name: 'CROMO BANK', c: '#ffd23f', c2: '#fff6c0', logo: 'coin', cat: 'corp' },
  { name: 'BAILE 3000', c: '#ff3fa4', c2: '#ffd23f', logo: 'speaker', cat: 'night' },
  { name: 'LAN HOUSE', c: '#22e5ff', c2: '#3ddc84', logo: 'monitor', cat: 'shop' },
  { name: 'FARMACIA 24H', c: '#3ddc84', c2: '#ffffff', logo: 'cross', cat: 'shop' },
  { name: 'MOTEL ORBITA', c: '#ff4fd8', c2: '#ffd23f', logo: 'heart', cat: 'night' },
  { name: 'TATTOO', c: '#ff6a2b', c2: '#ffd23f', logo: 'star', cat: 'shop' },
  { name: 'PASTEL++', c: '#ffd23f', c2: '#ff8a3d', logo: 'moon', cat: 'food' },
  { name: 'SAMBA NET', c: '#ff8a3d', c2: '#22e5ff', logo: 'wifi', cat: 'corp' },
  { name: 'CAFE MATRIX', c: '#ffb84a', c2: '#3ddc84', logo: 'cup', cat: 'food' },
  { name: 'ROBO FIX', c: '#22e5ff', c2: '#ffd23f', logo: 'gear', cat: 'shop' },
  { name: 'IMPLANTES', c: '#ff3fa4', c2: '#22e5ff', logo: 'eye', cat: 'shop' },
  { name: 'BOTECO', c: '#ffd23f', c2: '#ffffff', logo: 'mug', cat: 'night' },
  { name: 'TAXI AEREO', c: '#ffd23f', c2: '#22e5ff', logo: 'wing', cat: 'corp' },
  { name: 'CHURRASCO', c: '#ff6a2b', c2: '#ffd23f', logo: 'flame', cat: 'food' },
  { name: 'FUTEBOL+', c: '#3ddc84', c2: '#ffffff', logo: 'ball', cat: 'night' },
  { name: 'HOTEL', c: '#a66bff', c2: '#ffffff', logo: 'star', cat: 'night' },
  { name: 'DIESEL BR', c: '#ff8a3d', c2: '#ffffff', logo: 'drop', cat: 'ind' },
  { name: 'CONTEINER SA', c: '#22e5ff', c2: '#ff8a3d', logo: 'box', cat: 'ind' },
  { name: 'FERRO&CIA', c: '#ffd23f', c2: '#ff3b5c', logo: 'gear', cat: 'ind' },
  { name: 'SORVETE', c: '#ff9ad8', c2: '#9af0ff', logo: 'cone', cat: 'food' },
];

// ------------------------------------------------------------------ breakable props (shoot them and they explode)
export const BREAK_INFO = {
  xbarrel: { hp: 20, r: 42, dmg: 60, kind: 'fire' },
  gastank: { hp: 16, r: 46, dmg: 66, kind: 'fire' },
  transformer: { hp: 40, r: 48, dmg: 44, kind: 'zap' },
  car: { hp: 120, r: 52, dmg: 62, kind: 'fire' },
};

// ------------------------------------------------------------------ bar drinks and dealer stims (3-slot belt, keys 1/2/3)
// eff: dmg (damage mult), speed, armor (damage taken mult), rof (cooldown mult), regen (HP/s), heal (fraction now),
//      cure, ghost (enemies lose you), dash (dash cooldown), crit (extra crit chance), radar, cheat (survive one death)
export const DRINKS = {
  caipirinha: { name: 'Caipirinha Neon', price: 260, t: 180, eff: { dmg: 1.2 }, c: '#7dff9a', desc: '+20% damage for 3 min' },
  guarana: { name: 'Guaraná Volt', price: 220, t: 180, eff: { speed: 1.25 }, c: '#ff3b3b', desc: '+25% move speed for 3 min' },
  acai: { name: 'Açaí Nanotech', price: 240, t: 120, eff: { heal: 0.4, regen: 2 }, c: '#a66bff', desc: 'Heal 40% now, then +2 HP/s for 2 min' },
  cerveja: { name: 'Cerveja Cromada', price: 200, t: 180, eff: { armor: 0.85, sway: 1 }, c: '#ffd23f', desc: 'Take 15% less damage for 3 min (a little tipsy)' },
  chopp: { name: 'Chopp Turbo', price: 300, t: 150, eff: { rof: 0.8 }, c: '#ffb84a', desc: '+25% fire rate for 2.5 min' },
  coco: { name: 'Água de Coco', price: 90, t: 0, eff: { cure: 1, heal: 0.15 }, c: '#e8f4d8', desc: 'Cures poison and burning, small heal' },
};
export const STIMS = {
  porosa: { name: 'Pó Rosa', price: 700, t: 150, eff: { dmg: 1.5, knock: 2 }, c: '#ff3fa4', desc: '+50% damage and huge knockback for 2.5 min' },
  balao: { name: 'Balão', price: 800, t: 100, eff: { ghost: 1, speed: 1.2 }, c: '#9af0ff', desc: 'Near-invisible: enemies and police lose you, +20% speed (100s)' },
  pedra: { name: 'Pedra Azul', price: 700, t: 120, eff: { armor: 0.5 }, c: '#4f7bff', desc: 'Take 50% less damage for 2 min' },
  lolo: { name: 'Loló', price: 600, t: 120, eff: { speed: 1.6, dash: 1 }, c: '#ffd23f', desc: '+60% speed and 1s dash cooldown for 2 min' },
  bala: { name: 'Bala', price: 600, t: 150, eff: { crit: 0.3, radar: 1 }, c: '#ff8a3d', desc: '+30% crit chance, every enemy near you shows on the minimap (2.5 min)' },
  doce: { name: 'Doce', price: 900, t: 240, eff: { cheat: 1 }, c: '#3ddc84', desc: 'Cheat death once in the next 4 min (get back up at 50% HP)' },
};
export const ITEMS = { ...DRINKS, ...STIMS };
export const BELT_SIZE = 3;
export const BAD_BATCH = { chance: 0.2, dps: 3, t: 20 };

// ------------------------------------------------------------------ police
// Crimes that civilians witness raise your heat. 100 heat = 1 star, up to 5.
export const WANTED = {
  shotSeen: 3,            // shooting with civilians nearby
  hurtCiv: 25, killCiv: 60, boomSeen: 35, hitCop: 30, killCop: 45,
  witnessRange: 11,       // tiles
  decay: 1.5,             // heat lost per second while no cop is near
  escapeRange: 24,        // tiles away from every cop...
  escapeTime: 14,         // ...for this long and you lose them
  bribe: 350,             // R$ per star to pay off your wanted level at your base
};
// what each wanted level sends (tiers of the police faction)
export const POLICE_WAVES = [
  null,
  [1, 1],
  [1, 1, 2, 2],
  [1, 2, 2, 2, 3, 3],
  [2, 3, 3, 3, 3, 4],
  [3, 3, 3, 3, 4, 4, 5],
];

// ------------------------------------------------------------------ bar interior layout (pixels, interior space)
// One shared layout (colors and names change per bar). Solid rects block movement.
// machines bleed oil and sparks instead of blood (faction → tiers that are drones, mechs, armored trucks)
const MECH_TIERS = { 0: [5], 1: [1, 5], 2: [5], 3: [4, 5] };
export const isMech = (faction, tier, boss = false) => !boss && !!(MECH_TIERS[faction] && MECH_TIERS[faction].includes(tier));

export const BAR_ROOM = {
  w: 544, h: 304,
  door: { x: 272, y: 300 },
  counter: { x: 24, y: 64, w: 34, h: 176 },        // the bar counter along the left wall (bartender behind it)
  dealer: { x: 486, y: 50 },                         // back corner, right
  dj: { x: 220, y: 18, w: 104, h: 30 },             // DJ booth (top center)
  floor: { x: 176, y: 80, w: 192, h: 128 },         // dancefloor
  solids: [
    { x: 0, y: 0, w: 544, h: 16 }, { x: 0, y: 0, w: 16, h: 304 }, { x: 528, y: 0, w: 16, h: 304 },
    { x: 0, y: 288, w: 256, h: 16 }, { x: 288, y: 288, w: 256, h: 16 },
    { x: 24, y: 64, w: 34, h: 176 },                 // counter
    { x: 220, y: 18, w: 104, h: 30 },                // DJ booth
    { x: 420, y: 120, w: 40, h: 24 }, { x: 420, y: 196, w: 40, h: 24 },   // tables
    { x: 470, y: 230, w: 50, h: 40 },                // sofa booth
  ],
};
