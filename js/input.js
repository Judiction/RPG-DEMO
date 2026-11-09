// Keyboard + mouse. Exposes the current state and a queue of key presses.

export function createInput(canvas) {
  const I = {
    keys: new Set(), pressed: [], mouse: { x: 0, y: 0, L: false, R: false }, enabled: true, typing: false,
  };
  const block = (e) => ['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code);
  window.addEventListener('keydown', (e) => {
    if (I.typing) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (block(e)) e.preventDefault();
    if (!e.repeat) I.pressed.push(e.code);
    I.keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => I.keys.delete(e.code));
  window.addEventListener('blur', () => { I.keys.clear(); I.mouse.L = I.mouse.R = false; });
  canvas.addEventListener('mousemove', (e) => { I.mouse.x = e.clientX; I.mouse.y = e.clientY; });
  window.addEventListener('mousemove', (e) => { I.mouse.x = e.clientX; I.mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) I.mouse.L = true;
    if (e.button === 2) I.mouse.R = true;
    e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) I.mouse.L = false;
    if (e.button === 2) I.mouse.R = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  I.axis = () => {
    if (!I.enabled || I.typing) return { x: 0, y: 0 };
    const k = I.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
    return { x, y };
  };
  I.take = () => { const p = I.pressed; I.pressed = []; return p; };
  return I;
}
