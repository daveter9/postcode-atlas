// Functional end-to-end test of the production build, on desktop and mobile.
//
//   npm run build:pages && npm run test:e2e
import { launch, newPage, PROFILES, startServer, wait, waitForMap } from './lib.mjs';

const args = process.argv.slice(2);
const profiles = args.find((a) => a.startsWith('--profile='))?.split('=')[1]?.split(',') ?? Object.keys(PROFILES);
const failures = [];
const check = (profile, name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${profile.padEnd(8)} ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failures.push(`${profile}: ${name}`);
};

const server = await startServer();
const browser = await launch();
try {
  for (const profile of profiles) {
    const page = await newPage(browser, profile);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const value = () => page.$eval('#pc', (e) => e.value);
    const card = () => page.$eval('.card', (e) => e.textContent ?? '').catch(() => '');

    await page.goto(server.url + '/', { waitUntil: 'networkidle0' });
    await waitForMap(page);
    if (profile === 'desktop') check(profile, 'invoerveld heeft focus', (await page.evaluate(() => document.activeElement?.id)) === 'pc');
    await page.focus('#pc');

    await page.keyboard.type('3512ab');
    await page.waitForFunction(() => document.querySelector('.card')?.textContent?.includes('Adressen'), { timeout: 15000 }).catch(() => {});
    check(profile, 'letters worden opgemaakt', (await value()) === '3512 AB', await value());
    check(profile, 'URL bevat de postcode', page.url().endsWith('?pc=3512AB'), page.url());
    const c = await card();
    check(profile, 'infokaart toont buurt en wijk', c.includes('Domplein') && c.includes('Binnenstad'), c.slice(0, 120));
    check(profile, 'infokaart toont adressen', c.includes('Vinkenburgstraat') && /\d+ adressen/.test(c), c.slice(0, 160));

    await page.keyboard.press('Backspace');
    await wait(300);
    check(profile, 'Backspace gaat een niveau terug', (await value()) === '3512 A', await value());
    await page.keyboard.type('q');
    await wait(300);
    const notice = await page.$eval('.notice', (e) => e.textContent ?? '').catch(() => '');
    check(profile, 'onbestaande letter wordt geweigerd', notice.includes('3512 AQ') && (await value()) === '3512 A', notice);

    await page.keyboard.press('Escape');
    await wait(1500);
    check(profile, 'Esc gaat naar heel Nederland', (await value()) === '', await value());

    const box = await (await page.$('canvas')).boundingBox();
    const x = box.x + box.width * 0.5, y = box.y + box.height * 0.55;
    if (PROFILES[profile].viewport.hasTouch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await wait(1500);
    check(profile, 'klik op de kaart kiest een regio', /^\d$/.test(await value()), await value());

    await page.click('.bar .btn');
    await page.waitForFunction(() => /^\d{4} [A-Z]{2}$/.test(document.querySelector('#pc')?.value ?? ''), { timeout: 15000 }).catch(() => {});
    check(profile, 'willekeurige postcode heeft letters', /^\d{4} [A-Z]{2}$/.test(await value()), await value());

    if (PROFILES[profile].viewport.hasTouch) {
      // touchscreen: own keypad, system keyboard off
      check(profile, 'systeemtoetsenbord uit', (await page.$eval('#pc', (e) => e.inputMode)) === 'none');
      await page.keyboard.press('Escape');
      await wait(500);
      // key label: its text, or ⌫ for the erase key (an SVG icon with aria-label "Wissen")
      await page.evaluate(() => {
        window.keyLabel = (b) => b.textContent.trim() || (b.ariaLabel === 'Wissen' ? '⌫' : '');
      });
      const tap = (k, sel = '.keypad button') => page.$$eval(sel, (bs, k) => bs.find((b) => keyLabel(b) === k)?.click(), k);
      const keyState = (k) => page.$$eval('.keypad button', (bs, k) => bs.find((b) => keyLabel(b) === k)?.disabled, k);
      const rows = () => page.$$eval('.krow', (rs) => rs.map((r) => [...r.querySelectorAll('button')].map(keyLabel).join('')).join('|'));
      const delBox = async () => JSON.stringify(await (await page.$('.keypad .del')).boundingBox());
      check(profile, 'eerst alleen cijfers', (await rows()) === '12345|67890⌫', await rows());
      const delDigits = await delBox();
      check(profile, '0 is uitgegrijsd als eerste cijfer', (await keyState('0')) === true);
      for (const k of ['3', '5', '1', '2']) await tap(k);
      await page.waitForFunction(() => [...document.querySelectorAll('.keypad button')].some((b) => b.textContent.trim() === 'A' && !b.disabled), { timeout: 15000 }).catch(() => {});
      check(profile, 'na vier cijfers alleen QWERTY-letters', (await rows()) === 'QWERTYUIOP|ASDFGHJKL|ZXCVBNM⌫', await rows());
      const inOrder = await page.$$eval('.krow', (rs) => rs.every((r) => [...r.querySelectorAll('button')].every((b, i, a) => !i || a[i - 1].getBoundingClientRect().right < b.getBoundingClientRect().left)));
      check(profile, 'lettertoetsen op het scherm in QWERTY-volgorde', inOrder);
      check(profile, 'wistoets blijft op dezelfde plek', (await delBox()) === delDigits, `${delDigits} -> ${await delBox()}`);
      const kpBox = await (await page.$('.keypad')).boundingBox();
      const del = JSON.parse(await delBox());
      check(profile, 'wistoets rechtsonder', Math.abs(del.x + del.width - (kpBox.x + kpBox.width)) < 2 && Math.abs(del.y + del.height - (kpBox.y + kpBox.height)) < 2, JSON.stringify({ del, kpBox }));
      await tap('A');
      await tap('B');
      check(profile, 'tikken op het toetsenblok', (await value()) === '3512 AB', await value());
      await wait(200);
      check(profile, 'complete postcode: toetsenblok ingeklapt', !(await page.$('.keypad')) && !!(await page.$('.bar .del')));
      await tap('⌫', '.bar .del');
      await wait(200);
      check(profile, 'wissen: een terug en toetsenblok weer zichtbaar', (await value()) === '3512 A' && !!(await page.$('.keypad')) && !(await page.$('.bar .del')), await value());
      await tap('⌫');
      check(profile, 'wissen op het toetsenblok', (await value()) === '3512', await value());
      const kp = await (await page.$('.keypad')).boundingBox();
      check(profile, 'toetsenblok is compact', kp.height <= 130, String(kp.height));
      check(profile, 'geen lijst', !(await page.$('.kids')));
    } else {
      check(profile, 'geen toetsenblok of lijst', !(await page.$('.keypad')) && !(await page.$('.kids')));
    }
    check(profile, 'geen fouten in de console', errors.length === 0, errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}
console.log(failures.length ? `\n${failures.length} mislukt` : '\nalles ok');
process.exit(failures.length ? 1 : 0);
