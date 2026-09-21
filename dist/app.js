import { clamp, boundsOf, hasTransparency, selectConnected, detectComponents, removeCornerBackground, safeName, createExportPlan, makeZip } from './core.mjs';

const $ = id => document.getElementById(id);
const image = $('source-image'), overlay = $('overlay'), stage = $('stage');
const source = document.createElement('canvas'), sourceCtx = source.getContext('2d', { willReadFrequently: true });
const state = { assets: [], selected: null, mode: 'rect', zoom: 1, fit: true, points: [], drag: null, undo: [], redo: [], pixels: null, alpha: false, busy: false, nextId: 1, filename: '', dirty: false };
const cache = new WeakMap();
let toastTimer, loadSequence = 0;
const current = () => state.assets.find(a => a.id === state.selected);
const snapshot = () => ({ assets: state.assets.map(a => ({ ...a, points: a.points?.map(p => ({ ...p })) })), selected: state.selected });
function checkpoint() { state.undo.push(snapshot()); if (state.undo.length > 35) state.undo.shift(); state.redo = []; state.dirty = true; }
function restore(from, to) { if (!from.length || state.busy) return; to.push(snapshot()); Object.assign(state, from.pop()); state.points = []; state.drag = null; render(); }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
function busy(value, message = 'Analisando a imagem…') { state.busy = value; $('loading').hidden = !value; $('loading').textContent = message; $('upload').disabled = value; $('example').disabled = value; $('download').disabled = value; $('detect').disabled = value || !state.pixels; renderCounts(); }
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
function setZoom(value, fitted = false) {
  if (!image.naturalWidth) return;
  state.zoom = clamp(value, .02, 6); state.fit = fitted;
  $('image-wrap').style.width = `${source.width * state.zoom}px`;
  $('image-wrap').style.height = `${source.height * state.zoom}px`;
  overlay.setAttribute('viewBox', `0 0 ${source.width} ${source.height}`);
  $('zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  renderOverlay();
}
function fit() { if (source.width) setZoom(Math.min((stage.clientWidth - 56) / source.width, (stage.clientHeight - 56) / source.height, 1), true); }
function setMode(mode) {
  if (state.points.length && mode !== 'polygon') { state.points = []; toast('Contorno não concluído descartado.'); }
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('mode-help').textContent = {
    select: 'Clique em um asset para mover. Arraste os cantos ou os pontos para refinar.',
    rect: 'Arraste sobre uma peça para recortar. Depois, ajuste as bordas.',
    polygon: 'Clique ao redor da peça. Enter ou clique no primeiro ponto para concluir. Esc cancela.',
    wand: 'Clique na peça. A varinha seleciona uma região conectada; revise o resultado na prévia.'
  }[mode];
  $('wand-controls').hidden = mode !== 'wand';
  overlay.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  renderOverlay();
}
function renderCounts() {
  const count = state.assets.filter(a => a.included).length;
  $('asset-count').textContent = state.assets.length;
  $('export-count').textContent = count;
  $('png-count').textContent = count;
  $('export-all').disabled = !count || state.busy;
  $('export-pngs').disabled = !count || state.busy;
  $('batch-selection').hidden = !state.assets.length;
  $('selected-count').textContent = `${count} de ${state.assets.length} selecionados`;
  $('select-all').checked = count > 0 && count === state.assets.length;
  $('select-all').indeterminate = count > 0 && count < state.assets.length;
  $('select-all').disabled = state.busy;
  document.querySelectorAll('.asset-card input[type="checkbox"]').forEach(box => { box.disabled = state.busy; });
  $('undo').disabled = !state.undo.length || state.busy;
  $('redo').disabled = !state.redo.length || state.busy;
  $('empty-list').hidden = state.assets.length > 0;
}
function assetCanvas(asset) {
  if (cache.has(asset)) return cache.get(asset);
  const cut = document.createElement('canvas'); cut.width = asset.w; cut.height = asset.h;
  const ctx = cut.getContext('2d', { willReadFrequently: true });
  if (asset.type === 'polygon') {
    ctx.beginPath(); asset.points.forEach((p, i) => i ? ctx.lineTo(p.x - asset.x, p.y - asset.y) : ctx.moveTo(p.x - asset.x, p.y - asset.y)); ctx.closePath(); ctx.clip();
  } else if (asset.type === 'mask') {
    ctx.beginPath();
    for (let i = 0; i < asset.runs.length; i += 3) ctx.rect(asset.runs[i + 1], asset.runs[i], asset.runs[i + 2], 1);
    ctx.clip();
  }
  ctx.drawImage(source, asset.x, asset.y, asset.w, asset.h, 0, 0, asset.w, asset.h);
  if (asset.removeBg) {
    const pixels = ctx.getImageData(0, 0, cut.width, cut.height);
    removeCornerBackground(pixels.data, cut.width, cut.height, asset.bgTolerance);
    ctx.putImageData(pixels, 0, 0);
  }
  const output = document.createElement('canvas'); output.width = asset.w + asset.padding * 2; output.height = asset.h + asset.padding * 2;
  output.getContext('2d').drawImage(cut, asset.padding, asset.padding);
  // Bound cached canvases: big exports are generated on demand, not retained per undo entry.
  if (output.width * output.height < 1500000) cache.set(asset, output);
  return output;
}
function thumbnail(asset) {
  const output = assetCanvas(asset), thumb = document.createElement('canvas');
  const ratio = Math.min(92 / output.width, 92 / output.height, 1);
  thumb.width = Math.max(1, Math.round(output.width * ratio)); thumb.height = Math.max(1, Math.round(output.height * ratio));
  thumb.getContext('2d').drawImage(output, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/png');
}
function renderList() {
  const fragment = document.createDocumentFragment();
  for (const asset of state.assets) {
    const row = document.createElement('div'); row.className = `asset-card${asset.id === state.selected ? ' active' : ''}`;
    row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `Selecionar ${asset.name}`); row.setAttribute('aria-pressed', String(asset.id === state.selected));
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = asset.included; box.setAttribute('aria-label', `Exportar ${asset.name}`);
    box.onclick = e => e.stopPropagation(); box.onchange = () => { checkpoint(); state.assets = state.assets.map(a => a.id === asset.id ? { ...a, included: box.checked } : a); renderCounts(); };
    const img = document.createElement('img'); img.src = thumbnail(asset); img.alt = '';
    const info = document.createElement('div'); info.className = 'asset-info';
    const name = document.createElement('strong'); name.textContent = asset.name;
    const meta = document.createElement('small'); meta.textContent = `${asset.w} × ${asset.h} px · ${asset.type === 'rect' ? 'retângulo' : asset.type === 'polygon' ? 'contorno' : 'seleção'}`;
    info.append(name, meta); row.append(box, img, info);
    const select = () => { state.selected = asset.id; setMode('select'); render(); };
    row.onclick = select; row.onkeydown = e => { if (e.target === row && ['Enter', ' '].includes(e.key)) { e.preventDefault(); select(); } };
    fragment.append(row);
  }
  $('asset-list').replaceChildren(fragment);
}
function svgElement(tag, attrs) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; }
function renderOverlay() {
  overlay.replaceChildren();
  const scale = 1 / state.zoom;
  for (const [index, asset] of state.assets.entries()) {
    const selected = asset.id === state.selected;
    const shape = asset.type === 'polygon'
      ? svgElement('polygon', { points: asset.points.map(p => `${p.x},${p.y}`).join(' ') })
      : svgElement('rect', { x: asset.x, y: asset.y, width: asset.w, height: asset.h });
    shape.setAttribute('class', `selection${selected ? ' selected' : ''}`); shape.dataset.asset = asset.id; overlay.append(shape);
    const labelY = Math.max(0, asset.y - 22 * scale);
    overlay.append(svgElement('rect', { x: asset.x, y: labelY, width: 28 * scale, height: 20 * scale, rx: 3 * scale, fill: selected ? '#c5f275' : '#d0f894', 'pointer-events': 'none' }));
    const label = svgElement('text', { x: asset.x + 14 * scale, y: labelY + 14 * scale, fill: '#1b2515', 'text-anchor': 'middle', 'font-size': 11 * scale, 'font-family': 'sans-serif', 'font-weight': '700', 'pointer-events': 'none' }); label.textContent = String(index + 1).padStart(2, '0'); overlay.append(label);
    if (selected && state.mode === 'select') {
      const points = asset.type === 'polygon' ? asset.points : asset.type === 'rect' ? [{ x: asset.x, y: asset.y }, { x: asset.x + asset.w, y: asset.y }, { x: asset.x + asset.w, y: asset.y + asset.h }, { x: asset.x, y: asset.y + asset.h }] : [];
      points.forEach((p, i) => { const handle = svgElement('circle', { cx: p.x, cy: p.y, r: 4.5 * scale, fill: '#c5f275', stroke: '#172014', 'stroke-width': 1.5 * scale, cursor: asset.type === 'polygon' ? 'crosshair' : i % 2 ? 'nesw-resize' : 'nwse-resize' }); handle.dataset.handle = i; handle.dataset.asset = asset.id; overlay.append(handle); });
    }
  }
  if (state.drag?.type === 'new') {
    const b = rectangle(state.drag.start, state.drag.last); overlay.append(svgElement('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'draft' }));
  }
  if (state.points.length) {
    overlay.append(svgElement('polyline', { points: state.points.map(p => `${p.x},${p.y}`).join(' '), class: 'draft' }));
    state.points.forEach((p, i) => overlay.append(svgElement('circle', { cx: p.x, cy: p.y, r: (i ? 3 : 5) * scale, fill: '#c5f275', 'pointer-events': 'none' })));
  }
  $('finish-polygon').hidden = state.points.length < 3;
}
function renderInspector() {
  const asset = current(); $('inspector-content').hidden = !asset; $('inspector-empty').hidden = !!asset;
  $('selection-status').textContent = asset ? `${asset.name} · ${asset.w} × ${asset.h} px` : `${state.assets.length} assets · marque uma peça para começar`;
  if (!asset) return;
  const output = assetCanvas(asset), preview = $('preview'), ratio = Math.min(440 / output.width, 360 / output.height, 1);
  preview.width = Math.max(1, Math.round(output.width * ratio)); preview.height = Math.max(1, Math.round(output.height * ratio)); preview.getContext('2d').drawImage(output, 0, 0, preview.width, preview.height);
  $('preview-size').textContent = `${output.width} × ${output.height} px`;
  $('shape-label').textContent = asset.type === 'rect' ? 'Retângulo' : asset.type === 'polygon' ? 'Contorno' : 'Região por pixels';
  $('asset-name').value = asset.name;
  for (const k of ['x', 'y', 'w', 'h']) { $(`bound-${k}`).value = asset[k]; $(`bound-${k}`).disabled = asset.type === 'mask' && ['w', 'h'].includes(k); }
  $('bounds-help').textContent = asset.type === 'polygon' ? 'Arraste cada ponto do contorno para ajustar a silhueta.' : asset.type === 'mask' ? 'Para outra seleção, use a varinha novamente com uma nova tolerância.' : 'Arraste os cantos na imagem ou ajuste os valores.';
  $('padding').value = asset.padding; $('padding-value').value = asset.padding;
  $('remove-bg').checked = asset.removeBg; $('bg-controls').hidden = !asset.removeBg; $('bg-tolerance').value = asset.bgTolerance;
}
function render() { renderCounts(); renderList(); renderOverlay(); renderInspector(); }
function updateAsset(id, patch, full = true) { state.assets = state.assets.map(a => a.id === id ? { ...a, ...patch } : a); if (full) render(); else { renderOverlay(); renderInspector(); } }
function newAsset(properties) {
  const id = state.nextId++;
  return { id, name: `asset_${String(id).padStart(2, '0')}`, included: true, padding: 0, removeBg: false, bgTolerance: 30, ...properties };
}
function addAsset(properties) { checkpoint(); const asset = newAsset(properties); state.assets.push(asset); state.selected = asset.id; state.points = []; setMode('select'); render(); return asset; }
function rectangle(a, b) { const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y)); return { x, y, w: Math.max(1, Math.ceil(Math.max(a.x, b.x)) - x), h: Math.max(1, Math.ceil(Math.max(a.y, b.y)) - y) }; }
function point(event) { const r = overlay.getBoundingClientRect(); return { x: clamp((event.clientX - r.left) * source.width / r.width, 0, source.width), y: clamp((event.clientY - r.top) * source.height / r.height, 0, source.height) }; }
function finishPolygon() {
  if (state.points.length < 3) return toast('Marque pelo menos três pontos para formar o contorno.');
  const points = state.points.map(p => ({ ...p }));
  let area = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; area += a.x * b.y - b.x * a.y; }
  if (Math.abs(area) < 8) return toast('O contorno precisa delimitar uma área.');
  addAsset({ type: 'polygon', points, ...boundsOf(points) }); toast('Contorno criado. Arraste os pontos para refinar.');
}
async function wand(p) {
  if (state.busy) return;
  busy(true, 'Identificando a região…'); await nextFrame();
  try {
    const region = selectConnected(state.pixels.data, source.width, source.height, p.x, p.y, Number($('tolerance').value), state.alpha);
    if (!region || region.pixels < 4) return toast('Clique dentro de uma peça visível.');
    if (region.pixels > source.width * source.height * .75) return toast('A seleção cobriu quase toda a imagem. Reduza a tolerância ou use Contorno.');
    addAsset({ type: 'mask', ...region });
    toast(state.alpha ? 'Peça conectada selecionada. Confira a prévia.' : 'Região por cor criada. Peças com várias cores podem precisar de Contorno.');
  } finally { busy(false); }
}
overlay.addEventListener('pointerdown', e => {
  if (e.button !== 0 || state.busy || !state.pixels) return;
  e.preventDefault(); stage.focus({ preventScroll: true });
  const p = point(e), id = Number(e.target.dataset.asset), asset = state.assets.find(a => a.id === id);
  if (state.mode === 'polygon') {
    if (state.points.length >= 3 && Math.hypot(p.x - state.points[0].x, p.y - state.points[0].y) * state.zoom < 11) return finishPolygon();
    state.points.push(p); renderOverlay(); return;
  }
  if (state.mode === 'wand') { wand(p); return; }
  overlay.setPointerCapture(e.pointerId);
  if (state.mode === 'select' && asset) {
    state.selected = id;
    state.drag = { type: e.target.dataset.handle !== undefined ? 'handle' : 'move', handle: Number(e.target.dataset.handle), start: p, original: { ...asset, points: asset.points?.map(v => ({ ...v })) }, changed: false };
    render();
  } else if (state.mode === 'rect') { state.drag = { type: 'new', start: p, last: p }; renderOverlay(); }
  else { state.selected = null; render(); }
});
overlay.addEventListener('pointermove', e => {
  const drag = state.drag; if (!drag) return;
  const p = point(e);
  if (drag.type === 'new') { drag.last = p; renderOverlay(); return; }
  if (!drag.changed) { if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * state.zoom < 2) return; checkpoint(); drag.changed = true; }
  const a = drag.original;
  if (drag.type === 'move') {
    const dx = clamp(Math.round(p.x - drag.start.x), -a.x, source.width - a.x - a.w), dy = clamp(Math.round(p.y - drag.start.y), -a.y, source.height - a.y - a.h);
    updateAsset(a.id, { x: a.x + dx, y: a.y + dy, ...(a.points ? { points: a.points.map(v => ({ x: v.x + dx, y: v.y + dy })) } : {}) }, false);
  } else if (a.type === 'polygon') {
    const points = a.points.map((v, i) => i === drag.handle ? p : v); updateAsset(a.id, { points, ...boundsOf(points) }, false);
  } else {
    const opposites = [{ x: a.x + a.w, y: a.y + a.h }, { x: a.x, y: a.y + a.h }, { x: a.x, y: a.y }, { x: a.x + a.w, y: a.y }];
    updateAsset(a.id, rectangle(p, opposites[drag.handle]), false);
  }
});
function endDrag(e) {
  const drag = state.drag; if (!drag) return;
  state.drag = null;
  if (drag.type === 'new') {
    const p = e ? point(e) : drag.last;
    if (Math.abs(p.x - drag.start.x) * state.zoom >= 3 && Math.abs(p.y - drag.start.y) * state.zoom >= 3) addAsset({ type: 'rect', ...rectangle(drag.start, p) });
    else renderOverlay();
  } else render();
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', () => { const drag = state.drag; if (drag?.changed) { state.assets = state.assets.map(a => a.id === drag.original.id ? drag.original : a); state.undo.pop(); } state.drag = null; render(); });

async function replaceAllowed() {
  if (!state.assets.length) return true;
  const dialog = $('replace-dialog'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace'), { once: true }));
}
async function loadImage(url, filename, sample = false) {
  const sequence = ++loadSequence;
  busy(true, 'Preparando a imagem…');
  try {
    const loaded = new Image(); loaded.src = url; await loaded.decode();
    if (sequence !== loadSequence) return;
    if (loaded.naturalWidth * loaded.naturalHeight > 16000000 || Math.max(loaded.naturalWidth, loaded.naturalHeight) > 8192) throw new Error('Use uma imagem de até 16 megapixels e 8192 px por lado.');
    source.width = loaded.naturalWidth; source.height = loaded.naturalHeight; sourceCtx.drawImage(loaded, 0, 0);
    state.pixels = sourceCtx.getImageData(0, 0, source.width, source.height); state.alpha = hasTransparency(state.pixels.data);
    image.src = url; await image.decode();
    state.assets = []; state.selected = null; state.undo = []; state.redo = []; state.points = []; state.drag = null; state.nextId = 1; state.filename = filename; state.dirty = false;
    $('filename').textContent = filename; $('workspace-name').textContent = filename; $('dimensions').textContent = `${source.width} × ${source.height} px · ${state.alpha ? 'transparente' : 'fundo opaco'}`; $('sample-tag').hidden = !sample;
    setMode('rect'); fit(); render();
  } catch (error) { toast(error.message || 'Não foi possível abrir esta imagem.'); }
  finally { if (sequence === loadSequence) busy(false); }
}
async function openFile(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('Escolha uma imagem PNG, JPG ou WebP.');
  if (!await replaceAllowed()) return;
  const url = URL.createObjectURL(file);
  try { await loadImage(url, file.name); } finally { URL.revokeObjectURL(url); }
}
$('upload').onclick = () => $('file').click();
$('file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
$('example').onclick = async () => { if (await replaceAllowed()) loadImage('./exemplo.png', 'teste.png', true); };
stage.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
stage.addEventListener('drop', e => { e.preventDefault(); if (!state.busy) openFile(e.dataTransfer.files[0]); });
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => setMode(button.dataset.mode));
$('fit').onclick = fit; $('zoom-in').onclick = () => setZoom(state.zoom * 1.25); $('zoom-out').onclick = () => setZoom(state.zoom / 1.25);
new ResizeObserver(() => { if (state.fit) fit(); }).observe(stage);
$('undo').onclick = () => restore(state.undo, state.redo); $('redo').onclick = () => restore(state.redo, state.undo);
$('finish-polygon').onclick = finishPolygon;
$('tolerance').oninput = () => { $('tolerance-value').value = $('tolerance').value; };
$('detect').onclick = async () => {
  if (!state.pixels || state.busy) return;
  if (!state.alpha) return toast('Esta imagem não tem fundo transparente. Use Retângulo ou Contorno para separar as peças.');
  busy(true, 'Separando peças transparentes…'); await nextFrame();
  try {
    const result = detectComponents(state.pixels.data, source.width, source.height);
    const fresh = result.components.filter(r => !state.assets.some(a => a.type === 'mask' && a.x === r.x && a.y === r.y && a.w === r.w && a.h === r.h));
    if (!fresh.length) return toast('Nenhuma peça nova encontrada. Peças que se tocam são detectadas juntas.');
    checkpoint(); state.assets.push(...fresh.map(r => newAsset({ type: 'mask', ...r }))); state.selected = state.assets[0]?.id; setMode('select'); render();
    toast(`${fresh.length} peças adicionadas.${result.limited ? ' Limite de 250 peças atingido.' : ''} Revise os recortes antes de exportar.`);
  } finally { busy(false); }
};
let nameEditStarted = false;
$('asset-name').onfocus = () => { nameEditStarted = false; };
$('asset-name').oninput = () => {
  const a = current(); if (!a) return;
  if (!nameEditStarted) { checkpoint(); nameEditStarted = true; }
  state.assets = state.assets.map(item => item.id === a.id ? { ...item, name: $('asset-name').value } : item);
  renderList(); renderCounts(); $('selection-status').textContent = `${$('asset-name').value || 'Asset'} · ${a.w} × ${a.h} px`;
};
$('asset-name').onchange = () => { const a = current(); if (a) updateAsset(a.id, { name: $('asset-name').value.trim() || `asset_${String(a.id).padStart(2, '0')}` }); };
for (const key of ['x', 'y', 'w', 'h']) $(`bound-${key}`).onchange = () => {
  const a = current(); if (!a) return;
  const value = Number($(`bound-${key}`).value); if (!Number.isFinite(value)) return renderInspector();
  const b = { x: a.x, y: a.y, w: a.w, h: a.h };
  b[key] = Math.round(value);
  b.x = clamp(b.x, 0, source.width - a.w); b.y = clamp(b.y, 0, source.height - a.h);
  b.w = clamp(b.w, 1, source.width - b.x); b.h = clamp(b.h, 1, source.height - b.y);
  checkpoint();
  if (a.points) b.points = a.points.map(p => ({ x: b.x + (p.x - a.x) * b.w / a.w, y: b.y + (p.y - a.y) * b.h / a.h }));
  updateAsset(a.id, b);
};
for (const [id, prop] of [['padding', 'padding'], ['bg-tolerance', 'bgTolerance']]) {
  $(id).oninput = () => { if (id === 'padding') $('padding-value').value = $(id).value; };
  $(id).onchange = () => { const a = current(); if (a) { checkpoint(); updateAsset(a.id, { [prop]: Number($(id).value) }); } };
}
$('remove-bg').onchange = () => { const a = current(); if (a) { checkpoint(); updateAsset(a.id, { removeBg: $('remove-bg').checked }); } };
function deleteSelected() { const a = current(); if (!a) return; checkpoint(); state.assets = state.assets.filter(item => item.id !== a.id); state.selected = state.assets.at(-1)?.id ?? null; render(); toast('Asset removido. Ctrl+Z para desfazer.'); }
$('delete').onclick = deleteSelected;
$('select-all').onchange = () => {
  if (state.busy || !state.assets.length) return;
  const included = $('select-all').checked;
  checkpoint(); state.assets = state.assets.map(asset => ({ ...asset, included })); render();
};
const pngBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Falha ao criar PNG.')), 'image/png'));
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
$('download').onclick = async () => { const a = current(); if (!a) return; try { downloadBlob(await pngBlob(assetCanvas(a)), `${safeName(a.name)}.png`); toast('PNG preparado para download.'); } catch (error) { toast(error.message); } };
async function exportAssets(format) {
  const plan = createExportPlan(state.assets); if (!plan.length || state.busy) return;
  const sourceName = state.filename;
  let requested = 0;
  busy(true, 'Preparando os PNGs…'); await nextFrame();
  try {
    const files = [];
    for (const [index, { asset, name }] of plan.entries()) {
      $('loading').textContent = `Preparando PNG ${index + 1} de ${plan.length}…`;
      const blob = await pngBlob(assetCanvas(asset));
      if (format === 'png') {
        downloadBlob(blob, name); requested++;
        // Space out requests; the browser still controls permission and actual saving.
        if (index < plan.length - 1) await new Promise(resolve => setTimeout(resolve, 300));
      } else files.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    if (format === 'zip') {
      downloadBlob(makeZip(files), `${safeName(sourceName.replace(/\.[^.]+$/, ''))}_assets.zip`);
      toast(`${plan.length} PNGs preparados em um ZIP.`);
    } else {
      toast(`Downloads de ${requested} PNGs solicitados. Se o navegador bloquear algum, permita vários downloads ou use Baixar ZIP.`);
    }
  } catch (error) { toast(`${requested ? `${requested} downloads já solicitados. ` : ''}Não foi possível concluir a exportação: ${error.message}`); }
  finally { busy(false); }
}
$('export-all').onclick = () => exportAssets('zip');
$('export-pngs').onclick = () => exportAssets('png');
window.addEventListener('keydown', e => {
  if ($('replace-dialog').open || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); restore(e.shiftKey ? state.redo : state.undo, e.shiftKey ? state.undo : state.redo); return; }
  if (e.key === 'Escape') { if (state.drag?.changed) { const a = state.drag.original; state.assets = state.assets.map(item => item.id === a.id ? a : item); state.undo.pop(); } state.points = []; state.drag = null; render(); }
  else if (e.key === 'Enter' && state.points.length) { e.preventDefault(); finishPolygon(); }
  else if (e.key === 'Backspace' && state.points.length) { e.preventDefault(); state.points.pop(); renderOverlay(); }
  else if (['Delete', 'Backspace'].includes(e.key)) { e.preventDefault(); deleteSelected(); }
  else if (!e.ctrlKey && !e.metaKey && { v: 'select', r: 'rect', p: 'polygon', w: 'wand' }[e.key.toLowerCase()]) setMode({ v: 'select', r: 'rect', p: 'polygon', w: 'wand' }[e.key.toLowerCase()]);
});
window.addEventListener('beforeunload', e => { if (state.dirty && state.assets.length) { e.preventDefault(); e.returnValue = ''; } });

// Agents use the same reviewed app state; unsupported browsers simply skip registration.
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
  register({ name: 'list_asset_crops', title: 'Listar recortes', description: 'Lista os recortes e dimensões da imagem atualmente aberta.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ width: source.width, height: source.height, assets: state.assets.map(({ id, name, x, y, w, h, type, included }) => ({ id, name, x, y, w, h, type, included })) }) });
  register({ name: 'create_rectangle_crops', title: 'Criar recortes retangulares', description: 'Adiciona retângulos à imagem aberta para revisão. Não faz downloads.', inputSchema: { type: 'object', properties: { crops: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false } } }, required: ['crops'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: input => {
    if (!state.pixels || state.busy || !Array.isArray(input?.crops) || input.crops.length < 1 || input.crops.length > 100) throw new Error('Imagem indisponível ou lista inválida.');
    for (const c of input.crops) if (!c || ![c.x, c.y, c.width, c.height].every(Number.isInteger) || c.x < 0 || c.y < 0 || c.width < 1 || c.height < 1 || c.x + c.width > source.width || c.y + c.height > source.height || (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 80))) throw new Error('Coordenadas ou nome inválidos. Nenhum recorte foi criado.');
    checkpoint(); const created = input.crops.map(c => newAsset({ type: 'rect', x: c.x, y: c.y, w: c.width, h: c.height, ...(c.name?.trim() ? { name: c.name.trim() } : {}) })); state.assets.push(...created); state.selected = created.at(-1).id; setMode('select'); render(); return { created: created.map(a => ({ id: a.id, name: a.name })) };
  } });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
loadImage('./exemplo.png', 'teste.png', true);
