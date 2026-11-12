// Canvas renderer.
// Pipeline per frame:
//   1. ground (cached tile chunks), y-sorted ground sprites (props, characters, turrets...)
//   2. lighting: a colored light map (dark ambient + every light source added) multiplied over the scene
//   3. emissive things drawn at full brightness (neon props, bullets, muzzle flashes, explosions, fire)
//   4. GTA2-style 3D buildings, projected with a perspective camera (walls lean away from the screen center),
//      baked for the current light (lit windows and neon stay bright)
//   5. bloom, flying vehicles, holograms, silhouettes of players hidden behind buildings, tags and overlays
// The game is drawn at low resolution (~640 px wide) and scaled up with crisp pixels.

import { TILE, FACTIONS, WEAPONS, GANG_COLORS, VEHICLES, BRANDS, BAR_ROOM, ITEMS, isMech, CREW_WEAPONS, DOWN, GRENADES, ALIENS, JAIL_ROOM } from './data.js';
import { T, CHUNK, STATION_COLORS } from './world.js';
import {
  getTileset, charSprite, armSprite, propSprite, playerSpec, enemySpec, allySpec, followerSpec, civilianSpec, ENEMY_ARM,
  flashOf, shade, rgba, mk, breakSprite, vehicleSprite, turretBase, turretHead, holoSprite, hexToRgb, drawLogo, petSprite,
} from './sprites.js';
import { CAM_Z, projK, buildingArt, bakeBuilding, neonState, neonIsOff } from './buildings.js';
import { drawText, textSprite } from './font.js';
import { hash2 } from './rng.js';

const CH_PX = CHUNK * TILE;
const STATION_IDX = { arsenal: 0, clinic: 1, locker: 2, vault: 3, garage: 4 };
const CLOTH = ['#ff3f8e', '#22e5ff', '#ffd23f', '#f2f2f2', '#3ddc84', '#ff8a3d', '#a66bff', '#3a5a8c', '#d01e2e'];
const STATION_LABEL = { arsenal: 'ARSENAL', clinic: 'CLINICA', locker: 'ARMARIO', vault: 'COFRE', garage: 'GARAGEM' };

export const ownerColorOf = (owner) => (typeof owner === 'string' && owner[0] === 'g' ? GANG_COLORS[Number(owner.slice(1))] || '#fff' : FACTIONS[owner] ? FACTIONS[owner].color : '#888');

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Ambient light color [r, g, b] (0..1) for a time of day. Days feel like dusk, nights are very dark.
export function ambientOf(dayT) {
  const sun = Math.sin((dayT - 0.25) * Math.PI * 2);
  const day = smooth(-0.25, 0.55, sun);
  const dusk = Math.max(0, 1 - Math.abs(sun + 0.05) * 2.6);
  const night = [0.10, 0.09, 0.19], noon = [0.74, 0.69, 0.79];
  return [0, 1, 2].map((i) => night[i] + (noon[i] - night[i]) * day + [0.16, 0.03, -0.02][i] * dusk);
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const light = mk(4, 4);
  const lctx = light.getContext('2d');
  const R = {
    canvas, ctx, vw: 640, vh: 360, scale: 2,
    cam: { x: 0, y: 0 }, shake: 0, world: null, chunks: new Map(),
    particles: [], texts: [], effects: [], anim: new Map(), ghosts: [], decals: [], stains: [], bloodOn: true, grenades: [], areas: [],
    mouse: { x: 0, y: 0 }, time: 0, specCache: new Map(), flashT: 0, flashCol: '#ff0000', smokeT: 0,
    quality: 'high', bakeBudget: 0, dynLights: [], trans: new Map(),
  };

  R.resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    R.scale = Math.max(1, Math.round(Math.max(w / 660, h / 380)));
    R.vw = Math.ceil(w / R.scale);
    R.vh = Math.ceil(h / R.scale);
    canvas.width = R.vw; canvas.height = R.vh;
    canvas.style.width = R.vw * R.scale + 'px';
    canvas.style.height = R.vh * R.scale + 'px';
    light.width = Math.ceil(R.vw / 2); light.height = Math.ceil(R.vh / 2);
    ctx.imageSmoothingEnabled = false;
  };
  R.resize();

  R.setWorld = (world) => {
    R.world = world; R.chunks.clear(); R.anim.clear(); R.particles = []; R.texts = []; R.effects = []; R.decals = []; R.stains = [];
    // buildings bucketed by chunk for quick culling
    if (world) {
      R.bgrid = Array.from({ length: world.gridW * world.gridH }, () => []);
      const all = world.buildings.slice();
      for (const Rg of world.regions) for (const w of Rg.compound.walls || []) {
        all.push({ x: w.x, y: w.y, w: w.w, h: w.h, style: 'cwall', floors: 1, H: Rg.base ? 12 : 10, seed: (w.x * 7919 + w.y * 104729) % 1e9, compound: Rg.id, fr: 0 });
      }
      for (const b of all) {
        const gx = Math.min(world.gridW - 1, Math.floor((b.x + b.w / 2) / CHUNK)), gy = Math.min(world.gridH - 1, Math.floor((b.y + b.h / 2) / CHUNK));
        R.bgrid[gy * world.gridW + gx].push(b);
      }
    }
  };

  R.screenToWorld = (sx, sy) => ({ x: sx / R.scale + R.cam.x - R.vw / 2, y: sy / R.scale + R.cam.y - R.vh / 2 });

  // ---------------------------------------------------------------- chunks
  function chunk(cx, cy) {
    const key = cy * 1000 + cx;
    let c = R.chunks.get(key);
    if (c) return c;
    c = renderChunk(R.world, cx, cy);
    R.chunks.set(key, c);
    if (R.chunks.size > 80) R.chunks.delete(R.chunks.keys().next().value);
    return c;
  }

  // ---------------------------------------------------------------- effects API
  R.text = (x, y, str, color, life = 0.9, vy = -24) => R.texts.push({ x, y, str, color, t: 0, life, vy });
  R.burst = (x, y, colors, n = 8, speed = 60, life = 0.5, g = 0, em = false) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      R.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (g ? 30 : 0), life: life * (0.5 + Math.random() * 0.5), t: 0, c: colors[(Math.random() * colors.length) | 0], g, sz: Math.random() < 0.3 ? 2 : 1, em });
    }
  };
  R.flame = (x, y, a, r) => {
    for (let i = 0; i < 6; i++) {
      const aa = a + (Math.random() - 0.5) * 0.6, s = r * (2.2 + Math.random() * 1.6);
      R.particles.push({ x, y, vx: Math.cos(aa) * s, vy: Math.sin(aa) * s, life: 0.25 + Math.random() * 0.15, t: 0, c: ['#ffd23f', '#ff8a3d', '#ff3b3b', '#fff6c0'][(Math.random() * 4) | 0], g: -40, sz: Math.random() < 0.5 ? 2 : 3, em: true, fire: true });
    }
  };
  R.smoke = (x, y, col = '#6a6676', n = 1, vy = -14, life = 1.6, hi = false) => {
    for (let i = 0; i < n; i++) R.particles.push({ x: x + (Math.random() - 0.5) * 4, y, vx: (Math.random() - 0.5) * 6, vy: vy * (0.7 + Math.random() * 0.6), life, t: 0, c: col, g: 0, sz: 2 + (Math.random() < 0.4 ? 1 : 0), smoke: true, hi });
  };
  R.effect = (e) => { e.t = 0; R.effects.push(e); };
  R.addShake = (v) => { R.shake = Math.min(10, R.shake + v); };
  R.screenFlash = (col, t = 0.25) => { R.flashCol = col; R.flashT = t; };
  R.light = (x, y, r, c, life = 0.08, i = 1.2) => R.dynLights.push({ x, y, r, c, life, t: 0, i });
  R.swing = (key, slot, ang, kind, dur = 0.18) => {
    const a = animOf(key);
    a.swT = 0; a.swDur = dur; a.swSlot = slot; a.swKind = kind; a.swAng = ang;
  };
  R.recoil = (key, slot) => { const a = animOf(key); if (slot === 'L') a.recL = 0.08; else a.recR = 0.08; };
  R.ghost = (x, y, sprite) => R.ghosts.push({ x, y, s: sprite, t: 0 });
  // big, layered explosion: flash, fireball, shockwave, sparks, smoke plume, scorch mark and a light pulse
  R.explosion = (x, y, r, kind = 'fire') => {
    R.effect({ k: 'boom', x, y, r, life: 0.55, zap: kind === 'zap' });
    R.effect({ k: 'shock', x, y, r: r * 1.7, life: 0.32, c: kind === 'zap' ? '#9af0ff' : '#fff0c0' });
    R.burst(x, y, kind === 'zap' ? ['#ffffff', '#9af0ff', '#4f7bff'] : ['#ffffff', '#ffd23f', '#ff8a3d', '#ff3b3b'], 34, r * 4, 0.7, 160, true);
    R.burst(x, y, ['#ffd23f', '#ff6a2b'], 12, r * 1.6, 1.4, 60, true);
    for (let i = 0; i < 10; i++) R.smoke(x + (Math.random() - 0.5) * r, y - Math.random() * r * 0.4, Math.random() < 0.5 ? '#2a2630' : '#4a4652', 1, -12 - Math.random() * 14, 2.2 + Math.random() * 1.4, true);
    R.decals.push({ x, y, r: r * 0.7, t: 0, life: 30 });
    if (R.decals.length > 40) R.decals.shift();
    R.dynLights.push({ x, y, r: r * 4, c: kind === 'zap' ? '#9af0ff' : '#ffc070', life: 0.6, t: 0, i: 2.2, boom: true });
  };

  function animOf(key) {
    let a = R.anim.get(key);
    if (!a) { a = { lx: null, ly: null, dist: 0, moving: false, still: 0, swT: 9, swDur: 0.18, swSlot: 'R', swKind: '', swAng: 0, recL: 0, recR: 0 }; R.anim.set(key, a); }
    return a;
  }

  // ---------------------------------------------------------------- main draw
  R.draw = (view, dt) => {
    R.time += dt;
    const world = view.world;
    if (!world) return;
    if (view.interior) { drawInterior(view, dt); return; }
    const me = view.me;
    const WW = world.W, HH = world.H;
    // camera (with a little look-ahead toward the mouse)
    const look = me && !me.dead ? { x: (R.mouse.x / R.scale - R.vw / 2) * 0.22, y: (R.mouse.y / R.scale - R.vh / 2) * 0.22 } : { x: 0, y: 0 };
    const tx = (me ? me.x : WW * TILE / 2) + look.x, ty = (me ? me.y - 8 - (me.alt || 0) : HH * TILE / 2) + look.y;
    if (R.snapCam) { R.cam.x = tx; R.cam.y = ty; R.snapCam = false; }
    R.cam.x += (tx - R.cam.x) * Math.min(1, dt * 7);
    R.cam.y += (ty - R.cam.y) * Math.min(1, dt * 7);
    R.shake = Math.max(0, R.shake - dt * 20);
    let sx = (Math.random() - 0.5) * R.shake, sy = (Math.random() - 0.5) * R.shake;
    if (view.sway) { sx += Math.sin(R.time * 0.9) * 5; sy += Math.sin(R.time * 0.63 + 1) * 3; }
    const ox = Math.round(R.cam.x - R.vw / 2 + sx), oy = Math.round(R.cam.y - R.vh / 2 + sy);
    R.ox = ox; R.oy = oy;
    const emq = [];
    const amb = ambientOf(view.dayT ?? 0.3);
    const night = Math.max(0, Math.min(1, (0.62 - amb[1]) / 0.5));
    R.night = night;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0f4c72';
    ctx.fillRect(0, 0, R.vw, R.vh);

    // ---- 1. ground
    const c0 = Math.max(0, Math.floor(ox / CH_PX)), c1 = Math.min(Math.ceil(WW / CHUNK) - 1, Math.floor((ox + R.vw) / CH_PX));
    const r0 = Math.max(0, Math.floor(oy / CH_PX)), r1 = Math.min(Math.ceil(HH / CHUNK) - 1, Math.floor((oy + R.vh) / CH_PX));
    const visChunks = [];
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) { const ch = chunk(cx, cy); visChunks.push([ch, cx, cy]); ctx.drawImage(ch.c, cx * CH_PX - ox, cy * CH_PX - oy); }

    ctx.translate(-ox, -oy);
    drawWater(world, ox, oy);
    drawDecals(dt);
    drawStains(dt);
    for (const h of view.helis || []) shadow(h.x + 10, h.y + 14, 13, 0.25);
    if (view.ufo) { const q = ufoPos(view.ufo); ctx.fillStyle = `rgba(4,2,12,${Math.max(0.08, 0.32 - (q.z - 110) / 900)})`; pixCircleFill(q.x + 12, q.y + 16, 44, 0.42); }
    drawCores(view);
    for (const e of R.effects) if (e.k === 'tele') {
      const p = Math.min(1, e.t / e.d);
      ctx.fillStyle = rgba('#ff3b5c', 0.12 + 0.18 * p);
      pixCircleFill(e.x, e.y, e.r * p);
      pixCircle(e.x, e.y, e.r, '#ff3b5c');
    }
    drawWaypointMarkers(view);
    for (const k of view.pickups) {
      const bob = Math.sin(R.time * 5 + k.id) * 1.5;
      shadow(k.x, k.y + 2, 4);
      if (k.type === 'cash') {
        ctx.fillStyle = '#2fa84f'; ctx.fillRect(k.x - 4, k.y - 6 + bob, 8, 5);
        ctx.fillStyle = '#7dff9a'; ctx.fillRect(k.x - 3, k.y - 5 + bob, 6, 1);
        ctx.fillStyle = '#ffd23f'; ctx.fillRect(k.x - 1, k.y - 5 + bob, 2, 3);
      } else if (k.type === 'ufo') {
        const sp = armSprite('ufo', '#a8b4bc');
        ctx.drawImage(sp, Math.round(k.x - 11), Math.round(k.y - 13 + bob));
        if (Math.random() < 0.25) R.particles.push({ x: k.x + (Math.random() - 0.5) * 14, y: k.y - 8, vx: 0, vy: -18, life: 0.6, t: 0, c: Math.random() < 0.5 ? '#7dff4a' : '#d8ffd0', g: 0, sz: 1, em: true });
      } else {
        ctx.fillStyle = '#1f9e3a'; ctx.fillRect(k.x - 2, k.y - 9 + bob, 5, 8);
        ctx.fillStyle = '#ff3b3b'; ctx.fillRect(k.x - 2, k.y - 7 + bob, 5, 3);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(k.x - 1, k.y - 9 + bob, 3, 1);
      }
    }

    // y-sorted ground sprites
    const list = [];
    const inView = (x, y, mx = 40, my = 60) => x > ox - mx && x < ox + R.vw + mx && y > oy - 10 && y < oy + R.vh + my;
    const gx0 = Math.max(0, Math.floor((ox - 40) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 40) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 20) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 60) / CH_PX));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const gi = gy * world.gridW + gx;
      for (const p of world.propGrid[gi]) if (inView(p.x, p.y)) list.push({ y: p.y, p });
      for (const b of world.breakGrid[gi]) if (inView(b.x, b.y)) list.push({ y: b.y, b });
      if (world.hangGrid) for (const h of world.hangGrid[gi]) {
        if (!inView(h.x, h.y)) continue;
        const rs = view.rs[h.region];
        if (rs && typeof rs.owner === 'string' && !(rs.capture > 0)) list.push({ y: h.y, hg: h, own: rs.owner });
      }
    }
    for (const p of view.players) if (!p.dead && !p.veh && !(p.bar >= 0)) list.push({ y: p.y, pl: p });
    for (const e of view.enemies) list.push({ y: e.y, en: e });
    for (const a of view.allies) list.push({ y: a.y, al: a });
    for (const c of view.civs || []) if (inView(c.x, c.y)) list.push({ y: c.y, cv: c });
    for (const a of view.pets || []) if (inView(a.x, a.y)) list.push({ y: a.y, pt: a });
    for (const ch of world.churches || []) if (inView(ch.px, ch.py)) list.push({ y: ch.py, pr: ch });
    const raised = [];
    for (const t of view.turrets || []) { if (world.tiles[Math.floor(t.y / TILE - 0.2) * world.W + Math.floor(t.x / TILE)] === T.WALL) raised.push(t); else list.push({ y: t.y, tu: t }); }
    const flying = [];
    for (const v of view.vehicles || []) {
      if (!inView(v.x, v.y, 80, 100)) continue;
      if (v.flying) { flying.push(v); hoverGround(v, dt); } else list.push({ y: v.y, ve: v });
    }
    list.sort((a, b) => a.y - b.y);
    for (const g of R.ghosts) {
      const a = 0.4 * (1 - g.t / 0.3);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(flashOf(g.s), Math.round(g.x - g.s.ax), Math.round(g.y - g.s.ay));
      ctx.globalAlpha = 1;
    }
    for (const d of list) {
      if (d.p) drawProp(d.p, view, emq);
      else if (d.b) drawBreakable(d.b, view, emq);
      else if (d.pl) drawPlayer(d.pl, view, dt);
      else if (d.en) drawEnemy(d.en, dt);
      else if (d.al) drawAlly(d.al, view, dt);
      else if (d.cv) drawCiv(d.cv, view, dt);
      else if (d.pt) drawPet(d.pt, dt);
      else if (d.tu) drawTurret(d.tu, view, emq);
      else if (d.ve) drawVehicle(d.ve, view, dt, emq, ox, oy, false);
      else if (d.hg) drawHangout(d.hg, d.own, dt);
      else if (d.pr) drawPriest(d.pr, view, dt);
    }
    drawWires(world, ox, oy);
    drawGrenades(dt);
    tickAreas(dt);
    emitSmoke(world, ox, oy, dt);
    drawParticles(dt, 'ground');

    // ---- 2. lighting (multiply a colored light map over the scene)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lights = collectLights(view, ox, oy, dt);
    applyLighting(lights, amb, ox, oy);
    // ---- 3. emissive ground things at full brightness
    for (const [ch, cx, cy] of visChunks) if (ch.e) ctx.drawImage(ch.e, cx * CH_PX - ox, cy * CH_PX - oy);
    for (const q of emq) ctx.drawImage(q.s, q.x - ox, q.y - oy);
    ctx.translate(-ox, -oy);
    drawCaptureRings(view);
    drawProjectiles(view.projectiles);
    drawEffects(dt);
    drawParticles(dt, 'em');

    // ---- 4. buildings
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const drawn = drawBuildings(world, ox, oy, amb, night, view);
    lightRoofs(flying, drawn, ox, oy, night);
    // ---- 5. bloom, sky layer
    drawBloom(lights, ox, oy, night);
    ctx.translate(-ox, -oy);
    drawParticles(dt, 'hi');
    drawSilhouettes(view, drawn, ox, oy);
    flying.sort((a, b) => a.y - b.y);
    for (const v of flying) drawVehicle(v, view, dt, null, ox, oy, true, amb);
    drawHolograms(world, ox, oy, night);
    drawRoofSigns(world, ox, oy, night);
    drawBunting(view, ox, oy);
    drawFlags(view, ox, oy, night);
    drawBaseSigns(view, ox, oy, night);
    drawRaised(view, raised, ox, oy, dt, night);
    for (const c of view.pcars || []) drawPoliceCar(c, view, ox, oy, amb);
    drawTags(view, list, flying);
    drawTexts(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawRaidArrows(view, ox, oy);
    drawWaypointArrows(view, ox, oy);
    if (R.flashT > 0) {
      R.flashT -= dt;
      ctx.fillStyle = rgba(R.flashCol, Math.min(0.4, R.flashT));
      ctx.fillRect(0, 0, R.vw, R.vh);
    }
    // vignette (stronger at night) + low HP
    const vg = ctx.createRadialGradient(R.vw / 2, R.vh / 2, R.vh * 0.35, R.vw / 2, R.vh / 2, R.vh * 0.95);
    vg.addColorStop(0, 'rgba(5,2,15,0)'); vg.addColorStop(1, `rgba(5,2,15,${0.25 + night * 0.35})`);
    ctx.fillStyle = vg; ctx.fillRect(0, 0, R.vw, R.vh);
    if (me && !me.dead && me.hp / me.maxHp < 0.3) {
      const a = (0.3 - me.hp / me.maxHp) * (0.8 + Math.sin(R.time * 6) * 0.3);
      const g = ctx.createRadialGradient(R.vw / 2, R.vh / 2, R.vh * 0.3, R.vw / 2, R.vh / 2, R.vh * 0.8);
      g.addColorStop(0, 'rgba(255,0,40,0)'); g.addColorStop(1, `rgba(255,0,40,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, R.vw, R.vh);
    }
    R.ghosts = R.ghosts.filter((g) => (g.t += dt) < 0.3);
  };

  // ---------------------------------------------------------------- buildings (GTA2 perspective)
  function drawBuildings(world, ox, oy, amb, night, view) {
    const scx = R.vw / 2, scy = R.vh / 2;
    const margin = 260;
    const gx0 = Math.max(0, Math.floor((ox - margin) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + margin) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - margin) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + margin) / CH_PX));
    const vis = [];
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const b of R.bgrid[gy * world.gridW + gx]) {
      if (b.style === 'cwall') { const rs = view.rs[b.compound]; b.wl = rs && rs.up ? rs.up.walls || 0 : 0; }
      const tint = b.compound !== undefined && (b.style === 'cwall' || b.style === 'hq' || b.style === 'shack' || b.style === 'garage' || b.style === 'boca' || b.style === 'brick') ? tintFor(view, b) : null;
      const art = buildingArt(b, tint);
      const k = art.k;
      const x0 = b.x * TILE - ox, y0 = b.y * TILE - oy, x1 = x0 + art.W, y1 = y0 + art.D;
      const rx0 = scx + (x0 - scx) * k, rx1 = scx + (x1 - scx) * k, ry0 = scy + (y0 - scy) * k, ry1 = scy + (y1 - scy) * k;
      const bx0 = Math.min(x0, rx0), bx1 = Math.max(x1, rx1), by0 = Math.min(y0, ry0), by1 = Math.max(y1, ry1);
      if (bx1 < 0 || by1 < 0 || bx0 > R.vw || by0 > R.vh) continue;
      const cx = (x0 + x1) / 2 - scx, cy = (y0 + y1) / 2 - scy;
      vis.push({ b, art, tint, x0, y0, x1, y1, rx0, rx1, ry0, ry1, bx0, bx1, by0, by1, d: cx * cx + cy * cy });
    }
    vis.sort((a, b) => b.d - a.d);
    const litFrac = 0.12 + night * 0.5;
    // buildings are drawn after the light map, so give them a slightly brighter ambient (moonlight on the roofs)
    const bAmb = amb.map((x, i) => Math.min(1, x * 1.3 + [0.05, 0.05, 0.09][i]));
    R.bakeBudget = R.quality === 'low' ? 3 : 6;
    for (const v of vis) {
      const b = v.b;
      const epoch = Math.floor((R.time + (b.seed % 37)) / 38);
      let baked = v.art.baked;
      const key = bAmb.map((x) => Math.round(x * 24)).join(',') + '|' + epoch + '|' + Math.round(litFrac * 10);
      if (!baked || (v.art.bakeKey !== key && (R.bakeBudget-- > 0 || v.tint))) baked = bakeBuilding(b, bAmb, epoch, litFrac, v.tint);
      const st = neonState(v.art.anim, v.art.seed, R.time);
      drawBox(v, baked, st, scx, scy);
    }
    return vis;
  }

  function drawBox(v, baked, st, scx, scy) {
    const { art, x0, y0, x1, y1, rx0, rx1, ry0, ry1 } = v;
    const H = art.H;
    const step = R.quality === 'low' ? 2 : 1;
    // horizontal walls (south face when the building is above the camera center, north face when below)
    // height on the wall (z) seen at screen coordinate c along the wall's depth axis
    const zOf = (c, g, r, sc) => {
      const den = c - sc;
      const z = Math.abs(den) < 0.5 ? H * (1 - (c - r) / (g - r)) : CAM_Z * (1 - (g - sc) / den);
      return Math.max(0, Math.min(H, z));
    };
    // each screen row/column takes the whole band of texture rows that falls on it (smoothed), so small lit windows
    // never pop in and out as the camera moves; only when the band is under a pixel do we take a single row
    const band = (z1, z2) => {
      let hi = Math.max(z1, z2), lo = Math.min(z1, z2);
      if (hi - lo < 1) { const m = Math.min(H - 0.5, Math.max(0.5, (hi + lo) / 2)); hi = m + 0.5; lo = m - 0.5; }
      return [H - hi, hi - lo];
    };
    const wallH = (tex, yg, yr, gx0, gx1) => {
      const a = Math.min(yg, yr), bb = Math.max(yg, yr);
      const span = bb - a;
      if (span < 0.5) return;
      const s = span > 90 ? step + 1 : step;
      for (let y = Math.floor(a); y < bb; y += s) {
        const yc = y + s / 2;
        const t = (yc - yr) / (yg - yr);
        const xl = rx0 + (gx0 - rx0) * t, xr = rx1 + (gx1 - rx1) * t;
        const [sy, sh] = band(zOf(Math.max(a, y), yg, yr, scy), zOf(Math.min(bb, y + s), yg, yr, scy));
        ctx.drawImage(tex, 0, sy, tex.width, sh, Math.floor(xl), y, Math.ceil(xr) - Math.floor(xl), s);
      }
    };
    const wallV = (tex, xg, xr, gy0, gy1) => {
      const a = Math.min(xg, xr), bb = Math.max(xg, xr);
      const span = bb - a;
      if (span < 0.5) return;
      const s = span > 90 ? step + 1 : step;
      for (let x = Math.floor(a); x < bb; x += s) {
        const xc = x + s / 2;
        const t = (xc - xr) / (xg - xr);
        const yt = ry0 + (gy0 - ry0) * t, yb = ry1 + (gy1 - ry1) * t;
        const [sx, sw] = band(zOf(Math.max(a, x), xg, xr, scx), zOf(Math.min(bb, x + s), xg, xr, scx));
        ctx.drawImage(tex, sx, 0, sw, tex.height, x, Math.floor(yt), s, Math.ceil(yb) - Math.floor(yt));
      }
    };
    ctx.imageSmoothingEnabled = true;
    if (y1 < scy) wallH(baked.S[st], y1, ry1, x0, x1);
    if (y0 > scy) wallH(baked.N[st], y0, ry0, x0, x1);
    if (x1 < scx) wallV(baked.E[st], x1, rx1, y0, y1);
    if (x0 > scx) wallV(baked.W[st], x0, rx0, y0, y1);
    ctx.imageSmoothingEnabled = false;
    const fx = Math.round(rx0), fy = Math.round(ry0);
    ctx.drawImage(baked.roof[st], fx, fy, Math.round(rx1) - fx, Math.round(ry1) - fy);
    // blinking antenna lights and helipad beacons
    const blinks = art.roof.blinks;
    if (blinks && blinks.length && Math.floor(R.time * 1.6 + art.seed) % 2) {
      const k = (Math.round(rx1) - fx) / art.W;
      for (const bl of blinks) { ctx.fillStyle = bl.c || '#ff3b5c'; ctx.fillRect(Math.round(fx + bl.x * k) - 1, Math.round(fy + bl.y * k) - 1, 2, 2); }
    }
  }

  // flying vehicles light up the roofs they pass over (their under-glow and headlights)
  function lightRoofs(flying, drawn, ox, oy, night) {
    if (!flying.length) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    for (const v of flying) {
      const px = (v.sx ?? v.x) - ox, py = (v.sy ?? v.y) - oy;
      const col = v.civ ? '#ffe6b0' : v.team >= 0 ? GANG_COLORS[v.team] || '#22e5ff' : '#22e5ff';
      for (const d of drawn) {
        if (px < d.x0 - 24 || px > d.x1 + 24 || py < d.y0 - 24 || py > d.y1 + 24) continue;
        const fx = Math.max(0, Math.min(1, (px - d.x0) / (d.x1 - d.x0))), fy = Math.max(0, Math.min(1, (py - d.y0) / (d.y1 - d.y0)));
        const X = d.rx0 + fx * (d.rx1 - d.rx0), Y = d.ry0 + fy * (d.ry1 - d.ry0);
        const inside = px >= d.x0 && px <= d.x1 && py >= d.y0 && py <= d.y1;
        const r = inside ? 84 : 50, a = (inside ? 0.55 : 0.3) * (0.35 + 0.65 * night);
        ctx.save();
        ctx.beginPath(); ctx.rect(Math.round(d.rx0), Math.round(d.ry0), Math.round(d.rx1 - d.rx0), Math.round(d.ry1 - d.ry0)); ctx.clip();
        ctx.globalAlpha = a; ctx.drawImage(lightSprite(col), X - r / 2, Y - r / 2, r, r);
        ctx.globalAlpha = a * 0.8; ctx.drawImage(lightSprite('#fff4dc'), X - r / 4, Y - r / 4, r / 2, r / 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
  }

  // players behind a building show as an outline in their color
  function drawSilhouettes(view, drawn, ox, oy) {
    for (const p of view.players) {
      if (p.dead || p.veh || p.cloak) continue;
      const px = p.x - ox, py = p.y - 8 - oy;
      let hidden = false;
      for (const v of drawn) {
        if (px < v.bx0 || px > v.bx1 || py < v.by0 || py > v.by1) continue;
        if (px > v.x0 && px < v.x1 && py > v.y0 && py < v.y1) continue;
        if (px > Math.min(v.rx0, v.x0) && px < Math.max(v.rx1, v.x1) && py > Math.min(v.ry0, v.y0) && py < Math.max(v.ry1, v.y1)) { hidden = true; break; }
      }
      if (!hidden) continue;
      const spec = playerSpecOf(p, view);
      const s = charSprite(spec, 0, 0);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(tinted(s, p.color || '#ffffff'), Math.round(p.x - s.ax), Math.round(p.y - s.ay));
      ctx.globalAlpha = 1;
    }
  }
  const tintCache = new WeakMap();
  function tinted(s, col) {
    let m = tintCache.get(s);
    if (!m) { m = new Map(); tintCache.set(s, m); }
    let c = m.get(col);
    if (c) return c;
    c = mk(s.width, s.height);
    const g = c.getContext('2d');
    g.drawImage(s, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = col; g.fillRect(0, 0, c.width, c.height);
    m.set(col, c);
    return c;
  }

  // ---------------------------------------------------------------- lighting
  const spriteCache = new Map();
  function lightSprite(col) {
    let g = spriteCache.get(col);
    if (g) return g;
    g = mk(64, 64);
    const c = g.getContext('2d');
    const grd = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, rgba(col, 1)); grd.addColorStop(0.25, rgba(col, 0.7)); grd.addColorStop(0.6, rgba(col, 0.22)); grd.addColorStop(1, rgba(col, 0));
    c.fillStyle = grd; c.fillRect(0, 0, 64, 64);
    spriteCache.set(col, g);
    return g;
  }

  function collectLights(view, ox, oy, dt) {
    const out = [];
    const world = view.world;
    const t = R.time;
    const near = (x, y, r) => x > ox - r && x < ox + R.vw + r && y > oy - r && y < oy + R.vh + r;
    const gx0 = Math.max(0, Math.floor((ox - 160) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 160) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 160) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 160) / CH_PX));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const l of world.lightGrid[gy * world.gridW + gx]) {
      if (!near(l.x, l.y, l.r)) continue;
      if (l.night && R.night < 0.3) continue;
      let i = l.base ? 0.95 : 0.85, c = l.c, r = l.r;
      if (l.anim) {
        const st = neonState(l.anim, l.seed || 0, t);
        if (neonIsOff(l.anim, st)) i *= 0.12;
        else if (st === 1 && l.c2) c = l.c2;
        if (l.anim === 'pulse') i *= 0.65 + 0.35 * Math.sin(t * 3 + (l.seed || 0));
      }
      if (l.flicker) { r *= 0.85 + Math.sin(t * 17 + l.x) * 0.08 + Math.random() * 0.07; i *= 0.85 + Math.random() * 0.2; }
      if (l.night) i *= (l.spill ? 0.85 : 0.6) * R.night;
      out.push({ x: l.x, y: l.y, r, c, i, bloom: !l.base && !l.night });
    }
    for (const Rg of world.regions) {
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      if (!near(x, y, 80) || !view.rs[Rg.id]) continue;
      out.push({ x, y: y - 20, r: 70, c: ownerColorOf(view.rs[Rg.id].owner), i: 0.8, bloom: true });
    }
    for (const p of view.players) if (!p.dead && !p.cloak && !p.veh && near(p.x, p.y, 60)) out.push({ x: p.x, y: p.y - 6, r: p === view.me ? 70 : 46, c: '#ffe6c8', i: p === view.me ? 0.55 : 0.4 });
    for (const v of view.vehicles || []) {
      if (!near(v.x, v.y, 100)) continue;
      const gc = v.team >= 0 ? GANG_COLORS[v.team] : '#22e5ff';
      if (v.flying) out.push({ x: v.x, y: v.y, r: v.type === 'car' ? 66 : 52, c: gc, i: 0.9, bloom: true });
      out.push({ x: v.x + [0, -26, 26, 0][v.dir], y: v.y + [26, 0, 0, -26][v.dir], r: 46, c: '#fff6d8', i: 0.7 });
    }
    for (const tu of view.turrets || []) if (!tu.dead && near(tu.x, tu.y, 40)) out.push({ x: tu.x, y: tu.y - 8, r: 30, c: GANG_COLORS[tu.team] || '#fff', i: 0.6 });
    for (const pr of view.projectiles) if (near(pr.x, pr.y, 30)) out.push({ x: pr.x, y: pr.y, r: pr.kind.includes('rocket') ? 44 : 22, c: (PROJ[pr.kind] || PROJ.pulse)[0], i: 0.9, bloom: pr.kind.includes('rocket') });
    for (const e of R.effects) {
      if (e.k === 'beam' || e.k === 'zap') out.push({ x: (e.x + e.x2) / 2, y: (e.y + e.y2) / 2, r: 90, c: e.c || '#9af0ff', i: 1.2 * (1 - e.t / (e.life || 0.3)), bloom: true });
      else if (e.k === 'muzzle') out.push({ x: e.x, y: e.y, r: 64, c: '#ffd08a', i: 1.5, bloom: true });
    }
    let fire = 0;
    for (const p of R.particles) if (p.fire && fire++ < 36 && near(p.x, p.y, 30)) out.push({ x: p.x, y: p.y, r: 30, c: '#ff8a3d', i: 0.55, bloom: fire % 3 === 0 });
    for (const e of view.enemies) if (e.burn) out.push({ x: e.x, y: e.y - 8, r: 34, c: '#ff8a3d', i: 0.7 });
    for (const h of world.holos) if (near(h.x, h.y, 90)) out.push({ x: h.x, y: h.y + 10, r: 80, c: BRANDS[h.brand].c, i: 0.6 });
    for (const l of R.policeLights(view)) out.push(l);
    if (view.ufo) {
      const q = ufoPos(view.ufo);
      out.push({ x: q.x, y: q.y, r: view.ufo.state === 'beam' ? 180 : 120, c: '#7dff4a', i: view.ufo.state === 'warn' ? 0.5 : 1.3, bloom: true });
    }
    for (const k of view.pickups) if (k.type === 'ufo') out.push({ x: k.x, y: k.y - 6, r: 54, c: '#7dff4a', i: 1, bloom: true });
    for (const h of view.helis || []) {
      const gx = h.x + Math.cos(h.aim || 0) * 46, gy = h.y + Math.sin(h.aim || 0) * 46;
      out.push({ x: gx, y: gy, r: 110, c: '#f4f8ff', i: 1.2, bloom: true });
      out.push({ x: h.x, y: h.y, r: 60, c: Math.floor(t * 6) % 2 ? '#ff2a2a' : '#2a4aff', i: 0.8 });
    }
    for (const a of R.areas) {
      if (a.k === 'fire') out.push({ x: a.x, y: a.y, r: 80 + Math.random() * 10, c: '#ff8a3d', i: 1, bloom: true });
      else if (a.k === 'emp') out.push({ x: a.x, y: a.y, r: 140, c: '#22e5ff', i: Math.max(0, 1 - a.t), bloom: true });
    }
    R.dynLights = R.dynLights.filter((l) => (l.t += dt) < l.life);
    for (const l of R.dynLights) {
      const k = 1 - l.t / l.life;
      out.push({ x: l.x, y: l.y, r: l.r * (l.boom ? 0.6 + 0.4 * k : 1), c: l.t < 0.06 && l.boom ? '#ffffff' : l.c, i: l.i * k, bloom: true });
    }
    return out;
  }

  function applyLighting(lights, amb, ox, oy) {
    const lw = light.width, lh = light.height;
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.fillStyle = `rgb(${Math.round(amb[0] * 255)},${Math.round(amb[1] * 255)},${Math.round(amb[2] * 255)})`;
    lctx.fillRect(0, 0, lw, lh);
    lctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      const r = l.r;
      lctx.globalAlpha = Math.min(1, l.i);
      lctx.drawImage(lightSprite(l.c), (l.x - ox - r) / 2, (l.y - oy - r) / 2, r, r);
      if (l.i > 1) { lctx.globalAlpha = Math.min(1, l.i - 1); lctx.drawImage(lightSprite(l.c), (l.x - ox - r * 0.6) / 2, (l.y - oy - r * 0.6) / 2, r * 0.6, r * 0.6); }
    }
    lctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(light, 0, 0, lw, lh, 0, 0, R.vw, R.vh);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawBloom(lights, ox, oy, night) {
    if (R.quality === 'low') return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    const base = 0.1 + night * 0.22;
    for (const l of lights) {
      if (!l.bloom) continue;
      const r = l.r * 0.55;
      ctx.globalAlpha = Math.min(0.8, base * l.i);
      ctx.drawImage(lightSprite(l.c), l.x - ox - r / 2, l.y - oy - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- pieces
  function shadow(x, y, w, a = 0.4) {
    ctx.fillStyle = `rgba(4,2,12,${a})`;
    ctx.fillRect(Math.round(x - w), Math.round(y - 1), w * 2, 2);
    ctx.fillRect(Math.round(x - w + 1), Math.round(y - 2), w * 2 - 2, 4);
  }

  function pixCircle(cx, cy, r, col, sq = 0.75) {
    ctx.fillStyle = col;
    const n = Math.max(12, Math.round(r * 2.2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * sq), 1, 1);
    }
  }
  function pixCircleFill(cx, cy, r, sq = 0.75) {
    for (let y = -r * sq; y <= r * sq; y += 1) {
      const w = Math.sqrt(Math.max(0, r * r - (y / sq) ** 2));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), Math.round(w * 2), 1);
    }
  }

  function drawWater(world, ox, oy) {
    const WW = world.W, HH = world.H;
    const t0 = Math.max(0, Math.floor(ox / TILE)), t1 = Math.min(WW - 1, Math.floor((ox + R.vw) / TILE));
    const u0 = Math.max(0, Math.floor(oy / TILE)), u1 = Math.min(HH - 1, Math.floor((oy + R.vh) / TILE));
    const ph = R.time;
    for (let ty = u0; ty <= u1; ty++) for (let tx = t0; tx <= t1; tx++) {
      if (world.tiles[ty * WW + tx] !== T.WATER) continue;
      const h = hash2(tx, ty, 77);
      const k = (ph * 0.8 + h * 10) % 3;
      if (k < 1) {
        ctx.fillStyle = k < 0.5 ? '#3a8ab8' : '#5aa8d0';
        ctx.fillRect(tx * TILE + ((h * 13) | 0), ty * TILE + ((h * 977) % 14 | 0), 3, 1);
      }
      const isW = (x, y) => world.tiles[y * WW + x] === T.WATER;
      if ((ty > 0 && !isW(tx, ty - 1)) || (tx > 0 && !isW(tx - 1, ty)) || (tx < WW - 1 && !isW(tx + 1, ty)) || (ty < HH - 1 && !isW(tx, ty + 1))) {
        const f = Math.sin(ph * 2 + tx * 0.7 + ty * 0.3);
        if (f > 0.3) { ctx.fillStyle = 'rgba(230,248,255,0.55)'; ctx.fillRect(tx * TILE + ((h * 7) | 0), ty * TILE + ((h * 11) | 0), 4, 1); }
      }
    }
  }

  function drawDecals(dt) {
    R.decals = R.decals.filter((d) => (d.t += dt) < d.life);
    for (const d of R.decals) {
      const a = 0.5 * Math.min(1, (d.life - d.t) / 5);
      ctx.fillStyle = `rgba(10,6,8,${a})`;
      pixCircleFill(d.x, d.y, d.r);
      ctx.fillStyle = `rgba(10,6,8,${a * 0.6})`;
      for (let i = 0; i < 8; i++) { const an = i * 0.8 + d.x; ctx.fillRect(Math.round(d.x + Math.cos(an) * d.r * 1.3), Math.round(d.y + Math.sin(an) * d.r * 0.9), 2, 2); }
      if (d.t < 6 && Math.random() < 0.05) R.smoke(d.x + (Math.random() - 0.5) * d.r, d.y, '#3a3640', 1, -10, 1.4, true);
    }
  }

  const ownerColor = (owner) => ownerColorOf(owner);

  function drawCores(view) {
    for (const Rg of view.world.regions) {
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      if (x < R.ox - 120 || x > R.ox + R.vw + 120 || y < R.oy - 120 || y > R.oy + R.vh + 120) continue;
      const rs = view.rs[Rg.id];
      if (!rs) continue;
      const col = ownerColor(rs.owner);
      const up = rs.up;
      if (up) {
        if (up.radar) { const rx = x - 3 * TILE, ry = y - 0.6 * TILE; ctx.fillStyle = '#2a2636'; ctx.fillRect(rx - 6, ry - 2, 12, 5); ctx.fillStyle = '#4a4656'; ctx.fillRect(rx - 6, ry - 2, 12, 1); }
        if (up.medic) {
          // medic tent with a cross
          const mx = x + 3 * TILE, my = y - 1.2 * TILE;
          ctx.fillStyle = '#d8d8e0'; ctx.fillRect(mx - 10, my - 8, 20, 12); ctx.fillStyle = '#f2f2f2'; ctx.fillRect(mx - 9, my - 11, 18, 4); ctx.fillStyle = '#b8b8c4'; ctx.fillRect(mx - 10, my + 3, 20, 1);
          ctx.fillStyle = '#ff3b5c'; ctx.fillRect(mx - 1, my - 7, 3, 9); ctx.fillRect(mx - 4, my - 4, 9, 3);
          ctx.fillStyle = '#2a1a22'; ctx.fillRect(mx - 3, my, 6, 4);
        }
        for (let b = 0; b < (up.barracks || 0); b++) {
          // bunk tents for the soldiers
          const bx = x + (b % 2 ? 4.2 : -4.2) * TILE, by = y + (2.4 + Math.floor(b / 2) * 1.6) * TILE;
          ctx.fillStyle = '#4a5a3a'; ctx.fillRect(bx - 11, by - 8, 22, 11); ctx.fillStyle = '#5a6a4a'; ctx.fillRect(bx - 10, by - 11, 20, 4); ctx.fillStyle = '#3a4a2a'; ctx.fillRect(bx - 11, by + 2, 22, 1);
          ctx.fillStyle = '#1a1a14'; ctx.fillRect(bx - 3, by - 5, 6, 8); ctx.fillStyle = col; ctx.fillRect(bx - 9, by - 10, 2, 2);
        }
        if (up.level) {
          // fortified: concrete barriers around the flag
          for (const [dx, dy] of [[-2.4, 1.8], [2.4, 1.8], [-2.4, -1.4], [2.4, -1.4]].slice(0, 2 + up.level * 2)) {
            const bx = x + dx * TILE, by = y + dy * TILE;
            ctx.fillStyle = '#8a8698'; ctx.fillRect(bx - 8, by - 6, 16, 6); ctx.fillStyle = '#a8a4b4'; ctx.fillRect(bx - 7, by - 7, 14, 2);
            for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#ffd23f' : '#1a1622'; ctx.fillRect(bx - 7 + i * 4, by - 4, 3, 2); }
          }
        }
        if (up.pad) {
          const px = x, py = y + 3 * TILE;
          ctx.fillStyle = 'rgba(20,30,50,0.7)'; pixCircleFill(px, py, 15, 0.6);
          ctx.globalAlpha = 0.6 + Math.sin(R.time * 4) * 0.3;
          pixCircle(px, py, 15, '#22e5ff', 0.6); pixCircle(px, py, 10, '#22e5ff', 0.6); pixCircle(px, py, 5, '#9af0ff', 0.6);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  function drawProp(p, view, emq) {
    if (p.type === 'core') return drawCoreProp(p, view);
    let s;
    if (p.type === 'barrel') s = propSprite('barrel', 0, ((R.time * 8 + p.x) | 0) % 3);
    else if (p.type === 'station') s = propSprite('station', STATION_IDX[p.kind]);
    else if (p.type === 'paredao') {
      const beat = (R.time * 124 / 60) % 1;
      s = propSprite('paredao', 0, beat < 0.22 ? 1 : 0);
      if (Math.random() < 0.04) R.particles.push({ x: p.x + (Math.random() - 0.5) * 24, y: p.y - 30, vx: (Math.random() - 0.5) * 10, vy: -20, life: 1.1, t: 0, c: ['#ff3fa4', '#22e5ff', '#ffd23f'][(Math.random() * 3) | 0], g: 0, sz: 2, em: true });
    }
    else s = propSprite(p.type, p.v);
    if (p.type === 'palm' || p.type === 'banana') shadow(p.x + 3, p.y, 7);
    else if (p.type === 'busstop' || p.type === 'dumpster') shadow(p.x, p.y, 12);
    const x = Math.round(p.x - s.ax), y = Math.round(p.y - s.ay);
    ctx.drawImage(s, x, y);
    if (s.em) emq.push({ s: s.em, x, y });
    if (p.type === 'barrel') emq.push({ s, x, y });
  }

  function drawBreakable(b, view, emq) {
    const dead = view.broken && view.broken.has(b.id);
    const s = breakSprite(b.type, b.v, dead);
    if (b.type === 'car') shadow(b.x, b.y + 1, 14);
    const x = Math.round(b.x - s.ax), y = Math.round(b.y - s.ay);
    ctx.drawImage(s, x, y);
    if (s.em) emq.push({ s: s.em, x, y });
    if (dead && Math.random() < 0.04) R.smoke(b.x, b.y - 8, '#4a4652', 1, -10, 1.4);
    if (dead && b.type !== 'transformer' && Math.random() < 0.15) R.particles.push({ x: b.x + (Math.random() - 0.5) * 6, y: b.y - 4, vx: 0, vy: -16, life: 0.4, t: 0, c: Math.random() < 0.5 ? '#ff8a3d' : '#ffd23f', g: 0, sz: 1, em: true, fire: Math.random() < 0.3 });
  }

  function drawCoreProp(p, view) {
    const rs0 = view.rs[p.region];
    if (!rs0) return;
    const col0 = ownerColor(rs0.owner);
    const x0 = Math.round(p.x), y0 = Math.round(p.y);
    ctx.fillStyle = '#14121c'; ctx.fillRect(x0 - 8, y0 - 3, 16, 5);
    ctx.fillStyle = '#3a3646'; ctx.fillRect(x0 - 7, y0 - 5, 14, 3); ctx.fillStyle = '#5a566a'; ctx.fillRect(x0 - 7, y0 - 5, 14, 1);
    ctx.fillStyle = '#2a2636'; ctx.fillRect(x0 - 2, y0 - 22, 4, 18); ctx.fillStyle = '#4e4a5c'; ctx.fillRect(x0 - 2, y0 - 22, 1, 18);
    ctx.fillStyle = '#3a3646'; ctx.fillRect(x0 - 5, y0 - 24, 10, 3);
    ctx.fillStyle = col0; ctx.fillRect(x0 - 4, y0 - 23, 8, 1); ctx.fillRect(x0 - 6, y0 - 2, 12, 1);
    for (let i = 0; i < 3; i++) { ctx.fillStyle = Math.floor(R.time * 6 + i) % 3 === 0 ? '#ffffff' : col0; ctx.fillRect(x0 - 1, y0 - 19 + i * 5, 2, 2); }
    return;
    const rs = view.rs[p.region];
    if (!rs) return;
    const col = ownerColor(rs.owner);
    const x = Math.round(p.x), y = Math.round(p.y);
    ctx.fillStyle = '#1b1b24'; ctx.fillRect(x - 6, y - 4, 12, 5);
    ctx.fillStyle = '#3a3646'; ctx.fillRect(x - 5, y - 5, 10, 2);
    ctx.fillStyle = col; ctx.fillRect(x - 4, y - 2, 8, 1);
    ctx.fillStyle = '#2a2636'; ctx.fillRect(x - 1, y - 30, 2, 26);
    ctx.fillStyle = '#4e4a5c'; ctx.fillRect(x - 1, y - 30, 1, 26);
    const bob = Math.sin(R.time * 2 + p.region) * 1.5;
    const w = Math.abs(Math.cos(R.time * 2 + p.region)) * 4 + 1;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x - w), Math.round(y - 40 + bob), Math.round(w * 2), 6);
    ctx.fillRect(Math.round(x - w / 2), Math.round(y - 42 + bob), Math.round(w), 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, Math.round(y - 39 + bob), 1, 2);
    ctx.fillStyle = col;
    const wave = Math.sin(R.time * 5 + p.region) > 0 ? 1 : 0;
    ctx.fillRect(x + 1, y - 29, 8, 4 + wave);
    ctx.fillStyle = shade(col, -0.3);
    ctx.fillRect(x + 1, y - 26 + wave, 8, 1);
  }

  function specFor(key, make) {
    let s = R.specCache.get(key);
    if (!s) { s = make(); R.specCache.set(key, s); if (R.specCache.size > 400) R.specCache.delete(R.specCache.keys().next().value); }
    return s;
  }

  const dirOf = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    if (Math.abs(c) > Math.abs(s) * 1.1) return c > 0 ? 2 : 1;
    return s > 0 ? 0 : 3;
  };

  function stepAnim(key, x, y, dt) {
    const a = animOf(key);
    if (a.lx === null) { a.lx = x; a.ly = y; }
    const d = Math.hypot(x - a.lx, y - a.ly);
    a.dist += d;
    if (d > 0.05) { a.moving = true; a.still = 0; } else { a.still += dt; if (a.still > 0.12) a.moving = false; }
    a.lx = x; a.ly = y;
    a.swT += dt;
    a.recL = Math.max(0, a.recL - dt); a.recR = Math.max(0, a.recR - dt);
    return a;
  }

  function armAngle(a, slot, base) {
    if (a.swT < a.swDur && (a.swSlot === slot || a.swKind === 'slam2')) {
      const p = a.swT / a.swDur;
      const kind = a.swKind;
      if (kind === 'slam' || kind === 'hammer') return base - 1.6 + p * 1.6 * (p < 0.5 ? 0.4 : 1);
      if (kind === 'blade' || kind === 'claw') return base - 1.3 + p * 2.6;
      if (kind === 'whip') return base - 0.6 + p * 1.2;
      return base + Math.sin(p * Math.PI) * 0.25;
    }
    return base;
  }

  function armReach(a, slot, kind) {
    if (a.swT < a.swDur && a.swSlot === slot && (kind === 'fist')) return Math.sin((a.swT / a.swDur) * Math.PI) * 5;
    return -((slot === 'L' ? a.recL : a.recR) > 0 ? 3 : 0);
  }

  function drawArm(x, y, ang, kind, color, reach = 0) {
    const s = armSprite(kind, color);
    ctx.save();
    ctx.translate(Math.round(x + Math.cos(ang) * reach), Math.round(y + Math.sin(ang) * reach));
    ctx.rotate(ang);
    if (Math.cos(ang) < 0) ctx.scale(1, -1);
    ctx.drawImage(s, 0, -Math.floor(s.height / 2));
    ctx.restore();
  }

  function drawCharacter(key, x, y, aim, spec, arms, dt, opts = {}) {
    const a = stepAnim(key, x, y, dt);
    const moving = opts.moving ?? a.moving;
    const dir = opts.dir ?? dirOf(aim);
    const frame = moving ? 1 + (Math.floor(a.dist / 5) % 4) : 0;
    const s = charSprite(spec, dir, frame);
    const bx = Math.round(x - s.ax), by = Math.round(y - s.ay);
    if (!opts.noShadow) shadow(x, y, Math.max(4, Math.round(s.width * 0.3)));
    const shY = y - s.shY;
    const drawArms = (front) => {
      if (!arms) return;
      for (const arm of arms) {
        let sx = x, isFront;
        if (dir === 0) { sx = x + (arm.slot === 'L' ? s.shX : -s.shX); isFront = true; }
        else if (dir === 3) { sx = x + (arm.slot === 'L' ? -s.shX : s.shX); isFront = false; }
        else if (dir === 2) { sx = x + (arm.slot === 'R' ? 1 : -1); isFront = arm.slot === 'R'; }
        else { sx = x + (arm.slot === 'L' ? -1 : 1); isFront = arm.slot === 'L'; }
        if (isFront !== front) continue;
        drawArm(sx, shY, armAngle(a, arm.slot, aim), arm.kind, arm.color, armReach(a, arm.slot, arm.kind));
      }
    };
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    drawArms(false);
    ctx.drawImage(opts.flash ? flashOf(s) : s, bx, by);
    drawArms(true);
    ctx.globalAlpha = 1;
    if (opts.burn && Math.random() < 0.5) R.particles.push({ x: x + (Math.random() - 0.5) * s.width * 0.6, y: y - Math.random() * s.top * 0.7, vx: 0, vy: -20, life: 0.4, t: 0, c: Math.random() < 0.5 ? '#ff8a3d' : '#ffd23f', g: 0, sz: 2, em: true, fire: Math.random() < 0.3 });
    return s;
  }

  function playerSpecOf(p, view) {
    const look = p.look || {};
    const mods = p.mods || {};
    const gc = GANG_COLORS[p.gang] || view.gangColor;
    return specFor('P' + JSON.stringify(look) + JSON.stringify(mods) + gc, () => playerSpec(look, mods, gc));
  }

  function drawPlayer(p, view, dt) {
    const key = 'p' + p.id;
    const spec = playerSpecOf(p, view);
    const eq = p.equip || { L: 'fist', R: 'pistol' };
    const arms = [{ slot: 'L', kind: eq.L, color: '#aeb9c9' }, { slot: 'R', kind: eq.R, color: '#aeb9c9' }];
    const isMe = view.me && p.id === view.me.id;
    if (p.down) { drawDowned(p, key, spec, dt); return; }
    if (p.emote) { const s0 = drawDancer(key, p.x, p.y, spec, p.emote - 1, dt); p._top = s0.top; return; }
    let alpha;
    if (p.cloak) alpha = isMe ? 0.35 : 0.1 + Math.abs(Math.sin(R.time * 9)) * 0.08;
    if (p.ghost) alpha = isMe ? 0.4 : 0.15 + Math.abs(Math.sin(R.time * 5)) * 0.1;
    if (p.fury && Math.random() < 0.3) R.particles.push({ x: p.x + (Math.random() - 0.5) * 8, y: p.y - Math.random() * 18, vx: 0, vy: -24, life: 0.4, t: 0, c: Math.random() < 0.5 ? '#ff3fa4' : '#ff3b3b', g: 0, sz: 1, em: true });
    if (p.inv && Math.floor(R.time * 12) % 2) alpha = 0.5;
    const s = drawCharacter(key, p.x, p.y, p.aim, spec, arms, dt, { alpha, moving: isMe ? view.meMoving : undefined, burn: p.burn });
    p._top = s.top;
    if (p.hp < p.maxHp * 0.35 && !p.cloak) drip(p.x, p.y, dt, false);
    if (p.shield) {
      ctx.globalAlpha = 0.35 + Math.sin(R.time * 8) * 0.1;
      pixCircle(p.x, p.y - 8, 11, '#4fc3ff');
      ctx.globalAlpha = 1;
    }
  }

  function drawEnemy(e, dt) {
    const key = 'e' + e.id;
    const spec = specFor(`E${e.faction}-${e.tier}-${e.id % 3}-${e.boss ? 1 : 0}`, () => enemySpec(e.faction, e.boss ? 6 : e.tier, e.id % 3, e.boss));
    let arms = null;
    if (!spec.special || spec.special === 'alien') {
      const kind = ENEMY_ARM[e.atk] || 'pistol';
      const col = shade(spec.top, -0.1);
      arms = e.boss ? [{ slot: 'L', kind: 'rail', color: col }, { slot: 'R', kind: kind === 'rail' ? 'rocket' : kind, color: col }] : [{ slot: 'R', kind, color: col }];
    }
    const flash = e.flash > 0 || (e.windup > 0 && Math.floor(R.time * 16) % 2 === 0);
    const s = drawCharacter(key, e.x, e.y, e.aim, spec, arms, dt, { flash, moving: e.moving, burn: e.burn });
    e._top = s.top;
    if (e.hp < e.maxHp * 0.35) drip(e.x, e.y, dt, spec.special === 'alien' ? 'alien' : !!(spec.special && spec.special !== 'dog'));
    if (e.stunT > 0) for (let i = 0; i < 3; i++) { const a = R.time * 5 + i * 2.1; ctx.fillStyle = i % 2 ? '#ffd23f' : '#9af0ff'; ctx.fillRect(Math.round(e.x + Math.cos(a) * 6), Math.round(e.y - s.top - 4 + Math.sin(a) * 2), 2, 2); }
    if (e.windup > 0 && Math.floor(R.time * 16) % 2) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(Math.round(e.x - 2), Math.round(e.y - s.top - 4), 4, 4);
      ctx.globalAlpha = 1;
    }
  }

  function drawAlly(al, view, dt) {
    const gc = GANG_COLORS[al.team] || view.gangColor;
    let spec, weapon;
    if (al.civ) { spec = specFor('Cv' + al.civ + gc, () => civilianSpec(al.civ, gc)); weapon = al.melee ? 'claw' : 'pistol'; }
    else if (al.follow) { spec = specFor('F' + (al.id % 4) + gc + al.tier, () => followerSpec(gc, al.id % 4, al.tier)); weapon = al.tier >= 4 ? 'smg' : 'pistol'; }
    const lv = al.lvl || 1;
    if (al.follow && lv > 1) {
      const base = spec;
      spec = specFor('L' + lv + JSON.stringify(base), () => Object.assign({}, base, { band: gc }, lv >= 3 ? { armor: Math.max(base.armor || 0, 1), visor: gc } : {}, lv >= 4 ? { armor: Math.max(base.armor || 0, 2), chromeLegs: true } : {}, lv >= 5 ? { armor: 3, kneeGlow: true, chains: true } : {}));
      const wk = (al.melee ? CREW_WEAPONS.melee : CREW_WEAPONS.gun)[lv - 1];
      weapon = wk === 'burst' ? 'smg' : wk;
      if (lv >= 5 && Math.random() < 0.08) R.particles.push({ x: al.x + (Math.random() - 0.5) * 8, y: al.y - Math.random() * 16, vx: 0, vy: -14, life: 0.5, t: 0, c: gc, g: 0, sz: 1, em: true });
    }
    else { spec = specFor('A' + (al.id % 4) + gc, () => allySpec(gc, al.id % 4)); weapon = 'pistol'; }
    if (al.healer) {
      const base = spec;
      spec = specFor('HL' + JSON.stringify(base), () => Object.assign({}, base, { top: '#f2f0ea', top2: '#d8d4c8', pants: '#ece8de', armor: 0, visor: null, mask: null, band: '#ffd88a', chromeLegs: false, kneeGlow: false, chains: false }));
    }
    if (al.emote) { const s0 = drawDancer('a' + al.id, al.x, al.y, spec, al.emote - 1, dt, al.id % 5); al._top = s0.top; return; }
    if (al.healer) {
      const s1 = drawCharacter('a' + al.id, al.x, al.y, al.aim, spec, null, dt, { flash: al.flash > 0, moving: al.moving });
      al._top = s1.top;
      const cy = Math.round(al.y - s1.top * 0.55), cx = Math.round(al.x);
      ctx.fillStyle = '#ffd23f'; ctx.fillRect(cx, cy - 2, 1, 5); ctx.fillRect(cx - 1, cy - 1, 3, 1);
      if (Math.random() < 0.07) R.particles.push({ x: al.x + (Math.random() - 0.5) * 8, y: al.y - Math.random() * 16, vx: 0, vy: -12, life: 0.7, t: 0, c: '#9affc8', g: 0, sz: 1, em: true });
      return;
    }
    const s = drawCharacter('a' + al.id, al.x, al.y, al.aim, spec, [{ slot: 'R', kind: weapon, color: al.civ ? '#8a8494' : shade(spec.top, -0.1) }], dt, { flash: al.flash > 0, moving: al.moving });
    al._top = s.top;
    if (al.hp < al.maxHp * 0.35) drip(al.x, al.y, dt, false);
    if (al.rev && Math.random() < 0.25) R.particles.push({ x: al.x + (Math.random() - 0.5) * 8, y: al.y - 10, vx: 0, vy: -18, life: 0.5, t: 0, c: '#3ddc84', g: 0, sz: 1, em: true });
  }

  // cats and dogs
  function drawPet(a, dt) {
    const an = stepAnim('pt' + a.id, a.x, a.y, dt);
    const moving = a.moving ?? an.moving;
    const frame = moving ? 1 + (Math.floor(an.dist / (a.flee ? 4 : 2.5)) % 4) : 0;
    const pose = a.happy ? 2 : a.sit && !moving ? 1 : 0;
    const sp = petSprite(a.kind, a.seed, frame, pose, Math.cos(a.aim || 0) < 0, R.time + (a.id % 7) * 0.13);
    shadow(a.x, a.y, 5, 0.3);
    const hop = a.happy && a.kind === 'dog' ? -Math.round(Math.abs(Math.sin(R.time * 9)) * 2) : 0;
    ctx.drawImage(sp, Math.round(a.x - sp.ax), Math.round(a.y - sp.ay + hop));
    a._top = sp.top;
    if (a.flee && Math.random() < dt * 0.7) R.text(a.x, a.y - 16, a.kind === 'dog' ? 'AU!' : 'FSSS!', '#ffffff', 0.7, -12);
    if (a.happy && Math.random() < dt * 3) R.particles.push({ x: a.x + (Math.random() - 0.5) * 6, y: a.y - 14, vx: (Math.random() - 0.5) * 8, vy: -18, life: 0.8, t: 0, c: '#ff3fa4', g: 0, sz: 2, em: true });
  }

  function drawCiv(c, view, dt) {
    const spec = specFor('C' + c.seed, () => civilianSpec(c.seed));
    if (c.dance) { const s0 = drawDancer('c' + c.id, c.x, c.y, spec, 3, dt, c.id % 7); c._top = s0.top; return; }
    const s = drawCharacter('c' + c.id, c.x, c.y, c.aim, spec, null, dt, { flash: c.flash, moving: c.moving });
    c._top = s.top;
    if (c.hpPct < 35) drip(c.x, c.y, dt, false);
    if (c.flee && Math.random() < 0.03) R.text(c.x, c.y - s.top - 4, ['AI!', 'SOCORRO!', 'CORRE!', 'MEU DEUS!'][(Math.random() * 4) | 0], '#ffffff', 0.8, -14);
  }

  function drawTurret(t, view, emq) {
    const gc = GANG_COLORS[t.team] || '#fff';
    const base = turretBase(gc, t.dead);
    const bx = Math.round(t.x - base.ax), by = Math.round(t.y - base.ay);
    shadow(t.x, t.y, 8);
    ctx.drawImage(t.flash ? flashOf(base) : base, bx, by);
    if (base.em) emq.push({ s: base.em, x: bx, y: by });
    if (t.dead) { if (Math.random() < 0.15) R.smoke(t.x, t.y - 8, '#3a3640', 1, -16, 1.2); if (Math.random() < 0.05) R.burst(t.x, t.y - 8, ['#ffd23f', '#ff8a3d'], 2, 30, 0.3, 0, true); return; }
    const head = turretHead(t.type, gc);
    const hy = t.y - 9;
    ctx.save();
    ctx.translate(Math.round(t.x), Math.round(hy));
    if (t.type !== 'tesla') { ctx.rotate(t.aim); if (Math.cos(t.aim) < 0) ctx.scale(1, -1); }
    ctx.drawImage(head, -head.ax, -head.ay);
    ctx.restore();
    if (t.type === 'tesla' && Math.random() < 0.2) R.burst(t.x, hy - 2, ['#9af0ff', '#ffffff'], 1, 30, 0.15, 0, true);
    for (let i = 0; i < t.mk; i++) { ctx.fillStyle = '#ffd23f'; ctx.fillRect(Math.round(t.x - 4 + i * 3), Math.round(t.y - 1), 2, 1); }
  }

  // ground part of a hovering vehicle (drawn before the lighting): shadow
  function hoverGround(v) {
    const alt = 16 + Math.sin(R.time * 2.6 + v.id) * 2.5;
    const w = v.type === 'car' ? 16 : 11;
    shadow(v.x, v.y, Math.round(w * (1 - alt / 90)), 0.32);
  }

  function drawVehicle(v, view, dt, emq, ox, oy, isFlying, amb) {
    const V = VEHICLES[v.type];
    const gc = v.team >= 0 ? GANG_COLORS[v.team] : '#b8b0c8';
    const color = v.type === 'car' ? shade(gc, -0.1) : gc;
    const frame = Math.floor(R.time * 10) % 2;
    const s = vehicleSprite(v.type, v.dir, color, frame);
    let alt = 1, X = v.x, Y = v.y;
    if (isFlying) {
      alt = 16 + Math.sin(R.time * 2.6 + v.id) * 2.5;
      // perspective parallax: high things drift away from the screen center
      const k = projK(alt);
      const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
      X = scx + (v.x - scx) * k; Y = scy + (v.y - scy) * k;
      // levitation: pulsing anti-grav rings on the ground, thruster beams, dust
      const ring = (R.time * 1.6 + v.id * 0.37) % 1;
      const rw = v.type === 'car' ? 18 : 12;
      ctx.globalCompositeOperation = 'lighter';
      for (const off of [0, 0.5]) {
        const p = (ring + off) % 1;
        ctx.globalAlpha = (1 - p) * 0.7;
        pixCircle(v.x, v.y, rw * (0.35 + p * 0.9), gc, 0.5);
      }
      ctx.globalAlpha = 0.45 + Math.random() * 0.2;
      const beams = v.type === 'car' ? [-rw * 0.6, rw * 0.6] : [0];
      for (const bxo of beams) {
        const x = Math.round(X + bxo);
        for (let y = Math.round(Y - alt - 2); y < v.y; y += 2) { ctx.fillStyle = (y >> 1) % 2 ? gc : '#ffffff'; ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x, y + 1, 1, 1); }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < 0.35) {
        const a = Math.random() * 6.28;
        R.particles.push({ x: v.x + Math.cos(a) * rw * 0.5, y: v.y + Math.sin(a) * rw * 0.3, vx: Math.cos(a) * 40, vy: Math.sin(a) * 22, life: 0.5, t: 0, c: view.world.tiles[Math.floor(v.y / TILE) * view.world.W + Math.floor(v.x / TILE)] === T.WATER ? '#d8f4ff' : '#8a8494', g: 0, sz: 1 });
      }
      // thruster plume: behind the moto, under the car corners
      const back = [[0, -1], [1, 0], [-1, 0], [0, 1]][v.dir];
      const tailX = X + back[0] * (s.width * 0.45), tailY = Y - alt - 4 + back[1] * 4;
      const n = v.type === 'moto' ? 3 : 2;
      for (let i = 0; i < n; i++) R.particles.push({ x: tailX + (Math.random() - 0.5) * 3, y: tailY + (Math.random() - 0.5) * 3, vx: back[0] * (60 + Math.random() * 40) + (Math.random() - 0.5) * 10, vy: back[1] * (60 + Math.random() * 40) + (Math.random() - 0.5) * 10, life: 0.22 + Math.random() * 0.12, t: 0, c: ['#22e5ff', '#9af0ff', '#ffffff', gc][(Math.random() * 4) | 0], g: 0, sz: v.type === 'moto' ? 2 : 1, em: true, hi: true });
      if (amb) { try { ctx.filter = `brightness(${Math.max(0.35, (amb[0] + amb[1] + amb[2]) / 3 + 0.2).toFixed(2)})`; } catch { /* no filters */ } }
    } else {
      shadow(v.x, v.y, Math.round(s.width * 0.38), 0.35);
    }
    v.alt = alt; v.sx = X; v.sy = Y;
    const ax = Math.round(X - s.ax), ay = Math.round(Y - alt - s.ay);
    // riders sit inside: draw them first, then the body over their legs
    const riders = [];
    for (let i = 0; i < v.seats.length; i++) {
      const pid = v.seats[i];
      if (!pid) continue;
      const p = view.players.find((q) => q.id === pid);
      if (p) riders.push([i, p]);
    }
    riders.sort((a, b) => s.seats[a[0]][1] - s.seats[b[0]][1]);
    for (const [i, p] of riders) {
      const [sx, sy] = s.seats[i];
      const spec = playerSpecOf(p, view);
      const eq = p.equip || { L: 'fist', R: 'pistol' };
      const gunner = V.gunners.includes(i);
      const arms = gunner ? [{ slot: 'L', kind: eq.L, color: '#aeb9c9' }, { slot: 'R', kind: eq.R, color: '#aeb9c9' }] : null;
      const cs = drawCharacter('p' + p.id, X + sx, Y - alt + sy, gunner ? p.aim : [Math.PI / 2, Math.PI, 0, -Math.PI / 2][v.dir], spec, arms, dt, { moving: false, noShadow: true, dir: gunner ? undefined : v.dir });
      p._top = cs.top - sy + alt;
    }
    ctx.drawImage(v.flash ? flashOf(s) : s, ax, ay);
    try { ctx.filter = 'none'; } catch { /* ignore */ }
    if (s.em) { if (isFlying) ctx.drawImage(s.em, ax, ay); else emq.push({ s: s.em, x: ax, y: ay }); }
    if (v.charging && Math.random() < 0.3) R.burst(X, Y - alt - 8, ['#3ddc84', '#9af0ff'], 1, 20, 0.5, 0, true);
    if (v.hp < v.maxHp * 0.35 && Math.random() < 0.2) R.smoke(X, Y - alt - 6, '#3a3640', 1, -18, 1, true);
    if (!isFlying && v.charge <= 0 && Math.random() < 0.03) R.burst(v.x, v.y - 6, ['#9af0ff', '#ffffff'], 3, 30, 0.2, 0, true);
  }

  function drawWires(world, ox, oy) {
    const gx0 = Math.max(0, Math.floor((ox - 120) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 120) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 120) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 120) / CH_PX));
    ctx.fillStyle = '#141018';
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const w of world.wireGrid[gy * world.gridW + gx]) {
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const n = Math.ceil(len / 2), sag = len * 0.08;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        ctx.fillRect(Math.round(w.x1 + (w.x2 - w.x1) * t), Math.round(w.y1 + (w.y2 - w.y1) * t + Math.sin(t * Math.PI) * sag), 1, 1);
      }
      if (w.cl !== undefined) {
        // laundry hanging on the line, moving a little in the wind
        for (let i = 2; i < n - 1; i += 3) {
          const t = i / n, x = Math.round(w.x1 + (w.x2 - w.x1) * t), y = Math.round(w.y1 + (w.y2 - w.y1) * t + Math.sin(t * Math.PI) * sag);
          const sw = Math.sin(R.time * 2 + i) > 0.6 ? 1 : 0;
          ctx.fillStyle = CLOTH[(i + w.cl) % CLOTH.length];
          ctx.fillRect(x + sw, y + 1, 2, 3 + ((i * 7 + w.cl) % 3));
        }
        ctx.fillStyle = '#141018';
      }
    }
  }

  function emitSmoke(world, ox, oy, dt) {
    R.smokeT += dt;
    if (R.smokeT < 0.12) return;
    R.smokeT = 0;
    const gx0 = Math.max(0, Math.floor(ox / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw) / CH_PX));
    const gy0 = Math.max(0, Math.floor(oy / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 60) / CH_PX));
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const s of world.smokeGrid[gy * world.gridW + gx]) {
      if (s.x < ox - 40 || s.x > ox + R.vw + 40 || s.y < oy - 40 || s.y > oy + R.vh + 60) continue;
      if (s.k === 'smoke') {
        // chimney on a roof: emit at the projected roof position
        const k = projK(s.z || 30);
        if (Math.random() < 0.6) R.smoke(scx + (s.x - scx) * k, scy + (s.y - scy) * k, Math.random() < 0.5 ? '#3a3644' : '#5a5664', 1, -12, 2.6, true);
      } else if (s.k === 'steam') { if (Math.random() < 0.35) R.smoke(s.x, s.y, '#a8b0c0', 1, -10, 1.2); }
      else if (Math.random() < 0.3) R.smoke(s.x, s.y, '#8a8a96', 1, -12, 0.9);
    }
  }

  function drawHolograms(world, ox, oy, night) {
    const gx0 = Math.max(0, Math.floor((ox - 120) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 120) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 120) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 120) / CH_PX));
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const h of world.holoGrid[gy * world.gridW + gx]) {
      const s = holoSprite(h.brand);
      const k = projK((h.z || 80) + 14);
      const hx = scx + (h.x - scx) * k, hy = scy + (h.y - scy) * k;
      const bob = Math.sin(R.time * 1.5 + h.seed) * 2;
      const flick = Math.random() < 0.04 ? 0.3 : 1;
      const x = Math.round(hx - s.width / 2), y = Math.round(hy - s.height - 6 + bob);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (0.55 + 0.4 * night) * flick;
      ctx.drawImage(s, x, y);
      ctx.globalAlpha = 0.14 + 0.14 * night;
      ctx.fillStyle = BRANDS[h.brand].c;
      for (let i = 0; i < 8; i++) ctx.fillRect(Math.round(hx - i * 1.2), Math.round(hy - i * 1.4), Math.max(1, Math.round(i * 2.4)), 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // neon letters standing on steel frames on the roofs (letreiros), and the big neon cross on top of each church
  const roofCache = new Map();
  function roofSignSprite(sg, alt) {
    const key = sg.kind + (sg.text || sg.brand) + ':' + alt;
    let c = roofCache.get(key);
    if (c) return c;
    if (sg.kind === 'cross') {
      const w = 15, h = 30;
      c = mk(w, h);
      const g = c.getContext('2d');
      const F = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x, y, ww, hh); };
      F(5, 0, 5, 24, '#2a2236'); F(0, 5, 15, 5, '#2a2236');                     // the frame
      const col = alt ? '#ffffff' : '#ffd23f';
      F(6, 1, 3, 22, col); F(1, 6, 13, 3, col);
      F(7, 2, 1, 20, '#ffffff'); F(2, 7, 11, 1, '#ffffff');
      F(6, 23, 3, 7, '#5a5664'); F(4, 28, 7, 2, '#3a3646');                    // the post on the dome
      roofCache.set(key, c);
      c.ax = 7; c.ay = 30;
      return c;
    }
    const B = sg.brand >= 0 ? BRANDS[sg.brand] : { name: sg.text || 'BAR', c: '#ff3fa4', c2: '#22e5ff' };
    let word = (sg.text || B.name).toUpperCase();
    const maxCh = Math.max(3, Math.floor((sg.maxW || 60) / 6));
    if (word.length > maxCh) word = word.split(/[ .]/)[0].slice(0, maxCh);
    const col = alt ? (B.c2 || B.c) : B.c;
    const t = textSprite(word, col, null);
    const w = t.width * 2 + 6, h = t.height * 2 + 13;
    c = mk(w, h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    // steel frame: two legs and a cross bar, under big letters (scaled x2)
    g.fillStyle = '#3a3646'; g.fillRect(3, h - 9, 1, 9); g.fillRect(w - 4, h - 9, 1, 9); g.fillRect(2, h - 7, w - 4, 1);
    for (let x = 6; x < w - 6; x += 6) g.fillRect(x, h - 9, 1, 3);
    g.fillStyle = 'rgba(10,6,20,0.85)'; g.fillRect(1, 1, w - 2, t.height * 2 + 3);
    g.drawImage(t, 3, 2, t.width * 2, t.height * 2);
    g.fillStyle = col; g.fillRect(1, t.height * 2 + 4, w - 2, 1);
    c.ax = w >> 1; c.ay = h;
    roofCache.set(key, c);
    return c;
  }
  function drawRoofSigns(world, ox, oy, night) {
    if (!world.roofGrid) return;
    const gx0 = Math.max(0, Math.floor((ox - 120) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 120) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 120) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 140) / CH_PX));
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const sg of world.roofGrid[gy * world.gridW + gx]) {
      const k = projK(sg.z || 40);
      const hx = scx + (sg.x - scx) * k, hy = scy + (sg.y - scy) * k;
      if (hx < ox - 80 || hx > ox + R.vw + 80 || hy < oy - 60 || hy > oy + R.vh + 80) continue;
      const st = sg.kind === 'cross' ? Math.floor(R.time / 1.6 + sg.seed) % 2 : sg.anim === 'chase' ? Math.floor(R.time * 1.5 + sg.seed) % 2 : 0;
      const off = sg.anim === 'flicker' && hash2(Math.floor(R.time * 9 + sg.seed), 3, sg.seed) < 0.12;
      const s = roofSignSprite(sg, st);
      const x = Math.round(hx - s.ax), y = Math.round(hy - s.ay);
      ctx.globalAlpha = off ? 0.35 : 1;
      ctx.drawImage(s, x, y);
      if (!off) {
        // neon glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.18 + 0.32 * night;
        ctx.drawImage(s, x - 1, y); ctx.drawImage(s, x + 1, y); ctx.drawImage(s, x, y - 1);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
    }
  }

  const PROJ = {
    pulse: ['#22e5ff', '#ffffff', 3], pellet: ['#ffb84a', '#fff0a0', 2], smart: ['#3ddc84', '#d0ffe0', 2], tbullet: ['#ffd23f', '#ffffff', 3],
    rocket: ['#ff8a3d', '#ffffff', 4], ebullet: ['#ff3b5c', '#ffd0d8', 3], eball: ['#c86bff', '#ffffff', 4], erocket: ['#ff3b5c', '#ffffff', 4],
    eplasma: ['#7dff4a', '#e8ffd8', 4],
  };
  function drawProjectiles(projs) {
    for (const p of projs) {
      const st = PROJ[p.kind] || PROJ.pulse;
      const len = Math.hypot(p.vx, p.vy) || 1;
      const ux = p.vx / len, uy = p.vy / len;
      const x = Math.round(p.x), y = Math.round(p.y);
      ctx.fillStyle = st[0];
      for (let i = 1; i <= st[2] + 2; i++) { ctx.globalAlpha = 1 - i / (st[2] + 3); ctx.fillRect(Math.round(p.x - ux * i * 1.6), Math.round(p.y - uy * i * 1.6), 1, 1); }
      ctx.globalAlpha = 1;
      if (p.kind === 'ebullet' || p.kind === 'eball' || p.kind === 'eplasma') {
        const r = p.kind === 'ebullet' ? 1 : 2;
        ctx.fillRect(x - r, y - r, r * 2 + 1, r * 2 + 1);
        ctx.fillStyle = st[1]; ctx.fillRect(x, y, 1, 1);
      } else if (p.kind === 'rocket' || p.kind === 'erocket') {
        ctx.fillStyle = '#3a3a46'; ctx.fillRect(x - 1, y - 1, 3, 3);
        ctx.fillStyle = st[0]; ctx.fillRect(Math.round(x + ux * 2), Math.round(y + uy * 2), 2, 2);
        if (Math.random() < 0.7) R.particles.push({ x: p.x - ux * 4, y: p.y - uy * 4, vx: (Math.random() - 0.5) * 10, vy: -8, life: 0.6, t: 0, c: Math.random() < 0.5 ? '#6a6474' : '#8a8494', g: 0, sz: 2, smoke: true });
        R.particles.push({ x: p.x - ux * 3, y: p.y - uy * 3, vx: -ux * 30, vy: -uy * 30, life: 0.15, t: 0, c: '#ffd23f', g: 0, sz: 2, em: true });
      } else {
        ctx.fillStyle = st[1]; ctx.fillRect(x, y, 2, 1);
      }
    }
  }

  function drawEffects(dt) {
    const keep = [];
    for (const e of R.effects) {
      e.t += dt;
      const life = e.life || 0.3;
      if (e.k === 'tele') { if (e.t < e.d) keep.push(e); continue; }
      if (e.t > life) continue;
      keep.push(e);
      const p = e.t / life;
      if (e.k === 'arc') {
        ctx.fillStyle = e.c;
        const n = 14, r = e.r;
        for (let i = 0; i <= n * Math.min(1, p * 2); i++) {
          const a = e.a - e.arc / 2 + (i / n) * e.arc;
          ctx.fillRect(Math.round(e.x + Math.cos(a) * r), Math.round(e.y + Math.sin(a) * r), 2, 2);
          if (i % 2) { ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(e.x + Math.cos(a) * (r - 2)), Math.round(e.y + Math.sin(a) * (r - 2)), 1, 1); ctx.fillStyle = e.c; }
        }
      } else if (e.k === 'whip') {
        const n = 20;
        ctx.fillStyle = p < 0.5 ? '#ffffff' : '#9af0ff';
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const w = Math.sin(t * Math.PI * 3 + e.t * 40) * 2 * (1 - p) * Math.sin(t * Math.PI);
          const nx = -(e.y2 - e.y), ny = e.x2 - e.x, nl = Math.hypot(nx, ny) || 1;
          ctx.fillRect(Math.round(e.x + (e.x2 - e.x) * t + nx / nl * w), Math.round(e.y + (e.y2 - e.y) * t + ny / nl * w), 1, 1);
        }
      } else if (e.k === 'beam') {
        const steps = Math.ceil(Math.hypot(e.x2 - e.x, e.y2 - e.y) / 2);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = Math.round(e.x + (e.x2 - e.x) * t), y = Math.round(e.y + (e.y2 - e.y) * t);
          ctx.fillStyle = e.c; ctx.fillRect(x - 1, y - 1, 3, 3);
          if (p < 0.6) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, 1, 1); }
        }
      } else if (e.k === 'zap') {
        const n = Math.max(4, Math.ceil(Math.hypot(e.x2 - e.x, e.y2 - e.y) / 6));
        let px = e.x, py = e.y;
        ctx.fillStyle = p < 0.5 ? '#ffffff' : '#9af0ff';
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const nx = e.x + (e.x2 - e.x) * t + (i < n ? (Math.random() - 0.5) * 8 : 0), ny = e.y + (e.y2 - e.y) * t + (i < n ? (Math.random() - 0.5) * 8 : 0);
          const steps = Math.ceil(Math.hypot(nx - px, ny - py));
          for (let s2 = 0; s2 <= steps; s2++) ctx.fillRect(Math.round(px + (nx - px) * s2 / steps), Math.round(py + (ny - py) * s2 / steps), 1, 1);
          px = nx; py = ny;
        }
      } else if (e.k === 'ring' || e.k === 'shock') {
        ctx.globalAlpha = 1 - p;
        pixCircle(e.x, e.y, e.r * (0.3 + p * 0.7), e.c);
        if (e.r > 30 || e.k === 'shock') pixCircle(e.x, e.y, e.r * (0.2 + p * 0.6), e.c);
        ctx.globalAlpha = 1;
      } else if (e.k === 'boom') {
        // layered fireball with a ragged edge
        const r = e.r * (0.35 + Math.sqrt(p) * 0.75);
        const layers = e.zap ? ['#ffffff', '#9af0ff', '#4f7bff', '#1a2a5a'] : ['#ffffff', '#fff3a0', '#ffb84a', '#ff5a2b', '#8a2a1a', '#3a2a2e'];
        const li = Math.min(layers.length - 1, Math.floor(p * layers.length));
        ctx.globalAlpha = 1 - p * 0.6;
        ctx.fillStyle = layers[li];
        pixCircleFill(e.x, e.y - p * 6, r);
        if (li + 1 < layers.length) { ctx.fillStyle = layers[Math.max(0, li - 1)]; pixCircleFill(e.x + Math.sin(e.t * 30) * 2, e.y - p * 8, r * 0.55); }
        for (let i = 0; i < 10; i++) {
          const a = i * 0.63 + e.x * 0.1, rr = r * (0.85 + 0.3 * Math.sin(i * 7.3 + e.t * 20));
          ctx.fillStyle = layers[Math.min(layers.length - 1, li + 1)];
          ctx.fillRect(Math.round(e.x + Math.cos(a) * rr) - 2, Math.round(e.y - p * 6 + Math.sin(a) * rr * 0.75) - 2, 4, 4);
        }
        ctx.globalAlpha = 1;
      } else if (e.k === 'muzzle') {
        const big = e.big;
        ctx.fillStyle = '#fff6c0';
        ctx.fillRect(Math.round(e.x) - 1, Math.round(e.y) - 1, 3, 3);
        ctx.fillStyle = e.c || '#ffd23f';
        for (let i = 1; i <= (big ? 6 : 3); i++) ctx.fillRect(Math.round(e.x + Math.cos(e.a) * i * 1.5), Math.round(e.y + Math.sin(e.a) * i * 1.5), 2, 2);
        if (big) { ctx.fillRect(Math.round(e.x + Math.cos(e.a + 1.4) * 3), Math.round(e.y + Math.sin(e.a + 1.4) * 3), 2, 2); ctx.fillRect(Math.round(e.x + Math.cos(e.a - 1.4) * 3), Math.round(e.y + Math.sin(e.a - 1.4) * 3), 2, 2); }
      } else if (e.k === 'pillar') {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = e.c;
        const h = 60 * Math.min(1, p * 3);
        ctx.fillRect(Math.round(e.x - 3), Math.round(e.y - h), 6, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(e.x - 1), Math.round(e.y - h), 2, h);
        ctx.globalAlpha = 1;
      }
    }
    R.effects = keep;
  }

  // layer: 'ground' (smoke & dust under the lighting), 'em' (glowing: sparks, fire), 'hi' (above buildings)
  function drawParticles(dt, layer) {
    const keep = [];
    for (const p of R.particles) {
      const L = p.hi ? 'hi' : p.em ? 'em' : 'ground';
      if (L !== layer) { keep.push(p); continue; }
      p.t += dt;
      if (p.t > p.life) continue;
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.floor !== undefined && p.vy > 0 && p.y >= p.floor) { addStain(p.x, p.floor, p.sz, p.c, p.oil, Math.random() < 0.45 ? 1 + (Math.random() < 0.3 ? 1 : 0) : 0); continue; }
      if (p.smoke) { p.vx *= 0.99; p.vy *= 0.985; } else { p.vx *= 0.96; p.vy *= p.g ? 1 : 0.96; }
      ctx.fillStyle = p.c;
      ctx.globalAlpha = p.smoke ? Math.min(0.55, (1 - p.t / p.life) * 0.75) : Math.min(1, (1 - p.t / p.life) * 1.5);
      const sz = p.smoke ? p.sz + Math.floor(p.t / p.life * 4) : p.sz;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), sz, sz);
      keep.push(p);
    }
    ctx.globalAlpha = 1;
    if (keep.length > 1600) keep.splice(0, keep.length - 1600);
    R.particles = keep;
  }

  // ---------------------------------------------------------------- tags, texts, arrows, waypoints
  function hpBar(x, y, w, frac, col) {
    x = Math.round(x - w / 2); y = Math.round(y);
    ctx.fillStyle = '#0b0710'; ctx.fillRect(x - 1, y - 1, w + 2, 4);
    ctx.fillStyle = '#3a1a22'; ctx.fillRect(x, y, w, 2);
    ctx.fillStyle = col || (frac > 0.6 ? '#3ddc84' : frac > 0.3 ? '#ffd23f' : '#ff3b5c');
    ctx.fillRect(x, y, Math.max(0, Math.round(w * frac)), 2);
  }

  function playerTag(p, view, x, top) {
    const me = view.me;
    const hostile = view.mode === 'pvp' && me && p.gang !== view.myGang;
    if (hostile) { ctx.fillStyle = '#ff3b5c'; ctx.fillRect(Math.round(x - 1), Math.round(top - 14), 3, 2); ctx.fillRect(Math.round(x), Math.round(top - 12), 1, 1); }
    drawText(ctx, p.name, x, top - 8, p.color || '#ffffff');
    if (view.mode === 'pvp') { ctx.fillStyle = GANG_COLORS[p.gang] || '#fff'; const w = p.name.length * 4 + 1; ctx.fillRect(Math.round(x - w / 2 - 4), Math.round(top - 7), 2, 3); }
    hpBar(x, top - 1, 16, p.hp / p.maxHp, hostile ? '#ff3b5c' : null);
    if (p.chat && p.chat.t > R.time) drawText(ctx, p.chat.text, x, top - 16, '#ffd23f');
  }

  function drawTags(view, list, flying) {
    const me = view.me;
    for (const d of list) {
      if (d.pl) {
        const p = d.pl;
        if (p.cloak && (!me || p.id !== me.id)) continue;
        if (p.down) {
          drawText(ctx, p.name, p.x, p.y - 26, p.color || '#ffffff');
          drawText(ctx, me && p.id !== me.id && p.gang === view.myGang ? '[E] REVIVE' : 'DOWN', p.x, p.y - 34, Math.floor(R.time * 3) % 2 ? '#ff3b5c' : '#ffffff');
          hpBar(p.x, p.y - 19, 18, p._bleed ?? 1, '#ff3b5c');
          continue;
        }
        playerTag(p, view, p.x, p.y - (p._top || 26));
      } else if (d.en) {
        const e = d.en;
        const top = e.y - (e._top || 26);
        const showName = e.boss || e.stars > 0 || e.tier >= 3 || e.hp < e.maxHp || (me && Math.abs(me.x - e.x) < 60 && Math.abs(me.y - e.y) < 50);
        const w = e.boss ? 40 : Math.round(12 + e.tier * 2);
        if (showName) {
          const F = FACTIONS[e.faction];
          const nm = (e.stars ? '*'.repeat(Math.min(3, e.stars)) + ' ' : '') + (e.boss ? F.boss : F.tiers[e.tier - 1]);
          drawText(ctx, nm, e.x, top - 8, e.stars ? '#ffd23f' : FACTIONS[e.faction].color);
        }
        hpBar(e.x, top - 1, w, e.hp / e.maxHp, e.boss ? '#ff3b5c' : null);
      } else if (d.al) {
        const a = d.al;
        const top = a.y - (a._top || 24);
        const gc = GANG_COLORS[a.team] || view.gangColor;
        const hostile = view.mode === 'pvp' && a.team !== view.myGang;
        if (a.follow) {
          const owner = view.players.find((p) => p.id === a.follow);
          ctx.fillStyle = owner ? owner.color || gc : gc;
          ctx.fillRect(Math.round(a.x - 2), Math.round(top - 5), 5, 1); ctx.fillRect(Math.round(a.x - 1), Math.round(top - 4), 3, 1); ctx.fillRect(Math.round(a.x), Math.round(top - 3), 1, 1);
          if ((a.lvl || 1) > 1) drawText(ctx, '*'.repeat(a.lvl - 1), a.x, top - 12, '#ffd23f');
        }
        if (a.hp < a.maxHp || hostile) hpBar(a.x, top - 1, 12, a.hp / a.maxHp, hostile ? '#ff3b5c' : gc);
      } else if (d.pr) {
        const ch = d.pr, top = ch.py - (ch._top || 24);
        if (view.priest === ch.id) drawText(ctx, view.prayCd > 0 ? `PRAY AGAIN IN ${view.prayCd}s` : '[T] PRAY', ch.px, top - 9, view.prayCd > 0 ? '#9a8cc0' : Math.floor(R.time * 3) % 2 ? '#ffd23f' : '#ffffff');
        else if (view.me && Math.abs(view.me.x - ch.px) < 9 * TILE && Math.abs(view.me.y - ch.py) < 7 * TILE) drawText(ctx, 'PADRE', ch.px, top - 9, '#ffd88a');
      } else if (d.pt) {
        if (view.petPrompt === d.pt.id) drawText(ctx, '[G]', d.pt.x, d.pt.y - (d.pt._top || 14) - 4, Math.floor(R.time * 3) % 2 ? '#ffd23f' : '#ffffff');
      } else if (d.cv) {
        const c = d.cv;
        if (c.hpPct < 100) hpBar(c.x, c.y - (c._top || 24) - 1, 10, c.hpPct / 100, '#c8c0d8');
        if (view.civPrompt === c.id) drawText(ctx, '[G]', c.x, c.y - (c._top || 24) - 9, Math.floor(R.time * 3) % 2 ? '#ffd23f' : '#ffffff');
      } else if (d.tu) {
        const t = d.tu;
        if (!t.dead && t.hp < t.maxHp) hpBar(t.x, t.y - 22, 14, t.hp / t.maxHp, GANG_COLORS[t.team]);
        if (t.dead) drawText(ctx, 'REPAIRING', t.x, t.y - 24, '#9a8cc0');
      } else if (d.p && d.p.type === 'station') {
        const p = d.p;
        drawText(ctx, STATION_LABEL[p.kind], p.x, p.y - 38, STATION_COLORS[p.kind], 'center', '#120a1c');
      } else if (d.ve) vehicleTag(d.ve, view);
    }
    for (const v of flying) vehicleTag(v, view);
  }

  function vehicleTag(v, view) {
    const X = v.sx ?? v.x, Y = v.sy ?? v.y;
    const top = Y - (v.alt || 0) - 26;
    const riders = v.seats.filter(Boolean);
    const me = view.me;
    for (const pid of riders) {
      const p = view.players.find((q) => q.id === pid);
      if (p && p.seat === 0) { drawText(ctx, p.name, X, top - 12, p.color || '#fff'); break; }
    }
    if (v.hp < v.maxHp || riders.length) hpBar(X, top - 4, 20, v.hp / v.maxHp, view.mode === 'pvp' && v.team !== view.myGang && riders.length ? '#ff3b5c' : null);
    const w = 20, x = Math.round(X - w / 2), y = Math.round(top);
    ctx.fillStyle = '#0b0710'; ctx.fillRect(x - 1, y - 1, w + 2, 3);
    ctx.fillStyle = v.charge > 25 ? '#22e5ff' : '#ff8a3d'; ctx.fillRect(x, y, Math.round(w * v.charge / 100), 1);
    if (!riders.length && me && Math.abs(me.x - v.x) < 26 && Math.abs(me.y - v.y) < 26 && !me.veh) drawText(ctx, '[V]', X, top - 10, '#ffd23f');
  }

  function drawTexts(dt) {
    const keep = [];
    for (const t of R.texts) {
      t.t += dt;
      if (t.t > t.life) continue;
      keep.push(t);
      t.y += t.vy * dt;
      t.vy *= 0.92;
      ctx.globalAlpha = Math.min(1, (1 - t.t / t.life) * 2);
      drawText(ctx, t.str, t.x, t.y, t.color);
    }
    ctx.globalAlpha = 1;
    if (keep.length > 120) keep.splice(0, keep.length - 120);
    R.texts = keep;
  }

  // a big red pointer circling your character, pointing at the base under attack (never hidden by the HUD panels)
  function alarmArrow(x, y, col, label, sub, view, ox, oy) {
    const me = view.me;
    const cx = me ? me.x - ox : R.vw / 2, cy = me ? me.y - 12 - oy : R.vh / 2;
    const a = Math.atan2(y - cy, x - cx);
    const ca = Math.cos(a), sa = Math.sin(a);
    const rr = 40 + Math.sin(R.time * 6) * 3;
    const px = cx + ca * rr, py = cy + sa * rr * 0.85;
    ctx.fillStyle = '#120a1c';
    for (let i = -1; i < 10; i++) for (let j = -i - 1; j <= i + 1; j++) { const lx = 10 - i, ly = j * 0.7; ctx.fillRect(Math.round(px + ca * lx - sa * ly), Math.round(py + sa * lx + ca * ly), 1, 1); }
    ctx.fillStyle = col;
    for (let i = 0; i < 9; i++) for (let j = -i; j <= i; j++) { const lx = 10 - i, ly = j * 0.7; ctx.fillRect(Math.round(px + ca * lx - sa * ly), Math.round(py + sa * lx + ca * ly), 1, 1); }
    const tx = px + ca * 24, ty = py + sa * 18;
    drawText(ctx, label, tx, ty - 4, col, 'center', '#120a1c');
    if (sub) drawText(ctx, sub, tx, ty + 4, '#ffffff', 'center', '#120a1c');
  }
  function edgeArrow(x, y, col, label, sub) {
    const cx = R.vw / 2, cy = R.vh / 2;
    const a = Math.atan2(y - cy, x - cx);
    const m = 14;
    const k = Math.min((R.vw / 2 - m) / Math.abs(Math.cos(a) || 1e-3), (R.vh / 2 - m) / Math.abs(Math.sin(a) || 1e-3));
    const px = cx + Math.cos(a) * k, py = cy + Math.sin(a) * k;
    ctx.fillStyle = col;
    for (let i = 0; i < 6; i++) for (let j = -i; j <= i; j++) {
      const lx = 6 - i, ly = j * 0.6;
      ctx.fillRect(Math.round(px + Math.cos(a) * lx - Math.sin(a) * ly), Math.round(py + Math.sin(a) * lx + Math.cos(a) * ly), 1, 1);
    }
    drawText(ctx, label, px - Math.cos(a) * 14, py - Math.sin(a) * 14 - 2, col);
    if (sub) drawText(ctx, sub, px - Math.cos(a) * 14, py - Math.sin(a) * 14 + 5, '#c8c0d8');
  }

  function drawRaidArrows(view, ox, oy) {
    // our bases under attack: a red arrow on the screen edge until the fight is over
    const myId = 'g' + view.myGang;
    const ac = Math.floor(R.time * 4) % 2 ? '#ff3b5c' : '#ffffff';
    for (const Rg of view.world.regions) {
      const rs = view.rs[Rg.id];
      if (!rs || !rs.atk || rs.owner !== myId) continue;
      const C = Rg.compound;
      const wx = (C.coreX + 0.5) * TILE, wy = (C.coreY + 0.5) * TILE;
      const x = wx - ox, y = wy - oy;
      if (x > 8 && x < R.vw - 8 && y > 8 && y < R.vh - 8) continue;
      const d = view.me ? Math.round(Math.hypot(wx - view.me.x, wy - view.me.y) / TILE) : 0;
      alarmArrow(x, y, ac, Rg.base ? 'BASE!' : 'ATTACK', d + 'm', view, ox, oy);
    }
    if (!view.raids) return;
    for (const r of view.raids) {
      if (view.mode === 'pvp' && r.g !== view.myGang) continue;
      const C = view.world.regions[r.target].compound;
      const x = (C.coreX + 0.5) * TILE - ox, y = (C.coreY + 0.5) * TILE - oy;
      if (x > 8 && x < R.vw - 8 && y > 8 && y < R.vh - 8) continue;
      if (Math.floor(R.time * 4) % 2) continue;
      edgeArrow(x, y, '#ff3b5c', 'RAID');
    }
  }

  function drawWaypointMarkers(view) {
    for (const w of view.waypoints || []) {
      if (w.x < R.ox - 30 || w.x > R.ox + R.vw + 30 || w.y < R.oy - 60 || w.y > R.oy + R.vh + 30) continue;
      const b = Math.sin(R.time * 4) * 2;
      ctx.globalAlpha = 0.5 + Math.sin(R.time * 4) * 0.2;
      pixCircle(w.x, w.y, 8, w.color); pixCircle(w.x, w.y, 4 + (R.time * 8) % 6, w.color);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = w.color; ctx.fillRect(Math.round(w.x), Math.round(w.y - 34), 1, 34);
      ctx.globalAlpha = 1;
      const y = Math.round(w.y - 40 + b);
      ctx.fillStyle = w.color;
      ctx.fillRect(Math.round(w.x - 3), y, 7, 1); ctx.fillRect(Math.round(w.x - 2), y + 1, 5, 1); ctx.fillRect(Math.round(w.x - 1), y + 2, 3, 1); ctx.fillRect(Math.round(w.x), y + 3, 1, 1);
      drawText(ctx, w.name, w.x, y - 8, w.color);
    }
  }

  function drawWaypointArrows(view, ox, oy) {
    const me = view.me;
    for (const w of view.waypoints || []) {
      const x = w.x - ox, y = w.y - oy;
      if (x > 8 && x < R.vw - 8 && y > 8 && y < R.vh - 8) continue;
      const d = me ? Math.round(Math.hypot(w.x - me.x, w.y - me.y) / TILE) : 0;
      edgeArrow(x, y, w.color, w.name.slice(0, 8), d + 'm');
    }
  }

  // ---------------------------------------------------------------- compounds: owner colors, capture transition
  const EMBLEM = (o) => (typeof o === 'string' && o[0] === 'g' ? ['flame', 'bolt', 'heart', 'coin', 'gear', 'ball'][Number(o.slice(1))] || 'star' : ['star', 'tri', 'speaker', 'eye'][o] || 'star');
  // a district changed hands: walls repaint in a wave from the flag outward, the flag glitches into the new colors
  R.capture = (region, from, to) => {
    const Rg = R.world.regions[region];
    if (!Rg) return;
    const C = Rg.compound;
    const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
    const toC = ownerColorOf(to);
    R.trans.set(region, { t0: R.time, from: ownerColorOf(from), to: toC, x, y, maxR: Math.hypot(C.w, C.h) * TILE * 0.6 });
    R.effect({ k: 'shock', x, y, r: Math.hypot(C.w, C.h) * TILE * 0.7, life: 1.4, c: toC });
    R.effect({ k: 'shock', x, y, r: Math.hypot(C.w, C.h) * TILE * 0.45, life: 1.0, c: '#ffffff' });
    R.effect({ k: 'pillar', x, y: y - 20, c: toC, life: 1.4 });
    R.burst(x, y - 40, [toC, '#ffffff', shade(toC, 0.4)], 70, 160, 1.6, 60, true);
    R.dynLights.push({ x, y, r: 260, c: toC, life: 2.2, t: 0, i: 2, boom: true });
    R.text(x, y - 70, 'DOMINADO!', toC, 2.4, -10);
  };
  function tintFor(view, b) {
    const rs = view.rs[b.compound];
    if (!rs) return '#888888';
    const now = ownerColorOf(rs.owner);
    const tr = R.trans.get(b.compound);
    if (!tr) return now;
    const age = R.time - tr.t0;
    if (age > 2.4) { R.trans.delete(b.compound); return now; }
    const d = Math.hypot((b.x + b.w / 2) * TILE - tr.x, (b.y + b.h / 2) * TILE - tr.y);
    const reached = d < (age / 1.6) * tr.maxR;
    const col = reached ? tr.to : tr.from;
    if (reached && b._wave !== tr.t0) {
      b._wave = tr.t0;
      for (let i = 0; i < 6; i++) R.particles.push({ x: (b.x + Math.random() * b.w) * TILE, y: (b.y + Math.random() * b.h) * TILE - 6, vx: (Math.random() - 0.5) * 30, vy: -40 - Math.random() * 40, life: 0.7, t: 0, c: Math.random() < 0.5 ? tr.to : '#ffffff', g: 40, sz: 2, em: true, hi: true });
    }
    return col;
  }

  // animated capture ring around every flag: rotating dashes, ticks, and a glowing progress arc
  function drawCaptureRings(view) {
    for (const Rg of view.world.regions) {
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE + 2;
      if (x < R.ox - 80 || x > R.ox + R.vw + 80 || y < R.oy - 80 || y > R.oy + R.vh + 80) continue;
      const rs = view.rs[Rg.id];
      if (!rs) continue;
      const col = ownerColor(rs.owner);
      const r = 2.6 * TILE, t = R.time;
      const pt = (a, rr) => [Math.round(x + Math.cos(a) * rr), Math.round(y + Math.sin(a) * rr * 0.72)];
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = col;
      for (let i = 0; i < 28; i++) { const a0 = t * 0.4 + (i / 28) * Math.PI * 2; for (let k = 0; k < 3; k++) { const [px, py] = pt(a0 + k * 0.03, r); ctx.fillRect(px, py, 1, 1); } }
      ctx.globalAlpha = 0.35;
      for (let i = 0; i < 40; i++) { const [px, py] = pt(-t * 0.7 + (i / 40) * Math.PI * 2, r - 5); if (i % 2) ctx.fillRect(px, py, 1, 1); }
      ctx.globalAlpha = 0.5 + Math.sin(t * 4) * 0.3;
      for (let q = 0; q < 4; q++) {
        const a = q * Math.PI / 2;
        for (let k = 0; k < 3; k++) { const [px, py] = pt(a - 0.06 + k * 0.06, r + 4 - Math.abs(k - 1) * 2); ctx.fillRect(px - 1, py - 1, 2, 2); }
      }
      ctx.globalAlpha = 1;
      // an abandoned district: say so over the core (free to take)
      if (rs.owner === 9 && !(rs.capture > 0) && view.me && Math.abs(view.me.x - x) < 12 * TILE && Math.abs(view.me.y - y) < 9 * TILE) drawText(ctx, Math.floor(t * 1.5) % 2 ? 'VAZIO' : 'EMPTY - TAKE IT', x, y - 30, '#c8c8d0', 'center', '#120a1c');
      if (rs.shield) {
        const pulse = 0.55 + Math.sin(t * 2.4) * 0.2;
        const sr = r + 9, sy = y - 8;
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.1 + 0.07 * pulse;
        pixCircleFill(x, sy, sr, 0.8);
        ctx.globalAlpha = 0.35 + 0.5 * pulse;
        pixCircle(x, sy, sr, col, 0.8);
        pixCircle(x, sy - 3, sr - 6, col, 0.55);
        ctx.globalAlpha = 0.8;
        for (let i = 0; i < 12; i++) { const a = t * 0.6 + i * 0.5236; const rr = sr * (0.35 + 0.6 * (((i * 37) % 10) / 10)); ctx.fillRect(Math.round(x + Math.cos(a) * rr), Math.round(sy + Math.sin(a) * rr * 0.8), 1, 1); }
        ctx.globalAlpha = 1;
        const me = view.me;
        if (me && rs.owner !== 'g' + view.myGang && Math.abs(me.x - x) < 9 * TILE && Math.abs(me.y - y) < 7 * TILE) drawText(ctx, 'SHIELDED', x, sy - sr * 0.8 - 8, col);
      }
      if (rs.capture > 0) {
        const cc = rs.capBy === 'raid' ? '#ff3b5c' : rs.capBy !== null && rs.capBy !== undefined ? ownerColor(rs.capBy) : '#ff3b5c';
        ctx.globalAlpha = 0.12 + Math.sin(t * 8) * 0.05;
        ctx.fillStyle = cc;
        pixCircleFill(x, y, r - 2, 0.72);
        ctx.globalAlpha = 1;
        const n = 90, m = Math.floor(n * rs.capture);
        for (let i = 0; i <= m; i++) {
          const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
          const [px, py] = pt(a, r);
          ctx.fillStyle = i >= m - 2 ? '#ffffff' : cc;
          ctx.fillRect(px - 1, py - 1, 3, 3);
        }
        if (Math.random() < 0.5) { const a = -Math.PI / 2 + rs.capture * Math.PI * 2; const [px, py] = pt(a, r); R.particles.push({ x: px, y: py, vx: (Math.random() - 0.5) * 20, vy: -30, life: 0.6, t: 0, c: cc, g: 0, sz: 1, em: true }); }
      }
    }
  }

  // holographic flags floating above each compound's pylon: waving, scanlines, glitches
  const flagCache = new Map();
  function flagCanvas(owner) {
    const key = String(owner);
    let c = flagCache.get(key);
    if (c) return c;
    const col = ownerColorOf(owner);
    c = mk(30, 18);
    const g = c.getContext('2d');
    const F = (x, y, w, h, cl) => { g.fillStyle = cl; g.fillRect(x, y, w, h); };
    F(0, 0, 30, 18, rgba(col, 0.35));
    F(0, 0, 30, 1, col); F(0, 17, 30, 1, col); F(0, 0, 1, 18, col); F(29, 0, 1, 18, col);
    for (let y = 2; y < 17; y += 4) F(1, y, 28, 1, rgba(col, 0.25));
    drawLogo(F, EMBLEM(owner), 8, 2, '#ffffff', col, 2);
    g.globalCompositeOperation = 'destination-out';
    for (let y = 1; y < 18; y += 2) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, y, 30, 1); }
    flagCache.set(key, c);
    return c;
  }
  function drawFlags(view, ox, oy, night) {
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    const k = projK(34);
    ctx.globalCompositeOperation = 'lighter';
    for (const Rg of view.world.regions) {
      const C = Rg.compound;
      const bx = (C.coreX + 0.5) * TILE, by = (C.coreY + 0.5) * TILE;
      if (bx < ox - 100 || bx > ox + R.vw + 100 || by < oy - 60 || by > oy + R.vh + 120) continue;
      const rs = view.rs[Rg.id];
      if (!rs) continue;
      const tr = R.trans.get(Rg.id);
      const age = tr ? R.time - tr.t0 : 9;
      const owner = rs.owner;
      const col = ownerColor(owner);
      const X = Math.round(scx + (bx - scx) * k), Y = Math.round(scy + (by - 22 - scy) * k);
      const top = Y - 34;
      // projector beam from the pylon to the flag
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = col;
      for (let y = top; y < Y; y += 2) ctx.fillRect(X, y, 1, 1);
      ctx.globalAlpha = 0.15;
      ctx.fillRect(X - 2, top, 5, Y - top);
      const f = flagCanvas(owner);
      const glitch = age < 0.9 || Math.random() < 0.015;
      const base = (0.6 + 0.3 * night) * (age < 0.9 ? 0.4 + Math.random() * 0.6 : 0.85 + Math.random() * 0.15);
      for (let x = 0; x < f.width; x++) {
        const wave = Math.sin(R.time * 3.2 + x * 0.32) * 2.2 * (x / f.width) + (glitch && Math.random() < 0.2 ? (Math.random() - 0.5) * 6 : 0);
        ctx.globalAlpha = base;
        ctx.drawImage(f, x, 0, 1, f.height, X + 2 + x, Math.round(top + wave), 1, f.height);
      }
      if (age < 0.4) { ctx.globalAlpha = 1 - age / 0.4; ctx.fillStyle = '#ffffff'; ctx.fillRect(X + 2, top - 2, f.width, f.height + 4); }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // hologram labels over the main base buildings (ARSENAL, CLINICA, ARMARIO, COFRE, GARAGEM)
  const labelCache = new Map();
  const LABEL = { arsenal: 'ARSENAL', clinic: 'CLINICA', locker: 'ARMARIO', vault: 'COFRE', garage: 'GARAGEM', boca: 'BOCA', king: 'BOCA KING' };
  const LABEL_ICON = { arsenal: 'star', clinic: 'cross', locker: 'box', vault: 'coin', garage: 'gear', boca: 'coin', king: 'star' };
  function labelCanvas(kind, extra = '') {
    const ck = kind + extra;
    let c = labelCache.get(ck);
    if (c) return c;
    const col = kind === 'king' ? '#ffd23f' : STATION_COLORS[kind] || '#ffffff';
    const t = textSprite(LABEL[kind] + extra, col, null);
    const w = t.width * 2 + 22, h = 16;
    c = mk(w, h);
    const g = c.getContext('2d');
    g.fillStyle = rgba(col, 0.18); g.fillRect(0, 0, w, h);
    g.fillStyle = col; g.fillRect(0, 0, w, 1); g.fillRect(0, h - 1, w, 1);
    drawLogo((x, y, ww, hh, cl) => { g.fillStyle = cl; g.fillRect(x, y, ww, hh); }, LABEL_ICON[kind], 3, 4, col, '#ffffff');
    g.imageSmoothingEnabled = false;
    g.drawImage(t, 0, 0, t.width, t.height, 14, 3, t.width * 2, t.height * 2);
    g.globalCompositeOperation = 'destination-out';
    for (let y = 1; y < h; y += 2) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, y, w, 1); }
    labelCache.set(ck, c);
    return c;
  }
  function drawBaseSigns(view, ox, oy, night) {
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    ctx.globalCompositeOperation = 'lighter';
    for (const b0 of view.world.bases) {
      const C = view.world.regions[b0].compound;
      if (!C.stations || C.small) continue;
      for (const st of C.stations) {
        const b = st.b;
        if (!b) continue;
        const wx = (b.x + b.w / 2) * TILE, wy = (b.doorN ? b.y + b.h - 0.8 : b.y + 0.8) * TILE;
        if (wx < ox - 120 || wx > ox + R.vw + 120 || wy < oy - 120 || wy > oy + R.vh + 140) continue;
        const z = (b.H || 30) + 8;
        const k = projK(z);
        const X = scx + (wx - scx) * k, Y = scy + (wy - scy) * k;
        const c = labelCanvas(st.kind);
        ctx.globalAlpha = (0.55 + 0.35 * night) * (Math.random() < 0.03 ? 0.4 : 1);
        ctx.drawImage(c, Math.round(X - c.width / 2), Math.round(Y - c.height / 2 + Math.sin(R.time * 1.7 + wx) * 1.5));
      }
    }
    // the BOCA KING: a huge golden hologram over the central base
    if (view.world.kingId >= 0) {
      const C = view.world.regions[view.world.kingId].compound;
      const wx = (C.coreX + 0.5) * TILE, wy = (C.coreY - 1) * TILE;
      if (wx > ox - 200 && wx < ox + R.vw + 200 && wy > oy - 200 && wy < oy + R.vh + 260) {
        const k = projK(70), c = labelCanvas('king');
        const X = scx + (wx - scx) * k, Y = scy + (wy - scy) * k + Math.sin(R.time * 1.4) * 2;
        ctx.globalAlpha = 0.75 + 0.25 * Math.sin(R.time * 3);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(c, Math.round(X - c.width), Math.round(Y - c.height), c.width * 2, c.height * 2);
      }
    }
    // every boca held by a gang shows its sign (with its upgrade level)
    for (const Rg of view.world.regions) {
      const B = Rg.compound.boca;
      if (!B || !B.b) continue;
      const rs = view.rs[Rg.id];
      if (!rs || typeof rs.owner !== 'string') continue;
      const b = B.b;
      const wx = (b.x + b.w / 2) * TILE, wy = (b.y + b.h / 2) * TILE;
      if (wx < ox - 120 || wx > ox + R.vw + 120 || wy < oy - 120 || wy > oy + R.vh + 140) continue;
      const k = projK((b.H || 20) + 10);
      const lvl = rs.up ? rs.up.boca || 0 : 0;
      const c = labelCanvas('boca', lvl ? ' ' + '*'.repeat(lvl) : '');
      ctx.globalAlpha = (0.6 + 0.35 * night) * (Math.random() < 0.04 ? 0.4 : 1);
      ctx.drawImage(c, Math.round(scx + (wx - scx) * k - c.width / 2), Math.round(scy + (wy - scy) * k - c.height / 2 + Math.sin(R.time * 2.1 + wx) * 1.5));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // little flags strung between the outpost shacks, in the owner's color
  function drawBunting(view, ox, oy) {
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    const k = projK(20);
    for (const Rg of view.world.regions) {
      const C = Rg.compound;
      if (!C.bunting || !C.bunting.length) continue;
      const cx = (C.coreX + 0.5) * TILE, cy = (C.coreY + 0.5) * TILE;
      if (cx < ox - 150 || cx > ox + R.vw + 150 || cy < oy - 150 || cy > oy + R.vh + 150) continue;
      const rs = view.rs[Rg.id];
      if (!rs) continue;
      const col = ownerColor(rs.owner);
      for (const w of C.bunting) {
        const x1 = scx + (w.x1 - scx) * k, y1 = scy + (w.y1 - scy) * k, x2 = scx + (w.x2 - scx) * k, y2 = scy + (w.y2 - scy) * k;
        const len = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(len / 2);
        for (let i = 0; i <= n; i++) {
          const t = i / n, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t + Math.sin(t * Math.PI) * len * 0.07;
          ctx.fillStyle = '#1a1418'; ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
          if (w.lights) {
            if (i % 3 === 0) { const on = (Math.floor(R.time * 3) + i / 3) % 4 !== 0; ctx.fillStyle = on ? ['#ffd88a', '#ff3fa4', '#22e5ff', col][(i / 3) % 4] : '#3a2a20'; ctx.fillRect(Math.round(x), Math.round(y) + 1, 2, 2); }
            continue;
          }
          if (i % 4 === 0) { const sway = Math.sin(R.time * 4 + i) > 0 ? 1 : 0; ctx.fillStyle = (i / 4) % 2 ? '#f2f2f2' : col; ctx.fillRect(Math.round(x) - 1, Math.round(y) + 1, 3, 2); ctx.fillRect(Math.round(x) + sway - 0, Math.round(y) + 3, 1, 1); }
        }
      }
    }
  }

  // police patrol car: flies in with sirens, drops the cops, flies away
  function drawPoliceCar(c, view, ox, oy, amb) {
    if (c.x < ox - 100 || c.x > ox + R.vw + 100 || c.y < oy - 100 || c.y > oy + R.vh + 100) return;
    const scx = ox + R.vw / 2, scy = oy + R.vh / 2;
    const alt = c.state === 1 ? 10 : c.state === 3 ? 30 : 24;
    const k = projK(alt);
    const X = scx + (c.x - scx) * k, Y = scy + (c.y - scy) * k;
    shadow(c.x, c.y, 14, 0.3);
    const s = vehicleSprite('car', c.dir, '#22306a', Math.floor(R.time * 10) % 2);
    try { ctx.filter = `brightness(${Math.max(0.4, (amb[0] + amb[1] + amb[2]) / 3 + 0.25).toFixed(2)})`; } catch { /* no filters */ }
    ctx.drawImage(s, Math.round(X - s.ax), Math.round(Y - alt - s.ay));
    try { ctx.filter = 'none'; } catch { /* ignore */ }
    if (s.em) ctx.drawImage(s.em, Math.round(X - s.ax), Math.round(Y - alt - s.ay));
    const on = Math.floor(R.time * (c.state === 3 ? 3 : 8)) % 2;
    ctx.fillStyle = on ? '#ff3b3b' : '#3a5aff'; ctx.fillRect(Math.round(X - 5), Math.round(Y - alt - s.ay + 2), 4, 2);
    ctx.fillStyle = on ? '#3a5aff' : '#ff3b3b'; ctx.fillRect(Math.round(X + 1), Math.round(Y - alt - s.ay + 2), 4, 2);
    if (c.state === 3) return;                       // just cruising: no siren
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    pixCircle(c.x, c.y, 14 + (R.time * 20) % 6, on ? '#ff3b3b' : '#3a5aff', 0.5);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  R.policeLights = (view) => {
    const out = [];
    const on = Math.floor(R.time * 8) % 2;
    for (const c of view.pcars || []) {
      if (c.state === 3) { const s2 = Math.floor(R.time * 3) % 2; out.push({ x: c.x, y: c.y, r: 50, c: s2 ? '#ff2a2a' : '#2a4aff', i: 0.6 }); continue; }
      out.push({ x: c.x - 10, y: c.y, r: 90, c: on ? '#ff2a2a' : '#2a4aff', i: 1.1, bloom: true }); out.push({ x: c.x + 10, y: c.y, r: 70, c: on ? '#2a4aff' : '#ff2a2a', i: 0.9, bloom: true });
    }
    for (const e of view.enemies) if (e.faction === 3 && Math.random() < 0.5) out.push({ x: e.x, y: e.y - 14, r: 26, c: (Math.floor(R.time * 6) + e.id) % 2 ? '#ff2a2a' : '#2a4aff', i: 0.6 });
    return out;
  };


  // ---------------------------------------------------------------- blood (oil and sparks for machines)
  const BLOOD = ['#7a0610', '#9a0c18', '#b81624', '#5a040c'];
  const OIL = ['#121218', '#1e1e28', '#2a2636', '#0e0e0a'];
  const GOO = ['#2a6a12', '#3a8a1a', '#4aaa22', '#6ad03a'];
  // a hit: a spray of drops flying away from the shot, falling to the floor where they stain
  R.bleed = (x, y, amount, dir, mech, floorY) => {
    if (!R.bloodOn) return;
    const goo = mech === 'alien';
    if (goo) mech = false;
    const cols = goo ? GOO : mech ? OIL : BLOOD;
    const n = Math.min(34, 6 + Math.round(amount * 0.7));
    for (let i = 0; i < n; i++) {
      const a = dir !== undefined && dir !== null ? dir + (Math.random() - 0.5) * 1.3 : Math.random() * 6.28;
      const sp = 25 + Math.random() * 95;
      R.particles.push({ x: x + (Math.random() - 0.5) * 4, y: y + Math.random() * 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55 - 35 - Math.random() * 40, life: 1.6, t: 0, c: cols[(Math.random() * cols.length) | 0], g: 300, sz: Math.random() < 0.3 ? 2 : 1, floor: floorY + (Math.random() - 0.5) * 8 + Math.sin(a) * 6, oil: mech });
    }
    if (mech) R.burst(x, y + 4, ['#ffd23f', '#ffffff', '#ff8a3d'], 4 + (amount > 20 ? 4 : 0), 90, 0.25, 0, true);
    else if (amount > 8) addStain(x + (Math.random() - 0.5) * 8, floorY + (Math.random() - 0.5) * 4, 3, cols[0], false, 2 + Math.min(5, amount / 8));
  };
  // a body: a pool that spreads over a couple of seconds
  R.pool = (x, y, size, mech) => {
    if (!R.bloodOn) return;
    const goo = mech === 'alien';
    if (goo) mech = false;
    R.stains.push({ x, y, r: 0, rmax: size, c: goo ? GOO[1] : mech ? OIL[1] : BLOOD[1], c2: goo ? '#8aff5a' : mech ? '#3a3448' : '#c41e2a', t: 0, life: 32 + Math.random() * 4, pool: true, oil: mech });
    for (let i = 0; i < 6; i++) { const a = Math.random() * 6.28, d = size * (0.8 + Math.random() * 0.9); addStain(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, 1 + (Math.random() < 0.4 ? 1 : 0), goo ? GOO[0] : mech ? OIL[0] : BLOOD[0], mech); }
    R.bleed(x, y - 10, 30, null, goo ? 'alien' : mech, y);
  };
  function addStain(x, y, sz, c, oil, splat = 0) {
    if (!R.bloodOn) return;
    R.stains.push({ x: Math.round(x), y: Math.round(y), sz, c, t: 0, life: 28 + Math.random() * 6, splat, seed: (Math.random() * 1000) | 0, oil });
    if (R.stains.length > 700) R.stains.splice(0, R.stains.length - 700);
  }
  function drip(x, y, dt, mech) {
    const goo = mech === 'alien';
    if (R.bloodOn && Math.random() < dt * 2.5) addStain(x + (Math.random() - 0.5) * 5, y + (Math.random() - 0.5) * 2, 1, goo ? GOO[(Math.random() * 3) | 0] : mech ? OIL[0] : BLOOD[(Math.random() * 3) | 0], mech === true);
  }
  function drawStains(dt) {
    if (!R.stains.length) return;
    const keep = [];
    const x0 = R.ox - 30, x1 = R.ox + R.vw + 30, y0 = R.oy - 30, y1 = R.oy + R.vh + 30;
    for (const st of R.stains) {
      st.t += dt;
      if (st.t >= st.life) continue;
      keep.push(st);
      if (st.x < x0 || st.x > x1 || st.y < y0 || st.y > y1) continue;
      // fresh blood is bright and wet; it darkens, then fades away in the last seconds
      const fade = Math.min(1, (st.life - st.t) / 8);
      ctx.globalAlpha = 0.9 * fade;
      if (st.pool) {
        st.r = Math.min(st.rmax, st.rmax * Math.min(1, st.t / 2.2) ** 0.6);
        ctx.fillStyle = st.c;
        pixCircleFill(st.x, st.y, st.r, 0.55);
        ctx.fillStyle = st.oil ? '#3a3448' : '#5a040c';
        pixCircle(st.x, st.y, st.r, ctx.fillStyle, 0.55);
        if (st.t < 6) { ctx.fillStyle = st.c2; ctx.globalAlpha = 0.5 * (1 - st.t / 6) * fade; ctx.fillRect(Math.round(st.x - st.r * 0.3), Math.round(st.y - st.r * 0.2), 2, 1); }
      } else {
        ctx.fillStyle = st.c;
        ctx.fillRect(st.x, st.y, st.sz, Math.max(1, st.sz - (st.seed % 2)));
        if (st.splat) {
          for (let i = 0; i < 3 + st.splat; i++) { const a = (st.seed + i * 2.3) % 6.28, d = 1 + ((st.seed * (i + 3)) % (st.splat * 2 + 1)); ctx.fillRect(Math.round(st.x + Math.cos(a) * d), Math.round(st.y + Math.sin(a) * d * 0.6), 1, 1); }
          ctx.fillRect(st.x - 1, st.y - 1, st.splat, st.splat - 1 || 1);
        }
      }
    }
    ctx.globalAlpha = 1;
    R.stains = keep;
  }


  // ---------------------------------------------------------------- grenades in flight, smoke and fire on the ground
  R.grenade = (ev) => { R.grenades.push({ ...ev, t: 0 }); };
  R.grenadeBoom = (ev) => {
    const G0 = GRENADES[ev.k] || {};
    R.grenades = R.grenades.filter((g) => g.id !== ev.id);
    if (ev.k === 'impact' || ev.k === 'sticky') { R.explosion(ev.x, ev.y - 6, ev.k === 'sticky' ? 46 : 54); R.decals.push({ x: ev.x, y: ev.y, r: 14, t: 0, life: 30 }); }
    else if (ev.k === 'flash') {
      R.effect({ k: 'ring', x: ev.x, y: ev.y - 4, r: 84, c: '#ffffff', life: 0.35 });
      R.burst(ev.x, ev.y - 6, ['#ffffff', '#fff8d0'], 30, 140, 0.4, 0, true);
      R.dynLights.push({ x: ev.x, y: ev.y, r: 260, c: '#ffffff', life: 0.5, t: 0, i: 2.5, boom: true });
    } else if (ev.k === 'smoke') R.areas.push({ k: 'smoke', x: ev.x, y: ev.y, r: 64, t: 0, life: 8 });
    else if (ev.k === 'emp') {
      R.areas.push({ k: 'emp', x: ev.x, y: ev.y, r: 86, t: 0, life: 1 });
      R.effect({ k: 'ring', x: ev.x, y: ev.y - 4, r: 86, c: '#22e5ff', life: 0.5 });
      R.burst(ev.x, ev.y - 6, ['#22e5ff', '#9af0ff', '#ffffff'], 28, 120, 0.6, 0, true);
    } else if (ev.k === 'fire') { R.areas.push({ k: 'fire', x: ev.x, y: ev.y, r: 44, t: 0, life: 6 }); R.burst(ev.x, ev.y - 6, ['#ff3fa4', '#ff8a3d', '#ffd23f'], 24, 90, 0.6, 0, true); }
    void G0;
  };
  function drawGrenades(dt) {
    const keep = [];
    for (const g of R.grenades) {
      g.t += dt;
      const u = Math.min(1, g.t / g.T);
      if (g.t > g.T + 2) continue;
      keep.push(g);
      const x = g.x + (g.x2 - g.x) * u, y = g.y + 8 + (g.y2 - g.y - 8) * u, z = Math.sin(u * Math.PI) * (12 + Math.hypot(g.x2 - g.x, g.y2 - g.y) * 0.12) + (1 - u) * 8;
      shadow(x, y, 2, 0.35);
      const c = (GRENADES[g.k] || {}).c || '#fff';
      ctx.fillStyle = '#1a1622'; ctx.fillRect(Math.round(x) - 2, Math.round(y - z) - 2, 4, 4);
      ctx.fillStyle = c; ctx.fillRect(Math.round(x) - 1, Math.round(y - z) - 1, 2, 2);
      if (u >= 1 && Math.floor(R.time * 8) % 2) { ctx.fillStyle = '#ff3b5c'; ctx.fillRect(Math.round(x), Math.round(y - 3), 1, 1); }
      if (Math.random() < 0.4) R.particles.push({ x, y: y - z, vx: 0, vy: 0, life: 0.25, t: 0, c, g: 0, sz: 1, em: true });
    }
    R.grenades = keep;
  }
  function tickAreas(dt) {
    const keep = [];
    for (const a of R.areas) {
      a.t += dt;
      if (a.t > a.life) continue;
      keep.push(a);
      if (a.k === 'smoke') {
        // a thick, rolling cloud
        const fade = Math.min(1, (a.life - a.t) / 2);
        for (let i = 0; i < 5 * fade; i++) {
          const an = Math.random() * 6.28, d = Math.sqrt(Math.random()) * a.r;
          R.particles.push({ x: a.x + Math.cos(an) * d, y: a.y + Math.sin(an) * d * 0.7 - 6, vx: (Math.random() - 0.5) * 8, vy: -4 - Math.random() * 6, life: 1.8, t: 0, c: ['#8a8a96', '#a8a8b4', '#6e6e7a'][(Math.random() * 3) | 0], g: 0, sz: 5 + ((Math.random() * 4) | 0), smoke: true, hi: true });
        }
      } else if (a.k === 'fire') {
        ctx.fillStyle = 'rgba(40,10,10,0.4)'; pixCircleFill(a.x, a.y, a.r, 0.6);
        for (let i = 0; i < 4; i++) {
          const an = Math.random() * 6.28, d = Math.sqrt(Math.random()) * a.r;
          R.particles.push({ x: a.x + Math.cos(an) * d, y: a.y + Math.sin(an) * d * 0.6, vx: (Math.random() - 0.5) * 10, vy: -26 - Math.random() * 20, life: 0.5, t: 0, c: ['#ff3fa4', '#ff8a3d', '#ffd23f'][(Math.random() * 3) | 0], g: 0, sz: 2, em: true, fire: Math.random() < 0.3 });
        }
      }
    }
    R.areas = keep;
  }

  // ---------------------------------------------------------------- things up high: turrets on the walls, radar towers, helicopters
  const P3 = (wx, wy, z) => { const k = projK(z); return [R.vw / 2 + (wx - R.ox - R.vw / 2) * k, R.vh / 2 + (wy - R.oy - R.vh / 2) * k]; };
  function drawRaised(view, raised, ox, oy, dt, night) {
    // works in screen space; the caller's world transform is restored at the end (tags and texts rely on it)
    ctx.save();
    try { drawRaisedInner(view, raised, ox, oy, dt, night); } finally { ctx.restore(); }
  }
  function drawRaisedInner(view, raised, ox, oy, dt, night) {
    const emq = [];
    // turrets standing on the corners of the compound walls
    for (const t of raised) {
      if (t.x < ox - 60 || t.x > ox + R.vw + 60 || t.y < oy - 60 || t.y > oy + R.vh + 80) continue;
      const [X, Y] = P3(t.x, t.y, 12);
      ctx.setTransform(1, 0, 0, 1, Math.round(X - t.x), Math.round(Y - t.y));
      // a concrete pedestal on top of the wall
      ctx.fillStyle = '#5a5664'; ctx.fillRect(Math.round(t.x - 7), Math.round(t.y - 4), 14, 6); ctx.fillStyle = '#7a7688'; ctx.fillRect(Math.round(t.x - 7), Math.round(t.y - 5), 14, 2);
      const gc = GANG_COLORS[t.team] || '#ff3b5c';
      ctx.fillStyle = gc; ctx.fillRect(Math.round(t.x - 7), Math.round(t.y + 1), 14, 1);
      drawTurret(t, view, emq);
      for (const q of emq) ctx.drawImage(q.s, q.x, q.y);
      emq.length = 0;
      if (!t.dead && t.hp < t.maxHp) hpBar(t.x, t.y - 24, 16, t.hp / t.maxHp, t.hp / t.maxHp > 0.3 ? gc : '#ff3b5c');
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // radar towers: tall lattice with a turning dish and a blinking light
    for (const Rg of view.world.regions) {
      const rs = view.rs[Rg.id];
      if (!rs || !rs.up || !rs.up.radar) continue;
      const C = Rg.compound;
      const wx = (C.coreX - 2.5) * TILE, wy = (C.coreY - 0.1) * TILE;
      if (wx < ox - 80 || wx > ox + R.vw + 80 || wy < oy - 60 || wy > oy + R.vh + 120) continue;
      const H = 64, seg = 8;
      const col = ownerColor(rs.owner);
      for (let z = 0; z < H; z += seg) {
        const w0 = 6 * (1 - z / H) + 1.5, w1 = 6 * (1 - (z + seg) / H) + 1.5;
        const [ax, ay] = P3(wx, wy, z), [bx, by] = P3(wx, wy, z + seg);
        ctx.fillStyle = '#3a3646';
        line(ax - w0, ay, bx - w1, by); line(ax + w0, ay, bx + w1, by);
        ctx.fillStyle = '#5a566a'; line(ax - w0, ay, bx + w1, by); line(ax + w0, ay, bx - w1, by);
      }
      const [tx, ty] = P3(wx, wy, H);
      const sw = Math.round(Math.abs(Math.cos(R.time * 1.6)) * 7) + 1;
      ctx.fillStyle = '#c8c8d0'; ctx.fillRect(Math.round(tx - sw), Math.round(ty - 4), sw * 2, 4); ctx.fillStyle = '#8a8a96'; ctx.fillRect(Math.round(tx - sw), Math.round(ty - 1), sw * 2, 1);
      ctx.fillStyle = Math.floor(R.time * 2) % 2 ? '#ff3b5c' : '#4a1a22'; ctx.fillRect(Math.round(tx) - 1, Math.round(ty) - 7, 2, 2);
      ctx.fillStyle = col; ctx.fillRect(Math.round(tx) - 2, Math.round(ty) + 1, 4, 1);
    }
    // police helicopters: way up, rotors spinning, searchlight on the street
    for (const h of view.helis || []) {
      if (h.x < ox - 160 || h.x > ox + R.vw + 160 || h.y < oy - 160 || h.y > oy + R.vh + 200) continue;
      const [X, Y] = P3(h.x, h.y, 90);
      const a = h.aim || 0, ca = Math.cos(a), sa = Math.sin(a);
      // searchlight beam
      const [gx, gy] = [h.x + ca * 46 - ox, h.y + sa * 46 - oy];
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.12 + 0.08 * night;
      ctx.fillStyle = '#f4f8ff';
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(gx - 16, gy - 8); ctx.lineTo(gx + 16, gy + 8); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.25 + 0.2 * night; pixCircleFill(gx, gy, 20, 0.6);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.translate(Math.round(X), Math.round(Y));
      ctx.rotate(a);
      ctx.scale(1.7, 1.7);
      ctx.fillStyle = '#141c3a'; ctx.fillRect(-22, -1, 14, 2); ctx.fillRect(-24, -4, 3, 8);
      ctx.fillStyle = '#1a2448'; ctx.fillRect(-9, -6, 20, 12); ctx.fillRect(-11, -4, 2, 8); ctx.fillRect(11, -4, 3, 8);
      ctx.fillStyle = '#f2f2f2'; ctx.fillRect(-7, -6, 14, 2);
      ctx.fillStyle = '#5ab0e8'; ctx.fillRect(7, -4, 5, 8); ctx.fillStyle = '#c8f0ff'; ctx.fillRect(9, -3, 2, 2);
      if (h.kind === 'rocket') { ctx.fillStyle = '#3a3d48'; ctx.fillRect(-2, -9, 8, 3); ctx.fillRect(-2, 6, 8, 3); ctx.fillStyle = '#ff3b5c'; ctx.fillRect(6, -9, 1, 3); ctx.fillRect(6, 6, 1, 3); }
      else { ctx.fillStyle = '#56606e'; ctx.fillRect(10, 5, 7, 2); }
      ctx.fillStyle = Math.floor(R.time * 8) % 2 ? '#ff3b3b' : '#3a5aff'; ctx.fillRect(-3, -1, 3, 2);
      ctx.restore();
      // main rotor blur + blades
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#c8c8d0'; pixCircle(X, Y, 30, '#c8c8d0', 1);
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#2a2a36';
      const ra = R.time * 38;
      for (let k = 0; k < 2; k++) { const b = ra + k * Math.PI / 2; line(X - Math.cos(b) * 31, Y - Math.sin(b) * 31, X + Math.cos(b) * 31, Y + Math.sin(b) * 31); line(X - Math.cos(b) * 31, Y - Math.sin(b) * 31 + 1, X + Math.cos(b) * 31, Y + Math.sin(b) * 31 + 1); }
      ctx.globalAlpha = 1;
    }
    if (view.ufo) drawUfo(view.ufo, ox, oy, night);
  }
  // where the saucer is: flying in during the warning, low over the drop point, then away
  function ufoPos(u) {
    let dx = 0, dy = 0, z = 110;
    if (u.state === 'warn') { const k = Math.max(0, Math.min(1, u.t / ALIENS.warn)); dx = -340 * k; dy = -180 * k; z = 110 + 260 * k; }
    else if (u.state === 'leave') { const k = 1 - Math.max(0, Math.min(1, u.t / 3)); dx = 460 * k * k; dy = -220 * k * k; z = 110 + 320 * k; }
    else z = 110 + Math.sin(R.time * 1.6) * 4;
    return { x: u.x + dx, y: u.y + dy, z };
  }
  function drawUfo(u, ox, oy, night) {
    const q = ufoPos(u);
    const [X, Y0] = P3(q.x, q.y, q.z);
    const Y = Y0 - q.z * 0.6;          // way up in the sky: the beam reaches down to the street
    if (X < -200 || X > R.vw + 200 || Y < -200 || Y > R.vh + 200) return;
    const sc = 1 + (q.z - 110) / 500;
    // tractor beam down to the street
    if (u.state === 'beam' || (u.state === 'hover' && Math.sin(R.time * 0.9) > 0.55)) {
      const gx = q.x - ox, gy = q.y - oy;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (u.state === 'beam' ? 0.26 : 0.12) + 0.08 * night;
      ctx.fillStyle = '#7dff4a';
      ctx.beginPath(); ctx.moveTo(X - 16, Y + 8); ctx.lineTo(X + 16, Y + 8); ctx.lineTo(gx + 36, gy); ctx.lineTo(gx - 36, gy); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.45;
      for (let i = 0; i < 4; i++) { const f = (R.time * 0.9 + i / 4) % 1; pixCircle(X + (gx - X) * f, Y + 8 + (gy - Y - 8) * f, 16 + 20 * f, '#b8ffd0', 0.3); }
      ctx.globalAlpha = 0.3; ctx.fillStyle = '#7dff4a'; pixCircleFill(gx, gy, 36, 0.45);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    const W = Math.round(50 * sc), H = Math.max(6, Math.round(11 * sc));
    // glow under the hull
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 + 0.15 * Math.sin(R.time * 5); ctx.fillStyle = '#7dff4a'; pixCircleFill(X, Y + H * 0.5, W * 0.55, 0.3); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // the hull: a fat metal disc
    for (let dy = -H; dy <= H; dy++) {
      const w = Math.round(W * Math.sqrt(Math.max(0, 1 - (dy / H) ** 2)));
      ctx.fillStyle = dy < -H * 0.45 ? '#d4dce8' : dy < 0 ? '#a8b2c2' : dy < H * 0.35 ? '#5a6274' : '#3a4050';
      ctx.fillRect(Math.round(X - w), Math.round(Y + dy), w * 2, 1);
    }
    ctx.fillStyle = '#2a2e3a'; ctx.fillRect(Math.round(X - W), Math.round(Y), W * 2, 1);
    // dome with a little grey pilot inside
    const dw = Math.round(W * 0.38), dh = Math.round(12 * sc), dy0 = Math.round(Y - H * 0.55);
    for (let k = 0; k < dh; k++) {
      const w = Math.round(dw * Math.sqrt(1 - (k / dh) ** 2));
      ctx.fillStyle = k > dh * 0.6 ? '#b8f8ff' : '#6ad8f0';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(Math.round(X - w), dy0 - k, w * 2, 1);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#a8b4bc'; ctx.fillRect(Math.round(X - 3 * sc), dy0 - Math.round(8 * sc), Math.round(6 * sc), Math.round(5 * sc));
    ctx.fillStyle = '#08060c'; ctx.fillRect(Math.round(X - 2 * sc), dy0 - Math.round(6 * sc), Math.max(1, Math.round(1.5 * sc)), 1); ctx.fillRect(Math.round(X + 1 * sc), dy0 - Math.round(6 * sc), Math.max(1, Math.round(1.5 * sc)), 1);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(X - dw * 0.5), dy0 - Math.round(dh * 0.7), 2, 1);
    // running lights around the rim
    const LC = ['#7dff4a', '#ff3fa4', '#22e5ff', '#ffd23f'];
    for (let i = 0; i < 12; i++) {
      const a = R.time * 2.2 + i * Math.PI / 6;
      if (Math.sin(a) < -0.15) continue;
      const lx = X + Math.cos(a) * W * 0.86, ly = Y + Math.sin(a) * H * 0.35;
      ctx.fillStyle = LC[(i + Math.floor(R.time * 6)) % 4];
      ctx.fillRect(Math.round(lx) - 1, Math.round(ly) - 1, 2, 2);
    }
  }
  function line(x0, y0, x1, y1) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1);
  }

  // ---------------------------------------------------------------- downed players: crawling and bleeding
  function drawDowned(p, key, spec, dt) {
    const a = stepAnim(key, p.x, p.y, dt);
    const s = charSprite(spec, 0, a.moving ? 1 + (Math.floor(a.dist / 3) % 4) : 0);
    const left = Math.cos(p.aim || 0) < 0;
    shadow(p.x, p.y, 9, 0.5);
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y - 3 + (a.moving ? Math.sin(R.time * 14) * 0.6 : 0)));
    ctx.rotate(left ? -Math.PI / 2 : Math.PI / 2);
    ctx.globalAlpha = p.inv ? 0.6 : 1;
    ctx.drawImage(s, -s.ax, -Math.round(s.ay / 2));
    ctx.restore();
    ctx.globalAlpha = 1;
    p._top = 12;
    // a blood trail where they crawl, and a slow drip while still
    if (R.bloodOn) {
      if (a.moving && Math.random() < dt * 14) addStain(p.x + (Math.random() - 0.5) * 6, p.y + (Math.random() - 0.5) * 3, 2, ['#7a0610', '#9a0c18', '#5a040c'][(Math.random() * 3) | 0], false, Math.random() < 0.3 ? 2 : 0);
      else if (Math.random() < dt * 3) addStain(p.x + (Math.random() - 0.5) * 8, p.y + (Math.random() - 0.5) * 3, 1, '#7a0610', false);
    }
    // revive progress ring + bleed-out timer
    const T = Math.max(0, p.downT || 0) / DOWN.time;
    ctx.globalAlpha = 0.6 + Math.sin(R.time * 6) * 0.3;
    pixCircle(p.x, p.y, 12, '#ff3b5c', 0.55);
    ctx.globalAlpha = 1;
    if (p.revP > 0) {
      const n = 40, m = Math.floor(n * Math.min(1, p.revP));
      ctx.fillStyle = '#3ddc84';
      for (let i = 0; i <= m; i++) { const an = -Math.PI / 2 + (i / n) * Math.PI * 2; ctx.fillRect(Math.round(p.x + Math.cos(an) * 14), Math.round(p.y + Math.sin(an) * 14 * 0.55), 2, 2); }
      if (Math.random() < 0.3) R.particles.push({ x: p.x + (Math.random() - 0.5) * 12, y: p.y - 4, vx: 0, vy: -20, life: 0.6, t: 0, c: '#3ddc84', g: 0, sz: 1, em: true });
    }
    p._bleed = T;
  }

  // ---------------------------------------------------------------- gang members hanging out in their turf
  function drawHangout(h, owner, dt) {
    const gc = GANG_COLORS[Number(owner.slice(1))] || '#ff3f8e';
    const spec = specFor('H' + h.seed + gc, () => Object.assign(civilianSpec(h.seed, gc), { band: gc }));
    if (h.kind === 'dance') { drawDancer('h' + h.seed, h.x, h.y, spec, h.seed % 3, dt, h.seed % 7); return; }
    if (h.kind === 'sit') { const s = charSprite(spec, 0, 0); shadow(h.x, h.y + 2, 4); ctx.drawImage(s, Math.round(h.x - s.ax), Math.round(h.y - s.ay + 3)); return; }
    // lean / guard: stands around, looks around now and then
    const look = Math.floor(R.time * 0.4 + h.seed) % 4;
    const aim = [Math.PI / 2, 0, Math.PI, Math.PI / 2][look];
    drawCharacter('h' + h.seed, h.x, h.y, aim, spec, h.kind === 'guard' ? [{ slot: 'R', kind: 'smg', color: '#3a3646' }] : null, dt, { moving: false });
    if (h.kind === 'lean' && Math.random() < 0.01) R.smoke(h.x + 4, h.y - 16, '#c8c0d0', 1, -10, 1.2);
  }

  // the padre in front of each church: white robe, a golden stole, a cross; turns to bless whoever comes close
  function drawPriest(ch, view, dt) {
    const spec = specFor('PR' + ch.id, () => Object.assign(civilianSpec(ch.id * 131 + 7), { top: '#f6f4ee', top2: '#e2ded2', pants: '#f0ece2', hat: null, cap: null, band: '#ffd23f', mask: null, visor: null }));
    const me = view.me;
    const close = me && Math.abs(me.x - ch.px) < 3 * TILE && Math.abs(me.y - ch.py) < 3 * TILE;
    const aim = close ? Math.atan2(me.y - ch.py, me.x - ch.px) : [Math.PI / 2, 0, Math.PI, Math.PI / 2][Math.floor(R.time * 0.3 + ch.id) % 4];
    const s = drawCharacter('pr' + ch.id, ch.px, ch.py, aim, spec, null, dt, { moving: false });
    ch._top = s.top;
    const cy = Math.round(ch.py - s.top * 0.55), cx = Math.round(ch.px);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(cx, cy - 2, 1, 5); ctx.fillRect(cx - 1, cy - 1, 3, 1);
    if (Math.random() < 0.03) R.particles.push({ x: ch.px + (Math.random() - 0.5) * 8, y: ch.py - s.top, vx: 0, vy: -10, life: 0.9, t: 0, c: '#ffd88a', g: 0, sz: 1, em: true });
  }

  // ---------------------------------------------------------------- dancing (emote and the bar crowd)
  // style 0: passinho (fast footwork), 1: crip walk (side to side), 2: rebolado (shake it)
  function drawDancer(key, x, y, spec, style, dt, phase = 0) {
    stepAnim(key, x, y, dt);
    const t = R.time + phase;
    let dir = 0, frame = 0, dx = 0, dy = 0, sxs = 1;
    if (style === 0) { frame = 1 + (Math.floor(t * 12) % 4); dir = Math.floor(t * 2) % 2 ? 0 : (Math.floor(t * 4) % 2 ? 1 : 2); dy = -Math.abs(Math.sin(t * 10)) * 2; dx = Math.sin(t * 6) * 1.5; }
    else if (style === 1) { dir = Math.floor(t * 3) % 2 ? 1 : 2; frame = Math.floor(t * 6) % 2 ? 1 : 3; dx = Math.sin(t * 3 * Math.PI) * 3; dy = -Math.abs(Math.sin(t * 6)); }
    else if (style === 2) { dir = 3; dx = Math.sin(t * 22) * 1.2; sxs = 1 + Math.sin(t * 22) * 0.12; dy = Math.sin(t * 11) * 0.8 + 1; }
    else if (style === 3) {
      // "6 7!": facing you, palms up, hands pumping up and down in turns
      const s = charSprite(spec, 0, 0);
      const bob = -Math.abs(Math.sin(t * 9)) * 1.2;
      shadow(x, y, Math.max(4, Math.round(s.width * 0.3)));
      ctx.drawImage(s, Math.round(x - s.ax), Math.round(y - s.ay + bob));
      const ph = Math.sin(t * 10), sy = y - s.top * 0.52 + bob, skin = spec.skin || '#c88a5a';
      for (const [hx, o] of [[x - 6, ph], [x + 5, -ph]]) {
        const hy = Math.round(sy - 2 + o * 3);
        ctx.fillStyle = shade(spec.top || '#888', -0.1); ctx.fillRect(Math.round(hx + (hx < x ? 1 : -1)), Math.round(Math.min(hy, sy)), 1, Math.abs(Math.round(sy - hy)) + 1);
        ctx.fillStyle = skin; ctx.fillRect(Math.round(hx), hy - 1, 2, 2);
      }
      if (Math.random() < 0.04) R.particles.push({ x: x + (Math.random() - 0.5) * 10, y: y - s.top, vx: (Math.random() - 0.5) * 10, vy: -22, life: 0.8, t: 0, c: '#ffd23f', g: 0, sz: 2, em: true });
      return s;
    } else {
      // praying: kneeling, back to the camera (facing the church), a soft golden glow rising
      const s = charSprite(spec, 3, 0);
      shadow(x, y, Math.max(4, Math.round(s.width * 0.3)));
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y + 1));
      ctx.scale(1, 0.78);
      ctx.drawImage(s, -s.ax, -s.ay);
      ctx.restore();
      if (Math.random() < 0.06) R.particles.push({ x: x + (Math.random() - 0.5) * 8, y: y - s.top * 0.8, vx: 0, vy: -16, life: 1.1, t: 0, c: Math.random() < 0.5 ? '#ffd88a' : '#ffffff', g: 0, sz: 1, em: true });
      return s;
    }
    const s = charSprite(spec, dir, frame);
    shadow(x, y, Math.max(4, Math.round(s.width * 0.3)));
    ctx.save();
    ctx.translate(Math.round(x + dx), Math.round(y + dy));
    ctx.scale(sxs, 1);
    ctx.drawImage(s, -s.ax, -s.ay);
    ctx.restore();
    if (Math.random() < 0.05) R.particles.push({ x: x + (Math.random() - 0.5) * 10, y: y - s.top, vx: (Math.random() - 0.5) * 10, vy: -22, life: 0.8, t: 0, c: Math.random() < 0.5 ? '#ff3fa4' : '#22e5ff', g: 0, sz: 2, em: true });
    return s;
  }

  // ---------------------------------------------------------------- bar interiors
  const barCache = new Map();
  function barRoom(bar) {
    let c = barCache.get(bar.id);
    if (c) return c;
    const W = BAR_ROOM.w, H = BAR_ROOM.h;
    c = mk(W, H);
    const g = c.getContext('2d');
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
    let sd = bar.seed || 1;
    const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    // floor: dark wooden planks
    P(0, 0, W, H, '#241820');
    for (let y = 0; y < H; y += 8) for (let x = ((y / 8) % 2) * 12; x < W; x += 24) { P(x, y, 23, 7, rnd() < 0.5 ? '#2c1d27' : '#2a1b25'); P(x, y, 23, 1, '#33222e'); }
    // walls
    P(0, 0, W, 16, '#1a1022'); for (let x = 0; x < W; x += 8) P(x + ((x / 8) % 2) * 4, 3, 7, 4, '#24142e');
    P(0, 0, 16, H, '#160c1e'); P(W - 16, 0, 16, H, '#160c1e');
    P(0, H - 16, 256, 16, '#160c1e'); P(288, H - 16, 256, 16, '#160c1e');
    P(256, H - 16, 32, 16, '#3a2a32'); for (let x = 258; x < 288; x += 4) P(x, H - 14, 2, 12, '#4a3a42');
    // posters
    for (let i = 0; i < 4; i++) { const x = 70 + i * 34; if (x > 200 && x < 340) continue; P(x, 2, 14, 12, ['#ff3f8e', '#ffd23f', '#22e5ff', '#3ddc84'][i]); P(x + 2, 4, 10, 2, '#120a1c'); P(x + 2, 8, 6, 1, '#120a1c'); }
    // shelf with bottles behind the counter
    P(16, 56, 8, 192, '#3a2418');
    for (let y = 60; y < 244; y += 6) for (let i = 0; i < 2; i++) P(17 + i * 3, y, 2, 4, ['#3ddc84', '#ff8a3d', '#ffd23f', '#9af0ff', '#ff3fa4', '#c8a060'][(rnd() * 6) | 0]);
    // the counter
    const K = BAR_ROOM.counter;
    P(K.x, K.y, K.w, K.h, '#5a3424'); P(K.x, K.y, K.w, 3, '#8a5a3a'); P(K.x + K.w - 6, K.y, 6, K.h, '#3a2016');
    for (let y = K.y + 10; y < K.y + K.h - 6; y += 22) { P(K.x + 6, y, 4, 6, '#c8e8f0'); P(K.x + 16, y + 8, 3, 5, '#ffb84a'); }
    for (let y = K.y + 14; y < K.y + K.h; y += 26) { P(K.x + K.w + 8, y, 10, 10, '#2a1a22'); P(K.x + K.w + 9, y + 1, 8, 4, '#a01e2a'); }
    // DJ booth with speakers (paredão)
    const D = BAR_ROOM.dj;
    for (const sx of [D.x - 30, D.x + D.w + 4]) { P(sx, 14, 26, 40, '#120a1c'); for (const [cx, cy] of [[sx + 13, 24], [sx + 13, 42]]) { P(cx - 8, cy - 7, 16, 14, '#241634'); P(cx - 5, cy - 4, 10, 8, '#3a2a50'); P(cx - 2, cy - 1, 4, 3, '#0a0610'); } }
    P(D.x, D.y, D.w, D.h, '#1a1426'); P(D.x, D.y, D.w, 2, '#3a3046');
    for (const tx of [D.x + 16, D.x + D.w - 34]) { P(tx, D.y + 6, 18, 18, '#0e0a14'); P(tx + 3, D.y + 9, 12, 12, '#2a2a36'); P(tx + 8, D.y + 14, 2, 2, '#c8c8d0'); }
    P(D.x + 42, D.y + 8, 20, 14, '#2a2636');
    // tables, sofa
    for (const T of BAR_ROOM.solids.slice(7, 9)) { P(T.x, T.y, T.w, T.h, '#3a2418'); P(T.x, T.y, T.w, 2, '#5a3a28'); P(T.x + 6, T.y + 6, 4, 6, '#c8e8f0'); P(T.x + T.w - 12, T.y + 8, 4, 6, '#ffb84a'); for (const cx of [T.x - 8, T.x + T.w + 2]) P(cx, T.y + 6, 6, 12, '#2a1a22'); }
    const S = BAR_ROOM.solids[9];
    P(S.x, S.y, S.w, S.h, '#7a1424'); P(S.x, S.y, S.w, 8, '#a01e2a'); P(S.x + 4, S.y + 12, S.w - 8, S.h - 16, '#5a0e1a');
    // dealer corner: a dirty rug and a low table
    P(470, 24, 54, 54, '#1a1a14'); for (let i = 0; i < 6; i++) P(474 + i * 8, 28, 4, 46, '#22221a');
    P(492, 62, 20, 10, '#2a2420'); P(496, 64, 4, 3, '#ff3fa4'); P(504, 65, 3, 3, '#9af0ff');
    // dancefloor frame
    const F = BAR_ROOM.floor;
    P(F.x - 2, F.y - 2, F.w + 4, F.h + 4, '#0a0610');
    barCache.set(bar.id, c);
    return c;
  }

  function barNPCs(bar) {
    if (bar._npcs) return bar._npcs;
    let sd = (bar.seed || 7) + 13;
    const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const F = BAR_ROOM.floor, npcs = [];
    for (let i = 0; i < 9; i++) npcs.push({ kind: 'dance', x: F.x + 14 + rnd() * (F.w - 28), y: F.y + 18 + rnd() * (F.h - 24), seed: (rnd() * 1e5) | 0, style: (rnd() * 3) | 0, ph: rnd() * 10 });
    for (let i = 0; i < 4; i++) npcs.push({ kind: 'sit', x: BAR_ROOM.counter.x + BAR_ROOM.counter.w + 13, y: BAR_ROOM.counter.y + 26 + i * 52, seed: (rnd() * 1e5) | 0, dir: 1 });
    for (const T of BAR_ROOM.solids.slice(7, 9)) npcs.push({ kind: 'sit', x: T.x - 5, y: T.y + 18, seed: (rnd() * 1e5) | 0, dir: 2 }, { kind: 'sit', x: T.x + T.w + 5, y: T.y + 18, seed: (rnd() * 1e5) | 0, dir: 1 });
    npcs.push({ kind: 'sit', x: 486, y: 262, seed: (rnd() * 1e5) | 0, dir: 0 }, { kind: 'sit', x: 504, y: 262, seed: (rnd() * 1e5) | 0, dir: 0 });
    bar._npcs = npcs;
    return npcs;
  }

  // the cell block: six cells, tables, the guard desk, a small yard. Orange jumpsuits for everyone.
  let jailBg = null;
  function jailRoom() {
    if (jailBg) return jailBg;
    const J = JAIL_ROOM, W = J.w, H = J.h;
    const c = mk(W, H), g = c.getContext('2d');
    const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
    let sd = 991; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    // floor: worn grey concrete with a painted yellow line
    P(0, 0, W, H, '#4a4c54');
    for (let y = 0; y < H; y += 16) for (let x = 0; x < W; x += 16) { P(x, y, 15, 15, rnd() < 0.5 ? '#4e5058' : '#484a52'); if (rnd() < 0.1) P(x + rnd() * 12, y + rnd() * 12, 3, 2, '#3e4048'); }
    for (let x = 20; x < W - 20; x += 8) P(x, 108, 5, 2, '#c8a83a');
    // the yard: green court, white lines, a hoop
    const Y = J.yard;
    P(Y.x, Y.y, Y.w, Y.h, '#3a6a4a'); P(Y.x, Y.y, Y.w, 1, '#e8e8e0'); P(Y.x, Y.y, 1, Y.h, '#e8e8e0');
    for (let a = 0; a < 40; a++) { const an = a / 40 * Math.PI; P(Y.x + Y.w / 2 + Math.cos(an) * 30, Y.y + Math.sin(an) * 30, 1, 1, '#e8e8e0'); }
    P(Y.x + Y.w / 2 - 6, Y.y + 2, 12, 2, '#e8e8e0'); P(Y.x + Y.w / 2 - 3, Y.y + 4, 6, 3, '#ff8a3d');
    // walls: concrete with stains
    P(0, 0, W, 16, '#6a6c74'); for (let x = 0; x < W; x += 24) P(x, 0, 1, 16, '#5a5c64');
    P(0, 0, 16, H, '#5e6068'); P(W - 16, 0, 16, H, '#5e6068'); P(0, H - 16, W, 16, '#5e6068');
    for (let i = 0; i < 14; i++) P(16 + rnd() * (W - 40), 2 + rnd() * 10, 1, 4 + rnd() * 6, 'rgba(0,0,0,0.25)');
    // the gate (bars) at the bottom
    const G2 = J.gate; P(G2.x, G2.y, G2.w, 16, '#2a2c34'); for (let x = G2.x + 2; x < G2.x + G2.w; x += 4) P(x, G2.y, 2, 16, '#9aa0aa');
    // cells: back wall, bunk, toilet, bars with the open door
    for (const C of J.cells) {
      P(C.x, C.y, C.w, C.h, '#55575f');
      P(C.x + 4, C.y + 6, 26, 12, '#7a5a3a'); P(C.x + 5, C.y + 7, 24, 9, '#c8c0b0'); P(C.x + 5, C.y + 7, 6, 4, '#f0ece2');   // bunk + pillow
      P(C.x + C.w - 14, C.y + 8, 9, 9, '#e8e8f0'); P(C.x + C.w - 12, C.y + 10, 5, 5, '#a8b0c0');                               // toilet
      if (rnd() < 0.6) { P(C.x + 36, C.y + 4, 8, 10, ['#ff3f8e', '#ffd23f', '#22e5ff'][(rnd() * 3) | 0]); P(C.x + 37, C.y + 6, 6, 1, '#202028'); }   // poster
      for (let k = 0; k < 6; k++) P(C.x + 3 + rnd() * (C.w - 8), C.y + 22 + rnd() * 50, 1, 2, '#3a3c44');                       // tally marks
    }
    for (const b of J.solids) if (b.h === 84) P(b.x, b.y, b.w, b.h, '#6a6c74');
    for (const b of J.solids) if (b.h === 4) { P(b.x, b.y, b.w, b.h, '#2a2c34'); for (let x = b.x; x < b.x + b.w; x += 3) P(x, b.y - 30, 1, 34, '#a0a6b0'); }
    // tables, the guard desk, the weights bench
    for (const T of J.tables) { P(T.x, T.y, T.w, T.h, '#8a8c94'); P(T.x, T.y, T.w, 2, '#a8aab2'); P(T.x - 2, T.y - 6, T.w + 4, 3, '#6a6c74'); P(T.x - 2, T.y + T.h + 3, T.w + 4, 3, '#6a6c74'); P(T.x + 8, T.y + 5, 6, 4, '#f0ece2'); P(T.x + 24, T.y + 6, 5, 3, '#ff3b3b'); }
    const D = J.desk; P(D.x, D.y, D.w, D.h, '#3a3e5a'); P(D.x, D.y, D.w, 2, '#5a5e7a'); P(D.x + 8, D.y + 4, 14, 9, '#1a1e2a'); P(D.x + 9, D.y + 5, 12, 6, '#3a8aff');
    const Bn = J.bench; P(Bn.x, Bn.y, Bn.w, Bn.h, '#2a2a32'); P(Bn.x - 4, Bn.y - 6, Bn.w + 8, 2, '#c8c8d0'); P(Bn.x - 7, Bn.y - 9, 4, 8, '#2a2a32'); P(Bn.x + Bn.w + 3, Bn.y - 9, 4, 8, '#2a2a32');
    jailBg = c;
    return c;
  }
  const jailNPCs = (() => {
    const out = [];
    const J = JAIL_ROOM;
    let sd = 4242; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (const C of J.cells) if (rnd() < 0.55) out.push({ kind: 'sit', x: C.x + 18, y: C.y + 22, seed: (rnd() * 1e5) | 0, dir: 0 });
    out.push({ kind: 'cards', x: J.tables[0].x - 6, y: J.tables[0].y + 10, seed: 11, dir: 2 }, { kind: 'cards', x: J.tables[0].x + J.tables[0].w + 6, y: J.tables[0].y + 10, seed: 12, dir: 1 });
    out.push({ kind: 'push', x: J.yard.x + 30, y: J.yard.y + 70, seed: 13 }, { kind: 'walk', x: 200, y: 260, seed: 14, x0: 120, x1: 300 }, { kind: 'walk', x: 400, y: 140, seed: 15, x0: 330, x1: 500 });
    out.push({ kind: 'ball', x: J.yard.x + J.yard.w / 2, y: J.yard.y + 40, seed: 16 });
    out.push({ kind: 'guard', x: J.desk.x + 30, y: J.desk.y - 6, seed: 17 }, { kind: 'guard', x: J.gate.x - 14, y: J.gate.y - 6, seed: 18 }, { kind: 'guard', x: J.gate.x + J.gate.w + 14, y: J.gate.y - 6, seed: 19 });
    return out;
  })();
  const jumpsuit = (spec) => Object.assign({}, spec, { top: '#ff7a1a', top2: '#e8600a', pants: '#ff7a1a', armor: 0, visor: null, mask: null, chromeLegs: false, kneeGlow: false, chains: false });
  function drawJail(view, dt) {
    const I = view.interior, J = JAIL_ROOM;
    const W = J.w, H = J.h;
    const me = I.me;
    let offX = Math.round((R.vw - W) / 2), offY = Math.round(Math.min((R.vh - H) / 2, 4));
    if (R.vw < W) offX = Math.round(Math.max(R.vw - W, Math.min(0, R.vw / 2 - me.x)));
    if (R.vh < H) offY = Math.round(Math.max(R.vh - H, Math.min(0, R.vh / 2 - me.y)));
    const t = R.time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = '#05030a'; ctx.fillRect(0, 0, R.vw, R.vh);
    ctx.translate(offX, offY);
    ctx.drawImage(jailRoom(), 0, 0);
    const list = [];
    for (const n of jailNPCs) list.push({ y: n.y, n });
    for (const p of I.players) list.push({ y: p.y, p });
    list.sort((a, b) => a.y - b.y);
    for (const d of list) {
      if (d.n) {
        const n = d.n;
        if (n.kind === 'guard') {
          const spec = specFor('JG' + n.seed, () => Object.assign(civilianSpec(n.seed), { top: '#22306a', top2: '#1a2450', pants: '#1a1e2a', cap: '#22306a' }));
          const look = Math.floor(t * 0.4 + n.seed) % 4;
          drawCharacter('jg' + n.seed, n.x, n.y, [Math.PI / 2, 0, Math.PI, -Math.PI / 2][look], spec, [{ slot: 'R', kind: 'pistol', color: '#3a3646' }], dt, { moving: false });
          continue;
        }
        const spec = specFor('JI' + n.seed, () => jumpsuit(civilianSpec(n.seed * 7 + 3)));
        if (n.kind === 'walk') {
          const span = n.x1 - n.x0, ph = (t * 18 + n.seed * 7) % (span * 2), x = n.x0 + (ph < span ? ph : span * 2 - ph);
          drawCharacter('jw' + n.seed, x, n.y, ph < span ? 0 : Math.PI, spec, null, dt, { moving: true });
        } else if (n.kind === 'push') {
          const s = charSprite(spec, 1, 0), up = Math.sin(t * 4) > 0;
          ctx.save(); ctx.translate(Math.round(n.x), Math.round(n.y)); ctx.rotate(Math.PI / 2 * (up ? 0.82 : 0.95)); ctx.drawImage(s, -s.ax, -s.ay); ctx.restore();
        } else if (n.kind === 'ball') {
          const bx = n.x + Math.sin(t * 1.3) * 30, by = n.y + 10;
          drawCharacter('jb' + n.seed, bx, by, -Math.PI / 2, spec, null, dt, { moving: Math.abs(Math.cos(t * 1.3)) > 0.3 });
          const bb = Math.abs(Math.sin(t * 7)) * 8;
          ctx.fillStyle = '#ff8a3d'; ctx.fillRect(Math.round(bx + 5), Math.round(by - 4 - bb), 3, 3);
        } else { const s = charSprite(spec, n.dir || 0, 0); ctx.drawImage(s, Math.round(n.x - s.ax), Math.round(n.y - s.ay + 2)); }
      } else {
        const p = d.p;
        const spec = jumpsuit(playerSpecOf(p, view));
        if (p.emote) drawDancer('pj' + p.id, p.x, p.y, spec, p.emote - 1, dt);
        else drawCharacter('pj' + p.id, p.x, p.y, p.aim, spec, null, dt, { moving: p.moving });
      }
    }
    // lighting: cold fluorescent tubes, one flickering
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lights = [];
    for (let i = 0; i < 6; i++) lights.push({ x: 72 + i * 80, y: 60, r: 70, c: '#d8e8ff', i: i === 3 && Math.floor(t * 9) % 7 === 0 ? 0.2 : 0.9 });
    for (const [x, y] of [[140, 170], [300, 220], [425, 230], [60, 250], [272, 270]]) lights.push({ x, y, r: 110, c: '#c8d8f0', i: 0.8 });
    lights.push({ x: J.desk.x + 15, y: J.desk.y + 8, r: 40, c: '#3a8aff', i: 0.9 });
    for (const p of I.players) lights.push({ x: p.x, y: p.y - 6, r: 40, c: '#ffe6c8', i: 0.4 });
    applyLighting(lights, [0.36, 0.38, 0.46], -offX, -offY);
    ctx.translate(offX, offY);
    drawText(ctx, 'PRESIDIO CENTRAL', W / 2, 4, '#ffd23f');
    drawText(ctx, I.left > 0 ? `PORTAO ABRE EM ${I.left}s` : 'PORTAO ABRINDO', J.gate.x + J.gate.w / 2, H - 12, Math.floor(t * 2) % 2 ? '#ff3b5c' : '#ffd23f');
    drawParticles(dt, 'em');
    for (const p of I.players) drawText(ctx, p.name, p.x, p.y - 30, p.color || '#fff');
    drawTexts(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vg = ctx.createRadialGradient(R.vw / 2, R.vh / 2, R.vh * 0.35, R.vw / 2, R.vh / 2, R.vh * 0.95);
    vg.addColorStop(0, 'rgba(5,2,15,0)'); vg.addColorStop(1, 'rgba(5,2,15,0.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, R.vw, R.vh);
    R.interiorOff = { x: offX, y: offY };
  }

  function drawInterior(view, dt) {
    if (view.interior.jail) return drawJail(view, dt);
    const I = view.interior, bar = I.bar;
    const W = BAR_ROOM.w, H = BAR_ROOM.h;
    const me = I.me;
    let offX = Math.round((R.vw - W) / 2), offY = Math.round(Math.min((R.vh - H) / 2, 4));
    if (R.vw < W) offX = Math.round(Math.max(R.vw - W, Math.min(0, R.vw / 2 - me.x)));
    if (R.vh < H) offY = Math.round(Math.max(R.vh - H, Math.min(0, R.vh / 2 - me.y)));
    const t = R.time, beat = (t * 124 / 60) % 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = '#05030a'; ctx.fillRect(0, 0, R.vw, R.vh);
    ctx.translate(offX, offY);
    ctx.drawImage(barRoom(bar), 0, 0);
    const F0 = BAR_ROOM.floor, pal0 = ['#ff3fa4', '#22e5ff', '#a66bff', '#ffd23f', '#3ddc84'];
    const tileOn = (gx, gy) => ((gx * 7 + gy * 3 + Math.floor(t * 124 / 60)) % 4) === 0;
    for (let gy = 0; gy < F0.h / 16; gy++) for (let gx = 0; gx < F0.w / 16; gx++) {
      ctx.fillStyle = tileOn(gx, gy) ? pal0[(gx + gy + Math.floor(t * 2.07)) % pal0.length] : shade(pal0[(gx + gy + Math.floor(t * 2.07)) % pal0.length], -0.65);
      ctx.fillRect(F0.x + gx * 16 + 1, F0.y + gy * 16 + 1, 14, 14);
    }
    // sprites
    const list = [];
    for (const n of barNPCs(bar)) list.push({ y: n.y, n });
    list.push({ y: BAR_ROOM.counter.y + 40 + Math.sin(t * 0.5) * 60, bt: true });
    list.push({ y: BAR_ROOM.dj.y + 2, dj: true });
    if (bar.dealer) list.push({ y: BAR_ROOM.dealer.y, dealer: true });
    for (const p of I.players) list.push({ y: p.y, p });
    list.sort((a, b) => a.y - b.y);
    for (const d of list) {
      if (d.n) {
        const spec = specFor('C' + d.n.seed, () => civilianSpec(d.n.seed));
        if (d.n.kind === 'dance') drawDancer('bn' + bar.id + d.n.seed, d.n.x, d.n.y, spec, d.n.style, dt, d.n.ph);
        else { const s = charSprite(spec, d.n.dir, 0); ctx.drawImage(s, Math.round(d.n.x - s.ax), Math.round(d.n.y - s.ay + 2)); }
      } else if (d.bt) {
        const spec = specFor('BT' + bar.id, () => Object.assign(civilianSpec(bar.seed + 5), { top: '#f2f2f2', top2: '#2a2a36' }));
        const s = charSprite(spec, 2, 0);
        ctx.drawImage(s, Math.round(BAR_ROOM.counter.x + 8 - s.ax), Math.round(d.y - s.ay));
      } else if (d.dj) {
        const spec = specFor('DJ' + bar.id, () => Object.assign(civilianSpec(bar.seed + 9), { headphones: true, top: '#2b2b3a', visor: '#22e5ff' }));
        const s = charSprite(spec, 0, Math.floor(t * 4) % 2 ? 2 : 0);
        ctx.drawImage(s, Math.round(BAR_ROOM.dj.x + BAR_ROOM.dj.w / 2 - s.ax), Math.round(BAR_ROOM.dj.y + 10 - s.ay - (beat < 0.2 ? 1 : 0)));
      } else if (d.dealer) {
        const spec = specFor('DL' + bar.id, () => Object.assign(civilianSpec(bar.seed + 3), { mask: 'balaclava', top: '#1a1a22', pants: '#1a1a22' }));
        const s = charSprite(spec, 0, 0);
        ctx.drawImage(s, Math.round(BAR_ROOM.dealer.x - s.ax), Math.round(BAR_ROOM.dealer.y - s.ay));
      } else {
        const p = d.p;
        const spec = playerSpecOf(p, view);
        if (p.emote) drawDancer('p' + p.id, p.x, p.y, spec, p.emote - 1, dt);
        else drawCharacter('pi' + p.id, p.x, p.y, p.aim, spec, null, dt, { moving: p.moving });
      }
    }
    // lighting: dark room, moving spotlights, warm counter, DJ strobes
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const F = BAR_ROOM.floor;
    const pal = ['#ff3fa4', '#22e5ff', '#a66bff', '#ffd23f', '#3ddc84'];
    const lights = [];
    for (let i = 0; i < 4; i++) lights.push({ x: F.x + F.w / 2 + Math.sin(t * 0.9 + i * 1.7) * F.w * 0.45, y: F.y + F.h / 2 + Math.cos(t * 0.7 + i * 2.1) * F.h * 0.45, r: 120, c: pal[(i + Math.floor(t / 2)) % pal.length], i: 1, bloom: true });
    for (let y = BAR_ROOM.counter.y + 20; y < BAR_ROOM.counter.y + BAR_ROOM.counter.h; y += 50) lights.push({ x: BAR_ROOM.counter.x + 20, y, r: 90, c: '#ffc888', i: 0.9 });
    lights.push({ x: BAR_ROOM.dj.x + BAR_ROOM.dj.w / 2, y: BAR_ROOM.dj.y + 20, r: 140, c: beat < 0.15 ? '#ffffff' : pal[Math.floor(t * 2) % pal.length], i: beat < 0.15 ? 1.6 : 1, bloom: true });
    if (bar.dealer) lights.push({ x: BAR_ROOM.dealer.x, y: BAR_ROOM.dealer.y, r: 70, c: '#ff2a3a', i: 0.9, bloom: true });
    lights.push({ x: BAR_ROOM.door.x, y: BAR_ROOM.door.y - 10, r: 70, c: '#3ddc84', i: 0.8 });
    for (const p of I.players) lights.push({ x: p.x, y: p.y - 6, r: 40, c: '#ffe6c8', i: 0.4 });
    applyLighting(lights, [0.2, 0.14, 0.28], -offX, -offY);
    // emissive: dancefloor tiles, LED wall, neon tubes, signs
    ctx.translate(offX, offY);
    for (let gy = 0; gy < F.h / 16; gy++) for (let gx = 0; gx < F.w / 16; gx++) {
      const k = (gx + gy + Math.floor(t * 2.07)) % pal.length;
      const lit = tileOn(gx, gy);
      if (!lit) continue;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = pal[k];
      ctx.fillRect(F.x + gx * 16 + 1, F.y + gy * 16 + 1, 14, 14);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const D = BAR_ROOM.dj;
    for (let i = 0; i < 24; i++) { const h = 2 + Math.abs(Math.sin(t * 7 + i * 0.7) * Math.sin(t * 3.1 + i)) * 10 * (beat < 0.3 ? 1.3 : 1); ctx.fillStyle = pal[i % pal.length]; ctx.fillRect(D.x + 4 + i * 4, 14 - h, 3, h); }
    ctx.fillStyle = Math.floor(t * 2) % 2 ? '#ff3fa4' : '#22e5ff'; ctx.fillRect(16, 14, W - 32, 1);
    ctx.fillStyle = '#ff3fa4'; ctx.fillRect(BAR_ROOM.counter.x + BAR_ROOM.counter.w - 1, BAR_ROOM.counter.y, 1, BAR_ROOM.counter.h);
    for (let y = 60; y < 244; y += 12) { ctx.fillStyle = ['#3ddc84', '#ffd23f', '#9af0ff', '#ff3fa4'][(y / 12) % 4]; ctx.fillRect(18, y, 1, 3); }
    drawText(ctx, bar.name.toUpperCase(), 120, 4, Math.floor(t * 1.5) % 2 ? '#ffd23f' : '#ff3fa4');
    drawText(ctx, 'SAIDA', BAR_ROOM.door.x, H - 12, '#3ddc84');
    if (bar.dealer) { ctx.fillStyle = Math.floor(t * 3) % 2 ? '#ff2a3a' : '#7a1020'; ctx.fillRect(BAR_ROOM.dealer.x - 1, BAR_ROOM.dealer.y - 30, 3, 3); }
    drawParticles(dt, 'em');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawBloom(lights, -offX, -offY, 1);
    ctx.translate(offX, offY);
    // tags and prompts
    for (const p of I.players) drawText(ctx, p.name, p.x, p.y - 30, p.color || '#fff');
    if (I.prompt) drawText(ctx, I.prompt.text, I.prompt.x, I.prompt.y, Math.floor(t * 3) % 2 ? '#ffd23f' : '#ffffff');
    drawTexts(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vg = ctx.createRadialGradient(R.vw / 2, R.vh / 2, R.vh * 0.35, R.vw / 2, R.vh / 2, R.vh * 0.95);
    vg.addColorStop(0, 'rgba(5,2,15,0)'); vg.addColorStop(1, 'rgba(5,2,15,0.5)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, R.vw, R.vh);
    R.interiorOff = { x: offX, y: offY };
  }

  return R;
}

// ------------------------------------------------------------------ chunk rendering (ground only)
// gang yards: patched brick pavers, cracked cement and dirt, puddles, spray paint on the floor
function yardTile(P, px, py, tx, ty, h, seed) {
  const k = hash2(tx >> 1, ty >> 1, seed ^ 0x77a1);
  if (k < 0.6) {
    P(px, py, 16, 16, '#5a3a30');
    for (let y = 0; y < 16; y += 4) for (let x = (y / 4) % 2 ? -4 : 0; x < 16; x += 8) {
      const v = hash2(tx * 16 + x, ty * 16 + y, seed);
      P(px + Math.max(0, x), py + y, Math.min(7, 16 - Math.max(0, x)) - (x < 0 ? -x - 1 : 0), 3, v < 0.1 ? '#4a2a22' : v < 0.5 ? '#8a4a36' : v < 0.85 ? '#9a5640' : '#7a4030');
    }
  } else if (k < 0.8) {
    P(px, py, 16, 16, '#7a6c64');
    for (let i = 0; i < 10; i++) { const v = hash2(tx * 31 + i, ty * 17, seed); P(px + ((v * 16) | 0), py + ((v * 977 % 1) * 16 | 0), 1, 1, v < 0.5 ? '#6a5c54' : '#8a7c72'); }
    if (h < 0.3) { P(px + 3, py + 5, 6, 1, '#5a4c44'); P(px + 8, py + 6, 1, 4, '#5a4c44'); }
  } else if (k < 0.93) {
    P(px, py, 16, 16, '#6a5038');
    for (let i = 0; i < 9; i++) { const v = hash2(tx * 13 + i, ty * 29, seed ^ 5); P(px + ((v * 16) | 0), py + ((v * 613 % 1) * 16 | 0), 1, 1, v < 0.5 ? '#5a4230' : '#8a7058'); }
  } else {
    P(px, py, 16, 16, '#6e6466');
    if (h < 0.5) P(px + 4, py + 6, 7, 3, 'rgba(20,16,24,0.45)');
  }
  P(px, py + 15, 16, 1, 'rgba(0,0,0,0.12)');
  if (h > 0.992) { const c = ['#ff3f8e', '#22e5ff', '#ffd23f', '#f2f2f2'][(h * 1000 | 0) % 4]; P(px + 3, py + 4, 1, 7, c); P(px + 3, py + 4, 6, 1, c); P(px + 8, py + 4, 1, 4, c); P(px + 5, py + 8, 4, 1, c); P(px + 11, py + 6, 1, 6, c); }
  else if (h > 0.94) { P(px + 3, py + 7, 9, 4, '#2a3a5a'); P(px + 4, py + 8, 3, 1, '#5a7ab0'); }
}

// Returns { c: ground canvas, e: emissive ground canvas (or null) }
function renderChunk(world, cx, cy) {
  const WW = world.W, HH = world.H;
  const c = mk(CH_PX, CH_PX);
  const g = c.getContext('2d');
  const e = mk(CH_PX, CH_PX);
  const ge = e.getContext('2d');
  let hasE = false;
  const set = getTileset();
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  const tAt = (x, y) => (x < 0 || y < 0 || x >= WW || y >= HH ? T.WATER : world.tiles[y * WW + x]);
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const EM = (x, y, w, h, col) => { P(x, y, w, h, col); ge.fillStyle = col; ge.fillRect(x, y, w, h); hasE = true; };
  if (!world.cmask) {
    world.cmask = new Uint8Array(WW * HH);
    for (const Rg of world.regions) { const C = Rg.compound; for (let y = C.y; y < C.y + C.h; y++) for (let x = C.x; x < C.x + C.w; x++) world.cmask[y * WW + x] = 1; }
  }
  for (let ty = y0; ty < y0 + CHUNK && ty < HH; ty++) for (let tx = x0; tx < x0 + CHUNK && tx < WW; tx++) {
    const t = world.tiles[ty * WW + tx];
    const px = (tx - x0) * TILE, py = (ty - y0) * TILE;
    const vars = set[t] || set[T.CONCRETE];
    const h = hash2(tx, ty, world.seed);
    let v = (h * vars.length) | 0;
    if (t === T.ROAD) v = h < 0.8 ? 0 : (((h - 0.8) / 0.2) * vars.length) | 0;
    if (t === T.BUILD || t === T.WALL) { P(px, py, 16, 16, '#1a1622'); continue; }
    if (t === T.WALL) g.drawImage(set[T.CONCRETE][0], px, py);
    else if ((t === T.CONCRETE || t === T.PAD) && world.cmask[ty * WW + tx]) { yardTile(P, px, py, tx, ty, h, world.seed); if (t === T.PAD) g.drawImage(vars[0], px, py); }
    else g.drawImage(vars[Math.min(vars.length - 1, v)], px, py);
    // contact shadow at the foot of buildings
    if (t !== T.WATER) {
      if (tAt(tx, ty - 1) === T.BUILD) P(px, py, 16, 3, 'rgba(6,3,14,0.45)');
      if (tAt(tx - 1, ty) === T.BUILD) P(px, py, 3, 16, 'rgba(6,3,14,0.35)');
      if (tAt(tx + 1, ty) === T.BUILD) P(px + 13, py, 3, 16, 'rgba(6,3,14,0.35)');
      if (tAt(tx, ty + 1) === T.BUILD) P(px, py + 13, 16, 3, 'rgba(6,3,14,0.3)');
    }
    if (t === T.WATER) {
      const up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1), lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty);
      if (up !== T.WATER) { P(px, py, 16, 2, '#d8f4ff'); P(px, py + 2, 16, 1, '#5ab0d8'); }
      if (dn !== T.WATER) { P(px, py + 14, 16, 2, '#d8f4ff'); }
      if (lf !== T.WATER) { P(px, py, 2, 16, '#d8f4ff'); }
      if (rt !== T.WATER) { P(px + 14, py, 2, 16, '#d8f4ff'); }
    } else if (t === T.BRIDGE) {
      const lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty), up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1);
      const rail = (x, y, w, hh) => { P(x, y, w, hh, '#a9a3b6'); };
      if (lf === T.WATER) { rail(px, py, 2, 16); P(px + 2, py, 1, 16, '#3a3646'); }
      if (rt === T.WATER) { rail(px + 14, py, 2, 16); P(px + 13, py, 1, 16, '#3a3646'); }
      if (up === T.WATER) { rail(px, py, 16, 2); P(px, py + 2, 16, 1, '#3a3646'); }
      if (dn === T.WATER) { rail(px, py + 13, 16, 3); P(px, py + 16 - 1, 16, 1, '#5a5464'); }
      if ((lf === T.WATER || rt === T.WATER) && (tx + ty) % 3 === 0) EM(lf === T.WATER ? px : px + 14, py + 7, 2, 2, '#22e5ff');
    } else if (t === T.ROAD) {
      const up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1);
      if (up !== T.ROAD && up !== T.BUILD) P(px, py, 16, 1, '#141318');
      if (dn !== T.ROAD) P(px, py + 15, 16, 1, '#141318');
      if (up === T.ROAD && dn === T.ROAD && tAt(tx, ty - 2) !== T.ROAD && tAt(tx, ty + 2) !== T.ROAD && tx % 2 === 0) P(px + 4, py + 7, 8, 1, '#c8a83a');
      const lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty);
      if (lf === T.ROAD && rt === T.ROAD && tAt(tx - 2, ty) !== T.ROAD && tAt(tx + 2, ty) !== T.ROAD && ty % 2 === 0) P(px + 7, py + 4, 1, 8, '#c8a83a');
      if ((up === T.SIDEWALK || dn === T.SIDEWALK) && (lf !== T.ROAD || rt !== T.ROAD) && h < 0.5) for (let i = 0; i < 4; i++) P(px + 1 + i * 4, py + 3, 2, 10, '#c8c4d0');
      if (hash2(tx, ty, world.seed + 5) < 0.004) { P(px + 4, py + 4, 8, 8, '#141318'); for (let i = 0; i < 4; i++) P(px + 5 + i * 2, py + 5, 1, 6, '#3a3946'); }
      // wet asphalt puddles reflecting neon
      if (h > 0.97) { P(px + 3, py + 8, 9, 4, '#1a2a3e'); EM(px + 5, py + 9, 3, 1, ['#ff4fd8', '#22e5ff', '#ffd23f'][(h * 300 | 0) % 3]); }
    } else if (t === T.SIDEWALK || t === T.CALCADAO || t === T.STAIRS) {
      if (tAt(tx, ty + 1) === T.ROAD) { P(px, py + 14, 16, 2, '#3a3646'); P(px, py + 14, 16, 1, '#b8b4c4'); }
      if (tAt(tx, ty - 1) === T.ROAD) P(px, py, 16, 1, '#b8b4c4');
      if (t === T.SIDEWALK && h > 0.93) { P(px + 9, py + 6, 4, 4, '#2a2a36'); P(px + 10, py + 5, 2, 1, '#3a3a46'); }
      if (t === T.SIDEWALK && h > 0.88 && h < 0.9) { P(px + 3, py + 9, 6, 3, '#2a3a52'); P(px + 4, py + 9, 2, 1, '#ff4fd8'); }
    } else if (t === T.WALL) {
      const below = tAt(tx, ty + 1) === T.WALL;
      P(px, py, 16, below ? 16 : 10, '#a9a3b6');
      P(px, py, 16, 1, '#c8c2d4');
      P(px + 3, py + 3, 10, 1, '#8f899c');
      if (!below) {
        P(px, py + 10, 16, 6, '#6d6779');
        P(px, py + 10, 16, 1, '#4f4a5a');
        P(px + 7, py + 11, 1, 5, '#5a5566');
        if (h > 0.6) { P(px + 2, py + 12, 3, 2, ['#ff3f8e', '#22e5ff', '#ffd23f', '#141018'][(h * 40 | 0) % 4]); P(px + 6, py + 11, 1, 3, '#141018'); }
        if (h < 0.12) EM(px + 12, py + 11, 1, 1, '#ff3b5c');
      }
      for (let i = 0; i < 4; i++) P(px + 1 + i * 4, py - 1, 2, 1, '#56606e');
    } else if (t === T.PAD) {
      P(px + 6, py + 6, 4, 4, '#2a2636');
    }
  }
  for (const R of world.regions) {
    const C = R.compound;
    if (C.coreX < x0 - 4 || C.coreX > x0 + CHUNK + 4 || C.coreY < y0 - 4 || C.coreY > y0 + CHUNK + 4) continue;
    const ccx = (C.coreX - x0 + 0.5) * TILE, ccy = (C.coreY - y0 + 0.5) * TILE + 2;
    g.fillStyle = 'rgba(240,240,255,0.18)';
    for (let i = 0; i < 40; i++) {
      if (i % 2) continue;
      const a = (i / 40) * Math.PI * 2;
      g.fillRect(Math.round(ccx + Math.cos(a) * 2.6 * TILE), Math.round(ccy + Math.sin(a) * 2.6 * TILE * 0.75), 2, 1);
    }
    if (C.garage) {
      const gx = C.garage.x - x0 * TILE, gy = C.garage.y - y0 * TILE;
      for (let i = 0; i < 3; i++) { g.fillStyle = '#ffd23f'; g.fillRect(gx - 12 + i * 22, gy - 9, 18, 1); g.fillRect(gx - 12 + i * 22, gy + 9, 18, 1); }
    }
  }
  return { c, e: hasE ? e : null };
}
