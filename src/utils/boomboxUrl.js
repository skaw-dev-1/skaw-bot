const TOP4TOP_HOST = /(^|\.)top4top\.io$/i;
const MP3_PATH = /\.mp3(?:$|[?#])/i;

export function parseTop4TopUrl(input) {
    try {
        const url = new URL(String(input || '').trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
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

function assertAudioResponse(response) {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw new Error('Top4toP mengalihkan URL HTTP. URL direct HTTP wajib dipertahankan untuk Boombox.');
    }
    if (![200, 206].includes(response.status)) {
        throw new Error(`URL audio tidak bisa diakses (HTTP ${response.status}).`);
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('audio/mpeg') && !contentType.includes('audio/mp3') && !contentType.includes('application/octet-stream')) {
        throw new Error(`Content-Type bukan MP3 (${contentType}).`);
    }
}

export async function validateDirectAudioUrl(input) {
    if (!isDirectHttpMp3Url(input)) {
        throw new Error('URL hasil harus direct HTTP MP3 dari Top4toP.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
        let response = await fetch(input, {
            method: 'HEAD',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (SKAW-GROUP-Boombox)',
            },
        });

        if (response.status === 403 || response.status === 405 || response.status === 501) {
            response = await fetch(input, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (SKAW-GROUP-Boombox)',
                    Range: 'bytes=0-1',
                },
            });
            assertAudioResponse(response);
            await response.body?.cancel?.().catch(() => {});
            return true;
        }

        assertAudioResponse(response);
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Validasi URL Top4toP timeout.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
