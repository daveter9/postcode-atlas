// Turns the raw CBS PC4 polygons + GeoNames names into one small, content-hashed binary file
// in public/data/. The app is fully static: this file is the only data the browser downloads.
//
// Format (all integers are unsigned LEB128 varints, "z" = zigzag-encoded signed varint):
//   "PC4A" version Q x0 y0
//   nStrings { len utf8-bytes }*
//   nArcs { nPts  z(dx) z(dy) ... }*            coordinates in units of Q metres (RD New), delta coded
//   nFeat { dPostcode inwoners nPlaces placeIdx* gemIdx provIdx z(dLabelX) z(dLabelY)
//           nPolys { nRings { nRefs { (z(dArc) << 1) | reversed }* }* }* }*
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import polylabel from 'polylabel';

const root = new URL('../', import.meta.url);
const p = (rel) => new URL(rel, root);
const SIMPLIFY_M = Number(process.env.SIMPLIFY_M ?? 30); // Douglas-Peucker tolerance in metres
const Q = Number(process.env.QUANT_M ?? 5); // coordinate grid in metres

// 1. Topology-preserving simplification (shared borders stay shared) -> TopoJSON
const topoPath = p('data-raw/pc4.topo.json');
execFileSync(
  process.execPath,
  [
    p('node_modules/mapshaper/bin/mapshaper').pathname.replace(/^\/(\w:)/, '$1'),
    p('data-raw/pc4.geojson').pathname.replace(/^\/(\w:)/, '$1'),
    '-simplify', `interval=${SIMPLIFY_M}`, 'keep-shapes',
    '-filter-slivers', 'min-area=2000',
    '-o', 'format=topojson', 'no-quantization', 'force',
    topoPath.pathname.replace(/^\/(\w:)/, '$1'),
  ],
  { stdio: 'inherit' },
);
const topo = JSON.parse(await readFile(topoPath, 'utf8'));
const geoms = Object.values(topo.objects)[0].geometries;

// 2. Names from GeoNames (one PC4 can cover several places)
const PROV = {
  Drenthe: 'Drenthe', Flevoland: 'Flevoland', Friesland: 'Fryslân', Groningen: 'Groningen',
  Guelders: 'Gelderland', Limburg: 'Limburg', 'North Brabant': 'Noord-Brabant',
  'North Holland': 'Noord-Holland', Overijssel: 'Overijssel', 'South Holland': 'Zuid-Holland',
  Utrecht: 'Utrecht', Zeeland: 'Zeeland',
};
const names = new Map();
for (const line of (await readFile(p('data-raw/NL.txt'), 'utf8')).split('\n')) {
  const c = line.split('\t');
  if (c.length < 7) continue;
  const pc = Number(c[1]);
  const e = names.get(pc) ?? { places: [], gem: '', prov: '' };
  if (!e.places.includes(c[2])) e.places.push(c[2]);
  e.gem ||= c[5].replace(/ Municipality$/, '').replace(/^Gemeente /, '');
  e.prov ||= PROV[c[3]] ?? c[3];
  names.set(pc, e);
}
const nameFor = (pc) => {
  if (names.has(pc)) return names.get(pc);
  for (let d = 1; d < 10; d++) for (const q of [pc - d, pc + d]) if (names.has(q) && ((q / 10) | 0) === ((pc / 10) | 0)) return names.get(q);
  return { places: [], gem: '', prov: '' };
};

// 3. Quantise arcs
let minX = Infinity, minY = Infinity;
for (const arc of topo.arcs) for (const [x, y] of arc) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
const x0 = Math.floor(minX), y0 = Math.floor(minY);
const qArcs = topo.arcs.map((arc) => {
  const out = [];
  for (const [x, y] of arc) {
    const qx = Math.round((x - x0) / Q), qy = Math.round((y - y0) / Q);
    const l = out[out.length - 1];
    if (!l || l[0] !== qx || l[1] !== qy) out.push([qx, qy]);
  }
  if (out.length === 1) out.push(out[0]);
  return out;
});

// 4. Encode
const bytes = [];
const u = (v) => { do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; bytes.push(b); } while (v); };
const z = (v) => u(v < 0 ? -2 * v - 1 : 2 * v);
const strings = [], strIdx = new Map();
const s = (str) => { if (!strIdx.has(str)) { strIdx.set(str, strings.length); strings.push(str); } return strIdx.get(str); };

const feats = geoms
  .filter((g) => g.type === 'Polygon' || g.type === 'MultiPolygon')
  .map((g) => {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    // label point: polylabel on the largest polygon (in quantised coords)
    let best = null, bestA = -1;
    for (const poly of polys) {
      const rings = poly.map((refs) => ringCoords(refs));
      const a = Math.abs(area(rings[0]));
      if (a > bestA) { bestA = a; best = rings; }
    }
    const [lx, ly] = polylabel(best, 1);
    const n = nameFor(g.properties.pc);
    return {
      pc: g.properties.pc, inw: Math.max(0, g.properties.inw | 0), polys,
      lx: Math.round(lx), ly: Math.round(ly),
      places: n.places.slice(0, 4).map(s), gem: s(n.gem), prov: s(n.prov),
    };
  })
  .sort((a, b) => a.pc - b.pc);

function ringCoords(refs) {
  const pts = [];
  for (const r of refs) {
    const a = r >= 0 ? qArcs[r] : qArcs[~r].slice().reverse();
    for (let i = pts.length ? 1 : 0; i < a.length; i++) pts.push(a[i]);
  }
  return pts;
}
function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

for (const c of 'PC4A') bytes.push(c.charCodeAt(0));
u(1); u(Q); u(x0); u(y0);
u(strings.length);
for (const str of strings) { const b = Buffer.from(str, 'utf8'); u(b.length); bytes.push(...b); }
u(qArcs.length);
let px = 0, py = 0;
for (const arc of qArcs) {
  u(arc.length);
  for (const [x, y] of arc) { z(x - px); z(y - py); px = x; py = y; }
}
u(feats.length);
let ppc = 0, plx = 0, ply = 0;
for (const f of feats) {
  u(f.pc - ppc); ppc = f.pc;
  u(f.inw);
  u(f.places.length); f.places.forEach(u);
  u(f.gem); u(f.prov);
  z(f.lx - plx); z(f.ly - ply); plx = f.lx; ply = f.ly;
  u(f.polys.length);
  let pa = 0;
  for (const poly of f.polys) {
    u(poly.length);
    for (const ring of poly) {
      u(ring.length);
      for (const r of ring) {
        const idx = r >= 0 ? r : ~r;
        const d = idx - pa; pa = idx;
        u((d < 0 ? -2 * d - 1 : 2 * d) * 2 + (r < 0 ? 1 : 0));
      }
    }
  }
}

// 5. Write content-hashed file, wire it into the app + preload hint
const buf = Buffer.from(bytes);
const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
const file = `pc4.${hash}.bin`;
await mkdir(p('public/data/'), { recursive: true });
for (const old of await readdir(p('public/data/'))) if (/^pc4\..*\.bin$/.test(old)) await unlink(p(`public/data/${old}`));
await writeFile(p(`public/data/${file}`), buf);
await writeFile(p('src/app/data-file.ts'), `// Generated by scripts/build-data.mjs\nexport const DATA_FILE = 'data/${file}';\n`);
const indexPath = p('src/index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace(/data\/pc4\.[^"]*\.bin/g, `data/${file}`));

const pts = qArcs.reduce((n, a) => n + a.length, 0);
const kb = (n) => (n / 1024).toFixed(0) + ' kB';
console.log(
  `${feats.length} postcodes, ${qArcs.length} arcs, ${pts} points -> ${file}: ${kb(buf.length)} raw, ` +
  `${kb(gzipSync(buf, { level: 9 }).length)} gzip, ` +
  `${kb(brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } }).length)} brotli`,
);
