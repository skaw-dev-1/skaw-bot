import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const appPath = path.join(root, 'src', 'app.js');
const packagePath = path.join(root, 'package.json');

const boomboxImport = "import { initializeBoomboxConverter } from './services/boomboxService.js';";
const dbMarker = 'this.db = dbInstance.db;';
const boomboxStart = '    initializeBoomboxConverter(this);';

const app = await fs.readFile(appPath, 'utf8');
let nextApp = app;

if (!nextApp.includes("./services/boomboxService.js")) {
    const importAnchor = "import { initializeMusic } from './services/music/riffySetup.js';";
    if (nextApp.includes(importAnchor)) {
        nextApp = nextApp.replace(importAnchor, `${importAnchor}\n${boomboxImport}`);
    } else {
        nextApp = `${boomboxImport}\n${nextApp}`;
    }
}

if (!nextApp.includes(boomboxStart)) {
    if (!nextApp.includes(dbMarker)) {
        throw new Error('Could not find TitanBot database initialization marker in src/app.js. No app.js changes were written.');
    }
    nextApp = nextApp.replace(dbMarker, `${dbMarker}\n\n${boomboxStart}`);
}

await fs.writeFile(appPath, nextApp);

const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
pkg.dependencies ??= {};

const additions = {
    'cheerio': '^1.1.2',
    'ffmpeg-static': '^5.3.0',
    'form-data': '^4.0.4',
    'youtube-dl-exec': '^3.1.15',
};

for (const [name, version] of Object.entries(additions)) {
    if (!pkg.dependencies[name]) pkg.dependencies[name] = version;
}

await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log('SKAW Boombox integration applied.');
console.log('Next: npm install, then npm start.');
