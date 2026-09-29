const TOP4TOP_HOST = /(^|\.)top4top\.io$/i;
const MP3_PATH = /\.mp3(?:$|[?#])/i;

export function parseTop4TopUrl(input) {
    try {
        const url = new URL(String(input || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (!TOP4TOP_HOST.test(url.hostname)) return null;
        if (!MP3_PATH.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

export function normalizeHttpBoomboxUrl(input) {
    const url = parseTop4TopUrl(input);
    if (!url) return null;
    url.protocol = 'http:';
    return url.toString();
}

export function isDirectHttpMp3Url(input) {
    const url = parseTop4TopUrl(input);
    return Boolean(url && url.protocol === 'http:');
}

function validateAudioResponse(response) {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error('URL Top4toP mengalihkan request. Direct HTTP MP3 tidak tersedia pada URL tersebut.');
    }
    if (![200, 206].includes(response.status)) {
        throw new Error(`HTTP ${response.status} saat memeriksa audio.`);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !/(audio\/mpeg|audio\/mp3|application\/octet-stream)/i.test(contentType)) {
        throw new Error(`Content-Type bukan MP3 (${contentType}).`);
    }
}

export async function validateDirectAudioUrl(input) {
    if (!isDirectHttpMp3Url(input)) {
        throw new Error('Hasil harus berupa direct HTTP MP3 Top4toP.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
        let response = await fetch(input, {
            method: 'HEAD',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'SKAW-GROUP-Boombox/7.0' },
        });

        if ([403, 405, 501].includes(response.status)) {
            response = await fetch(input, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'SKAW-GROUP-Boombox/7.0',
                    Range: 'bytes=0-1',
                },
            });
            validateAudioResponse(response);
            await response.body?.cancel?.().catch(() => {});
            return true;
        }

        validateAudioResponse(response);
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Validasi URL Top4toP timeout.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
