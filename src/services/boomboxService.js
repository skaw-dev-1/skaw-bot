import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, MessageFlags } from 'discord.js';
import {
    findResultByDirectUrl,
    findResultBySourceUrl,
    getBoomboxConfig,
    saveBoomboxResult,
    searchBoomboxHistory,
} from './boomboxStorageService.js';
import { detectBoomboxPlatform, normalizeSourceUrl } from '../utils/boomboxPlatform.js';
import { isDirectHttpMp3Url, parseTop4TopUrl } from '../utils/boomboxUrl.js';

const states = new WeakMap();
const cooldowns = new Map();
const BOT_MARKER = 'SKAW-GROUP-Boombox-v6';

const PLATFORM_LABELS = Object.freeze({
    youtube: 'YouTube',
    tiktok: 'TikTok',
    spotify: 'Spotify',
    soundcloud: 'SoundCloud',
});

function stateFor(client) {
    let state = states.get(client);
    if (!state) {
        state = {
            started: false,
            queue: [],
            processing: 0,
            maxConcurrent: 2,
        };
        states.set(client, state);
    }
    return state;
}

function formatDuration(seconds) {
    const total = Number(seconds || 0);
    if (!total) return 'Unknown';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function safeText(value, max = 1000) {
    const text = String(value || 'Unknown').replace(/[<>]/g, '');
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function progressEmbed(client, title, description, mode) {
    const embed = new EmbedBuilder()
        .setColor(0x2F80ED)
        .setTitle(title)
        .setDescription(`${description}\n\n**Mode:** ${mode}`)
        .setFooter({ text: `${BOT_MARKER} • SKAW GROUP` });

    if (client.user) {
        embed.setAuthor({ name: 'SKAW GROUP', iconURL: client.user.displayAvatarURL({ size: 128 }) });
    }
    return embed;
}

function resultEmbed(client, result, { cached = false, retry = false } = {}) {
    const title = safeText(result.title, 256);
    const artist = safeText(result.artist, 200);
    const embed = new EmbedBuilder()
        .setColor(0x2F80ED)
        .setTitle('🎵 SKAW BOOMBOX CONVERTER')
        .setDescription(`**${title}**`)
        .addFields(
            { name: '👤 Artist', value: artist, inline: true },
            { name: '⏱ Duration', value: formatDuration(result.durationSeconds), inline: true },
            { name: '📁 Format', value: 'MP3', inline: true },
            { name: '🌐 Source', value: PLATFORM_LABELS[result.platform] || String(result.platform || 'Unknown'), inline: true },
            { name: cached ? '♻️ Existing URL' : retry ? '🔄 New Boombox URL' : '🔗 Boombox URL', value: `\`${safeText(result.directUrl, 1900)}\``, inline: false },
        )
        .setFooter({
            text: retry
                ? 'Generate ulang berhasil • URL Top4toP baru'
                : cached
                    ? 'Hasil tersimpan • gunakan !bb ulang untuk membuat URL baru'
                    : `${BOT_MARKER} • Direct HTTP MP3`,
        });

    if (client.user) {
        embed.setAuthor({ name: 'SKAW GROUP', iconURL: client.user.displayAvatarURL({ size: 128 }) });
    }
    if (result.thumbnail && /^https?:\/\//i.test(result.thumbnail)) embed.setThumbnail(result.thumbnail);
    return embed;
}

function urlComponents(url) {
    if (!isDirectHttpMp3Url(url)) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('🔗 Open HTTP URL')
            .setStyle(ButtonStyle.Link)
            .setURL(url),
    )];
}

async function getAllowedConfig(client, guildId, channelId) {
    const config = await getBoomboxConfig(client, guildId);
    if (!config.enabled) throw new Error('SKAW Boombox sedang nonaktif. Jalankan `/boombox-config enable`.');
    if (!config.channelId) throw new Error('Channel Boombox belum ditentukan. Jalankan `/boombox-config channel`.');
    if (String(config.channelId) !== String(channelId)) throw new Error(`Boombox hanya aktif di <#${config.channelId}>.`);
    return config;
}

function checkCooldown(guildId, userId, seconds) {
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const until = cooldowns.get(key) || 0;
    if (until > now) return Math.ceil((until - now) / 1000);
    cooldowns.set(key, now + Math.max(0, Number(seconds || 0)) * 1000);
    return 0;
}

async function resolveRetrySource(client, guildId, input) {
    if (!parseTop4TopUrl(input)) return input;
    const previous = await findResultByDirectUrl(client, guildId, input);
    if (!previous?.sourceUrl) {
        throw new Error('URL Top4toP tersebut belum tercatat di riwayat SKAW. Untuk re-convert, gunakan URL sumber asli.');
    }
    return previous.sourceUrl;
}

async function sendProgressMessage(client, channel, mode, text) {
    return await channel.send({
        embeds: [progressEmbed(client, '🔄 SKAW BOOMBOX • SEDANG DIPROSES', text, mode)],
        allowedMentions: { parse: [] },
    });
}

async function processJob(client, job) {
    const state = stateFor(client);
    state.processing += 1;
    try {
        const { convertToBoombox } = await import('./boomboxConversionService.js');
        const report = async (_stage, text) => {
            await job.progress.edit({
                embeds: [progressEmbed(client, '🔄 SKAW BOOMBOX • SEDANG DIPROSES', text, job.retry ? 'RE-CONVERT' : 'CONVERT')],
            }).catch(() => {});
        };

        await report('prepare', '🔎 Sedang membaca informasi audio...');
        const result = await convertToBoombox(job.sourceUrl, job.config, report);

        await saveBoomboxResult(client, job.guildId, {
            sourceUrl: result.sourceUrl,
            sourceKey: result.sourceKey,
            platform: result.platform,
            title: result.title,
            artist: result.artist,
            durationSeconds: result.durationSeconds,
            thumbnail: result.thumbnail,
            directUrl: result.directUrl,
            sizeBytes: result.sizeBytes,
            createdBy: job.userId,
        });

        await job.progress.edit({
            embeds: [resultEmbed(client, result, { retry: job.retry })],
            components: urlComponents(result.directUrl),
        }).catch(() => {});
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await job.progress.edit({
            embeds: [new EmbedBuilder()
                .setColor(0x2F80ED)
                .setTitle('❌ SKAW BOOMBOX • GAGAL')
                .setDescription(safeText(text, 3900))
                .setFooter({ text: `${BOT_MARKER} • Cek /boombox-config test untuk engine` })],
            components: [],
        }).catch(() => {});
    } finally {
        state.processing -= 1;
        pump(client);
    }
}

function pump(client) {
    const state = stateFor(client);
    while (state.processing < state.maxConcurrent && state.queue.length) {
        const job = state.queue.shift();
        void processJob(client, job);
    }
}

async function enqueue(client, { guildId, channelId, userId, sourceUrl, retry, progress }) {
    const config = await getAllowedConfig(client, guildId, channelId);
    const state = stateFor(client);

    if (state.queue.length >= config.queueLimit) throw new Error(`Queue penuh (${config.queueLimit}). Tunggu proses sebelumnya selesai.`);

    const wait = checkCooldown(guildId, userId, config.cooldownSeconds);
    if (wait) throw new Error(`Tunggu ${wait} detik sebelum convert lagi.`);

    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized || !detectBoomboxPlatform(normalized)) {
        throw new Error('URL tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.');
    }

    if (!retry) {
        const cached = await findResultBySourceUrl(client, guildId, normalized);
        if (cached?.directUrl) {
            await progress.edit({
                embeds: [resultEmbed(client, cached, { cached: true })],
                components: urlComponents(cached.directUrl),
            }).catch(() => {});
            return;
        }
    }

    state.queue.push({ guildId, channelId, userId, sourceUrl: normalized, retry: Boolean(retry), progress, config });
    pump(client);
}

export async function executeBbSlash(interaction) {
    if (!interaction || typeof interaction.isChatInputCommand !== 'function' || !interaction.isChatInputCommand()) {
        throw new Error('Invalid slash interaction.');
    }
    if (!interaction.inGuild()) throw new Error('Command hanya bisa digunakan di server.');

    const input = interaction.options.getString('url', true).trim();
    const retry = interaction.options.getBoolean('ulang') === true;
    let sourceUrl = input;

    if (retry) sourceUrl = await resolveRetrySource(interaction.client, interaction.guildId, input);

    const config = await getAllowedConfig(interaction.client, interaction.guildId, interaction.channelId);
    const wait = checkCooldown(interaction.guildId, interaction.user.id, config.cooldownSeconds);
    if (wait) throw new Error(`Tunggu ${wait} detik sebelum convert lagi.`);

    await interaction.reply({
        embeds: [progressEmbed(interaction.client, '🔄 SKAW BOOMBOX • QUEUED', retry ? '⏳ Re-convert dimasukkan ke queue...' : '⏳ URL dimasukkan ke queue converter...', retry ? 'RE-CONVERT' : 'CONVERT')],
    });
    const progress = await interaction.fetchReply();

    // Re-validate without consuming cooldown twice; enqueue's cooldown is skipped because this request already claimed it.
    const state = stateFor(interaction.client);
    if (state.queue.length >= config.queueLimit) throw new Error(`Queue penuh (${config.queueLimit}).`);
    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized || !detectBoomboxPlatform(normalized)) throw new Error('URL tidak didukung.');

    if (!retry) {
        const cached = await findResultBySourceUrl(interaction.client, interaction.guildId, normalized);
        if (cached?.directUrl) {
            await progress.edit({ embeds: [resultEmbed(interaction.client, cached, { cached: true })], components: urlComponents(cached.directUrl) }).catch(() => {});
            return;
        }
    }

    state.queue.push({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        sourceUrl: normalized,
        retry,
        progress,
        config,
    });
    pump(interaction.client);
}

export async function executeBbPrefix(client, message) {
    if (!message?.guildId || message.author?.bot) return false;

    const content = String(message.content || '').trim();
    const match = content.match(/^!bb(?:\s+([\s\S]*))?$/i);
    if (!match) return false;

    try {
        const rest = String(match[1] || '').trim();
        if (!rest) {
            await message.reply('📻 Gunakan `!bb <URL>` atau `!bb ulang <URL Top4toP / URL sumber>`.').catch(() => {});
            return true;
        }

        const retry = /^ulang\b/i.test(rest);
        const input = retry ? rest.replace(/^ulang\b/i, '').trim() : rest;
        if (!input) {
            await message.reply('🔄 Format: `!bb ulang <URL Top4toP atau URL sumber>`.').catch(() => {});
            return true;
        }

        const config = await getAllowedConfig(client, message.guildId, message.channelId);
        const wait = checkCooldown(message.guildId, message.author.id, config.cooldownSeconds);
        if (wait) {
            await message.reply(`⏳ Tunggu **${wait} detik** sebelum convert lagi.`).catch(() => {});
            return true;
        }

        const sourceUrl = retry ? await resolveRetrySource(client, message.guildId, input) : input;
        const normalized = normalizeSourceUrl(sourceUrl);
        if (!normalized || !detectBoomboxPlatform(normalized)) {
            await message.reply('❌ URL tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.').catch(() => {});
            return true;
        }

        const state = stateFor(client);
        if (state.queue.length >= config.queueLimit) {
            await message.reply(`⚠️ Queue penuh (${config.queueLimit}). Coba lagi sebentar.`).catch(() => {});
            return true;
        }

        const cached = !retry ? await findResultBySourceUrl(client, message.guildId, normalized) : null;
        const progress = await sendProgressMessage(client, message.channel, retry ? 'RE-CONVERT' : 'CONVERT', cached?.directUrl ? '♻️ Hasil sebelumnya ditemukan. Menampilkan hasil tersimpan...' : '⏳ URL diterima dan masuk ke queue...');
        if (cached?.directUrl) {
            await progress.edit({ embeds: [resultEmbed(client, cached, { cached: true })], components: urlComponents(cached.directUrl) }).catch(() => {});
            return true;
        }

        state.queue.push({
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.author.id,
            sourceUrl: normalized,
            retry,
            progress,
            config,
        });
        pump(client);
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await message.reply(`❌ ${text}`).catch(() => {});
    }

    return true;
}

export async function searchBbHistory(client, message, query) {
    const config = await getAllowedConfig(client, message.guildId, message.channelId);
    void config;
    const rows = await searchBoomboxHistory(client, message.guildId, query, 8);
    if (!rows.length) {
        await message.reply('🔎 Tidak ada hasil di riwayat Boombox SKAW.').catch(() => {});
        return;
    }
    const text = rows.map((item, index) => `**${index + 1}. ${safeText(item.title, 80)}** — ${safeText(item.artist, 60)}\n${item.directUrl}`).join('\n\n');
    await message.reply({ embeds: [new EmbedBuilder().setColor(0x2F80ED).setTitle('🔎 SKAW BOOMBOX • RIWAYAT').setDescription(text)] }).catch(() => {});
}

export function getBoomboxRuntimeStatus(client) {
    const state = stateFor(client);
    return {
        queue: state.queue.length,
        processing: state.processing,
        maxConcurrent: state.maxConcurrent,
        started: state.started,
    };
}

export function startBoomboxService(client) {
    const state = stateFor(client);
    if (state.started) return;

    state.started = true;
    client.on(Events.MessageCreate, (message) => {
        void executeBbPrefix(client, message).catch((error) => {
            console.error(`[BOOMBOX] ${BOT_MARKER}:`, error?.message || error);
        });
    });

    console.log(`[BOOMBOX] ${BOT_MARKER} service started.`);
}
