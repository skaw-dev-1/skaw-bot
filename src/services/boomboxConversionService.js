import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl, sanitizeFileName } from '../utils/boomboxPlatform.js';

let ytDlpPathPromise = null;

const YTDLP_VERSION = String(process.env.BOOMBOX_YTDLP_VERSION || '').trim();
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

function platformAsset() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    if (process.platform === 'linux') return 'yt-dlp';
    throw new Error(`Platform ${process.platform} tidak didukung untuk yt-dlp.`);
}

function platformLabel() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    return 'linux';
}

function releaseUrl() {
    const suffix = YTDLP_VERSION ? `download/${encodeURIComponent(YTDLP_VERSION)}` : 'latest/download';
    return `https://github.com/yt-dlp/yt-dlp/releases/${suffix}/${platformAsset()}`;
}

async function downloadBinary(url, destination) {
    const response = await fetch(url, {
        redirect: 'follow',
        headers: {
            'User-Agent': 'SKAW-GROUP-Boombox/6.0',
            Accept: 'application/octet-stream',
        },
    });
    if (!response.ok || !response.body) {
        throw new Error(`Gagal mengunduh yt-dlp (${response.status}).`);
    }

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
    if (stat.size < 1_000_000) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error('Binary yt-dlp yang diunduh tampaknya tidak valid.');
    }

    await fs.rename(temp, destination);
    await fs.chmod(destination, 0o755).catch(() => {});
}

async function ensureYtDlp() {
    if (!ytDlpPathPromise) {
        ytDlpPathPromise = (async () => {
            const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
            if (configured) {
                await fs.access(configured);
                return configured;
            }

            const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime');
            await fs.mkdir(runtimeDir, { recursive: true });
            const destination = path.join(runtimeDir, platformAsset());

            try {
                const stat = await fs.stat(destination);
                if (stat.isFile() && stat.size > 1_000_000) return destination;
            } catch {}

            await downloadBinary(releaseUrl(), destination);
            return destination;
        })();
    }
    return await ytDlpPathPromise;
}

function runProcess(command, args, { timeoutMs = 180_000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timeout = setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
        });

        child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            if (killed) {
                reject(new Error(`Proses ${path.basename(command)} timeout.`));
                return;
            }
            if (code !== 0) {
                const detail = (stderr || stdout).trim().slice(-2500);
                reject(new Error(`yt-dlp gagal (code ${code}, signal ${signal || 'none'}). ${detail}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function parseJson(stdout) {
    const text = String(stdout || '').trim();
    try {
        return JSON.parse(text);
    } catch {}

    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        } catch {}
    }
    throw new Error('yt-dlp tidak mengembalikan metadata JSON yang valid.');
}

async function getInfo(ytdlp, url) {
    const { stdout } = await runProcess(ytdlp, [
        url,
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
    ], { timeoutMs: 120_000 });
    return parseJson(stdout);
}

async function resolveSpotify(ytdlp, url) {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'SKAW-GROUP-Boombox/6.0' },
    });
    if (!response.ok) throw new Error(`Metadata Spotify gagal (HTTP ${response.status}).`);

    const data = await response.json();
    const title = String(data.title || '').trim();
    const artist = String(data.author_name || '').trim();
    if (!title) throw new Error('Spotify tidak memberikan judul track.');

    const query = [title, artist].filter(Boolean).join(' ');
    const { stdout } = await runProcess(ytdlp, [
        `ytsearch1:${query}`,
        '--flat-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
    ], { timeoutMs: 120_000 });
    const result = parseJson(stdout);
    const entry = result?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) {
        throw new Error('Track Spotify terbaca, tetapi sumber audio publik yang cocok tidak ditemukan.');
    }

    return {
        sourceUrl: entry.webpage_url || entry.url,
        title,
        artist: artist || String(entry.uploader || entry.channel || '').trim(),
        thumbnail: data.thumbnail_url || entry.thumbnail || null,
    };
}

async function downloadMp3(ytdlp, sourceUrl, outputDir, title, maxMb, report) {
    await report('download', '⬇️ Sedang mendownload audio...');
    const outputTemplate = path.join(outputDir, `${sanitizeFileName(title)}.%(ext)s`);

    await runProcess(ytdlp, [
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
        '--output', outputTemplate,
    ], { timeoutMs: 8 * 60 * 1000 });

    await report('convert', '🎚️ Download selesai. Memastikan file MP3...');
    const files = await fs.readdir(outputDir);
    const mp3 = files.find((name) => name.toLowerCase().endsWith('.mp3'));
    if (!mp3) throw new Error('File MP3 tidak ditemukan setelah conversion.');
    return path.join(outputDir, mp3);
}

export async function ensureConverterReady() {
    if (!ffmpegStatic) {
        throw new Error('ffmpeg-static tidak tersedia. Jalankan npm install ffmpeg-static@5.3.0.');
    }
    await fs.access(ffmpegStatic);

    const ytdlp = await ensureYtDlp();
    const { stdout } = await runProcess(ytdlp, ['--version'], { timeoutMs: 30_000 });
    return {
        ffmpeg: ffmpegStatic,
        ytDlp: String(stdout || '').trim(),
        ytdlpPath: ytdlp,
        platform: platformLabel(),
    };
}

export async function convertToBoombox(sourceUrl, config, report = async () => {}) {
    const normalized = normalizeSourceUrl(sourceUrl);
    const platform = detectBoomboxPlatform(normalized);
    if (!normalized || !platform) {
        throw new Error('URL harus YouTube, TikTok, Spotify, atau SoundCloud.');
    }

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
        throw new Error(`Durasi terlalu panjang (${Math.ceil(durationSeconds / 60)} menit). Maksimal ${Math.ceil(config.maxDurationSeconds / 60)} menit.`);
    }

    const title = String(titleOverride || info.title || 'SKAW Boombox').replace(/[<>]/g, '').trim().slice(0, 180) || 'SKAW Boombox';
    const artist = String(artistOverride || info.artist || info.creator || info.uploader || info.channel || 'Unknown Artist').replace(/[<>]/g, '').trim().slice(0, 180) || 'Unknown Artist';
    thumbnail ||= info.thumbnail || null;
    const sourceKey = createHash('sha256').update(normalized).digest('hex');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-'));
    try {
        const mp3Path = await downloadMp3(ytdlp, playableUrl, tempDir, `${artist} - ${title}`, config.maxFileMb, report);
        const stat = await fs.stat(mp3Path);
        if (stat.size > config.maxFileMb * 1024 * 1024) {
            throw new Error(`File MP3 melebihi batas ${config.maxFileMb} MB.`);
        }

        await report('upload', '☁️ MP3 siap. Sedang upload ke Top4toP...');
        const directUrl = await uploadMp3ToTop4Top(mp3Path, `${sanitizeFileName(`${artist} - ${title}`)}.mp3`);
        await report('done', '✅ Top4toP berhasil. Direct HTTP MP3 sudah divalidasi.');

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
