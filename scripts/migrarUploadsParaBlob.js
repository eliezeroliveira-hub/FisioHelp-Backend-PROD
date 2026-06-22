import 'dotenv/config';

import fs from 'fs/promises';
import path from 'path';

import {
  isAzureBlobStorageEnabled,
  normalizeStoragePath,
  uploadFile,
} from '../providers/fileStorageProvider.js';

const uploadsDir = path.resolve(process.cwd(), 'uploads');
const dryRun = process.argv.includes('--dry-run');

const skipDirNames = new Set([
  '_thumbs',
  'tmp',
  'temp',
]);

function shouldSkipDir(dirName) {
  return skipDirNames.has(String(dirName || '').toLowerCase());
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        yield* walk(fullPath);
      }
      continue;
    }

    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function main() {
  if (!isAzureBlobStorageEnabled) {
    throw new Error('Defina FILE_STORAGE_PROVIDER=azure antes de migrar uploads para Blob Storage.');
  }

  try {
    await fs.access(uploadsDir);
  } catch {
    console.log(`[uploads] pasta local nao encontrada: ${uploadsDir}`);
    return;
  }

  let total = 0;
  let enviados = 0;
  let falhas = 0;

  console.log(`[uploads] origem: ${uploadsDir}`);
  console.log(`[uploads] modo: ${dryRun ? 'dry-run' : 'envio real'}`);

  for await (const filePath of walk(uploadsDir)) {
    total += 1;
    const relativePath = normalizeStoragePath(path.relative(uploadsDir, filePath));

    if (dryRun) {
      console.log(`[dry-run] ${relativePath}`);
      continue;
    }

    try {
      await uploadFile(relativePath, filePath);
      enviados += 1;
      console.log(`[ok] ${relativePath}`);
    } catch (err) {
      falhas += 1;
      console.error(`[erro] ${relativePath}: ${err?.message || err}`);
    }
  }

  console.log(`[uploads] total=${total} enviados=${enviados} falhas=${falhas}`);

  if (falhas > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[uploads] falha fatal: ${err?.message || err}`);
  process.exitCode = 1;
});
