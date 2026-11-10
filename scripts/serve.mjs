// Local preview of the production build, mimicking deploy/nginx.conf:
// serves precompressed .br/.gz files and the same cache headers. Not meant for production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? 'dist/postcode-atlas/browser';
const port = Number(process.env.PORT ?? 4300);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};
// Same CSP as deploy/nginx.conf, read from there so a mismatch shows up while testing.
const CSP = (await readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8')).match(/set \$csp "([^"]+)"/)[1];
const HASHED = /([.-][A-Za-z0-9]{8,}\.(js|css|bin)|[\\/](pc6|adr)-[0-9a-f]{10}[\\/]\d{4}\.bin)$/;

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(root, normalize(path).replace(/^([/\\])+/, ''));
  if (!file.startsWith(normalize(root))) return res.writeHead(403).end();
  try {
    await stat(file);
  } catch {
    return res.writeHead(404).end('not found');
  }
  const ae = req.headers['accept-encoding'] ?? '';
  let body = null, enc = null;
  for (const [e, ext] of [['br', '.br'], ['gzip', '.gz']]) {
    if (!ae.includes(e)) continue;
    try { body = await readFile(file + ext); enc = e; break; } catch {}
  }
  body ??= await readFile(file);
  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Vary': 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
  };
  if (enc) headers['Content-Encoding'] = enc;
  res.writeHead(200, headers).end(body);
}).listen(port, () => console.log(`http://localhost:${port}`));
