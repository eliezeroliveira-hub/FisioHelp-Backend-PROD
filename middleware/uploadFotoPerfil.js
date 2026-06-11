// 📁 middleware/uploadFotoPerfil.js
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';

const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

function fileFilter(_req, file, cb) {
  if (MIMES_PERMITIDOS.includes(file.mimetype)) return cb(null, true);

  const err = new Error('Tipo de arquivo não permitido. Envie apenas JPG, PNG ou WEBP.');
  err.code = 'TIPO_ARQUIVO_INVALIDO';
  return cb(err, false);
}

async function validarMagicBytesFotoPerfil(req, res, next) {
  const buffer = req?.file?.buffer;
  if (!buffer) return next();

  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  if (detected?.mime && MIMES_PERMITIDOS.includes(detected.mime)) {
    return next();
  }

  return res.status(400).json({ erro: 'Conteúdo do arquivo não corresponde a uma imagem válida (JPG/PNG/WEBP).' });
}

const uploadFotoPerfil = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

export { validarMagicBytesFotoPerfil };
export default uploadFotoPerfil;
