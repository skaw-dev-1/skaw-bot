import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events,
    MessageFlags,
} from 'discord.js';
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
const PLATFORM_NAMES = Object.freeze({
    youtube: 'YouTube',
    tiktok: 'TikTok',
    spotify: 'Spotify',
    soundcloud: 'SoundCloud',
});

function getState(client) {
    let state = states.get(client);
    if (!state) {
        state = { started: false, queue: [], processing: 0, maxConcurrent: 1 };
        states.set(client, state);
    }
    return state;
}

function safe(value, max = 1000) {
    const text = String(value ?? '').replace(/[<>]/g, '').trim();
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function durationLabel(seconds) {
    const total = Number(seconds || 0);
    if (!total) return 'Unknown';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function headerEmbed(client, title, description, mode) {
    const embed = new EmbedBuilder()
        .setColor(0x2F80ED)
        .setTitle(title)
        .setDescription(`${description}\n\n**Mode:** ${mode}`)
        .setFooter({ text: 'SKAW GROUP • Boombox Converter v7' });
    if (client.user) embed.setAuthor({ name: 'SKAW GROUP', iconURL: client.user.displayAvatarURL({ size: 128 }) });
    return embed;
}

function resultEmbed(client, result, { cached = false, retry = false } = {}) {
    const embed = new EmbedBuilder()
        .setColor(0x2F80ED)
        .setTitle('🎵 SKAW BOOMBOX CONVERTER')
        .setDescription(`**${safe(result.title, 256)}**`)
        .addFields(
            { name: '👤 Artist', value: safe(result.artist, 200) || 'Unknown', inline: true },
            { name: '⏱ Duration', value: durationLabel(result.durationSeconds), inline: true },
            { name: '📁 Format', value: 'MP3', inline: true },
            { name: '🌐 Source', value: PLATFORM_NAMES[result.platform] || safe(result.platform), inline: true },
            {
                name: cached ? '♻️ Existing URL' : retry ? '🔄 New Boombox URL' : '🔗 Boombox URL',
                value: `\`${safe(result.directUrl, 1900)}\``,
                inline: false,
            },
        )
        .setFooter({
            text: retry
                ? 'Generate ulang selesai • URL Top4toP baru'
                : cached
                    ? 'Hasil tersimpan • gunakan ulang untuk generate URL baru'
                    : 'Direct HTTP MP3 • SKAW GROUP',
        });
    if (client.user) embed.setAuthor({ name: 'SKAW GROUP', iconURL: client.user.displayAvatarURL({ size: 128 }) });
    if (result.thumbnail && /^https?:\/\//i.test(result.thumbnail)) embed.setThumbnail(result.thumbnail);
    return embed;
}

function resultButtons(url) {
    if (!isDirectHttpMp3Url(url)) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Open HTTP URL').setURL(url),
    )];
}

async function requireChannel(client, guildId, channelId) {
    const config = await getBoomboxConfig(client, guildId);
    if (!config.enabled) throw new Error('SKAW Boombox sedang nonaktif. Jalankan `/boombox-config enable`.');
    if (!config.channelId) throw new Error('Channel Boombox belum diatur. Jalankan `/boombox-config channel`.');
    if (String(config.channelId) !== String(channelId)) throw new Error(`Boombox hanya aktif di <#${config.channelId}>.`);
    return config;
}

function claimCooldown(guildId, userId, seconds) {
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const until = cooldowns.get(key) || 0;
    if (until > now) return Math.ceil((until - now) / 1000);
    cooldowns.set(key, now + Math.max(0, Number(seconds || 0)) * 1000);
    return 0;
}

async function sourceForRetry(client, guildId, input) {
    if (!parseTop4TopUrl(input)) return input;
    const previous = await findResultByDirectUrl(client, guildId, input);
    if (!previous?.sourceUrl) {
        throw new Error('URL Top4toP ini belum tercatat sebagai hasil SKAW. Gunakan URL sumber aslinya setelah `ulang`.');
    }
    return previous.sourceUrl;
}

async function sendProgress(channel, client, mode, message) {
    return channel.send({
        embeds: [headerEmbed(client, '🔄 SKAW BOOMBOX • QUEUED', message, mode)],
        allowedMentions: { parse: [] },
    });
}

function enqueue(state, job) {
    state.queue.push(job);
    pump(job.client);
}

async function processJob(client, job) {
    const state = getState(client);
    state.processing += 1;
    try {
        const { convertToBoombox } = await import('./boomboxConversionService.js');
        const report = async (_stage, text) => {
            await job.progress.edit({
                embeds: [headerEmbed(client, '🔄 SKAW BOOMBOX • SEDANG DIPROSES', text, job.retry ? 'RE-CONVERT' : 'CONVERT')],
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
            components: resultButtons(result.directUrl),
        }).catch(() => {});
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await job.progress.edit({
            embeds: [new EmbedBuilder()
                .setColor(0x2F80ED)
                .setTitle('❌ SKAW BOOMBOX • GAGAL')
                .setDescription(safe(text, 3900))
                .setFooter({ text: 'SKAW GROUP • Jalankan /boombox-config test untuk memeriksa engine.' })],
            components: [],
        }).catch(() => {});
    } finally {
        state.processing -= 1;
        pump(client);
    }
}

function pump(client) {
    const state = getState(client);
    while (state.processing < state.maxConcurrent && state.queue.length) {
        const job = state.queue.shift();
        void processJob(client, job);
    }
}

async function prepareRequest(client, guildId, channelId, userId, rawInput, retry) {
    const config = await requireChannel(client, guildId, channelId);
    const wait = claimCooldown(guildId, userId, config.cooldownSeconds);
    if (wait) throw new Error(`Tunggu ${wait} detik sebelum convert lagi.`);

    const sourceUrl = retry ? await sourceForRetry(client, guildId, rawInput) : rawInput;
    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized || !detectBoomboxPlatform(normalized)) {
        throw new Error('URL tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.');
    }
    const state = getState(client);
    if (state.queue.length >= config.queueLimit) throw new Error(`Queue penuh (${config.queueLimit}).`);
    return { config, normalized };
}

export async function executeBbSlash(interaction) {
    // Keep this compatible with TitanBot's custom command router: only require
    // the interaction capabilities the command actually uses.
    if (!interaction?.options || typeof interaction.reply !== 'function' || typeof interaction.editReply !== 'function') {
        throw new Error('Invalid slash interaction.');
    }
    if (!interaction.guildId) throw new Error('Command hanya bisa digunakan di server.');

    const input = interaction.options.getString('url', true).trim();
    const retry = interaction.options.getBoolean('ulang') === true;

    // Defer immediately so Discord does not expire the interaction while the
    // database/config checks are running.
    await interaction.deferReply();

    try {
        const { config, normalized } = await prepareRequest(
            interaction.client,
            interaction.guildId,
            interaction.channelId,
            interaction.user.id,
            input,
            retry,
        );

        await interaction.editReply({
            embeds: [headerEmbed(
                interaction.client,
                '🔄 SKAW BOOMBOX • QUEUED',
                retry ? '⏳ Re-convert dimasukkan ke queue...' : '⏳ URL dimasukkan ke queue converter...',
                retry ? 'RE-CONVERT' : 'CONVERT',
            )],
            allowedMentions: { parse: [] },
        });

        const progress = await interaction.fetchReply();
        const state = getState(interaction.client);
        enqueue(state, {
            client: interaction.client,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            sourceUrl: normalized,
            retry,
            progress,
            config,
        });
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await interaction.editReply({ content: `❌ ${text}`, embeds: [], components: [] }).catch(async () => {
            await interaction.followUp({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
        });
    }
}

export async function executeBbPrefix(client, message) {
    if (!message?.guildId || message.author?.bot) return false;
    const content = String(message.content || '').trim();
    const match = /^!bb(?:\s+([\s\S]*))?$/i.exec(content);
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

        const { config, normalized } = await prepareRequest(client, message.guildId, message.channelId, message.author.id, input, retry);
        const existing = !retry ? await findResultBySourceUrl(client, message.guildId, normalized) : null;
        const progress = await sendProgress(message.channel, client, retry ? 'RE-CONVERT' : 'CONVERT', existing?.directUrl ? '♻️ Hasil sebelumnya ditemukan. Menampilkan hasil tersimpan...' : '⏳ URL diterima dan masuk ke queue...');

        if (existing?.directUrl) {
            await progress.edit({ embeds: [resultEmbed(client, existing, { cached: true })], components: resultButtons(existing.directUrl) }).catch(() => {});
            return true;
        }

        const state = getState(client);
        enqueue(state, { client, guildId: message.guildId, channelId: message.channelId, userId: message.author.id, sourceUrl: normalized, retry, progress, config });
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await message.reply(`❌ ${text}`).catch(() => {});
    }
    return true;
}

export async function searchBbHistory(client, message, query) {
    await requireChannel(client, message.guildId, message.channelId);
    const rows = await searchBoomboxHistory(client, message.guildId, query, 8);
    if (!rows.length) {
        await message.reply('🔎 Tidak ada hasil di riwayat Boombox SKAW.').catch(() => {});
        return;
    }
    const description = rows.map((item, i) => `**${i + 1}. ${safe(item.title, 90)}** — ${safe(item.artist, 60)}\n${safe(item.directUrl, 350)}`).join('\n\n');
    await message.reply({ embeds: [new EmbedBuilder().setColor(0x2F80ED).setTitle('🔎 SKAW BOOMBOX • RIWAYAT').setDescription(description)] }).catch(() => {});
}

export function getBoomboxRuntimeStatus(client) {
    const state = getState(client);
    return { queue: state.queue.length, processing: state.processing, maxConcurrent: state.maxConcurrent, started: state.started };
}

export function startBoomboxService(client) {
    const state = getState(client);
    if (state.started) return;
    state.maxConcurrent = 1;
    state.started = true;
    client.on(Events.MessageCreate, (message) => {
        void executeBbPrefix(client, message).catch((error) => console.error('[BOOMBOX v7]', error));
    });
    console.log('[BOOMBOX v7] prefix handler started.');
}
