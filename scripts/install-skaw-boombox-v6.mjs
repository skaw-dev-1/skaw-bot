import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');

const files = [
    ['src/commands/Utility/bb.js', 'src/commands/Utility/bb.js'],
    ['src/commands/Utility/boombox-config.js', 'src/commands/Utility/boombox-config.js'],
    ['src/services/boomboxService.js', 'src/services/boomboxService.js'],
    ['src/services/boomboxConversionService.js', 'src/services/boomboxConversionService.js'],
    ['src/services/boomboxStorageService.js', 'src/services/boomboxStorageService.js'],
    ['src/services/top4topService.js', 'src/services/top4topService.js'],
    ['src/utils/boomboxPlatform.js', 'src/utils/boomboxPlatform.js'],
    ['src/utils/boomboxUrl.js', 'src/utils/boomboxUrl.js'],
];

function assertRepo() {
    if (!process.cwd() || repoRoot !== path.resolve(process.cwd())) {
        console.warn(`Installer membaca repo: ${repoRoot}`);
        console.warn('Jalankan installer dari root repository untuk hasil yang paling aman.');
    }
}

async function backup(target) {
    try {
        await fs.access(target);
    } catch {
        return null;
    }

    const backupRoot = path.join(repoRoot, '.skaw-boombox-backup-v6');
    await fs.mkdir(backupRoot, { recursive: true });
    const destination = path.join(backupRoot, `${Date.now()}-${path.basename(target)}`);
    await fs.copyFile(target, destination);
    return destination;
}

async function copySources() {
    for (const [from, to] of files) {
        const source = path.join(packageRoot, from);
        const target = path.join(repoRoot, to);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await backup(target);
        await fs.copyFile(source, target);
        console.log(`Installed ${to}`);
    }
}

async function patchPackageJson() {
    const packagePath = path.join(repoRoot, 'package.json');
    const raw = await fs.readFile(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    pkg.dependencies ||= {};

    if (!pkg.dependencies['ffmpeg-static']) {
        pkg.dependencies['ffmpeg-static'] = '5.3.0';
        await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
        console.log('Added ffmpeg-static@5.3.0 to package.json');
    } else {
        console.log(`ffmpeg-static already declared (${pkg.dependencies['ffmpeg-static']})`);
    }
}

async function patchAppJs() {
    const appPath = path.join(repoRoot, 'src/app.js');
    let app = await fs.readFile(appPath, 'utf8');

    const importLine = "import { startBoomboxService } from './services/boomboxService.js';";
    if (!app.includes(importLine)) {
        const importLines = app.split(/\r?\n/);
        const lastImport = importLines.reduce((index, line, indexNow) => (/^import\s/.test(line.trim()) ? indexNow : index), -1);
        importLines.splice(lastImport + 1, 0, importLine);
        app = importLines.join('\n');
        console.log('Added Boombox import to src/app.js');
    } else {
        console.log('Boombox import already present in src/app.js');
    }

    const loginMarker = "startupLog('Discord login successful');";
    const startLine = 'startBoomboxService(this);';
    if (!app.includes(startLine)) {
        if (!app.includes(loginMarker)) {
            throw new Error("Tidak menemukan marker startupLog('Discord login successful'); di src/app.js. Patch dibatalkan agar app.js tidak rusak.");
        }
        app = app.replace(loginMarker, `${loginMarker}\n${startLine}`);
        console.log('Added startBoomboxService(this) after Discord login.');
    } else {
        console.log('Boombox startup hook already present in src/app.js');
    }

    await backup(appPath);
    await fs.writeFile(appPath, app);
}

async function npmInstall() {
    console.log('Installing/refreshing ffmpeg-static...');
    try {
        await execFileAsync('npm', ['install', 'ffmpeg-static@5.3.0'], {
            cwd: repoRoot,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (error) {
        console.error(error?.stdout || '');
        console.error(error?.stderr || '');
        throw new Error('npm install ffmpeg-static gagal. Jalankan manual dari root repo dan cek output npm di atas.');
    }
}

async function audit() {
    const commandFiles = await collectJs(path.join(repoRoot, 'src/commands'));
    const bbFiles = [];
    for (const file of commandFiles) {
        const text = await fs.readFile(file, 'utf8');
        if (/\.setName\(\s*['"]bb['"]\s*\)/.test(text)) bbFiles.push(path.relative(repoRoot, file));
    }

    if (bbFiles.length !== 1) {
        throw new Error(`Konflik /bb di project. Ditemukan ${bbFiles.length}: ${bbFiles.join(', ') || '(tidak ada)'}`);
    }

    const service = await fs.readFile(path.join(repoRoot, 'src/services/boomboxService.js'), 'utf8');
    if (service.includes('interaction.inGuild()')) {
        // Slash handler boleh memakai inGuild, prefix handler tidak boleh.
        const prefixSection = service.split('export async function executeBbPrefix')[1] || '';
        if (prefixSection.includes('interaction.inGuild()')) throw new Error('Prefix handler masih memakai interaction.inGuild().');
    }

    const conversion = await fs.readFile(path.join(repoRoot, 'src/services/boomboxConversionService.js'), 'utf8');
    if (conversion.includes('downloadFromGithub')) throw new Error('Source masih mengandung downloadFromGithub.');

    console.log(`Audit OK: exactly one /bb command: ${bbFiles[0]}`);
}

async function collectJs(dir) {
    const output = [];
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return output; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) output.push(...await collectJs(full));
        else if (/\.(js|mjs|cjs)$/.test(entry.name)) output.push(full);
    }
    return output;
}

assertRepo();
await copySources();
await patchPackageJson();
await patchAppJs();
await npmInstall();
await audit();
console.log('\nSKAW Boombox v6 installation complete.');
console.log('Run: node scripts/check-boombox-v6.mjs');
