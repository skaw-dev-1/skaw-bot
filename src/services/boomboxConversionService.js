import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import axios from 'axios';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';
import { detectBoomboxPlatform, sanitizeBoomboxFileName } from '../utils/boomboxUrl.js';
import { getBoomboxCache, setBoomboxCache } from './boomboxStorageService.js';
import { uploadToTop4Top } from './top4topService.js';

const MAX_DURATION_SECONDS = 20 * 60;
const MAX_FILE_MB = 95;

function assertDuration(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return;
    if (Number(seconds) > MAX_DURATION_SECONDS) {
        throw new Error(`Audio is too long. Maximum allowed duration is ${Math.floor(MAX_DURATION_SECONDS / 60)} minutes.`);
    }
}

function metadataFromInfo(info, platform) {
    const title = String(info?.track || info?.title || 'Unknown Title').trim();
    const artist = String(info?.artist || info?.uploader || info?.creator || 'Unknown Artist').trim();
    const durationSeconds = info?.duration == null ? null : Math.round(Number(info.duration));
    assertDuration(durationSeconds);
    return { title, artist, durationSeconds, platform };
}

async function getYtDlpInfo(url) {
    return youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        skipDownload: true,
        noCheckCertificates: true,
    });
}

async function downloadAudio(url, outputDir, baseName) {
    const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);
    await youtubedl(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: '192K',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        output: outputTemplate,
        ffmpegLocation: ffmpegPath || undefined,
        restrictFilenames: true,
        maxFilesize: `${MAX_FILE_MB}M`,
    });

    const expected = path.join(outputDir, `${baseName}.mp3`);
    try {
        await fs.access(expected);
        return expected;
    } catch {
        const files = await fs.readdir(outputDir);
        const match = files.find((file) => file.toLowerCase().endsWith('.mp3'));
        if (!match) throw new Error('Audio conversion completed but no MP3 file was produced.');
        return path.join(outputDir, match);
    }
}

async function spotifyMetadata(url) {
    const response = await axios.get('https://open.spotify.com/oembed', {
        params: { url },
        timeout: 15000,
        headers: { 'User-Agent': 'SKAW-GROUP-TitanBot-Boombox/1.0' },
    });

    const rawTitle = String(response.data?.title || '').trim();
    if (!rawTitle) throw new Error('Could not read Spotify track metadata.');

    return rawTitle;
}

async function spotifyToMatchedYoutube(url) {
    const title = await spotifyMetadata(url);
    const searchInfo = await getYtDlpInfo(`ytsearch1:${title}`);
    const entry = searchInfo?.entries?.[0];
    if (!entry?.webpage_url) {
        throw new Error('Could not find a matching playable source for this Spotify track.');
    }

    return {
        sourceUrl: entry.webpage_url,
        metadata: {
            title,
            artist: String(entry.artist || entry.uploader || 'Spotify match').trim(),
            durationSeconds: entry.duration == null ? null : Math.round(Number(entry.duration)),
            platform: 'spotify',
        },
        matchedSource: true,
    };
}

export async function convertBoomboxUrl(client, guildId, rawUrl) {
    const detected = detectBoomboxPlatform(rawUrl);
    if (!detected) {
        throw new Error('Unsupported URL. Only YouTube, TikTok, Spotify, and SoundCloud are supported.');
    }

    const sourceUrl = detected.url;
    const cacheKey = crypto.createHash('sha256').update(sourceUrl).digest('hex');
    const cached = await getBoomboxCache(client, guildId, cacheKey);
    if (cached) return { ...cached, cached: true };

    const tempDir = path.join(os.tmpdir(), `skaw-boombox-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
        let extractionUrl = sourceUrl;
        let metadata;
        let matchedSource = false;

        if (detected.platform === 'spotify') {
            const spotifyResult = await spotifyToMatchedYoutube(sourceUrl);
            extractionUrl = spotifyResult.sourceUrl;
            metadata = spotifyResult.metadata;
            matchedSource = spotifyResult.matchedSource;
            assertDuration(metadata.durationSeconds);
        } else {
            const info = await getYtDlpInfo(sourceUrl);
            metadata = metadataFromInfo(info, detected.platform);
        }

        const baseName = sanitizeBoomboxFileName(`${metadata.artist} - ${metadata.title}`)
            .replace(/[^a-zA-Z0-9 _-]/g, '') || 'skaw-audio';
        const filePath = await downloadAudio(extractionUrl, tempDir, baseName);
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_MB * 1024 * 1024) {
            throw new Error(`Converted MP3 is larger than ${MAX_FILE_MB} MB.`);
        }

        const top4topUrl = await uploadToTop4Top(filePath, `${baseName}.mp3`);
        const cachedItem = await setBoomboxCache(client, guildId, cacheKey, {
            sourceUrl,
            platform: detected.platform,
            title: metadata.title,
            artist: metadata.artist,
            durationSeconds: metadata.durationSeconds,
            top4topUrl,
        });

        return { ...cachedItem, cached: false, matchedSource };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
    }
}

export function getBoomboxLimits() {
    return { maxDurationSeconds: MAX_DURATION_SECONDS, maxFileMb: MAX_FILE_MB };
}
