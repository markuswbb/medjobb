// Lokal forhåndsvisning av nettsiden (på nett ligger den på GitHub Pages).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 4321;
const ROOT = path.join(__dirname, 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const file = path.join(ROOT, path.normalize(pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('Ikke funnet');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`Medjobb kjører på http://localhost:${PORT}`));
