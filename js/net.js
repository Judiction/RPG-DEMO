// Online play via PeerJS (WebRTC, browser to browser).
// PeerJS's free public server only introduces the browsers; game data then flows directly
// between the host and each friend. The host's peer id is derived from the room code.

const PREFIX = 'neonquebrada-rpg-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TIMEOUT = 12000;
const PART = 14000;

export const PROTOCOL = 3;

export function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return c;
}

export const cleanCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

export function send(conn, msg) {
  if (!conn || !conn.open) return;
  const text = JSON.stringify(msg);
  if (text.length <= PART) { conn.send(text); return; }
  const n = Math.ceil(text.length / PART);
  const id = (Math.random() * 1e9) | 0;
  for (let i = 0; i < n; i++) conn.send(JSON.stringify({ t: '_part', id, i, n, d: text.slice(i * PART, (i + 1) * PART) }));
}

// Wraps a data handler: parses JSON and reassembles split messages.
export function receiver(handler) {
  const parts = new Map();
  return (raw) => {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (msg && msg.t === '_part') {
      let p = parts.get(msg.id);
      if (!p) { p = []; parts.set(msg.id, p); }
      p[msg.i] = msg.d;
      if (p.filter((x) => x !== undefined).length === msg.n) {
        parts.delete(msg.id);
        try { handler(JSON.parse(p.join(''))); } catch (e) { console.error(e); }
      }
      return;
    }
    handler(msg);
  };
}

function needPeer() {
  if (typeof window.Peer !== 'function') throw Object.assign(new Error('PeerJS failed to load (are you offline?)'), { type: 'no-peerjs' });
}

const PEER_OPTS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };

export function hostRoom(code) {
  needPeer();
  return new Promise((resolve, reject) => {
    const peer = new window.Peer(PREFIX + code, PEER_OPTS);
    const timer = setTimeout(() => { peer.destroy(); reject(Object.assign(new Error('timeout'), { type: 'timeout' })); }, TIMEOUT);
    peer.on('open', () => { clearTimeout(timer); resolve(peer); });
    peer.on('error', (err) => { clearTimeout(timer); peer.destroy(); reject(err); });
  });
}

export function joinRoom(code) {
  needPeer();
  return new Promise((resolve, reject) => {
    const peer = new window.Peer(PEER_OPTS);
    let done = false;
    const fail = (err) => { if (done) return; done = true; clearTimeout(timer); peer.destroy(); reject(err); };
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'timeout' })), TIMEOUT);
    peer.on('error', fail);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
      conn.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve({ peer, conn }); });
      conn.on('error', fail);
    });
  });
}

export function errorText(err) {
  const t = err && err.type;
  if (t === 'peer-unavailable') return 'Room not found. Check the code (the host must keep their tab open).';
  if (t === 'unavailable-id') return 'That room code is taken. Try hosting again.';
  if (t === 'timeout') return 'Connection timed out. Check your internet and try again.';
  if (t === 'no-peerjs') return 'Online play library failed to load. Check your connection.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking server.';
  if (t === 'browser-incompatible') return 'Your browser does not support online play (WebRTC).';
  return (err && err.message) || 'Connection failed.';
}
