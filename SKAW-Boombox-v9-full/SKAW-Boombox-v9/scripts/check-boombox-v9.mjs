import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const files = [
  'src/commands/Utility/bb.js',
  'src/commands/Utility/boombox-config.js',
  'src/services/boomboxService.js',
  'src/services/boomboxConversionService.js',
  'src/services/boomboxStorageService.js',
  'src/services/top4topService.js',
  'src/utils/boomboxPlatform.js',
  'src/utils/boomboxUrl.js',
];

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

let failed = false;
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}'));

console.log(`Node.js: ${process.version}`);
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('FAIL  local Node must be 22+ for current yt-dlp EJS support.');
  failed = true;
} else console.log('OK    local Node 22+');

const engine = String(pkg?.engines?.node || '');
if (!/>=?\s*22|\b22\b|\b23\b|\b24\b|\b25\b/i.test(engine)) {
  console.error(`FAIL  package.json engines.node is not Node 22+ (${engine || 'missing'}).`);
  failed = true;
} else console.log(`OK    package.json engines.node = ${engine}`);

for (const relative of files) {
  const absolute = path.join(root, relative);
  try {
    await fs.access(absolute);
  } catch {
    console.error(`MISS  ${relative}`);
    failed = true;
    continue;
  }
  const code = await runNode(['--check', relative]);
  if (code === 0) console.log(`OK    syntax ${relative}`);
  else failed = true;
}

const appPath = path.join(root, 'src/app.js');
const app = await fs.readFile(appPath, 'utf8').catch(() => '');
if (!app) {
  console.error('FAIL  src/app.js not found.');
  failed = true;
} else {
  if (!app.includes("import { startBoomboxService } from './services/boomboxService.js';")) {
    console.error('FAIL  src/app.js is missing Boombox startup import.');
    failed = true;
  } else console.log('OK    app startup import');

  if (!/startBoomboxService\(\s*this\s*\)/.test(app)) {
    console.error('FAIL  src/app.js is missing startBoomboxService(this) hook.');
    failed = true;
  } else console.log('OK    app startup hook');
}

const conversion = await fs.readFile(path.join(root, 'src/services/boomboxConversionService.js'), 'utf8').catch(() => '');
for (const bad of ['youtube-dl-exec', 'yt-dlp-wrap-plus', 'downloadFromGithub', 'python3']) {
  if (conversion.includes(bad)) {
    console.error(`FAIL  old converter reference remains: ${bad}`);
    failed = true;
  }
}

for (const required of ['yt-dlp_musllinux', 'yt-dlp_linux', 'SHA2-256SUMS', 'process.execPath', 'ffmpegStatic']) {
  if (!conversion.includes(required)) {
    console.error(`FAIL  converter is missing expected feature: ${required}`);
    failed = true;
  } else console.log(`OK    converter feature ${required}`);
}

const bb = await fs.readFile(path.join(root, 'src/commands/Utility/bb.js'), 'utf8').catch(() => '');
const config = await fs.readFile(path.join(root, 'src/commands/Utility/boombox-config.js'), 'utf8').catch(() => '');
if ((bb.match(/\.setName\(\s*['"]bb['"]\s*\)/g) || []).length !== 1) {
  console.error('FAIL  /bb command definition missing or duplicated.');
  failed = true;
} else console.log('OK    /bb command definition');
if ((config.match(/\.setName\(\s*['"]boombox-config['"]\s*\)/g) || []).length !== 1) {
  console.error('FAIL  /boombox-config command definition missing or duplicated.');
  failed = true;
} else console.log('OK    /boombox-config command definition');

const platform = await import(path.join(root, 'src/utils/boomboxPlatform.js'));
const url = await import(path.join(root, 'src/utils/boomboxUrl.js'));
for (const [name, value] of [
  ['YouTube', platform.detectBoomboxPlatform('https://youtu.be/dQw4w9WgXcQ')],
  ['TikTok', platform.detectBoomboxPlatform('https://www.tiktok.com/@example/video/123')],
  ['Spotify', platform.detectBoomboxPlatform('https://open.spotify.com/track/123')],
  ['SoundCloud', platform.detectBoomboxPlatform('https://soundcloud.com/example/song')],
]) {
  if (!value) {
    console.error(`FAIL  platform detection: ${name}`);
    failed = true;
  } else console.log(`OK    platform detection: ${name}`);
}
if (!url.isDirectHttpMp3Url('http://f1.top4top.io/p_1/test.mp3')) {
  console.error('FAIL  direct HTTP Top4toP URL validator');
  failed = true;
} else console.log('OK    direct HTTP Top4toP URL validator');

if (!failed) console.log('\nALL V9 STATIC CHECKS PASSED');
else console.error('\nV9 STATIC CHECKS FAILED');
process.exitCode = failed ? 1 : 0;
