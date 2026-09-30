import fs from 'node:fs/promises';
import { normalizeHttpBoomboxUrl, validateDirectAudioUrl } from '../utils/boomboxUrl.js';

const HOME_URL = 'https://top4top.io/';
const USER_AGENT = 'SKAW-GROUP-Boombox/9.0';
const REQUEST_TIMEOUT_MS = 30_000;

function getSetCookieHeaders(response) {
  try {
    if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  } catch {}
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function splitSetCookieHeader(value) {
  const cookies = [];
  let current = '';
  let inExpires = false;
  for (const ch of String(value || '')) {
    if (ch === ', ' && !inExpires) {
      if (current) cookies.push(current);
      current = '';
      continue;
    }
    current += ch;
    if (/expires=/i.test(current.slice(-16))) inExpires = true;
    if (inExpires && ch === ';') inExpires = false;
  }
  if (current) cookies.push(current);
  return cookies;
}

function cookieHeader(setCookies) {
  const parts = [];
  for (const item of setCookies.flatMap((value) => splitSetCookieHeader(value))) {
    const part = String(item).split(';', 1)[0].trim();
    if (!part) continue;
    const name = part.split('=', 1)[0].trim();
    if (!name) continue;
    const existing = parts.findIndex((v) => v.split('=', 1)[0].trim() === name);
    if (existing >= 0) parts[existing] = part;
    else parts.push(part);
  }
  return parts.join('; ');
}

function absoluteUrl(value, base = HOME_URL) {
  try { return new URL(value || '/', base).toString(); } catch { return base; }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/gi, '/')
    .replace(/&#x5C;/gi, '\\')
    .replace(/\\\//g, '/');
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function selectedOption(selectHtml) {
  const option = String(selectHtml || '').match(/<option\b[^>]*selected[^>]*>([\s\S]*?)<\/option>/i)
    || String(selectHtml || '').match(/<option\b[^>]*value\s*=\s*(["'][^"']+["']|[^\s>]+)[^>]*>/i);
  if (!option) return '';
  const tag = option[0];
  return attr(tag, 'value') || decodeHtml(option[1] || '').replace(/<[^>]+>/g, '').trim();
}

function extractUploadForm(html) {
  const forms = [...String(html || '').matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const formHtml = forms.find((form) => /<input\b[^>]*type\s*=\s*["']?file\b/i.test(form));
  if (!formHtml) throw new Error('Form upload Top4toP tidak ditemukan pada halaman utama.');

  const formTag = formHtml.match(/<form\b[^>]*>/i)?.[0] || '';
  const action = absoluteUrl(attr(formTag, 'action') || '/index.php');
  const method = (attr(formTag, 'method') || 'POST').toUpperCase();

  const fileTag = formHtml.match(/<input\b[^>]*type\s*=\s*["']?file\b[^>]*>/i)?.[0] || '';
  const fileField = attr(fileTag, 'name');
  if (!fileField) throw new Error('Nama field file upload Top4toP tidak ditemukan.');

  const fields = [];
  for (const match of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    const name = attr(tag, 'name');
    if (!name || type === 'file' || type === 'submit' || type === 'button' || type === 'image') continue;

    if (type === 'checkbox' || type === 'radio') {
      const checked = /\bchecked(?:\s*=\s*(?:"checked"|'checked'|checked))?/i.test(tag);
      const looksLikeAgreement = /(agree|accept|terms|rule|policy|confirm|tos|موافق|اتفاق|شروط)/i.test(`${name} ${tag}`);
      if (!checked && !looksLikeAgreement) continue;
      fields.push([name, attr(tag, 'value') || 'on']);
      continue;
    }

    fields.push([name, attr(tag, 'value')]);
  }

  for (const match of formHtml.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)) {
    const tag = match[0];
    const name = attr(tag.match(/<select\b[^>]*>/i)?.[0] || '', 'name');
    if (!name) continue;
    fields.push([name, selectedOption(tag)]);
  }

  return { action, method, fileField, fields };
}

function extractUploadLinks(html, baseUrl) {
  const source = decodeHtml(html);
  const found = new Set();
  const patterns = [
    /https?:\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi,
    /(?:https?:)?\/\/[^\s"'<>]+\.mp3(?:\?[^\s"'<>]*)?/gi,
    /(?:href|src|url|link)\s*[:=]\s*["']([^"']+\.mp3(?:\?[^"']*)?)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let value = match[1] || match[0];
      value = value.replace(/^["']|["']$/g, '').replace(/[),.;!?]+$/g, '');
      if (value.startsWith('//')) value = `https:${value}`;
      const absolute = absoluteUrl(value, baseUrl);
      const normalized = normalizeHttpBoomboxUrl(absolute);
      if (normalized) found.add(normalized);
    }
  }
  return [...found];
}

function textContainsSuccess(html) {
  return /(upload\s+(?:success|complete|done)|uploaded\s+successfully|berhasil|تم رفع|تم الرفع)/i.test(String(html || ''));
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Request Top4toP timeout.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTop4Top() {
  const response = await fetchWithTimeout(HOME_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`Top4toP tidak dapat diakses (HTTP ${response.status}).`);
  const html = await response.text();
  const form = extractUploadForm(html);
  return {
    reachable: true,
    uploadAction: form.action,
    fileField: form.fileField,
  };
}

export async function uploadMp3ToTop4Top(filePath, fileName = 'skaw-boombox.mp3') {
  const page = await fetchWithTimeout(HOME_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!page.ok) throw new Error(`Top4toP tidak dapat diakses (HTTP ${page.status}).`);

  const html = await page.text();
  const formInfo = extractUploadForm(html);
  if (formInfo.method !== 'POST') throw new Error(`Form Top4toP memakai method ${formInfo.method}, bukan POST.`);

  const form = new FormData();
  for (const [name, value] of formInfo.fields) form.append(name, value);
  form.append(
    formInfo.fileField,
    new Blob([await fs.readFile(filePath)], { type: 'audio/mpeg' }),
    fileName,
  );

  const cookies = cookieHeader(getSetCookieHeaders(page));
  const response = await fetchWithTimeout(formInfo.action, {
    method: 'POST',
    redirect: 'follow',
    body: form,
    headers: {
      'User-Agent': USER_AGENT,
      Referer: HOME_URL,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });

  if (!response.ok) throw new Error(`Upload Top4toP gagal (HTTP ${response.status}).`);
  const resultHtml = await response.text();
  const candidates = extractUploadLinks(resultHtml, response.url || HOME_URL);

  if (!candidates.length) {
    const compact = resultHtml.replace(/\s+/g, ' ').slice(0, 1000);
    throw new Error(`Top4toP menerima request tetapi direct MP3 URL tidak ditemukan. ${textContainsSuccess(resultHtml) ? 'Server melaporkan upload selesai.' : `Response: ${compact}`}`);
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      await validateDirectAudioUrl(candidate);
      return candidate;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`Tidak ada direct HTTP MP3 Top4toP yang lolos validasi. ${failures.slice(0, 3).join(' | ')}`);
}
