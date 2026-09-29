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

function run(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
    });
}

let failed = false;
for (const target of targets) {
    const file = path.join(root, target);
    try { await fs.access(file); } catch {
        console.error(`MISS ${target}`);
        failed = true;
        continue;
    }
    const code = await run(process.execPath, ['--check', target]);
    if (code === 0) console.log(`OK   ${target}`);
    else failed = true;
}

const commandFiles = [];
async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
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
if (commandFiles.length !== 1) {
    console.error(commandFiles.length ? commandFiles.join('\n') : 'No /bb command found.');
    failed = true;
}

const service = await fs.readFile(path.join(root, 'src/services/boomboxService.js'), 'utf8').catch(() => '');
const prefixSection = service.split('export async function executeBbPrefix')[1] || '';
if (/interaction\.inGuild\(\)/.test(prefixSection)) {
    console.error('FAIL prefix handler contains interaction.inGuild().');
    failed = true;
} else console.log('OK   prefix handler does not use Interaction-only API.');

const conversion = await fs.readFile(path.join(root, 'src/services/boomboxConversionService.js'), 'utf8').catch(() => '');
if (conversion.includes('downloadFromGithub')) {
    console.error('FAIL conversion service still references downloadFromGithub().');
    failed = true;
} else console.log('OK   no downloadFromGithub() reference.');

process.exitCode = failed ? 1 : 0;
