const PLATFORM_HOSTS = {
    youtube: new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']),
    tiktok: new Set(['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com']),
    spotify: new Set(['open.spotify.com', 'spotify.com', 'www.spotify.com', 'spotify.link']),
    soundcloud: new Set(['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com']),
};

function hostMatches(host, candidate) {
    return host === candidate || host.endsWith(`.${candidate}`);
}

export function detectBoomboxPlatform(input) {
    try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol)) return null;

        for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
            for (const host of hosts) {
                if (hostMatches(url.hostname.toLowerCase(), host)) return platform;
            }
        }
    } catch {
        return null;
    }

    return null;
}

export function extractSupportedUrl(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
    for (const raw of matches) {
        const cleaned = raw.replace(/[),.;!?]+$/g, '');
        if (detectBoomboxPlatform(cleaned)) return cleaned;
    }
    return null;
}
