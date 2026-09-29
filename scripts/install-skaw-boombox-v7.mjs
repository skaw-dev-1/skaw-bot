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

const backupRoot = path.join(repoRoot, `.skaw-boombox-backup-v7-${Date.now()}`);

async function copyFileWithBackup(sourceRel, targetRel) {
    const source = path.join(packageRoot, sourceRel);
    const target = path.join(repoRoot, targetRel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
        await fs.access(target);
        const backup = path.join(backupRoot, targetRel);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(target, backup);
    } catch {}
    await fs.copyFile(source, target);
    console.log(`Installed ${targetRel}`);
}

async function patchPackage() {
    const packagePath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    pkg.dependencies ||= {};
    if (!pkg.dependencies['ffmpeg-static']) pkg.dependencies['ffmpeg-static'] = '5.3.0';
    await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function patchApp() {
    const appPath = path.join(repoRoot, 'src/app.js');
    let app = await fs.readFile(appPath, 'utf8');
    const importLine = "import { startBoomboxService } from './services/boomboxService.js';";
    if (!app.includes(importLine)) {
        const lines = app.split(/\r?\n/);
        let lastImport = -1;
        for (let i = 0; i < lines.length; i += 1) if (/^import\s/.test(lines[i].trim())) lastImport = i;
        lines.splice(lastImport + 1, 0, importLine);
        app = lines.join('\n');
    }

    const hook = 'startBoomboxService(this);';
    if (!app.includes(hook)) {
        const marker = "startupLog('Discord login successful');";
        if (!app.includes(marker)) throw new Error('Tidak menemukan marker login di src/app.js. Patch dihentikan demi keamanan.');
        app = app.replace(marker, `${marker}\n${hook}`);
    }

    await fs.copyFile(appPath, path.join(backupRoot, 'src/app.js')).catch(async () => {
        await fs.mkdir(path.join(backupRoot, 'src'), { recursive: true });
        await fs.copyFile(appPath, path.join(backupRoot, 'src/app.js'));
    });
    await fs.writeFile(appPath, app);
    console.log('Patched src/app.js');
}

async function npmInstall() {
    await execFileAsync('npm', ['install', 'ffmpeg-static@5.3.0'], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
}

for (const [source, target] of files) await copyFileWithBackup(source, target);
await patchPackage();
await patchApp();
await npmInstall();

console.log(`\nBackup: ${backupRoot}`);
console.log('SKAW Boombox v7 installed. Run: node scripts/check-boombox-v7.mjs');
