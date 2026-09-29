function top4topUrl(input) {
    try {
        const url = new URL(String(input || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (!/(^|\.)top4top\.io$/i.test(url.hostname)) return null;
        if (!/\.mp3(?:$|[?#])/i.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

export function normalizeHttpBoomboxUrl(input) {
    const url = top4topUrl(input);
    if (!url) return null;
    url.protocol = 'http:';
    return url.toString();
}

export function isDirectHttpMp3Url(input) {
    const url = top4topUrl(input);
    return Boolean(url && url.protocol === 'http:');
}

export function parseTop4TopUrl(input) {
    return top4topUrl(input);
}

export async function validateDirectAudioUrl(input) {
    if (!isDirectHttpMp3Url(input)) {
        throw new Error('URL hasil harus direct HTTP MP3 Top4toP.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
        let response = await fetch(input, {
            method: 'HEAD',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'SKAW-GROUP-Boombox/4.0' },
        });

        if (response.status === 403 || response.status === 405) {
            response = await fetch(input, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'SKAW-GROUP-Boombox/4.0',
                    Range: 'bytes=0-1',
                },
            });
            if (response.body) await response.body.cancel().catch(() => {});
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            throw new Error('URL HTTP mengalihkan ke URL lain. Direct HTTP diperlukan untuk Boombox.');
        }
        if (![200, 206].includes(response.status)) {
            throw new Error(`URL audio tidak dapat diakses (HTTP ${response.status}).`);
        }

        const type = String(response.headers.get('content-type') || '').toLowerCase();
        if (type && !type.includes('audio/mpeg') && !type.includes('audio/mp3') && !type.includes('application/octet-stream')) {
            throw new Error(`Content-Type bukan MP3 (${type}).`);
        }
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Validasi URL Top4toP timeout.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
