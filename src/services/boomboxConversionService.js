import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl, sanitizeFileName } from '../utils/boomboxPlatform.js';

let YTDlpWrap = null;
let ytdlpPathPromise = null;
let ytdlpPromise = null;

async function loadWrapper() {
    if (!YTDlpWrap) {
        const mod = await import('yt-dlp-wrap-plus');
        YTDlpWrap = mod.default ?? mod;
    }
    return YTDlpWrap;
}

function platformName() {
    if (process.platform === 'win32') return 'win32';
    if (process.platform === 'darwin') return 'darwin';
    return 'linux';
}

function binaryName() {
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

async function ensureYtDlp() {
    if (!ytdlpPathPromise) {
        ytdlpPathPromise = (async () => {
            const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
            if (configured) return configured;

            const Wrapper = await loadWrapper();
            const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime');
            const binaryPath = path.join(runtimeDir, binaryName());
            await fs.mkdir(runtimeDir, { recursive: true });

            try {
                const stat = await fs.stat(binaryPath);
                if (stat.isFile() && stat.size > 1_000_000) return binaryPath;
            } catch {}

            const version = String(process.env.BOOMBOX_YTDLP_VERSION || '').trim();
            await Wrapper.downloadFromGithub(binaryPath, version, platformName(), true);
            await fs.chmod(binaryPath, 0o755).catch(() => {});
            return binaryPath;
        })();
    }
    return await ytdlpPathPromise;
}

async function getYtDlp() {
    if (!ytdlpPromise) {
        ytdlpPromise = (async () => {
            const Wrapper = await loadWrapper();
            const binary = await ensureYtDlp();
            return new Wrapper(binary);
        })();
    }
    return await ytdlpPromise;
}

function clean(value, fallback) {
    const text = String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 180);
}

function durationFromInfo(info) {
    const value = Number(info?.duration);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

async function infoFor(ytdlp, url) {
    const raw = await ytdlp.execPromise([
        url,
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
    ]);
    const text = String(raw || '').trim();
    try {
        return JSON.parse(text);
    } catch {
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            try { return JSON.parse(lines[i]); } catch {}
        }
    }
    throw new Error('yt-dlp tidak mengembalikan metadata yang valid.');
}

async function resolveSpotify(ytdlp, spotifyUrl) {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
        headers: { 'User-Agent': 'SKAW-GROUP-Boombox/4.0' },
    });
    if (!response.ok) throw new Error(`Spotify metadata gagal (HTTP ${response.status}).`);

    const data = await response.json();
    const title = clean(data.title, 'Spotify Track');
    const artist = clean(data.author_name, 'Unknown Artist');

    const raw = await ytdlp.execPromise([
        `ytsearch1:${title} ${artist}`,
        '--flat-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
    ]);

    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { parsed = null; }
    const entry = parsed?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) {
        throw new Error('Track Spotify terbaca, tetapi sumber audio publik yang cocok tidak ditemukan.');
    }

    return {
        sourceUrl: entry.webpage_url || entry.url,
        title,
        artist,
        thumbnail: data.thumbnail_url || entry.thumbnail || null,
    };
}

async function downloadMp3(ytdlp, sourceUrl, title, tempDir, maxMb, progress) {
    const safeName = sanitizeFileName(title);
    const output = path.join(tempDir, `${safeName}.%(ext)s`);
    await progress('download', '⬇️ Sedang mendownload audio...');

    await ytdlp.execPromise([
        sourceUrl,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--no-warnings',
        '--restrict-filenames',
        '--no-part',
        '--output', output,
        '--max-filesize', `${maxMb}M`,
        '--ffmpeg-location', String(ffmpegStatic),
    ]);

    const files = await fs.readdir(tempDir);
    const mp3 = files.find((name) => name.toLowerCase().endsWith('.mp3'));
    if (!mp3) throw new Error('File MP3 tidak ditemukan setelah proses conversion.');
    return path.join(tempDir, mp3);
}

export async function ensureConverterReady() {
    if (!ffmpegStatic) throw new Error('ffmpeg-static tidak tersedia. Jalankan npm install ffmpeg-static@5.3.0.');
    await fs.access(ffmpegStatic);
    const ytdlp = await getYtDlp();
    const version = await ytdlp.getVersion();
    return { ffmpeg: ffmpegStatic, ytdlp: String(version).trim() };
}

export async function convertToBoombox(sourceUrl, config, progress = async () => {}) {
    const normalized = normalizeSourceUrl(sourceUrl);
    const platform = detectBoomboxPlatform(normalized);
    if (!normalized || !platform) throw new Error('URL sumber tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.');

    const ytdlp = await getYtDlp();
    await progress('metadata', '🔎 Sedang membaca informasi audio...');

    let playableUrl = normalized;
    let info;
    let titleOverride = '';
    let artistOverride = '';
    let thumbnail = null;

    if (platform === 'spotify') {
        const resolved = await resolveSpotify(ytdlp, normalized);
        playableUrl = resolved.sourceUrl;
        titleOverride = resolved.title;
        artistOverride = resolved.artist;
        thumbnail = resolved.thumbnail;
    }

    info = await infoFor(ytdlp, playableUrl);
    const durationSeconds = durationFromInfo(info);
    if (!durationSeconds) throw new Error('Durasi audio tidak dapat dibaca.');
    if (durationSeconds > config.maxDurationSeconds) {
        throw new Error(`Durasi terlalu panjang (${Math.ceil(durationSeconds / 60)} menit). Maksimal ${Math.ceil(config.maxDurationSeconds / 60)} menit.`);
    }

    const title = clean(titleOverride || info.title, 'SKAW Boombox');
    const artist = clean(artistOverride || info.artist || info.creator || info.uploader || info.channel, 'Unknown Artist');
    thumbnail ||= info.thumbnail || null;
    const sourceKey = createHash('sha256').update(normalized).digest('hex');

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-'));
    try {
        const filePath = await downloadMp3(ytdlp, playableUrl, `${artist} - ${title}`, tmp, config.maxFileMb, progress);
        const stat = await fs.stat(filePath);
        if (stat.size > config.maxFileMb * 1024 * 1024) throw new Error(`File MP3 melebihi ${config.maxFileMb} MB.`);

        await progress('upload', '☁️ Audio siap. Sedang upload ke Top4toP...');
        const directUrl = await uploadMp3ToTop4Top(filePath, `${sanitizeFileName(`${artist} - ${title}`)}.mp3`);
        await progress('done', '✅ Upload selesai dan URL HTTP direct sudah tervalidasi.');

        return {
            sourceUrl: normalized,
            sourceKey,
            platform,
            title,
            artist,
            durationSeconds,
            thumbnail,
            directUrl,
            sizeBytes: stat.size,
        };
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}
