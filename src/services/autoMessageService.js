// autoMessageService.js
// Persistent scheduled auto-message service for TitanBot / SKAW GROUP.
// Stores schedules through the existing key-value database interface (client.db).

import { ChannelType } from 'discord.js';
import { logger } from '../utils/logger.js';

const AUTO_MESSAGE_KEY = (guildId) => `guild:${guildId}:auto_messages`;
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const DISCORD_MAX_MESSAGE_LENGTH = 2000;
const MIN_INTERVAL_MS = 10 * 1000;

function normalizeSchedule(record) {
    return {
        id: String(record.id),
        guildId: String(record.guildId),
        channelId: String(record.channelId),
        message: String(record.message),
        timezone: record.timezone || DEFAULT_TIMEZONE,
        scheduleType: record.scheduleType || 'interval',
        intervalMs: record.intervalMs ?? null,
        startAt: Number(record.startAt),
        endAt: record.endAt == null ? null : Number(record.endAt),
        nextRunAt: record.nextRunAt == null ? null : Number(record.nextRunAt),
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
            if (record) map[id] = normalizeSchedule(record);
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
        throw new Error('Invalid interval. Use formats like 30s, 10m, 1h, 6h, 1d, 1w, or once.');
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
        throw new Error('Interval must be at least 10 seconds.');
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
    const match = String(value).trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;

    const [, y, mo, d, h, mi, s = '0'] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);

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

    // ISO with explicit timezone/offset. Keep the exact instant.
    if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
        const timestamp = Date.parse(raw);
        if (!Number.isNaN(timestamp)) return timestamp;
    }

    const parts = parseParts(raw);
    if (!parts) {
        throw new Error('Invalid date/time. Use YYYY-MM-DD HH:mm or ISO 8601 with timezone.');
    }

    const zone = validateTimeZone(timeZone);
    let timestamp = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
    );

    // Two-pass correction handles normal timezone offsets and DST transitions.
    timestamp -= getTimeZoneOffsetMs(new Date(timestamp), zone);
    timestamp -= getTimeZoneOffsetMs(new Date(timestamp), zone);

    const result = new Date(timestamp);
    if (Number.isNaN(result.getTime())) {
        throw new Error('Could not parse date/time.');
    }

    return timestamp;
}

export function formatDateTime(timestamp, timeZone = DEFAULT_TIMEZONE) {
    if (!Number.isFinite(timestamp)) return 'Not scheduled';
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toISOString();
    }
}

export async function getGuildAutoMessages(client, guildId) {
    if (!client?.db) return [];

    const raw = await client.db.get(AUTO_MESSAGE_KEY(guildId), {});
    return Object.values(asMap(raw));
}

export async function saveGuildAutoMessages(client, guildId, schedules) {
    if (!client?.db) return false;
    const map = {};
    for (const schedule of schedules) {
        const normalized = normalizeSchedule(schedule);
        map[normalized.id] = normalized;
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

export function buildAutoMessageData({
    id,
    guildId,
    channelId,
    message,
    intervalString,
    startString,
    endString,
    timezone,
    createdBy,
}) {
    const zone = validateTimeZone(timezone || DEFAULT_TIMEZONE);
    const intervalMs = parseInterval(intervalString);
    const startAt = parseScheduledDateTime(startString, zone);
    const endAt = endString ? parseScheduledDateTime(endString, zone) : null;

    if (endAt !== null && endAt <= startAt) {
        throw new Error('End time must be after start time.');
    }

    const now = Date.now();
    const schedule = {
        id: id || createAutoMessageId(),
        guildId: String(guildId),
        channelId: String(channelId),
        message: validateMessage(message),
        timezone: zone,
        scheduleType: intervalMs === null ? 'once' : 'interval',
        intervalMs,
        startAt,
        endAt,
        nextRunAt: startAt >= now ? startAt : (intervalMs === null ? startAt : now),
        lastRunAt: null,
        enabled: true,
        runCount: 0,
        createdAt: new Date().toISOString(),
        createdBy: createdBy ? String(createdBy) : null,
        updatedAt: null,
    };

    if (schedule.nextRunAt <= now && intervalMs !== null) {
        // Send on the next scheduler tick rather than trying to backfill every missed run.
        schedule.nextRunAt = now;
    }

    return schedule;
}

async function saveSingleSchedule(client, guildId, schedule) {
    const schedules = await getGuildAutoMessages(client, guildId);
    const index = schedules.findIndex(item => item.id === schedule.id);
    if (index >= 0) schedules[index] = schedule;
    else schedules.push(schedule);
    await saveGuildAutoMessages(client, guildId, schedules);
}

export async function runAutoMessages(client) {
    if (!client?.db) {
        logger.warn('Auto Message scheduler skipped: database unavailable.');
        return;
    }

    const now = Date.now();

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

                if (now < schedule.nextRunAt) continue;

                const channel = await guild.channels.fetch(schedule.channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    schedule.enabled = false;
                    schedule.updatedAt = new Date().toISOString();
                    changed = true;
                    logger.warn(`Auto Message ${schedule.id} disabled: channel ${schedule.channelId} is unavailable.`);
                    continue;
                }

                const sent = await channel.send({ content: schedule.message }).catch(error => {
                    logger.warn(`Auto Message ${schedule.id} failed to send in ${guild.id}: ${error.message}`);
                    return false;
                });

                if (!sent) continue;

                schedule.lastRunAt = now;
                schedule.runCount += 1;
                schedule.updatedAt = new Date().toISOString();

                if (schedule.intervalMs === null || schedule.scheduleType === 'once') {
                    schedule.enabled = false;
                    schedule.nextRunAt = null;
                } else {
                    schedule.nextRunAt = now + schedule.intervalMs;
                    if (schedule.endAt !== null && schedule.nextRunAt >= schedule.endAt) {
                        // Allow this run; disable before the next one.
                        schedule.nextRunAt = null;
                        schedule.enabled = false;
                    }
                }

                changed = true;
                logger.info(`Auto Message sent: ${schedule.id} in guild ${guild.id}, channel ${schedule.channelId}`);
            }

            if (changed) {
                await saveGuildAutoMessages(client, guild.id, schedules);
            }
        } catch (error) {
            logger.error(`Auto Message scheduler error in guild ${guild.id}:`, error);
        }
    }
}

export const AUTO_MESSAGE_DEFAULT_TIMEZONE = DEFAULT_TIMEZONE;
