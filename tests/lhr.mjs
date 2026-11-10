// Lighthouse measurement shared by tests/lighthouse.mjs and scripts/pr-evidence.mjs.
import { launch as launchChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { chromePath } from './lib.mjs';

export const PAGES = ['/', '/?pc=35', '/?pc=3512AB'];
export const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Runs Lighthouse for every page on mobile and desktop; returns one row per (form, path).
 * With runs > 1 every metric is the median of that many runs (mobile TBT is noisy).
 */
export async function measure(baseUrl, pages = PAGES, { runs = 1 } = {}) {
  const chrome = await launchChrome({ chromePath: chromePath(), chromeFlags: ['--headless=new'] });
  const rows = [];
  try {
    // warm-up: the first run in a fresh Chrome is consistently slower (TBT), so throw it away
    await lighthouse(baseUrl + pages[0], { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] });
    for (const form of ['mobile', 'desktop']) {
      for (const path of pages) {
        const samples = [];
        for (let i = 0; i < runs; i++) {
          const { lhr } = await lighthouse(
            baseUrl + path,
            { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES },
            form === 'desktop' ? desktopConfig : undefined,
          );
          samples.push({
            ...Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, c.score * 100])),
            fcp: lhr.audits['first-contentful-paint'].numericValue,
            lcp: lhr.audits['largest-contentful-paint'].numericValue,
            tbt: lhr.audits['total-blocking-time'].numericValue,
            cls: lhr.audits['cumulative-layout-shift'].numericValue,
            bytes: lhr.audits['total-byte-weight'].numericValue / 1024,
          });
        }
        const m = (k) => median(samples.map((x) => x[k]));
        rows.push({
          form,
          path,
          ...Object.fromEntries(CATEGORIES.map((k) => [k, Math.round(m(k))])),
          fcp: Math.round(m('fcp')),
          lcp: Math.round(m('lcp')),
          tbt: Math.round(m('tbt')),
          cls: +m('cls').toFixed(3),
          bytes: Math.round(m('bytes')),
        });
      }
    }
  } finally {
    await chrome.kill();
  }
  return rows;
}
