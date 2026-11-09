// Generative micro house, made entirely with code.
// A seed picks the key, tempo, groove and sounds; patterns are re-rolled every cycle so the track
// keeps evolving. Layers come in and out in sections (intro / groove / full / break), and the game
// pushes an "intensity" (calm, combat, raid/boss) that changes the energy.

import { getAudio } from './audio.js';
import { makeRng } from './rng.js';

const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10] };
const ROOTS = [33, 35, 36, 38, 40, 41, 43];          // A1..G2 (bass register)
const VOWELS = [[800, 1150], [400, 800], [350, 2000], [600, 1000], [300, 870]];
const PROGS = [[0, 5, 3, 4], [0, 3, 5, 4], [0, 6, 5, 3], [0, 0, 5, 5], [0, 3, 0, 4], [0, 5, 0, 6]];
const SECTIONS = ['intro', 'groove', 'full', 'full', 'break', 'groove', 'full', 'full'];
const LAYERS = {
  intro: { kick: 1, hat: 0.5, clicks: 1, rim: 0, shaker: 0, bass: 0, chords: 0, vox: 0, agogo: 0, clap: 0, pad: 0 },
  groove: { kick: 1, hat: 1, clicks: 1, rim: 1, shaker: 1, bass: 1, chords: 0, vox: 0, agogo: 0, clap: 1, pad: 0 },
  full: { kick: 1, hat: 1, clicks: 1, rim: 1, shaker: 1, bass: 1, chords: 1, vox: 1, agogo: 1, clap: 1, pad: 0 },
  break: { kick: 0, hat: 0.4, clicks: 1, rim: 0, shaker: 1, bass: 0, chords: 1, vox: 1, agogo: 0, clap: 0, pad: 1 },
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function createMusic(seed = (Math.random() * 1e9) | 0) {
  const A = getAudio();
  const ac = A.ctx;
  if (!ac) return null;

  // ---------------------------------------------------------------- mixer
  const bus = ac.createGain(); bus.gain.value = 0.0; bus.connect(A.musicBus);
  const duck = ac.createGain(); duck.connect(bus);
  const drums = ac.createGain(); drums.gain.value = 0.9; drums.connect(bus);
  const delay = ac.createDelay(2); const fb = ac.createGain(); fb.gain.value = 0.42;
  const dl = ac.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2400;
  const dh = ac.createBiquadFilter(); dh.type = 'highpass'; dh.frequency.value = 300;
  delay.connect(dl); dl.connect(dh); dh.connect(fb); fb.connect(delay);
  const dsend = ac.createGain(); dsend.gain.value = 0.35; dsend.connect(delay);
  const dwet = ac.createGain(); dwet.gain.value = 0.55; dh.connect(dwet); dwet.connect(bus);
  const conv = ac.createConvolver(); conv.buffer = impulse(ac, 2.4);
  const rsend = ac.createGain(); rsend.gain.value = 0.3; rsend.connect(conv);
  const rwet = ac.createGain(); rwet.gain.value = 0.5; conv.connect(rwet); rwet.connect(bus);

  const M = {
    seed, bpm: 122, stepDur: 0, root: 36, scale: SCALES.minor, swing: 0.1,
    step: 0, bar: 0, nextTime: 0, timer: null, intensity: 0, target: 0, playing: false,
    patterns: null, section: 'intro', cycle: 0,
  };

  function roll(s) {
    const r = makeRng(s);
    if (M.cycle === 0) {
      M.bpm = r.int(120, 125);
      M.root = r.pick(ROOTS);
      M.scale = SCALES[r.pick(['minor', 'minor', 'dorian', 'dorian', 'phrygian'])];
      M.swing = r.range(0.06, 0.16);
      delay.delayTime.value = (60 / M.bpm) * 0.75;
    } else if (r.chance(0.3)) {
      M.root = ROOTS[(ROOTS.indexOf(M.root) + r.pick([2, 3, 4])) % ROOTS.length];
    }
    M.stepDur = 60 / M.bpm / 4;
    const P = {};
    P.kickExtra = r.chance(0.5) ? r.pick([7, 14, 15, 10]) : -1;
    P.hat = Array.from({ length: 16 }, (_, i) => (i % 4 === 2 ? 1 : i % 2 ? r.range(0.2, 0.7) : r.range(0, 0.35)));
    P.openHat = r.chance(0.6);
    P.rim = Array.from({ length: 16 }, (_, i) => (r.chance([3, 7, 11, 13, 14].includes(i) ? 0.45 : 0.06) ? r.range(0.4, 1) : 0));
    P.clapSteps = r.chance(0.7) ? [4, 12] : [12];
    P.shaker = Array.from({ length: 16 }, () => r.range(0.25, 0.8));
    P.agogo = Array.from({ length: 16 }, (_, i) => [0, 3, 6, 8, 10, 13].includes(i) && r.chance(0.7) ? (r.chance(0.5) ? 2 : 1) : 0);
    // bass: offbeat-heavy house line
    const bassNotes = [0, 0, 0, 7, 12, 10, 3, 5];
    P.bass = Array.from({ length: 16 }, (_, i) => {
      const p = i % 4 === 2 ? 0.85 : i % 2 === 1 ? 0.3 : i === 0 ? 0.15 : 0.08;
      return r.chance(p) ? { n: r.pick(bassNotes), len: r.pick([1, 1, 2]) } : null;
    });
    P.prog = r.pick(PROGS);
    P.stab = [];
    const stabPos = [2, 3, 6, 7, 10, 11, 14, 15];
    for (let i = 0; i < 16; i++) P.stab[i] = stabPos.includes(i) && r.chance(0.32);
    if (!P.stab.some(Boolean)) P.stab[3] = P.stab[10] = true;
    P.stabCut = r.range(700, 1600);
    P.vox = Array.from({ length: 32 }, () => (r.chance(0.08) ? { d: r.int(0, 7), v: r.int(0, VOWELS.length - 1) } : null));
    P.clicks = Array.from({ length: 16 }, () => (r.chance(0.28) ? r.range(2000, 9000) : 0));
    P.stabWave = r.pick(['sawtooth', 'square', 'sawtooth']);
    M.patterns = P;
  }

  // ---------------------------------------------------------------- instruments
  const nz = (t, dur, f, type, q, v, out, att = 0.001, pan = 0) => {
    const s = ac.createBufferSource(); s.buffer = A.noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g);
    if (pan && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(out); } else g.connect(out);
    s.start(t, Math.random() * 0.8); s.stop(t + dur + 0.02);
  };

  function kick(t, v) {
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.1);
    const g = ac.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
    o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.4);
    nz(t, 0.008, 3000, 'highpass', 0.7, v * 0.25, drums);
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(0.32, t); duck.gain.linearRampToValueAtTime(1, t + 0.24);
  }
  const hat = (t, v, open) => nz(t, open ? 0.2 : 0.035, open ? 8000 : 9500, 'highpass', 0.8, v * 0.16, drums, 0.001, (Math.random() - 0.5) * 0.4);
  function rim(t, v) {
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 1750;
    const g = ac.createGain(); g.gain.setValueAtTime(v * 0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g); g.connect(drums); g.connect(dsend); o.start(t); o.stop(t + 0.05);
    nz(t, 0.025, 2600, 'bandpass', 3, v * 0.2, drums);
  }
  function clap(t, v) {
    for (let k = 0; k < 3; k++) nz(t + k * 0.011, 0.02, 1300, 'bandpass', 1.2, v * 0.3, drums);
    nz(t + 0.033, 0.16, 1300, 'bandpass', 1.2, v * 0.28, drums);
    nz(t + 0.033, 0.16, 1300, 'bandpass', 1.2, v * 0.1, rsend);
  }
  const shaker = (t, v) => nz(t, 0.05, 6500, 'bandpass', 2.5, v * 0.07, drums, 0.012, 0.25);
  function agogo(t, hi) {
    const f = hi === 2 ? 1046 : 784;
    for (const [mul, a] of [[1, 0.08], [2.76, 0.025]]) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
      const g = ac.createGain(); g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(drums); g.connect(dsend); o.start(t); o.stop(t + 0.2);
    }
  }
  function bass(t, n, len) {
    const f = mtof(M.root + n);
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const o2 = ac.createOscillator(); o2.type = 'triangle'; o2.frequency.value = f;
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 380 + M.intensity * 200; fl.Q.value = 3;
    const g = ac.createGain(); const d = len * M.stepDur * 0.95;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.42, t + 0.006); g.gain.setValueAtTime(0.42, t + d * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    const g2 = ac.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2); g2.connect(fl); fl.connect(g); g.connect(duck);
    o.start(t); o2.start(t); o.stop(t + d + 0.02); o2.stop(t + d + 0.02);
  }
  function chordNotes(deg) {
    const sc = M.scale, base = M.root + 24;
    return [0, 2, 4, 6].map((k) => { const i = deg + k; return base + sc[i % 7] + 12 * Math.floor(i / 7); });
  }
  function stab(t, deg, len) {
    const cut = M.patterns.stabCut * (0.7 + M.intensity * 0.35) * (M.section === 'break' ? 0.6 : 1);
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 5;
    fl.frequency.setValueAtTime(cut * 3, t); fl.frequency.exponentialRampToValueAtTime(cut, t + 0.12);
    const g = ac.createGain(); const d = Math.max(0.12, len * M.stepDur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.09, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
    fl.connect(g); g.connect(duck); g.connect(dsend); g.connect(rsend);
    for (const n of chordNotes(deg)) for (const det of [-8, 7]) {
      const o = ac.createOscillator(); o.type = M.patterns.stabWave; o.frequency.value = mtof(n); o.detune.value = det;
      o.connect(fl); o.start(t); o.stop(t + d + 0.25);
    }
  }
  function pad(t, deg, dur) {
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 700; fl.Q.value = 1;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + dur * 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    fl.connect(g); g.connect(bus); g.connect(rsend);
    for (const n of chordNotes(deg)) for (const det of [-12, 0, 12]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(n); o.detune.value = det;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function vox(t, deg, vw) {
    const sc = M.scale, n = M.root + 36 + sc[deg % 7];
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(mtof(n), t);
    o.frequency.linearRampToValueAtTime(mtof(n) * (Math.random() < 0.5 ? 1 : 0.94), t + 0.15);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.14, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    for (const f of VOWELS[vw]) {
      const b = ac.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = 9;
      o.connect(b); b.connect(g);
    }
    g.connect(duck); g.connect(dsend);
    o.start(t); o.stop(t + 0.22);
  }
  const click = (t, f) => nz(t, 0.004 + Math.random() * 0.01, f, 'bandpass', 6, 0.35, drums, 0.0005, (Math.random() - 0.5) * 1.6);
  function arp(t, deg) {
    const sc = M.scale, n = M.root + 36 + sc[deg % 7] + 12 * Math.floor(deg / 7);
    const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = mtof(n);
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 1800; fl.Q.value = 6;
    const g = ac.createGain(); g.gain.setValueAtTime(0.035, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(fl); fl.connect(g); g.connect(duck); g.connect(dsend);
    o.start(t); o.stop(t + 0.1);
  }

  // ---------------------------------------------------------------- sequencer
  function playStep(t) {
    const P = M.patterns, s = M.step, I = M.intensity;
    let sec = M.section;
    if (I >= 2 && sec !== 'break') sec = 'full';
    if (I === 0 && sec === 'full' && M.bar % 8 < 2) sec = 'groove';
    const L = LAYERS[sec];
    const sw = s % 2 ? M.swing * M.stepDur : 0;
    const tt = t + sw;
    const chordDeg = P.prog[Math.floor(M.bar / 2) % P.prog.length];
    if (L.kick && (s % 4 === 0 || s === P.kickExtra)) kick(t, s % 4 === 0 ? 0.95 : 0.45);
    if (L.hat) {
      const v = P.hat[s] * L.hat * (0.8 + I * 0.25);
      if (P.openHat && s % 4 === 2) hat(tt, 0.9, true);
      else if (Math.random() < v) hat(tt, v, false);
    }
    if (L.rim && P.rim[s]) rim(tt, P.rim[s]);
    if (L.clap && P.clapSteps.includes(s)) clap(t, 0.8);
    if (L.shaker && (I > 0 || sec !== 'groove' || M.bar % 4 > 1)) shaker(tt, P.shaker[s]);
    if (L.agogo && P.agogo[s] && M.bar % 2 === 1) agogo(tt, P.agogo[s]);
    if (L.bass && P.bass[s]) bass(tt, P.bass[s].n + (chordDeg ? M.scale[chordDeg % 7] - (chordDeg >= 5 ? 12 : 0) : 0), P.bass[s].len);
    if (L.chords && P.stab[s]) stab(tt, chordDeg, P.stab[(s + 1) % 16] ? 1 : 2);
    if (L.pad && s === 0 && M.bar % 2 === 0) pad(t, chordDeg, M.stepDur * 32);
    if (L.vox) { const vx = P.vox[(M.bar % 2) * 16 + s]; if (vx) vox(tt, vx.d, vx.v); }
    if (L.clicks && P.clicks[s] && Math.random() < 0.8) click(tt, P.clicks[s]);
    if (I >= 2 && s % 2 === 0) arp(tt, chordDeg + [0, 2, 4, 7, 4, 2, 0, 4][(s / 2) % 8]);
    if (I >= 1 && s % 4 === 3 && Math.random() < 0.3) click(tt, 9000);
  }

  function advance() {
    M.step++;
    if (M.step >= 16) {
      M.step = 0; M.bar++;
      if (M.bar % 8 === 0) {
        const idx = (M.bar / 8) % SECTIONS.length;
        M.section = SECTIONS[idx];
        if (idx === 0) { M.cycle++; roll(M.seed + M.cycle * 7919); }
      }
      M.intensity += Math.sign(M.target - M.intensity) * Math.min(1, Math.abs(M.target - M.intensity));
    }
  }

  function tick() {
    while (M.nextTime < ac.currentTime + 0.14) {
      playStep(M.nextTime);
      M.nextTime += M.stepDur;
      advance();
    }
  }

  M.start = () => {
    if (M.playing) return;
    M.playing = true;
    roll(M.seed);
    M.nextTime = ac.currentTime + 0.1;
    bus.gain.cancelScheduledValues(ac.currentTime);
    bus.gain.setValueAtTime(0, ac.currentTime);
    bus.gain.linearRampToValueAtTime(0.7, ac.currentTime + 3);
    M.timer = setInterval(tick, 25);
  };
  M.stop = () => {
    if (!M.playing) return;
    M.playing = false;
    clearInterval(M.timer);
    bus.gain.setTargetAtTime(0, ac.currentTime, 0.3);
  };
  M.setIntensity = (v) => { M.target = v; };
  M.reseed = (s) => { M.seed = s; M.cycle = 0; M.bar = 0; M.step = 0; M.section = 'intro'; roll(s); };
  return M;
}

function impulse(ac, secs) {
  const len = Math.floor(ac.sampleRate * secs);
  const b = ac.createBuffer(2, len, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return b;
}
