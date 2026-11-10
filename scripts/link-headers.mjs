// Adds a `Link: preload` response header for the start page to the built _headers file.
//
// The critical request chain is index.html -> main-<hash>.js (+ its shared chunk). With the
// header the browser can start fetching the bundle as soon as the response headers arrive,
// and Cloudflare can send it ahead as a 103 Early Hint while the HTML is still on its way.
// The bundle names contain a content hash, so this has to run after every `ng build`.
//
//   node scripts/link-headers.mjs [dist/postcode-atlas/browser]
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist/postcode-atlas/browser';
const html = await readFile(join(dir, 'index.html'), 'utf8');

// the entry module plus the chunks Angular marks as modulepreload (both needed before the app runs)
const entry = [...html.matchAll(/<script src="([^"]+\.js)" type="module"/g)].map((m) => m[1]);
const chunks = [...html.matchAll(/<link rel="modulepreload" href="([^"]+\.js)"/g)].map((m) => m[1]);
const scripts = [...entry, ...chunks];
if (entry.length === 0) throw new Error('link-headers: no <script type="module"> found in index.html');

// `as=script; crossorigin` matches how a module script is requested (cors, same-origin
// credentials), so the browser reuses the preloaded response instead of fetching twice.
// Early Hints only forwards rel=preload and rel=preconnect, hence not rel=modulepreload.
const link = scripts.map((s) => `</${s}>; rel=preload; as=script; crossorigin`).join(', ');

const rules = ['/', '/index.html'].map((path) => `${path}\n  Link: ${link}\n`).join('\n');
await appendFile(join(dir, '_headers'), `\n# start page: preload the bundle (added by scripts/link-headers.mjs)\n${rules}`);
console.log(`link-headers: ${scripts.join(', ')}`);
