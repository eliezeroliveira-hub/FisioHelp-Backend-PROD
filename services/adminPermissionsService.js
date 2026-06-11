import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

export const ADMIN_PERMISSION_KEYS = [
  'documentos',
  'admins',
  'fisioterapeutas',
  'pacientes',
  'disputas',
  'suporte',
  'parametros',
  'pontuacao',
  'relatorios',
  'relatorios-financeiros',
  'relatorios-plataforma',
];

export const DEFAULT_ADMIN_PERMISSIONS = {
  Master: [...ADMIN_PERMISSION_KEYS],
  Suporte: ['documentos', 'fisioterapeutas', 'pacientes', 'disputas', 'suporte'],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERMISSIONS_FILE = path.resolve(__dirname, '../config/adminPermissions.json');

function normalizeProfile(profile) {
  const normalized = String(profile || '').trim().toLowerCase();
  if (normalized === 'master') return 'Master';
  return 'Suporte';
}

function isPermissionKey(value) {
  return ADMIN_PERMISSION_KEYS.includes(String(value || '').trim());
}

function normalizeProfilePermissions(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];

  const unique = [...new Set(
    value
      .map((item) => String(item || '').trim())
      .filter((item) => isPermissionKey(item))
  )];

  return unique.length > 0 ? unique : [...fallback];
}

export function normalizePermissions(value) {
  const raw = value && typeof value === 'object' ? value : {};

  return {
    Master: [...DEFAULT_ADMIN_PERMISSIONS.Master],
    Suporte: normalizeProfilePermissions(raw.Suporte, DEFAULT_ADMIN_PERMISSIONS.Suporte),
  };
}

async function ensurePermissionsFile() {
  try {
    await fs.access(PERMISSIONS_FILE);
  } catch {
    const initial = JSON.stringify(normalizePermissions(null), null, 2);
    await fs.writeFile(PERMISSIONS_FILE, initial, 'utf-8');
  }
}

async function readPermissionsFile() {
  await ensurePermissionsFile();
  const raw = await fs.readFile(PERMISSIONS_FILE, 'utf-8');
  return normalizePermissions(JSON.parse(raw));
}

async function writePermissionsFile(permissions) {
  const normalized = normalizePermissions(permissions);
  await fs.writeFile(PERMISSIONS_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

async function getAdminRecord(usuario) {
  const adminId = Number(usuario?.id);
  if (!Number.isInteger(adminId) || adminId <= 0) {
    throw new HttpError(401, 'Usuário não autenticado.');
  }

  const result = await queryWithContext(
    usuario,
    (request) => request.input('Id', sql.Int, adminId),
    `
      SELECT TOP 1 Id, NivelAcesso, Ativo
      FROM dbo.Administradores
      WHERE Id = @Id;
    `,
    { requireContext: true }
  );

  const row = result.recordset?.[0];
  if (!row) throw new HttpError(404, 'Administrador não encontrado.');
  if (Number(row.Ativo) !== 1) throw new HttpError(403, 'Administrador inativo.');

  return {
    id: Number(row.Id),
    perfil: normalizeProfile(row.NivelAcesso),
  };
}

const adminPermissionsService = {
  async listar() {
    return readPermissionsFile();
  },

  async atualizar(permissions, usuario) {
    const admin = await getAdminRecord(usuario);
    if (admin.perfil !== 'Master') {
      throw new HttpError(403, 'Acesso negado: apenas Admin Master pode alterar permissões.');
    }

    return writePermissionsFile(permissions);
  },

  async obterPerfilAtual(usuario) {
    const admin = await getAdminRecord(usuario);
    return admin.perfil;
  },

  async verificarAcesso(usuario, permissionKey) {
    if (!isPermissionKey(permissionKey)) {
      throw new HttpError(400, 'Permissão inválida.');
    }

    const perfil = await this.obterPerfilAtual(usuario);
    if (perfil === 'Master') return true;

    const permissions = await readPermissionsFile();
    return permissions[perfil].includes(permissionKey);
  },
};

export default adminPermissionsService;
