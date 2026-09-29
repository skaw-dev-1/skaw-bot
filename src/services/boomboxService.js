import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } from 'discord.js';
import {
    findResultByDirectUrl,
    findResultBySourceUrl,
    getBoomboxConfig,
    saveBoomboxResult,
    setBoomboxEnabled,
} from './boomboxStorageService.js';
import { detectBoomboxPlatform, extractSupportedSourceUrl, normalizeSourceUrl } from '../utils/boomboxPlatform.js';
import { isDirectHttpMp3Url } from '../utils/boomboxUrl.js';

const states = new WeakMap();
const cooldowns = new Map();

function stateFor(client) {
    let state = states.get(client);
    if (!state) {
        state = { started: false, queue: [], processing: 0, maxConcurrent: 2 };
        states.set(client, state);
    }
    return state;
}

function durationText(seconds) {
    const total = Number(seconds || 0);
    if (!total) return 'Unknown';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function sourceText(platform) {
    return {
        youtube: 'YouTube',
        tiktok: 'TikTok',
        spotify: 'Spotify',
        soundcloud: 'SoundCloud',
    }[platform] || platform;
}

function progressEmbed(title, description, thumbnail = null, mode = 'CONVERT') {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`${description}\n\n**Mode:** ${mode}`)
        .setFooter({ text: 'SKAW GROUP • Boombox Converter' });
    if (thumbnail && /^https?:\/\//i.test(thumbnail)) embed.setThumbnail(thumbnail);
    return embed;
}

function resultEmbed(result, retry = false, cached = false) {
    const embed = new EmbedBuilder()
        .setTitle('🎵 SKAW BOOMBOX CONVERTER')
        .setDescription(`**${String(result.title || 'Unknown').slice(0, 256)}**`)
        .addFields(
            { name: '👤 Artist', value: String(result.artist || 'Unknown').slice(0, 200), inline: true },
            { name: '⏱ Duration', value: durationText(result.durationSeconds), inline: true },
            { name: '📁 Format', value: 'MP3', inline: true },
            { name: '🌐 Source', value: sourceText(result.platform), inline: true },
            { name: cached ? '♻️ Existing URL' : retry ? '🔄 New Boombox URL' : '🔗 Boombox URL', value: `\`${result.directUrl}\``, inline: false },
        )
        .setFooter({ text: retry ? 'Generate ulang berhasil. URL Top4toP baru dibuat dari sumber asli.' : cached ? 'Hasil tersimpan. Gunakan !bb ulang untuk membuat URL baru.' : 'Direct HTTP MP3 • Powered by SKAW GROUP' });
    if (result.thumbnail && /^https?:\/\//i.test(result.thumbnail)) embed.setThumbnail(result.thumbnail);
    return embed;
}

function urlButton(url) {
    if (!isDirectHttpMp3Url(url)) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🔗 Open Boombox URL').setStyle(ButtonStyle.Link).setURL(url),
    )];
}

async function checkChannel(client, guildId, channelId) {
    const config = await getBoomboxConfig(client, guildId);
    if (!config.enabled || !config.channelId || String(config.channelId) !== String(channelId)) {
        throw new Error(config.channelId ? `Boombox hanya aktif di <#${config.channelId}>.` : 'Boombox channel belum dikonfigurasi.');
    }
    return config;
}

function cooldownRemaining(guildId, userId, seconds) {
    const key = `${guildId}:${userId}`;
    const until = cooldowns.get(key) || 0;
    const remaining = Math.max(0, until - Date.now());
    if (remaining) return Math.ceil(remaining / 1000);
    cooldowns.set(key, Date.now() + Math.max(0, Number(seconds || 0)) * 1000);
    return 0;
}

async function processJob(client, job) {
    const state = stateFor(client);
    state.processing += 1;
    try {
        const { convertToBoombox } = await import('./boomboxConversionService.js');
        let latest = job.progress;
        const progress = async (_stage, text) => {
            latest = await job.progress.edit({
                embeds: [progressEmbed('🔄 SKAW BOOMBOX • SEDANG DIPROSES', text, job.thumbnail, job.retry ? 'RE-CONVERT' : 'CONVERT')],
            }).catch(() => latest);
        };

        await progress('start', '🔎 Sedang membaca informasi audio...');
        const result = await convertToBoombox(job.sourceUrl, job.config, progress);
        await saveBoomboxResult(client, job.guildId, {
            sourceUrl: result.sourceUrl,
            platform: result.platform,
            title: result.title,
            artist: result.artist,
            durationSeconds: result.durationSeconds,
            thumbnail: result.thumbnail,
            directUrl: result.directUrl,
            sizeBytes: result.sizeBytes,
            createdBy: job.userId,
        });

        await latest.edit({
            embeds: [resultEmbed(result, job.retry, false)],
            components: urlButton(result.directUrl),
        }).catch(() => {});
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await job.progress.edit({
            embeds: [new EmbedBuilder()
                .setTitle('❌ SKAW BOOMBOX • GAGAL')
                .setDescription(text.slice(0, 3900))
                .setFooter({ text: 'Periksa error Railway jika engine/dependency bermasalah.' })],
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

async function enqueue(client, job) {
    const state = stateFor(client);
    const config = await checkChannel(client, job.guildId, job.channelId);
    if (state.queue.length >= config.queueLimit) throw new Error(`Queue sedang penuh (${config.queueLimit}).`);

    const wait = cooldownRemaining(job.guildId, job.userId, config.cooldownSeconds);
    if (wait) throw new Error(`Tunggu ${wait} detik sebelum convert lagi.`);

    const normalized = normalizeSourceUrl(job.sourceUrl);
    if (!normalized || !detectBoomboxPlatform(normalized)) throw new Error('URL harus berasal dari YouTube, TikTok, Spotify, atau SoundCloud.');

    if (!job.retry) {
        const cached = await findResultBySourceUrl(client, job.guildId, normalized);
        if (cached?.directUrl) {
            await job.progress.edit({
                embeds: [resultEmbed(cached, false, true)],
                components: urlButton(cached.directUrl),
            }).catch(() => {});
            return;
        }
    }

    state.queue.push({ ...job, sourceUrl: normalized, config });
    pump(client);
}

async function enqueueAfterReply(interaction, sourceUrl, retry) {
    const config = await checkChannel(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({
        embeds: [progressEmbed('🔄 SKAW BOOMBOX • QUEUED', retry ? '⏳ Re-convert dimasukkan ke queue...' : '⏳ URL dimasukkan ke queue converter...', null, retry ? 'RE-CONVERT' : 'CONVERT')],
    });
    const progress = await interaction.fetchReply();
    await enqueue(interaction.client, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        sourceUrl,
        retry,
        progress,
        thumbnail: null,
        config,
    });
}

export async function executeBbSlash(interaction) {
    if (!interaction.inGuild()) throw new Error('Command hanya bisa digunakan di server.');
    const input = interaction.options.getString('url', true).trim();
    const retry = interaction.options.getBoolean('ulang') === true;

    let sourceUrl = input;
    if (retry && isDirectHttpMp3Url(input)) {
        const previous = await findResultByDirectUrl(interaction.client, interaction.guildId, input);
        if (!previous?.sourceUrl) throw new Error('URL Top4toP tersebut belum tercatat di riwayat SKAW.');
        sourceUrl = previous.sourceUrl;
    }

    await enqueueAfterReply(interaction, sourceUrl, retry);
}

export async function executeBbPrefix(client, message) {
    if (!message.guildId || message.author?.bot) return false;
    const content = String(message.content || '').trim();
    const match = content.match(/^!bb\b\s*([\s\S]*)$/i);
    if (!match) return false;

    const rest = match[1].trim();
    if (!rest) {
        await message.reply('📻 Gunakan `!bb <URL>` atau `!bb ulang <URL Top4toP / URL sumber>`.').catch(() => {});
        return true;
    }

    let retry = false;
    let input = rest;
    if (/^ulang\b/i.test(rest)) {
        retry = true;
        input = rest.replace(/^ulang\b/i, '').trim();
    }
    if (!input) {
        await message.reply('🔄 Format: `!bb ulang <URL Top4toP atau URL sumber>`.').catch(() => {});
        return true;
    }

    try {
        const config = await checkChannel(client, message.guildId, message.channelId);
        const wait = cooldownRemaining(message.guildId, message.author.id, config.cooldownSeconds);
        if (wait) {
            await message.reply(`⏳ Tunggu **${wait} detik** sebelum convert lagi.`).catch(() => {});
            return true;
        }

        let sourceUrl = input;
        if (retry && isDirectHttpMp3Url(input)) {
            const previous = await findResultByDirectUrl(client, message.guildId, input);
            if (!previous?.sourceUrl) {
                await message.reply('❌ URL Top4toP itu tidak ada di riwayat SKAW. Gunakan URL sumber aslinya setelah `!bb ulang`.').catch(() => {});
                return true;
            }
            sourceUrl = previous.sourceUrl;
        }

        const source = normalizeSourceUrl(sourceUrl);
        if (!source || !detectBoomboxPlatform(source)) {
            await message.reply('❌ URL tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.').catch(() => {});
            return true;
        }

        const progress = await message.reply({
            embeds: [progressEmbed('🔄 SKAW BOOMBOX • QUEUED', retry ? '⏳ Re-convert masuk ke queue...' : '⏳ URL terdeteksi dan masuk ke queue...', null, retry ? 'RE-CONVERT' : 'CONVERT')],
            allowedMentions: { repliedUser: false },
        }).catch(() => null);
        if (!progress) return true;

        await enqueue(client, {
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.author.id,
            sourceUrl: source,
            retry,
            progress,
            thumbnail: null,
            config,
        });
    } catch (error) {
        await message.reply(`❌ ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }

    return true;
}

export function getBoomboxRuntimeStatus(client) {
    const state = stateFor(client);
    return { queue: state.queue.length, processing: state.processing, maxConcurrent: state.maxConcurrent, started: state.started };
}

export function startBoomboxService(client) {
    const state = stateFor(client);
    if (state.started) return;
    state.started = true;

    client.on(Events.MessageCreate, (message) => {
        void executeBbPrefix(client, message).catch((error) => {
            console.error('[BOOMBOX] prefix handler error:', error?.message || error);
        });
    });

    console.log('[BOOMBOX] SKAW Boombox v4 service started.');
}
