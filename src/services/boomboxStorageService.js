const CONFIG_KEY = (guildId) => `guild:${guildId}:boombox_config`;
const HISTORY_KEY = (guildId) => `guild:${guildId}:boombox_history`;

const DEFAULT_CONFIG = {
    enabled: false,
    channelId: null,
    cooldownSeconds: 10,
    maxDurationSeconds: 1200,
    maxFileMb: 95,
    queueLimit: 10,
};

async function read(db, key) {
    if (!db) throw new Error('TitanBot database belum siap.');
    if (typeof db.get === 'function') return await db.get(key);
    if (typeof db.getData === 'function') return await db.getData(key);
    throw new Error('Database adapter TitanBot tidak memiliki method get().');
}

async function write(db, key, value) {
    if (!db) throw new Error('TitanBot database belum siap.');
    if (typeof db.set === 'function') return await db.set(key, value);
    if (typeof db.setData === 'function') return await db.setData(key, value);
    throw new Error('Database adapter TitanBot tidak memiliki method set().');
}

export async function getBoomboxConfig(client, guildId) {
    const raw = await read(client.db, CONFIG_KEY(guildId));
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
        ...DEFAULT_CONFIG,
        ...value,
        enabled: Boolean(value.enabled),
        channelId: value.channelId ? String(value.channelId) : null,
        cooldownSeconds: Math.max(0, Number(value.cooldownSeconds ?? DEFAULT_CONFIG.cooldownSeconds)),
        maxDurationSeconds: Math.max(30, Number(value.maxDurationSeconds ?? DEFAULT_CONFIG.maxDurationSeconds)),
        maxFileMb: Math.max(10, Number(value.maxFileMb ?? DEFAULT_CONFIG.maxFileMb)),
        queueLimit: Math.max(1, Number(value.queueLimit ?? DEFAULT_CONFIG.queueLimit)),
    };
}

export async function saveBoomboxConfig(client, guildId, patch = {}) {
    const current = await getBoomboxConfig(client, guildId);
    const next = { ...current, ...patch };
    delete next.runtime;
    await write(client.db, CONFIG_KEY(guildId), next);
    return next;
}

export async function setBoomboxChannel(client, guildId, channelId) {
    return await saveBoomboxConfig(client, guildId, { channelId: String(channelId) });
}

export async function setBoomboxEnabled(client, guildId, enabled) {
    return await saveBoomboxConfig(client, guildId, { enabled: Boolean(enabled) });
}

export async function resetBoomboxConfig(client, guildId) {
    await write(client.db, CONFIG_KEY(guildId), { ...DEFAULT_CONFIG });
}

export async function getBoomboxHistory(client, guildId) {
    const raw = await read(client.db, HISTORY_KEY(guildId));
    return Array.isArray(raw) ? raw : [];
}

export async function saveBoomboxResult(client, guildId, result) {
    const history = await getBoomboxHistory(client, guildId);
    history.unshift({
        id: `bb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ...result,
        createdAt: new Date().toISOString(),
    });
    const trimmed = history.slice(0, 500);
    await write(client.db, HISTORY_KEY(guildId), trimmed);
    return trimmed[0];
}

export async function findResultByDirectUrl(client, guildId, directUrl) {
    const wanted = String(directUrl || '').trim().replace(/^https:/i, 'http:');
    const history = await getBoomboxHistory(client, guildId);
    return history.find((item) => String(item.directUrl || '').trim().replace(/^https:/i, 'http:') === wanted) || null;
}

export async function findResultBySourceUrl(client, guildId, sourceUrl) {
    const wanted = String(sourceUrl || '').trim();
    const history = await getBoomboxHistory(client, guildId);
    return history.find((item) => item.sourceUrl === wanted) || null;
}

export async function searchBoomboxHistory(client, guildId, query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    const history = await getBoomboxHistory(client, guildId);
    if (!q) return history.slice(0, limit);
    return history.filter((item) => [item.title, item.artist, item.sourceUrl].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, limit);
}
