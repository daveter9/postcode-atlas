// Lighthouse scores and core metrics for a few states of the app, mobile and desktop.
//
//   npm run build:pages && npm run test:lighthouse [-- --assert]
import { launch as launchChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { chromePath, startServer } from './lib.mjs';

const assert = process.argv.includes('--assert');
const PAGES = ['/', '/?pc=35', '/?pc=3512AB'];
// minimum scores (0-100); performance has some run-to-run noise
const MIN = { performance: 90, accessibility: 100, 'best-practices': 100, seo: 100 };
const MAX = { lcp: 2500, tbt: 200, cls: 0.05 };

const server = await startServer();
const chrome = await launchChrome({ chromePath: chromePath(), chromeFlags: ['--headless=new'] });
const rows = [];
let failed = false;
try {
  for (const form of ['mobile', 'desktop']) {
    for (const path of PAGES) {
      const r = await lighthouse(
        server.url + path,
        { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: Object.keys(MIN) },
        form === 'desktop' ? desktopConfig : undefined,
      );
      const lhr = r.lhr;
      const score = Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, Math.round(c.score * 100)]));
      const m = {
        lcp: Math.round(lhr.audits['largest-contentful-paint'].numericValue),
        tbt: Math.round(lhr.audits['total-blocking-time'].numericValue),
        cls: +lhr.audits['cumulative-layout-shift'].numericValue.toFixed(3),
      };
      const bad = [
        ...Object.entries(MIN).filter(([k, v]) => score[k] < v).map(([k]) => k),
        ...Object.entries(MAX).filter(([k, v]) => m[k] > v).map(([k]) => k),
      ];
      failed ||= bad.length > 0;
      rows.push({ form, path, ...score, ...m, bad });
    }
  }
} finally {
  await chrome.kill();
  server.stop();
}

console.log('\nform     pagina         perf  a11y    bp   seo   LCP ms  TBT ms    CLS');
for (const r of rows)
  console.log(
    `${r.form.padEnd(8)} ${r.path.padEnd(13)} ${[r.performance, r.accessibility, r['best-practices'], r.seo].map((v) => String(v).padStart(5)).join(' ')} ${String(r.lcp).padStart(8)} ${String(r.tbt).padStart(7)} ${String(r.cls).padStart(6)}${r.bad.length ? '  ' + r.bad.join(', ') : ''}`,
  );
console.log(`\nminimum: ${JSON.stringify(MIN)}  maximum: ${JSON.stringify(MAX)}`);
if (assert && failed) process.exit(1);
