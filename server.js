/* Zero-dependency static server and optional Glitch proxy for REGOLITH.
   node server.js [port]                                     */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGlitchProxy, GLITCH_API_BASE_URL, GLITCH_TITLE_ID } from './backend/glitch-proxy.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance', '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
};

// Dev-only frame capture. Off unless you pass --shots; the release server
// never accepts a write of any kind.
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.SHOT_DIR || path.join(ROOT, '.shots');

function readServerSecrets(root) {
  const file = path.join(root, 'backend', 'runtime-secrets.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function truthy(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }

export function loadServerConfig(env = process.env, root = ROOT) {
  const values = { ...readServerSecrets(root), ...env };
  const requested = truthy(values.GLITCH_BACKEND_ENABLED);
  const titleToken = String(values.GLITCH_TITLE_TOKEN || '').trim();
  const enabled = requested && titleToken.length > 0;
  const environment = values.NODE_ENV === 'production' ? 'production' : 'development';
  return {
    port: Number(values.PORT || process.argv[2]) || DEFAULT_PORT,
    glitch: {
      enabled,
      requested,
      apiBaseUrl: String(values.GLITCH_API_BASE_URL || GLITCH_API_BASE_URL).replace(/\/$/, ''),
      titleId: GLITCH_TITLE_ID,
      titleToken,
      environment,
      apiOrigin: String(values.REGOLITH_PUBLIC_API_ORIGIN || ''),
      cloudSavesEnabled: values.GLITCH_CLOUD_SAVES_ENABLED !== '0',
      analyticsEnabled: enabled,
      allowedOrigins: String(values.REGOLITH_ALLOWED_ORIGINS || '')
        .split(',').map(v => v.trim()).filter(Boolean),
      requestTimeoutMs: Math.max(1000, Number(values.GLITCH_REQUEST_TIMEOUT_MS) || 10_000),
      rateLimitPerMinute: Math.max(10, Number(values.GLITCH_RATE_LIMIT_PER_MINUTE) || 180)
    }
  };
}

function runtimeConfig(config) {
  const publicConfig = {
    glitch: {
      enabled: config.enabled,
      titleId: config.titleId,
      environment: config.environment,
      apiOrigin: config.apiOrigin,
      cloudSavesEnabled: config.enabled && config.cloudSavesEnabled,
      analyticsEnabled: config.enabled && config.analyticsEnabled,
      gameVersion: '1.1.3',
      buildType: 'production'
    }
  };
  return `window.REGOLITH_RUNTIME_CONFIG = Object.freeze(${JSON.stringify(publicConfig)});\n`;
}

function securityHeaders(contentType, apiOrigin = '') {
  let connect = "'self'";
  try { if (apiOrigin) connect += ` ${new URL(apiOrigin).origin}`; } catch { /* invalid values fail closed */ }
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'self' https://*.glitch.fun`,
    ...(contentType ? { 'Content-Type': contentType } : {})
  };
}

function isPublicPath(rel) {
  if (rel === '/index.html' || rel === '/runtime-config.js') return true;
  return ['/src/', '/vendor/', '/assets/'].some(prefix => rel.startsWith(prefix));
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createRegolithServer({ root = ROOT, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadServerConfig(env, root);
  if (config.glitch.requested && !config.glitch.enabled) {
    throw new Error('GLITCH_BACKEND_ENABLED requires GLITCH_TITLE_TOKEN.');
  }
  const handleGlitch = createGlitchProxy({ config: config.glitch, fetchImpl });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (await handleGlitch(req, res, url)) return;

  if (SHOTS && req.method === 'POST' && req.url.startsWith('/__shot')) {
    if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403).end('Forbidden'); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 400e6) req.destroy(); });
    req.on('end', () => {
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        const name = (q.get('n') || 'shot').replace(/[^\w.-]/g, '');
        const ext = (q.get('ext') || 'png').replace(/[^\w]/g, '');
        const b64 = body.replace(/^data:[\w/+.-]+;base64,/, '');
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SHOT_DIR, `${name}.${ext}`), Buffer.from(b64, 'base64'));
        res.writeHead(200).end('ok');
      } catch (e) { res.writeHead(500).end(String(e)); }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders('text/plain; charset=utf-8', config.glitch.apiOrigin) }).end('Method Not Allowed');
    return;
  }

  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400, securityHeaders('text/plain; charset=utf-8', config.glitch.apiOrigin)).end('Bad Request'); return; }
  if (rel === '/') rel = '/index.html';
  rel = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (!isPublicPath(rel)) {
    res.writeHead(404, securityHeaders('text/plain; charset=utf-8', config.glitch.apiOrigin)).end('404 — not found');
    return;
  }
  if (rel === '/runtime-config.js') {
    const data = Buffer.from(runtimeConfig(config.glitch));
    res.writeHead(200, {
      ...securityHeaders('text/javascript; charset=utf-8', config.glitch.apiOrigin),
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') res.end(); else res.end(data);
    return;
  }
  const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 — not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      ...securityHeaders(MIME[ext] || 'application/octet-stream', config.glitch.apiOrigin),
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      // COOP/COEP left off deliberately: nothing here needs SharedArrayBuffer.
    });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
  });

  return { server, config };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { server, config } = createRegolithServer();
  server.listen(config.port, () => {
    console.log(`\n  REGOLITH — The Silence at Anaxagoras`);
    console.log(`  running at  http://localhost:${config.port}`);
    console.log(`  online services  ${config.glitch.enabled ? 'enabled' : 'disabled'}\n`);
  });
}
