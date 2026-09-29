const PLATFORM_HOSTS = {
    youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'],
    tiktok: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    spotify: ['open.spotify.com', 'spotify.com', 'www.spotify.com', 'spotify.link'],
    soundcloud: ['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com'],
};

function parseUrl(input) {
    try {
        const url = new URL(String(input || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return url;
    } catch {
        return null;
    }
}

function hostMatches(hostname, root) {
    return hostname === root || hostname.endsWith(`.${root}`);
}

export function normalizeSourceUrl(input) {
    const url = parseUrl(input);
    if (!url) return null;
    url.hash = '';
    return url.toString();
}

export function detectBoomboxPlatform(input) {
    const url = parseUrl(input);
    if (!url) return null;
    const hostname = url.hostname.toLowerCase();

    for (const [platform, roots] of Object.entries(PLATFORM_HOSTS)) {
        if (roots.some((root) => hostMatches(hostname, root))) return platform;
    }
    return null;
}

export function extractSupportedSourceUrl(content) {
    const urls = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    for (const raw of urls) {
        const cleaned = raw.replace(/[),.;!?]+$/g, '');
        if (detectBoomboxPlatform(cleaned)) return normalizeSourceUrl(cleaned);
    }
    return null;
}

export function sanitizeFileName(value) {
    return String(value || 'SKAW-Boombox')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90) || 'SKAW-Boombox';
}
