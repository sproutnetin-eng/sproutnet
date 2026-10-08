// Full thumbnail editor for problem uploads (no dependencies).
// Cards across the site render thumbnails in a fixed 16:9 frame, so after a
// poster picks any photo a popup editor opens: drag-crop, zoom, rotate,
// flip, text overlays (click and drag to move), freehand drawing,
// undo/redo and download. Nothing is applied automatically — the upload uses
// only what the poster confirms with "Crop & use" (output: 1280x720 JPEG).
//
// Usage:
//   import { initThumbCrop } from '/assets/thumb-crop.js';
//   const crop = initThumbCrop({ input: fileInputEl, mount: previewEl, onError: (m) => ... });
//   if (crop.isEditing()) throw new Error('Confirm your edit first.');
//   const file = await crop.getFile(); // confirmed File, or null
import { esc } from '/assets/app.js';

const MAX_BYTES = 5 * 1024 * 1024;
const OUT_W = 1280;
const OUT_H = 720;
const PV_W = 800;
const PV_H = 450;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const HIST_MAX = 30;

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.textContent = `
  .tc-overlay{position:fixed;inset:0;background:rgba(28,20,16,.55);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;box-sizing:border-box}
  .tc-modal{width:min(620px,94vw);max-height:92vh;overflow:auto;background:#fff;border-radius:16px;padding:20px;box-sizing:border-box;box-shadow:0 20px 60px rgba(28,20,16,.3)}
  .tc-title{font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;color:#1C1410;margin:0 0 4px}
  .tc-sub{font-size:12px;color:#6A5F58;margin:0 0 12px}
  .tc-canvas{width:100%;aspect-ratio:16/9;display:block;border-radius:8px;background:#1C1410;touch-action:none;cursor:grab;user-select:none}
  .tc-canvas.draw{cursor:crosshair}
  .tc-sec{margin:12px 0 0}
  .tc-sec>span{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6A5F58;margin-bottom:6px}
  .tc-slider{display:flex;align-items:center;gap:10px;font-size:12px;color:#4A3F38;margin:4px 0}
  .tc-slider input{flex:1;accent-color:#2D6A4F}
  .tc-slider output{min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
  .tc-tools{display:flex;gap:8px;flex-wrap:wrap}
  .tc-btn{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid rgba(28,20,16,.12);background:#fff;color:#1C1410}
  .tc-btn:disabled{opacity:.4;cursor:default}
  .tc-btn.primary{background:#F4A723;border:none;box-shadow:0 2px 10px rgba(244,167,35,.3)}
  .tc-btn.on{background:#2D6A4F;border-color:#2D6A4F;color:#fff}
  .tc-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}
  .tc-textrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .tc-textrow input[type=text]{flex:1;min-width:140px;font-family:'DM Sans',sans-serif;font-size:13px;padding:8px 10px;border:1.5px solid rgba(28,20,16,.12);border-radius:8px;background:#FAF8F4;color:#1C1410}
  .tc-textrow input[type=color]{width:38px;height:34px;padding:2px;border:1.5px solid rgba(28,20,16,.12);border-radius:8px;background:#fff;cursor:pointer}
  .tc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .tc-chips:empty{display:none}
  .tc-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;background:#FAF8F4;border:1px solid rgba(28,20,16,.12);border-radius:999px;padding:4px 6px 4px 12px;color:#1C1410;max-width:100%}
  .tc-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
  .tc-chip button{border:none;background:#fff;border:1px solid rgba(28,20,16,.12);border-radius:999px;width:20px;height:20px;font-size:11px;line-height:1;cursor:pointer;color:#1C1410}
  .tc-final{border-radius:8px;overflow:hidden;background:#F3EEE7}
  .tc-final img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
  .tc-final .bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;flex-wrap:wrap;background:#FAF8F4}
  .tc-final .bar span{font-size:12px;color:#4A3F38}
  .tc-box{display:grid;gap:10px}
  .tc-note{font-size:12px;color:#6A5F58}`;
  document.head.appendChild(s);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image. Try another file.'));
    img.src = src;
  });
}

export function initThumbCrop({ input, mount, onError, initialUrl = '', initialName = 'Current thumbnail' }) {
  injectCss();
  const fail = (m) => { if (typeof onError === 'function') onError(m); };

  // Editor state (one undo entry = one snapshot of this).
  const freshState = () => ({
    rot: 0, flipH: false, flipV: false,
    zoom: 1, dx: 0, dy: 0,
    drawMode: false, drawColor: '#F4A723', drawW: 4,
    texts: [], // {text,x,y,size,color} — x,y,size relative to canvas
    strokes: [], // {color,w,pts:[[rx,ry],...]} — w relative to canvas width
  });
  let S = freshState();
  let undoStack = [];
  let redoStack = [];

  let img = null; // source Image
  let base = null; // source with rotation + flip baked in
  let cover = 1;
  let fileName = '';
  let objectUrl = '';
  let overlay = null;
  let croppedFile = null;
  let croppedUrl = '';
  let passthroughFile = null; // GIFs upload as-is (canvas can't keep animation)
  let removed = false;
  let drag = null; // {mode:'pan'|'draw'|'text', ...}

  const snap = () => JSON.parse(JSON.stringify({ ...S, drawMode: false }));
  function commit() {
    undoStack.push(snap());
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack = [];
    syncHistoryButtons();
  }
  function restore(state) {
    const dm = S.drawMode;
    S = { ...JSON.parse(JSON.stringify(state)), drawMode: dm };
    rebuildBase();
    syncControls();
    redraw();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restore(undoStack.pop());
    syncHistoryButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restore(redoStack.pop());
    syncHistoryButtons();
  }
  function syncHistoryButtons() {
    if (!overlay) return;
    overlay.querySelector('[data-act="undo"]').disabled = !undoStack.length;
    overlay.querySelector('[data-act="redo"]').disabled = !redoStack.length;
  }

  // Bake rotation + flip into an offscreen canvas; all crop math uses this.
  function rebuildBase() {
    const swap = S.rot % 180 !== 0;
    const rw = swap ? img.naturalHeight : img.naturalWidth;
    const rh = swap ? img.naturalWidth : img.naturalHeight;
    base = document.createElement('canvas');
    base.width = rw; base.height = rh;
    const ctx = base.getContext('2d');
    ctx.fillStyle = '#F3EEE7';
    ctx.fillRect(0, 0, rw, rh);
    ctx.translate(rw / 2, rh / 2);
    ctx.rotate((S.rot * Math.PI) / 180);
    ctx.scale(S.flipH ? -1 : 1, S.flipV ? -1 : 1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    cover = Math.max(PV_W / rw, PV_H / rh);
  }

  // Source rect in base-image pixels for a W×H view (clamps pan).
  function srcRect(W, H) {
    const dw = base.width * cover * S.zoom;
    const dh = base.height * cover * S.zoom;
    S.dx = Math.min(0, Math.max(W - dw, S.dx));
    S.dy = Math.min(0, Math.max(H - dh, S.dy));
    return {
      sx: -S.dx / (cover * S.zoom),
      sy: -S.dy / (cover * S.zoom),
      sw: W / (cover * S.zoom),
      sh: H / (cover * S.zoom),
    };
  }

  // Paint the full scene (photo + drawings + text) onto any 16:9 canvas.
  function paint(ctx, W, H) {
    const { sx, sy, sw, sh } = srcRect(W, H);
    const rx = Math.max(0, Math.min(base.width - 1, sx));
    const ry = Math.max(0, Math.min(base.height - 1, sy));
    const rw = Math.max(1, Math.min(base.width - rx, sw));
    const rh = Math.max(1, Math.min(base.height - ry, sh));
    ctx.drawImage(base, rx, ry, rw, rh, 0, 0, W, H);
    // Drawings.
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of S.strokes) {
      if (s.pts.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.w * W);
      ctx.beginPath();
      ctx.moveTo(s.pts[0][0] * W, s.pts[0][1] * H);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0] * W, s.pts[i][1] * H);
      ctx.stroke();
    }
    ctx.restore();
    // Text overlays.
    for (const t of S.texts) {
      const px = t.size * H;
      ctx.save();
      ctx.font = `600 ${px}px 'DM Sans',sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(1, px * 0.08);
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.fillStyle = t.color;
      ctx.strokeText(t.text, t.x * W, t.y * H);
      ctx.fillText(t.text, t.x * W, t.y * H);
      ctx.restore();
    }
  }

  function drawGrid(ctx, W, H) {
    const thirds = (style, width) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo((W * i) / 3 + 0.5, 0);
        ctx.lineTo((W * i) / 3 + 0.5, H);
        ctx.moveTo(0, (H * i) / 3 + 0.5);
        ctx.lineTo(W, (H * i) / 3 + 0.5);
      }
      ctx.stroke();
    };
    thirds('rgba(0,0,0,0.35)', 3);
    thirds('rgba(255,255,255,0.8)', 1);
  }

  function redraw() {
    const canvas = overlay && overlay.querySelector('.tc-canvas');
    if (!canvas || !base) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1C1410';
    ctx.fillRect(0, 0, PV_W, PV_H);
    paint(ctx, PV_W, PV_H);
    drawGrid(ctx, PV_W, PV_H);
  }

  function closePopup() {
    if (overlay) { overlay.remove(); overlay = null; }
    drag = null;
  }
  const isOpen = () => !!overlay;

  function syncControls() {
    if (!overlay) return;
    overlay.querySelector('.tc-zoom').value = String(S.zoom);
    overlay.querySelector('.tc-zoomv').textContent = `${Math.round(S.zoom * 100)}%`;
    overlay.querySelector('[data-act="draw"]').classList.toggle('on', S.drawMode);
    overlay.querySelector('.tc-canvas').classList.toggle('draw', S.drawMode);
    renderChips();
  }

  function renderChips() {
    if (!overlay) return;
    const box = overlay.querySelector('.tc-chips');
    box.innerHTML = S.texts.map((t, i) =>
      `<span class="tc-chip"><span>${esc(t.text)}</span><button type="button" data-rm="${i}" aria-label="Remove text">✕</button></span>`).join('');
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      commit();
      S.texts.splice(Number(b.dataset.rm), 1);
      renderChips(); redraw();
    }));
  }

  function hitText(rx, ry) {
    const canvas = overlay.querySelector('.tc-canvas');
    const ctx = canvas.getContext('2d');
    for (let i = S.texts.length - 1; i >= 0; i--) {
      const t = S.texts[i];
      const px = t.size * PV_H;
      ctx.font = `600 ${px}px 'DM Sans',sans-serif`;
      const w = ctx.measureText(t.text).width;
      if (Math.abs(rx * PV_W - t.x * PV_W) <= w / 2 + 6 &&
          Math.abs(ry * PV_H - t.y * PV_H) <= px * 0.6 + 6) return i;
    }
    return -1;
  }

  function relPos(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  }

  function openPopup() {
    closePopup();
    overlay = document.createElement('div');
    overlay.className = 'tc-overlay';
    overlay.innerHTML = `<div class="tc-modal" role="dialog" aria-label="Edit thumbnail">
      <p class="tc-title">Edit thumbnail</p>
      <p class="tc-sub">Cards show a fixed 16:9 frame. Drag to reposition, or use the tools below — then Crop &amp; use.</p>
      <canvas class="tc-canvas" width="${PV_W}" height="${PV_H}"></canvas>
      <div class="tc-sec"><span>Zoom</span>
        <label class="tc-slider">Zoom <input type="range" class="tc-zoom" min="1" max="3" step="0.01" value="1"><output class="tc-zoomv">100%</output></label>
      </div>
      <div class="tc-sec"><span>Rotate &amp; flip</span>
        <div class="tc-tools">
          <button type="button" class="tc-btn" data-act="rotl" title="Rotate left 90°">⟲ 90°</button>
          <button type="button" class="tc-btn" data-act="rotr" title="Rotate right 90°">90° ⟳</button>
          <button type="button" class="tc-btn" data-act="fliph">⇋ Flip</button>
          <button type="button" class="tc-btn" data-act="flipv">⇅ Flip</button>
          <button type="button" class="tc-btn" data-act="reset">Reset photo</button>
        </div>
      </div>
      <div class="tc-sec"><span>Text</span>
        <div class="tc-textrow">
          <input type="text" class="tc-textin" placeholder="Write something…" maxlength="60">
          <input type="color" class="tc-textcolor" value="#ffffff" title="Text colour">
          <button type="button" class="tc-btn" data-act="addtext">Add text</button>
        </div>
        <div class="tc-note" style="margin-top:6px">Click the text on the photo and drag it to move. Remove it below.</div>
        <div class="tc-chips"></div>
      </div>
      <div class="tc-sec"><span>Draw</span>
        <div class="tc-textrow">
          <button type="button" class="tc-btn" data-act="draw">✏️ Pen: off</button>
          <input type="color" class="tc-drawcolor" value="#F4A723" title="Pen colour">
          <button type="button" class="tc-btn" data-act="clearstrokes">Clear drawing</button>
        </div>
      </div>
      <div class="tc-actions">
        <button type="button" class="tc-btn" data-act="undo">↩ Undo</button>
        <button type="button" class="tc-btn" data-act="redo">↪ Redo</button>
        <button type="button" class="tc-btn" data-act="download">⤓ Download</button>
        <button type="button" class="tc-btn" data-act="cancel">Cancel</button>
        <button type="button" class="tc-btn primary" data-act="crop">Crop &amp; use</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const canvas = overlay.querySelector('.tc-canvas');

    // Pointer: pan image, drag text, or draw — depending on mode/hit.
    const toPreview = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { dx: PV_W / rect.width, x: e.clientX, y: e.clientY };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const [rx, ry] = relPos(e, canvas);
      if (S.drawMode) {
        commit();
        S.strokes.push({ color: overlay.querySelector('.tc-drawcolor').value, w: S.drawW / PV_W, pts: [[rx, ry]] });
        drag = { mode: 'draw' };
      } else {
        const i = hitText(rx, ry);
        if (i >= 0) {
          commit();
          drag = { mode: 'text', i };
        } else {
          const k = toPreview(e);
          drag = { mode: 'pan', lx: k.x, ly: k.y, k: k.dx };
        }
      }
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) {
        // Hover feedback so added text is visibly grabbable.
        if (!S.drawMode && S.texts.length) {
          const [hx, hy] = relPos(e, canvas);
          canvas.style.cursor = hitText(hx, hy) >= 0 ? 'move' : '';
        } else if (!S.drawMode) {
          canvas.style.cursor = '';
        }
        return;
      }
      if (drag.mode === 'draw') {
        const [rx, ry] = relPos(e, canvas);
        S.strokes[S.strokes.length - 1].pts.push([rx, ry]);
      } else if (drag.mode === 'text') {
        const [rx, ry] = relPos(e, canvas);
        S.texts[drag.i].x = Math.min(1, Math.max(0, rx));
        S.texts[drag.i].y = Math.min(1, Math.max(0, ry));
      } else {
        S.dx += (e.clientX - drag.lx) * drag.k;
        S.dy += (e.clientY - drag.ly) * drag.k;
        drag.lx = e.clientX; drag.ly = e.clientY;
      }
      redraw();
    });
    ['pointerup', 'pointercancel'].forEach((ev) => canvas.addEventListener(ev, () => { drag = null; }));

    const sliderSnap = new Map();
    const trackSlider = (sel) => {
      const el = overlay.querySelector(sel);
      el.addEventListener('pointerdown', () => sliderSnap.set(sel, snap()));
      el.addEventListener('focus', () => { if (!sliderSnap.has(sel)) sliderSnap.set(sel, snap()); });
      el.addEventListener('change', () => {
        const prev = sliderSnap.get(sel);
        sliderSnap.delete(sel);
        if (prev) {
          undoStack.push(prev);
          if (undoStack.length > HIST_MAX) undoStack.shift();
          redoStack = [];
          syncHistoryButtons();
        }
      });
    };
    const live = (sel, fn) => overlay.querySelector(sel).addEventListener('input', (e) => { fn(Number(e.target.value)); redraw(); });
    const committed = (sel, fn) => overlay.querySelector(sel).addEventListener('change', (e) => { fn(Number(e.target.value)); syncControls(); redraw(); });
    trackSlider('.tc-zoom');
    live('.tc-zoom', (v) => { S.zoom = v; overlay.querySelector('.tc-zoomv').textContent = `${Math.round(v * 100)}%`; });
    committed('.tc-zoom', (v) => { S.zoom = v; });

    const act = (name, fn) => overlay.querySelector(`[data-act="${name}"]`).addEventListener('click', fn);
    act('rotl', () => { commit(); S.rot = (S.rot + 270) % 360; S.dx = 0; S.dy = 0; rebuildBase(); redraw(); });
    act('rotr', () => { commit(); S.rot = (S.rot + 90) % 360; S.dx = 0; S.dy = 0; rebuildBase(); redraw(); });
    act('fliph', () => { commit(); S.flipH = !S.flipH; rebuildBase(); redraw(); });
    act('flipv', () => { commit(); S.flipV = !S.flipV; rebuildBase(); redraw(); });
    act('reset', () => {
      commit();
      const keep = { texts: S.texts, strokes: S.strokes };
      S = { ...freshState(), texts: keep.texts, strokes: keep.strokes };
      rebuildBase(); syncControls(); redraw();
    });
    act('addtext', () => {
      const inp = overlay.querySelector('.tc-textin');
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      commit();
      S.texts.push({ text: v, x: 0.5, y: 0.5, size: 0.07, color: overlay.querySelector('.tc-textcolor').value });
      inp.value = '';
      renderChips(); redraw();
    });
    act('draw', () => {
      S.drawMode = !S.drawMode;
      const b = overlay.querySelector('[data-act="draw"]');
      b.classList.toggle('on', S.drawMode);
      b.textContent = S.drawMode ? '✏️ Pen: on' : '✏️ Pen: off';
      canvas.classList.toggle('draw', S.drawMode);
    });
    act('clearstrokes', () => {
      if (!S.strokes.length) return;
      commit();
      S.strokes = [];
      redraw();
    });
    act('undo', undo);
    act('redo', redo);
    act('download', () => {
      const out = document.createElement('canvas');
      out.width = OUT_W; out.height = OUT_H;
      paint(out.getContext('2d'), OUT_W, OUT_H);
      out.toBlob((blob) => {
        if (!blob) { fail('Could not export that image.'); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'thumbnail-16x9.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }, 'image/jpeg', 0.9);
    });
    act('cancel', () => {
      input.value = '';
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
      img = null; base = null;
      S = freshState(); undoStack = []; redoStack = [];
      closePopup();
    });
    act('crop', () => void confirmCrop());

    rebuildBase();
    syncControls();
    syncHistoryButtons();
    redraw();
  }

  function cleanupObjectUrl() {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
  }

  function renderOutputCanvas() {
    const out = document.createElement('canvas');
    out.width = OUT_W; out.height = OUT_H;
    paint(out.getContext('2d'), OUT_W, OUT_H);
    return out;
  }

  function buildCroppedFile() {
    return new Promise((resolve, reject) => {
      if (!base) return reject(new Error('No image to crop.'));
      renderOutputCanvas().toBlob((blob) => {
        if (!blob) return reject(new Error('Could not crop that image.'));
        const baseName = (fileName.split('.').slice(0, -1).join('.') || 'thumbnail')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'thumbnail';
        resolve(new File([blob], `${baseName}-16x9.jpg`, { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.87);
    });
  }

  async function confirmCrop() {
    try {
      const file = await buildCroppedFile();
      croppedFile = file; passthroughFile = null;
      if (croppedUrl) URL.revokeObjectURL(croppedUrl);
      croppedUrl = URL.createObjectURL(file);
      removed = false;
      closePopup();
      renderDone(croppedUrl, file.name);
    } catch (err) {
      fail(err.message || 'Could not crop that image.');
    }
  }

  function renderDone(url, name) {
    mount.innerHTML = `<div class="tc-box"><div class="tc-final">
      <img src="${esc(url)}" alt="Thumbnail preview">
      <div class="bar"><span>${esc(name)}</span>
        <span style="display:flex;gap:8px">
          <button type="button" class="tc-btn" data-act="change">Change</button>
          <button type="button" class="tc-btn" data-act="remove">Remove</button>
        </span>
      </div></div>
      <div class="tc-note">Edited 16:9 (1280×720) — every problem card stays the same size.</div>
    </div>`;
    mount.querySelector('[data-act="change"]').addEventListener('click', () => input.click());
    mount.querySelector('[data-act="remove"]').addEventListener('click', () => {
      input.value = ''; cleanupObjectUrl();
      croppedFile = null; passthroughFile = null;
      if (croppedUrl) { URL.revokeObjectURL(croppedUrl); croppedUrl = ''; }
      removed = true; img = null; base = null;
      renderIdle();
    });
  }

  function renderIdle() {
    if (initialUrl && !removed) {
      renderDone(initialUrl, initialName);
      return;
    }
    mount.innerHTML = '';
  }

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      fail('Use a JPG, PNG, WebP, or GIF image for the thumbnail.');
      input.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      fail('Thumbnail must be 5 MB or smaller.');
      input.value = '';
      return;
    }
    removed = false; croppedFile = null;
    if (croppedUrl) { URL.revokeObjectURL(croppedUrl); croppedUrl = ''; }
    // Canvas can't preserve GIF animation — upload GIFs untouched.
    if (file.type === 'image/gif') {
      passthroughFile = file;
      renderDone(URL.createObjectURL(file), file.name);
      return;
    }
    passthroughFile = null;
    fileName = file.name;
    S = freshState(); undoStack = []; redoStack = [];
    cleanupObjectUrl();
    objectUrl = URL.createObjectURL(file);
    try {
      img = await loadImage(objectUrl);
      openPopup();
    } catch (err) {
      fail(err.message);
      input.value = ''; cleanupObjectUrl(); img = null;
    }
  });

  renderIdle();

  return {
    // Returns the confirmed edit (or untouched GIF), or null when nothing new.
    // Never auto-applies — if the popup is still open the poster must press
    // "Crop & use" (or Cancel) first; use isEditing() to enforce that.
    async getFile() {
      if (croppedFile) return croppedFile;
      if (passthroughFile) return passthroughFile;
      return null;
    },
    isEditing() { return isOpen(); },
    isRemoved() { return removed && !croppedFile && !passthroughFile; },
    clear() {
      input.value = ''; cleanupObjectUrl(); closePopup();
      if (croppedUrl) URL.revokeObjectURL(croppedUrl);
      croppedFile = null; passthroughFile = null; img = null; base = null; removed = false;
      S = freshState(); undoStack = []; redoStack = [];
      renderIdle();
    },
  };
}
