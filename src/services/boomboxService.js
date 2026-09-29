import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } from 'discord.js';
import { getBoomboxConfig, getBoomboxHistory, findBoomboxByDirectUrl, findBoomboxHistory, saveBoomboxResult } from './boomboxStorageService.js';
import { detectBoomboxPlatform, normalizeSourceUrl } from '../utils/boomboxPlatform.js';
import { isDirectHttpMp3Url, parseTop4TopUrl } from '../utils/boomboxUrl.js';

const runtime = new WeakMap();
const cooldowns = new Map();

const PLATFORM_LABELS = {
    youtube: 'YouTube',
    tiktok: 'TikTok',
    spotify: 'Spotify',
    soundcloud: 'SoundCloud',
};

function getRuntime(client) {
    if (!runtime.has(client)) runtime.set(client, { started: false, queue: [], processing: 0, maxConcurrent: 2 });
    return runtime.get(client);
}

function formatDuration(seconds) {
    const value = Number(seconds || 0);
    if (!value) return 'Unknown';
    const hours = Math.floor(value / 3600);
    const mins = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function trimField(value, max = 1000) {
    const text = String(value || 'Unknown');
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function allowedChannel(config, channelId) {
    return Boolean(config.enabled && config.channelId && String(config.channelId) === String(channelId));
}

function progressEmbed(stage, detail, thumbnail, mode = 'CONVERT') {
    const embed = new EmbedBuilder()
        .setTitle('🔄 SKAW BOOMBOX • SEDANG DIPROSES')
        .setDescription(`${detail}\n\n**Mode:** ${mode}`)
        .setFooter({ text: 'SKAW GROUP • Boombox Converter' });
    if (thumbnail && /^https?:\/\//i.test(thumbnail)) embed.setThumbnail(thumbnail);
    return embed;
}

function resultEmbed(result, reused = false, retry = false) {
    const embed = new EmbedBuilder()
        .setTitle('🎵 SKAW BOOMBOX CONVERTER')
        .setDescription(`**${trimField(result.title, 256)}**`)
        .addFields(
            { name: '👤 Artist', value: trimField(result.artist, 200), inline: true },
            { name: '⏱ Duration', value: formatDuration(result.durationSeconds), inline: true },
            { name: '📁 Format', value: 'MP3', inline: true },
            { name: '🌐 Source', value: PLATFORM_LABELS[result.platform] || result.platform, inline: true },
            { name: reused ? '♻️ Cached URL' : '🔗 Boombox URL', value: `\`${result.url}\``, inline: false },
        )
        .setFooter({ text: retry ? 'Generate ulang berhasil • URL Top4toP baru' : reused ? 'Menggunakan hasil tersimpan • gunakan ulang untuk membuat URL baru' : 'URL HTTP direct untuk Boombox' });
    if (result.thumbnail && /^https?:\/\//i.test(result.thumbnail)) embed.setThumbnail(result.thumbnail);
    return embed;
}

function resultButtons(url) {
    if (!isDirectHttpMp3Url(url)) return [];
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🔗 Buka URL').setStyle(ButtonStyle.Link).setURL(url),
    );
    return [row];
}

async function enforceChannel(client, guildId, channelId) {
    const config = await getBoomboxConfig(client, guildId);
    if (!allowedChannel(config, channelId)) {
        throw new Error(`Converter tidak aktif di channel ini. Gunakan <#${config.channelId || 'unknown'}>.`);
    }
    return config;
}

async function checkCooldown(guildId, userId, seconds) {
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const last = cooldowns.get(key) || 0;
    const waitMs = Math.max(0, Number(seconds || 0)) * 1000;
    if (now - last < waitMs) {
        const remaining = Math.ceil((waitMs - (now - last)) / 1000);
        throw new Error(`Tunggu ${remaining} detik sebelum menjalankan converter lagi.`);
    }
    cooldowns.set(key, now);
}

async function cachedResult(client, guildId, sourceUrl) {
    const history = await getBoomboxHistory(client, guildId);
    const normalized = normalizeSourceUrl(sourceUrl);
    return history.find((entry) => entry.sourceUrl === normalized && entry.directUrl);
}

async function executeConversion(client, job) {
    const state = getRuntime(client);
    state.processing += 1;

    try {
        const { convertToBoombox } = await import('./boomboxConversionService.js');
        let latestEmbedMessage = job.progressMessage;
        const reportProgress = async (stage, detail) => {
            const message = await job.progressMessage.edit({
                embeds: [progressEmbed(stage, detail, job.thumbnail, job.retry ? 'RE-CONVERT' : 'CONVERT')],
            }).catch(() => null);
            if (message) latestEmbedMessage = message;
        };

        await reportProgress('prepare', '🔎 Sedang membaca informasi audio...');
        const result = await convertToBoombox(job.sourceUrl, job.config, reportProgress);

        await saveBoomboxResult(client, job.guildId, {
            sourceUrl: result.sourceUrl,
            platform: result.platform,
            title: result.title,
            artist: result.artist,
            durationSeconds: result.durationSeconds,
            directUrl: result.url,
            sizeBytes: result.sizeBytes,
            userId: job.userId,
        });

        await latestEmbedMessage.edit({
            embeds: [resultEmbed({ ...result, url: result.url }, false, job.retry)],
            components: resultButtons(result.url),
        }).catch(() => {});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await job.progressMessage.edit({
            embeds: [new EmbedBuilder()
                .setTitle('❌ SKAW BOOMBOX • GAGAL')
                .setDescription(`**${trimField(message, 3500)}**`)
                .setFooter({ text: 'Coba lagi dengan !bb ulang <URL> atau /bb ulang:true' })],
        }).catch(() => {});
    } finally {
        state.processing -= 1;
        pump(client);
    }
}

function pump(client) {
    const state = getRuntime(client);
    while (state.processing < state.maxConcurrent && state.queue.length) {
        const job = state.queue.shift();
        void executeConversion(client, job);
    }
}

async function enqueue(client, { guildId, channelId, userId, sourceUrl, retry = false, progressMessage, thumbnail = null }) {
    const config = await enforceChannel(client, guildId, channelId);
    await checkCooldown(guildId, userId, config.cooldownSeconds);

    const state = getRuntime(client);
    if (state.queue.length >= config.queueLimit) {
        throw new Error(`Queue penuh (${config.queueLimit}). Tunggu proses sebelumnya selesai.`);
    }

    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized || !detectBoomboxPlatform(normalized)) throw new Error('URL harus YouTube, TikTok, Spotify, atau SoundCloud.');

    if (!retry) {
        const cached = await cachedResult(client, guildId, normalized);
        if (cached) {
            await progressMessage.edit({
                embeds: [resultEmbed({
                    title: cached.title,
                    artist: cached.artist,
                    durationSeconds: cached.durationSeconds,
                    platform: cached.platform,
                    url: cached.directUrl,
                    thumbnail: cached.thumbnail,
                }, true, false)],
                components: resultButtons(cached.directUrl),
            }).catch(() => {});
            return;
        }
    }

    state.queue.push({
        guildId,
        channelId,
        userId,
        sourceUrl: normalized,
        retry,
        config,
        progressMessage,
        thumbnail,
    });
    pump(client);
}

export async function handleBbSlashCommand(interaction) {
    if (!interaction.inGuild()) throw new Error('Command hanya bisa digunakan di server.');

    const input = interaction.options.getString('url', true).trim();
    const retry = Boolean(interaction.options.getBoolean('ulang'));
    let sourceUrl = input;

    if (retry && parseTop4TopUrl(input)) {
        const previous = await findBoomboxByDirectUrl(interaction.client, interaction.guildId, input);
        if (!previous?.sourceUrl) {
            throw new Error('URL Top4toP itu tidak ada di riwayat SKAW. Gunakan URL sumber asli untuk membuat ulang.');
        }
        sourceUrl = previous.sourceUrl;
    }

    const config = await enforceChannel(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({
        embeds: [progressEmbed('queued', retry ? '⏳ Memasukkan permintaan re-convert ke queue...' : '⏳ Memasukkan URL ke queue converter...', null, retry ? 'RE-CONVERT' : 'CONVERT')],
    });

    const progressMessage = await interaction.fetchReply();
    await enqueue(interaction.client, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        sourceUrl,
        retry,
        progressMessage,
    });

    return config;
}

async function handleHistorySearch(message, query) {
    const results = await findBoomboxHistory(message.client, message.guildId, query, 8);
    if (!results.length) {
        await message.reply('🔎 Tidak ada hasil di riwayat Boombox SKAW.').catch(() => {});
        return;
    }

    const description = results.map((item, index) => {
        const title = trimField(item.title, 90);
        const artist = trimField(item.artist, 60);
        return `**${index + 1}. ${title}** — ${artist}\n<${item.directUrl}>`;
    }).join('\n\n');

    await message.reply({
        embeds: [new EmbedBuilder()
            .setTitle('🔎 SKAW BOOMBOX • RIWAYAT')
            .setDescription(description)
            .setFooter({ text: 'Gunakan !bb <URL> untuk convert baru.' })],
    }).catch(() => {});
}

export async function handleBbPrefixMessage(client, message) {
    if (!message.guildId || message.author?.bot) return false;
    const content = String(message.content || '').trim();
    if (!content.toLowerCase().startsWith('!bb')) return false;

    const remainder = content.slice(3).trim();
    if (!remainder) {
        await message.reply({ content: '📻 Gunakan `!bb <URL>` atau `!bb ulang <URL Top4toP / URL sumber>`. Untuk cari riwayat, `!bb <kata kunci>`. ' }).catch(() => {});
        return true;
    }

    const parts = remainder.split(/\s+/);
    const retry = parts[0]?.toLowerCase() === 'ulang';
    const input = retry ? parts.slice(1).join(' ').trim() : remainder;

    if (retry && !input) {
        await message.reply('🔁 Format: `!bb ulang <URL Top4toP atau URL sumber>`').catch(() => {});
        return true;
    }

    const config = await enforceChannel(client, message.guildId, message.channelId);
    let sourceUrl = input;
    if (retry && parseTop4TopUrl(input)) {
        const previous = await findBoomboxByDirectUrl(client, message.guildId, input);
        if (!previous?.sourceUrl) {
            await message.reply('❌ URL Top4toP itu belum tercatat di riwayat SKAW. Kirim URL sumber aslinya setelah `!bb ulang`.').catch(() => {});
            return true;
        }
        sourceUrl = previous.sourceUrl;
    }

    if (detectBoomboxPlatform(sourceUrl)) {
        const progress = await message.reply({
            embeds: [progressEmbed('queued', retry ? '⏳ Re-convert dimasukkan ke queue...' : '⏳ URL terdeteksi. Memasukkan ke queue converter...', null, retry ? 'RE-CONVERT' : 'CONVERT')],
        }).catch(() => null);
        if (!progress) return true;

        await enqueue(client, {
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.author.id,
            sourceUrl,
            retry,
            progressMessage: progress,
        });
        return true;
    }

    await handleHistorySearch(message, input);
    return true;
}

export function getBoomboxRuntimeStatus(client) {
    const state = getRuntime(client);
    return { queue: state.queue.length, processing: state.processing, maxConcurrent: state.maxConcurrent, started: state.started };
}

export function startBoomboxService(client) {
    const state = getRuntime(client);
    if (state.started) return;
    state.started = true;

    client.on(Events.MessageCreate, (message) => {
        void handleBbPrefixMessage(client, message).catch((error) => {
            console.error('[BOOMBOX] prefix handler error:', error?.message || error);
        });
    });

    console.log('[BOOMBOX] SKAW Boombox v3 command service started (prefix: !bb).');
}
