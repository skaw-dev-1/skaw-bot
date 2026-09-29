const CONFIG_KEY = (guildId) => `guild:${guildId}:boombox_config`;
const HISTORY_KEY = (guildId) => `guild:${guildId}:boombox_history`;

const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    channelId: null,
    cooldownSeconds: 10,
    maxDurationSeconds: 1200,
    maxFileMb: 95,
    queueLimit: 10,
});

async function getValue(db, key) {
    if (!db) throw new Error('Database TitanBot belum siap.');
    if (typeof db.get === 'function') return await db.get(key);
    if (typeof db.getData === 'function') return await db.getData(key);
    throw new Error('Storage adapter tidak memiliki method get().');
}

async function setValue(db, key, value) {
    if (!db) throw new Error('Database TitanBot belum siap.');
    if (typeof db.set === 'function') return await db.set(key, value);
    if (typeof db.setData === 'function') return await db.setData(key, value);
    throw new Error('Storage adapter tidak memiliki method set().');
}

export async function getBoomboxConfig(client, guildId) {
    const raw = await getValue(client.db, CONFIG_KEY(guildId));
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

export async function saveBoomboxConfig(client, guildId, patch) {
    const current = await getBoomboxConfig(client, guildId);
    const next = { ...current, ...patch };
    delete next.runtime;
    await setValue(client.db, CONFIG_KEY(guildId), next);
    return next;
}

export async function setBoomboxChannel(client, guildId, channelId) {
    return await saveBoomboxConfig(client, guildId, { channelId: String(channelId) });
}

export async function setBoomboxEnabled(client, guildId, enabled) {
    return await saveBoomboxConfig(client, guildId, { enabled: Boolean(enabled) });
}

export async function resetBoomboxConfig(client, guildId) {
    await setValue(client.db, CONFIG_KEY(guildId), { ...DEFAULT_CONFIG });
}

export async function getBoomboxHistory(client, guildId) {
    const raw = await getValue(client.db, HISTORY_KEY(guildId));
    return Array.isArray(raw) ? raw : [];
}

export async function saveBoomboxResult(client, guildId, entry) {
    const history = await getBoomboxHistory(client, guildId);
    history.unshift({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ...entry,
        createdAt: entry.createdAt || new Date().toISOString(),
    });

    const trimmed = history.slice(0, 500);
    await setValue(client.db, HISTORY_KEY(guildId), trimmed);
    return trimmed[0];
}

export async function findBoomboxByDirectUrl(client, guildId, inputUrl) {
    const wanted = String(inputUrl || '').trim();
    const http = wanted.replace(/^https:/i, 'http:');
    const history = await getBoomboxHistory(client, guildId);
    return history.find((entry) => {
        const stored = String(entry.directUrl || '').trim();
        return stored === wanted || stored === http || stored.replace(/^https:/i, 'http:') === http;
    }) || null;
}

export async function findBoomboxHistory(client, guildId, query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    const history = await getBoomboxHistory(client, guildId);
    if (!q) return history.slice(0, limit);

    return history
        .filter((entry) => [entry.title, entry.artist, entry.sourceUrl].some((value) => String(value || '').toLowerCase().includes(q)))
        .slice(0, limit);
}
