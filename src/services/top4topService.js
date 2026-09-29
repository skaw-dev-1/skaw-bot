import fs from 'node:fs';
import FormData from 'form-data';
import axios from 'axios';
import { validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const DEFAULT_UPLOAD_URL = 'https://top4top.io/index.php';

function findMp3Links(html) {
    const source = String(html || '');
    const found = new Set();
    const regex = /https?:\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi;
    for (const match of source.matchAll(regex)) found.add(match[0]);
    return [...found];
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
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 90_000,
        validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Upload Top4toP gagal (HTTP ${response.status}).`);
    }

    const html = String(response.data || '');
    const candidates = findMp3Links(html).filter((candidate) => {
        try {
            const parsed = new URL(candidate);
            const host = parsed.hostname.toLowerCase();
            return host === 'top4top.io' || host.endsWith('.top4top.io');
        } catch {
            return false;
        }
    });

    if (!candidates.length) {
        throw new Error('Top4toP tidak mengembalikan direct MP3 URL Top4toP pada response.');
    }

    const failures = [];
    for (const candidate of candidates) {
        try {
            const httpUrl = new URL(candidate);
            httpUrl.protocol = 'http:';
            const normalized = httpUrl.toString();
            await validateDirectAudioUrl(normalized);
            return normalized;
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
        }
    }

    throw new Error(`Tidak ada direct HTTP MP3 Top4toP yang lolos validasi: ${failures.join(' | ')}`);
}
