// Builds one small binary per PC4 with every address (street, house number, position), loaded by
// the app only when you are inside a 6-character postcode. Source: BAG via PDOK (bag-light.gpkg,
// CC0): verblijfsobjecten + ligplaatsen (houseboats) + standplaatsen (caravan pitches).
//
// Output: public/data/adr-<hash>/<pc4>.bin
//
// Format (u = unsigned LEB128 varint, z = zigzag varint), coordinates in whole metres (RD New):
//   "ADR1" version ox oy
//   nStrings { len utf8 }*                     street names and suffixes ("A", "bis", "2", …)
//   nPc6 { u(l1*26+l2)
//          nStreets { street
//                     nAddr { huisnummer suffix+1 z(dx) z(dy) }* }* }*     dx/dy chain over the file
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { brotliCompressSync, constants } from 'node:zlib';

const root = new URL('../', import.meta.url);
const p = (rel) => new URL(rel, root);
const fsPath = (u) => u.pathname.replace(/^\/(\w:)/, '$1');

const known = new Set(
  JSON.parse(await readFile(p('data-raw/pc4.topo.json'), 'utf8')).objects.pc4.geometries.map((g) => String(g.properties.pc)),
);

// point of a GeoPackage geometry: the point itself, or the mean of a polygon's outer ring
function position(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const env = (b[3] >> 1) & 7;
  let o = 8 + [0, 32, 48, 48, 64][env];
  const le = b[o] === 1;
  let type = dv.getUint32(o + 1, le) % 1000;
  o += 5;
  if (type === 1) return [dv.getFloat64(o, le), dv.getFloat64(o + 8, le)];
  if (type === 6) { o += 4 + 5; type = 3; } // first polygon of a multipolygon
  if (type !== 3) return null;
  o += 4; // number of rings
  const n = dv.getUint32(o, le);
  o += 4;
  let x = 0, y = 0;
  const m = Math.max(1, n - 1); // last point repeats the first
  for (let k = 0; k < m; k++, o += 16) { x += dv.getFloat64(o, le); y += dv.getFloat64(o + 8, le); }
  return [x / m, y / m];
}

// ---------- read all addresses into compact columns ----------
const db = new DatabaseSync(fsPath(p('data-raw/bag-light.gpkg')), { readOnly: true });
const strings = [], sIdx = new Map();
const str = (t) => { if (!sIdx.has(t)) { sIdx.set(t, strings.length); strings.push(t); } return sIdx.get(t); };
const CAP = 10_200_000;
const colPc = new Uint32Array(CAP); // pc4 * 676 + letters
const colStreet = new Uint32Array(CAP), colNr = new Uint32Array(CAP), colSuf = new Int32Array(CAP);
const colX = new Int32Array(CAP), colY = new Int32Array(CAP);
let n = 0;
for (const table of ['verblijfsobject', 'ligplaats', 'standplaats']) {
  const q = db.prepare(
    `select postcode, openbare_ruimte_naam s, huisnummer nr, huisletter l, toevoeging t, geom from ${table} where postcode is not null`,
  );
  for (const r of q.iterate()) {
    const pc = String(r.postcode).toUpperCase();
    if (!/^\d{4}[A-Z]{2}$/.test(pc) || !known.has(pc.slice(0, 4)) || !r.geom || r.nr == null) continue;
    const pos = position(r.geom);
    if (!pos) continue;
    const suffix = `${r.l ?? ''}${r.t ? (r.l ? '-' : '-') + r.t : ''}`;
    colPc[n] = Number(pc.slice(0, 4)) * 676 + (pc.charCodeAt(4) - 65) * 26 + (pc.charCodeAt(5) - 65);
    colStreet[n] = str(r.s ?? '');
    colNr[n] = r.nr;
    colSuf[n] = suffix ? str(suffix) : -1;
    colX[n] = Math.round(pos[0]);
    colY[n] = Math.round(pos[1]);
    n++;
  }
  console.log(`${table}: ${n} addresses so far`);
}

// ---------- sort: postcode, street, number, suffix ----------
const order = new Uint32Array(n);
for (let i = 0; i < n; i++) order[i] = i;
const collator = new Intl.Collator('nl', { numeric: true });
const sufCmp = (a, b) => (a === b ? 0 : a < 0 ? -1 : b < 0 ? 1 : collator.compare(strings[a], strings[b]));
order.sort((a, b) =>
  colPc[a] - colPc[b] ||
  collator.compare(strings[colStreet[a]], strings[colStreet[b]]) ||
  colNr[a] - colNr[b] ||
  sufCmp(colSuf[a], colSuf[b]),
);

// ---------- encode per PC4 ----------
const files = new Map();
for (let s0 = 0; s0 < n; ) {
  const pc4 = Math.floor(colPc[order[s0]] / 676);
  let e0 = s0;
  while (e0 < n && Math.floor(colPc[order[e0]] / 676) === pc4) e0++;
  files.set(String(pc4), encode(s0, e0));
  s0 = e0;
}

function encode(s0, e0) {
  const bytes = [];
  const u = (v) => { do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; bytes.push(b); } while (v); };
  const z = (v) => u(v < 0 ? -2 * v - 1 : 2 * v);
  let ox = Infinity, oy = Infinity;
  const local = [], lIdx = new Map();
  const ls = (g) => { if (!lIdx.has(g)) { lIdx.set(g, local.length); local.push(strings[g]); } return lIdx.get(g); };
  for (let k = s0; k < e0; k++) {
    const i = order[k];
    ox = Math.min(ox, colX[i]); oy = Math.min(oy, colY[i]);
    ls(colStreet[i]);
    if (colSuf[i] >= 0) ls(colSuf[i]);
  }
  for (const c of 'ADR1') bytes.push(c.charCodeAt(0));
  u(1); u(ox); u(oy);
  u(local.length);
  for (const t of local) { const b = Buffer.from(t, 'utf8'); u(b.length); bytes.push(...b); }
  // group into PC6 runs, then street runs
  const pc6Runs = [];
  for (let k = s0; k < e0; ) {
    let e = k;
    while (e < e0 && colPc[order[e]] === colPc[order[k]]) e++;
    pc6Runs.push([k, e]);
    k = e;
  }
  u(pc6Runs.length);
  let px = 0, py = 0;
  for (const [a, b] of pc6Runs) {
    u(colPc[order[a]] % 676);
    const streets = [];
    for (let k = a; k < b; ) {
      let e = k;
      while (e < b && colStreet[order[e]] === colStreet[order[k]]) e++;
      streets.push([k, e]);
      k = e;
    }
    u(streets.length);
    for (const [c, d] of streets) {
      u(lIdx.get(colStreet[order[c]]));
      u(d - c);
      for (let k = c; k < d; k++) {
        const i = order[k];
        u(colNr[i]);
        u(colSuf[i] >= 0 ? lIdx.get(colSuf[i]) + 1 : 0);
        const x = colX[i] - ox, y = colY[i] - oy;
        z(x - px); z(y - py);
        px = x; py = y;
      }
    }
  }
  return Buffer.from(bytes);
}

// ---------- write ----------
const h = createHash('sha256');
for (const [k, b] of [...files].sort()) h.update(k).update(b);
const dirName = `adr-${h.digest('hex').slice(0, 10)}`;
for (const d of await readdir(p('public/data/'))) if (d.startsWith('adr-')) await rm(p(`public/data/${d}`), { recursive: true });
await mkdir(p(`public/data/${dirName}/`), { recursive: true });
let raw = 0, br = 0;
for (const [k, b] of files) {
  await writeFile(p(`public/data/${dirName}/${k}.bin`), b);
  raw += b.length;
  br += brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}
const df = p('src/app/data-file.ts');
let src = await readFile(df, 'utf8');
src = src.replace(/\nexport const ADR_DIR = .*\n?/, '\n').replace(/\n+$/, '\n') + `export const ADR_DIR = 'data/${dirName}';\n`;
await writeFile(df, src);
console.log(
  `${n} addresses in ${files.size} files: ${(raw / 1048576).toFixed(1)} MB raw, ${(br / 1048576).toFixed(1)} MB brotli, ` +
    `avg ${(br / files.size / 1024).toFixed(1)} kB per PC4 -> public/data/${dirName}/`,
);
