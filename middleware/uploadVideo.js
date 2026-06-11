// 📁 middleware/uploadVideo.js
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import crypto from 'crypto';
import { fileTypeFromFile } from 'file-type';

const uploadsBase = path.resolve('uploads');
const videosDir = path.join(uploadsBase, 'videos_brutos');

fs.mkdirSync(videosDir, { recursive: true });

// Permitido apenas MP4
const allowedExtensions = ['.mp4'];
const allowedMimeTypes = ['video/mp4'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, videosDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const random = crypto.randomBytes(16).toString('hex');
    const safeName = `${Date.now()}-${random}${ext}`;
    cb(null, safeName);
  }
});

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExtensions.includes(ext)) return cb(new Error('Extensão de vídeo não permitida. Envie apenas arquivos .mp4.'), false);
  if (!allowedMimeTypes.includes(file.mimetype)) return cb(new Error('Tipo de vídeo não permitido. Envie apenas vídeos MP4.'), false);
  return cb(null, true);
}

async function removeFileSafe(filePath) {
  try {
    if (filePath) await fs.promises.unlink(filePath);
  } catch {
    // best-effort
  }
}

async function validarMagicBytesVideoBruto(req, res, next) {
  const filePath = req?.file?.path;
  if (!filePath) return next();

  const detected = await fileTypeFromFile(filePath).catch(() => null);
  if (detected?.mime && allowedMimeTypes.includes(detected.mime)) {
    return next();
  }

  await removeFileSafe(filePath);
  return res.status(400).json({
    sucesso: false,
    mensagem: 'Conteúdo do arquivo não corresponde a um vídeo MP4 válido.'
  });
}

// Ex.: 200MB (ajuste como quiser)
const uploadVideoBruto = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }
});

export { uploadVideoBruto, validarMagicBytesVideoBruto };
