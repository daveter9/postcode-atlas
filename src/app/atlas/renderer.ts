// Canvas renderer. Runs inside a Web Worker on an OffscreenCanvas (main thread stays idle),
// or on the main thread as a fallback for browsers without OffscreenCanvas.
//
// Every change of postcode is one transition in three phases:
//   1. select   - the area you are going into lights up as a whole (going back: the sub-areas
//                 melt into the area you are leaving)
//   2. zoom     - smooth van Wijk & Nuij zoom to the new view
//   3. reveal   - the sub-areas of the new postcode fade in
// Zooming far out stays fluid because the PC4 map has levels of detail (coarser arcs when
// one pixel covers more ground).
import {
  AdrData, AtlasGeom, AtlasMeta, Pc6Meta, adrRange, children, children6, colorSlot, decodeAdr, decodeAtlas, decodePc6, formatCode, group, group6,
} from './atlas-data';
import type { FromRenderer, Theme, ToRenderer } from './protocol';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Box = [number, number, number, number];
interface Cell { box: Box; path: Path2D }
interface View { x: number; y: number; k: number } // centre (world) + world units per CSS px
interface Arcs { off: Uint32Array; xy: Float64Array }
/** strokeCells[L - 1]: borders between postcode groups of L digits (L = 1..4) */
interface Lod { arcs: Arcs; feat: Path2D[]; fillCells: Cell[]; strokeCells: Cell[][] }
interface Detail {
  meta: Pc6Meta;
  geom: AtlasGeom;
  feat: Path2D[];
  /** [0]: borders between first letters, [1]: all 6-character postcode borders */
  borders: [Path2D, Path2D];
  paths: Map<string, Path2D>;
  outlines: Map<string, Path2D>;
}
interface Trans {
  from: string;
  to: string;
  x: string; // highlighted while leaving `from`
  y: string; // highlighted while arriving at `to`
  t0: number;
  d1: number;
  d2: number;
  d3: number;
  v0: View;
  zoom: ((t: number) => View) | null;
}
interface Layer { kind: 'hl' | 'state'; code: string; alpha: number }

const GRID = 12;
/** simplification tolerance per level of detail, in world units (1 unit = 5 m) */
const LOD_TOL = [0, 4, 14, 48];
const MAX_DETAILS = 12;

const raf: (cb: (t: number) => void) => unknown =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(performance.now()), 16);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Douglas-Peucker per arc; arc end points are kept, so shared borders stay shared. */
function simplifyArcs(src: Arcs, tol: number): Arcs {
  if (!tol) return src;
  const t2 = tol * tol;
  const off = new Uint32Array(src.off.length);
  const out: number[] = [];
  const xy = src.xy;
  const stack: number[] = [];
  for (let a = 0; a < src.off.length - 1; a++) {
    const s = src.off[a], e = src.off[a + 1], n = e - s;
    off[a] = out.length / 2;
    if (n <= 2) {
      for (let j = s; j < e; j++) out.push(xy[2 * j], xy[2 * j + 1]);
      continue;
    }
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    stack.push(0, n - 1);
    while (stack.length) {
      const j1 = stack.pop()!, j0 = stack.pop()!;
      const ax = xy[2 * (s + j0)], ay = xy[2 * (s + j0) + 1];
      const dx = xy[2 * (s + j1)] - ax, dy = xy[2 * (s + j1) + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let best = -1, bestD = t2;
      for (let j = j0 + 1; j < j1; j++) {
        const px = xy[2 * (s + j)] - ax, py = xy[2 * (s + j) + 1] - ay;
        let d: number;
        if (len2 === 0) d = px * px + py * py;
        else {
          const c = (px * dx + py * dy) / len2;
          d = c < 0 ? px * px + py * py : c > 1 ? (px - dx) ** 2 + (py - dy) ** 2 : (px - c * dx) ** 2 + (py - c * dy) ** 2;
        }
        if (d > bestD) { bestD = d; best = j; }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack.push(j0, best, best, j1);
      }
    }
    for (let j = 0; j < n; j++) if (keep[j]) out.push(xy[2 * (s + j)], xy[2 * (s + j) + 1]);
  }
  off[off.length - 1] = out.length / 2;
  return { off, xy: new Float64Array(out) };
}

function ringPath(p: Path2D, ring: Int32Array, arcs: Arcs) {
  let first = true;
  for (const ref of ring) {
    const a = ref < 0 ? ~ref : ref;
    const s = arcs.off[a], e = arcs.off[a + 1];
    for (let k = 0; k < e - s; k++) {
      const j = ref < 0 ? e - 1 - k : s + k;
      if (first) { p.moveTo(arcs.xy[2 * j], arcs.xy[2 * j + 1]); first = false; }
      else if (k > 0) p.lineTo(arcs.xy[2 * j], arcs.xy[2 * j + 1]);
    }
  }
  p.closePath();
}

function arcPath(p: Path2D, a: number, arcs: Arcs) {
  const s = arcs.off[a], e = arcs.off[a + 1];
  p.moveTo(arcs.xy[2 * s], arcs.xy[2 * s + 1]);
  for (let j = s + 1; j < e; j++) p.lineTo(arcs.xy[2 * j], arcs.xy[2 * j + 1]);
}

/**
 * For every arc, the coarsest level at which it separates two groups: an arc between 3511 and
 * 3512 only matters from 4 digits on, one between 1011 and 3512 already at 1 digit. Arcs on the
 * outside (coast, border) count from the first level.
 */
function arcLevels(rings: Int32Array[][], nArcs: number, key: (i: number) => string, first: number): Uint8Array {
  const u0 = new Int32Array(nArcs).fill(-1), u1 = new Int32Array(nArcs).fill(-1);
  rings.forEach((rs, i) => {
    for (const ring of rs)
      for (const ref of ring) {
        const a = ref < 0 ? ~ref : ref;
        if (u0[a] < 0) u0[a] = i;
        else if (u0[a] !== i) u1[a] = i;
      }
  });
  const lv = new Uint8Array(nArcs);
  for (let a = 0; a < nArcs; a++) {
    if (u0[a] < 0) { lv[a] = 255; continue; }
    if (u1[a] < 0) { lv[a] = first; continue; }
    const k0 = key(u0[a]), k1 = key(u1[a]);
    let cp = 0;
    while (cp < k0.length && k0[cp] === k1[cp]) cp++;
    lv[a] = cp >= k0.length ? 255 : first + cp;
  }
  return lv;
}

/**
 * One fillable shape for a whole group ("dissolve"): its boundary arcs (used once inside the
 * group) chained into closed rings, in the direction the features use them, so holes stay holes.
 * Region 3 becomes a few rings instead of 461 polygons, which makes zoomed-out frames cheap.
 */
function dissolvePath(rings: Int32Array[][], lo: number, hi: number, arcs: Arcs): Path2D {
  const count = new Map<number, number>();
  const dir = new Map<number, number>();
  for (let i = lo; i < hi; i++)
    for (const ring of rings[i])
      for (const ref of ring) {
        const a = ref < 0 ? ~ref : ref;
        count.set(a, (count.get(a) ?? 0) + 1);
        dir.set(a, ref);
      }
  const refs: number[] = [];
  for (const [a, c] of count) if (c === 1) refs.push(dir.get(a)!);
  const pt = (ref: number, end: boolean) => {
    const a = ref < 0 ? ~ref : ref;
    const atStart = (ref < 0) === end; // reversed arcs start at their last point
    const j = atStart ? arcs.off[a] : arcs.off[a + 1] - 1;
    return arcs.xy[2 * j] + ',' + arcs.xy[2 * j + 1];
  };
  const byStart = new Map<string, number[]>();
  refs.forEach((r, k) => {
    const key = pt(r, false);
    const l = byStart.get(key);
    if (l) l.push(k);
    else byStart.set(key, [k]);
  });
  const used = new Uint8Array(refs.length);
  const p = new Path2D();
  for (let k0 = 0; k0 < refs.length; k0++) {
    if (used[k0]) continue;
    let k = k0, first = true;
    while (k >= 0 && !used[k]) {
      used[k] = 1;
      const ref = refs[k], a = ref < 0 ? ~ref : ref;
      const s0 = arcs.off[a], e0 = arcs.off[a + 1];
      for (let q = 0; q < e0 - s0; q++) {
        const j = ref < 0 ? e0 - 1 - q : s0 + q;
        if (first) { p.moveTo(arcs.xy[2 * j], arcs.xy[2 * j + 1]); first = false; }
        else if (q > 0) p.lineTo(arcs.xy[2 * j], arcs.xy[2 * j + 1]);
      }
      const next = byStart.get(pt(ref, true));
      k = next?.find((n) => !used[n]) ?? -1;
    }
    p.closePath();
  }
  return p;
}

/** Outer boundary of a set of features: the arcs used exactly once. */
function outlinePath(rings: Int32Array[][], lo: number, hi: number, arcs: Arcs): Path2D {
  const count = new Map<number, number>();
  for (let i = lo; i < hi; i++)
    for (const ring of rings[i])
      for (const ref of ring) {
        const a = ref < 0 ? ~ref : ref;
        count.set(a, (count.get(a) ?? 0) + 1);
      }
  const p = new Path2D();
  for (const [a, c] of count) if (c === 1) arcPath(p, a, arcs);
  return p;
}

export function createRenderer(post: (m: FromRenderer) => void): (m: ToRenderer) => void {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let ctx: Ctx;
  let hit: Ctx;
  let w = 300, h = 300, dpr = 1;
  let insetTop = 0, insetBottom = 0;
  let theme: Theme;
  let reduceMotion = false;
  let pc6Dir = '';
  let adrDir = '';
  let meta: AtlasMeta | null = null;
  let geom: AtlasGeom;
  let baseArcs: Arcs;
  let arcLevel: Uint8Array;
  const lods: (Lod | undefined)[] = [];
  const pc4Paths = new Map<string, Path2D>();
  const pc4Outlines = new Map<string, Path2D>();
  const details = new Map<string, Detail | null | 'loading'>();
  const addrs = new Map<string, AdrData | null | 'loading'>();

  let requested = ''; // latest code from the UI
  let pending = ''; // code waiting for its PC6 file
  let shown = ''; // code the map rests on
  let trans: Trans | null = null;
  /** view-only animation (no change of postcode), e.g. when the info card changes size */
  let viewAnim: { f: (t: number) => View; t0: number; dur: number } | null = null;
  let view: View | null = null;
  let hover: Path2D | null = null;
  let scheduled = false;
  const textWidths = new Map<string, number>();

  // ---------- levels of detail ----------
  function buildLod(i: number): Lod {
    const m = meta!;
    const arcs = simplifyArcs(baseArcs, LOD_TOL[i]);
    const feat = geom.rings.map((rings) => {
      const p = new Path2D();
      for (const r of rings) ringPath(p, r, arcs);
      return p;
    });
    const all = group(m, '')!.bbox;
    const cw = (all[2] - all[0]) / GRID + 1e-6, ch = (all[3] - all[1]) / GRID + 1e-6;
    const cellOf = (x: number, y: number) =>
      Math.min(GRID - 1, Math.floor((x - all[0]) / cw)) * GRID + Math.min(GRID - 1, Math.floor((y - all[1]) / ch));
    const mk = (): Cell => ({ box: [Infinity, Infinity, -Infinity, -Infinity], path: new Path2D() });
    const grow = (b: Box, x0: number, y0: number, x1: number, y1: number) => {
      b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.max(b[2], x1); b[3] = Math.max(b[3], y1);
    };
    const fc = Array.from({ length: GRID * GRID }, mk);
    for (let k = 0; k < m.n; k++) {
      const c = fc[cellOf(m.lx[k], m.ly[k])];
      c.path.addPath(feat[k]);
      grow(c.box, m.bbox[k * 4], m.bbox[k * 4 + 1], m.bbox[k * 4 + 2], m.bbox[k * 4 + 3]);
    }
    const sc = [1, 2, 3, 4].map(() => Array.from({ length: GRID * GRID }, mk));
    for (let a = 0; a < arcs.off.length - 1; a++) {
      const s = arcs.off[a], e = arcs.off[a + 1];
      const cell = cellOf(arcs.xy[2 * s], arcs.xy[2 * s + 1]);
      for (let L = arcLevel[a]; L <= 4; L++) {
        const c = sc[L - 1][cell];
        arcPath(c.path, a, arcs);
        for (let j = s; j < e; j++) grow(c.box, arcs.xy[2 * j], arcs.xy[2 * j + 1], arcs.xy[2 * j], arcs.xy[2 * j + 1]);
      }
    }
    return {
      arcs, feat,
      fillCells: fc.filter((c) => c.box[0] !== Infinity),
      strokeCells: sc.map((cells) => cells.filter((c) => c.box[0] !== Infinity)),
    };
  }

  function lodFor(k: number): number {
    let want = 0;
    for (let i = 0; i < LOD_TOL.length; i++) if (LOD_TOL[i] <= 0.75 * k) want = i;
    for (let d = 0; d < LOD_TOL.length; d++) {
      if (lods[want - d]) return want - d;
      if (lods[want + d]) return want + d;
    }
    return 0;
  }

  function buildRemainingLods() {
    // finest first: it is the one needed when someone zooms in
    let next = -1;
    for (let i = 0; i < LOD_TOL.length; i++) if (!lods[i]) { next = i; break; }
    if (next < 0) return;
    lods[next] = buildLod(next);
    schedule();
    setTimeout(buildRemainingLods, 0);
  }

  // ---------- nodes: a node is any (partial) postcode, '' .. '3512AB' ----------
  const detailOf = (code: string): Detail | null => {
    const d = code.length >= 4 ? details.get(code.slice(0, 4)) : null;
    return d && d !== 'loading' ? d : null;
  };

  function kidsOf(code: string): string[] {
    if (!meta) return [];
    if (code.length < 4) return children(meta, code).map((g) => g.prefix);
    const d = detailOf(code);
    if (!d || code.length >= 6) return [];
    return children6(d.meta, code.slice(4)).map((g) => code.slice(0, 4) + g.letters);
  }

  function nodeBox(code: string): Box | null {
    if (code.length <= 4) return group(meta!, code)?.bbox ?? null;
    const d = detailOf(code);
    return (d && group6(d.meta, code.slice(4))?.bbox) || group(meta!, code.slice(0, 4))?.bbox || null;
  }

  function nodeFill(code: string, lod: number): Path2D | null {
    if (code.length <= 4) {
      const key = `${lod}|${code}`;
      let p = pc4Paths.get(key);
      if (!p) {
        const g = group(meta!, code);
        if (!g) return null;
        p = g.hi - g.lo === 1 ? lods[lod]!.feat[g.lo] : dissolvePath(geom.rings, g.lo, g.hi, lods[lod]!.arcs);
        pc4Paths.set(key, p);
      }
      return p;
    }
    const d = detailOf(code);
    if (!d) return null;
    const letters = code.slice(4);
    let p = d.paths.get(letters);
    if (!p) {
      const g = group6(d.meta, letters);
      if (!g) return null;
      p = new Path2D();
      for (let i = g.lo; i < g.hi; i++) p.addPath(d.feat[i]);
      d.paths.set(letters, p);
    }
    return p;
  }

  function nodeOutline(code: string, lod: number): Path2D | null {
    if (!code) return null;
    if (code.length <= 4) {
      const key = `${lod}|${code}`;
      let p = pc4Outlines.get(key);
      if (!p) {
        const g = group(meta!, code);
        if (!g) return null;
        p = outlinePath(geom.rings, g.lo, g.hi, lods[lod]!.arcs);
        pc4Outlines.set(key, p);
      }
      return p;
    }
    const d = detailOf(code);
    if (!d) return null;
    const letters = code.slice(4);
    let p = d.outlines.get(letters);
    if (!p) {
      const g = group6(d.meta, letters);
      if (!g) return null;
      p = outlinePath(d.geom.rings, g.lo, g.hi, { off: d.geom.arcOff, xy: d.geom.arcXY });
      d.outlines.set(letters, p);
    }
    return p;
  }

  function nodeLabel(code: string): { x: number; y: number; name: string; size: number } | null {
    if (code.length <= 4) {
      const g = group(meta!, code);
      return g && { x: g.lx, y: g.ly, name: g.name, size: Math.max(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1]) };
    }
    const d = detailOf(code);
    const g = d && group6(d.meta, code.slice(4));
    const name = g?.name || (group(meta!, code.slice(0, 4))?.name ?? '');
    return g ? { x: g.lx, y: g.ly, name, size: Math.max(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1]) } : null;
  }

  // ---------- PC6 files ----------
  /** Addresses of a PC4: fetched as soon as a letter is typed, drawn inside a 6-character postcode. */
  function ensureAddresses(pc4: string) {
    if (addrs.has(pc4) || !meta || !adrDir) return;
    addrs.set(pc4, 'loading');
    fetch(`${adrDir}/${pc4}.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        const data = buf ? decodeAdr(buf, pc4, meta!) : null;
        addrs.set(pc4, data);
        post({ t: 'adr', pc4, data });
      })
      .catch(() => {
        addrs.set(pc4, null);
        post({ t: 'adr', pc4, data: null });
      })
      .finally(() => {
        for (const k of [...addrs.keys()]) {
          if (addrs.size <= MAX_DETAILS) break;
          if (k !== requested.slice(0, 4) && addrs.get(k) !== 'loading') addrs.delete(k);
        }
        schedule();
      });
  }

  const addressesOf = (code: string): AdrData | null => {
    const a = code.length === 6 ? addrs.get(code.slice(0, 4)) : null;
    return a && a !== 'loading' ? a : null;
  };

  function ensureDetail(pc4: string) {
    if (details.has(pc4) || !meta || !group(meta, pc4)) return;
    details.set(pc4, 'loading');
    fetch(`${pc6Dir}/${pc4}.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (!buf) throw new Error('none');
        const { meta: m6, geom: g6 } = decodePc6(buf, pc4, meta!);
        const arcs = { off: g6.arcOff, xy: g6.arcXY };
        const feat = g6.rings.map((rings) => {
          const p = new Path2D();
          for (const r of rings) ringPath(p, r, arcs);
          return p;
        });
        const lv = arcLevels(g6.rings, g6.arcOff.length - 1, (i) => m6.codes[i], 5);
        const borders: [Path2D, Path2D] = [new Path2D(), new Path2D()];
        for (let a = 0; a < g6.arcOff.length - 1; a++) {
          if (lv[a] <= 5) arcPath(borders[0], a, arcs);
          if (lv[a] <= 6) arcPath(borders[1], a, arcs);
        }
        details.set(pc4, { meta: m6, geom: g6, feat, borders, paths: new Map(), outlines: new Map() });
        post({ t: 'pc6', pc4, meta: m6 });
      })
      .catch(() => {
        details.set(pc4, null);
        post({ t: 'pc6', pc4, meta: null });
      })
      .finally(() => {
        // forget old files (never the ones in use)
        for (const k of [...details.keys()]) {
          if (details.size <= MAX_DETAILS) break;
          if (k !== shown.slice(0, 4) && k !== requested.slice(0, 4) && details.get(k) !== 'loading') details.delete(k);
        }
        onDetail(pc4);
      });
  }

  function onDetail(pc4: string) {
    if (pending.slice(0, 4) === pc4) {
      const c = pending;
      pending = '';
      go(c);
    } else if (shown.slice(0, 4) === pc4 && !trans && shown.length === 4) {
      // the PC4 we rest on just got its letters: let them appear
      go(shown, true);
    } else schedule();
  }

  // ---------- view + transitions ----------
  function targetView(code: string): View {
    const m = meta!;
    const box = nodeBox(code) ?? group(m, '')!.bbox;
    const leaf = kidsOf(code).length === 0;
    const pad = leaf ? (code.length === 6 ? 1.6 : 1.9) : 1.12;
    // fit into the part of the canvas not covered by the info card
    const top = Math.min(insetTop, h * 0.4), bottom = Math.min(insetBottom, h * 0.2);
    const hh = Math.max(40, h - top - bottom);
    const k = Math.max(((box[2] - box[0]) * pad) / w, ((box[3] - box[1]) * pad) / hh, 0.4 / m.q);
    return { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 - ((top - bottom) / 2) * k, k };
  }

  /** Van Wijk & Nuij smooth zoom (as in d3.interpolateZoom). */
  function zoomInterp(a: View, b: View): { f: (t: number) => View; S: number } {
    const rho = 1.4, rho2 = rho * rho, rho4 = rho2 * rho2;
    const size = Math.max(w, h);
    const w0 = a.k * size, w1 = b.k * size;
    const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 < 1e-6) {
      const S = Math.log(w1 / w0) / rho;
      return { S: Math.abs(S), f: (t) => ({ x: a.x + t * dx, y: a.y + t * dy, k: (w0 * Math.exp(rho * t * S)) / size }) };
    }
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const S = (r1 - r0) / rho;
    const c0 = Math.cosh(r0);
    return {
      S: Math.abs(S),
      f: (t) => {
        const s = t * S;
        const u = (w0 / (rho2 * d1)) * (c0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
        return { x: a.x + u * dx, y: a.y + u * dy, k: (w0 * c0) / Math.cosh(rho * s + r0) / size };
      },
    };
  }

  /** Start the transition to `to`. `refresh`: same code, but its sub-areas just became available. */
  function go(to: string, refresh = false) {
    if (!meta) return;
    if (to.length >= 4) ensureDetail(to.slice(0, 4));
    if (to.length >= 5) ensureAddresses(to.slice(0, 4));
    if (to.length > 4 && !detailOf(to)) {
      // letters typed before the PC6 file arrived: go to the PC4 first, continue when it is loaded
      pending = details.get(to.slice(0, 4)) === null ? '' : to;
      to = to.slice(0, 4);
    }
    viewAnim = null;
    const interrupted = !!trans;
    const from = trans ? trans.to : shown;
    if (from === to && !refresh && !interrupted) return;
    const v0 = view ?? targetView(to);
    const v1 = targetView(to);
    if (reduceMotion || !view) {
      shown = to;
      trans = null;
      view = v1;
      schedule();
      return;
    }
    const forward = to !== from && to.startsWith(from);
    const backward = to !== from && from.startsWith(to);
    const moving = Math.abs(Math.log(v1.k / v0.k)) > 0.01 || Math.hypot(v1.x - v0.x, v1.y - v0.y) / v1.k > 1;
    const { f, S } = zoomInterp(v0, v1);
    trans = {
      from, to,
      x: refresh || forward ? to : from,
      y: refresh || !backward ? to : from,
      t0: performance.now(),
      d1: interrupted || refresh ? 0 : forward ? 170 : kidsOf(from).length ? 190 : 90,
      d2: moving ? Math.min(750, Math.max(300, S * 330)) : 0,
      d3: kidsOf(to).length ? 230 : 140,
      v0,
      zoom: moving ? f : null,
    };
    schedule();
  }

  // ---------- drawing ----------
  function schedule() {
    if (scheduled || !meta) return;
    scheduled = true;
    raf(frame);
  }

  function frame(now: number) {
    scheduled = false;
    if (!view) return;
    // layer opacities: a = state(from), hx/hy = highlights, b = state(to)
    let a = 0, hx = 0, hy = 0, b = 1;
    const t = trans;
    if (t) {
      const e = now - t.t0;
      if (e < t.d1) {
        a = 1 - smooth(e / t.d1);
        hx = 1;
        b = 0;
        view = t.v0;
      } else if (e < t.d1 + t.d2) {
        const p = (e - t.d1) / t.d2;
        if (t.zoom) view = t.zoom(ease(p));
        b = 0;
        if (t.x === t.y) hx = 1;
        else { hx = 1 - p; hy = p; }
      } else if (e < t.d1 + t.d2 + t.d3) {
        view = targetView(t.to);
        if (t.x === t.y) hx = 1;
        else hy = 1;
        b = smooth((e - t.d1 - t.d2) / t.d3);
      } else {
        view = targetView(t.to);
        shown = t.to;
        trans = null;
      }
    }
    if (!t && viewAnim) {
      const p = Math.min(1, (now - viewAnim.t0) / viewAnim.dur);
      view = viewAnim.f(ease(p));
      if (p >= 1) viewAnim = null;
    }
    draw(t && trans ? t : null, a, hx, hy, b);
    if (trans || viewAnim) schedule();
  }

  const hits = (b: ArrayLike<number>, v: Box) => b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1];
  const color = (code: string) => theme.palette[colorSlot(code)];

  function draw(t: Trans | null, a: number, hx: number, hy: number, b: number) {
    const v = view!;
    const from = t ? t.from : shown, to = t ? t.to : shown;
    const lod = lodFor(v.k);
    const L = lods[lod]!;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = dpr / v.k;
    ctx.setTransform(s, 0, 0, s, (w / 2) * dpr - v.x * s, (h / 2) * dpr - v.y * s);
    const vis: Box = [v.x - (w / 2) * v.k, v.y - (h / 2) * v.k, v.x + (w / 2) * v.k, v.y + (h / 2) * v.k];

    // land: the dissolved country when much of it is in view, else only the visible cells
    ctx.fillStyle = theme.land;
    const visCells = L.fillCells.filter((c) => hits(c.box, vis));
    if (visCells.length > L.fillCells.length / 4) ctx.fill(nodeFill('', lod)!);
    else for (const c of visCells) ctx.fill(c.path);

    // layers, bottom to top: highlight x, highlight y, state(from), state(to)
    const layers: Layer[] = [];
    if (t) {
      if (hx > 0) layers.push({ kind: 'hl', code: t.x, alpha: hx });
      if (hy > 0 && t.y !== t.x) layers.push({ kind: 'hl', code: t.y, alpha: hy });
      if (a > 0) layers.push({ kind: 'state', code: from, alpha: a });
    }
    if (b > 0) layers.push({ kind: 'state', code: to, alpha: b });

    const fillsOf = (l: Layer): string[] => {
      if (l.kind === 'hl') return l.code ? [l.code] : [];
      const kids = kidsOf(l.code);
      return kids.length ? kids : l.code ? [l.code] : [];
    };
    const fillPass = (fine: boolean) => {
      for (const l of layers) {
        for (const c of fillsOf(l)) {
          if (c.length > 4 !== fine) continue;
          const box = nodeBox(c);
          if (!box || !hits(box, vis)) continue;
          const p = nodeFill(c, lod);
          if (!p) continue;
          ctx.globalAlpha = l.alpha;
          ctx.fillStyle = color(c);
          ctx.fill(p);
        }
      }
      ctx.globalAlpha = 1;
    };

    // Borders: only those of the level below the one you are on (zoomed out: the 9 regions,
    // not all 4070 postcodes). During a transition the finer level fades in or out.
    fillPass(false);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 0.8 * v.k;
    const strokeLevel = (lvl: number, alpha: number) => {
      if (alpha <= 0.01) return;
      ctx.globalAlpha = alpha;
      for (const c of L.strokeCells[lvl - 1]) if (hits(c.box, vis)) ctx.stroke(c.path);
    };
    const lf = Math.min(4, from.length + 1), lt = Math.min(4, to.length + 1), base = Math.min(lf, lt);
    strokeLevel(base, 1);
    if (lf > base) strokeLevel(lf, a);
    if (lt > base) strokeLevel(lt, b);
    ctx.globalAlpha = 1;

    // 6-character postcodes inside the PC4 we are in, with the same rule for their borders
    fillPass(true);
    ctx.lineWidth = 0.7 * v.k;
    const pc6Borders = (dd: Detail | null, lvl: number, alpha: number) => {
      if (!dd || !lvl || alpha <= 0.01) return;
      ctx.globalAlpha = alpha;
      ctx.stroke(dd.borders[lvl - 5]);
    };
    const l6 = (c: string) => (c.length >= 4 ? Math.min(6, c.length + 1) : 0);
    const pf = l6(from), pt = l6(to);
    if (pf && pt && from.slice(0, 4) === to.slice(0, 4)) {
      const d = detailOf(to), b6 = Math.min(pf, pt);
      pc6Borders(d, b6, 1);
      if (pf > b6) pc6Borders(d, pf, a);
      if (pt > b6) pc6Borders(d, pt, b);
    } else {
      pc6Borders(detailOf(from), pf, a);
      pc6Borders(detailOf(to), pt, b);
    }
    ctx.globalAlpha = 1;

    // outlines: highlighted areas, the leaf we rest on, the hovered area
    ctx.strokeStyle = theme.ink;
    const outline = (code: string, alpha: number, px: number) => {
      const p = alpha > 0.01 ? nodeOutline(code, lod) : null;
      if (!p) return;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = px * v.k;
      ctx.stroke(p);
    };
    for (const l of layers) {
      if (l.kind === 'hl') outline(l.code, l.alpha * (1 - b), 2.2);
      else if (!kidsOf(l.code).length) outline(l.code, l.alpha, 2.5);
    }
    ctx.globalAlpha = 1;
    if (hover) {
      ctx.lineWidth = 1.5 * v.k;
      ctx.stroke(hover);
    }

    labels(vis, layers, a, b);
  }

  function labels(vis: Box, layers: Layer[], a: number, b: number) {
    const m = meta!, v = view!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed: Box[] = [];
    const named = new Set<string>();
    const width = (font: string, text: string) => {
      const key = font + '|' + text;
      let wv = textWidths.get(key);
      if (wv === undefined) {
        ctx.font = font;
        wv = ctx.measureText(text).width;
        if (textWidths.size > 4000) textWidths.clear();
        textWidths.set(key, wv);
      }
      return wv;
    };
    const sx = (x: number) => (x - v.x) / v.k + w / 2;
    const sy = (y: number) => (y - v.y) / v.k + h / 2;
    const put = (x: number, y: number, big: string, small: string, bigPx: number, strong: boolean, alpha: number, muted = false): boolean => {
      if (alpha < 0.02) return true;
      const bigFont = `700 ${bigPx}px ${theme.font}`, smallFont = `500 12px ${theme.font}`;
      const bw = width(bigFont, big);
      const sw = small ? width(smallFont, small) : 0;
      const bh = bigPx + (small ? 14 : 0);
      const half = Math.max(bw, sw) / 2 + 4;
      const box: Box = [x - half, y - bh / 2 - 2, x + half, y + bh / 2 + 2];
      if (box[0] < 2 || box[2] > w - 2 || box[1] < 2 || box[3] > h - 2) return false;
      if (!strong && placed.some((p) => p[0] < box[2] && p[2] > box[0] && p[1] < box[3] && p[3] > box[1])) return false;
      placed.push(box);
      const yBig = small ? y - 7 : y;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = theme.halo;
      ctx.fillStyle = muted ? theme.muted : theme.text;
      ctx.font = `700 ${bigPx}px ${theme.font}`;
      ctx.strokeText(big, x, yBig);
      ctx.fillText(big, x, yBig);
      if (small) {
        ctx.font = `500 12px ${theme.font}`;
        ctx.strokeText(small, x, yBig + bigPx / 2 + 7);
        ctx.fillText(small, x, yBig + bigPx / 2 + 7);
      }
      return true;
    };

    // the highlighted area first (never hidden), then the sub-areas, then context
    for (const l of layers) {
      if (l.kind !== 'hl' || !l.code) continue;
      const n = nodeLabel(l.code);
      if (n) put(sx(n.x), sy(n.y), formatCode(l.code), n.name, 20, true, l.alpha * (1 - a) * (1 - b));
    }
    for (const l of layers) {
      if (l.kind !== 'state') continue;
      const kids = kidsOf(l.code);
      if (!kids.length) {
        const n = l.code ? nodeLabel(l.code) : null;
        const ad = addressesOf(l.code);
        if (n && ad) {
          // the code goes above the area, the area itself shows its addresses
          const box = nodeBox(l.code)!;
          put(sx((box[0] + box[2]) / 2), Math.max(22, sy(box[1]) - 22), formatCode(l.code), n.name, 18, true, l.alpha);
        } else if (n) put(sx(n.x), sy(n.y), formatCode(l.code), n.name, 20, true, l.alpha);
        if (ad) {
          // one dot per house number (apartments share it), street names, then the numbers
          const [lo, hi] = adrRange(ad, l.code.slice(4));
          const pts = new Map<string, { s: number; nr: number; x: number; y: number; n: number }>();
          for (let i = lo; i < hi; i++) {
            const key = ad.street[i] + '|' + ad.nr[i];
            const pt = pts.get(key);
            if (pt) { pt.x += ad.x[i]; pt.y += ad.y[i]; pt.n++; }
            else pts.set(key, { s: ad.street[i], nr: ad.nr[i], x: ad.x[i], y: ad.y[i], n: 1 });
          }
          const list = [...pts.values()].map((pt) => ({ ...pt, X: sx(pt.x / pt.n), Y: sy(pt.y / pt.n) }));
          ctx.globalAlpha = l.alpha;
          ctx.fillStyle = theme.ink;
          ctx.strokeStyle = theme.halo;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (const pt of list) {
            ctx.moveTo(pt.X + 3, pt.Y);
            ctx.arc(pt.X, pt.Y, 3, 0, Math.PI * 2);
          }
          ctx.stroke();
          ctx.fill();
          const streets = new Map<number, { x: number; y: number; n: number }>();
          for (const pt of list) {
            const st = streets.get(pt.s);
            if (st) { st.x += pt.X; st.y += pt.Y; st.n++; }
            else streets.set(pt.s, { x: pt.X, y: pt.Y, n: 1 });
          }
          for (const [si, st] of streets) put(st.x / st.n, st.y / st.n + 16, ad.strings[si], '', 13, false, l.alpha);
          for (const pt of list.sort((p, q) => p.nr - q.nr)) put(pt.X, pt.Y - 10, String(pt.nr), '', 10, false, l.alpha, true);
        }
        continue;
      }
      const ordered: { c: string; n: NonNullable<ReturnType<typeof nodeLabel>> }[] = [];
      for (const c of kids) {
        const n = nodeLabel(c), box = nodeBox(c);
        if (n && box && hits(box, vis)) ordered.push({ c, n });
      }
      if (l.code.length < 4) ordered.sort((p, q) => (group(m, q.c)?.inw ?? 0) - (group(m, p.c)?.inw ?? 0));
      else ordered.sort((p, q) => q.n.size - p.n.size);
      const px = l.code.length === 0 ? 22 : l.code.length >= 4 ? 14 : 16;
      for (const { c, n } of ordered) {
        const size = n.size / v.k;
        if (size < (c.length > 4 ? 14 : 26)) continue;
        const text = c.length > 4 ? c.slice(4) : c;
        const x = sx(n.x), y = sy(n.y);
        // place names down to PC4, buurt names below that; each name only once
        const name = named.has(n.name) ? '' : n.name;
        if (size > (c.length === 6 ? 46 : 70) && name && put(x, y, text, name, px, false, l.alpha)) named.add(name);
        else put(x, y, text, '', px, false, l.alpha);
      }
    }
    // neighbouring PC4s for context once you are inside one
    let deepAlpha = 0, cur = '';
    for (const l of layers) if (l.code.length >= 4 && l.alpha >= deepAlpha) { deepAlpha = l.alpha; cur = l.code.slice(0, 4); }
    if (deepAlpha > 0) {
      const order: number[] = [];
      for (let i = 0; i < m.n; i++) if (String(m.pc[i]) !== cur && hits(m.bbox.subarray(i * 4, i * 4 + 4), vis)) order.push(i);
      order.sort((p, q) => m.inw[q] - m.inw[p]);
      for (const i of order) {
        const size = Math.min(m.bbox[i * 4 + 2] - m.bbox[i * 4], m.bbox[i * 4 + 3] - m.bbox[i * 4 + 1]) / v.k;
        if (size > 40) put(sx(m.lx[i]), sy(m.ly[i]), String(m.pc[i]), '', 12, false, deepAlpha, true);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- pointer ----------
  /** Full code + shape of what is under (x, y) in CSS pixels. */
  function hitTest(x: number, y: number): { code: string; path: Path2D } | null {
    if (!meta || !view) return null;
    const m = meta, wx = view.x + (x - w / 2) * view.k, wy = view.y + (y - h / 2) * view.k;
    const d = detailOf(trans ? trans.to : shown);
    if (d) {
      const m6 = d.meta;
      for (let i = 0; i < m6.n; i++) {
        const b = i * 4;
        if (wx < m6.bbox[b] || wx > m6.bbox[b + 2] || wy < m6.bbox[b + 1] || wy > m6.bbox[b + 3]) continue;
        if (hit.isPointInPath(d.feat[i], wx, wy)) return { code: m6.pc4 + m6.codes[i], path: d.feat[i] };
      }
    }
    const L = lods[0] ?? lods[lodFor(view.k)]!;
    for (let i = 0; i < m.n; i++) {
      const b = i * 4;
      if (wx < m.bbox[b] || wx > m.bbox[b + 2] || wy < m.bbox[b + 1] || wy > m.bbox[b + 3]) continue;
      if (hit.isPointInPath(L.feat[i], wx, wy)) return { code: String(m.pc[i]), path: L.feat[i] };
    }
    return null;
  }

  function resize(nw: number, nh: number, ndpr: number) {
    w = Math.max(1, nw);
    h = Math.max(1, nh);
    dpr = Math.min(2, ndpr || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (meta) {
      if (trans) {
        shown = trans.to;
        trans = null;
      }
      view = targetView(shown);
      schedule();
    }
  }

  return (msg: ToRenderer) => {
    switch (msg.t) {
      case 'init': {
        canvas = msg.canvas;
        ctx = canvas.getContext('2d', { alpha: false }) as Ctx;
        const hc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
        hit = hc.getContext('2d') as Ctx;
        theme = msg.theme;
        reduceMotion = msg.reduceMotion;
        requested = msg.code;
        pc6Dir = msg.pc6Dir;
        adrDir = msg.adrDir;
        resize(msg.w, msg.h, msg.dpr);
        break;
      }
      case 'data':
        try {
          const d = decodeAtlas(msg.buf);
          meta = d.meta;
          geom = d.geom;
          baseArcs = { off: d.geom.arcOff, xy: d.geom.arcXY };
          arcLevel = arcLevels(geom.rings, d.geom.arcOff.length - 1, (i) => String(d.meta.pc[i]), 1);
          // the country view needs a coarse level: build that first, the others right after
          lods[2] = buildLod(2);
          let start = requested.slice(0, 4);
          while (start && !group(meta, start)) start = start.slice(0, -1);
          shown = start;
          if (shown.length >= 4) ensureDetail(shown.slice(0, 4)); // a deep link to a PC4 needs its letters too
          view = targetView(shown);
          schedule();
          post({ t: 'ready', meta });
          setTimeout(buildRemainingLods, 0);
          if (requested !== shown) go(requested);
        } catch (e) {
          post({ t: 'error', message: String(e) });
        }
        break;
      case 'resize':
        resize(msg.w, msg.h, msg.dpr);
        break;
      case 'theme':
        theme = msg.theme;
        schedule();
        break;
      case 'insets':
        if (Math.abs(msg.top - insetTop) < 2 && Math.abs(msg.bottom - insetBottom) < 2) break;
        insetTop = msg.top;
        insetBottom = msg.bottom;
        if (!meta || !view) break;
        if (trans) {
          if (trans.zoom) trans.zoom = zoomInterp(trans.v0, targetView(trans.to)).f;
        } else {
          viewAnim = { f: zoomInterp(view, targetView(shown)).f, t0: performance.now(), dur: reduceMotion ? 1 : 260 };
          schedule();
        }
        break;
      case 'code':
        requested = msg.code;
        pending = '';
        hover = null;
        go(msg.code);
        break;
      case 'hover': {
        const r = msg.x < 0 ? null : hitTest(msg.x, msg.y);
        if ((r?.path ?? null) !== hover) {
          hover = r?.path ?? null;
          schedule();
        }
        break;
      }
      case 'pick':
        post({ t: 'pick', code: hitTest(msg.x, msg.y)?.code ?? '' });
        break;
    }
  };
}
