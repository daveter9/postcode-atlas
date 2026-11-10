// Lighthouse scores and core metrics for a few states of the app, mobile and desktop.
//
//   npm run build:pages && npm run test:lighthouse [-- --assert]
import { startServer } from './lib.mjs';
import { measure } from './lhr.mjs';

const assert = process.argv.includes('--assert');
// minimum scores (0-100); performance has some run-to-run noise
const MIN = { performance: 90, accessibility: 100, 'best-practices': 100, seo: 100 };
const MAX = { lcp: 2500, tbt: 200, cls: 0.05 };

const server = await startServer();
let rows;
try {
  rows = await measure(server.url);
} finally {
  server.stop();
}

let failed = false;
for (const r of rows) {
  r.bad = [
    ...Object.entries(MIN).filter(([k, v]) => r[k] < v).map(([k]) => k),
    ...Object.entries(MAX).filter(([k, v]) => r[k] > v).map(([k]) => k),
  ];
  failed ||= r.bad.length > 0;
}

console.log('\nform     pagina         perf  a11y    bp   seo   LCP ms  TBT ms    CLS');
for (const r of rows)
  console.log(
    `${r.form.padEnd(8)} ${r.path.padEnd(13)} ${[r.performance, r.accessibility, r['best-practices'], r.seo].map((v) => String(v).padStart(5)).join(' ')} ${String(r.lcp).padStart(8)} ${String(r.tbt).padStart(7)} ${String(r.cls).padStart(6)}${r.bad.length ? '  ' + r.bad.join(', ') : ''}`,
  );
console.log(`\nminimum: ${JSON.stringify(MIN)}  maximum: ${JSON.stringify(MAX)}`);
if (assert && failed) process.exit(1);
