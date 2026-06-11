//  middleware/uploadArquivos.js
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileTypeFromFile } from 'file-type';

//  Diretórios
const uploadsBase = path.resolve('uploads');
const pastaCertificados = path.join(uploadsBase, 'certificados');
const pastaPedidosMedicos = path.join(uploadsBase, 'pedidos-medicos');
const pastaCheckin = path.join(uploadsBase, 'checkin');

// Garante que a pasta exista
fs.mkdirSync(pastaCertificados, { recursive: true });

// Garante que a pasta de pedidos médicos exista
fs.mkdirSync(pastaPedidosMedicos, { recursive: true });

// Garante que a pasta de evidências de check-in exista
fs.mkdirSync(pastaCheckin, { recursive: true });

//  Tipos permitidos (MIME + extensão)
const EXTENSOES_PERMITIDAS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'];

const MIMES_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
];

const EXTENSOES_PEDIDOS_MEDICOS_PERMITIDAS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'];

const MIMES_PEDIDOS_MEDICOS_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
];

const EXTENSOES_SUPORTE_PERMITIDAS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'];

const MIMES_SUPORTE_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
];

function inferExtensionFromMime(mimetype) {
  const mimeToExt = {
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/heic-sequence': '.heic',
    'image/heif-sequence': '.heif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'application/pdf': '.pdf',
  };

  return mimeToExt[mimetype] ?? '';
}

function normalizeDetectedMime(mimetype) {
  const value = String(mimetype || '').trim().toLowerCase();

  if (value === 'image/heif') return 'image/heic';
  if (value === 'image/heif-sequence') return 'image/heic';
  if (value === 'image/heic-sequence') return 'image/heic';

  return value;
}

function getCompatibleExtensionsForMime(mimetype) {
  switch (normalizeDetectedMime(mimetype)) {
    case 'application/pdf':
      return ['.pdf'];
    case 'image/jpeg':
      return ['.jpg', '.jpeg'];
    case 'image/png':
      return ['.png'];
    case 'image/heic':
      return ['.heic', '.heif'];
    default:
      return [];
  }
}

//  Evidência de check-in: somente imagem
const EXTENSOES_IMAGEM = ['.jpg', '.jpeg', '.png', '.heic', '.heif'];
const MIMES_IMAGEM = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
];

const MAX_UPLOAD_PEDIDO_MEDICO_BYTES = 20 * 1024 * 1024;

function collectReqFiles(req) {
  const files = [];
  if (req?.file) files.push(req.file);

  if (Array.isArray(req?.files)) {
    files.push(...req.files);
  } else if (req?.files && typeof req.files === 'object') {
    for (const v of Object.values(req.files)) {
      if (Array.isArray(v)) files.push(...v);
      else if (v) files.push(v);
    }
  }

  return files.filter((f) => !!f?.path);
}

async function removeFilesSafe(files) {
  await Promise.all(
    (files || []).map(async (f) => {
      try {
        if (f?.path) await fs.promises.unlink(f.path);
      } catch {
        // best-effort
      }
    })
  );
}

function createMagicBytesValidator(allowedMimes, errorMessage) {
  const allowedMimeSet = new Set((allowedMimes || []).map(normalizeDetectedMime));

  return async (req, res, next) => {
    const files = collectReqFiles(req);
    if (files.length === 0) return next();

    const validations = await Promise.all(
      files.map(async (file) => {
        const detected = await fileTypeFromFile(file.path).catch(() => null);
        const detectedMime = normalizeDetectedMime(detected?.mime);
        const uploadedExt = path.extname(String(file?.filename || file?.path || file?.originalname || '')).toLowerCase();
        const compatibleExtensions = getCompatibleExtensionsForMime(detectedMime);
        const extensionMatches =
          compatibleExtensions.length === 0 || compatibleExtensions.includes(uploadedExt);

        return Boolean(detectedMime && allowedMimeSet.has(detectedMime) && extensionMatches);
      })
    );

    if (validations.some((isValid) => !isValid)) {
      await removeFilesSafe(files);
      return res.status(400).json({ erro: errorMessage });
    }

    return next();
  };
}

//  Configuração do armazenamento local
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, pastaCertificados);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    // Se ext vier vazia por algum motivo, bloqueia (evita "arquivo sem extensão")
    if (!ext) {
      const erro = new Error('Arquivo sem extensão não é permitido.');
      erro.code = 'EXTENSAO_INVALIDA';
      return cb(erro);
    }

    // Nome aleatório (não depender do nome original)
    const random = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    // Ex: 1730000000000_a1b2c3...f9.pdf
    return cb(null, `${timestamp}_${random}${ext}`);
  }
});

// Filtro de arquivos – BLOQUEIA tipos suspeitos
const fileFilter = (_req, file, cb) => {
  const mimetype = file.mimetype;
  let ext = path.extname(file.originalname).toLowerCase();

  if (!ext) {
    ext = inferExtensionFromMime(mimetype);
  }

  const mimeValido = MIMES_PERMITIDOS.includes(mimetype);
  const extValida = EXTENSOES_PERMITIDAS.includes(ext);

  if (mimeValido && extValida) return cb(null, true);

  // EXE, ZIP, scripts etc.
  const erro = new Error('Tipo de arquivo não permitido. Envie apenas PDF, JPG, PNG, HEIC ou HEIF.');
  erro.code = 'TIPO_ARQUIVO_INVALIDO';
  return cb(erro, false);
};

const fileFilterSuporte = (_req, file, cb) => {
  const mimetype = file.mimetype;
  let ext = path.extname(file.originalname).toLowerCase();

  if (!ext) {
    ext = inferExtensionFromMime(mimetype);
  }

  const mimeValido = MIMES_SUPORTE_PERMITIDOS.includes(mimetype);
  const extValida = EXTENSOES_SUPORTE_PERMITIDAS.includes(ext);

  if (mimeValido && extValida) return cb(null, true);

  const erro = new Error('Tipo de arquivo não permitido. Envie apenas PDF, JPG, PNG, HEIC ou HEIF.');
  erro.code = 'TIPO_ARQUIVO_INVALIDO';
  return cb(erro, false);
};

const fileFilterPedidosMedicos = (_req, file, cb) => {
  const mimetype = file.mimetype;
  let ext = path.extname(file.originalname).toLowerCase();

  if (!ext) {
    ext = inferExtensionFromMime(mimetype);
  }

  const mimeValido = MIMES_PEDIDOS_MEDICOS_PERMITIDOS.includes(mimetype);
  const extValida = EXTENSOES_PEDIDOS_MEDICOS_PERMITIDAS.includes(ext);

  if (mimeValido && extValida) return cb(null, true);

  const erro = new Error('Tipo de arquivo não permitido. Envie apenas PDF, JPG, PNG ou HEIC.');
  erro.code = 'TIPO_ARQUIVO_INVALIDO';
  return cb(erro, false);
};

//  Pasta Suporte (anexos) — salva em uploads/faleconosco/tmp
const pastaFaleConoscoTmp = path.join(uploadsBase, 'faleconosco', 'tmp');

// Garante que a pasta de fale conosco exista
fs.mkdirSync(pastaFaleConoscoTmp, { recursive: true });

//  Configuração do armazenamento local (FALE CONOSCO - TMP)
const storageFaleConoscoTmp = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, pastaFaleConoscoTmp);
  },

  filename: (_req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();

    if (!ext) {
      ext = inferExtensionFromMime(file.mimetype);
    }

    if (!ext) {
      const erro = new Error('Arquivo sem extensão não é permitido.');
      erro.code = 'EXTENSAO_INVALIDA';
      return cb(erro);
    }

    const random = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    return cb(null, `${timestamp}_${random}${ext}`);
  }
});

//  Limites — anexos Suporte (mesmo filtro de tipos do arquivo)
const uploadFaleConoscoAnexos = multer({
  storage: storageFaleConoscoTmp,
  fileFilter: fileFilterSuporte,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB (ajuste se quiser)
  }
});


// Filtro para evidência de check-in (JPG/PNG/HEIC/HEIF)
const fileFilterImagem = (_req, file, cb) => {
  const mimetype = file.mimetype;
  let ext = path.extname(file.originalname).toLowerCase();

  if (!ext) {
    ext = inferExtensionFromMime(mimetype);
  }

  const mimeValido = MIMES_IMAGEM.includes(mimetype);
  const extValida = EXTENSOES_IMAGEM.includes(ext);

  if (mimeValido && extValida) return cb(null, true);

  const erro = new Error('Tipo de arquivo não permitido. Envie apenas JPG, PNG ou HEIC.');
  erro.code = 'TIPO_ARQUIVO_INVALIDO';
  return cb(erro, false);
};

// Limites (ex: 5 MB)
const uploadCertificados = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB
  }
});


//  Configuração do armazenamento local (PEDIDOS MÉDICOS)
const storagePedidosMedicos = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, pastaPedidosMedicos);
  },

  filename: (_req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();

    if (!ext) {
      ext = inferExtensionFromMime(file.mimetype);
    }

    if (!ext) {
      const erro = new Error('Arquivo sem extensão não é permitido.');
      erro.code = 'EXTENSAO_INVALIDA';
      return cb(erro);
    }

    const random = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    return cb(null, `${timestamp}_${random}${ext}`);
  }
});

//  Evidência de check-in (1 foto)
const storageCheckin = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, pastaCheckin);
  },

  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();

    if (!ext) {
      ext = inferExtensionFromMime(file.mimetype);
    }

    if (!ext) {
      const erro = new Error('Arquivo sem extensão não é permitido.');
      erro.code = 'EXTENSAO_INVALIDA';
      return cb(erro);
    }

    const random = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    // tenta usar o :id da rota (/consultas/:id/comparecimento)
    const rawId = String(req?.params?.id ?? '').trim();
    const safeId = rawId.replace(/\D/g, '');
    const prefix = safeId ? `checkin_${safeId}` : 'checkin';

    return cb(null, `${prefix}_${timestamp}_${random}${ext}`);
  }
});

//  Limites (ex: 5 MB) — pedidos médicos
const uploadPedidosMedicos = multer({
  storage: storagePedidosMedicos,
  fileFilter: fileFilterPedidosMedicos,
  limits: {
    fileSize: MAX_UPLOAD_PEDIDO_MEDICO_BYTES // 20 MB
  }
});

//  Limites (ex: 5 MB) — evidência check-in
const uploadEvidenciaCheckin = multer({
  storage: storageCheckin,
  fileFilter: fileFilterImagem,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB
  }
});

const validarMagicBytesCertificados = createMagicBytesValidator(
  MIMES_PERMITIDOS,
  'Conteúdo do arquivo não corresponde a um PDF ou uma imagem válida (JPG, PNG, HEIC ou HEIF).'
);

const validarMagicBytesPedidosMedicos = createMagicBytesValidator(
  MIMES_PEDIDOS_MEDICOS_PERMITIDOS,
  'Conteúdo do arquivo não corresponde a um PDF ou uma imagem válida (JPG, PNG, HEIC ou HEIF).'
);

const validarMagicBytesFaleConoscoAnexos = createMagicBytesValidator(
  MIMES_SUPORTE_PERMITIDOS,
  'Conteúdo do arquivo não corresponde a um PDF ou uma imagem válida (JPG, PNG ou HEIC).'
);

const validarMagicBytesEvidenciaCheckin = createMagicBytesValidator(
  MIMES_IMAGEM,
  'Conteúdo do arquivo não corresponde a uma imagem válida (JPG, PNG ou HEIC).'
);

export {
  uploadPedidosMedicos,
  uploadEvidenciaCheckin,
  uploadFaleConoscoAnexos,
  validarMagicBytesCertificados,
  validarMagicBytesPedidosMedicos,
  validarMagicBytesFaleConoscoAnexos,
  validarMagicBytesEvidenciaCheckin
};

export default uploadCertificados;

/**
 *  Observação importante:
 * - O arquivo será salvo fisicamente em: uploads/certificados
 * - Para gravar NO BANCO, prefira salvar apenas o caminho relativo:
 *   `certificados/${req.file.filename}`
 *
 */
