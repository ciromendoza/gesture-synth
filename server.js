import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { MIME_TYPES } from './mime-types.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(fileURLToPath(import.meta.url), '..', 'public');

const server = createServer((req, res) => {
  // Strip query strings or hash
  const urlPath = req.url.split('?')[0].split('#')[0];
  let safePath = normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  let filePath = join(PUBLIC_DIR, safePath);

  // If path is a directory, try index.html inside
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  try {
    if (!existsSync(filePath)) {
      res.writeHead(404, { 
        'Content-Type': 'text/plain; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      });
      res.end('404 Not Found');
      return;
    }

    const content = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (err) {
    console.error(`[Server Error] ${req.url}:`, err.message);
    res.writeHead(500, { 
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });
    res.end('500 Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`Gesture Synthesizer running at http://localhost:${PORT}`);
  console.log(`Headers: COOP (same-origin), COEP (require-corp) active`);
  console.log(`====================================================`);
});
