// Frame-time benchmark for the map transitions (zoom in, zoom out, letters).
//
//   npm run build && npm run perf:frames            desktop + mobile, table output
//   npm run perf:frames -- --profile=mobile --json=frames.json --assert
//
// How it measures: the renderer normally runs in a Web Worker, where a page script cannot see
// its frames. This test runs the same renderer on the main thread (as for browsers without
// OffscreenCanvas) and after every frame forces Chrome to actually rasterise the canvas by
// reading back one pixel. "cost" is draw calls + rasterisation of one frame, which is what has
// to fit in 16.7 ms for 60 fps. "dropped" counts frame intervals longer than 1.5 frames.
import { writeFileSync } from 'node:fs';
import { launch, newPage, PROFILES, startServer, wait, waitForMap } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const profiles = args.profile ? [args.profile] : Object.keys(PROFILES);
// p95 frame cost budgets (ms) used by --assert
const BUDGET = { desktop: 16.7, mobile: 33 };

const SCENARIOS = [
  { name: 'in   NL -> 3', url: '/', keys: ['3'] },
  { name: 'in   3 -> 35', url: '/?pc=3', keys: ['5'] },
  { name: 'uit  35 -> 3', url: '/?pc=35', keys: ['Backspace'] },
  { name: 'in   3512 -> 3512 A', url: '/?pc=3512', keys: ['a'] },
  { name: 'uit  3512 AB -> 3512 A', url: '/?pc=3512AB', keys: ['Backspace'] },
  { name: 'uit  Esc 3512 AB -> NL', url: '/?pc=3512AB', keys: ['Escape'] },
];

const instrument = () => {
  delete HTMLCanvasElement.prototype.transferControlToOffscreen;
  let ctx = null;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...a) {
    const c = getContext.apply(this, a);
    if (this.closest?.('.map-panel')) ctx = c;
    return c;
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.__perf = { on: false, cost: [], at: [] };
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const t0 = performance.now();
      cb(t);
      if (!window.__perf.on) return;
      ctx?.getImageData(0, 0, 1, 1); // force rasterisation of this frame
      window.__perf.cost.push(performance.now() - t0);
      window.__perf.at.push(t0);
    });
};

const stats = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? 0 };
};

const server = await startServer();
const browser = await launch();
const results = [];
let failed = false;
try {
  for (const profile of profiles) {
    for (const sc of SCENARIOS) {
      const page = await newPage(browser, profile);
      await page.evaluateOnNewDocument(instrument);
      await page.goto(server.url + sc.url, { waitUntil: 'networkidle0' });
      await waitForMap(page);
      await wait(800); // let PC6 data and the initial state settle
      await page.evaluate(() => Object.assign(window.__perf, { on: true, cost: [], at: [] }));
      for (const k of sc.keys) await page.keyboard.press(k);
      await wait(2200 * PROFILES[profile].cpu ** 0.5);
      const { cost, at } = await page.evaluate(() => window.__perf);
      await page.close();
      // only frames that belong to the animation (drop the idle tail)
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      const c = stats(cost);
      const dropped = gaps.filter((g) => g > 25).length;
      const ok = c.p95 <= BUDGET[profile];
      failed ||= !ok;
      results.push({ profile, scenario: sc.name, frames: c.n, median: +c.median.toFixed(1), p95: +c.p95.toFixed(1), max: +c.max.toFixed(1), dropped, ok });
    }
  }
} finally {
  await browser.close();
  server.stop();
}

console.log('\nprofile  scenario                      frames  median    p95    max  dropped');
for (const r of results) {
  console.log(
    `${r.profile.padEnd(8)} ${r.scenario.padEnd(28)} ${String(r.frames).padStart(6)} ${r.median.toFixed(1).padStart(7)} ${r.p95.toFixed(1).padStart(6)} ${r.max.toFixed(1).padStart(6)} ${String(r.dropped).padStart(8)}${r.ok ? '' : '  > budget'}`,
  );
}
console.log(`\nframe cost in ms (draw + raster); budgets p95: ${Object.entries(BUDGET).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2));
if ('assert' in args && failed) process.exit(1);
