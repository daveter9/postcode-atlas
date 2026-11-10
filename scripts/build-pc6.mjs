// Builds one small binary per PC4 with its 6-character postcodes (PC6), loaded by the app only
// when someone zooms into that PC4. Source: CBS "Statistische gegevens per postcode" 2024 (GeoPackage).
//
// Output: public/data/pc6-<hash>/<pc4>.bin   (the directory hash changes whenever any file changes,
//         so every file can be cached forever)
//
// Buurt and wijk names: CBS "Buurt, wijk en gemeente 2026 voor postcode huisnummer"; a PC6 gets
// the buurt/wijk where most of its addresses are.
//
// Format (u = unsigned LEB128 varint, z = zigzag varint), coordinates in metres (RD New):
//   "PC6A" version(2) ox oy
//   nStrings { len utf8 }*                                 buurt + wijk names used in this file
//   nArcs { nPts z(dx) z(dy) ... }                         delta coded, relative to (ox, oy)
//   nFeat { u(l1*26+l2) inw+1 won+1 hh+1 woz+1 koop+1      (0 = unknown / shielded by CBS)
//           buurt+1 wijk+1                                 (string index, 0 = none)
//           z(dLabelX) z(dLabelY) nRings { nRefs { (z(dArc) << 1) | reversed }* }* }*
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { brotliCompressSync, constants } from 'node:zlib';
import mapshaper from 'mapshaper';
import polylabel from 'polylabel';

const root = new URL('../', import.meta.url);
const p = (rel) => new URL(rel, root);
const SIMPLIFY_M = Number(process.env.PC6_SIMPLIFY_M ?? 3);
const GPKG = p('data-raw/cbs_pc6_2024_v2.gpkg');

// ---------- read GeoPackage ----------
function parseGeom(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const env = (b[3] >> 1) & 7;
  let o = 8 + [0, 32, 48, 48, 64][env];
  const polys = [];
  const readPoly = () => {
    const le = b[o] === 1;
    const type = dv.getUint32(o + 1, le) % 1000;
    o += 5;
    if (type !== 3) throw new Error('expected polygon, got ' + type);
    const rings = [];
    for (let nr = dv.getUint32(o, le), r = (o += 4, 0); r < nr; r++) {
      const np = dv.getUint32(o, le);
      o += 4;
      const ring = new Array(np);
      for (let k = 0; k < np; k++, o += 16) ring[k] = [dv.getFloat64(o, le), dv.getFloat64(o + 8, le)];
      rings.push(ring);
    }
    polys.push(rings);
  };
  const le = b[o] === 1;
  const type = dv.getUint32(o + 1, le) % 1000;
  if (type === 3) readPoly();
  else if (type === 6) {
    const n = dv.getUint32(o + 5, le);
    o += 9;
    for (let i = 0; i < n; i++) readPoly();
  } else throw new Error('unsupported geometry type ' + type);
  return polys;
}

// ---------- buurt / wijk per PC6 (majority of addresses) ----------
async function readNames(file) {
  const m = new Map();
  const text = (await readFile(p(`data-raw/gwb/${file}`), 'utf8')).replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [code, name] = line.split(';');
    if (code && name) m.set(code.trim(), name.trim());
  }
  return m;
}
const buurtNames = await readNames('buurt_2026.csv');
const wijkNames = await readNames('wijk_2026.csv');
const votes = new Map(); // pc6 -> Map("buurt;wijk" -> address count)
{
  const rl = createInterface({ input: createReadStream(p('data-raw/gwb/pc6hnr20260801_gwb.csv')) });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    const c = line.split(';');
    if (c.length < 4) continue;
    const pc6 = c[0].toUpperCase();
    let v = votes.get(pc6);
    if (!v) votes.set(pc6, (v = new Map()));
    const k = `${c[2]};${c[3]}`;
    v.set(k, (v.get(k) ?? 0) + 1);
  }
}
const area6 = (pc6) => {
  const v = votes.get(pc6);
  if (!v) return { buurt: '', wijk: '' };
  let best = '', n = -1;
  for (const [k, c] of v) if (c > n) { n = c; best = k; }
  const [b, w] = best.split(';');
  return { buurt: buurtNames.get(b) ?? '', wijk: wijkNames.get(w) ?? '' };
};
console.log(`buurt/wijk for ${votes.size} PC6`);

const known = new Set(
  (await readFile(p('src/app/data-file.ts'), 'utf8')) && // PC4 data must exist first
    JSON.parse(await readFile(p('data-raw/pc4.topo.json'), 'utf8')).objects.pc4.geometries.map((g) => String(g.properties.pc)),
);

const db = new DatabaseSync(GPKG.pathname.replace(/^\/(\w:)/, '$1'), { readOnly: true });
const byChunk = new Map(); // first two digits -> features
const val = (v) => (typeof v === 'number' && v >= 0 ? Math.round(v) + 1 : 0);
let total = 0;
for (const r of db
  .prepare(
    `select postcode6, geom, aantal_inwoners inw, aantal_woningen won, aantal_part_huishoudens hh,
            gemiddelde_woz_waarde_woning woz, percentage_koopwoningen koop from cbs_pc6_2024`,
  )
  .iterate()) {
  const pc6 = String(r.postcode6).toUpperCase();
  if (!/^\d{4}[A-Z]{2}$/.test(pc6) || !known.has(pc6.slice(0, 4)) || !r.geom) continue;
  const chunk = pc6.slice(0, 2);
  if (!byChunk.has(chunk)) byChunk.set(chunk, []);
  byChunk.get(chunk).push({
    type: 'Feature',
    properties: { pc6, inw: val(r.inw), won: val(r.won), hh: val(r.hh), woz: val(r.woz), koop: val(r.koop), ...area6(pc6) },
    geometry: { type: 'MultiPolygon', coordinates: parseGeom(r.geom) },
  });
  total++;
}
console.log(`${total} PC6 areas in ${byChunk.size} chunks`);

// ---------- simplify per chunk (shared borders stay shared), encode per PC4 ----------
const files = new Map();
let pts = 0;
for (const [chunk, features] of [...byChunk].sort()) {
  const out = await mapshaper.applyCommands(
    `-i in.json -simplify interval=${SIMPLIFY_M} keep-shapes -o out.json format=topojson no-quantization`,
    { 'in.json': { type: 'FeatureCollection', features } },
  );
  const topo = JSON.parse(out['out.json']);
  const geoms = Object.values(topo.objects)[0].geometries.filter((g) => g.type === 'Polygon' || g.type === 'MultiPolygon');
  const byPc4 = new Map();
  for (const g of geoms) {
    const k = g.properties.pc6.slice(0, 4);
    if (!byPc4.has(k)) byPc4.set(k, []);
    byPc4.get(k).push(g);
  }
  for (const [pc4, gs] of byPc4) {
    const { buf, n } = encode(gs, topo.arcs);
    files.set(pc4, buf);
    pts += n;
  }
  process.stdout.write(`${chunk} `);
}
console.log();

function encode(geoms, allArcs) {
  // collect + quantise the arcs this PC4 uses
  const remap = new Map();
  const arcs = [];
  const ringsOf = (g) => (g.type === 'Polygon' ? g.arcs : g.arcs.flat());
  for (const g of geoms)
    for (const ring of ringsOf(g))
      for (const ref of ring) {
        const a = ref < 0 ? ~ref : ref;
        if (!remap.has(a)) { remap.set(a, arcs.length); arcs.push(allArcs[a]); }
      }
  let ox = Infinity, oy = Infinity;
  for (const a of arcs) for (const [x, y] of a) { ox = Math.min(ox, x); oy = Math.min(oy, y); }
  ox = Math.floor(ox); oy = Math.floor(oy);
  const qArcs = arcs.map((a) => {
    const o = [];
    for (const [x, y] of a) {
      const qx = Math.round(x - ox), qy = Math.round(y - oy), l = o[o.length - 1];
      if (!l || l[0] !== qx || l[1] !== qy) o.push([qx, qy]);
    }
    if (o.length === 1) o.push(o[0]);
    return o;
  });
  const ringCoords = (refs) => {
    const c = [];
    for (const ref of refs) {
      const a = ref < 0 ? qArcs[remap.get(~ref)].slice().reverse() : qArcs[remap.get(ref)];
      for (let i = c.length ? 1 : 0; i < a.length; i++) c.push(a[i]);
    }
    return c;
  };
  const area = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return s / 2; };

  const bytes = [];
  const u = (v) => { do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; bytes.push(b); } while (v); };
  const z = (v) => u(v < 0 ? -2 * v - 1 : 2 * v);
  const strings = [], sIdx = new Map();
  const str = (t) => { if (!t) return 0; if (!sIdx.has(t)) { sIdx.set(t, strings.length); strings.push(t); } return sIdx.get(t) + 1; };
  for (const g of geoms) { str(g.properties.buurt); str(g.properties.wijk); }
  for (const c of 'PC6A') bytes.push(c.charCodeAt(0));
  u(2); u(ox); u(oy);
  u(strings.length);
  for (const t of strings) { const b = Buffer.from(t, 'utf8'); u(b.length); bytes.push(...b); }
  u(qArcs.length);
  let px = 0, py = 0, n = 0;
  for (const a of qArcs) { u(a.length); for (const [x, y] of a) { z(x - px); z(y - py); px = x; py = y; n++; } }

  const sorted = geoms.slice().sort((a, b) => (a.properties.pc6 < b.properties.pc6 ? -1 : 1));
  u(sorted.length);
  let plx = 0, ply = 0;
  for (const g of sorted) {
    const pr = g.properties;
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    let best = null, bestA = -1;
    for (const poly of polys) {
      const rings = poly.map(ringCoords);
      const a = Math.abs(area(rings[0]));
      if (a > bestA) { bestA = a; best = rings; }
    }
    const [lx, ly] = polylabel(best, 1).map(Math.round);
    u((pr.pc6.charCodeAt(4) - 65) * 26 + (pr.pc6.charCodeAt(5) - 65));
    u(pr.inw); u(pr.won); u(pr.hh); u(pr.woz); u(pr.koop);
    u(str(pr.buurt)); u(str(pr.wijk));
    z(lx - plx); z(ly - ply); plx = lx; ply = ly;
    const rings = polys.flat();
    u(rings.length);
    let pa = 0;
    for (const ring of rings) {
      u(ring.length);
      for (const ref of ring) {
        const idx = remap.get(ref < 0 ? ~ref : ref);
        const d = idx - pa; pa = idx;
        u((d < 0 ? -2 * d - 1 : 2 * d) * 2 + (ref < 0 ? 1 : 0));
      }
    }
  }
  return { buf: Buffer.from(bytes), n };
}

// ---------- write ----------
const h = createHash('sha256');
for (const [k, b] of [...files].sort()) h.update(k).update(b);
const dirName = `pc6-${h.digest('hex').slice(0, 10)}`;
for (const d of await readdir(p('public/data/'))) if (d.startsWith('pc6-')) await rm(p(`public/data/${d}`), { recursive: true });
await mkdir(p(`public/data/${dirName}/`), { recursive: true });
let raw = 0, br = 0;
for (const [k, b] of files) {
  await writeFile(p(`public/data/${dirName}/${k}.bin`), b);
  raw += b.length;
  br += brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}
const df = p('src/app/data-file.ts');
const src = await readFile(df, 'utf8');
await writeFile(df, src.replace(/\nexport const PC6_DIR = .*\n|$/, `\nexport const PC6_DIR = 'data/${dirName}';\n`).replace(/\n\n+$/, '\n'));
console.log(
  `${files.size} files, ${pts} points: ${(raw / 1048576).toFixed(1)} MB raw, ${(br / 1048576).toFixed(1)} MB brotli, ` +
    `avg ${(br / files.size / 1024).toFixed(1)} kB per PC4 -> public/data/${dirName}/`,
);
