// SKAW GROUP Boombox persistence layer for TitanBot.
// Uses TitanBot's existing client.db key-value interface; no second database.

const CONFIG_KEY = (guildId) => `guild:${guildId}:boombox_config`;
const CACHE_KEY = (guildId) => `guild:${guildId}:boombox_cache`;

function normalizeConfig(guildId, record = {}) {
    return {
        guildId: String(guildId || record.guildId || ''),
        channelId: record.channelId ? String(record.channelId) : null,
        enabled: record.enabled === true,
        updatedAt: record.updatedAt || null,
        updatedBy: record.updatedBy ? String(record.updatedBy) : null,
    };
}

function normalizeCacheMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
}

export async function getBoomboxConfig(client, guildId) {
    if (!client?.db || !guildId) return normalizeConfig(guildId);
    const raw = await client.db.get(CONFIG_KEY(guildId), {});
    return normalizeConfig(guildId, raw);
}

export async function setBoomboxConfig(client, guildId, patch = {}, updatedBy = null) {
    if (!client?.db) throw new Error('TitanBot database is not available.');

    const current = await getBoomboxConfig(client, guildId);
    const next = normalizeConfig(guildId, {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedBy,
    });

    await client.db.set(CONFIG_KEY(guildId), next);
    return next;
}

export async function getBoomboxCache(client, guildId, cacheKey) {
    if (!client?.db || !guildId || !cacheKey) return null;
    const raw = await client.db.get(CACHE_KEY(guildId), {});
    const map = normalizeCacheMap(raw);
    const item = map[cacheKey] || null;
    return item ? { ...item, lastUsedAt: item.lastUsedAt || new Date().toISOString() } : null;
}

export async function setBoomboxCache(client, guildId, cacheKey, value) {
    if (!client?.db) throw new Error('TitanBot database is not available.');
    if (!guildId || !cacheKey) return null;

    const raw = await client.db.get(CACHE_KEY(guildId), {});
    const map = normalizeCacheMap(raw);
    map[cacheKey] = {
        ...value,
        lastUsedAt: new Date().toISOString(),
    };

    await client.db.set(CACHE_KEY(guildId), map);
    return map[cacheKey];
}
