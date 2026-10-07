export function movementFor(key, angle) {
  const direction = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  if (!direction) return null;
  const [x, z] = direction;
  const dx = x * Math.cos(angle) + z * Math.sin(angle);
  const dz = -x * Math.sin(angle) + z * Math.cos(angle);
  return Math.abs(dx) > Math.abs(dz) ? { dx: Math.sign(dx), dz: 0 } : { dx: 0, dz: Math.sign(dz) };
}

export function bindHouseControls(panel, { ready, angle, send, error }) {
  let key = null, busy = false;
  const editable = (target) => target?.closest('input, textarea, select, [contenteditable="true"]');
  const clear = () => { key = null; };
  const submit = async (body) => {
    if (busy) return;
    busy = true;
    try { await send(body); } catch (e) { clear(); error(e.message); } finally { busy = false; }
  };
  panel.addEventListener('keydown', (e) => {
    if (!ready() || editable(e.target)) return;
    if (movementFor(e.key, angle())) {
      e.preventDefault(); key = e.key;
      if (!e.repeat) submit({ action: 'move', ...movementFor(key, angle()) });
    } else if (e.code === 'KeyE' && !e.repeat) {
      e.preventDefault(); clear(); submit({ action: 'interact' });
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === key) clear(); });
  window.addEventListener('blur', clear);
  panel.addEventListener('focusin', (e) => { if (editable(e.target)) clear(); });
  document.addEventListener('visibilitychange', clear);
  setInterval(() => {
    if (!ready() || document.hidden || editable(document.activeElement)) return clear();
    if (key) submit({ action: 'move', ...movementFor(key, angle()) });
  }, 180);
  return clear;
}
