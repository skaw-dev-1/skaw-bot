import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { detectBoomboxPlatform } from '../utils/boomboxUrl.js';
import { getBoomboxConfig, setBoomboxConfig } from './boomboxStorageService.js';
import { convertBoomboxUrl, getBoomboxLimits } from './boomboxConversionService.js';

const MAX_CONCURRENT = 2;
const COOLDOWN_MS = 30 * 1000;
const MAX_QUEUE = 25;

const runtime = {
    queue: [],
    active: 0,
    cooldowns: new Map(),
};

const registeredClients = new WeakSet();

function getRemainingCooldown(userId) {
    const until = runtime.cooldowns.get(userId) || 0;
    const remaining = Math.max(0, until - Date.now());
    if (!remaining) runtime.cooldowns.delete(userId);
    return remaining;
}

function setCooldown(userId) {
    runtime.cooldowns.set(userId, Date.now() + COOLDOWN_MS);
}

function durationLabel(seconds) {
    if (!Number.isFinite(Number(seconds))) return 'Unknown';
    const total = Math.max(0, Math.round(Number(seconds)));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function platformLabel(platform) {
    return ({ youtube: 'YouTube', tiktok: 'TikTok', spotify: 'Spotify', soundcloud: 'SoundCloud' })[platform] || platform;
}

function buildProgressEmbed(stage, extra = '') {
    return {
        title: 'SKAW BOOMBOX CONVERTER',
        description: `${stage}${extra ? `\n\n${extra}` : ''}`,
        color: 0x0A5EA8,
        footer: { text: 'Powered by SKAW GROUP' },
    };
}

function buildResultEmbed(result, platform) {
    return {
        title: 'SKAW BOOMBOX CONVERTER',
        description: '✅ Your audio is ready for GTA SA-MP / San Andreas Roleplay.',
        color: 0x0A5EA8,
        fields: [
            { name: '🎵 Title', value: String(result.title || 'Unknown Title').slice(0, 1024), inline: false },
            { name: '👤 Artist', value: String(result.artist || 'Unknown Artist').slice(0, 1024), inline: true },
            { name: '⏱ Duration', value: durationLabel(result.durationSeconds), inline: true },
            { name: '📁 Source', value: platformLabel(platform), inline: true },
            { name: '🔗 Boombox URL', value: `\`${result.top4topUrl}\``, inline: false },
        ],
        footer: { text: result.cached ? 'Result served from SKAW cache.' : 'Powered by SKAW GROUP' },
    };
}

function buildErrorEmbed(error) {
    return {
        title: 'SKAW BOOMBOX CONVERTER',
        description: `❌ **Conversion Failed**\n\n${String(error?.message || 'Unknown error').slice(0, 3900)}`,
        color: 0xB91C1C,
        footer: { text: 'Please try another supported link.' },
    };
}

export function getBoomboxRuntimeStatus() {
    return {
        queueLength: runtime.queue.length,
        active: runtime.active,
        maxConcurrent: MAX_CONCURRENT,
        maxQueue: MAX_QUEUE,
        cooldownSeconds: Math.floor(COOLDOWN_MS / 1000),
        ...getBoomboxLimits(),
    };
}

async function processJob(job) {
    try {
        await job.replyMessage.edit({ embeds: [buildProgressEmbed('⏳ Processing your link...', '🔎 Detecting platform\n⬇️ Getting audio\n🎵 Converting to MP3\n☁️ Uploading to Top4toP\n✅ Preparing Boombox URL')] });
        const result = await convertBoomboxUrl(job.client, job.guildId, job.url);
        await job.replyMessage.edit({ embeds: [buildResultEmbed(result, job.platform)] });
    } catch (error) {
        logger.warn(`SKAW Boombox conversion failed for ${job.url}:`, error?.message || error);
        await job.replyMessage.edit({ embeds: [buildErrorEmbed(error)] }).catch(() => null);
    }
}

async function pump() {
    while (runtime.active < MAX_CONCURRENT && runtime.queue.length) {
        const job = runtime.queue.shift();
        runtime.active += 1;
        processJob(job).finally(() => {
            runtime.active -= 1;
            void pump();
        });
    }
}

export async function enqueueBoomboxConversion({ client, message, url, platform, replyMessage }) {
    const config = await getBoomboxConfig(client, message.guildId);
    if (!config.enabled || !config.channelId || config.channelId !== message.channelId) {
        return { accepted: false, reason: 'not_configured_channel' };
    }

    if (runtime.queue.length >= MAX_QUEUE) {
        return { accepted: false, reason: 'queue_full' };
    }

    const remaining = getRemainingCooldown(message.author.id);
    if (remaining > 0) {
        return { accepted: false, reason: 'cooldown', remainingMs: remaining };
    }

    setCooldown(message.author.id);
    runtime.queue.push({
        client,
        message,
        replyMessage,
        guildId: message.guildId,
        userId: message.author.id,
        url,
        platform,
    });
    const queuePosition = runtime.queue.length + runtime.active;
    void pump();
    return { accepted: true, queuePosition };
}

export async function initializeBoomboxConverter(client) {
    if (!client || registeredClients.has(client)) return false;

    client.on(Events.MessageCreate, async (message) => {
        if (message.author?.bot || !message.guild) return;

        try {
            const config = await getBoomboxConfig(client, message.guildId);
            if (!config.enabled || !config.channelId || config.channelId !== message.channelId) return;

            const urlPattern = /https?:\/\/[^\s<>]+/gi;
            const urls = [...new Set((String(message.content || '').match(urlPattern) || []).map((url) => url.replace(/[),.!?]+$/g, '')))].slice(0, 1);
            if (!urls.length) return;

            const detected = detectBoomboxPlatform(urls[0]);
            if (!detected) return;

            const remaining = getRemainingCooldown(message.author.id);
            if (remaining > 0) {
                const seconds = Math.ceil(remaining / 1000);
                await message.reply({
                    flags: MessageFlags.SuppressEmbeds,
                    content: `⏳ Please wait **${seconds}s** before starting another conversion.`,
                    allowedMentions: { repliedUser: false },
                }).catch(() => null);
                return;
            }

            const placeholder = await message.reply({
                embeds: [buildProgressEmbed('⏳ Added to the conversion queue...', `📌 Queue position will be shown when processing starts.\n🎵 Source: ${platformLabel(detected.platform)}`)],
                allowedMentions: { repliedUser: false },
            }).catch(() => null);
            if (!placeholder) return;

            const result = await enqueueBoomboxConversion({
                client,
                message,
                url: detected.url,
                platform: detected.platform,
                replyMessage: placeholder,
            });

            if (result.accepted) {
                if (result.queuePosition > 1) {
                    await placeholder.edit({
                        embeds: [buildProgressEmbed('⏳ Added to the conversion queue...', `📍 Queue position: **#${result.queuePosition}**\n🎵 Source: ${platformLabel(detected.platform)}`)],
                    }).catch(() => null);
                }
                return;
            }

            if (result.reason === 'not_configured_channel') {
                await placeholder.delete().catch(() => null);
                return;
            }

            if (result.reason === 'cooldown') {
                const seconds = Math.ceil(result.remainingMs / 1000);
                await placeholder.edit({
                    embeds: [{
                        title: 'SKAW BOOMBOX CONVERTER',
                        description: `⏳ Please wait **${seconds}s** before starting another conversion.`,
                        color: 0xF59E0B,
                    }],
                }).catch(() => null);
                return;
            }

            await placeholder.edit({
                embeds: [{
                    title: 'SKAW BOOMBOX CONVERTER',
                    description: '❌ The conversion queue is currently full. Please try again shortly.',
                    color: 0xF59E0B,
                }],
            }).catch(() => null);
        } catch (error) {
            logger.error('SKAW Boombox message handler error:', error);
        }
    });

    registeredClients.add(client);
    logger.info('SKAW Boombox Converter message listener registered.');
    return true;
}

export async function setBoomboxChannel(client, guildId, channelId, userId) {
    return setBoomboxConfig(client, guildId, { channelId }, userId);
}

export async function setBoomboxEnabled(client, guildId, enabled, userId) {
    return setBoomboxConfig(client, guildId, { enabled }, userId);
}
