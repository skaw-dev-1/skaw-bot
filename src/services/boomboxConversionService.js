import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform } from '../utils/boomboxPlatform.js';

let YTDlpWrapClass = null;
let ytDlpBinaryPath = null;
let ytDlpInstancePromise = null;

function cleanName(value) {
    return String(value || 'SKAW-Boombox')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90) || 'SKAW-Boombox';
}

function platformBinaryName() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    return 'yt-dlp';
}

function ytPlatform() {
    if (process.platform === 'win32') return 'win32';
    if (process.platform === 'darwin') return 'darwin';
    return 'linux';
}

async function loadYtDlp() {
    if (!YTDlpWrapClass) {
        const module = await import('yt-dlp-wrap-plus');
        YTDlpWrapClass = module.default ?? module;
    }

    if (!ytDlpBinaryPath) {
        const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime');
        await fs.mkdir(runtimeDir, { recursive: true });
        ytDlpBinaryPath = path.join(runtimeDir, platformBinaryName());
    }

    try {
        const stat = await fs.stat(ytDlpBinaryPath);
        if (!stat.isFile() || stat.size < 1_000_000) throw new Error('yt-dlp binary invalid');
    } catch {
        const version = process.env.BOOMBOX_YTDLP_VERSION || '';
        await YTDlpWrapClass.downloadFromGithub(ytDlpBinaryPath, version, ytPlatform(), true);
        await fs.chmod(ytDlpBinaryPath, 0o755).catch(() => {});
    }

    if (!ytDlpInstancePromise) {
        ytDlpInstancePromise = Promise.resolve(new YTDlpWrapClass(ytDlpBinaryPath));
    }

    return await ytDlpInstancePromise;
}

function normalizeInfo(info) {
    const durationSeconds = Number(info?.duration || 0);
    const title = cleanName(info?.title || info?.track || 'SKAW Boombox');
    const artist = cleanName(info?.artist || info?.creator || info?.uploader || info?.channel || 'Unknown');
    return { title, artist, durationSeconds };
}

async function getInfo(ytdlp, url) {
    const info = await ytdlp.getVideoInfo(url);
    return info;
}

async function spotifyResolve(ytdlp, url) {
    const oembed = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if (!oembed.ok) throw new Error(`Spotify metadata gagal (HTTP ${oembed.status}).`);
    const data = await oembed.json();
    const title = String(data.title || '').trim();
    if (!title) throw new Error('Spotify tidak memberikan judul track.');

    const search = await ytdlp.execPromise([
        `ytsearch1:${title}`,
        '--flat-playlist',
        '--skip-download',
        '--no-warnings',
        '--dump-single-json',
    ]);

    const parsed = JSON.parse(String(search));
    const entry = parsed?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) {
        throw new Error('Track Spotify berhasil dibaca, tetapi tidak ditemukan sumber publik yang cocok.');
    }

    return {
        sourceUrl: entry.webpage_url || entry.url,
        spotifyTitle: title,
    };
}

async function downloadMp3(ytdlp, sourceUrl, outputDir, title) {
    const template = path.join(outputDir, `${cleanName(title)}.%(ext)s`);
    await ytdlp.execPromise([
        sourceUrl,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--restrict-filenames',
        '--newline',
        '--no-warnings',
        '--max-filesize', `${Number(process.env.BOOMBOX_MAX_FILE_MB || 95)}M`,
        '--ffmpeg-location', String(ffmpegPath),
        '--output', template,
    ]);

    const files = await fs.readdir(outputDir);
    const mp3 = files.find((name) => name.toLowerCase().endsWith('.mp3'));
    if (!mp3) throw new Error('yt-dlp selesai tetapi file MP3 tidak ditemukan.');
    return path.join(outputDir, mp3);
}

export async function convertToBoombox(url, options = {}) {
    const platform = detectBoomboxPlatform(url);
    if (!platform) throw new Error('URL bukan platform yang didukung.');

    const ytdlp = await loadYtDlp();
    const maxDuration = Number(options.maxDurationSeconds || process.env.BOOMBOX_MAX_DURATION_SECONDS || 1200);

    let sourceUrl = url;
    let info = await getInfo(ytdlp, url);

    if (platform === 'spotify') {
        const resolved = await spotifyResolve(ytdlp, url);
        sourceUrl = resolved.sourceUrl;
        info = await getInfo(ytdlp, sourceUrl);
        info.title = resolved.spotifyTitle || info.title;
    }

    const meta = normalizeInfo(info);
    if (!meta.durationSeconds || meta.durationSeconds > maxDuration) {
        throw new Error(`Durasi ${meta.durationSeconds ? `${Math.ceil(meta.durationSeconds / 60)} menit` : 'tidak diketahui'} melewati batas ${Math.ceil(maxDuration / 60)} menit.`);
    }

    const sourceKey = createHash('sha256').update(url).digest('hex');
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-'));

    try {
        const filePath = await downloadMp3(ytdlp, sourceUrl, tmpRoot, meta.title);
        const stat = await fs.stat(filePath);
        const maxBytes = Number(options.maxFileMb || process.env.BOOMBOX_MAX_FILE_MB || 95) * 1024 * 1024;
        if (stat.size > maxBytes) throw new Error(`File MP3 melebihi batas ${maxBytes / 1024 / 1024} MB.`);

        const directUrl = await uploadMp3ToTop4Top(filePath, `${meta.title}.mp3`);
        return {
            sourceKey,
            platform,
            title: meta.title,
            artist: meta.artist,
            durationSeconds: meta.durationSeconds,
            format: 'MP3',
            url: directUrl,
            sizeBytes: stat.size,
        };
    } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
}
