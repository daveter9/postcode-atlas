// Pre-compresses the build output (.br + .gz next to each file) so the web server never has to
// compress anything at request time: nginx `gzip_static` / `brotli_static` just send the file.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dir = process.argv[2] ?? 'dist/postcode-atlas/browser';
const EXT = /\.(html|js|mjs|css|svg|json|txt|bin|webmanifest|xml)$/;

let before = 0, afterBr = 0;
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else if (EXT.test(e.name) && (await stat(p)).size > 512) {
      const buf = await readFile(p);
      const br = brotliCompressSync(buf, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_LGWIN]: 24,
          [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      });
      const gz = gzipSync(buf, { level: 9 });
      if (br.length < buf.length) await writeFile(p + '.br', br);
      if (gz.length < buf.length) await writeFile(p + '.gz', gz);
      before += buf.length;
      afterBr += Math.min(br.length, buf.length);
      console.log(`${p.slice(dir.length + 1).padEnd(40)} ${(buf.length / 1024).toFixed(1).padStart(7)} kB -> br ${(br.length / 1024).toFixed(1).padStart(6)} kB`);
    }
  }
}
await walk(dir);
console.log(`total ${(before / 1024).toFixed(0)} kB -> ${(afterBr / 1024).toFixed(0)} kB brotli`);

// CSP: print the hashes of inline scripts so deploy/nginx.conf can allow exactly these.
const html = await readFile(join(dir, 'index.html'), 'utf8');
for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  console.log(`CSP script hash: 'sha256-${createHash('sha256').update(code).digest('base64')}'`);
}
