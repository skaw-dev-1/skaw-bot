import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl } from '../utils/boomboxPlatform.js';

let YTDlpWrapClass = null;
let ytdlpPathPromise = null;
let ytdlpInstancePromise = null;

function cleanText(value, fallback = 'Unknown') {
    const text = String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 180);
}

function executableName() {
    return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function ytPlatform() {
    if (process.platform === 'win32') return 'win32';
    if (process.platform === 'darwin') return 'darwin';
    return 'linux';
}

async function loadWrapper() {
    if (!YTDlpWrapClass) {
        const mod = await import('yt-dlp-wrap-plus');
        YTDlpWrapClass = mod.default ?? mod;
    }
    return YTDlpWrapClass;
}

async function ensureYtDlp() {
    if (!ytdlpPathPromise) {
        ytdlpPathPromise = (async () => {
            const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
            if (configured) return configured;

            const YTDlpWrap = await loadWrapper();
            const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime');
            await fs.mkdir(runtimeDir, { recursive: true });
            const outputPath = path.join(runtimeDir, executableName());

            try {
                const stat = await fs.stat(outputPath);
                if (stat.isFile() && stat.size > 1_000_000) return outputPath;
            } catch {}

            const version = String(process.env.BOOMBOX_YTDLP_VERSION || '').trim();
            await YTDlpWrap.downloadFromGithub(outputPath, version, ytPlatform(), true);
            await fs.chmod(outputPath, 0o755).catch(() => {});
            return outputPath;
        })();
    }
    return await ytdlpPathPromise;
}

async function getYtDlp() {
    if (!ytdlpInstancePromise) {
        ytdlpInstancePromise = (async () => {
            const YTDlpWrap = await loadWrapper();
            const binary = await ensureYtDlp();
            return new YTDlpWrap(binary);
        })();
    }
    return await ytdlpInstancePromise;
}

function parseDuration(info) {
    const value = Number(info?.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

async function infoFromYtDlp(ytdlp, url) {
    const raw = await ytdlp.execPromise([
        url,
        '--no-playlist',
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
    ]);
    const text = String(raw || '').trim();
    try {
        return JSON.parse(text);
    } catch {
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            try {
                return JSON.parse(lines[index]);
            } catch {}
        }
        throw new Error('yt-dlp tidak mengembalikan metadata JSON yang valid.');
    }
}

async function resolveSpotify(ytdlp, spotifyUrl) {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
        headers: { 'User-Agent': 'SKAW-Boombox/3.0' },
    });
    if (!response.ok) throw new Error(`Metadata Spotify gagal (HTTP ${response.status}).`);

    const data = await response.json();
    const title = cleanText(data.title, 'Spotify Track');
    const artist = cleanText(data.author_name, 'Unknown');
    const query = `${title} ${artist}`.trim();

    const raw = await ytdlp.execPromise([
        `ytsearch1:${query}`,
        '--flat-playlist',
        '--skip-download',
        '--no-warnings',
        '--dump-single-json',
    ]);

    let parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch {
        throw new Error('Spotify berhasil dibaca, tetapi pencarian sumber publik tidak mengembalikan hasil valid.');
    }

    const entry = parsed?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) {
        throw new Error('Track Spotify ditemukan tetapi sumber audio publik yang cocok tidak tersedia.');
    }

    return {
        sourceUrl: entry.webpage_url || entry.url,
        spotifyTitle: title,
        spotifyArtist: artist,
        thumbnail: data.thumbnail_url || null,
    };
}

async function downloadMp3(ytdlp, sourceUrl, outputDir, baseName, reportProgress) {
    const template = path.join(outputDir, `${baseName}.%(ext)s`);
    await reportProgress('download', '⏳ Sedang mendownload audio...');

    await ytdlp.execPromise([
        sourceUrl,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--restrict-filenames',
        '--newline',
        '--no-warnings',
        '--no-part',
        '--output', template,
        '--max-filesize', `${Number(process.env.BOOMBOX_MAX_FILE_MB || 95)}M`,
        '--ffmpeg-location', String(ffmpegPath),
    ]);

    await reportProgress('convert', '🎚️ Download selesai. Sedang memastikan format MP3...');
    const names = await fs.readdir(outputDir);
    const mp3Name = names.find((name) => name.toLowerCase().endsWith('.mp3'));
    if (!mp3Name) throw new Error('Konversi selesai tetapi file MP3 tidak ditemukan.');
    return path.join(outputDir, mp3Name);
}

export async function ensureConverterReady() {
    if (!ffmpegPath) throw new Error('FFmpeg binary tidak tersedia dari ffmpeg-static.');
    await fs.access(ffmpegPath);
    const binary = await ensureYtDlp();
    await fs.access(binary);
    const ytdlp = await getYtDlp();
    const version = await ytdlp.getVersion();
    return { ffmpeg: ffmpegPath, ytDlp: binary, version: String(version).trim() };
}

export async function convertToBoombox(url, options = {}, reportProgress = async () => {}) {
    const normalizedUrl = normalizeSourceUrl(url);
    const platform = detectBoomboxPlatform(normalizedUrl);
    if (!normalizedUrl || !platform) throw new Error('URL sumber tidak didukung.');

    await reportProgress('prepare', '🔎 Sedang membaca informasi audio...');
    const ytdlp = await getYtDlp();

    let sourceUrl = normalizedUrl;
    let info;
    let spotifyTitle = '';
    let spotifyArtist = '';
    let spotifyThumbnail = null;

    if (platform === 'spotify') {
        const spotify = await resolveSpotify(ytdlp, normalizedUrl);
        sourceUrl = spotify.sourceUrl;
        spotifyTitle = spotify.spotifyTitle;
        spotifyArtist = spotify.spotifyArtist;
        spotifyThumbnail = spotify.thumbnail;
        await reportProgress('prepare', '🔎 Spotify terbaca. Mencari sumber audio publik yang cocok...');
    }

    info = await infoFromYtDlp(ytdlp, sourceUrl);
    const durationSeconds = parseDuration(info);
    const maxDuration = Number(options.maxDurationSeconds || process.env.BOOMBOX_MAX_DURATION_SECONDS || 1200);
    if (!durationSeconds) throw new Error('Durasi audio tidak dapat dibaca.');
    if (durationSeconds > maxDuration) {
        throw new Error(`Durasi terlalu panjang (${Math.ceil(durationSeconds / 60)} menit). Batas ${Math.ceil(maxDuration / 60)} menit.`);
    }

    const title = cleanText(spotifyTitle || info.title, 'SKAW Boombox');
    const artist = cleanText(spotifyArtist || info.artist || info.creator || info.uploader || info.channel, 'Unknown');
    const thumbnail = spotifyThumbnail || info.thumbnail || null;
    const sourceKey = createHash('sha256').update(normalizedUrl).digest('hex');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-'));
    try {
        const filePath = await downloadMp3(ytdlp, sourceUrl, tempDir, title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90), reportProgress);
        const stat = await fs.stat(filePath);
        const maxMb = Number(options.maxFileMb || process.env.BOOMBOX_MAX_FILE_MB || 95);
        if (stat.size > maxMb * 1024 * 1024) {
            throw new Error(`File MP3 melebihi batas ${maxMb} MB.`);
        }

        await reportProgress('upload', '☁️ MP3 siap. Sedang upload ke Top4toP...');
        const directUrl = await uploadMp3ToTop4Top(filePath, `${title}.mp3`);
        await reportProgress('done', '✅ Upload Top4toP berhasil dan direct HTTP MP3 sudah tervalidasi.');

        return {
            sourceUrl: normalizedUrl,
            sourceKey,
            platform,
            title,
            artist,
            durationSeconds,
            thumbnail,
            format: 'MP3',
            url: directUrl,
            sizeBytes: stat.size,
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
