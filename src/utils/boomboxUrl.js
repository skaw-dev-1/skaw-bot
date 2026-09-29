const DIRECT_URL_RE = /^http:\/\/[^\s/]+\/[^\s]*\.mp3(?:\?[^\s]*)?$/i;

export function normalizeHttpBoomboxUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(String(url).trim());
        parsed.protocol = 'http:';
        return parsed.toString();
    } catch {
        return null;
    }
}

export function isDirectHttpMp3Url(url) {
    return DIRECT_URL_RE.test(String(url || '').trim());
}

export async function validateDirectAudioUrl(url) {
    if (!isDirectHttpMp3Url(url)) {
        throw new Error('URL hasil bukan direct HTTP MP3.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            headers: { Range: 'bytes=0-1' },
            signal: controller.signal,
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            throw new Error('Server mengalihkan URL HTTP ke HTTPS/URL lain.');
        }

        if (![200, 206].includes(response.status)) {
            throw new Error(`URL audio tidak bisa diakses (HTTP ${response.status}).`);
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const allowed = contentType.includes('audio/mpeg')
            || contentType.includes('audio/mp3')
            || contentType.includes('application/octet-stream');

        if (!allowed) {
            throw new Error(`Content-Type bukan audio MP3 (${contentType || 'unknown'}).`);
        }

        return true;
    } finally {
        clearTimeout(timeout);
    }
}
