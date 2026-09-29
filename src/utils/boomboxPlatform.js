const PLATFORM_HOSTS = {
    youtube: [
        'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
        'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
    ],
    tiktok: [
        'tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
    ],
    spotify: [
        'open.spotify.com', 'spotify.com', 'www.spotify.com', 'spotify.link',
    ],
    soundcloud: [
        'soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com',
    ],
};

export function parseHttpUrl(input) {
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

export function detectBoomboxPlatform(input) {
    const url = parseHttpUrl(input);
    if (!url) return null;

    const hostname = url.hostname.toLowerCase();
    for (const [platform, roots] of Object.entries(PLATFORM_HOSTS)) {
        if (roots.some((root) => hostMatches(hostname, root))) return platform;
    }
    return null;
}

export function isSupportedSourceUrl(input) {
    return Boolean(detectBoomboxPlatform(input));
}

export function normalizeSourceUrl(input) {
    const url = parseHttpUrl(input);
    if (!url) return null;
    url.hash = '';
    return url.toString();
}

export function extractFirstHttpUrl(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    return matches.map((item) => item.replace(/[),.;!?]+$/g, '')).find((item) => parseHttpUrl(item));
}

export function findSupportedSourceUrl(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    for (const item of matches) {
        const cleaned = item.replace(/[),.;!?]+$/g, '');
        if (isSupportedSourceUrl(cleaned)) return cleaned;
    }
    return null;
}
