// Generative Brazilian funk, chiptune flavored, made entirely with code (Web Audio).
// Every district has its own track: the faction that owns it picks the style, the district picks the riff,
// key and patterns. Walking into another district sweeps a DJ filter and drops the new track on the next bar.
//
// Styles:
//   volt      — classic funk carioca (Volt Mix / tamborzão), 130 BPM. Your gang's turf and the QG.
//   bruxaria  — dark, distorted, hypnotic funk. Milícia turf.
//   melody    — cleaner melodic funk with arps and pads. NeoBrás turf.
//   f150      — fast funk 150 / mandelão, heavy toms and chops. Comando Cromo turf.

import { getAudio } from './audio.js';
import { makeRng } from './rng.js';

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixo: [0, 2, 4, 5, 7, 9, 10], harm: [0, 2, 3, 5, 7, 8, 11],
};
const PENTA = [0, 3, 5, 7, 10];
const ROOTS = [33, 34, 35, 36, 37, 38, 39, 40, 41];   // A1..F2
const VOWELS = [[800, 1150], [400, 800], [350, 2000], [600, 1000], [300, 870]];

const STYLES = {
  volt: {
    bpm: [128, 131], scales: ['minor', 'dorian', 'minor'], swing: [0.02, 0.07],
    kicks: [[0, 3, 6, 10, 12], [0, 3, 6, 10, 13], [0, 3, 7, 10, 12], [0, 3, 6, 8, 11, 14]],
    claps: [[4, 12], [4, 12, 15], [4, 11, 12]], toms: [[2, 5, 7, 9, 13, 15], [2, 7, 9, 14, 15], [3, 5, 8, 11, 14]],
    bassWave: 'sine', bassDist: 0, lead: 'pulse25', leadOct: 2, voltVox: true, agogo: 0.4, whistle: 0.3, arp: 0, pad: 0, dark: 0,
  },
  bruxaria: {
    bpm: [126, 130], scales: ['phrygian', 'harm'], swing: [0.0, 0.04],
    kicks: [[0, 6, 10], [0, 3, 10, 12], [0, 6, 8, 12]],
    claps: [[4, 12], [12], [4, 12, 13, 14]], toms: [[3, 7, 11], [2, 10, 15], [5, 13]],
    bassWave: 'square', bassDist: 1, lead: 'bell', leadOct: 2, voltVox: false, agogo: 0, whistle: 0, arp: 0, pad: 0.6, dark: 1,
  },
  melody: {
    bpm: [126, 129], scales: ['mixo', 'dorian', 'minor'], swing: [0.03, 0.08],
    kicks: [[0, 3, 6, 8, 12], [0, 4, 6, 8, 12, 14], [0, 3, 6, 10, 12]],
    claps: [[4, 12], [4, 12]], toms: [[7, 15], [2, 10], [7, 13, 15]],
    bassWave: 'triangle', bassDist: 0, lead: 'tri', leadOct: 2, voltVox: false, agogo: 0.2, whistle: 0, arp: 1, pad: 1, dark: 0,
  },
  f150: {
    bpm: [148, 152], scales: ['minor', 'phrygian'], swing: [0.0, 0.03],
    kicks: [[0, 3, 6, 8, 11, 14], [0, 3, 6, 10, 12, 14], [0, 2, 6, 8, 11, 13]],
    claps: [[4, 12], [4, 10, 12], [4, 12, 14]], toms: [[1, 3, 5, 7, 9, 11, 13, 15], [2, 3, 6, 7, 10, 11, 14, 15], [1, 5, 7, 9, 13, 15]],
    bassWave: 'square', bassDist: 0.6, lead: 'pulse12', leadOct: 2, voltVox: false, agogo: 0.6, whistle: 0.5, arp: 0, pad: 0, dark: 0.3, chops: true,
  },
};
const SECTIONS = ['intro', 'groove', 'full', 'full', 'break', 'groove', 'full', 'full'];
const LAYERS = {
  intro: { kick: 1, hat: 0.6, clap: 0, toms: 0, bass: 0, lead: 0, perc: 1, pad: 0, vox: 0 },
  groove: { kick: 1, hat: 1, clap: 1, toms: 1, bass: 1, lead: 0, perc: 1, pad: 0, vox: 0 },
  full: { kick: 1, hat: 1, clap: 1, toms: 1, bass: 1, lead: 1, perc: 1, pad: 1, vox: 1 },
  break: { kick: 0, hat: 0.5, clap: 0, toms: 1, bass: 0, lead: 1, perc: 0, pad: 1, vox: 1 },
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function createMusic(seed = (Math.random() * 1e9) | 0) {
  const A = getAudio();
  const ac = A.ctx;
  if (!ac) return null;

  // ---------------------------------------------------------------- mixer
  const bus = ac.createGain(); bus.gain.value = 0; bus.connect(A.musicBus);
  const sweep = ac.createBiquadFilter(); sweep.type = 'lowpass'; sweep.frequency.value = 18000; sweep.Q.value = 3;
  sweep.connect(bus);
  const duck = ac.createGain(); duck.connect(sweep);
  // drums go through a light "bit crush" for the chiptune grit
  const drums = ac.createGain(); drums.gain.value = 0.95;
  const crush = ac.createWaveShaper(); crush.curve = stepCurve(24); crush.oversample = 'none';
  drums.connect(crush); crush.connect(sweep);
  const delay = ac.createDelay(2); const fb = ac.createGain(); fb.gain.value = 0.38;
  const dl = ac.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 2600;
  delay.connect(dl); dl.connect(fb); fb.connect(delay);
  const dsend = ac.createGain(); dsend.gain.value = 0.3; dsend.connect(delay);
  const dwet = ac.createGain(); dwet.gain.value = 0.5; dl.connect(dwet); dwet.connect(sweep);
  const conv = ac.createConvolver(); conv.buffer = impulse(ac, 2.0);
  const rsend = ac.createGain(); rsend.gain.value = 0.25; rsend.connect(conv);
  const rwet = ac.createGain(); rwet.gain.value = 0.45; conv.connect(rwet); rwet.connect(sweep);
  const dist = ac.createWaveShaper(); dist.curve = driveCurve(6); dist.connect(duck);
  const waves = {
    pulse25: pulseWave(ac, 0.25), pulse12: pulseWave(ac, 0.125),
  };

  const M = {
    seed, style: 'volt', S: STYLES.volt, bpm: 130, stepDur: 0, root: 36, scale: SCALES.minor, swing: 0.04,
    step: 0, bar: 0, nextTime: 0, timer: null, intensity: 0, target: 0, playing: false,
    P: null, section: 'intro', cycle: 0, pending: null,
  };

  function roll(s) {
    const r = makeRng(s);
    const S = M.S;
    if (M.cycle === 0) {
      M.bpm = r.int(S.bpm[0], S.bpm[1]);
      M.root = r.pick(ROOTS);
      M.scale = SCALES[r.pick(S.scales)];
      M.swing = r.range(S.swing[0], S.swing[1]);
      delay.delayTime.value = (60 / M.bpm) * 0.75;
    }
    M.stepDur = 60 / M.bpm / 4;
    const P = {};
    P.kick = r.pick(S.kicks);
    P.kick2 = r.pick(S.kicks);
    P.clap = r.pick(S.claps);
    P.toms = r.pick(S.toms).map((st) => ({ st, hi: r.chance(0.5) }));
    P.hat = Array.from({ length: 16 }, (_, i) => (i % 2 ? r.range(0.5, 0.9) : r.range(0.05, 0.4)));
    P.openHat = r.chance(0.5) ? r.pick([6, 14, 10]) : -1;
    // 808 bass follows the kick: root mostly, fifth/octave/seventh sometimes
    P.bass = Array.from({ length: 16 }, (_, i) => (P.kick.includes(i) ? r.pick([0, 0, 0, 7, 12, -2, 0, 5]) : r.chance(0.08) ? r.pick([0, 7, 12]) : null));
    // the hook: a 2-bar riff on the pentatonic (catchy, repeated)
    const riffLen = 32;
    P.riff = [];
    let deg = r.int(0, 4);
    for (let i = 0; i < riffLen; i++) {
      const strong = i % 4 === 0 || i % 4 === 3;
      if (r.chance(strong ? 0.6 : 0.22)) {
        deg = Math.max(0, Math.min(9, deg + r.pick([-2, -1, 0, 1, 1, 2, 3, -3])));
        P.riff.push({ n: PENTA[deg % 5] + 12 * Math.floor(deg / 5), len: r.pick([1, 1, 2, 3]) });
      } else P.riff.push(null);
    }
    for (let i = 16; i < riffLen; i++) if (r.chance(0.55)) P.riff[i] = P.riff[i - 16];      // second bar echoes the first
    P.arp = Array.from({ length: 8 }, () => r.pick([0, 2, 4, 7, 4, 2, 9, 7]));
    P.chord = r.pick([[0, 5, 3, 4], [0, 3, 5, 4], [0, 6, 5, 3], [0, 0, 5, 5], [0, 4, 5, 3]]);
    P.agogo = Array.from({ length: 16 }, (_, i) => ([0, 3, 6, 8, 10, 13].includes(i) && r.chance(0.7) ? (r.chance(0.5) ? 2 : 1) : 0));
    P.vox = Array.from({ length: 32 }, () => (r.chance(0.07) ? { d: r.int(0, 4), v: r.int(0, VOWELS.length - 1) } : null));
    P.whistle = r.chance(S.whistle);
    P.voltBar = r.int(0, 3);
    M.P = P;
  }

  // ---------------------------------------------------------------- instruments
  const nz = (t, dur, f, type, q, v, out, att = 0.001) => {
    const s = ac.createBufferSource(); s.buffer = A.noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(out);
    s.start(t, Math.random() * 0.8); s.stop(t + dur + 0.02);
  };
  const osc = (t, dur, f, f2, wave, v, out, att = 0.002) => {
    const o = ac.createOscillator();
    if (waves[wave]) o.setPeriodicWave(waves[wave]); else o.type = wave;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.03);
    return o;
  };

  function kick(t, v) {
    // 808-style boom with a punchy click
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(M.S.dark ? dist : drums); o.start(t); o.stop(t + 0.45);
    nz(t, 0.01, 2500, 'highpass', 0.7, v * 0.3, drums);
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(0.4, t); duck.gain.linearRampToValueAtTime(1, t + 0.2);
  }
  function clap(t, v) {
    for (let k = 0; k < 3; k++) nz(t + k * 0.01, 0.02, 1400, 'bandpass', 1.4, v * 0.32, drums);
    nz(t + 0.03, 0.14, 1500, 'bandpass', 1.2, v * 0.3, drums);
    nz(t + 0.03, 0.14, 1500, 'bandpass', 1.2, v * 0.1, rsend);
  }
  function tom(t, hi, v) {
    // atabaque / tamborzão drum: pitched chip tom
    const f = hi ? 260 : 170;
    osc(t, 0.16, f * 1.6, f, 'triangle', v * 0.32, drums, 0.001);
    nz(t, 0.03, hi ? 1800 : 1100, 'bandpass', 2, v * 0.12, drums);
  }
  const hat = (t, v, open) => nz(t, open ? 0.18 : 0.03, open ? 7000 : 9000, 'highpass', 0.9, v * 0.14, drums);
  function agogo(t, hi) {
    const f = hi === 2 ? 1046 : 784;
    osc(t, 0.14, f, 0, 'square', 0.025, drums);
    osc(t, 0.12, f * 2.76, 0, 'sine', 0.012, dsend);
  }
  function bass(t, n, len) {
    const f = mtof(M.root + n);
    const d = Math.max(0.12, len * M.stepDur * 0.95);
    const out = M.S.bassDist ? dist : duck;
    const o = ac.createOscillator(); o.type = M.S.bassWave;
    o.frequency.setValueAtTime(f * (M.S.dark ? 1 : 1.02), t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 300 + M.intensity * 160 + M.S.bassDist * 300; fl.Q.value = 4;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(M.S.bassWave === 'sine' ? 0.5 : 0.22, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(fl); fl.connect(g); g.connect(out);
    o.start(t); o.stop(t + d + 0.03);
    if (M.S.bassWave === 'sine') { const s2 = ac.createOscillator(); s2.type = 'sine'; s2.frequency.value = f; const g2 = ac.createGain(); g2.gain.setValueAtTime(0.3, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + d); s2.connect(g2); g2.connect(duck); s2.start(t); s2.stop(t + d + 0.03); }
  }
  function lead(t, n, len) {
    const f = mtof(M.root + 12 * M.S.leadOct + 12 + n);
    const d = Math.max(0.09, len * M.stepDur * 0.9);
    const kind = M.S.lead;
    if (kind === 'bell') {
      // eerie detuned bell with tremolo (bruxaria)
      for (const [mul, a] of [[1, 0.06], [2.01, 0.025], [3.98, 0.012]]) {
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul * 0.5;
        const g = ac.createGain(); g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d * 2.5);
        const lfo = ac.createOscillator(); lfo.frequency.value = 7; const lg = ac.createGain(); lg.gain.value = a * 0.6; lfo.connect(lg); lg.connect(g.gain);
        o.connect(g); g.connect(duck); g.connect(rsend); o.start(t); o.stop(t + d * 2.6); lfo.start(t); lfo.stop(t + d * 2.6);
      }
      return;
    }
    const o = ac.createOscillator();
    if (waves[kind]) o.setPeriodicWave(waves[kind]); else o.type = kind === 'tri' ? 'triangle' : 'square';
    o.frequency.value = f;
    const vib = ac.createOscillator(); vib.frequency.value = 5.5; const vg = ac.createGain(); vg.gain.value = f * 0.008; vib.connect(vg); vg.connect(o.frequency);
    const g = ac.createGain();
    const v = kind === 'tri' ? 0.08 : 0.045;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.004); g.gain.setValueAtTime(v * 0.8, t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(duck); g.connect(dsend);
    o.start(t); o.stop(t + d + 0.02); vib.start(t); vib.stop(t + d + 0.02);
  }
  function arp(t, deg) {
    const sc = M.scale;
    const n = M.root + 36 + sc[deg % 7] + 12 * Math.floor(deg / 7);
    osc(t, 0.1, mtof(n), 0, 'pulse25', 0.03, duck);
  }
  function chordNotes(deg) {
    const sc = M.scale, base = M.root + 24;
    return [0, 2, 4].map((k) => { const i = deg + k; return base + sc[i % 7] + 12 * Math.floor(i / 7); });
  }
  function pad(t, deg, dur) {
    const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = M.S.dark ? 500 : 900; fl.Q.value = 1;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(M.S.dark ? 0.035 : 0.03, t + dur * 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    fl.connect(g); g.connect(sweep); g.connect(rsend);
    for (const n of chordNotes(deg)) for (const det of M.S.dark ? [-18, 0, 23] : [-8, 8]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(n); o.detune.value = det;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function voltVox(t) {
    // the classic sci-fi "uuuh" sweep of old Volt Mix funk
    const o = ac.createOscillator(); o.type = 'sawtooth';
    const f = mtof(M.root + 36);
    o.frequency.setValueAtTime(f * 2, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.5);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.09, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    for (const fr of [700, 1100]) { const b = ac.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr; b.Q.value = 6; o.connect(b); b.connect(g); }
    g.connect(duck); g.connect(dsend); o.start(t); o.stop(t + 0.75);
  }
  function chop(t, deg, vw) {
    // chopped vocal "tum" / "ai"
    const n = M.root + 36 + M.scale[deg % 7];
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(mtof(n), t);
    o.frequency.linearRampToValueAtTime(mtof(n) * 0.92, t + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.13, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    for (const f of VOWELS[vw]) { const b = ac.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = 9; o.connect(b); b.connect(g); }
    g.connect(duck); o.start(t); o.stop(t + 0.18);
  }
  function whistle(t) {
    // funk party whistle (apito), chiptune style
    for (let k = 0; k < 2; k++) {
      const tt = t + k * M.stepDur * 2;
      const o = osc(tt, M.stepDur * 1.6, 2600, 2500, 'square', 0.018, duck, 0.003);
      const lfo = ac.createOscillator(); lfo.frequency.value = 30; const lg = ac.createGain(); lg.gain.value = 120; lfo.connect(lg); lg.connect(o.frequency); lfo.start(tt); lfo.stop(tt + M.stepDur * 1.7);
    }
  }
  function swell(t, dur) {
    const s = ac.createBufferSource(); s.buffer = A.noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = 'bandpass'; fl.Q.value = 3; fl.frequency.setValueAtTime(300, t); fl.frequency.exponentialRampToValueAtTime(4000, t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    s.connect(fl); fl.connect(g); g.connect(sweep); s.start(t); s.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- sequencer
  function playStep(t) {
    const P = M.P, s = M.step, I = M.intensity, S = M.S;
    let sec = M.section;
    if (I >= 2 && sec !== 'break') sec = 'full';
    if (I === 0 && sec === 'full' && M.bar % 8 < 2) sec = 'groove';
    const L = LAYERS[sec];
    const sw = s % 2 ? M.swing * M.stepDur : 0;
    const tt = t + sw;
    const chordDeg = P.chord[Math.floor(M.bar / 2) % P.chord.length];
    const kp = M.bar % 4 === 3 ? P.kick2 : P.kick;
    if (L.kick && kp.includes(s)) kick(t, s === 0 ? 1 : 0.85);
    if (L.clap && P.clap.includes(s)) clap(t, s === 4 || s === 12 ? 0.85 : 0.5);
    if (L.clap && S.dark && M.bar % 4 === 3 && s >= 12) clap(t + M.stepDur / 3, 0.35);
    if (L.toms) for (const tm of P.toms) if (tm.st === s && (I > 0 || sec !== 'intro' || s % 2)) tom(tt, tm.hi, 0.8 + I * 0.1);
    if (L.hat) {
      const v = P.hat[s] * L.hat * (0.8 + I * 0.25);
      if (s === P.openHat) hat(tt, 0.8, true);
      else if (Math.random() < v) hat(tt, v, false);
    }
    if (L.perc && S.agogo && P.agogo[s] && Math.random() < S.agogo + I * 0.2) agogo(tt, P.agogo[s]);
    if (L.bass && P.bass[s] !== null) {
      let len = 1;
      while (len < 4 && P.bass[(s + len) % 16] === null && !kp.includes((s + len) % 16)) len++;
      bass(tt, P.bass[s] + (chordDeg ? M.scale[chordDeg % 7] - (chordDeg >= 4 ? 12 : 0) : 0), len);
    }
    if (L.lead && (I > 0 || sec === 'full' || sec === 'break')) { const nt = P.riff[(M.bar % 2) * 16 + s]; if (nt) lead(tt, nt.n, nt.len); }
    if (S.arp && (L.pad || I > 0) && s % 2 === 0) arp(tt, chordDeg + P.arp[(s / 2) % 8]);
    if (L.pad && S.pad && s === 0 && M.bar % 2 === 0) pad(t, chordDeg, M.stepDur * 32);
    if (L.vox && S.voltVox && s === 0 && M.bar % 4 === P.voltBar) voltVox(t);
    if (L.vox && S.chops) { const v = P.vox[(M.bar % 2) * 16 + s]; if (v) chop(tt, v.d, v.v); }
    if (S.dark && s === 8 && M.bar % 8 === 7) swell(t, M.stepDur * 8);
    if (P.whistle && L.perc && s === 12 && M.bar % 4 === 1 && (I > 0 || sec === 'full')) whistle(tt);
    if (I >= 2 && s % 4 === 2 && !S.arp) arp(tt, chordDeg + [0, 4, 7, 4][(s / 4) | 0]);
  }

  function advance() {
    M.step++;
    if (M.step >= 16) {
      M.step = 0; M.bar++;
      if (M.pending) {
        const p = M.pending; M.pending = null;
        M.style = p.style; M.S = STYLES[p.style] || STYLES.volt; M.seed = p.seed;
        M.cycle = 0; M.bar = 0; M.section = 'groove';
        roll(M.seed);
        const t = M.nextTime;
        sweep.frequency.cancelScheduledValues(t);
        sweep.frequency.setValueAtTime(500, t);
        sweep.frequency.exponentialRampToValueAtTime(18000, t + M.stepDur * 16);
        return;
      }
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
    if (!M.P) roll(M.seed);
    M.nextTime = ac.currentTime + 0.1;
    bus.gain.cancelScheduledValues(ac.currentTime);
    bus.gain.setValueAtTime(0, ac.currentTime);
    bus.gain.linearRampToValueAtTime(0.75, ac.currentTime + 2.5);
    M.timer = setInterval(tick, 25);
  };
  M.stop = () => {
    if (!M.playing) return;
    M.playing = false;
    clearInterval(M.timer);
    bus.gain.setTargetAtTime(0, ac.currentTime, 0.3);
  };
  M.setIntensity = (v) => { M.target = v; };
  // Switch to another district's track: DJ filter sweep now, new track on the next bar.
  M.setTrack = (style, s) => {
    if (M.style === style && M.seed === s && !M.pending) return;
    if (M.pending && M.pending.style === style && M.pending.seed === s) return;
    M.pending = { style, seed: s };
    if (!M.playing) { M.style = style; M.S = STYLES[style] || STYLES.volt; M.seed = s; M.cycle = 0; M.P = null; M.pending = null; return; }
    const t = ac.currentTime;
    sweep.frequency.cancelScheduledValues(t);
    sweep.frequency.setValueAtTime(sweep.frequency.value, t);
    sweep.frequency.exponentialRampToValueAtTime(500, t + Math.max(0.15, (16 - M.step) * M.stepDur));
  };
  M.reseed = (s) => { M.seed = s; M.cycle = 0; M.bar = 0; M.step = 0; M.section = 'intro'; roll(s); };
  M.styleName = () => ({ volt: 'Funk Volt Mix', bruxaria: 'Funk Bruxaria', melody: 'Funk Melody', f150: 'Funk 150' }[M.pending ? M.pending.style : M.style]);
  return M;
}

function pulseWave(ac, duty) {
  const n = 64, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) * 0.9;
  return ac.createPeriodicWave(re, im);
}
function stepCurve(levels) {
  const c = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.round(x * levels) / levels; }
  return c;
}
function driveCurve(k) {
  const c = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
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
