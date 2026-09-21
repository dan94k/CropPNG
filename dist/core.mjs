// Image algorithms are independent of the interface, and work at source resolution.
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function boundsOf(points) {
  const x = Math.floor(Math.min(...points.map(p => p.x)));
  const y = Math.floor(Math.min(...points.map(p => p.y)));
  const right = Math.ceil(Math.max(...points.map(p => p.x)));
  const bottom = Math.ceil(Math.max(...points.map(p => p.y)));
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

export function hasTransparency(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 8) return true;
  return false;
}

function colorDistance(data, a, b) {
  return ((data[a] - data[b]) ** 2 + (data[a + 1] - data[b + 1]) ** 2 + (data[a + 2] - data[b + 2]) ** 2) / 3;
}

// Iterative flood-fill: fixed seed color prevents the selection creeping through gradients.
function component(data, width, height, start, seen, queue, tolerance, alphaOnly) {
  let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0;
  queue[0] = start; seen[start] = 1;
  const seed = start * 4, threshold = tolerance * tolerance;
  const add = p => {
    if (seen[p] || data[p * 4 + 3] <= 8) return;
    if (!alphaOnly && colorDistance(data, p * 4, seed) > threshold) return;
    seen[p] = 1; queue[tail++] = p;
  };
  while (head < tail) {
    const p = queue[head++], x = p % width, y = Math.floor(p / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (x > 0) add(p - 1); if (x < width - 1) add(p + 1);
    if (y > 0) add(p - width); if (y < height - 1) add(p + width);
    if (alphaOnly) {
      if (x > 0 && y > 0) add(p - width - 1);
      if (x < width - 1 && y > 0) add(p - width + 1);
      if (x > 0 && y < height - 1) add(p + width - 1);
      if (x < width - 1 && y < height - 1) add(p + width + 1);
    }
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const local = new Uint8Array(w * h);
  for (let j = 0; j < tail; j++) {
    const p = queue[j]; local[(Math.floor(p / width) - minY) * w + p % width - minX] = 1;
  }
  // Compact horizontal runs are immutable and can be shared by undo snapshots.
  const runs = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
    if (!local[y * w + x]) { x++; continue; }
    const startX = x;
    while (x < w && local[y * w + x]) x++;
    runs.push(y, startX, x - startX);
  }
  return { x: minX, y: minY, w, h, runs, pixels: tail };
}

export function selectConnected(data, width, height, x, y, tolerance = 65, alphaOnly = false) {
  x = clamp(Math.floor(x), 0, width - 1); y = clamp(Math.floor(y), 0, height - 1);
  const start = y * width + x;
  if (data[start * 4 + 3] <= 8) return null;
  return component(data, width, height, start, new Uint8Array(width * height), new Int32Array(width * height), tolerance, alphaOnly);
}

export function detectComponents(data, width, height, minimumPixels = 12, limit = 250) {
  if (!hasTransparency(data)) return { components: [], opaque: true, limited: false };
  const seen = new Uint8Array(width * height), queue = new Int32Array(width * height), components = [];
  for (let p = 0; p < width * height; p++) {
    if (seen[p] || data[p * 4 + 3] <= 8) continue;
    const region = component(data, width, height, p, seen, queue, 0, true);
    if (region.pixels >= minimumPixels) {
      if (components.length >= limit) return { components, opaque: false, limited: true };
      components.push(region);
    }
  }
  components.sort((a, b) => a.y - b.y || a.x - b.x);
  return { components, opaque: false, limited: false };
}

export function removeCornerBackground(data, width, height, tolerance) {
  const source = new Uint8ClampedArray(data), seen = new Uint8Array(width * height), queue = new Int32Array(width * height);
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  for (const start of corners) {
    if (source[start * 4 + 3] <= 8) continue;
    // Each corner uses its own fixed reference, avoiding unrestricted gradient propagation.
    seen.fill(0);
    let head = 0, tail = 1; queue[0] = start; seen[start] = 1;
    const add = p => {
      if (seen[p] || source[p * 4 + 3] <= 8 || colorDistance(source, p * 4, start * 4) > tolerance * tolerance) return;
      seen[p] = 1; queue[tail++] = p;
    };
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      data[p * 4 + 3] = 0;
      if (x > 0) add(p - 1); if (x + 1 < width) add(p + 1);
      if (y > 0) add(p - width); if (y + 1 < height) add(p + width);
    }
  }
  return data;
}

export function safeName(name) {
  return (name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'asset');
}

export function createExportPlan(assets) {
  const names = new Set();
  return assets.filter(asset => asset.included).map(asset => {
    const base = safeName(asset.name);
    let name = `${base}.png`, counter = 2;
    while (names.has(name.toLowerCase())) name = `${base}_${counter++}.png`;
    names.add(name.toLowerCase());
    return { asset, name };
  });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// PNGs are already compressed; ZIP's store method needs no third-party dependency.
export function makeZip(files) {
  const entries = [], directory = []; let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), bytes = file.bytes, crc = crc32(bytes);
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true);
    header.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.set(name, 46); entries.push(header, bytes); directory.push(central); offset += header.length + bytes.length;
  }
  const directorySize = directory.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...entries, ...directory, end], { type: 'application/zip' });
}
