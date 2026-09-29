const TOP4TOP_HOST_RE = /(^|\.)top4top\.io$/i;

export function parseTop4TopUrl(input) {
    try {
        const url = new URL(String(input || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (!TOP4TOP_HOST_RE.test(url.hostname)) return null;
        if (!/\.mp3(?:$|[?#])/i.test(url.pathname)) return null;
        return url;
    } catch {
        return null;
    }
}

export function normalizeHttpBoomboxUrl(input) {
    const parsed = parseTop4TopUrl(input);
    if (!parsed) return null;
    parsed.protocol = 'http:';
    return parsed.toString();
}

export function isDirectHttpMp3Url(input) {
    const parsed = parseTop4TopUrl(input);
    return Boolean(parsed && parsed.protocol === 'http:');
}

async function checkResponse(response) {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error('URL HTTP mengalihkan ke URL lain. SKAW hanya menerima direct HTTP MP3.');
    }
    if (![200, 206].includes(response.status)) {
        throw new Error(`URL audio tidak bisa diakses (HTTP ${response.status}).`);
    }

    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const allowed = type.includes('audio/mpeg')
        || type.includes('audio/mp3')
        || type.includes('application/octet-stream');
    if (!allowed) throw new Error(`Content-Type bukan audio MP3 (${type || 'unknown'}).`);
}

export async function validateDirectAudioUrl(input) {
    if (!isDirectHttpMp3Url(input)) {
        throw new Error('URL hasil harus berupa direct HTTP MP3 Top4toP.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
        let response = await fetch(input, {
            method: 'HEAD',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'SKAW-Boombox/3.0' },
        });

        if (response.status === 405 || response.status === 403) {
            response = await fetch(input, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'SKAW-Boombox/3.0',
                    Range: 'bytes=0-1',
                },
            });
            await checkResponse(response);
            await response.body?.cancel().catch(() => {});
            return true;
        }

        await checkResponse(response);
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Validasi URL Top4toP timeout.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
