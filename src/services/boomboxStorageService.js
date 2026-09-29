const PREFIX = 'guild:';
const CONFIG_SUFFIX = ':boombox_config';

const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    channelId: null,
    cooldownSeconds: 30,
    maxDurationSeconds: 1200,
    maxFileMb: 95,
});

function keyFor(guildId) {
    return `${PREFIX}${guildId}${CONFIG_SUFFIX}`;
}

async function dbGet(db, key) {
    if (!db) throw new Error('Database belum siap.');
    if (typeof db.get === 'function') return await db.get(key);
    if (typeof db.getData === 'function') return await db.getData(key);
    throw new Error('Storage adapter TitanBot tidak memiliki method get().');
}

async function dbSet(db, key, value) {
    if (!db) throw new Error('Database belum siap.');
    if (typeof db.set === 'function') return await db.set(key, value);
    if (typeof db.setData === 'function') return await db.setData(key, value);
    throw new Error('Storage adapter TitanBot tidak memiliki method set().');
}

async function dbDelete(db, key) {
    if (!db) throw new Error('Database belum siap.');
    if (typeof db.delete === 'function') return await db.delete(key);
    if (typeof db.del === 'function') return await db.del(key);
    if (typeof db.deleteData === 'function') return await db.deleteData(key);
    return await dbSet(db, key, null);
}

export async function getBoomboxConfig(client, guildId) {
    const raw = await dbGet(client.db, keyFor(guildId));
    const stored = raw && typeof raw === 'object' ? raw : {};

    return {
        ...DEFAULT_CONFIG,
        ...stored,
        enabled: Boolean(stored.enabled),
        channelId: stored.channelId ?? null,
        cooldownSeconds: Number(stored.cooldownSeconds ?? DEFAULT_CONFIG.cooldownSeconds),
        maxDurationSeconds: Number(stored.maxDurationSeconds ?? DEFAULT_CONFIG.maxDurationSeconds),
        maxFileMb: Number(stored.maxFileMb ?? DEFAULT_CONFIG.maxFileMb),
        runtime: stored.runtime ?? { queue: 0, processing: 0 },
    };
}

export async function saveBoomboxConfig(client, guildId, patch) {
    const current = await getBoomboxConfig(client, guildId);
    const next = {
        ...current,
        ...patch,
        runtime: undefined,
    };
    delete next.runtime;
    await dbSet(client.db, keyFor(guildId), next);
    return { ...next, runtime: { queue: 0, processing: 0 } };
}

export async function setBoomboxChannel(client, guildId, channelId) {
    return await saveBoomboxConfig(client, guildId, { channelId: String(channelId) });
}

export async function setBoomboxEnabled(client, guildId, enabled) {
    return await saveBoomboxConfig(client, guildId, { enabled: Boolean(enabled) });
}

export async function resetBoomboxConfig(client, guildId) {
    await dbDelete(client.db, keyFor(guildId));
}

export function getDefaultBoomboxConfig() {
    return { ...DEFAULT_CONFIG };
}
