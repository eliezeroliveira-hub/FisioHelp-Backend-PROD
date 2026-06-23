import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { BlobServiceClient } from '@azure/storage-blob';

import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const LOCAL_UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const MODE = String(ENV.FILE_STORAGE_PROVIDER || 'local').trim().toLowerCase();

export const isAzureBlobStorageEnabled = MODE === 'azure';

let containerClientPromise = null;

function httpError(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode, httpStatus: statusCode });
}

function ensureAzureConfig() {
  if (!ENV.AZURE_STORAGE_CONNECTION_STRING) {
    throw httpError('AZURE_STORAGE_CONNECTION_STRING não configurado.', 500);
  }
  if (!ENV.AZURE_STORAGE_CONTAINER) {
    throw httpError('AZURE_STORAGE_CONTAINER não configurado.', 500);
  }
}

async function getContainerClient() {
  ensureAzureConfig();

  if (!containerClientPromise) {
    containerClientPromise = (async () => {
      const service = BlobServiceClient.fromConnectionString(ENV.AZURE_STORAGE_CONNECTION_STRING);
      const container = service.getContainerClient(ENV.AZURE_STORAGE_CONTAINER);
      await container.createIfNotExists();
      return container;
    })().catch((err) => {
      containerClientPromise = null;
      throw err;
    });
  }

  return containerClientPromise;
}

export function normalizeStoragePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const withoutUploads = raw.replace(/^uploads\//i, '');

  if (!withoutUploads || path.isAbsolute(withoutUploads) || withoutUploads.includes('\0')) {
    throw httpError('Caminho de arquivo inválido.', 400);
  }

  const parts = withoutUploads.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || part.includes('..'))) {
    throw httpError('Caminho de arquivo inválido.', 400);
  }

  return parts.join('/');
}

export function resolveLocalUploadPath(relativePath) {
  const rel = normalizeStoragePath(relativePath);
  const absolute = path.resolve(LOCAL_UPLOADS_DIR, rel);
  const relativeToRoot = path.relative(LOCAL_UPLOADS_DIR, absolute);

  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw httpError('Caminho de arquivo inválido.', 400);
  }

  return absolute;
}

function sameLocalPath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function contentTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.xml') return 'application/xml';
  return 'application/octet-stream';
}

function safeFileName(fileName) {
  return String(fileName || 'arquivo')
    .replace(/[\r\n"]/g, '_')
    .replace(/[\\/]+/g, '_')
    .slice(0, 260) || 'arquivo';
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;

  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) throw httpError('Range inválido.', 416);

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) throw httpError('Range inválido.', 416);

  if (start === null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) throw httpError('Range inválido.', 416);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) throw httpError('Range inválido.', 416);
    if (end === null || end >= size) end = size - 1;
  }

  if (!Number.isFinite(end) || start > end || start >= size) {
    throw httpError('Range inválido.', 416);
  }

  return { start, end, count: end - start + 1 };
}

export async function uploadFile(relativePath, sourceFilePath, options = {}) {
  const rel = normalizeStoragePath(relativePath);

  if (!isAzureBlobStorageEnabled) {
    const destination = resolveLocalUploadPath(rel);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (!sameLocalPath(sourceFilePath, destination)) {
      await fs.promises.copyFile(sourceFilePath, destination);
    }
    return { relativePath: rel };
  }

  const container = await getContainerClient();
  const client = container.getBlockBlobClient(rel);
  await client.uploadFile(sourceFilePath, {
    blobHTTPHeaders: {
      blobContentType: options.contentType || contentTypeFromPath(rel),
      blobCacheControl: options.cacheControl,
    },
  });
  return { relativePath: rel, url: client.url };
}

export async function uploadBuffer(relativePath, buffer, options = {}) {
  const rel = normalizeStoragePath(relativePath);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');

  if (!isAzureBlobStorageEnabled) {
    const destination = resolveLocalUploadPath(rel);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, data);
    return { relativePath: rel };
  }

  const container = await getContainerClient();
  const client = container.getBlockBlobClient(rel);
  await client.uploadData(data, {
    blobHTTPHeaders: {
      blobContentType: options.contentType || contentTypeFromPath(rel),
      blobCacheControl: options.cacheControl,
    },
  });
  return { relativePath: rel, url: client.url };
}

export async function deleteFile(relativePath) {
  const rel = normalizeStoragePath(relativePath);

  if (!isAzureBlobStorageEnabled) {
    const absolute = resolveLocalUploadPath(rel);
    await fs.promises.unlink(absolute).catch((err) => {
      if (err?.code !== 'ENOENT') throw err;
    });
    return;
  }

  const container = await getContainerClient();
  await container.getBlockBlobClient(rel).deleteIfExists();
}

export async function fileExists(relativePath) {
  const rel = normalizeStoragePath(relativePath);

  if (!isAzureBlobStorageEnabled) {
    try {
      await fs.promises.access(resolveLocalUploadPath(rel), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  const container = await getContainerClient();
  return container.getBlockBlobClient(rel).exists();
}

export async function downloadToFile(relativePath, targetFilePath) {
  const rel = normalizeStoragePath(relativePath);
  await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });

  if (!isAzureBlobStorageEnabled) {
    const source = resolveLocalUploadPath(rel);
    if (!sameLocalPath(source, targetFilePath)) {
      await fs.promises.copyFile(source, targetFilePath);
    }
    return targetFilePath;
  }

  const container = await getContainerClient();
  await container.getBlockBlobClient(rel).downloadToFile(targetFilePath);
  return targetFilePath;
}

export async function sendFile(res, relativePath, options = {}) {
  const rel = normalizeStoragePath(relativePath);
  const disposition = options.disposition || 'inline';
  const fileName = safeFileName(options.fileName || path.basename(rel));
  const cacheControl = options.cacheControl || 'no-store';
  const rangeHeader = options.rangeHeader;

  if (!isAzureBlobStorageEnabled) {
    const absolute = resolveLocalUploadPath(rel);
    let stat;
    try {
      stat = await fs.promises.stat(absolute);
    } catch (err) {
      if (err?.code === 'ENOENT') throw httpError('Arquivo não existe no servidor.', 404);
      throw err;
    }

    const range = parseRange(rangeHeader, stat.size);
    res.setHeader('Content-Type', options.contentType || contentTypeFromPath(rel));
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader('Content-Length', range.count);
      return pipeline(fs.createReadStream(absolute, { start: range.start, end: range.end }), res);
    }

    res.setHeader('Content-Length', stat.size);
    return pipeline(fs.createReadStream(absolute), res);
  }

  const container = await getContainerClient();
  const client = container.getBlockBlobClient(rel);
  let properties;
  try {
    properties = await client.getProperties();
  } catch (err) {
    if (err?.statusCode === 404) throw httpError('Arquivo não existe no servidor.', 404);
    throw err;
  }

  const size = Number(properties.contentLength || 0);
  const range = parseRange(rangeHeader, size);
  const download = range
    ? await client.download(range.start, range.count)
    : await client.download();

  res.setHeader('Content-Type', options.contentType || properties.contentType || contentTypeFromPath(rel));
  res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', range.count);
  } else {
    res.setHeader('Content-Length', size);
  }

  if (!download.readableStreamBody) {
    throw httpError('Falha ao abrir stream do arquivo.', 500);
  }

  return pipeline(download.readableStreamBody, res);
}

export async function cleanupLocalTempFile(filePath) {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch((err) => {
    if (err?.code !== 'ENOENT') {
      log('warn', '[storage] falha ao limpar arquivo temporário', { erro: err?.message });
    }
  });
}

export default {
  isAzureBlobStorageEnabled,
  normalizeStoragePath,
  resolveLocalUploadPath,
  uploadFile,
  uploadBuffer,
  deleteFile,
  fileExists,
  downloadToFile,
  sendFile,
  cleanupLocalTempFile,
};