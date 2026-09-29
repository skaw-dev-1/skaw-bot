import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { uploadMp3ToTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl, sanitizeFileName } from '../utils/boomboxPlatform.js';

const YTDLP_VERSION = String(process.env.BOOMBOX_YTDLP_VERSION || '2026.08.19').trim() || '2026.08.19';
const USER_AGENT = 'SKAW-GROUP-Boombox/8.0';
const MAX_LOG_CHARS = 12_000;
const YTDLP_MIN_BYTES = 30 * 1024 * 1024;
let ytdlpPromise;

const ASSETS = Object.freeze({
    linux_x64: { name: 'yt-dlp_linux' },
    linux_arm64: { name: 'yt-dlp_linux_aarch64' },
    linux_arm: { name: 'yt-dlp_linux_armv7l' },
    darwin: { name: 'yt-dlp_macos' },
    win32: { name: 'yt-dlp.exe' },
});

function assetInfo() {
    if (process.platform === 'linux') {
        if (process.arch === 'x64') return ASSETS.linux_x64;
        if (process.arch === 'arm64') return ASSETS.linux_arm64;
        if (process.arch === 'arm') return ASSETS.linux_arm;
    }
    if (process.platform === 'darwin') return ASSETS.darwin;
    if (process.platform === 'win32') return ASSETS.win32;
    throw new Error(`OS/CPU ${process.platform}/${process.arch} belum didukung.`);
}

function releaseBase() {
    return `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(YTDLP_VERSION)}`;
}

function releaseAssetUrl() {
    return `${releaseBase()}/${assetInfo().name}`;
}

function normalizeVersionOutput(output) {
    return String(output || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || 'unknown';
}

async function streamDownload(url, destination) {
    const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
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

    await fs.rename(temp, destination);
}

async function sha256File(filePath) {
    const hash = createHash('sha256');
    const file = await fs.open(filePath, 'r');
    try {
        const stream = file.createReadStream();
        for await (const chunk of stream) hash.update(chunk);
    } finally {
        await file.close().catch(() => {});
    }
    return hash.digest('hex');
}

async function expectedChecksum() {
    const sumsUrl = `${releaseBase()}/SHA2-256SUMS`;
    const response = await fetch(sumsUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error(`SHA2-256SUMS yt-dlp gagal diambil (HTTP ${response.status}).`);
    const text = await response.text();
    const target = assetInfo().name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^([0-9a-fA-F]{64})\\s+(?:\\*| )?${target}\\s*$`, 'mi');
    const match = text.match(regex);
    if (!match) throw new Error(`Checksum ${assetInfo().name} tidak ditemukan untuk yt-dlp ${YTDLP_VERSION}.`);
    return match[1].toLowerCase();
}

async function assertBinary(filePath) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < YTDLP_MIN_BYTES) throw new Error('Binary yt-dlp yang tersimpan terlalu kecil/tidak valid.');

    if (process.platform === 'linux') {
        const handle = await fs.open(filePath, 'r');
        const header = Buffer.alloc(4);
        try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
        if (header.toString('hex') !== '7f454c46') throw new Error('Binary yt-dlp bukan ELF Linux standalone.');
    }
}

function run(command, args, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        const collect = (value, chunk) => {
            const next = value + chunk.toString();
            return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
        };

        child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`${path.basename(command)} timeout.`));
            if (code !== 0) {
                const detail = (stderr || stdout).trim();
                return reject(new Error(`${path.basename(command)} gagal (code ${code}, signal ${signal || 'none'}). ${detail}`));
            }
            resolve({ stdout, stderr });
        });
    });
}

async function ensureYtDlp() {
    if (!ytdlpPromise) {
        ytdlpPromise = (async () => {
            const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
            if (configured) {
                const resolved = path.resolve(configured);
                await assertBinary(resolved);
                return resolved;
            }

            const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
            const runtimeDir = path.join(root, '.runtime', 'boombox');
            await fs.mkdir(runtimeDir, { recursive: true });
            const destination = path.join(runtimeDir, assetInfo().name);

            let valid = false;
            try {
                await assertBinary(destination);
                const expected = await expectedChecksum();
                valid = (await sha256File(destination)) === expected;
            } catch {
                valid = false;
            }

            if (!valid) {
                await fs.rm(destination, { force: true }).catch(() => {});
                await streamDownload(releaseAssetUrl(), destination);
                await fs.chmod(destination, 0o755).catch(() => {});
                await assertBinary(destination);
                const expected = await expectedChecksum();
                const actual = await sha256File(destination);
                if (actual !== expected) {
                    await fs.rm(destination, { force: true }).catch(() => {});
                    throw new Error(`Checksum yt-dlp mismatch. Expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}….`);
                }
            }

            await fs.chmod(destination, 0o755).catch(() => {});
            return destination;
        })().catch((error) => {
            ytdlpPromise = null;
            throw error;
        });
    }
    return await ytdlpPromise;
}

function metadataArgs(url) {
    return [
        url,
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
        '--js-runtimes', `node:${process.execPath}`,
    ];
}

function parseJson(output) {
    const text = String(output || '').trim();
    try { return JSON.parse(text); } catch {}
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { return JSON.parse(lines[i]); } catch {}
    }
    throw new Error('yt-dlp tidak mengembalikan JSON metadata yang valid.');
}

async function getInfo(ytdlp, url) {
    const { stdout } = await run(ytdlp, metadataArgs(url), 90_000);
    return parseJson(stdout);
}

async function resolveSpotify(ytdlp, spotifyUrl) {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Spotify metadata gagal (HTTP ${response.status}).`);
    const data = await response.json();
    const title = String(data?.title || '').trim();
    const artist = String(data?.author_name || '').trim();
    if (!title) throw new Error('Spotify tidak memberikan judul track.');

    const searchQuery = `ytsearch1:${[title, artist].filter(Boolean).join(' ')}`;
    const { stdout } = await run(ytdlp, [
        searchQuery,
        '--flat-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--no-progress',
        '--js-runtimes', `node:${process.execPath}`,
    ], 90_000);
    const result = parseJson(stdout);
    const entry = result?.entries?.[0];
    if (!entry?.webpage_url && !entry?.url) throw new Error('Track Spotify ditemukan tetapi sumber audio yang cocok tidak tersedia.');

    return {
        sourceUrl: entry.webpage_url || entry.url,
        title,
        artist: artist || String(entry.uploader || entry.channel || 'Unknown Artist'),
        thumbnail: data?.thumbnail_url || entry.thumbnail || null,
    };
}

async function downloadMp3(ytdlp, sourceUrl, title, outputDir, config, report) {
    await report('download', '⬇️ Sedang mendownload audio...');
    const template = path.join(outputDir, `${sanitizeFileName(title)}.%(ext)s`);

    await run(ytdlp, [
        sourceUrl,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--format', 'bestaudio/best',
        '--no-warnings',
        '--no-progress',
        '--restrict-filenames',
        '--no-part',
        '--max-filesize', `${config.maxFileMb}M`,
        '--ffmpeg-location', String(ffmpegStatic),
        '--js-runtimes', `node:${process.execPath}`,
        '--output', template,
    ], 8 * 60_000);

    await report('convert', '🎚️ Audio selesai di-download. Memastikan MP3...');
    const names = await fs.readdir(outputDir);
    const candidates = names.filter((value) => value.toLowerCase().endsWith('.mp3'));
    if (!candidates.length) throw new Error('Konversi selesai tetapi file MP3 tidak ditemukan.');
    candidates.sort((a, b) => b.localeCompare(a));
    return path.join(outputDir, candidates[0]);
}

export async function ensureConverterReady() {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
        throw new Error(`Node.js ${process.versions.node} terdeteksi. Boombox v8 membutuhkan Node.js 22+ untuk JavaScript runtime yt-dlp.`);
    }
    if (!ffmpegStatic) throw new Error('ffmpeg-static tidak tersedia.');
    await fs.access(ffmpegStatic);
    await run(ffmpegStatic, ['-version'], 30_000);
    const ytdlp = await ensureYtDlp();
    const { stdout } = await run(ytdlp, ['--version'], 30_000);
    return {
        ffmpeg: ffmpegStatic,
        ytDlpVersion: normalizeVersionOutput(stdout),
        ytDlpPath: ytdlp,
        asset: assetInfo().name,
        nodeVersion: process.versions.node,
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

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-v8-'));
    try {
        const mp3Path = await downloadMp3(ytdlp, playableUrl, `${artist} - ${title}`, tempDir, config, report);
        const stat = await fs.stat(mp3Path);
        if (stat.size <= 0) throw new Error('File MP3 kosong.');
        if (stat.size > config.maxFileMb * 1024 * 1024) throw new Error(`File MP3 melebihi batas ${config.maxFileMb} MB.`);

        await report('upload', '☁️ MP3 siap. Sedang upload ke Top4toP...');
        const directUrl = await uploadMp3ToTop4Top(mp3Path, `${sanitizeFileName(`${artist} - ${title}`)}.mp3`);
        await report('done', '✅ Upload Top4toP berhasil dan direct HTTP MP3 tervalidasi.');

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
            ytDlpVersion: YTDLP_VERSION,
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
