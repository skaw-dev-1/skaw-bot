const HOSTS = {
    youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']),
    tiktok: new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com']),
    spotify: new Set(['open.spotify.com', 'spotify.com', 'www.spotify.com']),
    soundcloud: new Set(['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com']),
};

export function normalizeBoomboxUrl(raw) {
    const value = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!/^https?:\/\//i.test(value)) return null;

    try {
        const url = new URL(value);
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

export function detectBoomboxPlatform(raw) {
    const normalized = normalizeBoomboxUrl(raw);
    if (!normalized) return null;

    const host = new URL(normalized).hostname.toLowerCase();
    for (const [platform, hosts] of Object.entries(HOSTS)) {
        if (hosts.has(host)) return { platform, url: normalized };
    }
    return null;
}

export function extractBoomboxUrls(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    return [...new Set(matches.map(normalizeBoomboxUrl).filter(Boolean))];
}

export function sanitizeBoomboxFileName(value) {
    return String(value || 'audio')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'skaw-audio';
}
