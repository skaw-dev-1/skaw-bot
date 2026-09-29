import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const targets = [
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
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
    });
}

let failed = false;
for (const target of targets) {
    try { await fs.access(path.join(root, target)); } catch { console.error(`MISS ${target}`); failed = true; continue; }
    const code = await runNode(['--check', target]);
    if (code === 0) console.log(`OK   ${target}`); else failed = true;
}

const commandFiles = [];
async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
            const text = await fs.readFile(full, 'utf8');
            if (/\.setName\(\s*['"]bb['"]\s*\)/.test(text)) commandFiles.push(path.relative(root, full));
        }
    }
}
await walk(path.join(root, 'src/commands'));
console.log(`/bb command count: ${commandFiles.length}`);
if (commandFiles.length !== 1) { console.error(commandFiles.join('\n') || 'No /bb command.'); failed = true; }

const service = await fs.readFile(path.join(root, 'src/services/boomboxService.js'), 'utf8').catch(() => '');
if (service.includes('interaction.inGuild()')) { console.error('FAIL: boomboxService still calls interaction.inGuild().'); failed = true; }
else console.log('OK   no interaction.inGuild() dependency in Boombox service.');

const conversion = await fs.readFile(path.join(root, 'src/services/boomboxConversionService.js'), 'utf8').catch(() => '');
if (/downloadFromGithub|yt-dlp-wrap-plus|youtube-dl-exec/.test(conversion)) { console.error('FAIL: old yt-dlp wrapper API/reference remains.'); failed = true; }
else console.log('OK   no old yt-dlp wrapper reference.');

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!packageJson.dependencies?.['ffmpeg-static']) { console.error('FAIL: ffmpeg-static missing from package.json'); failed = true; }
else console.log('OK   ffmpeg-static declared.');

process.exitCode = failed ? 1 : 0;
