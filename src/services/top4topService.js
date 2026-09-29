import fs from 'node:fs/promises';
import { normalizeHttpBoomboxUrl, validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const HOME_URL = 'https://top4top.io/';
const USER_AGENT = 'SKAW-GROUP-Boombox/8.0';

function getSetCookieHeaders(response) {
    try {
        if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
    } catch {}
    const combined = response.headers.get('set-cookie');
    return combined ? [combined] : [];
}

function cookieHeader(setCookies) {
    return setCookies
        .map((item) => String(item).split(';', 1)[0].trim())
        .filter(Boolean)
        .join('; ');
}

function absoluteUrl(value) {
    try { return new URL(value || '/index.php', HOME_URL).toString(); } catch { return HOME_URL; }
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x2F;/gi, '/')
        .replace(/&#47;/gi, '/')
        .replace(/\\\//g, '/');
}

function extractUploadForm(html) {
    const source = String(html || '');
    const forms = [...source.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)];
    const formHtml = forms.find((m) => /type\s*=\s*["']file["']/i.test(m[0]))?.[0];
    if (!formHtml) throw new Error('Form upload Top4toP tidak ditemukan.');

    const formTag = formHtml.match(/<form\b[^>]*>/i)?.[0] || '';
    const action = formTag.match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1] || '/index.php';
    const fileInput = formHtml.match(/<input\b[^>]*type\s*=\s*["']file["'][^>]*>/i)?.[0] || '';
    const fileField = fileInput.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!fileField) throw new Error('Field file upload Top4toP tidak ditemukan.');

    const hidden = [];
    for (const match of formHtml.matchAll(/<input\b[^>]*type\s*=\s*["']hidden["'][^>]*>/gi)) {
        const tag = match[0];
        const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!name) continue;
        const value = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1] || '';
        hidden.push([name, decodeHtml(value)]);
    }

    return { action: absoluteUrl(action), fileField, hidden };
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
            const normalized = normalizeHttpBoomboxUrl(value);
            if (normalized) found.add(normalized);
        }
    }
    return [...found];
}

export async function uploadMp3ToTop4Top(filePath, fileName = 'skaw-boombox.mp3') {
    const page = await fetch(HOME_URL, {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
        },
    });
    if (!page.ok) throw new Error(`Top4toP tidak bisa diakses (HTTP ${page.status}).`);

    const cookies = cookieHeader(getSetCookieHeaders(page));
    const html = await page.text();
    const formInfo = extractUploadForm(html);

    const form = new FormData();
    for (const [name, value] of formInfo.hidden) form.append(name, value);
    form.append(formInfo.fileField, new Blob([await fs.readFile(filePath)], { type: 'audio/mpeg' }), fileName);

    const response = await fetch(formInfo.action, {
        method: 'POST',
        body: form,
        redirect: 'follow',
        headers: {
            'User-Agent': USER_AGENT,
            Referer: HOME_URL,
            Accept: 'text/html,application/xhtml+xml',
            ...(cookies ? { Cookie: cookies } : {}),
        },
    });
    if (!response.ok) throw new Error(`Upload Top4toP gagal (HTTP ${response.status}).`);

    const resultHtml = await response.text();
    const candidates = extractMp3Candidates(resultHtml);
    if (!candidates.length) {
        throw new Error('Top4toP menerima upload tetapi direct MP3 URL tidak ditemukan pada response.');
    }

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
