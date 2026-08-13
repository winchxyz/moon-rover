import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRegolithServer } from '../server.js';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'test-runtime-token-that-must-never-be-public';

function enabledEnv(overrides = {}) {
  return {
    GLITCH_BACKEND_ENABLED: '1',
    GLITCH_TITLE_TOKEN: TOKEN,
    NODE_ENV: 'production',
    ...overrides
  };
}

async function withServer(options, fn) {
  const { server, config } = createRegolithServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`, config); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function upstreamJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('static runtime configuration is disabled without credentials', async () => {
  await withServer({ env: {} }, async (base) => {
    const response = await fetch(`${base}/runtime-config.js`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"enabled":false/);
    assert.doesNotMatch(text, /Bearer|gl_deploy|title-token/i);
  });
});

test('enabled runtime configuration exposes capability flags but never the token', async () => {
  await withServer({ env: enabledEnv() }, async (base) => {
    const text = await (await fetch(`${base}/runtime-config.js`)).text();
    assert.match(text, /"enabled":true/);
    assert.match(text, /"analyticsEnabled":true/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
  });
});

test('server-only files and traversal attempts are not publicly readable', async () => {
  await withServer({ env: enabledEnv() }, async (base) => {
    assert.equal((await fetch(`${base}/backend/runtime-secrets.json`)).status, 404);
    assert.equal((await fetch(`${base}/src/../../server.js`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
  });
});

test('install proxy uses the exact Glitch route, bearer token, and allowlisted fields', async () => {
  const upstreamCalls = [];
  await withServer({
    env: enabledEnv(),
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options, body: JSON.parse(options.body) });
      return upstreamJson({ data: { id: INSTALL_ID } }, 201);
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/glitch/installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_install_id: 'stable-device', platform: 'web', invented_field: 'drop-me' })
    });
    assert.equal(response.status, 201);
  });
  assert.equal(upstreamCalls[0].url,
    'https://api.glitch.fun/api/titles/6bd2c447-1770-441b-b94b-bceed5e81e87/installs');
  assert.equal(upstreamCalls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(upstreamCalls[0].body.invented_field, undefined);
});

test('install validation rejects non-UUID path values before upstream', async () => {
  let upstreamCalls = 0;
  await withServer({ env: enabledEnv(), fetchImpl: async () => { upstreamCalls++; } }, async (base) => {
    const response = await fetch(`${base}/api/glitch/installs/not-a-uuid/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'VALIDATION_ERROR');
  });
  assert.equal(upstreamCalls, 0);
});

test('save proxy verifies SHA-256 over decoded bytes before forwarding', async () => {
  const raw = Buffer.from(JSON.stringify({ missionIdx: 2 }));
  const payload = raw.toString('base64');
  const checksum = createHash('sha256').update(raw).digest('hex');
  let forwarded;
  await withServer({
    env: enabledEnv(),
    fetchImpl: async (url, options) => {
      forwarded = { url, body: JSON.parse(options.body) };
      return upstreamJson({ data: { version: 1, checksum } }, 201);
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/glitch/installs/${INSTALL_ID}/saves`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot_index: 0, payload, checksum, save_type: 'auto',
        client_timestamp: '2026-08-13T12:00:00.000Z', base_version: 0
      })
    });
    assert.equal(response.status, 201);
  });
  assert.equal(forwarded.url,
    `https://api.glitch.fun/api/titles/6bd2c447-1770-441b-b94b-bceed5e81e87/installs/${INSTALL_ID}/saves`);
  assert.equal(forwarded.body.checksum, checksum);
});

test('checksum mismatch is rejected without contacting Glitch', async () => {
  const raw = Buffer.from('{}');
  let upstreamCalls = 0;
  await withServer({ env: enabledEnv(), fetchImpl: async () => { upstreamCalls++; } }, async (base) => {
    const response = await fetch(`${base}/api/glitch/installs/${INSTALL_ID}/saves`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slot_index: 0, payload: raw.toString('base64'), checksum: '0'.repeat(64),
        save_type: 'auto', client_timestamp: '2026-08-13T12:00:00.000Z'
      })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'CHECKSUM_MISMATCH');
  });
  assert.equal(upstreamCalls, 0);
});

test('behavior analytics remains enabled outside production when Glitch is enabled', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: enabledEnv({ NODE_ENV: 'development' }),
    fetchImpl: async () => { upstreamCalls++; return upstreamJson({ data: { id: 'event' } }, 201); }
  }, async (base) => {
    const response = await fetch(`${base}/api/glitch/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_install_id: INSTALL_ID, step_key: 'main_menu', action_key: 'viewed' })
    });
    assert.equal(response.status, 201);
  });
  assert.equal(upstreamCalls, 1);
});

test('behavior events forward only documented fields in production', async () => {
  let forwarded;
  await withServer({
    env: enabledEnv(),
    fetchImpl: async (url, options) => {
      forwarded = { url, body: JSON.parse(options.body) };
      return upstreamJson({ data: { id: 'event' } }, 201);
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/glitch/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_install_id: INSTALL_ID, step_key: 'mission_01', action_key: 'started',
        metadata: { input_method: 'keyboard_mouse' }, private_token: 'drop-me'
      })
    });
    assert.equal(response.status, 201);
  });
  assert.equal(forwarded.url,
    'https://api.glitch.fun/api/titles/6bd2c447-1770-441b-b94b-bceed5e81e87/events');
  assert.equal(forwarded.body.private_token, undefined);
});

test('cross-origin API writes are rejected unless explicitly allowlisted', async () => {
  let upstreamCalls = 0;
  await withServer({ env: enabledEnv(), fetchImpl: async () => { upstreamCalls++; } }, async (base) => {
    const response = await fetch(`${base}/api/glitch/installs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ user_install_id: 'stable-device' })
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ORIGIN_NOT_ALLOWED');
  });
  assert.equal(upstreamCalls, 0);
});
