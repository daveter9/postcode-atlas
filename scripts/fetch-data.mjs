// Downloads the raw source data once (not needed at runtime, the app is fully static).
//  - CBS postcode4 (PC4) polygons, jaar 2024, in RD New (EPSG:28992) via PDOK OGC API  (CC BY 4.0)
//  - GeoNames NL postal codes (place names)                                            (CC BY 4.0)
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const OUT = new URL('../data-raw/', import.meta.url);
await mkdir(OUT, { recursive: true });

const YEAR = process.env.PC4_YEAR ?? '2024';
const RD = 'http://www.opengis.net/def/crs/EPSG/0/28992';
let url =
  `https://api.pdok.nl/cbs/postcode4/ogc/v1/collections/postcode4/items` +
  `?f=json&limit=1000&jaarcode=${YEAR}&crs=${encodeURIComponent(RD)}`;

const features = [];
while (url) {
  process.stdout.write(`fetch ${features.length}…\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const page = await res.json();
  for (const f of page.features) {
    const p = f.properties;
    features.push({
      type: 'Feature',
      properties: { pc: p.postcode, inw: p.aantal_inwoners > 0 ? p.aantal_inwoners : 0 },
      geometry: f.geometry,
    });
  }
  url = page.links.find((l) => l.rel === 'next')?.href;
}
await writeFile(new URL('pc4.geojson', OUT), JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`pc4: ${features.length} features`);

const zip = await fetch('https://download.geonames.org/export/zip/NL.zip');
await writeFile(new URL('NL.zip', OUT), Buffer.from(await zip.arrayBuffer()));
execSync('unzip -o -q NL.zip NL.txt', { cwd: OUT });
console.log('geonames: ok');
