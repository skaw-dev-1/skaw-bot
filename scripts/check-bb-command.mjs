import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('src/commands');
const matches = [];

async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            const text = await fs.readFile(full, 'utf8');
            if (/\.setName\(\s*['"]bb['"]\s*\)/.test(text)) matches.push(path.relative(process.cwd(), full));
        }
    }
}

await walk(root);
console.log('Slash command files registering /bb:');
for (const file of matches) console.log(`- ${file}`);
if (matches.length > 1) {
    console.error('\nERROR: more than one command file registers /bb. Keep only the v3 /bb command.');
    process.exitCode = 1;
} else if (matches.length === 1) {
    console.log('\nOK: exactly one /bb command found.');
} else {
    console.error('\nERROR: no /bb command found.');
    process.exitCode = 1;
}
