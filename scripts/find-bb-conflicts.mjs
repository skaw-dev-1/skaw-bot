import fs from 'node:fs/promises';
import path from 'node:path';

const roots = ['src'];
const hits = [];

async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
            const text = await fs.readFile(file, 'utf8');
            if (/\.setName\(\s*['"]bb['"]\s*\)/.test(text) || /(^|[^\w])!bb\b/.test(text)) hits.push(path.relative(process.cwd(), file));
        }
    }
}

for (const root of roots) await walk(path.resolve(root));
console.log('Files containing /bb or !bb references:');
for (const hit of hits) console.log(`- ${hit}`);
console.log('\nExpected: the v4 command src/commands/Utility/bb.js plus this intended boombox service.');
console.log('If an OLD /bb or !bb handler exists, remove/rename that old handler before testing.');
