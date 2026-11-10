// Decoder for the compact binary produced by scripts/build-data.mjs, plus pure helpers
// shared by the UI (main thread) and the renderer (web worker).

/** Attribute data per postcode area (index i = i-th postcode in ascending order). */
export interface AtlasMeta {
  n: number;
  /** metres per world unit */
  q: number;
  /** RD origin (metres) and max quantised y: world = ((rd - origin) / q) with y flipped */
  x0: number;
  y0: number;
  maxY: number;
  pc: Uint16Array;
  inw: Uint32Array;
  /** label point, world units (y grows downwards) */
  lx: Float32Array;
  ly: Float32Array;
  /** minX, minY, maxX, maxY per feature */
  bbox: Float32Array;
  placeOff: Uint32Array;
  placeIdx: Uint16Array;
  gem: Uint16Array;
  prov: Uint16Array;
  strings: string[];
}

export interface AtlasGeom {
  /** start offset (in points) of each arc in arcXY */
  arcOff: Uint32Array;
  arcXY: Float64Array;
  /** per feature: list of rings, each ring a list of arc refs (~i = reversed) */
  rings: Int32Array[][];
}

export function decodeAtlas(buf: ArrayBuffer): { meta: AtlasMeta; geom: AtlasGeom } {
  const b = new Uint8Array(buf);
  let pos = 0;
  const u = (): number => {
    let v = 0, m = 1, x: number;
    do {
      x = b[pos++];
      v += (x & 127) * m;
      m *= 128;
    } while (x & 128);
    return v;
  };
  const z = (): number => {
    const v = u();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };

  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'PC4A') throw new Error('Onbekend dataformaat');
  pos = 4;
  u(); // version
  const q = u();
  const x0 = u(), y0 = u();

  const td = new TextDecoder();
  const strings: string[] = new Array(u());
  for (let i = 0; i < strings.length; i++) {
    const len = u();
    strings[i] = td.decode(b.subarray(pos, pos + len));
    pos += len;
  }

  const nArcs = u();
  const arcOff = new Uint32Array(nArcs + 1);
  const xy: number[] = [];
  let px = 0, py = 0, maxY = 0;
  for (let a = 0; a < nArcs; a++) {
    arcOff[a] = xy.length / 2;
    for (let k = u(); k > 0; k--) {
      px += z();
      py += z();
      if (py > maxY) maxY = py;
      xy.push(px, py);
    }
  }
  arcOff[nArcs] = xy.length / 2;
  const arcXY = new Float64Array(xy);
  for (let i = 1; i < arcXY.length; i += 2) arcXY[i] = maxY - arcXY[i]; // north up

  const n = u();
  const meta: AtlasMeta = {
    n, q, x0, y0, maxY, strings,
    pc: new Uint16Array(n), inw: new Uint32Array(n),
    lx: new Float32Array(n), ly: new Float32Array(n), bbox: new Float32Array(n * 4),
    placeOff: new Uint32Array(n + 1), placeIdx: new Uint16Array(n * 4),
    gem: new Uint16Array(n), prov: new Uint16Array(n),
  };
  const rings: Int32Array[][] = new Array(n);
  let pc = 0, lx = 0, ly = 0, nPlaces = 0;
  for (let i = 0; i < n; i++) {
    meta.pc[i] = pc += u();
    meta.inw[i] = u();
    meta.placeOff[i] = nPlaces;
    for (let k = u(); k > 0; k--) meta.placeIdx[nPlaces++] = u();
    meta.gem[i] = u();
    meta.prov[i] = u();
    meta.lx[i] = lx += z();
    ly += z();
    meta.ly[i] = maxY - ly;

    const fr: Int32Array[] = [];
    let pa = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let p = u(); p > 0; p--) {
      for (let r = u(); r > 0; r--) {
        const ring = new Int32Array(u());
        for (let k = 0; k < ring.length; k++) {
          const v = u();
          const zz = Math.floor(v / 2);
          pa += zz % 2 ? -(zz + 1) / 2 : zz / 2;
          ring[k] = v & 1 ? ~pa : pa;
          for (let j = arcOff[pa]; j < arcOff[pa + 1]; j++) {
            const x = arcXY[2 * j], y = arcXY[2 * j + 1];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        fr.push(ring);
      }
    }
    rings[i] = fr;
    meta.bbox.set([x0, y0, x1, y1], i * 4);
  }
  meta.placeOff[n] = nPlaces;
  meta.placeIdx = meta.placeIdx.slice(0, nPlaces);
  return { meta, geom: { arcOff, arcXY, rings } };
}

// ---------------------------------------------------------------------------------------------
// Prefix groups. Postcodes are sorted, so every prefix is a contiguous index range.

export interface Group {
  prefix: string;
  lo: number;
  hi: number;
  inw: number;
  /** most populous place in the group */
  name: string;
  lx: number;
  ly: number;
  bbox: [number, number, number, number];
}

function lowerBound(a: Uint16Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const cache = new WeakMap<AtlasMeta, Map<string, Group | null>>();

export function group(meta: AtlasMeta, prefix: string): Group | null {
  let c = cache.get(meta);
  if (!c) cache.set(meta, (c = new Map()));
  if (c.has(prefix)) return c.get(prefix)!;

  const span = 10 ** (4 - prefix.length);
  const start = prefix ? Number(prefix) * span : 0;
  const lo = lowerBound(meta.pc, start);
  const hi = lowerBound(meta.pc, prefix ? start + span : 1e5);
  let g: Group | null = null;
  if (hi > lo) {
    let inw = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0, wsum = 0;
    const byPlace = new Map<number, number>();
    for (let i = lo; i < hi; i++) {
      inw += meta.inw[i];
      const b = meta.bbox.subarray(i * 4, i * 4 + 4);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
      const w = (b[2] - b[0]) * (b[3] - b[1]) + 1;
      cx += meta.lx[i] * w; cy += meta.ly[i] * w; wsum += w;
      if (meta.placeOff[i + 1] > meta.placeOff[i]) {
        const p = meta.placeIdx[meta.placeOff[i]];
        byPlace.set(p, (byPlace.get(p) ?? 0) + meta.inw[i] + 1);
      }
    }
    let best = -1, bestV = -1;
    for (const [p, v] of byPlace) if (v > bestV) { bestV = v; best = p; }
    // label anchor: label point of the member closest to the area-weighted centre (always on land)
    cx /= wsum; cy /= wsum;
    let li = lo, ld = Infinity;
    for (let i = lo; i < hi; i++) {
      const d = (meta.lx[i] - cx) ** 2 + (meta.ly[i] - cy) ** 2;
      if (d < ld) { ld = d; li = i; }
    }
    g = {
      prefix, lo, hi, inw,
      name: best >= 0 ? meta.strings[best] : '',
      lx: meta.lx[li], ly: meta.ly[li],
      bbox: [x0, y0, x1, y1],
    };
  }
  c.set(prefix, g);
  return g;
}

export function children(meta: AtlasMeta, prefix: string): Group[] {
  if (prefix.length >= 4) return [];
  const out: Group[] = [];
  for (let d = 0; d < 10; d++) {
    const g = group(meta, prefix + d);
    if (g) out.push(g);
  }
  return out;
}

export function places(meta: AtlasMeta, i: number): string[] {
  const out: string[] = [];
  for (let k = meta.placeOff[i]; k < meta.placeOff[i + 1]; k++) out.push(meta.strings[meta.placeIdx[k]]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// 6-character postcodes (PC6), one small file per PC4, loaded on demand.

export interface Pc6Meta {
  pc4: string;
  n: number;
  /** two letters per area, sorted ascending ("AA", "AB", …) */
  codes: string[];
  /** -1 = unknown or shielded by CBS */
  inw: Int32Array;
  won: Int32Array;
  hh: Int32Array;
  /** average WOZ value in € 1000 */
  woz: Int32Array;
  koop: Int32Array;
  /** index into strings, -1 = none */
  buurt: Int32Array;
  wijk: Int32Array;
  strings: string[];
  lx: Float32Array;
  ly: Float32Array;
  bbox: Float32Array;
}

export function decodePc6(buf: ArrayBuffer, pc4: string, w: AtlasMeta): { meta: Pc6Meta; geom: AtlasGeom } {
  const b = new Uint8Array(buf);
  let pos = 4;
  const u = (): number => {
    let v = 0, m = 1, x: number;
    do {
      x = b[pos++];
      v += (x & 127) * m;
      m *= 128;
    } while (x & 128);
    return v;
  };
  const z = (): number => {
    const v = u();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'PC6A') throw new Error('Onbekend PC6-formaat');
  const ver = u();
  const ox = u(), oy = u();
  const strings: string[] = [];
  if (ver >= 2) {
    const td = new TextDecoder();
    for (let k = u(); k > 0; k--) {
      const len = u();
      strings.push(td.decode(b.subarray(pos, pos + len)));
      pos += len;
    }
  }
  // RD metres -> world units of the PC4 map
  const wx = (x: number) => (ox + x - w.x0) / w.q;
  const wy = (y: number) => w.maxY - (oy + y - w.y0) / w.q;

  const nArcs = u();
  const arcOff = new Uint32Array(nArcs + 1);
  const xy: number[] = [];
  let px = 0, py = 0;
  for (let a = 0; a < nArcs; a++) {
    arcOff[a] = xy.length / 2;
    for (let k = u(); k > 0; k--) {
      px += z();
      py += z();
      xy.push(wx(px), wy(py));
    }
  }
  arcOff[nArcs] = xy.length / 2;
  const arcXY = new Float64Array(xy);

  const n = u();
  const meta: Pc6Meta = {
    pc4, n, codes: new Array(n),
    inw: new Int32Array(n), won: new Int32Array(n), hh: new Int32Array(n), woz: new Int32Array(n), koop: new Int32Array(n),
    buurt: new Int32Array(n).fill(-1), wijk: new Int32Array(n).fill(-1), strings,
    lx: new Float32Array(n), ly: new Float32Array(n), bbox: new Float32Array(n * 4),
  };
  const rings: Int32Array[][] = new Array(n);
  let lx = 0, ly = 0;
  for (let i = 0; i < n; i++) {
    const l = u();
    meta.codes[i] = String.fromCharCode(65 + Math.floor(l / 26), 65 + (l % 26));
    meta.inw[i] = u() - 1;
    meta.won[i] = u() - 1;
    meta.hh[i] = u() - 1;
    meta.woz[i] = u() - 1;
    meta.koop[i] = u() - 1;
    if (ver >= 2) {
      meta.buurt[i] = u() - 1;
      meta.wijk[i] = u() - 1;
    }
    lx += z();
    ly += z();
    meta.lx[i] = wx(lx);
    meta.ly[i] = wy(ly);
    const fr: Int32Array[] = [];
    let pa = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let r = u(); r > 0; r--) {
      const ring = new Int32Array(u());
      for (let k = 0; k < ring.length; k++) {
        const v = u();
        const zz = Math.floor(v / 2);
        pa += zz % 2 ? -(zz + 1) / 2 : zz / 2;
        ring[k] = v & 1 ? ~pa : pa;
        for (let j = arcOff[pa]; j < arcOff[pa + 1]; j++) {
          const x = arcXY[2 * j], y = arcXY[2 * j + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      fr.push(ring);
    }
    rings[i] = fr;
    meta.bbox.set([x0, y0, x1, y1], i * 4);
  }
  return { meta, geom: { arcOff, arcXY, rings } };
}

export interface Group6 {
  /** letters: '' (whole PC4), 'A' or 'AB' */
  letters: string;
  lo: number;
  hi: number;
  inw: number;
  /** buurt and wijk where most of its postcodes are ('' if unknown) */
  name: string;
  wijk: string;
  lx: number;
  ly: number;
  bbox: [number, number, number, number];
}

const cache6 = new WeakMap<Pc6Meta, Map<string, Group6 | null>>();

export function group6(m: Pc6Meta, letters: string): Group6 | null {
  let c = cache6.get(m);
  if (!c) cache6.set(m, (c = new Map()));
  if (c.has(letters)) return c.get(letters)!;
  let lo = 0;
  while (lo < m.n && m.codes[lo] < letters) lo++;
  let hi = lo;
  while (hi < m.n && m.codes[hi].startsWith(letters)) hi++;
  let g: Group6 | null = null;
  if (hi > lo) {
    let inw = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0, ws = 0;
    const byBuurt = new Map<number, number>(), byWijk = new Map<number, number>();
    for (let i = lo; i < hi; i++) {
      if (m.inw[i] > 0) inw += m.inw[i];
      if (m.buurt[i] >= 0) byBuurt.set(m.buurt[i], (byBuurt.get(m.buurt[i]) ?? 0) + 1);
      if (m.wijk[i] >= 0) byWijk.set(m.wijk[i], (byWijk.get(m.wijk[i]) ?? 0) + 1);
      const b = m.bbox.subarray(i * 4, i * 4 + 4);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
      const wgt = (b[2] - b[0]) * (b[3] - b[1]) + 1e-6;
      cx += m.lx[i] * wgt; cy += m.ly[i] * wgt; ws += wgt;
    }
    cx /= ws; cy /= ws;
    let li = lo, ld = Infinity;
    for (let i = lo; i < hi; i++) {
      const d = (m.lx[i] - cx) ** 2 + (m.ly[i] - cy) ** 2;
      if (d < ld) { ld = d; li = i; }
    }
    const top = (mp: Map<number, number>) => {
      let best = -1, bestN = 0;
      for (const [k, c] of mp) if (c > bestN) { bestN = c; best = k; }
      return best >= 0 ? m.strings[best] : '';
    };
    g = { letters, lo, hi, inw, name: top(byBuurt), wijk: top(byWijk), lx: m.lx[li], ly: m.ly[li], bbox: [x0, y0, x1, y1] };
  }
  c.set(letters, g);
  return g;
}

export function children6(m: Pc6Meta, letters: string): Group6[] {
  if (letters.length >= 2) return [];
  const out: Group6[] = [];
  for (let k = 0; k < 26; k++) {
    const g = group6(m, letters + String.fromCharCode(65 + k));
    if (g) out.push(g);
  }
  return out;
}

/** Display form of a postcode: "3512AB" -> "3512 AB" */
export const formatCode = (c: string) => (c.length > 4 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);

/** Palette slot of the last character of a code (digits 0-9, letters cycle through 10 colours). */
export const colorSlot = (c: string) => {
  const ch = c.charCodeAt(c.length - 1);
  return ch >= 65 ? (ch - 65) % 10 : ch - 48;
};

// ---------------------------------------------------------------------------------------------
// Addresses (BAG), one small file per PC4, loaded when you are inside a 6-character postcode.

export interface AdrData {
  pc4: string;
  /** letters of each 6-character postcode, sorted; addresses of codes[k] are off[k] .. off[k+1] */
  codes: string[];
  off: Uint32Array;
  strings: string[];
  street: Uint16Array;
  nr: Uint32Array;
  /** index into strings, -1 = none */
  suf: Int32Array;
  x: Float64Array;
  y: Float64Array;
}

export function decodeAdr(buf: ArrayBuffer, pc4: string, w: AtlasMeta): AdrData {
  const b = new Uint8Array(buf);
  let pos = 4;
  const u = (): number => {
    let v = 0, m = 1, x: number;
    do {
      x = b[pos++];
      v += (x & 127) * m;
      m *= 128;
    } while (x & 128);
    return v;
  };
  const z = (): number => {
    const v = u();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'ADR1') throw new Error('Onbekend adresformaat');
  u(); // version
  const ox = u(), oy = u();
  const td = new TextDecoder();
  const strings: string[] = new Array(u());
  for (let i = 0; i < strings.length; i++) {
    const len = u();
    strings[i] = td.decode(b.subarray(pos, pos + len));
    pos += len;
  }
  const codes: string[] = [];
  const offs: number[] = [];
  const street: number[] = [], nr: number[] = [], suf: number[] = [], xs: number[] = [], ys: number[] = [];
  let px = 0, py = 0;
  for (let k = u(); k > 0; k--) {
    const l = u();
    codes.push(String.fromCharCode(65 + Math.floor(l / 26), 65 + (l % 26)));
    offs.push(nr.length);
    for (let s = u(); s > 0; s--) {
      const st = u();
      for (let a = u(); a > 0; a--) {
        street.push(st);
        nr.push(u());
        suf.push(u() - 1);
        px += z();
        py += z();
        xs.push((ox + px - w.x0) / w.q);
        ys.push(w.maxY - (oy + py - w.y0) / w.q);
      }
    }
  }
  offs.push(nr.length);
  return {
    pc4, codes, off: Uint32Array.from(offs), strings,
    street: Uint16Array.from(street), nr: Uint32Array.from(nr), suf: Int32Array.from(suf),
    x: Float64Array.from(xs), y: Float64Array.from(ys),
  };
}

export function adrRange(a: AdrData, letters: string): [number, number] {
  const k = a.codes.indexOf(letters);
  return k < 0 ? [0, 0] : [a.off[k], a.off[k + 1]];
}

/** "Domplein 2–24 (even)" style summary per street for one 6-character postcode. */
export function addressSummary(a: AdrData, letters: string): { count: number; streets: string[] } {
  const [lo, hi] = adrRange(a, letters);
  const by = new Map<number, number[]>();
  for (let i = lo; i < hi; i++) {
    const l = by.get(a.street[i]);
    if (l) l.push(a.nr[i]);
    else by.set(a.street[i], [a.nr[i]]);
  }
  const streets: string[] = [];
  for (const [s, nrs] of by) {
    const u = [...new Set(nrs)].sort((p, q) => p - q);
    const min = u[0], max = u[u.length - 1];
    const parity = u.every((n) => n % 2 === 0) ? ' (even)' : u.every((n) => n % 2 === 1) ? ' (oneven)' : '';
    streets.push(`${a.strings[s]} ${min === max ? min : `${min}–${max}${u.length > 1 ? parity : ''}`}`);
  }
  return { count: hi - lo, streets };
}
