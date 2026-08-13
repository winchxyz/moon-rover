import { createHash } from 'node:crypto';

export const GLITCH_API_BASE_URL = 'https://api.glitch.fun/api';
export const GLITCH_TITLE_ID = '6bd2c447-1770-441b-b94b-bceed5e81e87';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM = /^[0-9a-f]{64}$/;
const INSTALL_FIELDS = [
  'user_install_id', 'user_id', 'user_email', 'user_name', 'platform',
  'device_type', 'operating_system', 'game_build_id', 'game_version',
  'build_type', 'device_id', 'referral_source', 'fingerprint_components',
  'session_id'
];
const SAVE_FIELDS = [
  'slot_index', 'payload', 'checksum', 'save_type', 'client_timestamp',
  'base_version', 'slot_name', 'metadata', 'device_id', 'platform',
  'game_version', 'last_played_at', 'play_duration_seconds'
];
const EVENT_FIELDS = [
  'game_install_id', 'step_key', 'step_label', 'step_description',
  'action_key', 'event_label', 'event_description', 'previous_step_key',
  'metadata', 'event_timestamp'
];

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(data);
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) if (source[field] !== undefined) result[field] = source[field];
  return result;
}

function assertString(value, name, max, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (required && !value) || value.length > max) {
    throw new RequestError(422, 'VALIDATION_ERROR', `${name} is invalid.`);
  }
}

function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RequestError(422, 'VALIDATION_ERROR', `${name} must be a UUID.`);
  }
}

function assertObject(value, name) {
  if (value !== undefined && (value === null || Array.isArray(value) || typeof value !== 'object')) {
    throw new RequestError(422, 'VALIDATION_ERROR', `${name} must be an object.`);
  }
}

function validateInstall(body) {
  const clean = pick(body, INSTALL_FIELDS);
  assertString(clean.user_install_id, 'user_install_id', 255, true);
  for (const field of ['user_email', 'user_name', 'device_type', 'operating_system', 'device_id', 'session_id']) {
    assertString(clean[field], field, 255);
  }
  assertString(clean.platform, 'platform', 50);
  assertString(clean.game_version, 'game_version', 50);
  if (clean.user_id !== undefined) assertUuid(clean.user_id, 'user_id');
  if (clean.game_build_id !== undefined) assertUuid(clean.game_build_id, 'game_build_id');
  if (clean.build_type !== undefined && !['production', 'demo', 'playtest'].includes(clean.build_type)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'build_type is invalid.');
  }
  if (clean.referral_source !== undefined &&
      !['social_media', 'advertising', 'influencer', 'newsletter', 'word_of_mouth', 'other'].includes(clean.referral_source)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'referral_source is invalid.');
  }
  assertObject(clean.fingerprint_components, 'fingerprint_components');
  return clean;
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  return bytes;
}

function validateSave(body) {
  const clean = pick(body, SAVE_FIELDS);
  if (!Number.isInteger(clean.slot_index) || clean.slot_index < 0 || clean.slot_index > 99) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'slot_index must be an integer from 0 to 99.');
  }
  const bytes = canonicalBase64(clean.payload);
  if (!bytes) throw new RequestError(400, 'INVALID_BASE64', 'Save payload is not valid base64.');
  if (bytes.length > 50 * 1024 * 1024) {
    throw new RequestError(413, 'PAYLOAD_TOO_LARGE', 'Decoded save payload exceeds 50 MB.');
  }
  if (typeof clean.checksum !== 'string' || !CHECKSUM.test(clean.checksum)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'checksum must be a lowercase SHA-256 value.');
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== clean.checksum) {
    throw new RequestError(400, 'CHECKSUM_MISMATCH', 'Save checksum does not match decoded bytes.');
  }
  if (!['manual', 'auto', 'checkpoint', 'quicksave'].includes(clean.save_type)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'save_type is invalid.');
  }
  assertString(clean.client_timestamp, 'client_timestamp', 64, true);
  if (!Number.isFinite(Date.parse(clean.client_timestamp))) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'client_timestamp must be ISO 8601.');
  }
  if (clean.base_version !== undefined && (!Number.isInteger(clean.base_version) || clean.base_version < 0)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'base_version must be a non-negative integer.');
  }
  assertString(clean.slot_name, 'slot_name', 100);
  assertString(clean.device_id, 'device_id', 255);
  assertString(clean.platform, 'platform', 50);
  assertString(clean.game_version, 'game_version', 50);
  assertString(clean.last_played_at, 'last_played_at', 64);
  if (clean.play_duration_seconds !== undefined &&
      (!Number.isInteger(clean.play_duration_seconds) || clean.play_duration_seconds < 0)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'play_duration_seconds must be a non-negative integer.');
  }
  assertObject(clean.metadata, 'metadata');
  return clean;
}

function validateResolve(body) {
  assertUuid(body.conflict_id, 'conflict_id');
  if (!['keep_server', 'use_client'].includes(body.choice)) {
    throw new RequestError(422, 'VALIDATION_ERROR', 'choice is invalid.');
  }
  return { conflict_id: body.conflict_id, choice: body.choice };
}

function validateEvent(body) {
  const clean = pick(body, EVENT_FIELDS);
  assertUuid(clean.game_install_id, 'game_install_id');
  assertString(clean.step_key, 'step_key', 100, true);
  assertString(clean.action_key, 'action_key', 100, true);
  assertString(clean.step_label, 'step_label', 255);
  assertString(clean.step_description, 'step_description', 2000);
  assertString(clean.event_label, 'event_label', 255);
  assertString(clean.event_description, 'event_description', 2000);
  assertString(clean.previous_step_key, 'previous_step_key', 100);
  assertString(clean.event_timestamp, 'event_timestamp', 64);
  assertObject(clean.metadata, 'metadata');
  return clean;
}

async function readJson(req, maxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed;
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

function requestOrigin(req) {
  const value = req.headers.origin;
  if (!value) return null;
  try { return new URL(value).origin; } catch { return 'invalid'; }
}

function originAllowed(req, config) {
  const origin = requestOrigin(req);
  if (!origin) return true;
  if (origin === 'invalid') return false;
  const originHost = new URL(origin).host;
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
  if (hosts.includes(originHost)) return true;
  return config.allowedOrigins.includes(origin);
}

function corsHeaders(req, config) {
  const origin = requestOrigin(req);
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function makeRateLimiter(limit, windowMs) {
  const clients = new Map();
  return (key, now = Date.now()) => {
    const current = clients.get(key);
    if (!current || current.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      return null;
    }
    current.count++;
    if (current.count <= limit) return null;
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  };
}

async function sendUpstream(res, config, fetchImpl, method, path, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const upstream = await fetchImpl(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.titleToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal
    });
    const data = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(data);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    json(res, timedOut ? 504 : 502, {
      code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      message: timedOut ? 'Glitch did not respond in time.' : 'Glitch is temporarily unavailable.'
    }, headers);
  } finally {
    clearTimeout(timeout);
  }
}

export function createGlitchProxy({ config, fetchImpl = globalThis.fetch }) {
  const rateLimit = makeRateLimiter(config.rateLimitPerMinute, 60_000);

  return async function handleGlitchRequest(req, res, url) {
    if (!url.pathname.startsWith('/api/glitch/')) return false;
    const extraHeaders = corsHeaders(req, config);

    if (!config.enabled) {
      json(res, 404, { code: 'BACKEND_DISABLED', message: 'Online services are not enabled.' });
      return true;
    }
    if (!originAllowed(req, config)) {
      json(res, 403, { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin cannot use online services.' });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, extraHeaders);
      res.end();
      return true;
    }

    const ip = req.socket.remoteAddress || 'unknown';
    const retryAfter = rateLimit(ip);
    if (retryAfter) {
      json(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
        { ...extraHeaders, 'Retry-After': retryAfter });
      return true;
    }

    try {
      let match;
      if (req.method === 'POST' && url.pathname === '/api/glitch/installs') {
        const body = validateInstall(await readJson(req, 128 * 1024));
        await sendUpstream(res, config, fetchImpl, 'POST',
          `/titles/${config.titleId}/installs`, body, extraHeaders);
        return true;
      }
      if (req.method === 'POST' &&
          (match = url.pathname.match(/^\/api\/glitch\/installs\/([^/]+)\/validate$/))) {
        assertUuid(match[1], 'install_id');
        await readJson(req, 16 * 1024);
        await sendUpstream(res, config, fetchImpl, 'POST',
          `/titles/${config.titleId}/installs/${match[1]}/validate`, {}, extraHeaders);
        return true;
      }
      if (req.method === 'GET' &&
          (match = url.pathname.match(/^\/api\/glitch\/installs\/([^/]+)\/saves$/))) {
        if (!config.cloudSavesEnabled) throw new RequestError(404, 'CLOUD_SAVES_DISABLED', 'Cloud saves are not enabled.');
        assertUuid(match[1], 'install_id');
        const include = url.searchParams.get('include_payload');
        const query = include === '0' || include === '1' ? `?include_payload=${include}` : '';
        await sendUpstream(res, config, fetchImpl, 'GET',
          `/titles/${config.titleId}/installs/${match[1]}/saves${query}`, undefined, extraHeaders);
        return true;
      }
      if (req.method === 'POST' &&
          (match = url.pathname.match(/^\/api\/glitch\/installs\/([^/]+)\/saves$/))) {
        if (!config.cloudSavesEnabled) throw new RequestError(404, 'CLOUD_SAVES_DISABLED', 'Cloud saves are not enabled.');
        assertUuid(match[1], 'install_id');
        const body = validateSave(await readJson(req, 70 * 1024 * 1024));
        await sendUpstream(res, config, fetchImpl, 'POST',
          `/titles/${config.titleId}/installs/${match[1]}/saves`, body, extraHeaders);
        return true;
      }
      if (req.method === 'POST' &&
          (match = url.pathname.match(/^\/api\/glitch\/installs\/([^/]+)\/saves\/([^/]+)\/resolve$/))) {
        if (!config.cloudSavesEnabled) throw new RequestError(404, 'CLOUD_SAVES_DISABLED', 'Cloud saves are not enabled.');
        assertUuid(match[1], 'install_id');
        assertUuid(match[2], 'save_id');
        const body = validateResolve(await readJson(req, 32 * 1024));
        await sendUpstream(res, config, fetchImpl, 'POST',
          `/titles/${config.titleId}/installs/${match[1]}/saves/${match[2]}/resolve`, body, extraHeaders);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/glitch/events') {
        if (!config.analyticsEnabled) throw new RequestError(404, 'ANALYTICS_DISABLED', 'Behavior analytics are not enabled.');
        const body = validateEvent(await readJson(req, 128 * 1024));
        await sendUpstream(res, config, fetchImpl, 'POST',
          `/titles/${config.titleId}/events`, body, extraHeaders);
        return true;
      }
      json(res, 404, { code: 'NOT_FOUND', message: 'Online-service route not found.' }, extraHeaders);
      return true;
    } catch (error) {
      if (error instanceof RequestError) {
        json(res, error.status, { code: error.code, message: error.message }, extraHeaders);
        return true;
      }
      json(res, 500, { code: 'BACKEND_ERROR', message: 'Online services could not process the request.' }, extraHeaders);
      return true;
    }
  };
}
