import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { uploadMp3ToTop4Top, probeTop4Top } from './top4topService.js';
import { detectBoomboxPlatform, normalizeSourceUrl, sanitizeFileName } from '../utils/boomboxPlatform.js';

const VERSION = '9.0.0';
const YTDLP_VERSION = String(process.env.BOOMBOX_YTDLP_VERSION || '2026.08.19').trim() || '2026.08.19';
const USER_AGENT = `SKAW-GROUP-Boombox/${VERSION}`;
const MAX_LOG_CHARS = 16_000;
const YTDLP_MIN_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const YTDLP_CACHE_ROOT = 'skaw-group/boombox-v9';
let ytdlpPromise = null;

const ASSETS = Object.freeze({
  linux_glibc_x64: 'yt-dlp_linux',
  linux_musl_x64: 'yt-dlp_musllinux',
  linux_glibc_arm64: 'yt-dlp_linux_aarch64',
  linux_musl_arm64: 'yt-dlp_musllinux_aarch64',
  linux_glibc_arm: 'yt-dlp_linux_armv7l',
  darwin: 'yt-dlp_macos',
  win32: 'yt-dlp.exe',
});

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function detectLibc() {
  if (process.platform !== 'linux') return 'n/a';

  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return 'glibc';
  } catch {}

  const muslCandidates = process.arch === 'x64'
    ? ['/lib/ld-musl-x86_64.so.1', '/usr/lib/ld-musl-x86_64.so.1']
    : process.arch === 'arm64'
      ? ['/lib/ld-musl-aarch64.so.1', '/usr/lib/ld-musl-aarch64.so.1']
      : [];

  for (const candidate of muslCandidates) {
    if (await exists(candidate)) return 'musl';
  }

  try {
    const procFiles = await fs.readdir('/lib');
    if (procFiles.some((name) => /^ld-musl-.+\.so\.1$/i.test(name))) return 'musl';
  } catch {}

  return 'unknown';
}

async function assetCandidates() {
  if (process.platform === 'darwin') return [{ name: ASSETS.darwin, libc: 'n/a' }];
  if (process.platform === 'win32') return [{ name: ASSETS.win32, libc: 'n/a' }];
  if (process.platform !== 'linux') throw new Error(`OS ${process.platform} belum didukung.`);

  const libc = await detectLibc();
  if (process.arch === 'x64') {
    if (libc === 'musl') return [{ name: ASSETS.linux_musl_x64, libc }];
    if (libc === 'glibc') return [{ name: ASSETS.linux_glibc_x64, libc }];
    return [
      { name: ASSETS.linux_musl_x64, libc: 'musl?' },
      { name: ASSETS.linux_glibc_x64, libc: 'glibc?' },
    ];
  }
  if (process.arch === 'arm64') {
    if (libc === 'musl') return [{ name: ASSETS.linux_musl_arm64, libc }];
    if (libc === 'glibc') return [{ name: ASSETS.linux_glibc_arm64, libc }];
    return [
      { name: ASSETS.linux_musl_arm64, libc: 'musl?' },
      { name: ASSETS.linux_glibc_arm64, libc: 'glibc?' },
    ];
  }
  if (process.arch === 'arm') return [{ name: ASSETS.linux_glibc_arm, libc: 'glibc' }];
  throw new Error(`CPU ${process.arch} belum didukung.`);
}

function releaseBase() {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(YTDLP_VERSION)}`;
}

function releaseAssetUrl(name) {
  return `${releaseBase()}/${name}`;
}

async function downloadWithTimeout(url, destination) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    if (!response.ok || !response.body) throw new Error(`Download yt-dlp gagal (HTTP ${response.status}).`);

    const tmp = `${destination}.part-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, 'w');
    let total = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 80 * 1024 * 1024) throw new Error('Download yt-dlp melebihi batas aman 80 MB.');
        await handle.write(Buffer.from(value));
      }
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, destination);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Download yt-dlp timeout.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

async function expectedChecksum(assetName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${releaseBase()}/SHA2-256SUMS`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error(`SHA2-256SUMS yt-dlp gagal (HTTP ${response.status}).`);
    const text = await response.text();
    const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^([0-9a-fA-F]{64})\\s+(?:\\*| )?${escaped}\\s*$`, 'mi'));
    if (!match) throw new Error(`Checksum ${assetName} tidak ditemukan pada yt-dlp ${YTDLP_VERSION}.`);
    return match[1].toLowerCase();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Mengambil checksum yt-dlp timeout.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function assertElf(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (header.toString('hex') !== '7f454c46') throw new Error('Binary yt-dlp bukan ELF Linux standalone.');
  } finally {
    await handle.close();
  }
}

async function assertBinaryFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < YTDLP_MIN_BYTES) {
    throw new Error('Binary yt-dlp tidak valid atau terlalu kecil.');
  }
  if (process.platform === 'linux') await assertElf(filePath);
  await fs.chmod(filePath, 0o755).catch(() => {});
}

function runProcess(command, args, timeoutMs = 120_000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = error?.code ? ` [${error.code}]` : '';
      reject(new Error(`${path.basename(command)} tidak dapat dijalankan${code}. ${error.message}`));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${path.basename(command)} timeout setelah ${Math.ceil(timeoutMs / 1000)} detik.`));
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim();
        reject(new Error(`${path.basename(command)} gagal (code ${code}, signal ${signal || 'none'}). ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function ytdlpRuntimeArgs() {
  return ['--js-runtimes', `node:${process.execPath}`];
}

function commonYtdlpArgs() {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    ...ytdlpRuntimeArgs(),
  ];
  const cookies = String(process.env.BOOMBOX_YTDLP_COOKIES_FILE || '').trim();
  if (cookies) args.push('--cookies', cookies);
  const proxy = String(process.env.BOOMBOX_YTDLP_PROXY || '').trim();
  if (proxy) args.push('--proxy', proxy);
  return args;
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) throw new Error('yt-dlp tidak mengembalikan metadata.');
  try { return JSON.parse(text); } catch {}
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('Output metadata yt-dlp bukan JSON yang valid.');
}

function runtimeDir() {
  const configured = String(process.env.BOOMBOX_RUNTIME_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), YTDLP_CACHE_ROOT);
}

async function cachedBinaryPath(assetName) {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${YTDLP_VERSION}-${assetName}`);
}

async function prepareCandidate(asset) {
  const destination = await cachedBinaryPath(asset.name);
  const sidecar = `${destination}.sha256`;

  if (await exists(destination)) {
    try {
      await assertBinaryFile(destination);
      const recorded = (await fs.readFile(sidecar, 'utf8')).trim().toLowerCase();
      if (recorded) {
        const actual = await sha256File(destination);
        if (recorded === actual) {
          await runProcess(destination, ['--version'], 30_000);
          return { path: destination, asset: asset.name, libc: asset.libc, cached: true };
        }
      }
    } catch {}
  }

  await fs.rm(destination, { force: true }).catch(() => {});
  await fs.rm(sidecar, { force: true }).catch(() => {});
  await downloadWithTimeout(releaseAssetUrl(asset.name), destination);
  await assertBinaryFile(destination);

  const expected = await expectedChecksum(asset.name);
  const actual = await sha256File(destination);
  if (actual !== expected) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw new Error(`Checksum yt-dlp mismatch (${asset.name}).`);
  }

  await fs.writeFile(sidecar, `${actual}\n`);
  await runProcess(destination, ['--version'], 30_000);
  return { path: destination, asset: asset.name, libc: asset.libc, cached: false };
}

async function ensureYtDlp() {
  if (!ytdlpPromise) {
    ytdlpPromise = (async () => {
      const configured = String(process.env.BOOMBOX_YTDLP_PATH || '').trim();
      if (configured) {
        const resolved = path.resolve(configured);
        await assertBinaryFile(resolved);
        await runProcess(resolved, ['--version'], 30_000);
        return { path: resolved, asset: path.basename(resolved), libc: await detectLibc(), cached: false, configured: true };
      }

      const candidates = await assetCandidates();
      const failures = [];
      for (const candidate of candidates) {
        try {
          return await prepareCandidate(candidate);
        } catch (error) {
          failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Tidak dapat menyiapkan yt-dlp. ${failures.join(' | ')}`);
    })().catch((error) => {
      ytdlpPromise = null;
      throw error;
    });
  }
  return ytdlpPromise;
}

async function spotifySearch(ytdlp, spotifyUrl) {
  const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Metadata Spotify gagal (HTTP ${response.status}).`);
  const data = await response.json();
  const title = String(data?.title || '').trim();
  const artist = String(data?.author_name || '').trim();
  if (!title) throw new Error('Spotify tidak memberikan judul track.');

  const query = `ytsearch1:${[title, artist].filter(Boolean).join(' ')}`;
  const { stdout } = await runProcess(ytdlp, [
    query,
    '--flat-playlist',
    '--skip-download',
    '--dump-single-json',
    ...commonYtdlpArgs(),
  ], 90_000);
  const result = parseJsonOutput(stdout);
  const entry = result?.entries?.[0];
  if (!entry?.webpage_url && !entry?.url) {
    throw new Error('Track Spotify ditemukan, tetapi sumber audio publik yang cocok tidak ditemukan.');
  }
  return {
    sourceUrl: entry.webpage_url || entry.url,
    title,
    artist: artist || String(entry.uploader || entry.channel || 'Unknown Artist'),
    thumbnail: data?.thumbnail_url || entry.thumbnail || null,
  };
}

async function readInfo(ytdlp, sourceUrl) {
  const { stdout } = await runProcess(ytdlp, [
    sourceUrl,
    '--skip-download',
    '--dump-single-json',
    ...commonYtdlpArgs(),
  ], 90_000);
  return parseJsonOutput(stdout);
}

async function downloadMp3(ytdlp, sourceUrl, title, outputDir, config, report) {
  await report('download', '⬇️ Mengambil audio dari sumber...');
  const outputTemplate = path.join(outputDir, `${sanitizeFileName(title)}.%(ext)s`);
  const args = [
    sourceUrl,
    ...commonYtdlpArgs(),
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', String(process.env.BOOMBOX_AUDIO_QUALITY || '192K'),
    '--format', 'bestaudio/best',
    '--restrict-filenames',
    '--no-part',
    '--ffmpeg-location', String(ffmpegStatic),
    '--output', outputTemplate,
  ];

  await runProcess(ytdlp, args, 8 * 60_000);
  await report('convert', '🎚️ Audio berhasil diambil. Memeriksa MP3...');

  const names = await fs.readdir(outputDir);
  const mp3s = names.filter((name) => name.toLowerCase().endsWith('.mp3'));
  if (!mp3s.length) throw new Error('yt-dlp selesai tetapi file MP3 tidak ditemukan.');
  mp3s.sort((a, b) => b.localeCompare(a));
  const mp3Path = path.join(outputDir, mp3s[0]);
  const stat = await fs.stat(mp3Path);
  if (!stat.isFile() || stat.size <= 0) throw new Error('File MP3 kosong.');
  if (stat.size > config.maxFileMb * 1024 * 1024) {
    throw new Error(`File MP3 ${ (stat.size / 1024 / 1024).toFixed(1) } MB melebihi batas ${config.maxFileMb} MB.`);
  }
  return { path: mp3Path, sizeBytes: stat.size };
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

export async function ensureConverterReady({ checkTop4Top = false } = {}) {
  if (!Number.isInteger(nodeMajor()) || nodeMajor() < 22) {
    throw new Error(`Node.js ${process.versions.node} terdeteksi. Boombox v9 membutuhkan Node.js 22+ untuk runtime JavaScript yt-dlp.`);
  }
  if (!ffmpegStatic) throw new Error('ffmpeg-static tidak tersedia. Jalankan npm install lalu restart bot.');
  await fs.access(ffmpegStatic);
  await runProcess(ffmpegStatic, ['-version'], 30_000);

  const ytdlp = await ensureYtDlp();
  const version = (await runProcess(ytdlp.path, ['--version'], 30_000)).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || 'unknown';
  const libc = await detectLibc();
  const result = {
    nodeVersion: process.versions.node,
    libc,
    ffmpeg: ffmpegStatic,
    ytDlpVersion: version,
    ytDlpPath: ytdlp.path,
    asset: ytdlp.asset,
    cached: Boolean(ytdlp.cached),
    configuredPath: Boolean(ytdlp.configured),
    versionPin: YTDLP_VERSION,
  };

  if (checkTop4Top) result.top4top = await probeTop4Top();
  return result;
}

export async function convertToBoombox(sourceUrl, config, report = async () => {}) {
  const normalized = normalizeSourceUrl(sourceUrl);
  const platform = detectBoomboxPlatform(normalized);
  if (!normalized || !platform) {
    throw new Error('URL tidak didukung. Gunakan YouTube, TikTok, Spotify, atau SoundCloud.');
  }

  const ytdlp = await ensureYtDlp();
  await report('metadata', '🔎 Membaca judul, artis, dan durasi...');

  let playableUrl = normalized;
  let titleOverride = '';
  let artistOverride = '';
  let thumbnail = null;

  if (platform === 'spotify') {
    const resolved = await spotifySearch(ytdlp.path, normalized);
    playableUrl = resolved.sourceUrl;
    titleOverride = resolved.title;
    artistOverride = resolved.artist;
    thumbnail = resolved.thumbnail;
  }

  const info = await readInfo(ytdlp.path, playableUrl);
  const durationSeconds = Math.round(Number(info?.duration) || 0);
  if (!durationSeconds) throw new Error('Durasi audio tidak dapat dibaca.');
  if (durationSeconds > config.maxDurationSeconds) {
    throw new Error(`Durasi ${Math.ceil(durationSeconds / 60)} menit melebihi maksimum ${Math.ceil(config.maxDurationSeconds / 60)} menit.`);
  }

  const title = String(titleOverride || info.title || 'SKAW Boombox')
    .replace(/[<>]/g, '').trim().slice(0, 180) || 'SKAW Boombox';
  const artist = String(artistOverride || info.artist || info.creator || info.uploader || info.channel || 'Unknown Artist')
    .replace(/[<>]/g, '').trim().slice(0, 180) || 'Unknown Artist';
  thumbnail ||= info.thumbnail || null;

  const sourceKey = createHash('sha256').update(normalized).digest('hex');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skaw-boombox-v9-'));

  try {
    const downloaded = await downloadMp3(
      ytdlp.path,
      playableUrl,
      `${artist} - ${title}`,
      tempDir,
      config,
      report,
    );

    await report('upload', '☁️ MP3 siap. Mengupload ke Top4toP...');
    const directUrl = await uploadMp3ToTop4Top(
      downloaded.path,
      `${sanitizeFileName(`${artist} - ${title}`)}.mp3`,
    );

    await report('done', '✅ Upload selesai. Direct HTTP MP3 sudah divalidasi.');

    return {
      sourceUrl: normalized,
      sourceKey,
      platform,
      title,
      artist,
      durationSeconds,
      thumbnail,
      directUrl,
      sizeBytes: downloaded.sizeBytes,
      ytDlpVersion: YTDLP_VERSION,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function getBoomboxEngineInfo() {
  return {
    version: VERSION,
    ytDlpVersion: YTDLP_VERSION,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}
