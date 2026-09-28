// autoMessageService.js
// Persistent scheduled auto-message service for TitanBot / SKAW GROUP.
// Uses the existing client.db key-value interface.

import { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const AUTO_MESSAGE_KEY = (guildId) => `guild:${guildId}:auto_messages`;
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 30 * 1000;

const schedulerHandles = new WeakMap();

function normalizeEmbed(embed = {}, fallbackDescription = '') {
    const normalized = {
        title: typeof embed.title === 'string' ? embed.title.trim() : '',
        description: typeof embed.description === 'string' ? embed.description : '',
        color: typeof embed.color === 'string' ? embed.color.trim() : '',
        footer: typeof embed.footer === 'string' ? embed.footer.trim() : '',
        imageUrl: typeof embed.imageUrl === 'string' ? embed.imageUrl.trim() : '',
    };

    if (!normalized.description && fallbackDescription) {
        normalized.description = fallbackDescription;
    }

    return normalized;
}

function normalizeSchedule(record = {}) {
    const startAt = Number(record.startAt);
    const rawNext = record.nextRunAt == null ? null : Number(record.nextRunAt);

    const message = String(record.message || '');
    const messageType = record.messageType === 'embed' ? 'embed' : 'text';

    return {
        id: String(record.id || ''),
        guildId: String(record.guildId || ''),
        channelId: String(record.channelId || ''),
        message,
        messageType,
        embed: normalizeEmbed(record.embed, messageType === 'embed' ? message : ''),
        timezone: record.timezone || DEFAULT_TIMEZONE,
        scheduleType: record.scheduleType || (record.intervalMs == null ? 'once' : 'interval'),
        intervalMs: record.intervalMs == null ? null : Number(record.intervalMs),
        startAt,
        endAt: record.endAt == null ? null : Number(record.endAt),
        nextRunAt: Number.isFinite(rawNext) ? rawNext : (Number.isFinite(startAt) ? startAt : null),
        lastRunAt: record.lastRunAt == null ? null : Number(record.lastRunAt),
        enabled: record.enabled !== false,
        runCount: Number.isInteger(record.runCount) ? record.runCount : 0,
        createdAt: record.createdAt || new Date().toISOString(),
        createdBy: record.createdBy ? String(record.createdBy) : null,
        updatedAt: record.updatedAt || null,
    };
}

function asMap(records) {
    const map = {};
    if (records && typeof records === 'object' && !Array.isArray(records)) {
        for (const [id, record] of Object.entries(records)) {
            if (record) map[id] = normalizeSchedule({ ...record, id: record.id || id });
        }
    }
    return map;
}

export function parseInterval(intervalString) {
    if (!intervalString || typeof intervalString !== 'string') {
        throw new Error('Interval is required.');
    }

    const value = intervalString.trim().toLowerCase();
    if (value === 'once') return null;

    const match = value.match(/^(\d+)(s|m|h|d|w)$/i);
    if (!match) {
        throw new Error('Invalid interval. Use 1m, 5m, 30m, 1h, 1d, 1w, or once.');
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
    }[unit];

    const intervalMs = amount * multiplier;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
        throw new Error('Interval must be at least 1 minute.');
    }

    return intervalMs;
}

function isValidTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format();
        return true;
    } catch {
        return false;
    }
}

export function validateTimeZone(timeZone = DEFAULT_TIMEZONE) {
    const normalized = String(timeZone).trim() || DEFAULT_TIMEZONE;
    if (!isValidTimeZone(normalized)) {
        throw new Error(`Invalid timezone: ${normalized}`);
    }
    return normalized;
}

function parseParts(value) {
    const match = String(value)
        .trim()
        .match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) return null;

    const [, y, mo, d, h, mi, s = '0'] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);

    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour < 0 || hour > 23 ||
        minute < 0 || minute > 59 ||
        second < 0 || second > 59
    ) {
        return null;
    }

    const candidate = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const check = new Date(candidate);

    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
    ) {
        return null;
    }

    return { year, month, day, hour, minute, second };
}

function getTimeZoneOffsetMs(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const values = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }

    const asUTC = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
    );

    return asUTC - date.getTime();
}

export function parseScheduledDateTime(value, timeZone = DEFAULT_TIMEZONE) {
    if (!value || typeof value !== 'string') {
        throw new Error('Date/time is required.');
    }

    const raw = value.trim();

    if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const timestamp = Date.parse(raw);
        if (!Number.isNaN(timestamp)) return timestamp;
    }

    const parts = parseParts(raw);
    if (!parts) {
        throw new Error('Invalid date/time. Use YYYY-MM-DD HH:mm.');
    }

    const zone = validateTimeZone(timeZone);
    const wallClockAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
    );

    const initialOffset = getTimeZoneOffsetMs(new Date(wallClockAsUtc), zone);
    let timestamp = wallClockAsUtc - initialOffset;

    const correctedOffset = getTimeZoneOffsetMs(new Date(timestamp), zone);
    if (correctedOffset !== initialOffset) {
        timestamp = wallClockAsUtc - correctedOffset;
    }

    const result = new Date(timestamp);
    if (Number.isNaN(result.getTime())) {
        throw new Error('Could not parse date/time.');
    }

    return timestamp;
}

export function formatDateTime(timestamp, timeZone = DEFAULT_TIMEZONE) {
    if (!Number.isFinite(Number(timestamp))) return 'Not scheduled';

    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(Number(timestamp)));
    } catch {
        return new Date(Number(timestamp)).toISOString();
    }
}

export async function getGuildAutoMessages(client, guildId) {
    if (!client?.db) return [];

    const raw = await client.db.get(AUTO_MESSAGE_KEY(guildId), {});
    return Object.values(asMap(raw)).filter(schedule => schedule.id);
}

export async function saveGuildAutoMessages(client, guildId, schedules) {
    if (!client?.db) return false;

    const map = {};
    for (const schedule of schedules) {
        const normalized = normalizeSchedule(schedule);
        if (normalized.id) map[normalized.id] = normalized;
    }

    await client.db.set(AUTO_MESSAGE_KEY(guildId), map);
    return true;
}

export async function getAutoMessage(client, guildId, id) {
    const schedules = await getGuildAutoMessages(client, guildId);
    return schedules.find(schedule => schedule.id === id) || null;
}

export function createAutoMessageId() {
    return `am_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function validateMessage(message) {
    if (typeof message !== 'string') throw new Error('Message must be text.');

    const trimmed = message.trim();
    if (!trimmed) throw new Error('Message cannot be empty.');

    if (trimmed.length > DISCORD_MAX_MESSAGE_LENGTH) {
        throw new Error(`Message must be ${DISCORD_MAX_MESSAGE_LENGTH} characters or fewer.`);
    }

    return trimmed;
}

export function validateEmbedDescription(description) {
    if (typeof description !== 'string') throw new Error('Embed description must be text.');

    const trimmed = description.trim();
    if (!trimmed) throw new Error('Embed description cannot be empty.');

    if (trimmed.length > DISCORD_EMBED_DESCRIPTION_LIMIT) {
        throw new Error(`Embed description must be ${DISCORD_EMBED_DESCRIPTION_LIMIT} characters or fewer.`);
    }

    return trimmed;
}

export function validateEmbedColor(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
        throw new Error('Embed color must be a 6-digit hex value such as #1A9EF3.');
    }

    return raw.toUpperCase();
}

export function validateEmbedUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        return url.toString();
    } catch {
        throw new Error('Embed image URL must be a valid HTTP or HTTPS URL.');
    }
}

export function buildAutoMessageData({
    id,
    guildId,
    channelId,
    message,
    messageType = 'text',
    embed = null,
    intervalString,
    startString,
    endString,
    timezone,
    createdBy,
}) {
    const zone = validateTimeZone(timezone || DEFAULT_TIMEZONE);
    const intervalMs = parseInterval(intervalString);
    const normalizedType = messageType === 'embed' ? 'embed' : 'text';
    const cleanMessage = normalizedType === 'embed'
        ? validateEmbedDescription(message)
        : validateMessage(message);
    const cleanEmbed = normalizedType === 'embed'
        ? normalizeEmbed(embed, cleanMessage)
        : normalizeEmbed();

    cleanEmbed.title = cleanEmbed.title.slice(0, 256);
    cleanEmbed.footer = cleanEmbed.footer.slice(0, 2048);
    cleanEmbed.color = validateEmbedColor(cleanEmbed.color);
    cleanEmbed.imageUrl = validateEmbedUrl(cleanEmbed.imageUrl);
    cleanEmbed.description = validateEmbedDescription(cleanEmbed.description);

    const startAt = parseScheduledDateTime(startString, zone);
    const endAt = endString ? parseScheduledDateTime(endString, zone) : null;

    if (endAt !== null && endAt <= startAt) {
        throw new Error('End time must be after the start time.');
    }

    const now = Date.now();

    if (startAt <= now) {
        throw new Error('Start time must be in the future.');
    }

    return {
        id: id || createAutoMessageId(),
        guildId: String(guildId),
        channelId: String(channelId),
        message: cleanMessage,
        messageType: normalizedType,
        embed: cleanEmbed,
        timezone: zone,
        scheduleType: intervalMs === null ? 'once' : 'interval',
        intervalMs,
        startAt,
        endAt,
        nextRunAt: startAt,
        lastRunAt: null,
        enabled: true,
        runCount: 0,
        createdAt: new Date().toISOString(),
        createdBy: createdBy ? String(createdBy) : null,
        updatedAt: null,
    };
}

function parseHexColor(color) {
    const clean = String(color || '').trim();
    if (!clean) return null;
    return Number.parseInt(clean.slice(1), 16);
}

export function buildAutoMessagePayload(schedule) {
    if (!schedule || schedule.messageType !== 'embed') {
        return { content: String(schedule?.message || '') };
    }

    const embedData = normalizeEmbed(schedule.embed, schedule.message);
    const embed = new EmbedBuilder();

    if (embedData.title) embed.setTitle(embedData.title.slice(0, 256));
    if (embedData.description) embed.setDescription(validateEmbedDescription(embedData.description));
    if (embedData.color) embed.setColor(parseHexColor(validateEmbedColor(embedData.color)));
    if (embedData.footer) embed.setFooter({ text: embedData.footer.slice(0, 2048) });
    if (embedData.imageUrl) embed.setImage(validateEmbedUrl(embedData.imageUrl));

    return { embeds: [embed] };
}

let schedulerRunning = false;

export function isAutoMessageSchedulerRunning(client) {
    const state = client ? schedulerHandles.get(client) : null;
    return Boolean(state?.timer);
}

export function startAutoMessageScheduler(client, intervalMs = DEFAULT_SCHEDULER_INTERVAL_MS) {
    if (!client || typeof client !== 'object') return false;

    const existing = schedulerHandles.get(client);
    if (existing?.timer) return true;

    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 5_000
        ? intervalMs
        : DEFAULT_SCHEDULER_INTERVAL_MS;

    const tick = () => {
        runAutoMessages(client).catch(error => {
            logger.error('Auto Message scheduler tick failed:', error);
        });
    };

    tick();

    const timer = setInterval(tick, safeInterval);
    if (typeof timer.unref === 'function') timer.unref();

    schedulerHandles.set(client, { timer, intervalMs: safeInterval });
    logger.info(`Auto Message scheduler started (every ${Math.round(safeInterval / 1000)}s).`);
    return true;
}

export function stopAutoMessageScheduler(client) {
    const state = client ? schedulerHandles.get(client) : null;
    if (!state?.timer) return false;

    clearInterval(state.timer);
    schedulerHandles.delete(client);
    logger.info('Auto Message scheduler stopped.');
    return true;
}

export async function runAutoMessages(client) {
    if (!client?.db) {
        logger.warn('Auto Message scheduler skipped: database unavailable.');
        return;
    }

    if (schedulerRunning) {
        logger.debug('Auto Message scheduler skipped: previous run is still active.');
        return;
    }

    schedulerRunning = true;
    const now = Date.now();

    try {
        for (const guild of client.guilds.cache.values()) {
            try {
                const schedules = await getGuildAutoMessages(client, guild.id);
                if (schedules.length === 0) continue;

                let changed = false;

                for (const schedule of schedules) {
                    if (!schedule.enabled || !Number.isFinite(schedule.startAt)) continue;

                    if (schedule.endAt !== null && now >= schedule.endAt) {
                        schedule.enabled = false;
                        schedule.nextRunAt = null;
                        schedule.updatedAt = new Date().toISOString();
                        changed = true;
                        logger.info(`Auto Message ${schedule.id} expired in guild ${guild.id}.`);
                        continue;
                    }

                    if (!Number.isFinite(schedule.nextRunAt)) {
                        schedule.nextRunAt = schedule.startAt;
                        changed = true;
                    }

                    if (now < schedule.nextRunAt) continue;

                    const channel = await guild.channels.fetch(schedule.channelId).catch(() => null);
                    if (!channel || typeof channel.send !== 'function' || !channel.isTextBased()) {
                        schedule.enabled = false;
                        schedule.nextRunAt = null;
                        schedule.updatedAt = new Date().toISOString();
                        changed = true;
                        logger.warn(`Auto Message ${schedule.id} disabled: channel ${schedule.channelId} is unavailable.`);
                        continue;
                    }

                    let payload;
                    try {
                        payload = buildAutoMessagePayload(schedule);
                    } catch (payloadError) {
                        logger.error(`Auto Message ${schedule.id} has invalid message/embeds: ${payloadError.message}`);
                        schedule.enabled = false;
                        schedule.nextRunAt = null;
                        schedule.updatedAt = new Date().toISOString();
                        changed = true;
                        continue;
                    }

                    const sent = await channel.send(payload).catch(error => {
                        logger.warn(`Auto Message ${schedule.id} failed to send in guild ${guild.id}: ${error.message}`);
                        return null;
                    });

                    if (!sent) continue;

                    schedule.lastRunAt = now;
                    schedule.runCount += 1;
                    schedule.updatedAt = new Date().toISOString();
                    changed = true;

                    if (schedule.scheduleType === 'once' || schedule.intervalMs === null) {
                        schedule.enabled = false;
                        schedule.nextRunAt = null;
                    } else {
                        let nextRunAt = schedule.nextRunAt + schedule.intervalMs;
                        while (nextRunAt <= now) {
                            nextRunAt += schedule.intervalMs;
                        }
                        schedule.nextRunAt = nextRunAt;

                        if (schedule.endAt !== null && schedule.nextRunAt >= schedule.endAt) {
                            schedule.enabled = false;
                            schedule.nextRunAt = null;
                        }
                    }

                    logger.info(`Auto Message sent: ${schedule.id} in guild ${guild.id}, channel ${schedule.channelId}`);
                }

                if (changed) {
                    await saveGuildAutoMessages(client, guild.id, schedules);
                }
            } catch (error) {
                logger.error(`Auto Message scheduler error in guild ${guild.id}:`, error);
            }
        }
    } finally {
        schedulerRunning = false;
    }
}

export const AUTO_MESSAGE_DEFAULT_TIMEZONE = DEFAULT_TIMEZONE;
