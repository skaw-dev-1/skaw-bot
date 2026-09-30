import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const backupDir = path.resolve(process.argv[2] || '');
if (!backupDir || backupDir === path.parse(backupDir).root) {
  throw new Error('Usage: node scripts/rollback-skaw-boombox-v9.mjs /tmp/skaw-boombox-v9-backup-...');
}

const files = [
  'src/commands/Utility/bb.js',
  'src/commands/Utility/boombox-config.js',
  'src/services/boomboxService.js',
  'src/services/boomboxConversionService.js',
  'src/services/boomboxStorageService.js',
  'src/services/top4topService.js',
  'src/utils/boomboxPlatform.js',
  'src/utils/boomboxUrl.js',
  'src/app.js',
  'package.json',
  '.node-version',
];

const repoRoot = process.cwd();

for (const relative of files) {
  const source = path.join(backupDir, relative);
  const target = path.join(repoRoot, relative);
  try {
    await fs.access(source);
  } catch {
    continue;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  console.log(`Restored ${relative}`);
}

console.log('Rollback complete. Review git diff before committing.');
