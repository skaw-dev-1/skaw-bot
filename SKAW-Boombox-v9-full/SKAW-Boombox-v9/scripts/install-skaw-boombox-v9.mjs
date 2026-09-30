import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function findRepoRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, 'package.json')) && await exists(path.join(current, 'src', 'app.js'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const repoRoot = await findRepoRoot(process.cwd());
if (!repoRoot) {
  throw new Error('Root TitanBot tidak ditemukan. Jalankan installer dari direktori repository (yang memiliki package.json dan src/app.js).');
}
if (repoRoot === packageRoot) {
  throw new Error('Paket v9 masih berada di dalam root repository. Extract ZIP sebagai folder terpisah (contoh: /workspaces/SKAW-Boombox-v9), lalu jalankan installer dari root repo.');
}

for (const relative of sourceFiles) {
  if (!await exists(path.join(packageRoot, relative))) throw new Error(`Payload v9 tidak lengkap: ${relative}`);
}

for (const relative of sourceFiles) {
  await execFileAsync(process.execPath, ['--check', path.join(packageRoot, relative)], { maxBuffer: 2 * 1024 * 1024 });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join('/tmp', `skaw-boombox-v9-backup-${stamp}`);
await fs.mkdir(backupRoot, { recursive: true });

const backupTargets = [...sourceFiles, 'src/app.js', 'package.json', '.node-version'];
async function backup(relative) {
  const source = path.join(repoRoot, relative);
  if (!await exists(source)) return;
  const target = path.join(backupRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

for (const relative of backupTargets) await backup(relative);

for (const relative of sourceFiles) {
  const source = path.join(packageRoot, relative);
  const target = path.join(repoRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  console.log(`Installed ${relative}`);
}

const packagePath = path.join(repoRoot, 'package.json');
const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
pkg.dependencies ||= {};
pkg.dependencies['ffmpeg-static'] = '5.3.0';
pkg.engines ||= {};
pkg.engines.node = '>=22.0.0';
pkg.scripts ||= {};
pkg.scripts['boombox:check'] = 'node scripts/check-boombox-v9.mjs';
await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Updated package.json: Node >=22 + ffmpeg-static 5.3.0');

await fs.writeFile(path.join(repoRoot, '.node-version'), '22\n');
console.log('Wrote .node-version = 22');

const appPath = path.join(repoRoot, 'src/app.js');
let app = await fs.readFile(appPath, 'utf8');
const importLine = "import { startBoomboxService } from './services/boomboxService.js';";
if (!app.includes(importLine)) {
  const lines = app.split(/\r?\n/);
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) if (/^import\s/.test(lines[i].trim())) lastImport = i;
  if (lastImport < 0) throw new Error('Blok import src/app.js tidak ditemukan.');
  lines.splice(lastImport + 1, 0, importLine);
  app = lines.join('\n');
}
if (!/startBoomboxService\(\s*this\s*\)/.test(app)) {
  const markers = [
    "startupLog('Discord login successful');",
    'startupLog("Discord login successful");',
  ];
  const marker = markers.find((value) => app.includes(value));
  if (!marker) throw new Error('Marker Discord login successful tidak ditemukan; app.js tidak dipatch agar aman.');
  app = app.replace(marker, `${marker}\n      startBoomboxService(this);`);
}
await fs.writeFile(appPath, app);
console.log('Updated src/app.js Boombox startup hook');

console.log('\nInstallation complete.');
console.log(`Backup: ${backupRoot}`);
console.log('Next: npm install --save-exact ffmpeg-static@5.3.0');
console.log('Then: node scripts/check-boombox-v9.mjs');
