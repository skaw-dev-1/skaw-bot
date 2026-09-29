import { EmbedBuilder, Events } from 'discord.js';
import { getBoomboxConfig, saveBoomboxConfig } from './boomboxStorageService.js';
import { extractSupportedUrl } from '../utils/boomboxPlatform.js';

const state = new WeakMap();
const globalCooldown = new Map();

function runtimeFor(client) {
    let current = state.get(client);
    if (!current) {
        current = {
            started: false,
            queue: [],
            processing: 0,
            maxConcurrent: Number(process.env.BOOMBOX_MAX_CONCURRENT || 2),
        };
        state.set(client, current);
    }
    return current;
}

function platformLabel(platform) {
    return {
        youtube: 'YouTube',
        tiktok: 'TikTok',
        spotify: 'Spotify',
        soundcloud: 'SoundCloud',
    }[platform] || platform;
}

function formatDuration(seconds) {
    const value = Number(seconds || 0);
    if (!value) return 'Unknown';
    const mins = Math.floor(value / 60);
    const secs = Math.floor(value % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function updateRuntime(client, guildId) {
    try {
        const runtime = runtimeFor(client);
        const config = await getBoomboxConfig(client, guildId);
        await saveBoomboxConfig(client, guildId, {
            runtime: { queue: runtime.queue.length, processing: runtime.processing },
        });
        return config;
    } catch {
        return null;
    }
}

async function editProgress(message, title, description) {
    await message.edit({
        embeds: [new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)],
    }).catch(() => {});
}

async function processJob(client, job) {
    const runtime = runtimeFor(client);
    runtime.processing += 1;
    await updateRuntime(client, job.message.guildId);

    try {
        const { convertToBoombox } = await import('./boomboxConversionService.js');
        const result = await convertToBoombox(job.url, {
            maxDurationSeconds: job.config.maxDurationSeconds,
            maxFileMb: job.config.maxFileMb,
        });

        const resultEmbed = new EmbedBuilder()
            .setTitle('SKAW BOOMBOX CONVERTER')
            .addFields(
                { name: '🎵 Title', value: result.title || 'Unknown' },
                { name: '👤 Artist', value: result.artist || 'Unknown', inline: true },
                { name: '⏱ Duration', value: formatDuration(result.durationSeconds), inline: true },
                { name: '📁 Format', value: 'MP3', inline: true },
                { name: '🌐 Source', value: platformLabel(result.platform), inline: true },
            )
            .setDescription(`🔗 **Boombox URL**\n\`${result.url}\``)
            .setFooter({ text: 'Gunakan URL HTTP direct yang ditampilkan di atas.' });

        await job.message.reply({ embeds: [resultEmbed] });
        await job.progress.delete().catch(() => {});
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Konversi gagal.';
        await editProgress(job.progress, 'SKAW BOOMBOX • ERROR', `❌ ${message}`);
    } finally {
        runtime.processing -= 1;
        await updateRuntime(client, job.message.guildId);
        pump(client);
    }
}

function pump(client) {
    const runtime = runtimeFor(client);
    while (runtime.processing < runtime.maxConcurrent && runtime.queue.length) {
        const job = runtime.queue.shift();
        void processJob(client, job);
    }
}

async function handleMessage(client, message) {
    if (!message.guildId || message.author?.bot) return;

    const contentUrl = extractSupportedUrl(message.content);
    if (!contentUrl) return;

    const config = await getBoomboxConfig(client, message.guildId);
    if (!config.enabled || !config.channelId || String(config.channelId) !== String(message.channelId)) return;

    const now = Date.now();
    const cooldownMs = Math.max(0, Number(config.cooldownSeconds || 30)) * 1000;
    const cooldownKey = `${message.guildId}:${message.author.id}`;
    const last = globalCooldown.get(cooldownKey) || 0;

    if (now - last < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - (now - last)) / 1000);
        await message.reply({ content: `⏳ Tunggu ${remaining} detik sebelum memasukkan URL lagi.` }).catch(() => {});
        return;
    }
    globalCooldown.set(cooldownKey, now);

    const runtime = runtimeFor(client);
    if (runtime.queue.length >= 25) {
        await message.reply({ content: '⚠️ Queue Boombox sedang penuh. Coba lagi sebentar.' }).catch(() => {});
        return;
    }

    const progress = await message.reply({
        embeds: [new EmbedBuilder()
            .setTitle('SKAW BOOMBOX • QUEUED')
            .setDescription('⏳ URL terdeteksi dan masuk ke queue converter.')],
    }).catch(() => null);

    if (!progress) return;

    runtime.queue.push({ message, url: contentUrl, config, progress });
    await updateRuntime(client, message.guildId);
    pump(client);
}

export function getBoomboxRuntimeStatus(client) {
    const runtime = runtimeFor(client);
    return {
        queue: runtime.queue.length,
        processing: runtime.processing,
        maxConcurrent: runtime.maxConcurrent,
    };
}

export function startBoomboxService(client) {
    const runtime = runtimeFor(client);
    if (runtime.started) return;
    runtime.started = true;

    client.on(Events.MessageCreate, (message) => {
        void handleMessage(client, message).catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            console.error('[BOOMBOX] message handler error:', text);
        });
    });

    console.log('[BOOMBOX] SKAW Boombox Converter service started.');
}
