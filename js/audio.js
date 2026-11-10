// Sound effects, synthesized live with Web Audio (no audio files).

let ac = null, master, sfxBus, musicBus, comp, noiseBuf;
let listenerX = 0, listenerY = 0;
const last = new Map();
const vol = { music: 0.6, sfx: 0.8 };

export function initAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return ac; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  master = ac.createGain(); master.gain.value = 0.9;
  sfxBus = ac.createGain(); sfxBus.gain.value = vol.sfx;
  musicBus = ac.createGain(); musicBus.gain.value = vol.music;
  sfxBus.connect(master); musicBus.connect(master); master.connect(comp); comp.connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ac;
}

export const getAudio = () => ({ ctx: ac, musicBus, sfxBus, noiseBuf });

export function setVolume(kind, v) {
  vol[kind] = v;
  if (!ac) return;
  (kind === 'music' ? musicBus : sfxBus).gain.setTargetAtTime(v, ac.currentTime, 0.05);
}
export const getVolume = (kind) => vol[kind];

export function setListener(x, y) { listenerX = x; listenerY = y; }

function noise(t, dur, { type = 'lowpass', f = 1000, f2, q = 1, v = 0.5, out, attack = 0.002 }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const fl = ac.createBiquadFilter();
  fl.type = type; fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(fl); fl.connect(g); g.connect(out);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}

function tone(t, dur, { wave = 'square', f = 440, f2, v = 0.3, out, attack = 0.002 }) {
  const o = ac.createOscillator();
  o.type = wave;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.05);
}

const LIMIT = { pistol: 0.04, smg: 0.05, hit: 0.03, ebullet: 0.05, die: 0.04, cash: 0.06, spark: 0.05, punch: 0.04, flame: 0.09, tmg: 0.06, zap: 0.08 };

// Flying vehicle engine hum (a looping synth that follows speed). level 0 = off, 1 = full throttle.
let engine = null;
export function setEngine(level, pitch = 1) {
  if (!ac || ac.state !== 'running') return;
  if (!engine) {
    const o1 = ac.createOscillator(), o2 = ac.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square';
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 500; fl.Q.value = 4;
    const g = ac.createGain(); g.gain.value = 0;
    o1.connect(fl); o2.connect(fl); fl.connect(g); g.connect(sfxBus);
    o1.start(); o2.start();
    engine = { o1, o2, fl, g };
  }
  const t = ac.currentTime;
  const f = 55 * pitch * (1 + level * 0.8);
  engine.o1.frequency.setTargetAtTime(f, t, 0.1);
  engine.o2.frequency.setTargetAtTime(f * 1.505, t, 0.1);
  engine.fl.frequency.setTargetAtTime(300 + level * 900, t, 0.1);
  engine.g.gain.setTargetAtTime(level > 0 ? 0.035 + level * 0.04 : 0, t, 0.15);
}

// x, y: world position (for distance + stereo); omit for UI sounds.
export function sfx(name, x, y, volume = 1) {
  if (!ac || ac.state !== 'running') return;
  const now = ac.currentTime;
  const lim = LIMIT[name] ?? 0.02;
  if (now - (last.get(name) || 0) < lim) return;
  last.set(name, now);
  let g = volume, pan = 0;
  if (x !== undefined) {
    const dx = x - listenerX, dy = y - listenerY;
    const d = Math.hypot(dx, dy);
    if (d > 460) return;
    g *= Math.pow(Math.max(0, 1 - d / 460), 1.4);
    pan = Math.max(-1, Math.min(1, dx / 260));
  }
  if (g < 0.02) return;
  const out = ac.createGain();
  out.gain.value = g;
  if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; out.connect(p); p.connect(sfxBus); }
  else out.connect(sfxBus);
  const t = now + 0.005;
  switch (name) {
    case 'punch': noise(t, 0.06, { f: 900, v: 0.5, out }); tone(t, 0.08, { wave: 'sine', f: 140, f2: 55, v: 0.5, out }); break;
    case 'slash': noise(t, 0.13, { type: 'bandpass', f: 4000, f2: 1200, q: 2, v: 0.6, out }); tone(t, 0.1, { wave: 'sawtooth', f: 1800, f2: 500, v: 0.08, out }); break;
    case 'pistol': tone(t, 0.07, { f: 900, f2: 180, v: 0.18, out }); noise(t, 0.04, { type: 'highpass', f: 2500, v: 0.25, out }); break;
    case 'smg': tone(t, 0.04, { f: 1300, f2: 400, v: 0.12, out }); noise(t, 0.03, { type: 'highpass', f: 3000, v: 0.18, out }); break;
    case 'shotgun': noise(t, 0.22, { f: 1600, f2: 300, v: 0.7, out }); tone(t, 0.15, { wave: 'sine', f: 160, f2: 40, v: 0.5, out }); break;
    case 'whip': tone(t, 0.14, { wave: 'sine', f: 2400, f2: 300, v: 0.25, out }); noise(t, 0.1, { type: 'highpass', f: 5000, v: 0.3, out }); break;
    case 'slam': tone(t, 0.32, { wave: 'sine', f: 100, f2: 30, v: 0.8, out }); noise(t, 0.3, { f: 600, f2: 120, v: 0.6, out }); break;
    case 'rocket': noise(t, 0.35, { type: 'bandpass', f: 500, f2: 1500, q: 1.5, v: 0.5, out }); tone(t, 0.2, { wave: 'sawtooth', f: 120, f2: 300, v: 0.1, out }); break;
    case 'boom': noise(t, 0.7, { f: 1000, f2: 80, v: 0.9, out }); tone(t, 0.5, { wave: 'sine', f: 80, f2: 25, v: 0.8, out }); break;
    case 'beam': tone(t, 0.25, { wave: 'sawtooth', f: 200, f2: 1800, v: 0.15, out }); tone(t, 0.3, { wave: 'sine', f: 3000, f2: 900, v: 0.12, out }); noise(t, 0.2, { type: 'highpass', f: 4000, v: 0.2, out }); break;
    case 'hit': noise(t, 0.035, { type: 'highpass', f: 2000, v: 0.35, out }); tone(t, 0.03, { f: 600, f2: 300, v: 0.08, out }); break;
    case 'spark': noise(t, 0.03, { type: 'highpass', f: 5000, v: 0.15, out }); break;
    case 'hurt': tone(t, 0.14, { f: 320, f2: 120, v: 0.25, out }); noise(t, 0.08, { f: 1500, v: 0.3, out }); break;
    case 'die': noise(t, 0.25, { f: 1400, f2: 200, v: 0.5, out }); tone(t, 0.2, { f: 420, f2: 70, v: 0.15, out }); break;
    case 'bigdie': noise(t, 0.6, { f: 1200, f2: 60, v: 0.8, out }); tone(t, 0.5, { wave: 'sawtooth', f: 300, f2: 30, v: 0.2, out }); break;
    case 'ebullet': tone(t, 0.06, { f: 700, f2: 280, v: 0.1, out }); break;
    case 'cash': tone(t, 0.06, { f: 1318, v: 0.12, out }); tone(t + 0.06, 0.12, { f: 1760, v: 0.12, out }); break;
    case 'pickup': tone(t, 0.1, { wave: 'triangle', f: 880, f2: 1320, v: 0.3, out }); break;
    case 'levelup': [523, 659, 784, 1046, 1318].forEach((f, i) => tone(t + i * 0.07, 0.2, { f, v: 0.15, out })); break;
    case 'capture': [392, 523, 659, 784].forEach((f, i) => tone(t + i * 0.1, 0.4, { wave: 'sawtooth', f, v: 0.08, out })); [523, 659, 784].forEach((f) => tone(t + 0.45, 0.9, { wave: 'triangle', f, v: 0.12, out })); break;
    case 'alarm': for (let i = 0; i < 3; i++) { tone(t + i * 0.5, 0.25, { wave: 'sawtooth', f: 620, f2: 940, v: 0.12, out }); tone(t + i * 0.5 + 0.25, 0.25, { wave: 'sawtooth', f: 940, f2: 620, v: 0.12, out }); } break;
    case 'lost': [659, 523, 392, 262].forEach((f, i) => tone(t + i * 0.14, 0.3, { wave: 'sawtooth', f, v: 0.08, out })); break;
    case 'dash': noise(t, 0.16, { type: 'bandpass', f: 800, f2: 3000, q: 1, v: 0.35, out }); break;
    case 'heal': [660, 880, 1100].forEach((f, i) => tone(t + i * 0.06, 0.2, { wave: 'sine', f, v: 0.15, out })); break;
    case 'cloak': tone(t, 0.4, { wave: 'sine', f: 1500, f2: 200, v: 0.15, out }); break;
    case 'shield': tone(t, 0.3, { wave: 'square', f: 200, f2: 600, v: 0.08, out }); tone(t, 0.3, { wave: 'sine', f: 400, f2: 1200, v: 0.1, out }); break;
    case 'tele': tone(t, 0.12, { f: 880, v: 0.1, out }); break;
    case 'click': tone(t, 0.03, { f: 1200, v: 0.08, out }); break;
    case 'buy': tone(t, 0.08, { f: 988, v: 0.12, out }); tone(t + 0.08, 0.2, { f: 1318, v: 0.12, out }); noise(t, 0.05, { type: 'highpass', f: 6000, v: 0.1, out }); break;
    case 'error': tone(t, 0.15, { f: 180, v: 0.15, out }); break;
    case 'boss': tone(t, 1.2, { wave: 'sawtooth', f: 55, f2: 50, v: 0.3, out }); tone(t, 1.2, { wave: 'sawtooth', f: 82, f2: 78, v: 0.2, out }); break;
    case 'enemyup': tone(t, 0.3, { wave: 'sawtooth', f: 200, f2: 600, v: 0.15, out }); tone(t + 0.15, 0.3, { wave: 'square', f: 300, f2: 900, v: 0.08, out }); break;
    case 'respawn': tone(t, 0.4, { wave: 'triangle', f: 300, f2: 900, v: 0.2, out }); break;
    case 'death': tone(t, 0.8, { wave: 'sawtooth', f: 400, f2: 50, v: 0.2, out }); noise(t, 0.5, { f: 800, f2: 100, v: 0.4, out }); break;
    case 'flame': noise(t, 0.16, { type: 'bandpass', f: 900, f2: 500, q: 0.8, v: 0.35, out }); noise(t, 0.12, { f: 300, v: 0.25, out }); break;
    case 'tmg': tone(t, 0.05, { f: 1100, f2: 300, v: 0.12, out }); noise(t, 0.03, { type: 'highpass', f: 3000, v: 0.16, out }); break;
    case 'zap': tone(t, 0.18, { wave: 'sawtooth', f: 1800, f2: 200, v: 0.14, out }); noise(t, 0.15, { type: 'highpass', f: 5000, v: 0.25, out }); break;
    case 'venter': tone(t, 0.3, { wave: 'sawtooth', f: 80, f2: 220, v: 0.15, out }); tone(t + 0.1, 0.2, { wave: 'square', f: 440, f2: 660, v: 0.06, out }); break;
    case 'vexit': tone(t, 0.25, { wave: 'sawtooth', f: 220, f2: 70, v: 0.12, out }); break;
    case 'vboom': noise(t, 1.0, { f: 900, f2: 60, v: 1.0, out }); tone(t, 0.8, { wave: 'sine', f: 70, f2: 22, v: 0.9, out }); tone(t, 0.4, { wave: 'sawtooth', f: 400, f2: 40, v: 0.2, out }); break;
    case 'zapboom': noise(t, 0.6, { type: 'highpass', f: 3000, v: 0.6, out }); tone(t, 0.5, { wave: 'sawtooth', f: 2000, f2: 80, v: 0.25, out }); tone(t, 0.4, { wave: 'sine', f: 90, f2: 30, v: 0.6, out }); break;
    case 'follower': [523, 784, 1046].forEach((f, i) => tone(t + i * 0.08, 0.18, { wave: 'triangle', f, v: 0.16, out })); break;
    case 'cup': [392, 523, 784].forEach((f, i) => tone(t + i * 0.06, 0.2, { wave: 'square', f, v: 0.08, out })); break;
    case 'wp': tone(t, 0.1, { wave: 'sine', f: 1320, v: 0.15, out }); tone(t + 0.1, 0.15, { wave: 'sine', f: 1760, v: 0.12, out }); break;
    case 'land': tone(t, 0.4, { wave: 'sawtooth', f: 300, f2: 60, v: 0.15, out }); noise(t + 0.3, 0.2, { f: 600, v: 0.3, out }); break;
    case 'save': tone(t, 0.05, { wave: 'sine', f: 1500, v: 0.05, out }); break;
    // police siren: two-tone wail
    case 'siren': for (let i = 0; i < 4; i++) { tone(t + i * 0.36, 0.34, { wave: 'square', f: 780, f2: 1180, v: 0.07, out, attack: 0.03 }); tone(t + i * 0.36, 0.34, { wave: 'sine', f: 390, f2: 590, v: 0.1, out, attack: 0.03 }); } break;
    case 'copsdrop': tone(t, 0.35, { wave: 'sawtooth', f: 200, f2: 60, v: 0.12, out }); noise(t, 0.3, { f: 800, f2: 200, v: 0.3, out }); break;
    // gulp + fizz
    case 'drink': for (let i = 0; i < 3; i++) tone(t + i * 0.13, 0.09, { wave: 'sine', f: 220 + i * 30, f2: 120, v: 0.35, out }); noise(t + 0.4, 0.35, { type: 'highpass', f: 6000, v: 0.12, out }); break;
    case 'stim': noise(t, 0.25, { type: 'bandpass', f: 1200, f2: 4000, q: 2, v: 0.3, out }); tone(t + 0.1, 0.5, { wave: 'sawtooth', f: 110, f2: 880, v: 0.07, out }); break;
    case 'poison': tone(t, 0.5, { wave: 'sawtooth', f: 160, f2: 90, v: 0.12, out }); tone(t, 0.5, { wave: 'sawtooth', f: 167, f2: 95, v: 0.12, out }); break;
    case 'door': noise(t, 0.12, { f: 400, v: 0.35, out }); tone(t, 0.1, { wave: 'sine', f: 120, f2: 70, v: 0.3, out }); noise(t + 0.15, 0.25, { type: 'bandpass', f: 1800, q: 3, v: 0.12, out }); break;
    case 'cheat': [262, 392, 523, 784, 1046].forEach((f, i) => tone(t + i * 0.05, 0.3, { wave: 'triangle', f, v: 0.15, out })); noise(t, 0.4, { type: 'highpass', f: 5000, v: 0.15, out }); break;
    case 'dance': tone(t, 0.08, { wave: 'square', f: 523, v: 0.08, out }); tone(t + 0.12, 0.08, { wave: 'square', f: 659, v: 0.08, out }); tone(t + 0.24, 0.12, { wave: 'square', f: 784, v: 0.08, out }); break;
    default: tone(t, 0.05, { f: 600, v: 0.1, out });
  }
}
