import fs from 'node:fs';
import FormData from 'form-data';
import axios from 'axios';
import { normalizeHttpBoomboxUrl, validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const DEFAULT_UPLOAD_URL = 'https://top4top.io/index.php';

function extractCandidateUrls(html) {
    const source = String(html || '');
    const found = new Set();
    const patterns = [
        /https?:\\/\\/[^\"'<>\s]+/gi,
        /https?:\/\/[^\"'<>\s]+/gi,
        /href\\s*=\\s*[\"']([^\"']+)[\"']/gi,
        /href\s*=\s*[\"']([^\"']+)[\"']/gi,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const value = match[1] || match[0];
            if (String(value).toLowerCase().includes('.mp3')) {
                const cleaned = String(value)
                    .replace(/\\u0026/g, '&')
                    .replace(/&amp;/gi, '&')
                    .replace(/[\"'<>\]\[),.;!?]+$/g, '');
                found.add(cleaned);
            }
        }
    }
    return [...found];
}

function hostAllowed(input) {
    try {
        const url = new URL(input);
        return /(^|\.)top4top\.io$/i.test(url.hostname);
    } catch {
        return false;
    }
}

export async function uploadMp3ToTop4Top(filePath, originalName = 'skaw-boombox.mp3') {
    const uploadUrl = process.env.TOP4TOP_UPLOAD_URL || DEFAULT_UPLOAD_URL;
    const form = new FormData();
    form.append('file_1_', fs.createReadStream(filePath), {
        filename: originalName,
        contentType: 'audio/mpeg',
    });
    form.append('submitr', 'UpLoad');

    const response = await axios.post(uploadUrl, form, {
        headers: form.getHeaders({ 'User-Agent': 'SKAW-Boombox/3.0' }),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Upload Top4toP gagal (HTTP ${response.status}).`);
    }

    const candidates = extractCandidateUrls(response.data)
        .filter(hostAllowed)
        .map(normalizeHttpBoomboxUrl)
        .filter(Boolean);

    if (!candidates.length) {
        throw new Error('Top4toP tidak mengembalikan direct MP3 URL yang bisa dipakai.');
    }

    const errors = [];
    for (const candidate of candidates) {
        try {
            await validateDirectAudioUrl(candidate);
            return candidate;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }

    throw new Error(`Direct HTTP MP3 Top4toP tidak lolos validasi. ${errors.slice(0, 2).join(' | ')}`);
}
