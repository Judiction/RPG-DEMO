// Canvas renderer: tile chunks, y-sorted sprites, neon lighting, effects and name tags.
// The game is drawn at low resolution and scaled up with crisp pixels.

import { TILE, FACTIONS, WEAPONS } from './data.js';
import { W, H, T, CHUNK, STATION_COLORS } from './world.js';
import {
  getTileset, drawBuilding, charSprite, armSprite, propSprite, playerSpec, enemySpec, allySpec, ENEMY_ARM,
  flashOf, shade, rgba, mk,
} from './sprites.js';
import { drawText } from './font.js';
import { hash2 } from './rng.js';

const CH_PX = CHUNK * TILE;
const STATION_IDX = { arsenal: 0, clinic: 1, locker: 2, vault: 3 };
const STATION_LABEL = { arsenal: 'ARSENAL', clinic: 'CLINICA', locker: 'ARMARIO', vault: 'COFRE' };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const light = mk(4, 4);
  const lctx = light.getContext('2d');
  const R = {
    canvas, ctx, vw: 480, vh: 270, scale: 3,
    cam: { x: 0, y: 0 }, shake: 0, world: null, chunks: new Map(),
    particles: [], texts: [], effects: [], anim: new Map(), ghosts: [],
    mouse: { x: 0, y: 0 }, time: 0, specCache: new Map(), localSwing: null, flashT: 0, flashCol: '#ff0000',
  };

  R.resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    R.scale = Math.max(2, Math.ceil(Math.max(w / 520, h / 330)));
    R.vw = Math.ceil(w / R.scale);
    R.vh = Math.ceil(h / R.scale);
    canvas.width = R.vw; canvas.height = R.vh;
    canvas.style.width = R.vw * R.scale + 'px';
    canvas.style.height = R.vh * R.scale + 'px';
    light.width = R.vw; light.height = R.vh;
    ctx.imageSmoothingEnabled = false;
  };
  R.resize();

  R.setWorld = (world) => { R.world = world; R.chunks.clear(); R.anim.clear(); R.particles = []; R.texts = []; R.effects = []; };

  R.screenToWorld = (sx, sy) => ({ x: sx / R.scale + R.cam.x - R.vw / 2, y: sy / R.scale + R.cam.y - R.vh / 2 });

  // ---------------------------------------------------------------- chunks
  function chunk(cx, cy) {
    const key = cy * 1000 + cx;
    let c = R.chunks.get(key);
    if (c) return c;
    c = renderChunk(R.world, cx, cy);
    R.chunks.set(key, c);
    if (R.chunks.size > 90) R.chunks.delete(R.chunks.keys().next().value);
    return c;
  }

  // ---------------------------------------------------------------- effects API
  R.text = (x, y, str, color, life = 0.9, vy = -24) => R.texts.push({ x, y, str, color, t: 0, life, vy });
  R.burst = (x, y, colors, n = 8, speed = 60, life = 0.5, g = 0) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      R.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (g ? 30 : 0), life: life * (0.5 + Math.random() * 0.5), t: 0, c: colors[(Math.random() * colors.length) | 0], g, sz: Math.random() < 0.3 ? 2 : 1 });
    }
  };
  R.effect = (e) => { e.t = 0; R.effects.push(e); };
  R.addShake = (v) => { R.shake = Math.min(8, R.shake + v); };
  R.screenFlash = (col, t = 0.25) => { R.flashCol = col; R.flashT = t; };
  R.swing = (key, slot, ang, kind, dur = 0.18) => {
    const a = animOf(key);
    a.swT = 0; a.swDur = dur; a.swSlot = slot; a.swKind = kind; a.swAng = ang;
  };
  R.recoil = (key, slot) => { const a = animOf(key); if (slot === 'L') a.recL = 0.08; else a.recR = 0.08; };
  R.ghost = (x, y, sprite) => R.ghosts.push({ x, y, s: sprite, t: 0 });

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
    const me = view.me;
    // camera
    const look = me && !me.dead ? { x: (R.mouse.x / R.scale - R.vw / 2) * 0.18, y: (R.mouse.y / R.scale - R.vh / 2) * 0.18 } : { x: 0, y: 0 };
    const tx = (me ? me.x : W * TILE / 2) + look.x, ty = (me ? me.y - 8 : H * TILE / 2) + look.y;
    if (R.snapCam) { R.cam.x = tx; R.cam.y = ty; R.snapCam = false; }
    R.cam.x += (tx - R.cam.x) * Math.min(1, dt * 8);
    R.cam.y += (ty - R.cam.y) * Math.min(1, dt * 8);
    R.shake = Math.max(0, R.shake - dt * 18);
    const sx = (Math.random() - 0.5) * R.shake, sy = (Math.random() - 0.5) * R.shake;
    const ox = Math.round(R.cam.x - R.vw / 2 + sx), oy = Math.round(R.cam.y - R.vh / 2 + sy);
    R.ox = ox; R.oy = oy;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0f4c72';
    ctx.fillRect(0, 0, R.vw, R.vh);

    // ground chunks
    const c0 = Math.max(0, Math.floor(ox / CH_PX)), c1 = Math.min(Math.ceil(W / CHUNK) - 1, Math.floor((ox + R.vw) / CH_PX));
    const r0 = Math.max(0, Math.floor(oy / CH_PX)), r1 = Math.min(Math.ceil(H / CHUNK) - 1, Math.floor((oy + R.vh) / CH_PX));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) ctx.drawImage(chunk(cx, cy), cx * CH_PX - ox, cy * CH_PX - oy);

    ctx.translate(-ox, -oy);
    drawWater(world, ox, oy);
    drawCores(view);

    // telegraphs (ground)
    for (const e of R.effects) if (e.k === 'tele') {
      const p = Math.min(1, e.t / e.d);
      ctx.fillStyle = rgba('#ff3b5c', 0.12 + 0.18 * p);
      pixCircleFill(e.x, e.y, e.r * p);
      pixCircle(e.x, e.y, e.r, '#ff3b5c');
    }

    // pickups
    for (const k of view.pickups) {
      const bob = Math.sin(R.time * 5 + k.id) * 1.5;
      shadow(k.x, k.y + 2, 4);
      if (k.type === 'cash') {
        ctx.fillStyle = '#2fa84f'; ctx.fillRect(k.x - 4, k.y - 6 + bob, 8, 5);
        ctx.fillStyle = '#7dff9a'; ctx.fillRect(k.x - 3, k.y - 5 + bob, 6, 1);
        ctx.fillStyle = '#ffd23f'; ctx.fillRect(k.x - 1, k.y - 5 + bob, 2, 3);
      } else {
        ctx.fillStyle = '#1f9e3a'; ctx.fillRect(k.x - 2, k.y - 9 + bob, 5, 8);
        ctx.fillStyle = '#ff3b3b'; ctx.fillRect(k.x - 2, k.y - 7 + bob, 5, 3);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(k.x - 1, k.y - 9 + bob, 3, 1);
      }
    }

    // y-sorted drawables
    const list = [];
    const gx0 = Math.max(0, Math.floor((ox - 40) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 40) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 20) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 60) / CH_PX));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      for (const p of world.propGrid[gy * world.gridW + gx]) {
        if (p.x < ox - 40 || p.x > ox + R.vw + 40 || p.y < oy - 10 || p.y > oy + R.vh + 60) continue;
        list.push({ y: p.y, p });
      }
    }
    for (const p of view.players) if (!p.dead) list.push({ y: p.y, pl: p });
    for (const e of view.enemies) list.push({ y: e.y, en: e });
    for (const a of view.allies) list.push({ y: a.y, al: a });
    list.sort((a, b) => a.y - b.y);

    for (const g of R.ghosts) {
      const a = 0.4 * (1 - g.t / 0.3);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(flashOf(g.s), Math.round(g.x - g.s.ax), Math.round(g.y - g.s.ay));
      ctx.globalAlpha = 1;
    }
    for (const d of list) {
      if (d.p) drawProp(d.p, view);
      else if (d.pl) drawPlayer(d.pl, view, dt);
      else if (d.en) drawEnemy(d.en, dt);
      else drawAlly(d.al, view, dt);
    }

    drawProjectiles(view.projectiles, dt);
    drawEffects(dt);
    drawParticles(dt);

    // lighting
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawLighting(view, ox, oy);

    // overlays (after light so they stay readable)
    ctx.translate(-ox, -oy);
    drawTags(view, list);
    drawTexts(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawRaidArrows(view, ox, oy);
    if (R.flashT > 0) {
      R.flashT -= dt;
      ctx.fillStyle = rgba(R.flashCol, Math.min(0.35, R.flashT));
      ctx.fillRect(0, 0, R.vw, R.vh);
    }
    if (me && !me.dead && me.hp / me.maxHp < 0.3) {
      const a = (0.3 - me.hp / me.maxHp) * (0.8 + Math.sin(R.time * 6) * 0.3);
      const g = ctx.createRadialGradient(R.vw / 2, R.vh / 2, R.vh * 0.3, R.vw / 2, R.vh / 2, R.vh * 0.8);
      g.addColorStop(0, 'rgba(255,0,40,0)'); g.addColorStop(1, `rgba(255,0,40,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, R.vw, R.vh);
    }
    R.ghosts = R.ghosts.filter((g) => (g.t += dt) < 0.3);
  };

  // ---------------------------------------------------------------- pieces
  function shadow(x, y, w) {
    ctx.fillStyle = 'rgba(8,4,20,0.35)';
    ctx.fillRect(Math.round(x - w), Math.round(y - 1), w * 2, 2);
    ctx.fillRect(Math.round(x - w + 1), Math.round(y - 2), w * 2 - 2, 4);
  }

  function pixCircle(cx, cy, r, col) {
    ctx.fillStyle = col;
    const n = Math.max(12, Math.round(r * 2.2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.75), 1, 1);
    }
  }
  function pixCircleFill(cx, cy, r) {
    for (let y = -r * 0.75; y <= r * 0.75; y += 1) {
      const w = Math.sqrt(Math.max(0, r * r - (y / 0.75) ** 2));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), Math.round(w * 2), 1);
    }
  }

  function drawWater(world, ox, oy) {
    const t0 = Math.max(0, Math.floor(ox / TILE)), t1 = Math.min(W - 1, Math.floor((ox + R.vw) / TILE));
    const u0 = Math.max(0, Math.floor(oy / TILE)), u1 = Math.min(H - 1, Math.floor((oy + R.vh) / TILE));
    const ph = R.time;
    for (let ty = u0; ty <= u1; ty++) for (let tx = t0; tx <= t1; tx++) {
      if (world.tiles[ty * W + tx] !== T.WATER) continue;
      const h = hash2(tx, ty, 77);
      const k = (ph * 0.8 + h * 10) % 3;
      if (k < 1) {
        ctx.fillStyle = k < 0.5 ? '#3a8ab8' : '#5aa8d0';
        ctx.fillRect(tx * TILE + ((h * 13) | 0), ty * TILE + ((h * 977) % 14 | 0), 3, 1);
      }
      if (ty > 0 && world.tiles[(ty - 1) * W + tx] !== T.WATER || tx > 0 && world.tiles[ty * W + tx - 1] !== T.WATER || tx < W - 1 && world.tiles[ty * W + tx + 1] !== T.WATER || ty < H - 1 && world.tiles[(ty + 1) * W + tx] !== T.WATER) {
        const f = Math.sin(ph * 2 + tx * 0.7 + ty * 0.3);
        if (f > 0.3) { ctx.fillStyle = 'rgba(230,248,255,0.55)'; ctx.fillRect(tx * TILE + ((h * 7) | 0), ty * TILE + ((h * 11) | 0), 4, 1); }
      }
    }
  }

  function ownerColor(view, owner) {
    if (owner === 'g' || owner === 9) return view.gangColor;
    return FACTIONS[owner] ? FACTIONS[owner].color : '#888';
  }

  function drawCores(view) {
    // owner-colored capture circle on the ground around each visible compound core
    for (const Rg of view.world.regions) {
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      if (x < R.ox - 80 || x > R.ox + R.vw + 80 || y < R.oy - 80 || y > R.oy + R.vh + 80) continue;
      const rs = view.rs[Rg.id];
      const col = ownerColor(view, rs.owner);
      const pulse = 0.5 + Math.sin(R.time * 3) * 0.2;
      ctx.globalAlpha = 0.5 * pulse;
      pixCircle(x, y + 2, 2.6 * TILE, col);
      ctx.globalAlpha = 1;
      if (rs.capture > 0) {
        const n = 48;
        ctx.fillStyle = rs.owner === 'g' || rs.owner === 9 ? '#ff3b5c' : view.gangColor;
        for (let i = 0; i < n * rs.capture; i++) {
          const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
          ctx.fillRect(Math.round(x + Math.cos(a) * 2.6 * TILE), Math.round(y + 2 + Math.sin(a) * 2.6 * TILE * 0.75), 2, 2);
        }
      }
    }
  }

  function drawProp(p, view) {
    if (p.type === 'core') return drawCoreProp(p, view);
    let s;
    if (p.type === 'barrel') s = propSprite('barrel', 0, ((R.time * 8 + p.x) | 0) % 3);
    else if (p.type === 'station') s = propSprite('station', STATION_IDX[p.kind]);
    else s = propSprite(p.type, p.v);
    if (p.type === 'palm' || p.type === 'banana') shadow(p.x + 3, p.y, 7);
    else if (p.type === 'car') shadow(p.x, p.y + 1, 14);
    ctx.drawImage(s, Math.round(p.x - s.ax), Math.round(p.y - s.ay));
  }

  function drawCoreProp(p, view) {
    const rs = view.rs[p.region];
    const col = ownerColor(view, rs.owner);
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
    // flag
    ctx.fillStyle = col;
    const wave = Math.sin(R.time * 5 + p.region) > 0 ? 1 : 0;
    ctx.fillRect(x + 1, y - 29, 8, 4 + wave);
    ctx.fillStyle = shade(col, -0.3);
    ctx.fillRect(x + 1, y - 26 + wave, 8, 1);
  }

  function specFor(key, make) {
    let s = R.specCache.get(key);
    if (!s) { s = make(); R.specCache.set(key, s); if (R.specCache.size > 300) R.specCache.delete(R.specCache.keys().next().value); }
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
    return -((slot === 'L' ? a.recL : a.recR) > 0 ? 2 : 0);
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
    const dir = dirOf(aim);
    const frame = moving ? 1 + (Math.floor(a.dist / 5) % 4) : 0;
    const s = charSprite(spec, dir, frame);
    const bx = Math.round(x - s.ax), by = Math.round(y - s.ay);
    shadow(x, y, Math.max(4, Math.round(s.width * 0.3)));
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
    return s;
  }

  function drawPlayer(p, view, dt) {
    const look = p.look || {};
    const mods = p.mods || {};
    const key = 'p' + p.id;
    const spec = specFor('P' + JSON.stringify(look) + JSON.stringify(mods) + view.gangColor, () => playerSpec(look, mods, view.gangColor));
    const eq = p.equip || { L: 'fist', R: 'pistol' };
    const arms = [{ slot: 'L', kind: eq.L, color: '#aeb9c9' }, { slot: 'R', kind: eq.R, color: '#aeb9c9' }];
    const isMe = view.me && p.id === view.me.id;
    let alpha;
    if (p.cloak) alpha = isMe ? 0.35 : 0.1 + Math.abs(Math.sin(R.time * 9)) * 0.08;
    if (p.inv && Math.floor(R.time * 12) % 2) alpha = 0.5;
    const s = drawCharacter(key, p.x, p.y, p.aim, spec, arms, dt, { alpha, moving: isMe ? view.meMoving : undefined });
    p._top = s.top;
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
    if (!spec.special) {
      const kind = ENEMY_ARM[e.atk] || 'pistol';
      const col = shade(spec.top, -0.1);
      arms = e.boss ? [{ slot: 'L', kind: 'rail', color: col }, { slot: 'R', kind: kind === 'rail' ? 'rocket' : kind, color: col }] : [{ slot: 'R', kind, color: col }];
    }
    const flash = e.flash > 0 || (e.windup > 0 && Math.floor(R.time * 16) % 2 === 0);
    const s = drawCharacter(key, e.x, e.y, e.aim, spec, arms, dt, { flash, moving: e.moving });
    e._top = s.top;
    if (e.windup > 0 && Math.floor(R.time * 16) % 2) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(Math.round(e.x - 2), Math.round(e.y - s.top - 4), 4, 4);
      ctx.globalAlpha = 1;
    }
  }

  function drawAlly(al, view, dt) {
    const spec = specFor('A' + (al.id % 4) + view.gangColor, () => allySpec(view.gangColor, al.id % 4));
    const s = drawCharacter('a' + al.id, al.x, al.y, al.aim, spec, [{ slot: 'R', kind: 'pistol', color: shade(spec.top, -0.1) }], dt, { flash: al.flash > 0, moving: al.moving });
    al._top = s.top;
  }

  const PROJ = {
    pulse: ['#22e5ff', '#ffffff', 3], pellet: ['#ffb84a', '#fff0a0', 2], smart: ['#3ddc84', '#d0ffe0', 2],
    rocket: ['#ff8a3d', '#ffffff', 4], ebullet: ['#ff3b5c', '#ffd0d8', 3], eball: ['#c86bff', '#ffffff', 4], erocket: ['#ff3b5c', '#ffffff', 4],
  };
  function drawProjectiles(projs, dt) {
    for (const p of projs) {
      const st = PROJ[p.kind] || PROJ.pulse;
      const len = Math.hypot(p.vx, p.vy) || 1;
      const ux = p.vx / len, uy = p.vy / len;
      const x = Math.round(p.x), y = Math.round(p.y);
      ctx.fillStyle = st[0];
      for (let i = 1; i <= st[2]; i++) ctx.fillRect(Math.round(p.x - ux * i * 1.5), Math.round(p.y - uy * i * 1.5), 1, 1);
      if (p.kind === 'ebullet' || p.kind === 'eball') {
        const r = p.kind === 'eball' ? 2 : 1;
        ctx.fillRect(x - r, y - r, r * 2 + 1, r * 2 + 1);
        ctx.fillStyle = st[1]; ctx.fillRect(x, y, 1, 1);
      } else if (p.kind === 'rocket' || p.kind === 'erocket') {
        ctx.fillStyle = '#3a3a46'; ctx.fillRect(x - 1, y - 1, 3, 3);
        ctx.fillStyle = st[0]; ctx.fillRect(Math.round(x + ux * 2), Math.round(y + uy * 2), 2, 2);
        if (Math.random() < 0.6) R.particles.push({ x: p.x - ux * 4, y: p.y - uy * 4, vx: (Math.random() - 0.5) * 10, vy: -8, life: 0.5, t: 0, c: Math.random() < 0.5 ? '#8a8494' : '#ffb84a', g: 0, sz: 2 });
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
      } else if (e.k === 'ring') {
        ctx.globalAlpha = 1 - p;
        pixCircle(e.x, e.y, e.r * (0.3 + p * 0.7), e.c);
        if (e.r > 30) pixCircle(e.x, e.y, e.r * (0.2 + p * 0.6), e.c);
        ctx.globalAlpha = 1;
      } else if (e.k === 'boom') {
        const r = e.r * (0.4 + p * 0.6);
        ctx.fillStyle = p < 0.25 ? '#ffffff' : p < 0.5 ? '#ffd23f' : p < 0.75 ? '#ff6a2b' : '#5a4a5a';
        ctx.globalAlpha = 1 - p * 0.7;
        pixCircleFill(e.x, e.y, r);
        ctx.globalAlpha = 1;
      } else if (e.k === 'muzzle') {
        ctx.fillStyle = '#fff6c0';
        ctx.fillRect(Math.round(e.x) - 1, Math.round(e.y) - 1, 3, 3);
        ctx.fillStyle = e.c || '#ffd23f';
        ctx.fillRect(Math.round(e.x + Math.cos(e.a) * 3), Math.round(e.y + Math.sin(e.a) * 3), 2, 2);
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

  function drawParticles(dt) {
    const keep = [];
    for (const p of R.particles) {
      p.t += dt;
      if (p.t > p.life) continue;
      p.vy += p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= p.g ? 1 : 0.96;
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.min(1, (1 - p.t / p.life) * 1.5);
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.sz, p.sz);
      keep.push(p);
    }
    ctx.globalAlpha = 1;
    if (keep.length > 900) keep.splice(0, keep.length - 900);
    R.particles = keep;
  }

  // ---------------------------------------------------------------- lighting
  const glowCache = new Map();
  function glow(col) {
    let g = glowCache.get(col);
    if (g) return g;
    g = mk(64, 64);
    const c = g.getContext('2d');
    const grd = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, rgba(col, 0.5)); grd.addColorStop(0.35, rgba(col, 0.22)); grd.addColorStop(1, rgba(col, 0));
    c.fillStyle = grd; c.fillRect(0, 0, 64, 64);
    glowCache.set(col, g);
    return g;
  }
  const holeSprite = (() => {
    const g = mk(64, 64), c = g.getContext('2d');
    const grd = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.5, 'rgba(0,0,0,0.7)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grd; c.fillRect(0, 0, 64, 64);
    return g;
  })();

  R.darkness = (dayT) => {
    const sun = Math.sin((dayT - 0.25) * Math.PI * 2);
    return Math.max(0.1, Math.min(0.68, 0.5 - sun * 0.85));
  };

  function drawLighting(view, ox, oy) {
    const dayT = view.dayT ?? 0.3;
    const dark = R.darkness(dayT);
    const sun = Math.sin((dayT - 0.25) * Math.PI * 2);
    // sunset / sunrise tint
    const dusk = Math.max(0, 1 - Math.abs(sun) * 3);
    if (dusk > 0) { ctx.fillStyle = rgba(dayT > 0.5 ? '#ff4f8a' : '#ff9a5a', 0.16 * dusk); ctx.fillRect(0, 0, R.vw, R.vh); }
    if (dark < 0.06) return;
    const lights = [];
    const world = view.world;
    const gx0 = Math.max(0, Math.floor((ox - 64) / CH_PX)), gx1 = Math.min(world.gridW - 1, Math.floor((ox + R.vw + 64) / CH_PX));
    const gy0 = Math.max(0, Math.floor((oy - 64) / CH_PX)), gy1 = Math.min(world.gridH - 1, Math.floor((oy + R.vh + 64) / CH_PX));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      for (const l of world.lightGrid[gy * world.gridW + gx]) {
        if (l.x < ox - l.r || l.x > ox + R.vw + l.r || l.y < oy - l.r || l.y > oy + R.vh + l.r) continue;
        let r = l.r;
        if (l.flicker) r *= 0.85 + Math.sin(R.time * 17 + l.x) * 0.08 + Math.random() * 0.07;
        lights.push({ x: l.x, y: l.y, r, c: l.c, i: 1 });
      }
    }
    for (const Rg of world.regions) {
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE, y = (C.coreY + 0.5) * TILE;
      if (x < ox - 80 || x > ox + R.vw + 80 || y < oy - 80 || y > oy + R.vh + 80) continue;
      lights.push({ x, y: y - 30, r: 56, c: ownerColor(view, view.rs[Rg.id].owner), i: 1 });
    }
    for (const p of view.players) if (!p.dead && !p.cloak) lights.push({ x: p.x, y: p.y - 8, r: p === view.me ? 76 : 48, c: '#ffe6c0', i: 0.75, ng: true });
    for (const pr of view.projectiles) lights.push({ x: pr.x, y: pr.y, r: pr.kind.includes('rocket') ? 30 : 16, c: (PROJ[pr.kind] || PROJ.pulse)[0], i: 0.8 });
    for (const e of R.effects) {
      if (e.k === 'boom') lights.push({ x: e.x, y: e.y, r: e.r * 2.5 * (1 - e.t / e.life), c: '#ffb84a', i: 1 });
      else if (e.k === 'beam') lights.push({ x: (e.x + e.x2) / 2, y: (e.y + e.y2) / 2, r: 60, c: e.c, i: 1 - e.t / e.life });
      else if (e.k === 'muzzle') lights.push({ x: e.x, y: e.y, r: 24, c: '#ffd88a', i: 1 });
    }
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, R.vw, R.vh);
    lctx.fillStyle = `rgba(14,6,34,${dark})`;
    lctx.fillRect(0, 0, R.vw, R.vh);
    lctx.globalCompositeOperation = 'destination-out';
    for (const l of lights) {
      lctx.globalAlpha = Math.min(1, l.i);
      lctx.drawImage(holeSprite, l.x - ox - l.r, l.y - oy - l.r, l.r * 2, l.r * 2);
    }
    lctx.globalAlpha = 1;
    ctx.drawImage(light, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    const ga = Math.min(0.7, dark * 1.1);
    for (const l of lights) {
      if (l.ng) continue;
      ctx.globalAlpha = ga * Math.min(1, l.i);
      const rr = l.r * 0.8;
      ctx.drawImage(glow(l.c), l.x - ox - rr, l.y - oy - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- tags, texts, arrows
  function hpBar(x, y, w, frac, col) {
    x = Math.round(x - w / 2); y = Math.round(y);
    ctx.fillStyle = '#0b0710'; ctx.fillRect(x - 1, y - 1, w + 2, 4);
    ctx.fillStyle = '#3a1a22'; ctx.fillRect(x, y, w, 2);
    ctx.fillStyle = col || (frac > 0.6 ? '#3ddc84' : frac > 0.3 ? '#ffd23f' : '#ff3b5c');
    ctx.fillRect(x, y, Math.max(0, Math.round(w * frac)), 2);
  }

  function drawTags(view, list) {
    const me = view.me;
    for (const d of list) {
      if (d.pl) {
        const p = d.pl;
        if (p.cloak && (!me || p.id !== me.id)) continue;
        const top = p.y - (p._top || 26);
        drawText(ctx, p.name, p.x, top - 8, me && p.id === me.id ? '#ffffff' : view.gangColor);
        hpBar(p.x, top - 1, 16, p.hp / p.maxHp);
        if (p.chat && p.chat.t > R.time) drawText(ctx, p.chat.text, p.x, top - 16, '#ffd23f');
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
        if (a.hp < a.maxHp) hpBar(a.x, a.y - (a._top || 24) - 1, 12, a.hp / a.maxHp, view.gangColor);
      } else if (d.p && d.p.type === 'station') {
        const p = d.p;
        drawText(ctx, STATION_LABEL[p.kind], p.x, p.y - 38, STATION_COLORS[p.kind], 'center', '#120a1c');
      }
    }
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

  function drawRaidArrows(view, ox, oy) {
    if (!view.raids) return;
    for (const r of view.raids) {
      const Rg = view.world.regions[r.target];
      const C = Rg.compound;
      const x = (C.coreX + 0.5) * TILE - ox, y = (C.coreY + 0.5) * TILE - oy;
      if (x > 8 && x < R.vw - 8 && y > 8 && y < R.vh - 8) continue;
      const cx = R.vw / 2, cy = R.vh / 2;
      const a = Math.atan2(y - cy, x - cx);
      const m = 14;
      const k = Math.min((R.vw / 2 - m) / Math.abs(Math.cos(a) || 1e-3), (R.vh / 2 - m) / Math.abs(Math.sin(a) || 1e-3));
      const px = cx + Math.cos(a) * k, py = cy + Math.sin(a) * k;
      if (Math.floor(R.time * 4) % 2) continue;
      ctx.fillStyle = '#ff3b5c';
      for (let i = 0; i < 6; i++) for (let j = -i; j <= i; j++) {
        const lx = 6 - i, ly = j * 0.6;
        ctx.fillRect(Math.round(px + Math.cos(a) * lx - Math.sin(a) * ly), Math.round(py + Math.sin(a) * lx + Math.cos(a) * ly), 1, 1);
      }
      drawText(ctx, 'RAID', px - Math.cos(a) * 12, py - Math.sin(a) * 12 - 2, '#ff3b5c');
    }
  }

  return R;
}

// ------------------------------------------------------------------ chunk rendering
function renderChunk(world, cx, cy) {
  const c = mk(CH_PX, CH_PX);
  const g = c.getContext('2d');
  const set = getTileset();
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  const tAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T.WATER : world.tiles[y * W + x]);
  const P = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  for (let ty = y0; ty < y0 + CHUNK && ty < H; ty++) for (let tx = x0; tx < x0 + CHUNK && tx < W; tx++) {
    const t = world.tiles[ty * W + tx];
    const px = (tx - x0) * TILE, py = (ty - y0) * TILE;
    const vars = set[t] || set[T.CONCRETE];
    const h = hash2(tx, ty, world.seed);
    let v = (h * vars.length) | 0;
    if (t === T.ROAD) v = h < 0.82 ? 0 : (((h - 0.82) / 0.18) * vars.length) | 0;
    if (t === T.WALL || t === T.BUILD) g.drawImage(set[T.CONCRETE][0], px, py);
    else g.drawImage(vars[Math.min(vars.length - 1, v)], px, py);
    if (t === T.WATER) {
      const up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1), lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty);
      if (up !== T.WATER) { P(px, py, 16, 2, '#d8f4ff'); P(px, py + 2, 16, 1, '#5ab0d8'); }
      if (dn !== T.WATER) { P(px, py + 14, 16, 2, '#d8f4ff'); }
      if (lf !== T.WATER) { P(px, py, 2, 16, '#d8f4ff'); }
      if (rt !== T.WATER) { P(px + 14, py, 2, 16, '#d8f4ff'); }
    } else if (t === T.ROAD) {
      const up = tAt(tx, ty - 1), dn = tAt(tx, ty + 1);
      if (up !== T.ROAD && up !== T.BUILD) P(px, py, 16, 1, '#1a1922');
      if (dn !== T.ROAD) P(px, py + 15, 16, 1, '#1a1922');
      // dashed lane marks where roads are 3 wide
      if (up === T.ROAD && dn === T.ROAD && tAt(tx, ty - 2) !== T.ROAD && tAt(tx, ty + 2) !== T.ROAD && tx % 2 === 0) P(px + 4, py + 7, 8, 1, '#c8a83a');
      const lf = tAt(tx - 1, ty), rt = tAt(tx + 1, ty);
      if (lf === T.ROAD && rt === T.ROAD && tAt(tx - 2, ty) !== T.ROAD && tAt(tx + 2, ty) !== T.ROAD && ty % 2 === 0) P(px + 7, py + 4, 1, 8, '#c8a83a');
    } else if (t === T.SIDEWALK || t === T.CALCADAO || t === T.STAIRS) {
      if (tAt(tx, ty + 1) === T.ROAD) { P(px, py + 14, 16, 2, '#4a4656'); P(px, py + 14, 16, 1, '#b8b4c4'); }
      if (tAt(tx, ty - 1) === T.ROAD) P(px, py, 16, 1, '#b8b4c4');
      if (t === T.SIDEWALK && h > 0.93) { P(px + 9, py + 6, 4, 4, '#2a2a36'); P(px + 10, py + 5, 2, 1, '#3a3a46'); }
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
      }
      for (let i = 0; i < 4; i++) P(px + 1 + i * 4, py - 1, 2, 1, '#56606e');
    } else if (t === T.PAD) {
      P(px + 6, py + 6, 4, 4, '#2a2636');
    }
  }
  // building shadows, then buildings
  const bx0 = x0 - 12, by0 = y0 - 12, bx1 = x0 + CHUNK + 1, by1 = y0 + CHUNK + 1;
  const near = world.buildings.filter((b) => b.x < bx1 && b.x + b.w > bx0 && b.y < by1 && b.y + b.h > by0);
  g.fillStyle = 'rgba(10,6,24,0.28)';
  for (const b of near) g.fillRect((b.x - x0) * TILE + 4, (b.y - y0) * TILE + 4, b.w * TILE, b.h * TILE);
  for (const b of near) drawBuilding(g, b, (b.x - x0) * TILE, (b.y - y0) * TILE);
  // compound core capture circle (painted)
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
  }
  return c;
}
