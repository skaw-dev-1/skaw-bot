const CONFIG_KEY = (guildId) => `guild:${guildId}:boombox_config_v9`;
const HISTORY_KEY = (guildId) => `guild:${guildId}:boombox_history_v9`;

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  channelId: null,
  cooldownSeconds: 8,
  maxDurationSeconds: 20 * 60,
  maxFileMb: 95,
  queueLimit: 8,
  maxConcurrent: 1,
});

async function dbGet(db, key, fallback) {
  if (!db) throw new Error('Database TitanBot belum siap.');
  if (typeof db.get === 'function') return await db.get(key, fallback);
  if (typeof db.getData === 'function') return await db.getData(key, fallback);
  throw new Error('Database adapter TitanBot tidak mendukung get().');
}

async function dbSet(db, key, value) {
  if (!db) throw new Error('Database TitanBot belum siap.');
  if (typeof db.set === 'function') return await db.set(key, value);
  if (typeof db.setData === 'function') return await db.setData(key, value);
  throw new Error('Database adapter TitanBot tidak mendukung set().');
}

function numberBetween(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function getBoomboxConfig(client, guildId) {
  const raw = await dbGet(client.db, CONFIG_KEY(guildId), {});
  const stored = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    enabled: Boolean(stored.enabled),
    channelId: stored.channelId ? String(stored.channelId) : null,
    cooldownSeconds: numberBetween(stored.cooldownSeconds, 0, 120, DEFAULT_CONFIG.cooldownSeconds),
    maxDurationSeconds: numberBetween(stored.maxDurationSeconds, 30, 3600, DEFAULT_CONFIG.maxDurationSeconds),
    maxFileMb: numberBetween(stored.maxFileMb, 10, 95, DEFAULT_CONFIG.maxFileMb),
    queueLimit: numberBetween(stored.queueLimit, 1, 25, DEFAULT_CONFIG.queueLimit),
    maxConcurrent: numberBetween(stored.maxConcurrent, 1, 2, DEFAULT_CONFIG.maxConcurrent),
  };
}

export async function saveBoomboxConfig(client, guildId, patch = {}) {
  const current = await getBoomboxConfig(client, guildId);
  const next = { ...current, ...patch };
  await dbSet(client.db, CONFIG_KEY(guildId), next);
  return next;
}

export function setBoomboxChannel(client, guildId, channelId) {
  return saveBoomboxConfig(client, guildId, { channelId: String(channelId) });
}

export function setBoomboxEnabled(client, guildId, enabled) {
  return saveBoomboxConfig(client, guildId, { enabled: Boolean(enabled) });
}

export async function resetBoomboxConfig(client, guildId) {
  await dbSet(client.db, CONFIG_KEY(guildId), { ...DEFAULT_CONFIG });
  await dbSet(client.db, HISTORY_KEY(guildId), []);
}

export async function getBoomboxHistory(client, guildId) {
  const raw = await dbGet(client.db, HISTORY_KEY(guildId), []);
  return Array.isArray(raw) ? raw : [];
}

export async function saveBoomboxResult(client, guildId, result) {
  const history = await getBoomboxHistory(client, guildId);
  const entry = {
    id: `bb9_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ...result,
    guildId: String(guildId),
    createdAt: result.createdAt || new Date().toISOString(),
  };

  const next = [entry, ...history]
    .filter((value, index, arr) => index === arr.findIndex((item) => item.id === value.id))
    .slice(0, 500);

  await dbSet(client.db, HISTORY_KEY(guildId), next);
  return entry;
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/^https:/i, 'http:').replace(/#.*$/, '');
}

export async function findResultByDirectUrl(client, guildId, directUrl) {
  const target = normalizeUrl(directUrl);
  const history = await getBoomboxHistory(client, guildId);
  return history.find((item) => normalizeUrl(item.directUrl) === target) || null;
}

export async function findResultBySourceUrl(client, guildId, sourceUrl) {
  const target = String(sourceUrl || '').trim();
  const history = await getBoomboxHistory(client, guildId);
  return history.find((item) => String(item.sourceUrl || '').trim() === target) || null;
}

export async function searchBoomboxHistory(client, guildId, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const history = await getBoomboxHistory(client, guildId);
  if (!q) return history.slice(0, limit);
  return history
    .filter((item) => [item.title, item.artist, item.sourceUrl, item.platform]
      .some((value) => String(value || '').toLowerCase().includes(q)))
    .slice(0, limit);
}

export function getDefaultBoomboxConfig() {
  return { ...DEFAULT_CONFIG };
}
