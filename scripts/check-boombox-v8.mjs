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

const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log(`Node.js: ${process.versions.node}`);
if (nodeMajor < 22) {
    console.error('FAIL  Node.js 22+ required by current yt-dlp JavaScript runtime support.');
    failed = true;
} else {
    console.log('OK    Node.js 22+');
}

for (const relative of files) {
    const absolute = path.join(root, relative);
    try { await fs.access(absolute); } catch {
        console.error(`MISS  ${relative}`);
        failed = true;
        continue;
    }
    const code = await runNode(['--check', relative]);
    if (code === 0) console.log(`OK    ${relative}`);
    else failed = true;
}

let commandFiles = [];
async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
            const text = await fs.readFile(full, 'utf8');
            if (/\.setName\(\s*['"]bb['"]\s*\)/.test(text)) {
                commandFiles.push(path.relative(root, full));
            }
        }
    }
}
await walk(path.join(root, 'src', 'commands'));
console.log(`/bb command count: ${commandFiles.length}`);
if (commandFiles.length !== 1) {
    console.error(commandFiles.join('\n') || 'No /bb command found.');
    failed = true;
} else {
    console.log(`OK    /bb => ${commandFiles[0]}`);
}

const service = await fs.readFile(path.join(root, 'src/services/boomboxService.js'), 'utf8').catch(() => '');
if (/interaction\.inGuild\(\)/.test(service)) {
    console.error('FAIL  boomboxService must not call interaction.inGuild().');
    failed = true;
} else {
    console.log('OK    prefix/slash service separated from interaction.inGuild().');
}

const conversion = await fs.readFile(path.join(root, 'src/services/boomboxConversionService.js'), 'utf8').catch(() => '');
for (const bad of ['downloadFromGithub', 'yt-dlp-wrap-plus', 'youtube-dl-exec']) {
    if (conversion.includes(bad)) {
        console.error(`FAIL  old converter reference remains: ${bad}`);
        failed = true;
    }
}
if (!/yt-dlp_linux/.test(conversion)) {
    console.error('FAIL  standalone Linux yt-dlp asset not present in converter.');
    failed = true;
} else {
    console.log('OK    standalone yt-dlp asset bootstrap.');
}
if (!failed) console.log('All static checks passed.');
process.exitCode = failed ? 1 : 0;
