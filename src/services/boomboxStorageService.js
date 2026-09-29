const CONFIG_KEY = (guildId) => `guild:${guildId}:boombox_config`;
const HISTORY_KEY = (guildId) => `guild:${guildId}:boombox_history`;

const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    channelId: null,
    cooldownSeconds: 5,
    maxDurationSeconds: 1200,
    maxFileMb: 95,
    queueLimit: 10,
});

async function dbGet(db, key) {
    if (!db) throw new Error('Database TitanBot belum siap.');
    if (typeof db.get === 'function') return await db.get(key);
    if (typeof db.getData === 'function') return await db.getData(key);
    throw new Error('Database adapter TitanBot tidak memiliki get().');
}

async function dbSet(db, key, value) {
    if (!db) throw new Error('Database TitanBot belum siap.');
    if (typeof db.set === 'function') return await db.set(key, value);
    if (typeof db.setData === 'function') return await db.setData(key, value);
    throw new Error('Database adapter TitanBot tidak memiliki set().');
}

export async function getBoomboxConfig(client, guildId) {
    const raw = await dbGet(client.db, CONFIG_KEY(guildId));
    const stored = raw && typeof raw === 'object' ? raw : {};
    return {
        ...DEFAULT_CONFIG,
        ...stored,
        enabled: Boolean(stored.enabled),
        channelId: stored.channelId ? String(stored.channelId) : null,
        cooldownSeconds: Math.max(0, Number(stored.cooldownSeconds ?? DEFAULT_CONFIG.cooldownSeconds)),
        maxDurationSeconds: Math.max(30, Number(stored.maxDurationSeconds ?? DEFAULT_CONFIG.maxDurationSeconds)),
        maxFileMb: Math.max(10, Number(stored.maxFileMb ?? DEFAULT_CONFIG.maxFileMb)),
        queueLimit: Math.max(1, Number(stored.queueLimit ?? DEFAULT_CONFIG.queueLimit)),
    };
}

export async function saveBoomboxConfig(client, guildId, patch = {}) {
    const current = await getBoomboxConfig(client, guildId);
    const next = { ...current, ...patch };
    delete next.runtime;
    await dbSet(client.db, CONFIG_KEY(guildId), next);
    return next;
}

export async function setBoomboxChannel(client, guildId, channelId) {
    return await saveBoomboxConfig(client, guildId, { channelId: String(channelId) });
}

export async function setBoomboxEnabled(client, guildId, enabled) {
    return await saveBoomboxConfig(client, guildId, { enabled: Boolean(enabled) });
}

export async function resetBoomboxConfig(client, guildId) {
    await dbSet(client.db, CONFIG_KEY(guildId), { ...DEFAULT_CONFIG });
}

export async function getBoomboxHistory(client, guildId) {
    const raw = await dbGet(client.db, HISTORY_KEY(guildId));
    return Array.isArray(raw) ? raw : [];
}

export async function saveBoomboxResult(client, guildId, result) {
    const history = await getBoomboxHistory(client, guildId);
    const entry = {
        id: `bb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ...result,
        createdAt: result.createdAt || new Date().toISOString(),
    };
    const next = [entry, ...history].slice(0, 500);
    await dbSet(client.db, HISTORY_KEY(guildId), next);
    return entry;
}

function normalizeUrl(value) {
    return String(value || '').trim().replace(/^https:/i, 'http:');
}

export async function findResultByDirectUrl(client, guildId, directUrl) {
    const wanted = normalizeUrl(directUrl);
    const history = await getBoomboxHistory(client, guildId);
    return history.find((item) => normalizeUrl(item.directUrl) === wanted) || null;
}

export async function findResultBySourceUrl(client, guildId, sourceUrl) {
    const wanted = String(sourceUrl || '').trim();
    const history = await getBoomboxHistory(client, guildId);
    return history.find((item) => String(item.sourceUrl || '').trim() === wanted) || null;
}

export async function searchBoomboxHistory(client, guildId, query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    const history = await getBoomboxHistory(client, guildId);
    if (!q) return history.slice(0, limit);
    return history.filter((item) => [item.title, item.artist, item.sourceUrl].some((value) => String(value || '').toLowerCase().includes(q))).slice(0, limit);
}

export function getDefaultBoomboxConfig() {
    return { ...DEFAULT_CONFIG };
}
