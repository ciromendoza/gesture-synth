import { createServer } from 'http';
import { createReadStream, promises as fs } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { createBrotliCompress, createGzip } from 'zlib';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { MIME_TYPES } from './mime-types.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const pipelineAsync = promisify(pipeline);

const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);
const IMMUTABLE_PREFIX = `${join('lib', 'mediapipe')}${sep}`;

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin'
};

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function resolveRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  const relativePath = pathname.replace(/^[/\\]+/, '') || 'index.html';
  const filePath = resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) return null;
  return filePath;
}

function getCacheControl(filePath) {
  const relativePath = relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith(IMMUTABLE_PREFIX)) {
    // The vendored MediaPipe files are pinned as a set in this repository.
    return 'public, max-age=31536000, immutable';
  }
  // App code remains revalidated, but ETag/Last-Modified make a reload a
  // cheap 304 instead of re-reading and transferring multi-megabyte assets.
  return 'public, max-age=0, must-revalidate';
}

function chooseEncoding(req, filePath) {
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase())) return null;
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/i.test(accepted)) return 'br';
  if (/\bgzip\b/i.test(accepted)) return 'gzip';
  return null;
}

function createCompressor(encoding) {
  if (encoding === 'br') return createBrotliCompress();
  if (encoding === 'gzip') return createGzip();
  return null;
}

async function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, responseHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Allow': 'GET, HEAD',
      'Cache-Control': 'no-store'
    }));
    res.end('405 Method Not Allowed');
    return;
  }

  const requestedPath = resolveRequestPath(req.url);
  if (!requestedPath) {
    res.writeHead(400, responseHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }));
    res.end('400 Bad Request');
    return;
  }

  let filePath = requestedPath;
  let fileStat;
  try {
    fileStat = await fs.stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = join(filePath, 'index.html');
      fileStat = await fs.stat(filePath);
    }
  } catch (error) {
    res.writeHead(404, responseHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }));
    res.end('404 Not Found');
    return;
  }

  if (!fileStat.isFile()) {
    res.writeHead(404, responseHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }));
    res.end('404 Not Found');
    return;
  }

  const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
  const lastModified = fileStat.mtime.toUTCString();
  const encoding = chooseEncoding(req, filePath);
  const headers = responseHeaders({
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': getCacheControl(filePath),
    'ETag': etag,
    'Last-Modified': lastModified,
    'Vary': 'Accept-Encoding'
  });

  if (req.headers['if-none-match'] === etag ||
      (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (encoding) {
    headers['Content-Encoding'] = encoding;
  } else {
    headers['Content-Length'] = fileStat.size;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const source = createReadStream(filePath);
  const compressor = createCompressor(encoding);
  try {
    if (compressor) await pipelineAsync(source, compressor, res);
    else await pipelineAsync(source, res);
  } catch (error) {
    // A client navigating away can close the stream while a large model is
    // being served. There is nothing useful to send in that case.
    if (!res.destroyed && !res.writableEnded) res.destroy(error);
  }
}

const server = createServer((req, res) => {
  serve(req, res).catch((error) => {
    console.error(`[Server Error] ${req.url}:`, error.message);
    if (!res.headersSent) {
      res.writeHead(500, responseHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }));
    }
    if (!res.writableEnded) res.end('500 Internal Server Error');
  });
});

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`Gesture Synthesizer running at http://localhost:${PORT}`);
  console.log('Headers: COOP (same-origin), COEP (require-corp) active');
  console.log('Static assets: streaming + ETag + Brotli/gzip where applicable');
  console.log('====================================================');
});
