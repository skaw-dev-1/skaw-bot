const PLATFORM_HOSTS = Object.freeze({
    youtube: ['youtube.com', 'youtu.be'],
    tiktok: ['tiktok.com', 'vt.tiktok.com'],
    spotify: ['spotify.com', 'spotify.link'],
    soundcloud: ['soundcloud.com', 'on.soundcloud.com'],
});

export function parseHttpUrl(input) {
    try {
        const url = new URL(String(input ?? '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return url;
    } catch {
        return null;
    }
}

function hostMatches(hostname, root) {
    return hostname === root || hostname.endsWith(`.${root}`);
}

export function detectBoomboxPlatform(input) {
    const url = parseHttpUrl(input);
    if (!url) return null;
    const hostname = url.hostname.toLowerCase();

    for (const [platform, roots] of Object.entries(PLATFORM_HOSTS)) {
        if (roots.some((root) => hostMatches(hostname, root))) return platform;
    }
    return null;
}

export function normalizeSourceUrl(input) {
    const url = parseHttpUrl(input);
    if (!url) return null;
    url.hash = '';
    return url.toString();
}

export function extractSupportedSourceUrl(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    for (const raw of matches) {
        const cleaned = raw.replace(/[),.;!?]+$/g, '');
        if (detectBoomboxPlatform(cleaned)) return normalizeSourceUrl(cleaned);
    }
    return null;
}

export function sanitizeFileName(value, fallback = 'SKAW-Boombox') {
    const cleaned = String(value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return cleaned || fallback;
}
