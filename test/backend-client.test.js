import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  BackendAccessError,
  RegolithBackend,
  decodeCloudSave,
  encodeCloudSave
} from '../src/services/backend.js';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
const SAVE_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const TITLE_ID = '6bd2c447-1770-441b-b94b-bceed5e81e87';

class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    titleId: TITLE_ID,
    environment: 'production',
    apiOrigin: '',
    cloudSavesEnabled: true,
    analyticsEnabled: true,
    gameVersion: '1.1.2',
    buildType: 'production',
    ...overrides
  };
}

function createClient({ fetchImpl, config, storage, search = '', now, onConflict, timers = false } = {}) {
  return new RegolithBackend({
    config: config || baseConfig(),
    storage: storage || new MemoryStorage(),
    fetchImpl,
    cryptoImpl: webcrypto,
    locationImpl: { search },
    navigatorImpl: { platform: 'TestOS', userAgent: 'Desktop Test' },
    matchMediaImpl: () => ({ matches: false }),
    now: now || (() => Date.parse('2026-08-13T12:00:00Z')),
    setTimeoutImpl: timers ? setTimeout : () => 1,
    clearTimeoutImpl: timers ? clearTimeout : () => {},
    onConflict
  });
}

function saveStore(local = null, meta = {}) {
  return {
    value: local,
    metadata: { ...meta },
    read() { return this.value; },
    meta() { return { ...this.metadata }; },
    replaceFromCloud(value, record) {
      this.value = value;
      this.metadata = { cloudVersion: record.version, cloudChecksum: record.checksum };
    },
    markCloudSynced(version, checksum) {
      this.metadata.cloudVersion = version;
      this.metadata.cloudChecksum = checksum;
    }
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('cloud saves hash decoded JSON bytes and round-trip safely', async () => {
  const original = { missionIdx: 3, unlocked: ['memo'], text: 'lunar ✓' };
  const encoded = await encodeCloudSave(original, webcrypto);
  assert.match(encoded.payload, /^[A-Za-z0-9+/]+=*$/);
  assert.match(encoded.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(await decodeCloudSave({ ...encoded }, webcrypto), original);
});

test('cloud save decoder rejects payload tampering', async () => {
  const encoded = await encodeCloudSave({ missionIdx: 1 }, webcrypto);
  const tampered = { ...encoded, payload: btoa('{"missionIdx":2}') };
  await assert.rejects(() => decodeCloudSave(tampered, webcrypto), /checksum/i);
});

test('disabled backend performs no network work', async () => {
  let calls = 0;
  const client = createClient({ config: baseConfig({ enabled: false }), fetchImpl: async () => { calls++; } });
  assert.deepEqual(await client.initialize(), { enabled: false });
  assert.equal(calls, 0);
});

test('install creation is followed by validation and identifiers are persisted', async () => {
  const calls = [];
  const storage = new MemoryStorage();
  const client = createClient({
    storage,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body && JSON.parse(options.body) });
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID, user_id: 'user' } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true, user_id: 'user' });
      throw new Error(`Unexpected ${url}`);
    }
  });
  const result = await client.initialize();
  assert.equal(result.installId, INSTALL_ID);
  assert.equal(calls[0].url, '/api/glitch/installs');
  assert.equal(calls[1].url, `/api/glitch/installs/${INSTALL_ID}/validate`);
  assert.equal(calls[0].body.platform, 'web');
  assert.equal(calls[0].body.game_version, '1.1.2');
  assert.ok(calls[0].body.user_install_id);
  assert.equal(storage.getItem('regolith.glitch.install_id.v1'), INSTALL_ID);
});

test('desktop launch install ID is validated before fallback creation', async () => {
  const calls = [];
  const client = createClient({
    search: `?title_id=${TITLE_ID}&install_id=${INSTALL_ID}&user_install_id=device-7&session_id=session-9`,
    fetchImpl: async (url) => { calls.push(url); return response({ valid: true, user_id: 'user' }); }
  });
  await client.initialize();
  assert.deepEqual(calls.filter(url => url !== '/api/glitch/events'),
    [`/api/glitch/installs/${INSTALL_ID}/validate`]);
  assert.equal(client.userInstallId, 'device-7');
  assert.equal(client.sessionId, 'session-9');
});

test('missing desktop install is recreated and revalidated', async () => {
  const calls = [];
  const client = createClient({
    search: `?install_id=${INSTALL_ID}`,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) return response({ code: 'INSTALL_NOT_FOUND' }, 404);
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID } }, 201);
      return response({ valid: true });
    }
  });
  await client.initialize();
  assert.deepEqual(calls.filter(url => url !== '/api/glitch/events'), [
    `/api/glitch/installs/${INSTALL_ID}/validate`,
    '/api/glitch/installs',
    `/api/glitch/installs/${INSTALL_ID}/validate`
  ]);
});

test('license denial produces a player-safe access error', async () => {
  const client = createClient({
    fetchImpl: async (url) => url === '/api/glitch/installs'
      ? response({ data: { id: INSTALL_ID } }, 201)
      : response({ valid: false, reason: 'TRIAL_EXPIRED' })
  });
  await assert.rejects(() => client.initialize(), (error) => {
    assert.ok(error instanceof BackendAccessError);
    assert.equal(error.reason, 'TRIAL_EXPIRED');
    assert.doesNotMatch(error.playerMessage, /403|UUID|JSON|stack/i);
    return true;
  });
});

test('recent successful validation grants a bounded offline grace period', async () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  const storage = new MemoryStorage({
    'regolith.glitch.install_id.v1': INSTALL_ID,
    'regolith.glitch.last_valid_at.v1': String(now - 60_000)
  });
  const client = createClient({ storage, now: () => now, fetchImpl: async () => { throw new Error('offline'); } });
  const result = await client.initialize();
  assert.equal(result.offlineGrace, true);
  assert.equal(client.online, false);
});

test('analytics starts automatically whenever the Glitch backend is enabled', async () => {
  const events = [];
  const client = createClient({
    config: baseConfig({ environment: 'development' }),
    fetchImpl: async (url, options) => {
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true });
      events.push(JSON.parse(options.body));
      return response({ data: {} }, 201);
    }
  });
  await client.initialize();
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].step_key, 'app_launch');
  assert.equal(events[0].action_key, 'session_started');
});

test('analytics payloads contain stable context, remove sensitive keys, and deduplicate', async () => {
  const events = [];
  const client = createClient({
    fetchImpl: async (url, options) => {
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true });
      events.push(JSON.parse(options.body));
      return response({ data: { id: 'event' } }, 201);
    }
  });
  await client.initialize();
  await settle();
  events.length = 0;
  client.track('mission_01', 'objective_completed', {
    objective_id: 'scan', password: 'never-send', private_message: 'secret'
  }, { dedupeKey: 'objective-1' });
  client.track('mission_01', 'objective_completed', { objective_id: 'scan' }, { dedupeKey: 'objective-1' });
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].game_install_id, INSTALL_ID);
  assert.equal(events[0].step_key, 'mission_01');
  assert.equal(events[0].metadata.game_version, '1.1.2');
  assert.equal(events[0].metadata.password, undefined);
  assert.equal(events[0].metadata.private_message, undefined);
});

test('analytics provider failures never reject gameplay calls', async () => {
  const client = createClient({
    fetchImpl: async (url) => {
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true });
      throw new Error('blocked');
    }
  });
  await client.initialize();
  assert.doesNotThrow(() => client.track('gameplay', 'started'));
  await settle();
  assert.ok(client.eventQueue.length >= 1);
});

test('new local progress uploads with exact cloud-save fields', async () => {
  const requests = [];
  const local = { missionIdx: 2, relaysPlaced: 1, met: 45, anoms: [1, 0, 2] };
  const store = saveStore(local);
  const client = createClient({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID, user_id: 'user' } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true, user_id: 'user' });
      if (options.method === 'GET') return response({ data: [] });
      if (url.endsWith('/saves')) return response({ data: { id: SAVE_ID, version: 1, checksum: requests.at(-1).body.checksum } }, 201);
      if (url === '/api/glitch/events') return response({ data: {} }, 201);
      throw new Error(`Unexpected ${url}`);
    }
  });
  await client.initialize();
  await client.syncInitialSave(store);
  await settle();
  const upload = requests.find(item => item.url.endsWith('/saves') && item.body?.payload);
  assert.equal(upload.body.slot_index, 0);
  assert.equal(upload.body.save_type, 'auto');
  assert.equal(upload.body.base_version, 0);
  assert.match(upload.body.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(atob(upload.body.payload)), local);
  assert.equal(store.metadata.cloudVersion, 1);
});

test('remote-only cloud progress is checksum-verified and restored locally', async () => {
  const remoteData = { missionIdx: 3, met: 321, relaysPlaced: 2 };
  const encoded = await encodeCloudSave(remoteData, webcrypto);
  const store = saveStore(null);
  const client = createClient({
    fetchImpl: async (url, options = {}) => {
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID, user_id: 'user' } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true, user_id: 'user' });
      if (options.method === 'GET') return response({ data: [{
        id: SAVE_ID, slot_index: 0, version: 7, client_timestamp: '2026-08-13T11:00:00Z', ...encoded
      }] });
      if (url === '/api/glitch/events') return response({ data: {} }, 201);
      throw new Error(`Unexpected ${url}`);
    }
  });
  await client.initialize();
  await client.syncInitialSave(store);
  assert.deepEqual(store.value, remoteData);
  assert.equal(store.metadata.cloudVersion, 7);
  assert.equal(store.metadata.cloudChecksum, encoded.checksum);
});

test('409 cloud conflict is surfaced and resolved through the documented route', async () => {
  const local = { missionIdx: 4, met: 500 };
  const remoteEncoded = await encodeCloudSave({ missionIdx: 2, met: 200 }, webcrypto);
  const store = saveStore(local);
  const calls = [];
  const client = createClient({
    onConflict: async () => 'use_client',
    fetchImpl: async (url, options = {}) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ url, body, method: options.method });
      if (url === '/api/glitch/installs') return response({ data: { id: INSTALL_ID, user_id: 'user' } }, 201);
      if (url.endsWith('/validate')) return response({ valid: true, user_id: 'user' });
      if (options.method === 'GET') return response({ data: [{
        id: SAVE_ID, slot_index: 0, version: 3, ...remoteEncoded
      }] });
      if (url.endsWith('/saves')) return response({
        status: 'conflict', save_id: SAVE_ID, conflict_id: CONFLICT_ID,
        server_version: 3, your_base_version: 0
      }, 409);
      if (url.endsWith(`/saves/${SAVE_ID}/resolve`)) return response({
        data: { id: SAVE_ID, version: 4, checksum: body.choice === 'use_client' ? (await encodeCloudSave(local, webcrypto)).checksum : remoteEncoded.checksum }
      });
      if (url === '/api/glitch/events') return response({ data: {} }, 201);
      throw new Error(`Unexpected ${url}`);
    }
  });
  await client.initialize();
  await client.syncInitialSave(store);
  const resolveCall = calls.find(item => item.url.endsWith(`/saves/${SAVE_ID}/resolve`));
  assert.deepEqual(resolveCall.body, { conflict_id: CONFLICT_ID, choice: 'use_client' });
  assert.equal(store.metadata.cloudVersion, 4);
});
