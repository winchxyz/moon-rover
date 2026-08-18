const KEY = 'regolith.anaxagoras.v1';
const META_KEY = KEY + '.meta';
let syncHandler = null;

function readMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || 'null') || {}; }
  catch { return {}; }
}

function writeMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* private mode */ }
}

export const Save = {
  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch { return null; }
  },
  write(data, options = {}) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      const meta = { ...readMeta(), updatedAt: options.updatedAt || new Date().toISOString() };
      writeMeta(meta);
      if (options.sync !== false && syncHandler) syncHandler(data, meta);
      return true;
    }
    catch { return false; }
  },
  clear() {
    try { localStorage.removeItem(KEY); localStorage.removeItem(META_KEY); } catch { /* private mode */ }
  },
  meta() { return readMeta(); },
  markCloudSynced(version, checksum) {
    writeMeta({ ...readMeta(), cloudVersion: version, cloudChecksum: checksum });
  },
  replaceFromCloud(data, record) {
    const updatedAt = record.client_timestamp || record.updated_at || new Date().toISOString();
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      writeMeta({ updatedAt, cloudVersion: record.version, cloudChecksum: record.checksum });
      return true;
    } catch { return false; }
  },
  setSyncHandler(handler) { syncHandler = typeof handler === 'function' ? handler : null; },
  settings() {
    try { return JSON.parse(localStorage.getItem(KEY + '.set') || 'null') || {}; }
    catch { return {}; }
  },
  saveSettings(s) {
    try { localStorage.setItem(KEY + '.set', JSON.stringify(s)); } catch { /* ignore */ }
  }
};
