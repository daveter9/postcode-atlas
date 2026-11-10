// Load-time test: how long until the map is drawn, and how many bytes travel, on a first visit
// and on a return visit (warm cache), for desktop and for mobile on a slow 4G connection.
//
//   npm run build:pages && npm run test:load [-- --assert]
//
// "map" = time from navigation start to performance.mark('map-ready') (data decoded, first frame).
// Bytes count what the page fetches; the PC6 and address files are fetched by the map worker and
// are not included (a few kB each).
import { launch, newPage, PROFILES, startServer } from './lib.mjs';

const args = process.argv.slice(2);
const assert = args.includes('--assert');
// Lighthouse's mobile network: 150 ms RTT, 1.6 Mbit/s down
const NETWORK = { mobile: { latency: 150, downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (750e3 / 8) * 0.9 } };
const BUDGET = {
  desktop: { map: 1000, coldKB: 500, warmKB: 10 },
  mobile: { map: 4500, coldKB: 500, warmKB: 10 },
};
const PAGES = ['/', '/?pc=3512AB'];

const server = await startServer();
const browser = await launch();
const rows = [];
let failed = false;
try {
  for (const profile of Object.keys(PROFILES)) {
    for (const path of PAGES) {
      // fresh context = empty cache for the first visit; the second visit reuses it
      const ctx = await browser.createBrowserContext();
      const page = await newPage(ctx, profile);
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      if (NETWORK[profile]) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETWORK[profile] });
      let bytes = 0, requests = 0;
      cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; requests++; });
      for (const visit of ['eerste', 'terug']) {
        bytes = 0;
        requests = 0;
        await page.goto(server.url + path, { waitUntil: 'load' });
        await page.waitForFunction(() => performance.getEntriesByName('map-ready').length > 0, { timeout: 60000 });
        // let the lazy files of a deep link (PC6, addresses) arrive as well
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 60000 }).catch(() => {});
        const t = await page.evaluate(() => ({
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
          map: performance.getEntriesByName('map-ready')[0].startTime,
        }));
        const kb = bytes / 1024;
        const b = BUDGET[profile];
        const ok = visit === 'eerste' ? t.map <= b.map && (path !== '/' || kb <= b.coldKB) : kb <= b.warmKB;
        failed ||= !ok;
        rows.push({ profile, path, visit, fcp: Math.round(t.fcp), map: Math.round(t.map), kb: +kb.toFixed(1), requests, ok });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}

console.log('\nprofile  pagina          bezoek   FCP ms  kaart ms       kB  requests');
for (const r of rows)
  console.log(
    `${r.profile.padEnd(8)} ${r.path.padEnd(15)} ${r.visit.padEnd(7)} ${String(r.fcp).padStart(7)} ${String(r.map).padStart(9)} ${r.kb.toFixed(1).padStart(8)} ${String(r.requests).padStart(9)}${r.ok ? '' : '  > budget'}`,
  );
console.log(`\nbudgets: ${JSON.stringify(BUDGET)}  (mobiel: slow 4G 1,6 Mbit/s, 150 ms RTT, 4x CPU)`);
if (assert && failed) process.exit(1);
