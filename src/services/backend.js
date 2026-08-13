const KEYS = {
  userInstallId: 'regolith.glitch.user_install_id.v1',
  installId: 'regolith.glitch.install_id.v1',
  deviceId: 'regolith.glitch.device_id.v1',
  lastValidAt: 'regolith.glitch.last_valid_at.v1'
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[a-z0-9_]{1,100}$/;
const VALIDATION_GRACE_MS = 24 * 60 * 60 * 1000;

export class BackendApiError extends Error {
  constructor(status, body = {}) {
    super(body.message || body.error || `Online service request failed (${status}).`);
    this.name = 'BackendApiError';
    this.status = status;
    this.code = body.code || body.reason || null;
    this.body = body;
  }
}

export class BackendAccessError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'BackendAccessError';
    this.reason = reason;
    this.playerMessage = message;
  }
}

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function safeSet(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* private mode */ }
}

function randomId(cryptoImpl) {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoImpl?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storedId(storage, key, cryptoImpl, preferred = null) {
  if (preferred) { safeSet(storage, key, preferred); return preferred; }
  const current = safeGet(storage, key);
  if (current) return current;
  const created = randomId(cryptoImpl);
  safeSet(storage, key, created);
  return created;
}

function bytesToBase64(bytes, btoaImpl = globalThis.btoa) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoaImpl(binary);
}

function base64ToBytes(value, atobImpl = globalThis.atob) {
  const binary = atobImpl(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function encodeCloudSave(value, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    payload: bytesToBase64(bytes),
    checksum: await sha256(bytes, cryptoImpl),
    sizeBytes: bytes.byteLength
  };
}

export async function decodeCloudSave(record, cryptoImpl = globalThis.crypto) {
  if (!record?.payload || typeof record.payload !== 'string') throw new Error('Cloud save payload is missing.');
  const bytes = base64ToBytes(record.payload);
  const checksum = await sha256(bytes, cryptoImpl);
  if (checksum !== record.checksum) throw new Error('Cloud save checksum does not match.');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function cleanMetadata(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => cleanMetadata(v, depth + 1)).filter(v => v !== undefined);
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.slice(0, 64);
    if (!key || /(token|secret|password|email|chat|message|dialogue|player_text)/i.test(key)) continue;
    const cleaned = cleanMetadata(rawValue, depth + 1);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

function deviceType(navigatorImpl, matchMediaImpl) {
  const coarse = matchMediaImpl?.('(pointer: coarse)')?.matches;
  const ua = String(navigatorImpl?.userAgent || '');
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (coarse || /mobile|android|iphone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function operatingSystem(navigatorImpl) {
  return String(navigatorImpl?.userAgentData?.platform || navigatorImpl?.platform || 'browser').slice(0, 255);
}

function accessMessage(reason) {
  switch (reason) {
    case 'LICENSE_EXPIRED_OR_MISSING': return 'This copy could not be licensed. Your local save is safe. Check your Glitch account and try again.';
    case 'TRIAL_EXPIRED': return 'This trial has ended. Your local save is safe. Open the game from Glitch to continue.';
    case 'AGE_GATE_LOCKED': return 'This account cannot open the game because its age settings do not allow access.';
    case 'ACCOUNT_SUSPENDED': return 'This account cannot open the game right now. Contact Glitch support for help.';
    case 'SUBSCRIPTION_REQUIRED': return 'A Glitch subscription is required to open this build.';
    default: return 'We could not verify access to the game. Your local save is safe. Check your connection and try again.';
  }
}

export class RegolithBackend {
  constructor({
    config = globalThis.REGOLITH_RUNTIME_CONFIG?.glitch || {},
    storage = globalThis.localStorage,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cryptoImpl = globalThis.crypto,
    locationImpl = globalThis.location,
    navigatorImpl = globalThis.navigator,
    matchMediaImpl = globalThis.matchMedia?.bind(globalThis),
    now = () => Date.now(),
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
    onStatus = () => {}
  } = {}) {
    this.config = {
      enabled: !!config.enabled,
      titleId: config.titleId || '',
      environment: config.environment || 'development',
      apiOrigin: String(config.apiOrigin || '').replace(/\/$/, ''),
      cloudSavesEnabled: !!config.cloudSavesEnabled,
      analyticsEnabled: !!config.analyticsEnabled,
      gameVersion: config.gameVersion || '1.1.3',
      buildType: config.buildType || 'production'
    };
    Object.assign(this, {
      storage, fetchImpl, cryptoImpl, locationImpl, navigatorImpl, matchMediaImpl,
      now, setTimeoutImpl, clearTimeoutImpl, onStatus
    });
    this.valid = false;
    this.online = false;
    this.linkedUser = false;
    this.active = false;
    this.eventQueue = [];
    this.eventSending = false;
    this.eventRetryTimer = null;
    this.eventDedupe = new Map();
    this.previousStep = null;
    this.cloudVersion = 0;
    this.cloudChecksum = null;
    this.cloudRecord = null;
    this.cloudPending = null;
    this.cloudSending = false;
    this.cloudDisabled = false;
    this.sessionStartedAt = this.now();
  }

  get enabled() { return this.config.enabled; }
  get analyticsAvailable() { return this.enabled && this.config.analyticsEnabled; }
  get cloudAvailable() {
    return this.enabled && this.valid && this.online && this.config.cloudSavesEnabled &&
      this.linkedUser && !this.cloudDisabled;
  }

  _url(path) { return `${this.config.apiOrigin}${path}`; }

  async _request(path, { method = 'GET', body, keepalive = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this._url(path), {
        method,
        headers: body === undefined ? { Accept: 'application/json' } :
          { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        keepalive
      });
    } catch {
      throw new BackendApiError(0, { code: 'NETWORK_ERROR', message: 'Online services are unreachable.' });
    }
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: 'Online services returned an unreadable response.' }; }
    }
    if (!response.ok) throw new BackendApiError(response.status, data);
    return data;
  }

  _installBody() {
    return {
      user_install_id: this.userInstallId,
      platform: 'web',
      device_type: deviceType(this.navigatorImpl, this.matchMediaImpl),
      operating_system: operatingSystem(this.navigatorImpl),
      game_version: this.config.gameVersion,
      build_type: this.config.buildType,
      device_id: this.deviceId,
      session_id: this.sessionId
    };
  }

  async _createInstall({ adopt = true } = {}) {
    const response = await this._request('/api/glitch/installs', { method: 'POST', body: this._installBody() });
    const install = response.data || response;
    if (!install?.id || !UUID.test(install.id)) {
      throw new BackendApiError(502, { code: 'INVALID_INSTALL_RESPONSE', message: 'Glitch did not return an install ID.' });
    }
    if (adopt) {
      this.installId = install.id;
      safeSet(this.storage, KEYS.installId, install.id);
    }
    return install;
  }

  async _validateInstall(installId) {
    return this._request(`/api/glitch/installs/${encodeURIComponent(installId)}/validate`, {
      method: 'POST', body: {}
    });
  }

  async initialize() {
    if (!this.enabled) return { enabled: false };
    if (!this.fetchImpl || !this.storage || !this.cryptoImpl) {
      throw new BackendAccessError('CLIENT_UNAVAILABLE', accessMessage());
    }

    const params = new URLSearchParams(this.locationImpl?.search || '');
    const launchTitleId = params.get('title_id') || params.get('game_id');
    if (launchTitleId && launchTitleId !== this.config.titleId) {
      throw new BackendAccessError('TITLE_MISMATCH', 'This launch link belongs to a different game. Open Regolith again from its Glitch page.');
    }
    const launchUserInstallId = params.get('user_install_id');
    const launchInstallId = params.get('install_id');
    const launchSessionId = params.get('session_id');
    this.userInstallId = storedId(this.storage, KEYS.userInstallId, this.cryptoImpl, launchUserInstallId);
    this.deviceId = storedId(this.storage, KEYS.deviceId, this.cryptoImpl);
    this.sessionId = (launchSessionId || randomId(this.cryptoImpl)).slice(0, 255);
    this.installId = launchInstallId || safeGet(this.storage, KEYS.installId);
    this.canHeartbeat = !launchInstallId || !!launchUserInstallId;

    let install = null;
    try {
      let validation;
      if (launchInstallId && UUID.test(launchInstallId)) {
        safeSet(this.storage, KEYS.installId, launchInstallId);
        try {
          validation = await this._validateInstall(launchInstallId);
        } catch (error) {
          if (error.status !== 404) throw error;
          install = await this._createInstall();
          validation = await this._validateInstall(install.id);
        }
      } else {
        install = await this._createInstall();
        validation = await this._validateInstall(install.id);
      }

      if (!validation.valid) {
        const reason = validation.reason || validation.code || 'ACCESS_DENIED';
        throw new BackendAccessError(reason, accessMessage(reason));
      }
      this.valid = true;
      this.online = true;
      this.linkedUser = !!(validation.user_id || install?.user_id);
      safeSet(this.storage, KEYS.lastValidAt, String(this.now()));
      this.onStatus(this.linkedUser && this.config.cloudSavesEnabled
        ? 'Online services connected.'
        : 'Access verified. Cloud saves need a signed-in Glitch account.');
      this.track('app_launch', 'session_started', {
        session_id: this.sessionId,
        game_version: this.config.gameVersion,
        build_type: this.config.buildType,
        platform: 'web'
      }, { dedupeKey: `session:${this.sessionId}` });
      return { enabled: true, valid: true, installId: this.installId, linkedUser: this.linkedUser };
    } catch (error) {
      if (error instanceof BackendAccessError) throw error;
      if (error instanceof BackendApiError && error.status === 403) {
        const reason = error.code || 'ACCESS_DENIED';
        throw new BackendAccessError(reason, accessMessage(reason));
      }
      const lastValidAt = Number(safeGet(this.storage, KEYS.lastValidAt) || 0);
      const storedInstallId = safeGet(this.storage, KEYS.installId);
      if (storedInstallId && UUID.test(storedInstallId) && this.now() - lastValidAt <= VALIDATION_GRACE_MS) {
        this.installId = storedInstallId;
        this.valid = true;
        this.online = false;
        this.onStatus('Playing offline. Progress is saved on this device and will sync later.');
        return { enabled: true, valid: true, offlineGrace: true, installId: this.installId };
      }
      throw new BackendAccessError(error.code || 'VALIDATION_UNAVAILABLE', accessMessage());
    }
  }

  track(stepKey, actionKey, metadata = {}, options = {}) {
    if (!this.analyticsAvailable || !this.valid || !this.online) return false;
    if (!SAFE_KEY.test(stepKey) || !SAFE_KEY.test(actionKey)) return false;
    const now = this.now();
    const dedupeKey = options.dedupeKey || `${stepKey}:${actionKey}:${JSON.stringify(metadata)}`;
    const last = this.eventDedupe.get(dedupeKey) || 0;
    if (now - last < (options.dedupeMs ?? 1000)) return false;
    this.eventDedupe.set(dedupeKey, now);
    if (this.eventDedupe.size > 200) {
      for (const [key, stamp] of this.eventDedupe) if (now - stamp > 60_000) this.eventDedupe.delete(key);
    }
    const event = {
      game_install_id: this.installId,
      step_key: stepKey,
      action_key: actionKey,
      metadata: cleanMetadata({
        ...metadata,
        session_id: this.sessionId,
        game_version: this.config.gameVersion,
        build_type: this.config.buildType
      }),
      event_timestamp: new Date(now).toISOString()
    };
    if (this.previousStep && this.previousStep !== stepKey) event.previous_step_key = this.previousStep;
    if (options.stepLabel) event.step_label = options.stepLabel;
    if (options.stepDescription) event.step_description = options.stepDescription;
    if (options.eventLabel) event.event_label = options.eventLabel;
    if (options.eventDescription) event.event_description = options.eventDescription;
    this.previousStep = stepKey;
    this.eventQueue.push({ event, attempts: 0 });
    if (this.eventQueue.length > 100) this.eventQueue.shift();
    void this._drainEvents();
    return true;
  }

  async _drainEvents(keepalive = false) {
    if (this.eventSending || !this.eventQueue.length) return;
    this.eventSending = true;
    try {
      while (this.eventQueue.length) {
        const item = this.eventQueue[0];
        try {
          await this._request('/api/glitch/events', { method: 'POST', body: item.event, keepalive });
          this.eventQueue.shift();
        } catch (error) {
          item.attempts++;
          if ((error.status >= 400 && error.status < 500 && error.status !== 429) || item.attempts >= 4) {
            this.eventQueue.shift();
            continue;
          }
          if (!this.eventRetryTimer && this.setTimeoutImpl) {
            const wait = Math.min(30_000, 1000 * 2 ** (item.attempts - 1));
            this.eventRetryTimer = this.setTimeoutImpl(() => {
              this.eventRetryTimer = null;
              void this._drainEvents();
            }, wait);
          }
          break;
        }
      }
    } finally {
      this.eventSending = false;
    }
  }

  startPlay(mode, resumed, context = {}) {
    this.active = true;
    this.playStartedAt = this.now();
    this.track('gameplay', 'started', { mode, resumed: !!resumed, ...context },
      { dedupeKey: `play:${this.sessionId}:${mode}:${this.playStartedAt}` });
    this._startHeartbeat();
  }

  endPlay(reason, context = {}) {
    const duration = Math.max(0, Math.round((this.now() - (this.playStartedAt || this.sessionStartedAt)) / 1000));
    this.track('session_end', 'ended', { reason, duration_seconds: duration, ...context },
      { dedupeKey: `end:${this.sessionId}:${reason}`, dedupeMs: 60_000 });
    this.active = false;
    this._stopHeartbeat();
    void this._drainEvents(reason === 'page_unload');
  }

  _startHeartbeat() {
    if (this.heartbeatTimer || !this.canHeartbeat || !this.online || !this.setTimeoutImpl) return;
    const run = async () => {
      this.heartbeatTimer = null;
      if (!this.active) return;
      try { await this._createInstall({ adopt: false }); } catch { /* heartbeat never interrupts play */ }
      this.heartbeatTimer = this.setTimeoutImpl(run, 30_000);
    };
    this.heartbeatTimer = this.setTimeoutImpl(run, 30_000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer && this.clearTimeoutImpl) this.clearTimeoutImpl(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async syncInitialSave(saveStore) {
    this.saveStore = saveStore;
    if (!this.cloudAvailable) return;
    try {
      const response = await this._request(
        `/api/glitch/installs/${encodeURIComponent(this.installId)}/saves?include_payload=1`);
      const records = Array.isArray(response.data) ? response.data : [];
      const remote = records.find(record => record.slot_index === 0) || null;
      const local = saveStore.read();
      const meta = saveStore.meta();
      if (!remote) {
        if (local) this.queueCloudSave(local, meta);
        return;
      }
      const remoteData = await decodeCloudSave(remote, this.cryptoImpl);
      this.cloudRecord = remote;
      this.cloudVersion = remote.version || 0;
      this.cloudChecksum = remote.checksum;
      if (!local) {
        saveStore.replaceFromCloud(remoteData, remote);
        this.track('cloud_save', 'restored', { version: remote.version });
        this.onStatus('Cloud save restored.');
        return;
      }
      const encodedLocal = await encodeCloudSave(local, this.cryptoImpl);
      if (encodedLocal.checksum === remote.checksum) {
        saveStore.markCloudSynced(remote.version, remote.checksum);
        this.onStatus('Cloud save is up to date.');
        return;
      }
      if (meta.cloudChecksum === remote.checksum) {
        this.queueCloudSave(local, meta);
        return;
      }
      if (meta.cloudChecksum === encodedLocal.checksum) {
        saveStore.replaceFromCloud(remoteData, remote);
        this.track('cloud_save', 'restored', { version: remote.version });
        this.onStatus('Newer cloud progress restored.');
        return;
      }
      saveStore.replaceFromCloud(remoteData, remote);
      this.track('cloud_save', 'conflict_detected', {
        server_version: remote.version,
        local_base_version: meta.cloudVersion || 0,
        automatic: true
      });
      this.track('cloud_save', 'conflict_resolved', {
        choice: 'keep_server', version: remote.version, automatic: true
      });
      this.onStatus('Cloud progress restored automatically.');
    } catch (error) {
      if (error.status === 403 && error.code === 'GUEST_NOT_ALLOWED') {
        this.cloudDisabled = true;
        this.onStatus('Cloud saves need a signed-in Glitch account. Progress remains on this device.');
      } else {
        this.onStatus('Cloud sync is temporarily unavailable. Progress remains on this device.');
        this.track('cloud_save', 'sync_failed', { error_type: error.code || 'unavailable' });
      }
    }
  }

  queueCloudSave(data, meta = {}) {
    if (!this.cloudAvailable) return;
    this.cloudPending = { data, meta };
    void this._drainCloud();
  }

  async _drainCloud() {
    if (this.cloudSending || !this.cloudPending) return;
    this.cloudSending = true;
    try {
      while (this.cloudPending && this.cloudAvailable) {
        const pending = this.cloudPending;
        this.cloudPending = null;
        try { await this._uploadSave(pending.data, pending.meta); }
        catch (error) {
          if (error.status === 403 && error.code === 'GUEST_NOT_ALLOWED') this.cloudDisabled = true;
          else this.cloudPending = pending;
          this.onStatus('Cloud sync paused. Progress remains saved on this device.');
          this.track('cloud_save', 'sync_failed', { error_type: error.code || 'unavailable' });
          break;
        }
      }
    } finally {
      this.cloudSending = false;
    }
  }

  async _uploadSave(data, meta = {}) {
    const encoded = await encodeCloudSave(data, this.cryptoImpl);
    if (encoded.checksum === this.cloudChecksum) return;
    const nowIso = new Date(this.now()).toISOString();
    const body = {
      slot_index: 0,
      payload: encoded.payload,
      checksum: encoded.checksum,
      save_type: 'auto',
      client_timestamp: nowIso,
      base_version: Number.isInteger(meta.cloudVersion) ? meta.cloudVersion : this.cloudVersion,
      slot_name: 'Autosave',
      metadata: {
        mission_index: Number(data.missionIdx || 0),
        relays_placed: Number(data.relaysPlaced || 0),
        samples_excavated: Number(data.anoms?.filter?.(v => v === 1).length || 0)
      },
      device_id: this.deviceId,
      platform: 'web',
      game_version: this.config.gameVersion,
      last_played_at: nowIso,
      play_duration_seconds: Math.max(0, Math.round(Number(data.met || 0)))
    };
    try {
      const response = await this._request(
        `/api/glitch/installs/${encodeURIComponent(this.installId)}/saves`,
        { method: 'POST', body });
      const record = response.data || response;
      this.cloudRecord = record;
      this.cloudVersion = record.version || this.cloudVersion;
      this.cloudChecksum = record.checksum || encoded.checksum;
      this.saveStore?.markCloudSynced(this.cloudVersion, this.cloudChecksum);
      this.track('cloud_save', 'synced', { version: this.cloudVersion, size_bytes: encoded.sizeBytes });
      this.onStatus('Progress saved to the cloud.');
    } catch (error) {
      if (error.status !== 409) throw error;
      const conflict = error.body;
      this.track('cloud_save', 'conflict_detected', {
        server_version: conflict.server_version,
        local_base_version: conflict.your_base_version
      });
      const choice = 'keep_server';
      const resolvedResponse = await this._request(
        `/api/glitch/installs/${encodeURIComponent(this.installId)}/saves/${encodeURIComponent(conflict.save_id)}/resolve`,
        { method: 'POST', body: { conflict_id: conflict.conflict_id, choice } });
      const resolved = resolvedResponse.data || resolvedResponse;
      this.cloudVersion = resolved.version || conflict.server_version || this.cloudVersion;
      this.cloudChecksum = resolved.checksum || null;
      try {
        let latest = resolved?.payload ? resolved : null;
        if (!latest) {
          const latestResponse = await this._request(
            `/api/glitch/installs/${encodeURIComponent(this.installId)}/saves?include_payload=1`);
          latest = (latestResponse.data || []).find(record => record.slot_index === 0) || null;
        }
        if (!latest) throw new BackendApiError(502, {
          code: 'CLOUD_SAVE_MISSING', message: 'The resolved cloud save could not be loaded.'
        });
        const cloudData = await decodeCloudSave(latest, this.cryptoImpl);
        this.cloudVersion = latest.version || this.cloudVersion;
        this.cloudChecksum = latest.checksum;
        this.saveStore?.replaceFromCloud(cloudData, latest);
      } catch (error) {
        // The server already kept its cloud copy. Disable further uploads for
        // this session so stale local data cannot overwrite it after a
        // transient read failure; the next online launch will restore it.
        this.cloudDisabled = true;
        this.track('cloud_save', 'conflict_resolved', {
          choice, version: this.cloudVersion, automatic: true, local_restore: 'deferred'
        });
        this.track('cloud_save', 'sync_failed', {
          error_type: error.code || 'restore_unavailable', phase: 'restore_after_conflict'
        });
        this.onStatus('Cloud copy kept. It will restore on the next online launch.');
        return;
      }
      this.track('cloud_save', 'conflict_resolved', {
        choice, version: this.cloudVersion, automatic: true, local_restore: 'completed'
      });
      this.onStatus('Cloud progress restored automatically.');
    }
  }
}

export function createBrowserBackend(options = {}) { return new RegolithBackend(options); }
