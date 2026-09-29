import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const packageRoot = path.resolve(scriptDir, '..');

function hasPackageMarker(dir) {
    return fs.access(path.join(dir, 'VERSION.txt'))
        .then(() => true)
        .catch(() => false);
}

async function findRepoRoot(start) {
    let current = path.resolve(start);
    while (true) {
        const hasPkg = await fs.access(path.join(current, 'package.json')).then(() => true).catch(() => false);
        const hasApp = await fs.access(path.join(current, 'src', 'app.js')).then(() => true).catch(() => false);
        if (hasPkg && hasApp) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

if (!await hasPackageMarker(packageRoot)) {
    throw new Error(
        'Paket v8 tidak lengkap. Jangan menaruh installer ini langsung di repo/scripts. ' +
        'Extract seluruh folder SKAW-Boombox-v8 terlebih dahulu, lalu jalankan installernya dari root repo.',
    );
}

const repoRoot = await findRepoRoot(process.cwd());
if (!repoRoot) throw new Error('Tidak menemukan root TitanBot (package.json + src/app.js). Jalankan dari root repository.');
if (repoRoot === packageRoot) throw new Error('Source paket dan repository terdeteksi sama. Extract v8 sebagai folder terpisah terlebih dahulu.');

const sourceFiles = [
    'src/commands/Utility/bb.js',
    'src/commands/Utility/boombox-config.js',
    'src/services/boomboxService.js',
    'src/services/boomboxConversionService.js',
    'src/services/boomboxStorageService.js',
    'src/services/top4topService.js',
    'src/utils/boomboxPlatform.js',
    'src/utils/boomboxUrl.js',
];

const backupRoot = path.join(repoRoot, `.skaw-boombox-backup-v8-${Date.now()}`);

async function assertPayload() {
    for (const relative of sourceFiles) {
        await fs.access(path.join(packageRoot, relative));
    }
    await fs.access(path.join(packageRoot, 'scripts', 'check-boombox-v8.mjs'));
}

async function validateSyntax() {
    for (const relative of sourceFiles) {
        const file = path.join(packageRoot, relative);
        await execFileAsync(process.execPath, ['--check', file], { maxBuffer: 4 * 1024 * 1024 });
    }
}

async function backupIfExists(relative) {
    const source = path.join(repoRoot, relative);
    try {
        await fs.access(source);
    } catch {
        return;
    }
    const destination = path.join(backupRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
}

async function copyPayload() {
    for (const relative of sourceFiles) {
        await backupIfExists(relative);
        const source = path.join(packageRoot, relative);
        const target = path.join(repoRoot, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        console.log(`Installed ${relative}`);
    }
}

async function patchPackage() {
    const packagePath = path.join(repoRoot, 'package.json');
    await backupIfExists('package.json');
    const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    pkg.dependencies ||= {};
    pkg.dependencies['ffmpeg-static'] = pkg.dependencies['ffmpeg-static'] || '5.3.0';
    pkg.engines ||= {};
    const currentEngine = String(pkg.engines.node || '').trim();
    if (!currentEngine || /20|21/.test(currentEngine) || !/22|23|24|25|>=\s*2[2-9]/.test(currentEngine)) {
        pkg.engines.node = '>=22.0.0';
    }
    await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function patchApp() {
    const appPath = path.join(repoRoot, 'src/app.js');
    let app = await fs.readFile(appPath, 'utf8');
    await backupIfExists('src/app.js');

    const importLine = "import { startBoomboxService } from './services/boomboxService.js';";
    if (!app.includes(importLine)) {
        const lines = app.split(/\r?\n/);
        let lastImport = -1;
        for (let i = 0; i < lines.length; i += 1) {
            if (/^import\s/.test(lines[i].trim())) lastImport = i;
        }
        if (lastImport < 0) throw new Error('Tidak menemukan blok import di src/app.js. Patch dihentikan.');
        lines.splice(lastImport + 1, 0, importLine);
        app = lines.join('\n');
    }

    const hookPresent = /startBoomboxService\(\s*this\s*\)\s*;/.test(app);
    if (!hookPresent) {
        const markers = [
            "startupLog('Discord login successful');",
            'startupLog("Discord login successful");',
        ];
        const marker = markers.find((candidate) => app.includes(candidate));
        if (!marker) throw new Error('Tidak menemukan marker Discord login successful di src/app.js. Patch dihentikan demi keamanan.');
        app = app.replace(marker, `${marker}\n        startBoomboxService(this);`);
    }

    await fs.writeFile(appPath, app);
    console.log('Patched src/app.js');
}

async function installDependency() {
    await execFileAsync('npm', ['install', 'ffmpeg-static@5.3.0'], {
        cwd: repoRoot,
        maxBuffer: 12 * 1024 * 1024,
    });
}

await assertPayload();
await validateSyntax();
await fs.mkdir(backupRoot, { recursive: true });
await copyPayload();
await patchPackage();
await patchApp();
await installDependency();

console.log(`\nBackup: ${backupRoot}`);
console.log('SKAW Boombox v8 installed successfully.');
console.log('Run from repo root: node scripts/check-boombox-v8.mjs');
