import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl, sanitizeFileName } from '../utils/boomboxPlatform.js';

let ytDlpPromise = null;
const MAX_LOG_BYTES = 12 * 1024 * 1024;

function getPlatformAsset() {
    if (process.platform === 'linux') {
        if (process.arch === 'x64' || process.arch === 'amd64') return 'yt-dlp_linux';
        if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
        if (process.arch === 'arm') return 'yt-dlp_linux_armv7l';
    }
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    if (process.platform === 'win32') return 'yt-dlp.exe';
    throw new Error(`OS/CPU ${process.platform}/${process.arch} belum didukung.`);
}

function getReleaseUrl() {
    const requested = String(process.env.BOOMBOX_YTDLP_VERSION || '').trim();
    const pathPart = requested ? `download/${encodeURIComponent(requested)}` : 'latest/download';
    return `https://github.com/yt-dlp/yt-dlp/releases/${pathPart}/${getPlatformAsset()}`;
}

async function downloadFile(url, destination) {
    const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'SKAW-GROUP-Boombox/7.0' },
    });
    if (!response.ok || !response.body) throw new Error(`Download yt-dlp gagal (HTTP ${response.status}).`);

    const temp = `${destination}.part-${process.pid}-${Date.now()}`;
    const handle = await fs.open(temp, 'w');
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await handle.write(Buffer.from(value));
        }
    } finally {
        await handle.close();
    }

    const stat = await fs.stat(temp);
    if (stat.size < 10 * 1024 * 1024) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error('Binary yt-dlp yang diterima terlalu kecil/tidak valid. Pastikan asset standalone dipakai.');
    }

    const probe = await fs.open(temp, 'r');
    const header = Buffer.alloc(4);
    await probe.read(header, 0, 4, 0);
    await probe.close();
    if (process.platform === 'linux' && header.toString('hex') !== '7f454c46') {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error('Asset yt-dlp yang diunduh bukan Linux standalone ELF.');
    }

    await fs.rename(temp, destination);
    await fs.chmod(destination, 0o755).catch(() => {});
}

async function ensureYtDlp() {
    if (!ytDlpPromise) {
        ytDlpPromise = (async () => {
            const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
            if (configured) {
                await fs.access(configured);
                return configured;
            }

            const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime');
            await fs.mkdir(runtimeDir, { recursive: true });
            const asset = getPlatformAsset();
            const destination = path.join(runtimeDir, asset);

            try {
                const stat = await fs.stat(destination);
                const probe = await fs.open(destination, 'r');
                const header = Buffer.alloc(4);
                await probe.read(header, 0, 4, 0);
                await probe.close();
                const validHeader = process.platform === 'linux'
                    ? header.toString('hex') === '7f454c46'
                    : stat.size > 10 * 1024 * 1024;
                if (stat.isFile() && stat.size > 10 * 1024 * 1024 && validHeader) return destination;
            } catch {}

            // Remove old v4/v5 wrong asset if it exists; v7 intentionally uses standalone binary.
            await fs.rm(path.join(runtimeDir, process.platform === 'linux' ? 'yt-dlp' : 'yt-dlp_old'), { force: true }).catch(() => {});
            await downloadFile(getReleaseUrl(), destination);
            return destination;
        })();
    }
    return await ytDlpPromise;
}

function run(command, args, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        const collect = (target, chunk) => {
            const value = target + chunk.toString();
            return value.length > MAX_LOG_BYTES ? value.slice(-MAX_LOG_BYTES) : value;
        };
        child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`${path.basename(command)} timeout.`));
            if (code !== 0) {
                const detail = (stderr || stdout).trim().slice(-3000);
                return reject(new Error(`${path.basename(command)} gagal (code ${code}, signal ${signal || 'none'}). ${detail}`));
            }
            resolve({ stdout, stderr });
        });
    });
}

function parseJson(stdout) {
    const text = String(stdout || '').trim();
    try { return JSON.parse(text); } catch {}
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { return JSON.parse(lines[i]); } catch {}
    }
    throw new Error('yt-dlp tidak mengembalikan JSON metadata yang valid.');
}

async function getInfo(ytdlp, url) {
    const { stdout } = await run(ytdlp, [
        url,
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
    ], 90_000);
    return parseJson(stdout);
}

async function resolveSpotify(ytdlp, url) {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'SKAW-GROUP-Boombox/7.0' },
    });
    if (!response.ok) throw new Error(`Spotify metadata gagal (HTTP ${response.status}).`);
    const data = await response.json();
    const title = String(data.title || '').trim();
    const artist = String(data.author_name || '').trim();
    if (!title) throw new Error('Spotify tidak memberikan judul track.');

    const { stdout } = await run(ytdlp, [
        `ytsearch1:${[title, artist].filter(Boolean).join(' ')}`,
        '--flat-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
    ], 90_000);
    const result = parseJson(stdout);
    const entry = result?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) throw new Error('Tidak menemukan sumber audio publik yang cocok untuk track Spotify.');

    return {
        sourceUrl: entry.webpage_url || entry.url,
        title,
        artist: artist || String(entry.uploader || entry.channel || 'Unknown').trim(),
        thumbnail: data.thumbnail_url || entry.thumbnail || null,
    };
}

async function downloadMp3(ytdlp, sourceUrl, title, outputDir, maxMb, report) {
    await report('download', '⬇️ Sedang mendownload audio...');
    const template = path.join(outputDir, `${sanitizeFileName(title)}.%(ext)s`);

    await run(ytdlp, [
        sourceUrl,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--no-warnings',
        '--no-progress',
        '--restrict-filenames',
        '--no-part',
        '--max-filesize', `${maxMb}M`,
        '--ffmpeg-location', String(ffmpegStatic),
        '--output', template,
    ], 8 * 60_000);

    await report('convert', '🎚️ Audio selesai di-download. Memastikan MP3...');
    const names = await fs.readdir(outputDir);
    const name = names.find((value) => value.toLowerCase().endsWith('.mp3'));
    if (!name) throw new Error('Konversi selesai tetapi file MP3 tidak ditemukan.');
    return path.join(outputDir, name);
}

export async function ensureConverterReady() {
    if (!ffmpegStatic) throw new Error('ffmpeg-static tidak tersedia.');
    await fs.access(ffmpegStatic);
    await run(ffmpegStatic, ['-version'], 30_000);

    const ytdlp = await ensureYtDlp();
    const { stdout } = await run(ytdlp, ['--version'], 30_000);
    return {
        ffmpeg: ffmpegStatic,
        ytDlpVersion: stdout.trim(),
        ytDlpPath: ytdlp,
        asset: getPlatformAsset(),
    };
}

export async function convertToBoombox(sourceUrl, config, report = async () => {}) {
    const normalized = normalizeSourceUrl(sourceUrl);
    const platform = detectBoomboxPlatform(normalized);
    if (!normalized || !platform) throw new Error('URL harus YouTube, TikTok, Spotify, atau SoundCloud.');

    await report('prepare', '🔎 Sedang membaca informasi audio...');
    const ytdlp = await ensureYtDlp();

    let playableUrl = normalized;
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

    const info = await getInfo(ytdlp, playableUrl);
    const durationSeconds = Math.round(Number(info?.duration) || 0);
    if (!durationSeconds) throw new Error('Durasi audio tidak dapat dibaca.');
    if (durationSeconds > config.maxDurationSeconds) {
        throw new Error(`Durasi terlalu panjang (${Math.ceil(durationSeconds / 60)} menit). Maksimum ${Math.ceil(config.maxDurationSeconds / 60)} menit.`);
    }

    const title = String(titleOverride || info.title || 'SKAW Boombox').replace(/[<>]/g, '').trim().slice(0, 180) || 'SKAW Boombox';
    const artist = String(artistOverride || info.artist || info.creator || info.uploader || info.channel || 'Unknown Artist').replace(/[<>]/g, '').trim().slice(0, 180) || 'Unknown Artist';
    thumbnail ||= info.thumbnail || null;
    const sourceKey = createHash('sha256').update(normalized).digest('hex');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-v7-'));
    try {
        const mp3Path = await downloadMp3(ytdlp, playableUrl, `${artist} - ${title}`, tempDir, config.maxFileMb, report);
        const stat = await fs.stat(mp3Path);
        if (stat.size > config.maxFileMb * 1024 * 1024) throw new Error(`File MP3 melebihi batas ${config.maxFileMb} MB.`);

        await report('upload', '☁️ MP3 siap. Sedang upload ke Top4toP...');
        const directUrl = await uploadMp3ToTop4Top(mp3Path, `${sanitizeFileName(`${artist} - ${title}`)}.mp3`);
        await report('done', '✅ Top4toP berhasil. Direct HTTP MP3 tervalidasi.');

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
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
