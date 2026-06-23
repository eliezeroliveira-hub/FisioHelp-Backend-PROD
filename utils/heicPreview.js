import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

import { log } from '../config/logger.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';

const MAX_HEIC_BYTES = 10 * 1024 * 1024;
const HEIC_CONVERSION_TIMEOUT_MS = 15_000;
const HEIC_PREVIEW_CACHE_CONTROL = 'no-store';

let conversionTail = Promise.resolve();

function toPosixPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

export function isHeicStoragePath(relativePath) {
  const lower = toPosixPath(relativePath).toLowerCase();
  return lower.endsWith('.heic') || lower.endsWith('.heif');
}

export function getHeicPreviewRelativePath(relativePath) {
  const rel = fileStorageProvider.normalizeStoragePath(relativePath);
  const dir = path.posix.dirname(toPosixPath(rel));
  const base = path.posix.basename(rel).replace(/\.(heic|heif)$/i, '');
  return `${dir}/_previews/${base}.jpg`;
}

function runExclusive(task) {
  const run = conversionTail.catch(() => {}).then(task);
  conversionTail = run.catch(() => {});
  return run;
}

async function convertHeicToJpegFile({ inputPath, outputPath }) {
  return new Promise((resolve, reject) => {
    let timer;
    const worker = new Worker(new URL('./heicConvertWorker.js', import.meta.url), {
      workerData: {
        inputPath,
        outputPath,
        quality: 0.88,
      },
    });

    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('Timeout ao converter HEIC para JPEG.'));
    }, HEIC_CONVERSION_TIMEOUT_MS);

    worker.once('message', (msg) => {
      if (msg?.ok) {
        finish(null, msg);
        return;
      }

      const err = new Error(msg?.erro || 'Falha ao converter HEIC para JPEG.');
      if (msg?.stack) err.stack = msg.stack;
      finish(err);
    });

    worker.once('error', (err) => finish(err));
    worker.once('exit', (code) => {
      if (code !== 0) {
        finish(new Error(`Worker HEIC finalizado com codigo ${code}.`));
      }
    });
  });
}

async function validateSourceSize(sourceFilePath) {
  const stat = await fs.promises.stat(sourceFilePath);
  if (stat.size > MAX_HEIC_BYTES) {
    throw new Error('Arquivo HEIC excede o tamanho maximo para preview.');
  }
  return stat.size;
}

export async function createHeicPreviewFromFile({ sourceFilePath, sourceRelativePath }) {
  if (!isHeicStoragePath(sourceRelativePath)) return null;

  await validateSourceSize(sourceFilePath);

  const previewRel = getHeicPreviewRelativePath(sourceRelativePath);
  const outputPath = path.join(
    os.tmpdir(),
    `fisiohelp-heic-preview-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
  );

  try {
    await runExclusive(() => convertHeicToJpegFile({
      inputPath: sourceFilePath,
      outputPath,
    }));

    await fileStorageProvider.uploadFile(previewRel, outputPath, {
      contentType: 'image/jpeg',
      cacheControl: HEIC_PREVIEW_CACHE_CONTROL,
    });

    return previewRel;
  } finally {
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

export async function ensureHeicPreview({ sourceRelativePath }) {
  if (!isHeicStoragePath(sourceRelativePath)) return null;

  const previewRel = getHeicPreviewRelativePath(sourceRelativePath);
  if (await fileStorageProvider.fileExists(previewRel)) {
    return previewRel;
  }

  if (!await fileStorageProvider.fileExists(sourceRelativePath)) {
    return null;
  }

  const inputPath = path.join(
    os.tmpdir(),
    `fisiohelp-heic-source-${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(sourceRelativePath)}`
  );

  try {
    await fileStorageProvider.downloadToFile(sourceRelativePath, inputPath);
    return await createHeicPreviewFromFile({
      sourceFilePath: inputPath,
      sourceRelativePath,
    });
  } catch (err) {
    log('warn', '[heic] falha ao gerar preview HEIC', {
      caminho: sourceRelativePath,
      erro: err?.message || String(err),
    });
    return null;
  } finally {
    await fs.promises.unlink(inputPath).catch(() => {});
  }
}

export default {
  isHeicStoragePath,
  getHeicPreviewRelativePath,
  createHeicPreviewFromFile,
  ensureHeicPreview,
};
