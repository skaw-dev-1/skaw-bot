import fs from 'node:fs';
import FormData from 'form-data';
import axios from 'axios';
import { normalizeHttpBoomboxUrl, validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const UPLOAD_URL = process.env.TOP4TOP_UPLOAD_URL || 'https://top4top.io/index.php';

function extractMp3Candidates(html) {
    const source = String(html || '');
    const found = new Set();
    const patterns = [
        /https?:\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi,
        /href\s*=\s*["']([^"']+\.mp3(?:\?[^"']*)?)["']/gi,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const value = match[1] || match[0];
            if (value) found.add(String(value).replace(/&amp;/gi, '&').replace(/[),.;!?]+$/g, ''));
        }
    }
    return [...found];
}

function isTop4TopHost(input) {
    try {
        const host = new URL(input).hostname.toLowerCase();
        return host === 'top4top.io' || host.endsWith('.top4top.io');
    } catch {
        return false;
    }
}

export async function uploadMp3ToTop4Top(filePath, fileName) {
    const form = new FormData();
    form.append('file_1_', fs.createReadStream(filePath), { filename: fileName, contentType: 'audio/mpeg' });
    form.append('submitr', 'UpLoad');

    const response = await axios.post(UPLOAD_URL, form, {
        headers: { ...form.getHeaders(), 'User-Agent': 'SKAW-GROUP-Boombox/4.0' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Top4toP upload gagal (HTTP ${response.status}).`);
    }

    const candidates = extractMp3Candidates(response.data)
        .filter(isTop4TopHost)
        .map(normalizeHttpBoomboxUrl)
        .filter(Boolean);

    if (!candidates.length) {
        throw new Error('Top4toP tidak mengembalikan direct MP3 URL.');
    }

    let lastError = null;
    for (const candidate of candidates) {
        try {
            await validateDirectAudioUrl(candidate);
            return candidate;
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Tidak ada URL Top4toP yang lolos validasi HTTP direct. ${lastError?.message || ''}`.trim());
}
