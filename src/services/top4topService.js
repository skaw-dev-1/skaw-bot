import axios from 'axios';
import FormData from 'form-data';
import * as cheerio from 'cheerio';
import fs from 'node:fs';

const TOP4TOP_UPLOAD_URL = 'https://top4top.io/index.php';
const USER_AGENT = 'SKAW-GROUP-TitanBot-Boombox/1.0';

function toHttp(url) {
    const value = String(url || '').trim();
    return value.replace(/^https:\/\//i, 'http://');
}

function isAllowedTop4TopHost(hostname) {
    return /(^|\.)top4top\.io$/i.test(String(hostname || ''));
}

async function validateHttpAudioUrl(url) {
    const candidate = toHttp(url);

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Top4toP returned an invalid URL.');
    }

    if (parsed.protocol !== 'http:' || !isAllowedTop4TopHost(parsed.hostname) || !/\.mp3(?:$|\?)/i.test(parsed.pathname)) {
        throw new Error('Top4toP did not return a direct HTTP MP3 URL.');
    }

    const response = await axios.get(candidate, {
        responseType: 'stream',
        maxRedirects: 0,
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: { 'User-Agent': USER_AGENT },
    }).catch((error) => {
        const status = error?.response?.status;
        if (status >= 300 && status < 400) {
            throw new Error('Top4toP HTTP URL redirects and is not directly usable for the Boombox.');
        }
        throw error;
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const finalUrl = response.request?.res?.responseUrl || candidate;
    response.data.destroy?.();

    if (!/^http:\/\//i.test(finalUrl)) {
        throw new Error('Top4toP did not provide a direct HTTP URL.');
    }

    if (contentType && !contentType.includes('audio') && !contentType.includes('mpeg') && !contentType.includes('octet-stream')) {
        throw new Error('Top4toP URL does not look like an audio file.');
    }

    return candidate;
}

export async function uploadToTop4Top(filePath, fileName) {
    const form = new FormData();
    form.append('file_1_', fs.createReadStream(filePath), {
        filename: fileName,
        contentType: 'audio/mpeg',
    });
    form.append('submitr', 'رفع الملفات');

    const response = await axios.post(TOP4TOP_UPLOAD_URL, form, {
        headers: {
            ...form.getHeaders(),
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': USER_AGENT,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    const $ = cheerio.load(response.data);
    const links = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /top4top\.io/i.test(href)) links.push(href);
    });

    const direct = links.find((href) => /\.mp3(?:\?|$)/i.test(href));
    if (!direct) {
        throw new Error('Top4toP upload completed but no direct MP3 URL was found in the response.');
    }

    const absolute = new URL(direct, response.request?.res?.responseUrl || TOP4TOP_UPLOAD_URL).toString();
    return validateHttpAudioUrl(absolute);
}
