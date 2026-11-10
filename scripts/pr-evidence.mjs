#!/usr/bin/env node
// Bewijs voor een PR: screenshots van de echte build op desktop en mobiel, en Lighthouse van deze
// build naast een build van origin/main (beide lokaal, onder dezelfde omstandigheden), plus de live
// site als referentie. Afbeeldingen gaan naar de losse branch `pr-assets` (via git-plumbing, zodat
// main en de featurebranch er niet mee vervuild raken); de markdown voor de PR-beschrijving komt op
// stdout en in <tmp>/evidence.md.
//
//   (in de worktree van het ticket) npm run build:pages
//   node scripts/pr-evidence.mjs <ticket#> [--root worktree] [--steps steps.mjs] [--no-base] [--no-prod] [--no-push]
//
// De main-build staat in een eigen worktree (../postcode-atlas-wt/_main, met eigen npm ci) en wordt
// alleen opnieuw gebouwd als origin/main veranderd is.
//
// Een steps-module exporteert een array van stappen, die per profiel in volgorde draaien op
// dezelfde pagina (zo kun je een flow vastleggen):
//   export default [
//     { name: 'start', caption: 'Startscherm', path: '/' },
//     { name: 'zoek', caption: 'Postcode ingetypt', run: async (page, h) => { await page.type('#pc', '3512ab'); await h.wait(1500); } },
//   ];
// `path` (optioneel) navigeert eerst; `run` (optioneel) voert acties uit (h: wait, waitForMap,
// profile, url); daarna volgt de screenshot. `settle` (ms, standaard 600) wacht vlak voor de foto.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'daveter9/postcode-atlas';
const PROD = 'https://postcoderadar.nl';
const ASSET_BRANCH = 'pr-assets';
const RUNS = 3; // Lighthouse-runs per pagina; de tabel toont de mediaan
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Hoofdmap van de repo (ook als dit script vanuit een worktree draait) en de map voor worktrees
const MAIN_ROOT = dirname(
  execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
);
const WT_ROOT = join(MAIN_ROOT, '..', 'postcode-atlas-wt');
const MAIN_WT = join(WT_ROOT, '_main');

const argv = process.argv.slice(2);
const ticket = Number(String(argv[0] ?? '').replace(/^#/, ''));
if (!Number.isInteger(ticket) || ticket <= 0) {
  console.error('Gebruik: node scripts/pr-evidence.mjs <ticket#> [--root worktree] [--steps steps.mjs] [--no-base] [--no-prod] [--no-push]');
  process.exit(1);
}
const flag = (f) => argv.includes(f);
const optArg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
// --root <dir>: de checkout (worktree) waarvan de build getoond wordt; standaard deze repo
const appRoot = resolve(optArg('--root') ?? REPO_ROOT);
process.env.APP_ROOT = appRoot;
const { launch, newPage, PROFILES, startServer, wait, waitForMap } = await import('../tests/lib.mjs');
const { measure } = await import('../tests/lhr.mjs');
const steps = optArg('--steps')
  ? (await import(pathToFileURL(resolve(optArg('--steps'))).href)).default
  : [
      { name: 'start', caption: 'Startscherm', path: '/' },
      { name: 'postcode', caption: 'Postcode 3512 AB', path: '/?pc=3512AB' },
    ];

const out = mkdtempSync(join(tmpdir(), `pr-evidence-${ticket}-`));
mkdirSync(join(out, String(ticket)));
const log = (...a) => console.error(...a);
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/** Worktree met origin/main, gebouwd; geeft het pad terug. */
function prepareMain() {
  git(['fetch', 'origin', 'main']);
  const sha = git(['rev-parse', 'origin/main']);
  if (!existsSync(MAIN_WT)) {
    git(['worktree', 'add', '--detach', MAIN_WT, sha]);
    log('main-worktree: npm ci…');
    execFileSync('npm ci', { cwd: MAIN_WT, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
  } else {
    const lockBefore = git(['-C', MAIN_WT, 'rev-parse', 'HEAD:package-lock.json']);
    git(['-C', MAIN_WT, 'checkout', '--detach', sha]);
    if (git(['-C', MAIN_WT, 'rev-parse', 'HEAD:package-lock.json']) !== lockBefore) {
      log('main-worktree: dependencies gewijzigd, npm ci…');
      execFileSync('npm ci', { cwd: MAIN_WT, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
    }
  }
  const marker = join(MAIN_WT, 'dist', '.built-sha');
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== sha) {
    log(`main-build (${sha.slice(0, 7)})…`);
    execFileSync('npm run build:pages', { cwd: MAIN_WT, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
    writeFileSync(marker, sha);
  }
  return { dir: MAIN_WT, sha };
}

// ---------- screenshots ----------
const shots = []; // { step, profile, file }
const browser = await launch();
const server = await startServer(appRoot);
try {
  for (const profile of Object.keys(PROFILES)) {
    const page = await newPage(browser, profile);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const step of steps) {
      if (step.path) {
        await page.goto(server.url + step.path, { waitUntil: 'networkidle0' });
        await waitForMap(page);
      }
      if (step.run) await step.run(page, { wait, waitForMap, profile, url: server.url });
      await wait(step.settle ?? 600);
      const file = `${profile}-${step.name}.png`;
      await page.screenshot({ path: join(out, String(ticket), file) });
      shots.push({ step, profile, file });
      log(`screenshot ${file}`);
    }
    if (errors.length) log(`let op, paginafouten op ${profile}: ${errors.join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}

// ---------- lighthouse ----------
let local, base, prod, baseSha;
try {
  log('lighthouse: deze build…');
  local = await measure(server.url, undefined, { runs: RUNS });
} finally {
  server.stop();
}
if (!flag('--no-base')) {
  const main = prepareMain();
  baseSha = main.sha;
  const s = await startServer(main.dir);
  try {
    log('lighthouse: main-build…');
    base = await measure(s.url, undefined, { runs: RUNS });
  } finally {
    s.stop();
  }
}
if (!flag('--no-prod')) {
  log(`lighthouse: ${PROD}…`);
  try {
    prod = await measure(PROD); // alleen referentie: één run
  } catch (e) {
    log(`live site niet gemeten: ${e.message}`);
  }
}

// ---------- assets naar de pr-assets branch ----------
let base_ = pathToFileURL(out).href;
if (!flag('--no-push')) {
  let parent = null;
  try {
    git(['fetch', 'origin', ASSET_BRANCH]);
    parent = git(['rev-parse', 'FETCH_HEAD']);
  } catch {
    /* branch bestaat nog niet */
  }
  const env = { ...process.env, GIT_INDEX_FILE: join(out, '.index') };
  git(parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
  for (const s of shots) {
    const sha = git(['hash-object', '-w', join(out, String(ticket), s.file)]);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${ticket}/${s.file}`], { env });
  }
  const tree = git(['write-tree'], { env });
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Screenshots voor ticket #${ticket}`]);
  git(['push', 'origin', `${commit}:refs/heads/${ASSET_BRANCH}`]);
  base_ = `https://raw.githubusercontent.com/${REPO}/${commit}`;
  log(`assets gepusht naar ${ASSET_BRANCH} (${commit.slice(0, 7)})`);
}

// ---------- markdown ----------
const img = (s) =>
  `<img src="${base_}/${ticket}/${s.file}" width="${s.profile === 'mobile' ? 260 : 560}" alt="${s.step.caption} (${s.profile})">`;
let md = '## Screenshots\n\n| | Desktop | Mobiel |\n|---|---|---|\n';
for (const step of steps) {
  const d = shots.find((s) => s.step === step && s.profile === 'desktop');
  const m = shots.find((s) => s.step === step && s.profile === 'mobile');
  md += `| **${step.caption}** | ${d ? img(d) : ''} | ${m ? img(m) : ''} |\n`;
}

// [key, kop, hoger-is-beter, drempel(v, ref) waaronder een verschil als ruis geldt]
const COLS = [
  ['performance', 'Perf', true, () => 3],
  ['accessibility', 'A11y', true, () => 1],
  ['best-practices', 'BP', true, () => 1],
  ['seo', 'SEO', true, () => 1],
  ['fcp', 'FCP ms', false, (r) => Math.max(50, r * 0.1)],
  ['lcp', 'LCP ms', false, (r) => Math.max(50, r * 0.1)],
  ['tbt', 'TBT ms', false, (r) => Math.max(50, r * 0.2)],
  ['cls', 'CLS', false, () => 0.01],
  ['bytes', 'KB', false, (r) => Math.max(2, r * 0.02)],
];
const cell = ([key, , higher, noise], v, ref) => {
  if (ref === undefined) return `${v}`;
  const diff = +(v - ref).toFixed(3);
  if (Math.abs(diff) < noise(ref)) return `${v}`;
  const better = higher ? diff > 0 : diff < 0;
  return `${v} ${better ? '🟢' : '🔴'} <sub>(main ${ref})</sub>`;
};
const table = (rows, ref, cols = COLS) => {
  let t = `| Vorm | Pagina | ${cols.map((c) => c[1]).join(' | ')} |\n|---|---|${cols.map(() => '---:').join('|')}|\n`;
  for (const r of rows) {
    const b = ref?.find((x) => x.form === r.form && x.path === r.path);
    t += `| ${r.form} | \`${r.path}\` | ${cols.map((c) => cell(c, r[c[0]], b?.[c[0]])).join(' | ')} |\n`;
  }
  return t;
};

md += '\n## Lighthouse\n\n';
md += base
  ? `Deze PR naast \`main\` (${baseSha.slice(0, 7)}), beide lokaal gebouwd en gemeten onder dezelfde omstandigheden (mediaan van ${RUNS} runs per pagina). 🟢/🔴 alleen bij een verschil boven de meetruis.\n\n`
  : 'Deze PR, lokaal gebouwd en gemeten.\n\n';
md += table(local, base);
if (prod) {
  md += `\n<details><summary>Ter referentie: live site ${PROD}</summary>\n\n`;
  md += 'Gemeten via internet; KB is hier niet vergelijkbaar (Lighthouse telt de data uit de Web Worker op de live site niet mee).\n\n';
  md += table(prod, undefined, COLS.filter((c) => c[0] !== 'bytes'));
  md += '\n</details>\n';
}
writeFileSync(join(out, 'evidence.md'), md);
log(`\nmarkdown: ${join(out, 'evidence.md')}`);
console.log(md);
