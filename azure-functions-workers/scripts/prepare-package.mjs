import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const backendRoot = path.resolve(packageRoot, '..');
const distRoot = path.join(packageRoot, 'dist');

const packageEntries = ['src', 'host.json', 'package.json', 'package-lock.json'];
const backendEntries = ['workers', 'services', 'providers', 'config', 'utils'];
const funcignore = `local.settings.json
.git/
.gitignore
.vscode/
*.zip
`;

async function copyEntry(from, to) {
  await cp(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

for (const entry of packageEntries) {
  await copyEntry(path.join(packageRoot, entry), path.join(distRoot, entry));
}

for (const entry of backendEntries) {
  await copyEntry(path.join(backendRoot, entry), path.join(distRoot, entry));
}

await writeFile(path.join(distRoot, '.funcignore'), funcignore);

console.log(`Pacote de workers preparado em ${distRoot}`);
