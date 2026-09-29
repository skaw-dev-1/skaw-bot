import fs from 'node:fs/promises';
import { normalizeHttpBoomboxUrl, validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const HOME_URL = 'https://top4top.io/';
const DEFAULT_FILE_FIELD = 'file_1_';

function absoluteUrl(value) {
    try { return new URL(value || '/index.php', HOME_URL).toString(); } catch { return HOME_URL; }
}

function extractHiddenInputs(html) {
    const fields = [];
    for (const match of String(html || '').matchAll(/<input\b[^>]*type\s*=\s*["']hidden["'][^>]*>/gi)) {
        const tag = match[0];
        const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
        const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] || '';
        if (name) fields.push([name, value]);
    }
    return fields;
}

function discoverUploadForm(html) {
    const source = String(html || '');
    const forms = [...source.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)];
    const uploadForm = forms.find((match) => /type\s*=\s*["']file["']/i.test(match[0]))?.[0] || source;
    const formTag = uploadForm.match(/<form\b[^>]*>/i)?.[0] || '';
    const action = formTag.match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1] || '/index.php';
    const fileTag = uploadForm.match(/<input\b[^>]*type\s*=\s*["']file["'][^>]*>/i)?.[0] || '';
    const fieldName = fileTag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1] || DEFAULT_FILE_FIELD;
    return { action: absoluteUrl(action), fieldName, hidden: extractHiddenInputs(uploadForm) };
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x2F;/gi, '/')
        .replace(/&#47;/gi, '/');
}

function extractMp3Candidates(html) {
    const source = decodeHtml(html);
    const found = new Set();
    const patterns = [
        /https?:\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi,
        /href\s*=\s*["']([^"']+\.mp3(?:\?[^"']*)?)["']/gi,
        /(?:https?:)?\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            let value = match[1] || match[0];
            if (value.startsWith('//')) value = `http:${value}`;
            value = value.replace(/[),.;!?]+$/g, '');
            if (/top4top\.io/i.test(value) && /\.mp3(?:$|[?#])/i.test(value)) found.add(value);
        }
    }
    return [...found];
}

export async function uploadMp3ToTop4Top(filePath, fileName = 'skaw-boombox.mp3') {
    const pageResponse = await fetch(HOME_URL, { headers: { 'User-Agent': 'SKAW-GROUP-Boombox/7.0' } });
    if (!pageResponse.ok) throw new Error(`Top4toP tidak bisa diakses (HTTP ${pageResponse.status}).`);
    const html = await pageResponse.text();
    const formInfo = discoverUploadForm(html);

    const form = new FormData();
    for (const [name, value] of formInfo.hidden) form.append(name, value);
    form.append('submitr', 'UpLoad');
    form.append(formInfo.fieldName, new Blob([await fs.readFile(filePath)], { type: 'audio/mpeg' }), fileName);

    const response = await fetch(formInfo.action, {
        method: 'POST',
        body: form,
        redirect: 'follow',
        headers: {
            'User-Agent': 'SKAW-GROUP-Boombox/7.0',
            Referer: HOME_URL,
        },
    });
    if (!response.ok) throw new Error(`Upload Top4toP gagal (HTTP ${response.status}).`);

    const resultHtml = await response.text();
    const candidates = extractMp3Candidates(resultHtml)
        .map(normalizeHttpBoomboxUrl)
        .filter(Boolean);
    if (!candidates.length) throw new Error('Top4toP tidak mengembalikan direct MP3 URL.');

    const failures = [];
    for (const candidate of candidates) {
        try {
            await validateDirectAudioUrl(candidate);
            return candidate;
        } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
        }
    }
    throw new Error(`Direct HTTP MP3 Top4toP tidak lolos validasi. ${failures.slice(0, 2).join(' | ')}`);
}
