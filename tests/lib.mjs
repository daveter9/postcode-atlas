// Shared helpers for the browser tests: serve the production build, launch the local Chrome,
// and the device profiles every test runs on.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Launcher } from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

// APP_ROOT points the helpers at another checkout (a git worktree), e.g. for scripts/pr-evidence.mjs
export const ROOT = process.env.APP_ROOT
  ? pathToFileURL(resolve(process.env.APP_ROOT) + '/')
  : new URL('../', import.meta.url);
export const DIST = new URL('dist/postcode-atlas/browser/', ROOT);

export const PROFILES = {
  desktop: { viewport: { width: 1366, height: 860, deviceScaleFactor: 2 }, cpu: 1 },
  // mid-range phone: small screen, 3x pixels, touch, 4x slower CPU (Lighthouse's mobile throttling)
  mobile: {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    cpu: 4,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  },
};

export const chromePath = () => process.env.CHROME_PATH || Launcher.getInstallations()[0];

/** Serves dist/ of `root` (default ROOT) with scripts/serve.mjs on a free port; resolves to { url, stop }. */
export function startServer(root = ROOT) {
  const rootUrl = typeof root === 'string' ? pathToFileURL(resolve(root) + '/') : root;
  const dist = new URL('dist/postcode-atlas/browser/', rootUrl);
  if (!existsSync(new URL('index.html', dist))) throw new Error(`Geen build gevonden in ${dist.pathname}: draai eerst \`npm run build\`.`);
  const port = 4400 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: rootUrl,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http://')) resolve({ url: `http://localhost:${port}`, stop: () => proc.kill() });
    });
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)));
  });
}

export async function launch() {
  const executablePath = chromePath();
  if (!executablePath) throw new Error('Chrome niet gevonden; zet CHROME_PATH.');
  return puppeteer.launch({ executablePath, headless: true, args: ['--enable-gpu-rasterization'] });
}

export async function newPage(browser, profileName) {
  const prof = PROFILES[profileName];
  const page = await browser.newPage();
  await page.setViewport(prof.viewport);
  if (prof.userAgent) await page.setUserAgent(prof.userAgent);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
  return page;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the map data is decoded and the first state is drawn. */
export async function waitForMap(page) {
  await page.waitForFunction(() => !document.querySelector('.status'), { timeout: 30000 });
  await wait(400);
}
