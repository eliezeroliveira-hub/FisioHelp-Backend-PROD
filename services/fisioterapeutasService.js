import bcrypt from 'bcrypt';
import crypto from 'crypto';
import contatoProvider from '../providers/contatoProvider.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { obterPendenciaAvaliacaoFisioterapeuta } from './avaliacoesService.js';
import { HttpError } from '../utils/httpError.js';
import { getContatoSecret } from '../utils/contactSecret.js';
import { isValidCNPJ, isValidCPF, isValidEmail, normalizeEmail as normalizeEmailAddress } from '../utils/identityValidators.js';
import { validatePasswordStrength } from '../utils/passwordPolicy.js';

const APP_TIME_ZONE = 'America/Sao_Paulo';

// --- Utilitários de normalização para verificação de contato ---
function normalizarEmail(email) {
  return normalizeEmailAddress(email);
}

function normalizarTelefoneBR(telefone) {
  // Normaliza para E.164 (BR) de forma best-effort: +55 + DDD + número
  const digits = String(telefone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  return `+${digits}`;
}

function normalizarTelefoneSomenteDigitosBR(telefone) {
  const digits = String(telefone ?? '').replace(/\D/g, '');
  if (!digits) return '';

  // Se vier com 55 + DDD + número, remove o 55
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits.substring(2);
  }

  return digits; // esperado: 10 ou 11 dígitos
}

function normalizeCanalContato(canal) {
  const v = String(canal ?? '').trim().toLowerCase();
  if (v === 'email') return 'Email';
  if (v === 'telefone' || v === 'celular' || v === 'phone') return 'Telefone';
  return null;
}

const YOUTUBE_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/).+/i;
const VERIFICACAO_CONTATO_COOLDOWN_SEGUNDOS = 60;

function inferirCanalPorDestino(destino) {
  const d = String(destino ?? '').trim();
  if (!d) return null;

  // Heurística simples: se parece e-mail -> Email; senão, se parece telefone -> Telefone
  if (d.includes('@')) return 'Email';

  const digits = d.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 13) return 'Telefone';

  return null;
}


function normalizeDestinoContato(canalNorm, destino) {
  if (destino == null) return null;
  if (canalNorm === 'Email') return normalizarEmail(destino);
  if (canalNorm === 'Telefone') return normalizarTelefoneBR(destino);
  return null;
}

function gerarCodigo6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizeOptionalText(value, max = 1000) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeOptionalInt(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (value == null || String(value).trim() === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return n;
}

const PIX_TIPOS_VALIDOS = new Set(['CNPJ', 'EMAIL', 'PHONE', 'EVP']);

function normalizarTipoChavePix(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'TELEFONE' || raw === 'CELULAR') return 'PHONE';
  if (raw === 'ALEATORIA' || raw === 'ALEATÓRIA' || raw === 'CHAVE_ALEATORIA') return 'EVP';
  return PIX_TIPOS_VALIDOS.has(raw) ? raw : null;
}

function normalizarChavePix(tipo, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (tipo === 'CNPJ') {
    const cnpj = raw.replace(/\D/g, '');
    if (!isValidCNPJ(cnpj)) throw new HttpError(400, 'Chave Pix CNPJ inválida.');
    return cnpj;
  }

  if (tipo === 'EMAIL') {
    const email = normalizarEmail(raw);
    if (!isValidEmail(email)) throw new HttpError(400, 'Chave Pix e-mail inválida.');
    return email;
  }

  if (tipo === 'PHONE') {
    const phone = normalizarTelefoneBR(raw);
    const digits = phone.replace(/\D/g, '');
    if (!digits.startsWith('55') || (digits.length !== 12 && digits.length !== 13)) {
      throw new HttpError(400, 'Chave Pix telefone inválida. Use DDD + número.');
    }
    return phone;
  }

  if (tipo === 'EVP') {
    const evp = raw.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evp)) {
      throw new HttpError(400, 'Chave Pix aleatória inválida. Informe a chave no formato UUID.');
    }
    return evp;
  }

  throw new HttpError(400, 'Tipo de chave Pix inválido.');
}

function normalizarAgenciaBancaria(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits || digits.length > 6) {
    throw new HttpError(400, 'Agência inválida. Informe apenas números.');
  }
  return digits;
}

function normalizarContaBancaria(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  const match = raw.match(/^(\d{1,20})-([0-9X])$/);
  if (!match) {
    throw new HttpError(400, 'Conta inválida. Informe a conta com dígito no formato 123456-7.');
  }
  return `${match[1]}-${match[2]}`;
}

function normalizarTipoContaBancaria(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.includes('poup')) return 'Poupança';
  if (raw.includes('corr')) return 'Corrente';
  throw new HttpError(400, 'Tipo de conta bancária inválido.');
}

function normalizarBancoParaRepasse(value) {
  const banco = normalizeOptionalText(value, 80);
  if (!banco || !/^\d{3}\b/.test(banco)) {
    throw new HttpError(400, 'Banco inválido. Selecione um banco da lista.');
  }
  return banco;
}

function gerarSalt16() {
  return crypto.randomBytes(16);
}

function calcularCodigoHash(secret, saltBuf, canal, codigo, destino) {
  const saltHex = Buffer.isBuffer(saltBuf) ? saltBuf.toString('hex') : Buffer.from(saltBuf).toString('hex');
  const canalNorm = normalizeCanalContato(canal) || String(canal || '');
  const msg = `${saltHex}:${String(canalNorm)}:${String(codigo)}:${String(destino)}`;

  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest(); // 32 bytes
}

function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// --- fim utilitários ---

/**
 *  Usa o contexto do JWT quando existir.
 * - Se vier { id, tipo }, usa.
 * - Se vier algo incompleto, cai para null (público).
 */
function safeUsuario(usuario) {
  if (!usuario) return null;

  // Aceita tanto { id, tipo } quanto { usuarioId, tipoUsuario } (compat com controllers antigos)
  const id = usuario.id ?? usuario.usuarioId ?? usuario.UsuarioId ?? null;
  const tipo = usuario.tipo ?? usuario.tipoUsuario ?? usuario.UsuarioTipo ?? null;

  if (!id || !tipo) return null;

  return { id: Number(id), tipo: String(tipo) };
}

function extractSqlDateParts(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
    };
  }

  const raw = String(value).trim().replace(' ', 'T');
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );

  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
  };
}

function extractAppLocalDatePartsFromUtcValue(value) {
  if (value === null || value === undefined) return null;

  let instant = null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    instant = value;
  } else {
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
    instant = new Date(normalized);
    if (Number.isNaN(instant.getTime())) return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const read = (type) => Number(parts.find((item) => item.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

const TERMINAL_STATUS_CONSULTA = [
  'Cancelada',
  'Concluída',
  'Paciente Ausente',
  'Fisioterapeuta Ausente',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildSlotKey(parts) {
  if (!parts) return null;
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function partsToUtcMs(parts) {
  if (!parts) return null;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
}

function hhmmssToMinutes(value) {
  const match = String(value ?? '').trim().match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function mergeMinuteIntervals(intervals) {
  const normalized = intervals
    .filter((item) => Number.isInteger(item?.inicioMin) && Number.isInteger(item?.fimMin) && item.inicioMin < item.fimMin)
    .sort((a, b) => a.inicioMin - b.inicioMin);

  const merged = [];
  for (const interval of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.inicioMin > previous.fimMin) {
      merged.push({ ...interval });
      continue;
    }
    previous.fimMin = Math.max(previous.fimMin, interval.fimMin);
  }
  return merged;
}

function slotInsideAnyInterval(slotInicioMin, slotFimMin, intervals) {
  return intervals.some((interval) => slotInicioMin >= interval.inicioMin && slotFimMin <= interval.fimMin);
}

function slotOverlapsAnyRange(slotInicioMs, slotFimMs, ranges) {
  return ranges.some((range) => range.inicioMs < slotFimMs && range.fimMs > slotInicioMs);
}

async function obterChavesHorariosOcupados(fisioterapeutaId, dataInicio, dataFim, usuario = null) {
  const rs = await queryWithContext(
    safeUsuario(usuario),
    (req) => {
      req.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
      req.input('DataInicio', sql.VarChar(19), dataInicio);
      req.input('DataFim', sql.VarChar(19), dataFim);
      req.input('StatusCancelada', sql.NVarChar(60), TERMINAL_STATUS_CONSULTA[0]);
      req.input('StatusConcluida', sql.NVarChar(60), TERMINAL_STATUS_CONSULTA[1]);
      req.input('StatusPacienteAusente', sql.NVarChar(60), TERMINAL_STATUS_CONSULTA[2]);
      req.input('StatusFisioterapeutaAusente', sql.NVarChar(60), TERMINAL_STATUS_CONSULTA[3]);
    },
    `
      SELECT c.DataHora
      FROM dbo.Consultas c
      WHERE c.FisioterapeutaId = @FisioterapeutaId
        AND c.DataHora >= CONVERT(datetime2, @DataInicio, 126)
        AND c.DataHora < CONVERT(datetime2, @DataFim, 126)
        AND (
          c.Status IS NULL
          OR LTRIM(RTRIM(c.Status)) NOT IN (
            @StatusCancelada,
            @StatusConcluida,
            @StatusPacienteAusente,
            @StatusFisioterapeutaAusente
          )
        );
    `
  );

  const ocupados = new Set();
  for (const row of (rs.recordset || [])) {
    const parts = extractSqlDateParts(row.DataHora);
    const key = buildSlotKey(parts);
    if (key) ocupados.add(key);
  }

  return ocupados;
}

/**
 * Normaliza caminho do certificado para ser RELATIVO dentro de uploads/, no padrão:
 *   certificados/<arquivo>.pdf
 * Aceita entradas absolutas do Windows (C:\...\uploads\certificados\x.pdf) ou relativas.
 */
function normalizarRelCertificadoFromDb(caminhoArquivo) {
  const p = String(caminhoArquivo || '').trim().replace(/\\/g, '/');
  if (!p) return null;

  const lower = p.toLowerCase();

  if (lower.startsWith('certificados/')) return p;

  if (lower.startsWith('uploads/certificados/')) return p.substring('uploads/'.length);

  const marker = '/uploads/certificados/';
  const idx = lower.lastIndexOf(marker);
  if (idx !== -1) {
    return p.substring(idx + '/uploads/'.length); // => certificados/...
  }

  const idx2 = lower.lastIndexOf('certificados/');
  if (idx2 !== -1) return p.substring(idx2);

  // fallback: mantém como veio
  return p;
}

/**
 *  Normaliza qualquer entrada (ex: "188750", "188.750-F", "188750-f") → "188750-F"
 */
function normalizarCrefito(valor) {
  if (!valor) return null;
  const apenasNumeros = valor.toString().replace(/\D/g, '');
  if (apenasNumeros.length < 4 || apenasNumeros.length > 6) {
    throw new HttpError(400, 'CREFITO deve conter entre 4 e 6 números.');
  }
  return `${apenasNumeros}-F`;
}

function toBoolBit(v) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'FALSE') return 0;
  throw new HttpError(400, 'Valor inválido para campo booleano.');
}

async function obterValorMinimoConsulta(usuario) {
  const param = await queryWithContext(
    safeUsuario(usuario),
    null,
    `
    SELECT TOP 1 ValorDecimal
    FROM dbo.ParametrosSistema
    WHERE Nome = 'ValorMinimoConsulta'
    `
  );

  const valorMinimo = param.recordset[0]?.ValorDecimal;
  if (!valorMinimo || Number(valorMinimo) <= 0) {
    throw new HttpError(500, 'Parâmetro ValorMinimoConsulta não configurado.');
  }
  return Number(valorMinimo);
}

//  Campos que FISIOTERAPEUTA NUNCA pode alterar (garantia final)
const CAMPOS_BLOQUEADOS_FISIO = new Set([
  'LinkVideoApresentacao', //  YouTube - somente ADMIN
  'Ativo',
  'IsBloqueado',
  'CrefitoVerificado',
  'PremiumAte',
  'ScoreConfianca',
  'NivelAcesso', // só por segurança, caso alguém envie
]);

// Para blindar também variações de casing (linkVideoApresentacao etc.)
const CAMPOS_BLOQUEADOS_FISIO_LC = new Set(
  Array.from(CAMPOS_BLOQUEADOS_FISIO).map((k) => String(k).toLowerCase())
);

function removerCamposBloqueadosFisio(dados) {
  if (!dados || typeof dados !== 'object') return;
  for (const k of Object.keys(dados)) {
    if (CAMPOS_BLOQUEADOS_FISIO.has(k) || CAMPOS_BLOQUEADOS_FISIO_LC.has(String(k).toLowerCase())) {
      delete dados[k];
    }
  }
}

function normalizarPaginacao(page, pageSize) {
  const p = Number(page);
  const s = Number(pageSize);

  const pagina = Number.isInteger(p) && p > 0 ? p : 1;
  const tamanhoPagina = Number.isInteger(s) && s > 0 ? Math.min(s, 100) : 20;
  const offset = (pagina - 1) * tamanhoPagina;

  return { pagina, tamanhoPagina, offset };
}

function mapFisioterapeutaCreateError(err) {
  const num =
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number;

  const msg = String(
    err?.message ||
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    ''
  ).toLowerCase();

  if (num === 2601 || num === 2627 || msg.includes('duplicate key')) {
    if (
      msg.includes('uq_fisioterapeutas_email') ||
      msg.includes('uq_usuariosemailsunicos_emailnormalizado') ||
      msg.includes('emailnormalizado')
    ) {
      return new HttpError(409, 'E-mail já cadastrado.');
    }
    if (
      msg.includes('uq_usuariostelefonesunicos_telefonenormalizado') ||
      msg.includes('telefonenormalizado') ||
      msg.includes('uq_fisioterapeutas_telefone')
    ) {
      return new HttpError(409, 'Telefone já cadastrado.');
    }
    if (msg.includes('uq_fisioterapeutas_crefito') || msg.includes('crefito')) {
      return new HttpError(409, 'Já existe um fisioterapeuta com esse CREFITO.');
    }
    if (msg.includes('uq_fisioterapeutas_cnpj') || msg.includes('cnpj')) {
      return new HttpError(409, 'Já existe um fisioterapeuta com esse CNPJ.');
    }
    return new HttpError(409, 'Registro duplicado (violação de chave única).');
  }

  // Erros de negócio re-lançados pelo bloco SQL com THROW 50000, @Msg, 1.
  if (num === 50000) {
    if (msg.includes('indicac') || msg.includes('código') || msg.includes('codigo')) {
      return new HttpError(400, 'Código de indicação inválido.');
    }

    if (msg.includes('duplicate key') || msg.includes('chave única') || msg.includes('unique')) {
      if (msg.includes('email')) return new HttpError(409, 'E-mail já cadastrado.');
      if (msg.includes('telefone')) return new HttpError(409, 'Telefone já cadastrado.');
      if (msg.includes('crefito')) return new HttpError(409, 'Já existe um fisioterapeuta com esse CREFITO.');
      if (msg.includes('cnpj')) return new HttpError(409, 'Já existe um fisioterapeuta com esse CNPJ.');
      return new HttpError(409, 'Registro duplicado.');
    }

    return new HttpError(400, 'Erro ao processar cadastro.');
  }

  return err;
}

function mapPreCadastroPacienteError(err) {
  const num =
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number;

  const msg = String(
    err?.message ||
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    ''
  ).toLowerCase();

  if (num === 2601 || num === 2627 || msg.includes('duplicate key')) {
    if (
      msg.includes('email') ||
      msg.includes('uq__paciente__a9d10534031fdd2c') ||
      msg.includes('uq_usuariosemailsunicos_emailnormalizado')
    ) {
      return new HttpError(409, 'E-mail já cadastrado.');
    }
    if (
      msg.includes('telefone') ||
      msg.includes('uq_usuariostelefonesunicos_telefonenormalizado')
    ) {
      return new HttpError(409, 'Telefone já cadastrado.');
    }
    if (
      msg.includes('cpf') ||
      msg.includes('uq__paciente__c1f89731b0dbc1ff')
    ) {
      return new HttpError(409, 'CPF já cadastrado.');
    }
    return new HttpError(409, 'Dados duplicados.');
  }

  return err;
}

const fisioterapeutasService = {
  //  agora aceita usuario opcional (Admin pode chamar com contexto)
  async listarTodos(incluirInativos = false, usuario = null, paginacao = {}) {
    const { tamanhoPagina, offset } = normalizarPaginacao(paginacao?.page, paginacao?.pageSize);
    let query = `
      SELECT
        *,
        COUNT(*) OVER() AS TotalRegistros
      FROM dbo.vw_FisioterapeutaPerfilPublico
    `;
    if (!incluirInativos) query += ` WHERE Ativo = 1 AND CrefitoVerificado = 1`;
    query += `
      ORDER BY FisioterapeutaId ASC
      OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
    `;

    const result = await queryWithContext(safeUsuario(usuario), (req) => {
      req.input('Offset', sql.Int, offset);
      req.input('PageSize', sql.Int, tamanhoPagina);
    }, query);
    return result.recordset;
  },

  //  agora aceita usuario opcional (público por padrão)
  async buscarPerfilPublico(id, usuario = null) {
    const ctx = safeUsuario(usuario);
    const resultado = await queryWithContext(
      ctx,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, id);
      },
      `
        EXEC dbo.SP_Fisioterapeuta_PerfilPublico
          @FisioterapeutaId = @FisioterapeutaId;
      `
    );

    const fisio = resultado.recordsets?.[0]?.[0] || null;
    if (!fisio) return null;

    fisio.Avaliacoes = resultado.recordsets?.[1] || [];
    fisio.Formacoes = await this.listarFormacoesFisioterapeuta(Number(id), ctx);
    fisio.Especialidades = await this.listarEspecialidades(Number(id), ctx);

    if (String(ctx?.tipo || '').toLowerCase() === 'paciente' && Number(ctx?.id) > 0) {
      const pendenciaAvaliacao = await obterPendenciaAvaliacaoFisioterapeuta(
        usuario,
        Number(ctx.id),
        Number(id)
      );

      fisio.PodeAvaliarFisioterapeuta = pendenciaAvaliacao?.PodeAvaliarFisioterapeuta ?? false;
      fisio.ConsultaPendenteAvaliacaoId = pendenciaAvaliacao?.ConsultaPendenteAvaliacaoId ?? null;
    } else {
      fisio.PodeAvaliarFisioterapeuta = false;
      fisio.ConsultaPendenteAvaliacaoId = null;
    }

    return fisio;
  },

  /**
   *  Disponibilidade do fisioterapeuta por data (para Paciente agendar)
   * Usa dbo.SP_Agenda_DisponibilidadePorData
   */
  async obterDisponibilidadePorData(fisioterapeutaId, data, usuario = null) {
    const id = Number(fisioterapeutaId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

    const dataStr = String(data || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) throw new HttpError(400, 'Parâmetro "data" inválido. Use YYYY-MM-DD.');
    const proximoDia = new Date(`${dataStr}T00:00:00`);
    proximoDia.setDate(proximoDia.getDate() + 1);
    const dataFim = `${proximoDia.getFullYear()}-${pad2(proximoDia.getMonth() + 1)}-${pad2(proximoDia.getDate())}T00:00:00`;

    const r = await queryWithContext(
      safeUsuario(usuario),
      (req) => {
        req.input('FisioterapeutaId', sql.Int, id);
        req.input('Data', sql.Date, dataStr);
      },
      `
        EXEC dbo.SP_Agenda_DisponibilidadePorData
          @FisioterapeutaId = @FisioterapeutaId,
          @Data = @Data;
      `
    );

    const ocupados = await obterChavesHorariosOcupados(
      id,
      `${dataStr}T00:00:00`,
      dataFim,
      usuario
    );

    return (r.recordset || []).map((slot) => {
      const key = buildSlotKey(extractSqlDateParts(slot.DataHora));
      if (!key || !ocupados.has(key)) return slot;
      return { ...slot, Disponivel: 0 };
    });
  },

  /**
   *  Calendário do mês (agrupado por dia + horários)
   * - Consulta única em dbo.SP_Agenda_DisponibilidadePorMes.
   * - Ideal para o paciente renderizar o mês inteiro do calendário.
   */
  async obterCalendarioMensal(fisioterapeutaId, ano, mes, usuario = null) {
    const id = Number(fisioterapeutaId);
    const y = Number(ano);
    const m = Number(mes);
    const duracaoMin = 60;

    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');
    if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new HttpError(400, 'Ano inválido.');
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new HttpError(400, 'Mês inválido.');

    const crefitoCheck = await queryWithContext(
      safeUsuario(usuario),
      (req) => req.input('FisioterapeutaId', sql.Int, id),
      `SELECT CrefitoVerificado FROM dbo.Fisioterapeutas WHERE Id = @FisioterapeutaId;`
    );
    if (!crefitoCheck.recordset?.length) throw new HttpError(404, 'Fisioterapeuta não encontrado.');
    if (!crefitoCheck.recordset[0].CrefitoVerificado) {
      throw new HttpError(403, 'Calendário indisponível: CREFITO pendente de verificação.');
    }

    const mesKey = `${y}-${pad2(m)}`;
    const lastDay = new Date(y, m, 0).getDate();
    const nextMonth = new Date(y, m, 1);
    const dataInicioMes = `${mesKey}-01`;
    const dataInicioDateTime = `${dataInicioMes}T00:00:00`;
    const proximoMesStr = `${nextMonth.getFullYear()}-${pad2(nextMonth.getMonth() + 1)}-01`;
    const dataFimDateTime = `${proximoMesStr}T00:00:00`;

    const [ocupados, rs, bloqueiosRs, excecoesRs] = await Promise.all([
      obterChavesHorariosOcupados(
        id,
        dataInicioDateTime,
        dataFimDateTime,
        usuario
      ),
      queryWithContext(
        safeUsuario(usuario),
        (req) => {
          req.input('FisioterapeutaId', sql.Int, id);
          req.input('Ano', sql.SmallInt, y);
          req.input('Mes', sql.TinyInt, m);
        },
        `
          EXEC dbo.SP_Agenda_DisponibilidadePorMes
            @FisioterapeutaId = @FisioterapeutaId,
            @Ano = @Ano,
            @Mes = @Mes;
        `
      ),
      queryWithContext(
        safeUsuario(usuario),
        (req) => {
          req.input('FisioterapeutaId', sql.Int, id);
          req.input('DataInicio', sql.VarChar(19), dataInicioDateTime);
          req.input('DataFim', sql.VarChar(19), dataFimDateTime);
        },
        `
          SELECT
            hb.DataInicio,
            hb.DataFim
          FROM dbo.HorariosBloqueados hb
          WHERE hb.FisioterapeutaId = @FisioterapeutaId
            AND hb.DataInicio < CONVERT(datetime2, @DataFim, 126)
            AND hb.DataFim > CONVERT(datetime2, @DataInicio, 126);
        `
      ),
      queryWithContext(
        safeUsuario(usuario),
        (req) => {
          req.input('FisioterapeutaId', sql.Int, id);
          req.input('DataInicio', sql.Date, dataInicioMes);
          req.input('DataFim', sql.Date, proximoMesStr);
        },
        `
          SELECT
            CONVERT(varchar(10), e.Data, 23) AS Data,
            e.DiaSemDisponibilidade,
            e.Notas,
            CONVERT(varchar(8), i.HoraInicio, 108) AS HoraInicio,
            CONVERT(varchar(8), i.HoraFim, 108) AS HoraFim
          FROM dbo.AgendasExcecoesDia e
          LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
            ON i.ExcecaoDiaId = e.Id
          WHERE e.FisioterapeutaId = @FisioterapeutaId
            AND e.Data >= @DataInicio
            AND e.Data < @DataFim
          ORDER BY e.Data ASC, i.HoraInicio ASC;
        `
      ),
    ]);

    const bloqueios = (bloqueiosRs.recordset || [])
      .map((row) => {
        const inicio = extractAppLocalDatePartsFromUtcValue(row.DataInicio);
        const fim = extractAppLocalDatePartsFromUtcValue(row.DataFim);
        const inicioMs = partsToUtcMs(inicio);
        const fimMs = partsToUtcMs(fim);
        if (inicioMs == null || fimMs == null || inicioMs >= fimMs) return null;
        return { inicioMs, fimMs };
      })
      .filter(Boolean);

    const excecoesPorData = new Map();
    for (const row of (excecoesRs.recordset || [])) {
      const dataStr = String(row.Data || '').trim();
      if (!dataStr) continue;

      const existing = excecoesPorData.get(dataStr) || {
        diaSemDisponibilidade: false,
        intervalos: [],
      };

      existing.diaSemDisponibilidade = existing.diaSemDisponibilidade || Boolean(row.DiaSemDisponibilidade);

      const inicioMin = hhmmssToMinutes(row.HoraInicio);
      const fimMin = hhmmssToMinutes(row.HoraFim);
      if (Number.isInteger(inicioMin) && Number.isInteger(fimMin) && inicioMin < fimMin) {
        existing.intervalos.push({ inicioMin, fimMin });
      }

      excecoesPorData.set(dataStr, existing);
    }

    for (const [date, value] of excecoesPorData.entries()) {
      excecoesPorData.set(date, {
        diaSemDisponibilidade: value.diaSemDisponibilidade,
        intervalos: mergeMinuteIntervals(value.intervalos),
      });
    }

    const dias = [];
    const diasMap = new Map();

    for (let day = 1; day <= lastDay; day++) {
      const dataStr = `${y}-${pad2(m)}-${pad2(day)}`;
      const dia = {
        Data: dataStr,
        Slots: [],
        HorariosDisponiveis: []
      };
      dias.push(dia);
      diasMap.set(dataStr, dia);
    }

    for (const r of (rs.recordset || [])) {
      const parts = extractSqlDateParts(r.DataHora);
      if (!parts) continue;

      const hh = pad2(parts.hour);
      const mm = pad2(parts.minute);
      const ss = pad2(parts.second);
      const dataStr = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
      const dia = diasMap.get(dataStr);
      if (!dia) continue;
      const slotKey = buildSlotKey(parts);
      const slotInicioMin = parts.hour * 60 + parts.minute;
      const slotFimMin = slotInicioMin + duracaoMin;
      const slotInicioMs = partsToUtcMs(parts);
      const slotFimMs = slotInicioMs == null ? null : slotInicioMs + duracaoMin * 60 * 1000;
      const excecao = excecoesPorData.get(dataStr);

      let disponivel =
        (r.Disponivel === true || r.Disponivel === 1) && !ocupados.has(slotKey)
          ? 1
          : 0;

      if (disponivel && excecao) {
        if (excecao.diaSemDisponibilidade) {
          disponivel = 0;
        } else if (!slotInsideAnyInterval(slotInicioMin, slotFimMin, excecao.intervalos)) {
          disponivel = 0;
        }
      }

      if (disponivel && slotInicioMs != null && slotFimMs != null && slotOverlapsAnyRange(slotInicioMs, slotFimMs, bloqueios)) {
        disponivel = 0;
      }

      const slot = {
        DataHora: `${dataStr}T${hh}:${mm}:${ss}`,
        Hora: `${hh}:${mm}`,
        Disponivel: disponivel
      };

      dia.Slots.push(slot);
      if (slot.Disponivel === 1) dia.HorariosDisponiveis.push(slot.Hora);
    }

    let totalSlots = 0;
    let totalDisponiveis = 0;
    let diasComDisponibilidade = 0;

    for (const dia of dias) {
      totalSlots += dia.Slots.length;
      totalDisponiveis += dia.HorariosDisponiveis.length;
      if (dia.HorariosDisponiveis.length > 0) diasComDisponibilidade += 1;
    }

    return {
      FisioterapeutaId: id,
      Mes: mesKey,
      Resumo: {
        DiasNoMes: lastDay,
        DiasComDisponibilidade: diasComDisponibilidade,
        TotalSlots: totalSlots,
        TotalHorariosDisponiveis: totalDisponiveis
      },
      Dias: dias
    };
  },

  //  Perfil completo (pensado para área logada)
  //  agora recebe usuario do JWT (evita "forjar" contexto)
  async buscarPerfilCompleto(id, usuario = null) {
    // compatibilidade: se não vier usuario, mantém o comportamento antigo
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };

    const resultado = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, id);
    }, `
      SELECT
        v.FisioterapeutaId,
        v.Nome,
        f.CNPJ,
        f.Email,
        f.EmailVerificado,
        f.Telefone,
        f.TelefoneVerificado,
        f.Genero,
        v.Especialidade,
        v.Cidade,
        v.Estado,
        v.Descricao,
        v.CREFITO,
        v.CrefitoVerificado,
        v.ToleranciaCancelamentoMinutos,
        v.ConfirmacaoAutomatica,
        v.LinkVideoApresentacao,
        v.FotoPerfilDocumentoId,
        v.FotoPerfilUrl,
        v.ValorConsultaBase,
        v.DescontoPacote,
        v.ValorLiquidoFisioterapeuta,
        v.TipoContaBancaria,
        v.Banco,
        v.Agencia,
        v.Conta,
        f.ChavePix,
        f.TipoChavePix,
        f.PixAtualizadoEm,
        v.SaldoAtual,
        v.TotalRecebido,
        v.UltimoPagamento,
        v.MediaAvaliacoes,
        v.TotalAvaliacoes,
        v.TotalAtendimentos,
        v.Curso,
        v.Instituicao,
        v.AnoInicio,
        v.AnoFim,
        v.AnoConclusao,
        v.TipoFormacao,
        v.CaminhoArquivo,
        v.UrlCredencial,
        v.Ativo,
        v.IsBloqueado,
        v.DataCadastro
      FROM dbo.vw_FisioterapeutaPerfilCompleto v
      INNER JOIN dbo.Fisioterapeutas f
        ON f.Id = v.FisioterapeutaId
      WHERE v.FisioterapeutaId = @Id;

      SELECT
        Id,
        Curso,
        Instituicao,
        MesInicio,
        AnoInicio,
        MesFim,
        AnoFim,
        AnoConclusao,
        TipoFormacao,
        Descricao,
        IdCredencial,
        UrlCredencial
      FROM dbo.vw_FormacoesFisioterapeutas
      WHERE FisioterapeutaId = @Id
      ORDER BY Id DESC;
    `);

    const fisio = resultado.recordsets?.[0]?.[0] || null;
    if (!fisio) return null;

    fisio.Especialidades = await this.listarEspecialidades(Number(id), ctx);

    // Formações/certificados no mesmo roundtrip (2º resultset).
    fisio.Formacoes = (resultado.recordsets?.[1] || []).map((r) => ({
      Id: r.Id ?? null,
      Curso: r.Curso ?? null,
      Instituicao: r.Instituicao ?? null,
      MesInicio: r.MesInicio ?? null,
      AnoInicio: r.AnoInicio ?? null,
      MesFim: r.MesFim ?? null,
      AnoFim: r.AnoFim ?? null,
      AnoConclusao: r.AnoConclusao ?? null,
      TipoFormacao: r.TipoFormacao ?? null,
      Descricao: r.Descricao ?? null,
      IdCredencial: r.IdCredencial ?? null,
      UrlCredencial: r.UrlCredencial ?? null,
      Media: `/api/arquivos/certificados/${r.Id}/visualizar`,
      Thumbnail: `/api/arquivos/certificados/${r.Id}/thumbnail`
    }));

    return fisio;
  },

  /**
   *  Formaçoes/Certificados do fisioterapeuta (para "Meu perfil (completo)")
   * Usa dbo.vw_FormacoesFisioterapeutas e filtra por FisioterapeutaId.
   * Retorna somente campos úteis e omite campos null/undefined/"".
   */
  async listarFormacoesFisioterapeuta(fisioterapeutaId, usuario = null) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    const result = await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    }, `
      SELECT
        Id,
        Curso,
        Instituicao,
        MesInicio,
        AnoInicio,
        MesFim,
        AnoFim,
        AnoConclusao,
        TipoFormacao,
        Descricao,
        IdCredencial,
        UrlCredencial
      FROM dbo.vw_FormacoesFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
      ORDER BY Id DESC;
    `);

    return (result.recordset || []).map((r) => ({
      Id: r.Id ?? null,
      Curso: r.Curso ?? null,
      Instituicao: r.Instituicao ?? null,
      MesInicio: r.MesInicio ?? null,
      AnoInicio: r.AnoInicio ?? null,
      MesFim: r.MesFim ?? null,
      AnoFim: r.AnoFim ?? null,
      AnoConclusao: r.AnoConclusao ?? null,
      TipoFormacao: r.TipoFormacao ?? null,
      Descricao: r.Descricao ?? null,
      IdCredencial: r.IdCredencial ?? null,
      UrlCredencial: r.UrlCredencial ?? null,

      //  "Media" (mídia/arquivo) = URL do PDF inline (serve o arquivo real salvo em CaminhoArquivo)
      Media: `/api/arquivos/certificados/${r.Id}/visualizar`,

      //  Thumbnail para LinkedIn-like (gera só para PDF na rota específica)
      Thumbnail: `/api/arquivos/certificados/${r.Id}/thumbnail`
    }));
},

  /**
   *  Lista de avaliações do fisioterapeuta logado
   * Usa dbo.AvaliacoesFisioterapeutas + dbo.Pacientes para devolver o nome do paciente.
   */
  async listarAvaliacoesFisioterapeuta(id, usuario = null) {
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };

    const resultado = await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, id);
      },
      `
      SELECT
        a.Id AS AvaliacaoId,
        a.ConsultaId,
        a.PacienteId,
        a.FisioterapeutaId,
        p.Nome AS NomePaciente,
        a.Nota,
        a.Comentario,
        a.DataAvaliacao
      FROM dbo.AvaliacoesFisioterapeutas a
      LEFT JOIN dbo.Pacientes p
        ON p.Id = a.PacienteId
      WHERE a.FisioterapeutaId = @Id
      ORDER BY a.DataAvaliacao DESC, a.Id DESC
    `
    );

    return resultado.recordset;
  },

    /**
   *  Resumo de avaliações (média/total/última) do fisioterapeuta logado
   * Usa analytics.vw_FisioAvaliacoesMedia e respeita o contexto (RLS) do JWT.
   */
  async obterResumoAvaliacoesFisioterapeuta(id, usuario = null) {
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };

    const r = await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, id);
      },
      `
        SELECT TOP 1
          FisioterapeutaId,
          MediaNota,
          TotalAvaliacoes,
          UltimaAvaliacao,
          AtualizadoEm
        FROM analytics.vw_FisioAvaliacoesMedia
        WHERE FisioterapeutaId = @Id
      `
    );

    // Se não houver avaliações, devolvemos um resumo vazio (frontend pode exibir "sem avaliações")
    return r.recordset?.[0] || {
      FisioterapeutaId: id,
      MediaNota: 0,
      TotalAvaliacoes: 0,
      UltimaAvaliacao: null,
      AtualizadoEm: null
    };
  },

  //  agora aceita usuario opcional (público por padrão)
  async buscarComFiltros(
    { cidade, estado, especialidade, precoMax, data, lat, lon, raioKm, page, pageSize },
    usuario = null
  ) {
    const { tamanhoPagina, offset } = normalizarPaginacao(page, pageSize);

    let dataFiltro = null;
    if (data != null && data !== '') {
      const dataStr = String(data).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
        throw new HttpError(400, 'Parâmetro "data" inválido. Use YYYY-MM-DD.');
      }
      dataFiltro = dataStr;
    }

    const temDistancia = lat != null && lon != null && raioKm != null;
    let latNum = null;
    let lonNum = null;
    let raioNum = null;
    if (temDistancia) {
      latNum = Number(lat);
      lonNum = Number(lon);
      raioNum = Number(raioKm);
      if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
        throw new HttpError(400, 'lat inválido (−90 a 90).');
      }
      if (!Number.isFinite(lonNum) || lonNum < -180 || lonNum > 180) {
        throw new HttpError(400, 'lon inválido (−180 a 180).');
      }
      if (!Number.isFinite(raioNum) || raioNum <= 0 || raioNum > 500) {
        throw new HttpError(400, 'raioKm inválido (1–500).');
      }
    }

    const result = await queryWithContext(
      safeUsuario(usuario),
      (req) => {
        req.input('Cidade', sql.NVarChar(200), cidade ? String(cidade).trim() : null);
        req.input('Estado', sql.Char(2), estado ? String(estado).trim().toUpperCase() : null);
        req.input('Especialidade', sql.NVarChar(200), especialidade ? String(especialidade).trim() : null);
        req.input(
          'PrecoMax',
          sql.Decimal(10, 2),
          precoMax !== undefined && precoMax !== null && precoMax !== '' ? Number(precoMax) : null
        );
        req.input('DataFiltro', sql.Date, dataFiltro);
        req.input('Lat', sql.Decimal(9, 6), temDistancia ? latNum : null);
        req.input('Lon', sql.Decimal(9, 6), temDistancia ? lonNum : null);
        req.input('RaioKm', sql.Decimal(6, 2), temDistancia ? raioNum : null);
        req.input('Offset', sql.Int, offset);
        req.input('PageSize', sql.Int, tamanhoPagina);
      },
      `
        EXEC dbo.SP_Fisioterapeutas_BuscarPublico
          @Cidade = @Cidade,
          @Estado = @Estado,
          @Especialidade = @Especialidade,
          @PrecoMax = @PrecoMax,
          @DataFiltro = @DataFiltro,
          @Lat = @Lat,
          @Lon = @Lon,
          @RaioKm = @RaioKm,
          @Offset = @Offset,
          @PageSize = @PageSize;
      `
    );

    return result.recordset;
  },

  /**
   *  Valida se uma especialidade existe na vw_Especialidades (por Nome)
   * Usado no PATCH /fisioterapeutas/me/especialidade
   */
  async validarEspecialidade(nome, usuario = null) {
    const n = String(nome || '').trim();
    if (!n) return false;

    const r = await queryWithContext(
      safeUsuario(usuario),
      (req) => {
        req.input('Nome', sql.VarChar(200), n);
      },
      `
        SELECT TOP 1 1 AS Ok
        FROM dbo.vw_Especialidades
        WHERE Nome = @Nome;
      `
    );

    return r.recordset.length > 0;
  },

  async listarEspecialidades(fisioId, usuario = null) {
    const id = Number(fisioId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };
    const r = await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, id);
    }, `
      EXEC dbo.SP_FisioEspecialidades_Listar
        @FisioterapeutaId = @FisioterapeutaId;
    `);

    return r.recordset || [];
  },

  async salvarEspecialidades(fisioId, especialidades, usuario = null) {
    const id = Number(fisioId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

    if (!Array.isArray(especialidades) || especialidades.length === 0) {
      throw new HttpError(400, 'A lista de especialidades não pode estar vazia.');
    }

    // Validação de valor mínimo no backend antes de chegar na SP
    const valorMinimo = await obterValorMinimoConsulta(usuario);
    for (const esp of especialidades) {
      const val = Number(esp?.ValorConsultaBase ?? esp?.valorConsultaBase);
      if (!Number.isFinite(val) || val <= 0) {
        throw new HttpError(400, 'ValorConsultaBase deve ser maior que zero em todas as especialidades.');
      }
      if (val < valorMinimo) {
        throw new HttpError(400, `ValorConsultaBase não pode ser menor que o mínimo (${valorMinimo}).`);
      }
    }

    // Validar cada EspecialidadeId (inteiro positivo e sem duplicidade) e exatamente um Principal
    const idsEspecialidades = new Set();

    for (const esp of especialidades) {
      const espId = Number(esp?.EspecialidadeId ?? esp?.especialidadeId);

      if (!Number.isInteger(espId) || espId <= 0) {
        throw new HttpError(400, 'Cada especialidade deve ter um EspecialidadeId inteiro positivo.');
      }

      if (idsEspecialidades.has(espId)) {
        throw new HttpError(400, 'EspecialidadeId duplicado na lista de especialidades.');
      }

      idsEspecialidades.add(espId);
    }

    const totalPrincipais = especialidades.filter(
      (e) => e?.Principal === true || e?.Principal === 1 || e?.principal === true || e?.principal === 1
    ).length;
    if (totalPrincipais === 0) throw new HttpError(400, 'Exatamente uma especialidade deve ser marcada como Principal.');
    if (totalPrincipais > 1)   throw new HttpError(400, 'Somente uma especialidade pode ser marcada como Principal.');

    // Normaliza para o formato esperado pela SP
    const payload = especialidades.map((e) => ({
      EspecialidadeId: Number(e?.EspecialidadeId ?? e?.especialidadeId),
      ValorConsultaBase: Number(e?.ValorConsultaBase ?? e?.valorConsultaBase),
      Principal: e?.Principal === true || e?.Principal === 1 || e?.principal === true || e?.principal === 1 ? 1 : 0
    }));

    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };
    await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, id);
      req.input('EspecialidadesJson', sql.NVarChar(sql.MAX), JSON.stringify(payload));
    }, `
      EXEC dbo.SP_FisioEspecialidades_Salvar
        @FisioterapeutaId  = @FisioterapeutaId,
        @EspecialidadesJson = @EspecialidadesJson;
    `);
  },

  // ================================================================
  //  CRIAR FISIOTERAPEUTA – com normalização de CREFITO
  // ================================================================
  async criar(dados) {
    const {
      Nome,
      CREFITO,
      Email,
      Telefone,
      Cidade,
      Estado,
      EspecialidadeId,
      CNPJ,
      Senha,
      ValorConsultaBase,
      CodigoIndicacao,
      Genero,
    } = dados;
    try {

    if (!Nome || !CREFITO || !Email || !Telefone || !Cidade || !Estado || !EspecialidadeId || !CNPJ || !Senha) {
      throw new HttpError(400, 'Campos obrigatórios ausentes.');
    }
    const GENEROS_VALIDOS = ['Masculino', 'Feminino'];
    if (!Genero || !GENEROS_VALIDOS.includes(Genero)) {
      throw new HttpError(400, 'Gênero é obrigatório. Informe Masculino ou Feminino.');
    }
    validatePasswordStrength(Senha);

    const emailNorm = normalizarEmail(Email);
    const telefoneNorm = normalizarTelefoneSomenteDigitosBR(Telefone);
    const especialidadeIdNum = Number.parseInt(String(EspecialidadeId), 10);

    if (!isValidEmail(emailNorm)) {
      throw new HttpError(400, 'E-mail inválido.');
    }

    if (!telefoneNorm || telefoneNorm.length < 10 || telefoneNorm.length > 11) {
      throw new HttpError(400, 'Telefone inválido: use DDD + número (10 ou 11 dígitos).');
    }

    if (!Number.isInteger(especialidadeIdNum) || especialidadeIdNum <= 0) {
      throw new HttpError(400, 'EspecialidadeId inválido.');
    }

    const crefito = normalizarCrefito(CREFITO);
    const uf = Estado.toUpperCase().trim();
    const cnpj = String(CNPJ).replace(/\D/g, '');

    if (!/^[A-Z]{2}$/.test(uf)) throw new HttpError(400, 'Estado inválido. Use sigla UF, ex.: SP.');
    if (!isValidCNPJ(cnpj)) throw new HttpError(400, 'CNPJ inválido.');

    // Especialidade via ID (somente opções disponíveis)
    const esp = await queryWithContext(
      null,
      (req) => {
        req.input('Id', sql.Int, especialidadeIdNum);
      },
      `SELECT Nome FROM dbo.vw_Especialidades WHERE Id = @Id`
    );

    if (esp.recordset.length === 0) throw new HttpError(400, 'Especialidade inválida.');
    const especialidadeNome = esp.recordset[0].Nome;

    // Valor Mínimo Consulta
    const valorMinimo = await obterValorMinimoConsulta(null);
    const valorConsulta =
      ValorConsultaBase === undefined || ValorConsultaBase === null || String(ValorConsultaBase).trim() === ''
        ? valorMinimo
        : Number(ValorConsultaBase);

    if (!Number.isFinite(valorConsulta) || valorConsulta <= 0) {
      throw new HttpError(400, 'ValorConsultaBase inválido.');
    }

    if (Number(valorConsulta) < Number(valorMinimo)) {
      throw new HttpError(400, `ValorConsultaBase não pode ser menor que o mínimo (${valorMinimo}).`);
    }

    //  Unicidade GLOBAL (Admin/Paciente/Fisio)
    const dupEmailGlobal = await queryWithContext(
      null,
      (req) => req.input('Email', sql.NVarChar(300), emailNorm),
      `
        SELECT TOP 1 UsuarioTipo, UsuarioId
        FROM dbo.UsuariosEmailsUnicos
        WHERE EmailNormalizado = @Email;
      `
    );

    if (dupEmailGlobal.recordset?.length) {
      throw new HttpError(409, 'E-mail já cadastrado.');
    }

    const dupTelGlobal = await queryWithContext(
      null,
      (req) => req.input('Telefone', sql.NVarChar(60), telefoneNorm),
      `
        SELECT TOP 1 UsuarioTipo, UsuarioId
        FROM dbo.UsuariosTelefonesUnicos
        WHERE TelefoneNormalizado = @Telefone;
      `
    );

    if (dupTelGlobal.recordset?.length) {
      throw new HttpError(409, 'Telefone já cadastrado.');
    }

    // Unicidade
    const dupCheck = await queryWithContext(
      null,
      (req) => {
        req.input('CREFITO', sql.NVarChar(20), crefito);
        req.input('CNPJ', sql.NVarChar(20), cnpj);
      },
      `
        SELECT TOP 1 'CREFITO' AS Campo FROM dbo.Fisioterapeutas WHERE CREFITO = @CREFITO
        UNION ALL
        SELECT TOP 1 'CNPJ'           FROM dbo.Fisioterapeutas WHERE CNPJ = @CNPJ
      `
    );


    if (dupCheck.recordset.length > 0) {
      const campo = dupCheck.recordset[0].Campo;
      throw new HttpError(409, `Já existe um fisioterapeuta com esse ${campo}.`);
    }

    const senhaHash = await bcrypt.hash(Senha, 12);

    // Defaults
    const tolerancia = 60;
    const confirmacaoAutomatica = 0;
    const descontoPacote = 0;
    const tipoConta = 'Comum';
    const ativo = 1;
    const isBloqueado = 0;
    const verificado = 0;

    const insert = await queryWithContext(
      null,
      (req) => {
        req.input('Nome', sql.NVarChar(150), Nome);
        req.input('CREFITO', sql.NVarChar(20), crefito);
        req.input('Email', sql.NVarChar(150), emailNorm);
        req.input('Telefone', sql.NVarChar(30), telefoneNorm);
        req.input('Cidade', sql.NVarChar(150), Cidade);
        req.input('Estado', sql.Char(2), uf);
        req.input('Especialidade', sql.NVarChar(200), especialidadeNome);
        req.input('CNPJ', sql.NVarChar(20), cnpj);
        req.input('SenhaHash', sql.NVarChar(255), senhaHash);
        req.input('Tolerancia', sql.Int, tolerancia);
        req.input('ValorConsultaBase', sql.Decimal(10, 2), Number(valorConsulta));
        req.input('ConfirmacaoAutomatica', sql.Bit, confirmacaoAutomatica);
        req.input('TipoConta', sql.NVarChar(50), tipoConta);
        req.input('DescontoPacote', sql.Decimal(5, 2), Number(descontoPacote));
        req.input('Ativo', sql.Bit, ativo);
        req.input('IsBloqueado', sql.Bit, isBloqueado);
        req.input('CrefitoVerificado', sql.Bit, verificado);
        req.input('Genero', sql.NVarChar(40), Genero);
        req.input('CodigoIndicacao', sql.NVarChar(50), CodigoIndicacao || null);
        req.input('EspecialidadeId', sql.Int, especialidadeIdNum);
      },
      `
        SET XACT_ABORT ON;

        BEGIN TRY
          BEGIN TRAN;

          DECLARE @NovoId TABLE (Id INT);

          INSERT INTO dbo.Fisioterapeutas (
            Nome, CREFITO, Email, Telefone, Cidade, Estado,
            Especialidade, CNPJ, SenhaHash,
            ToleranciaCancelamentoMinutos,
            ValorConsultaBase, ConfirmacaoAutomatica,
            TipoConta, DescontoPacote,
            Ativo, IsBloqueado, CrefitoVerificado,
            Genero,
            DataCadastro
          )
          OUTPUT INSERTED.Id INTO @NovoId(Id)
          VALUES (
            @Nome, @CREFITO, @Email, @Telefone, @Cidade, @Estado,
            @Especialidade, @CNPJ, @SenhaHash,
            @Tolerancia,
            @ValorConsultaBase, @ConfirmacaoAutomatica,
            @TipoConta, @DescontoPacote,
            @Ativo, @IsBloqueado, @CrefitoVerificado,
            @Genero,
            SYSDATETIME()
          );

          DECLARE @FisioId INT = (SELECT TOP 1 Id FROM @NovoId);

          INSERT INTO dbo.DocumentosFisioterapeutas
            (FisioterapeutaId, TipoDocumento, CaminhoArquivo, Status, DataEnvio, FonteValidacao, ScoreConfianca)
          VALUES
            (@FisioId, N'CREFITO', @CREFITO, N'Pendente', SYSDATETIME(), N'Cadastro', NULL);

          IF (NULLIF(LTRIM(RTRIM(@CodigoIndicacao)), '') IS NOT NULL)
          BEGIN
            DECLARE @Codigo NVARCHAR(50) = @CodigoIndicacao;
            DECLARE @IndicadoId INT = @FisioId;
            EXEC dbo.sp_RegistrarUsoCodigo @Codigo, @IndicadoId;
          END

          INSERT INTO dbo.FisioterapeutaEspecialidades
            (FisioterapeutaId, EspecialidadeId, ValorConsultaBase, Principal, CriadoEm)
          VALUES (@FisioId, @EspecialidadeId, @ValorConsultaBase, 1, SYSDATETIME());

          DECLARE @FisioterapeutaId INT = @FisioId;
          EXEC dbo.sp_GerarCodigoIndicacao @FisioterapeutaId;

          COMMIT;

          SELECT @FisioId AS Id;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          DECLARE @Msg NVARCHAR(2048) = ERROR_MESSAGE();
          THROW 50000, @Msg, 1;
        END CATCH
        `
    );

    const novoId = insert.recordset[0].Id;

    //  Em alguns ambientes, a vw_FisioterapeutaPerfilCompleto pode não retornar o recém-criado
    // (por regras de view/RLS). Nesse caso, caímos para um SELECT direto na tabela, para evitar
    // retorno null e o controller responder 501.
    let fisio = await this.buscarPerfilCompleto(novoId, null);

    if (!fisio) {
      const base = await queryWithContext(
        { id: novoId, tipo: 'Fisioterapeuta' },
        (req) => req.input('Id', sql.Int, novoId),
        `
          SELECT
            Id,
            Nome,
            CREFITO,
            Email,
            Telefone,
            Especialidade,
            Cidade,
            Estado,
            ValorConsultaBase,
            TipoConta,
            Ativo,
            CrefitoVerificado
          FROM dbo.Fisioterapeutas
          WHERE Id = @Id;
        `
      );

      fisio = base.recordset?.[0] || null;

      // fallback final (não deve ocorrer, mas evita null)
      if (!fisio) {
        fisio = {
          Id: novoId,
          Nome,
          CREFITO: crefito,
          Email: emailNorm,
          Telefone: telefoneNorm,
          Especialidade: especialidadeNome,
          Cidade,
          Estado: uf,
          ValorConsultaBase: Number(valorConsulta),
          TipoConta: tipoConta,
          Ativo: ativo,
          CrefitoVerificado: verificado
        };
      }
    }

    return fisio;
    } catch (e) {
      throw mapFisioterapeutaCreateError(e);
    }
  },

  // ================================================================
  //  UPDATE – normalizando CREFITO
  //  Especialidade só por ID (valida em vw_Especialidades)
  //  Fisioterapeuta NÃO altera LinkVideoApresentacao (YouTube)
  // ================================================================
  async atualizar(id, dados, usuario = null) {
    // compatibilidade: se não vier usuario, mantém o comportamento antigo
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };

    if (
      dados?.Senha !== undefined ||
      dados?.senha !== undefined ||
      dados?.SenhaHash !== undefined ||
      dados?.senhaHash !== undefined
    ) {
      throw new HttpError(400, 'Use o endpoint alterarSenhaMe para atualizar a senha.');
    }

    //  Blindagem máxima: remove qualquer tentativa de campos bloqueados (case-insensitive)
    removerCamposBloqueadosFisio(dados);

    // Normaliza Email/Telefone se vierem no PATCH
    if (dados?.Email !== undefined) {
      const e = normalizarEmail(dados.Email);
      if (!isValidEmail(e)) throw new HttpError(400, 'E-mail inválido.');
      dados.Email = e;
    }

    if (dados?.Telefone !== undefined) {
      const t = normalizarTelefoneSomenteDigitosBR(dados.Telefone);
      if (!t || t.length < 10 || t.length > 11) {
        throw new HttpError(400, 'Telefone inválido: use DDD + número (10 ou 11 dígitos).');
      }
      dados.Telefone = t;
    }

    let crefitoAlterado = false;
    let crefitoNovoNormalizado = null;

    //  especialidade: só pode vir por EspecialidadeId
    if (dados?.EspecialidadeId !== undefined && dados?.EspecialidadeId !== null && dados?.EspecialidadeId !== '') {
      const esp = await queryWithContext(
        ctx,
        (req) => {
          req.input('Id', sql.Int, parseInt(dados.EspecialidadeId, 10));
        },
        `SELECT Nome FROM dbo.vw_Especialidades WHERE Id = @Id;`
      );

      if (esp.recordset.length === 0) throw new HttpError(400, 'Especialidade inválida.');
      dados.Especialidade = esp.recordset[0].Nome;
    }

    if (dados?.CREFITO !== undefined) {
      crefitoNovoNormalizado = normalizarCrefito(dados.CREFITO);

      const resAtual = await queryWithContext(ctx, (req) => {
        req.input('Id', sql.Int, id);
      }, `
        SELECT CREFITO
        FROM dbo.Fisioterapeutas
        WHERE Id = @Id;
      `);

      const crefitoAtual = resAtual.recordset[0]?.CREFITO || null;
      if (crefitoNovoNormalizado !== crefitoAtual) crefitoAlterado = true;

      dados.CREFITO = crefitoNovoNormalizado;
    }

    const pixFoiInformado =
      Object.prototype.hasOwnProperty.call(dados || {}, 'ChavePix') ||
      Object.prototype.hasOwnProperty.call(dados || {}, 'TipoChavePix');

    const bancoFoiInformado =
      Object.prototype.hasOwnProperty.call(dados || {}, 'Banco') ||
      Object.prototype.hasOwnProperty.call(dados || {}, 'Agencia') ||
      Object.prototype.hasOwnProperty.call(dados || {}, 'Conta') ||
      Object.prototype.hasOwnProperty.call(dados || {}, 'TipoContaBancaria');

    if (bancoFoiInformado) {
      const bancoVazio = dados.Banco == null || String(dados.Banco).trim() === '';
      const agenciaVazia = dados.Agencia == null || String(dados.Agencia).trim() === '';
      const contaVazia = dados.Conta == null || String(dados.Conta).trim() === '';
      const tipoContaVazio = dados.TipoContaBancaria == null || String(dados.TipoContaBancaria).trim() === '';

      if (bancoVazio && agenciaVazia && contaVazia && tipoContaVazio) {
        dados.Banco = null;
        dados.Agencia = null;
        dados.Conta = null;
        dados.TipoContaBancaria = null;
      } else {
        dados.Banco = normalizarBancoParaRepasse(dados.Banco);
        dados.Agencia = normalizarAgenciaBancaria(dados.Agencia);
        dados.Conta = normalizarContaBancaria(dados.Conta);
        dados.TipoContaBancaria = normalizarTipoContaBancaria(dados.TipoContaBancaria);

        const cnpjAtualResult = await queryWithContext(ctx, (req) => {
          req.input('Id', sql.Int, id);
        }, `
          SELECT TOP (1) CNPJ
          FROM dbo.Fisioterapeutas
          WHERE Id = @Id;
        `);
        const cnpjAtual = cnpjAtualResult.recordset?.[0]?.CNPJ ?? null;
        if (!isValidCNPJ(String(cnpjAtual ?? '').replace(/\D/g, ''))) {
          throw new HttpError(400, 'CNPJ do fisioterapeuta inválido. Corrija o cadastro antes de salvar dados bancários.');
        }
      }
    }

    if (pixFoiInformado) {
      const chaveRaw = dados?.ChavePix;
      const tipoRaw = dados?.TipoChavePix;
      const chaveVazia = chaveRaw == null || String(chaveRaw).trim() === '';
      const tipoVazio = tipoRaw == null || String(tipoRaw).trim() === '';

      if (chaveVazia && tipoVazio) {
        dados.ChavePix = null;
        dados.TipoChavePix = null;
      } else {
        const tipoPix = normalizarTipoChavePix(tipoRaw);
        if (!tipoPix) throw new HttpError(400, 'Tipo de chave Pix inválido.');
        dados.TipoChavePix = tipoPix;
        dados.ChavePix = normalizarChavePix(tipoPix, chaveRaw);
      }
    }

    const camposPermitidos = [
      'Nome', 'Email', 'Telefone', 'Cidade', 'Estado',
      'Descricao', 'Banco', 'Agencia', 'Conta',
      'TipoContaBancaria', 'ChavePix', 'TipoChavePix',
      'ToleranciaCancelamentoMinutos',
      'ValorConsultaBase', 'DescontoPacote', 'ConfirmacaoAutomatica',
      'CREFITO', 'Genero',
      'Especialidade' // derivada do EspecialidadeId (ou validada no controller)
    ];

    const tipos = {
      Nome: sql.NVarChar(150),
      Email: sql.NVarChar(150),
      Telefone: sql.NVarChar(30),
      Especialidade: sql.NVarChar(200),
      Cidade: sql.NVarChar(150),
      Estado: sql.Char(2),
      Descricao: sql.NVarChar(sql.MAX),
      Banco: sql.NVarChar(80),
      Agencia: sql.NVarChar(30),
      Conta: sql.NVarChar(30),
      TipoContaBancaria: sql.NVarChar(30),
      ChavePix: sql.NVarChar(140),
      TipoChavePix: sql.NVarChar(20),
      ToleranciaCancelamentoMinutos: sql.Int,
      ValorConsultaBase: sql.Decimal(10, 2),
      DescontoPacote: sql.Decimal(5, 2),
      ConfirmacaoAutomatica: sql.Bit,
      CREFITO: sql.NVarChar(20),
      Genero: sql.NVarChar(40),
    };

    const updateFields = [];
    const prepared = {};

    // regra de valor mínimo (se tentar atualizar)
    if (dados?.ValorConsultaBase !== undefined) {
      const minimo = await obterValorMinimoConsulta(ctx);
      const novoValor = Number(dados.ValorConsultaBase);
      if (Number.isNaN(novoValor)) throw new HttpError(400, 'ValorConsultaBase inválido.');
      if (novoValor < minimo) {
        throw new HttpError(400, `ValorConsultaBase não pode ser menor que o mínimo (${minimo}).`);
      }
    }

    if (dados?.DescontoPacote !== undefined) {
      const novoDesconto = Number(dados.DescontoPacote);
      if (Number.isNaN(novoDesconto) || novoDesconto < 0 || novoDesconto > 100) {
        throw new HttpError(400, 'DescontoPacote inválido.');
      }
    }

    if (dados?.Genero !== undefined) {
      const genero = String(dados.Genero ?? '').trim();
      const GENEROS_VALIDOS = ['Masculino', 'Feminino'];
      if (!GENEROS_VALIDOS.includes(genero)) {
        throw new HttpError(400, 'Gênero inválido. Informe Masculino ou Feminino.');
      }
      dados.Genero = genero;
    }

    for (const campo of camposPermitidos) {
      if (dados?.[campo] !== undefined) {
        updateFields.push(`${campo} = @${campo}`);

        if (campo === 'Estado' && typeof dados[campo] === 'string') {
          const ufNorm = dados[campo].toUpperCase().trim();
          prepared[campo] = ufNorm;
        } else if (campo === 'ValorConsultaBase') {
          prepared[campo] = Number(dados[campo]);
        } else if (campo === 'DescontoPacote') {
          prepared[campo] = Number(dados[campo]);
        } else if (campo === 'ConfirmacaoAutomatica') {
          prepared[campo] = toBoolBit(dados[campo]);
        } else if (campo === 'ToleranciaCancelamentoMinutos') {
          const v = parseInt(dados[campo], 10);
          if (Number.isNaN(v)) throw new HttpError(400, 'ToleranciaCancelamentoMinutos inválida.');
          prepared[campo] = v;
        } else {
          prepared[campo] = dados[campo];
        }
      }
    }

    if (updateFields.length === 0) {
      throw new HttpError(400, 'Nenhum campo válido enviado para atualização.');
    }

    // Se CREFITO mudou, zera verificação
    if (crefitoAlterado) {
      updateFields.push(`CrefitoVerificado = 0`);
    }

    if (Object.prototype.hasOwnProperty.call(prepared, 'Email')) {
      updateFields.push(`EmailVerificado = 0`);
      updateFields.push(`EmailVerificadoEm = NULL`);
    }

    if (Object.prototype.hasOwnProperty.call(prepared, 'Telefone')) {
      updateFields.push(`TelefoneVerificado = 0`);
      updateFields.push(`TelefoneVerificadoEm = NULL`);
    }

    if (
      Object.prototype.hasOwnProperty.call(prepared, 'ChavePix') ||
      Object.prototype.hasOwnProperty.call(prepared, 'TipoChavePix')
    ) {
      updateFields.push(`PixAtualizadoEm = SYSDATETIME()`);
    }

    // ===============================
    // PRÉ-CHECK: e-mail/telefone únicos (global)
    // ===============================
    if (Object.prototype.hasOwnProperty.call(prepared, 'Email')) {
      const dupEmail = await queryWithContext(
        ctx,
        (req) => {
          req.input('Email', sql.NVarChar(300), prepared.Email);
          req.input('FisioId', sql.Int, id);
        },
        `
          SELECT TOP 1 UsuarioTipo, UsuarioId
          FROM dbo.UsuariosEmailsUnicos
          WHERE EmailNormalizado = @Email
            AND NOT (UsuarioTipo = 'Fisioterapeuta' AND UsuarioId = @FisioId);
        `
      );

      if (dupEmail.recordset?.length) {
        throw new HttpError(409, 'E-mail já cadastrado.');
      }
    }

    if (Object.prototype.hasOwnProperty.call(prepared, 'Telefone')) {
      const dupTel = await queryWithContext(
        ctx,
        (req) => {
          req.input('Telefone', sql.NVarChar(60), prepared.Telefone);
          req.input('FisioId', sql.Int, id);
        },
        `
          SELECT TOP 1 UsuarioTipo, UsuarioId
          FROM dbo.UsuariosTelefonesUnicos
          WHERE TelefoneNormalizado = @Telefone
            AND NOT (UsuarioTipo = 'Fisioterapeuta' AND UsuarioId = @FisioId);
        `
      );

      if (dupTel.recordset?.length) {
        throw new HttpError(409, 'Telefone já cadastrado.');
      }
    }

    // Sync FisioterapeutaEspecialidades — resolve @EspId ANTES de zerar para não
    // deixar fisio sem Principal caso o nome seja inválido. ValorConsultaBase vai
    // para a principal já trocada (se Especialidade também mudou neste batch).
    const syncEspSql = prepared.Especialidade !== undefined ? `
      DECLARE @EspId INT = NULL;
      SELECT @EspId = Id FROM dbo.Especialidades WHERE Nome = @Especialidade;

      IF @EspId IS NULL
        THROW 50001, 'Especialidade não reconhecida na tabela de especialidades.', 1;

      UPDATE dbo.FisioterapeutaEspecialidades
        SET Principal = 0, AtualizadoEm = SYSDATETIME()
        WHERE FisioterapeutaId = @Id;

      IF EXISTS (
        SELECT 1 FROM dbo.FisioterapeutaEspecialidades
        WHERE FisioterapeutaId = @Id AND EspecialidadeId = @EspId
      )
        UPDATE dbo.FisioterapeutaEspecialidades
          SET Principal = 1, AtualizadoEm = SYSDATETIME()
          WHERE FisioterapeutaId = @Id AND EspecialidadeId = @EspId;
      ELSE
        INSERT INTO dbo.FisioterapeutaEspecialidades
          (FisioterapeutaId, EspecialidadeId, ValorConsultaBase, Principal, CriadoEm)
        SELECT @Id, @EspId, f.ValorConsultaBase, 1, SYSDATETIME()
        FROM dbo.Fisioterapeutas f WHERE f.Id = @Id;
    ` : '';

    const syncValorSql = prepared.ValorConsultaBase !== undefined ? `
      UPDATE dbo.FisioterapeutaEspecialidades
        SET ValorConsultaBase = @ValorConsultaBase, AtualizadoEm = SYSDATETIME()
        WHERE FisioterapeutaId = @Id AND Principal = 1;
    ` : '';

    await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, id);

      for (const [k, v] of Object.entries(prepared)) {
        const tipo = tipos[k] || sql.NVarChar(sql.MAX);
        req.input(k, tipo, v);
      }
    }, `
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRAN;

        UPDATE dbo.Fisioterapeutas
        SET ${updateFields.join(', ')}
        WHERE Id = @Id;

        ${syncEspSql}
        ${syncValorSql}

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH;

      BEGIN TRY
        EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @Id;
      END TRY
      BEGIN CATCH
      END CATCH;
    `);

    return await this.buscarPerfilCompleto(id, ctx);
  },

  
  //  Alterar senha (somente do próprio fisioterapeuta)
  async alterarSenhaMe(id, senhaAtual, novaSenha, usuario = null) {
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };

    if (!senhaAtual || !novaSenha) {
      throw new HttpError(400, 'Informe senhaAtual e novaSenha.');
    }
    const nova = String(novaSenha || '');
    validatePasswordStrength(nova);

    // 1) Buscar hash atual
    const r = await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, Number(id));
      },
      `
        SELECT TOP 1
          Id,
          SenhaHash,
          Ativo,
          IsBloqueado
        FROM dbo.Fisioterapeutas
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    const u = r.recordset?.[0];
    if (!u) throw new HttpError(404, 'Fisioterapeuta não encontrado.');
    if (u.Ativo === 0 || u.Ativo === false) throw new HttpError(403, 'Conta inativa.');
    if (Number(u.IsBloqueado) === 1) throw new HttpError(403, 'Conta bloqueada.');

    const hashAtual = String(u.SenhaHash || '');
    const ok = await bcrypt.compare(String(senhaAtual), hashAtual);
    if (!ok) throw new HttpError(401, 'Senha atual incorreta.');

    // 2) Atualizar hash
    const novoHash = await bcrypt.hash(nova, 12);

    await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, Number(id));
        req.input('SenhaHash', sql.NVarChar(510), novoHash);
      },
      `
        UPDATE dbo.Fisioterapeutas
        SET SenhaHash = @SenhaHash
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    return { sucesso: true, mensagem: 'Senha atualizada com sucesso.' };
  },

  async remover(id, payload = {}, usuario = null) {
    const ctx = safeUsuario(usuario) || { id, tipo: 'Fisioterapeuta' };
    const senha = payload?.senha ?? payload?.Senha ?? null;

    const check = await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, Number(id));
      },
      `
        SELECT TOP 1
          Ativo,
          IsBloqueado,
          SenhaHash
        FROM dbo.Fisioterapeutas
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    const row = check.recordset?.[0];
    if (!row) throw new HttpError(404, 'Fisioterapeuta não encontrado.');
    if (Number(row.IsBloqueado) === 1 || row.Ativo === 0 || row.Ativo === false) {
      return { sucesso: false, mensagem: 'Fisioterapeuta já está desativado.' };
    }

    if (ctx.tipo !== 'Admin') {
      if (!senha) throw new HttpError(400, 'Senha é obrigatória para desativar a conta.');

      const senhaHash = String(row.SenhaHash || '');
      if (!senhaHash) throw new HttpError(404, 'Fisioterapeuta não encontrado.');

      const ok = await bcrypt.compare(String(senha), senhaHash);
      if (!ok) throw new HttpError(401, 'Senha incorreta.');
    }

    const r = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, Number(id));
    }, `
      UPDATE dbo.Fisioterapeutas
      SET IsBloqueado = 1
      WHERE Id = @Id;
      DECLARE @Afetadas INT = @@ROWCOUNT;

      BEGIN TRY
        EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @Id;
      END TRY
      BEGIN CATCH
      END CATCH;

      SELECT @Afetadas AS Afetadas;
    `);
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Fisioterapeuta não encontrado.');

    return { sucesso: true, mensagem: 'Fisioterapeuta desativado com sucesso.' };
  },

  // ================================================================
  //  ADMIN ONLY: atualizar link do YouTube (LinkVideoApresentacao)
  // ================================================================
  async atualizarYoutubeAdmin({ fisioterapeutaId, linkYoutube, adminId } = {}, usuario = null) {
    if (!fisioterapeutaId) throw new HttpError(400, 'FisioterapeutaId é obrigatório.');
    if (!linkYoutube) throw new HttpError(400, 'linkYoutube é obrigatório.');
    if (!YOUTUBE_RE.test(String(linkYoutube).trim())) {
      throw new HttpError(400, 'Link inválido. Use uma URL do YouTube.');
    }

    const ctx = safeUsuario(usuario) || (adminId ? { id: Number(adminId), tipo: 'Admin' } : null);
    if (!ctx) throw new HttpError(403, 'Contexto do Admin é obrigatório.');

    const result = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, Number(fisioterapeutaId));
      req.input('Link', sql.NVarChar(2000), String(linkYoutube));
    }, `
      UPDATE dbo.Fisioterapeutas
      SET LinkVideoApresentacao = @Link
      WHERE Id = @Id;

      BEGIN TRY
        EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @Id;
      END TRY
      BEGIN CATCH
      END CATCH;

      SELECT Id, Nome, LinkVideoApresentacao
      FROM dbo.Fisioterapeutas
      WHERE Id = @Id;
    `);

    return result.recordset?.[0] || null;
  },

  // ================================================================
  //  Upload de CERTIFICADO → FormacoesFisioterapeutas (sem aprovação)
  // ================================================================
  async processarDocumento(fisioterapeutaId, caminhoArquivo, formacao = {}, usuario = null) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    //  Curso é obrigatório (NOT NULL)
    const curso = String(formacao.Curso || '').trim();
    if (!curso) {
      throw new HttpError(400, 'Campo "Curso" é obrigatório.');
    }

    //  salva no banco sempre como caminho RELATIVO (certificados/<arquivo>.pdf)
    const caminhoRel = normalizarRelCertificadoFromDb(caminhoArquivo);
    if (!caminhoRel) {
      throw new HttpError(400, 'Caminho do certificado inválido.');
    }

    const sqlText = `
      INSERT INTO dbo.FormacoesFisioterapeutas (
        FisioterapeutaId,
        Curso,
        Instituicao,
        AnoConclusao,
        TipoFormacao,
        DataCadastro,
        MesInicio,
        AnoInicio,
        MesFim,
        AnoFim,
        CaminhoArquivo,
        IdCredencial,
        UrlCredencial,
        Descricao,
        Media
      )
      VALUES (
        @FisioterapeutaId,
        @Curso,
        @Instituicao,
        @AnoConclusao,
        @TipoFormacao,
        SYSDATETIME(),
        @MesInicio,
        @AnoInicio,
        @MesFim,
        @AnoFim,
        @CaminhoArquivo,
        @IdCredencial,
        @UrlCredencial,
        @Descricao,
        @Media
      );

      DECLARE @NewId INT = CAST(SCOPE_IDENTITY() AS INT);

      SELECT TOP 1 *
      FROM dbo.FormacoesFisioterapeutas
      WHERE Id = @NewId
        AND FisioterapeutaId = @FisioterapeutaId;
    `;

    const result = await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('Curso', sql.NVarChar(300), curso);
      req.input('Instituicao', sql.NVarChar(300), formacao.Instituicao || null);
      req.input('AnoConclusao', sql.Int, formacao.AnoConclusao ? parseInt(formacao.AnoConclusao, 10) : null);
      req.input('TipoFormacao', sql.NVarChar(100), formacao.TipoFormacao || null);
      req.input('MesInicio', sql.Int, formacao.MesInicio ? parseInt(formacao.MesInicio, 10) : null);
      req.input('AnoInicio', sql.Int, formacao.AnoInicio ? parseInt(formacao.AnoInicio, 10) : null);
      req.input('MesFim', sql.Int, formacao.MesFim ? parseInt(formacao.MesFim, 10) : null);
      req.input('AnoFim', sql.Int, formacao.AnoFim ? parseInt(formacao.AnoFim, 10) : null);
      req.input('CaminhoArquivo', sql.NVarChar(2000), caminhoRel);
      req.input('IdCredencial', sql.NVarChar(400), formacao.IdCredencial || null);
      req.input('UrlCredencial', sql.NVarChar(1000), formacao.UrlCredencial || null);
      req.input('Descricao', sql.NVarChar(sql.MAX), formacao.Descricao || null);
      req.input('Media', sql.Decimal(5, 2), null);
    }, sqlText);

    return result.recordset?.[0] ?? null;
  },

  async atualizarFormacao(fisioterapeutaId, formacaoId, formacao = {}, usuario = null) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    const fisioId = Number(fisioterapeutaId);
    const registroId = Number(formacaoId);

    if (!Number.isInteger(fisioId) || fisioId <= 0) {
      throw new HttpError(400, 'FisioterapeutaId inválido.');
    }
    if (!Number.isInteger(registroId) || registroId <= 0) {
      throw new HttpError(400, 'Id da formação inválido.');
    }

    const updates = {};

    const curso = normalizeOptionalText(formacao.Curso, 300);
    if (curso !== undefined) {
      if (!curso) throw new HttpError(400, 'Campo "Curso" é obrigatório.');
      updates.Curso = curso;
    }

    const instituicao = normalizeOptionalText(formacao.Instituicao, 300);
    if (instituicao !== undefined) updates.Instituicao = instituicao;

    const tipoFormacao = normalizeOptionalText(formacao.TipoFormacao, 100);
    if (tipoFormacao !== undefined) updates.TipoFormacao = tipoFormacao;

    const idCredencial = normalizeOptionalText(formacao.IdCredencial, 400);
    if (idCredencial !== undefined) updates.IdCredencial = idCredencial;

    const urlCredencial = normalizeOptionalText(formacao.UrlCredencial, 1000);
    if (urlCredencial !== undefined) updates.UrlCredencial = urlCredencial;

    const descricao = normalizeOptionalText(formacao.Descricao, 4000);
    if (descricao !== undefined) updates.Descricao = descricao;

    const anoConclusao = normalizeOptionalInt(formacao.AnoConclusao, 'AnoConclusao', { min: 1900, max: 2100 });
    if (anoConclusao !== undefined) updates.AnoConclusao = anoConclusao;

    const mesInicio = normalizeOptionalInt(formacao.MesInicio, 'MesInicio', { min: 1, max: 12 });
    if (mesInicio !== undefined) updates.MesInicio = mesInicio;

    const anoInicio = normalizeOptionalInt(formacao.AnoInicio, 'AnoInicio', { min: 1900, max: 2100 });
    if (anoInicio !== undefined) updates.AnoInicio = anoInicio;

    const mesFim = normalizeOptionalInt(formacao.MesFim, 'MesFim', { min: 1, max: 12 });
    if (mesFim !== undefined) updates.MesFim = mesFim;

    const anoFim = normalizeOptionalInt(formacao.AnoFim, 'AnoFim', { min: 1900, max: 2100 });
    if (anoFim !== undefined) updates.AnoFim = anoFim;

    if (!Object.keys(updates).length) {
      throw new HttpError(400, 'Nenhum campo válido para atualização.');
    }

    const sqlTypes = {
      Curso: sql.NVarChar(300),
      Instituicao: sql.NVarChar(300),
      AnoConclusao: sql.Int,
      TipoFormacao: sql.NVarChar(100),
      MesInicio: sql.Int,
      AnoInicio: sql.Int,
      MesFim: sql.Int,
      AnoFim: sql.Int,
      IdCredencial: sql.NVarChar(400),
      UrlCredencial: sql.NVarChar(1000),
      Descricao: sql.NVarChar(sql.MAX),
    };

    const setClauses = Object.keys(updates).map((campo) => `${campo} = @${campo}`);

    const result = await queryWithContext(
      ctx,
      (req) => {
        req.input('FormacaoId', sql.Int, registroId);
        req.input('FisioterapeutaId', sql.Int, fisioId);

        for (const [campo, valor] of Object.entries(updates)) {
          req.input(campo, sqlTypes[campo], valor);
        }
      },
      `
        UPDATE dbo.FormacoesFisioterapeutas
        SET ${setClauses.join(', ')}
        WHERE Id = @FormacaoId
          AND FisioterapeutaId = @FisioterapeutaId;

        SELECT TOP 1 *
        FROM dbo.FormacoesFisioterapeutas
        WHERE Id = @FormacaoId
          AND FisioterapeutaId = @FisioterapeutaId;
      `
    );

    const row = result.recordset?.[0] ?? null;
    if (!row) {
      throw new HttpError(404, 'Formação não encontrada para este fisioterapeuta.');
    }

    return {
      Id: row.Id ?? null,
      Curso: row.Curso ?? null,
      Instituicao: row.Instituicao ?? null,
      AnoConclusao: row.AnoConclusao ?? null,
      TipoFormacao: row.TipoFormacao ?? null,
      MesInicio: row.MesInicio ?? null,
      AnoInicio: row.AnoInicio ?? null,
      MesFim: row.MesFim ?? null,
      AnoFim: row.AnoFim ?? null,
      IdCredencial: row.IdCredencial ?? null,
      UrlCredencial: row.UrlCredencial ?? null,
      Descricao: row.Descricao ?? null,
      Media: `/api/arquivos/certificados/${row.Id}/visualizar`,
      Thumbnail: `/api/arquivos/certificados/${row.Id}/thumbnail`,
    };
  },


  // ==================
  //  FOTO DE PERFIL (Opção B)
  // ==================
  async salvarFotoPerfil({ fisioterapeutaId, caminhoArquivo, usuario = null }) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    if (!fisioterapeutaId) throw new HttpError(400, 'fisioterapeutaId é obrigatório.');
    if (!caminhoArquivo || !String(caminhoArquivo).trim()) throw new HttpError(400, 'caminhoArquivo é obrigatório.');
    const ext = String(caminhoArquivo).split('.').pop().toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      throw new HttpError(400, 'Formato de imagem inválido. Use jpg, jpeg, png ou webp.');
    }

    // somente fisioterapeuta dono
    if (ctx?.tipo !== 'Fisioterapeuta' || Number(ctx?.id) !== Number(fisioterapeutaId)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const sqlText = `
      DECLARE @Ids TABLE (Id INT);

      INSERT INTO dbo.DocumentosFisioterapeutas (
        FisioterapeutaId,
        TipoDocumento,
        CaminhoArquivo,
        Status,
        FonteValidacao,
        ScoreConfianca
      )
      OUTPUT INSERTED.Id INTO @Ids(Id)
      VALUES (
        @FisioterapeutaId,
        N'FOTO_PERFIL',
        @CaminhoArquivo,
        N'Aprovado',
        N'Upload App',
        100
      );

      DECLARE @DocumentoId INT;
      SELECT TOP 1 @DocumentoId = Id FROM @Ids;

      UPDATE dbo.Fisioterapeutas
      SET FotoPerfilDocumentoId = @DocumentoId
      WHERE Id = @FisioterapeutaId;

      BEGIN TRY
        EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @FisioterapeutaId;
      END TRY
      BEGIN CATCH
      END CATCH;

      SELECT
        @DocumentoId AS FotoPerfilDocumentoId,
        @CaminhoArquivo AS CaminhoArquivo;
    `;

    const result = await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
      req.input('CaminhoArquivo', sql.NVarChar(2000), String(caminhoArquivo));
    }, sqlText);

    return result.recordset?.[0] ?? null;
  },

  async removerFotoPerfil({ fisioterapeutaId, usuario = null }) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    if (!fisioterapeutaId) throw new HttpError(400, 'fisioterapeutaId é obrigatório.');

    if (ctx?.tipo !== 'Fisioterapeuta' || Number(ctx?.id) !== Number(fisioterapeutaId)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
    }, `
      UPDATE dbo.Fisioterapeutas
      SET FotoPerfilDocumentoId = NULL
      WHERE Id = @FisioterapeutaId;

      BEGIN TRY
        EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @FisioterapeutaId;
      END TRY
      BEGIN CATCH
      END CATCH;
    `);

    return true;
  },

  // ==================
  //  PRÉ-CADASTRO DE PACIENTE (carteira/vínculo)
  // ==================
  async preCadastrarPaciente(fisioterapeutaId, dados = {}, usuario = null) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    // Anti-spoof: só o próprio fisio logado pode pré-cadastrar paciente na sua carteira
    if (ctx?.tipo !== 'Fisioterapeuta' || Number(ctx?.id) !== Number(fisioterapeutaId)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const nome = String(dados?.Nome || '').trim();
    const cpfRaw = String(dados?.CPF || '').trim();
    const email = String(dados?.Email || '').trim();
    const telefone = String(dados?.Telefone || '').trim();
    const emailNorm = normalizarEmail(email);
    const telNorm = normalizarTelefoneSomenteDigitosBR(telefone);


    if (!nome) {
      throw new HttpError(400, 'Nome é obrigatório.');
    }

    // Compatível com CK_Pacientes_Nome (sem números e sem caracteres "estranhos")
    if (/[0-9]/.test(nome) || /[^A-Za-zÀ-ÿ\s]/.test(nome)) {
      throw new HttpError(400, 'Nome inválido. Use apenas letras e espaços.');
    }

    if (!cpfRaw) {
      throw new HttpError(400, 'CPF é obrigatório.');
    }

    const cpf = cpfRaw.replace(/\D/g, '');
    if (cpf.length !== 11) {
      throw new HttpError(400, 'CPF inválido.');
    }
    if (!isValidCPF(cpf)) {
      throw new HttpError(400, 'CPF inválido.');
    }

   if (!emailNorm) {
      throw new HttpError(400, 'Email é obrigatório.');
    }

    if (!isValidEmail(emailNorm)) {
      throw new HttpError(400, 'E-mail inválido.');
    }

    if (!telNorm) {
      throw new HttpError(400, 'Telefone é obrigatório.');
    }

    if (telNorm.length < 10 || telNorm.length > 11) {
      throw new HttpError(400, 'Telefone inválido: use DDD + número (10 ou 11 dígitos).');
    }

    //  Unicidade GLOBAL (Admin/Paciente/Fisio) - antes de chamar a SP
    const dupEmailGlobal = await queryWithContext(
      null,
      (req) => req.input('Email', sql.NVarChar(300), emailNorm),
      `
        SELECT TOP 1 UsuarioTipo, UsuarioId
        FROM dbo.UsuariosEmailsUnicos
        WHERE EmailNormalizado = @Email;
      `
    );

    if (dupEmailGlobal.recordset?.length) {
      throw new HttpError(409, 'E-mail já cadastrado.');
    }

    const dupTelGlobal = await queryWithContext(
      null,
      (req) => req.input('Telefone', sql.NVarChar(60), telNorm),
      `
        SELECT TOP 1 UsuarioTipo, UsuarioId
        FROM dbo.UsuariosTelefonesUnicos
        WHERE TelefoneNormalizado = @Telefone;
      `
    );

    if (dupTelGlobal.recordset?.length) {
      throw new HttpError(409, 'Telefone já cadastrado.');
    }

    // Gênero (se vier preenchido, precisa ser Feminino ou Masculino)
    const genero = (dados?.Genero ?? dados?.genero ?? '').toString().trim() || null;
    if (genero && genero !== 'Feminino' && genero !== 'Masculino') {
      throw new HttpError(400, 'Gênero inválido. Use "Feminino" ou "Masculino".');
    }

    // CEP (8 dígitos ou 9 com hífen)
    const cepRaw = (
      dados?.Cep ??
      dados?.CEP ??
      dados?.CEPResidencial ??
      dados?.CEPComercial ??
      dados?.cep ??
      dados?.cepResidencial ??
      dados?.cepComercial ??
      null
    );
    const cepStr = cepRaw ? String(cepRaw).trim() : null;
    const cepDigits = cepStr ? cepStr.replace(/\D/g, '') : null;
    if (cepDigits && cepDigits.length !== 8) {
      throw new HttpError(400, "CEP inválido. Use 8 dígitos (ex: '01310000') ou '01310-900'.");
    }
    const cep = cepDigits ? `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}` : null;

    // DataNascimento (DATE)
    let dataNascimento = dados?.DataNascimento ?? dados?.dataNascimento ?? null;
    if (dataNascimento) {
      const d = new Date(dataNascimento);
      if (Number.isNaN(d.getTime())) {
        throw new HttpError(400, 'DataNascimento inválida.');
      }
      dataNascimento = d;
    } else {
      dataNascimento = null;
    }

    // senha aleatória só pra cumprir NOT NULL/CK (len bcrypt >= 60)
    const senhaAleatoria = `temp_${crypto.randomBytes(24).toString('hex')}_${Date.now()}`;
    const senhaHash = await bcrypt.hash(senhaAleatoria, 12);

    const sqlText = `
      EXEC dbo.SP_Fisio_PreCadastrarPaciente
        @FisioterapeutaId       = @FisioterapeutaId,
        @Nome                   = @Nome,
        @CPF                    = @CPF,
        @Email                  = @Email,
        @Telefone               = @Telefone,
        @SenhaHash              = @SenhaHash,
        @DataNascimento         = @DataNascimento,
        @Cidade                 = @Cidade,
        @Estado                 = @Estado,
        @Naturalidade           = @Naturalidade,
        @EstadoCivil            = @EstadoCivil,
        @Genero                 = @Genero,
        @Profissao              = @Profissao,
        @EnderecoComercial      = @EnderecoComercial,
        @EnderecoResidencial    = @EnderecoResidencial,
        @BairroComercial        = @BairroComercial,
        @BairroResidencial      = @BairroResidencial,
        @Cep                    = @Cep,
        @ObservacoesVinculo     = @ObservacoesVinculo,
        @CPFValido              = @CPFValido,
        @ComplementoResidencial = @ComplementoResidencial;
    `;

    const complementoResidencial =
      dados?.ComplementoResidencial ?? dados?.complementoResidencial ?? null;
    const complementoResidencialNorm =
      complementoResidencial != null && String(complementoResidencial).trim()
        ? String(complementoResidencial).trim()
        : null;
    let result;
    try {
      result = await queryWithContext(ctx, (req) => {
        req.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
        req.input('Nome', sql.NVarChar(300), nome);
        req.input('CPF', sql.NVarChar(40), cpf);
        req.input('Email', sql.NVarChar(300), emailNorm);
        req.input('Telefone', sql.NVarChar(60), telNorm);
        req.input('SenhaHash', sql.NVarChar(256), senhaHash);

        req.input('DataNascimento', sql.Date, dataNascimento);

        const cidade = dados?.Cidade ?? dados?.cidade ?? null;
        const estado = dados?.Estado ?? dados?.estado ?? null;
        const naturalidade = dados?.Naturalidade ?? dados?.naturalidade ?? null;
        const estadoCivil = dados?.EstadoCivil ?? dados?.estadoCivil ?? null;
        const profissao = dados?.Profissao ?? dados?.profissao ?? null;
        const endComercial = dados?.EnderecoComercial ?? dados?.enderecoComercial ?? null;
        const endResidencial = dados?.EnderecoResidencial ?? dados?.enderecoResidencial ?? null;
        const bairroComercial = dados?.BairroComercial ?? dados?.bairroComercial ?? null;
        const bairroResidencial = dados?.BairroResidencial ?? dados?.bairroResidencial ?? null;
        const obsVinculo = dados?.ObservacoesVinculo ?? dados?.observacoesVinculo ?? null;

        req.input('Cidade', sql.NVarChar(400), cidade ? String(cidade).trim() : null);
        req.input('Estado', sql.NVarChar(400), estado ? String(estado).trim() : null);
        req.input('Naturalidade', sql.NVarChar(240), naturalidade ? String(naturalidade).trim() : null);
        req.input('EstadoCivil', sql.NVarChar(120), estadoCivil ? String(estadoCivil).trim() : null);
        req.input('Genero', sql.NVarChar(40), genero);
        req.input('Profissao', sql.NVarChar(240), profissao ? String(profissao).trim() : null);
        req.input('EnderecoComercial', sql.NVarChar(1600), endComercial ? String(endComercial).trim() : null);
        req.input('EnderecoResidencial', sql.NVarChar(1600), endResidencial ? String(endResidencial).trim() : null);
        req.input('BairroComercial', sql.NVarChar(200), bairroComercial ? String(bairroComercial).trim() : null);
        req.input('BairroResidencial', sql.NVarChar(200), bairroResidencial ? String(bairroResidencial).trim() : null);
        req.input('Cep', sql.NVarChar(18), cep);
        req.input('ObservacoesVinculo', sql.NVarChar(400), obsVinculo ? String(obsVinculo).trim() : null);
        req.input('CPFValido', sql.Bit, 1);
        req.input('ComplementoResidencial', sql.NVarChar(400), complementoResidencialNorm);
      }, sqlText);
    } catch (err) {
      throw mapPreCadastroPacienteError(err);
    }

    const row = result.recordset?.[0] ?? null;

    return {
      ...(row || {}),
      mensagem: 'Paciente pré-cadastrado com sucesso.'
    };
  },


  //  Documentos (status de validação) do fisioterapeuta
  async obterStatusDocumento(fisioterapeutaId, usuario = null) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };

    const result = await queryWithContext(ctx, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('TipoDocumento', sql.NVarChar(50), 'CREFITO');
    }, `
      SELECT
        Id,
        FisioterapeutaId,
        NomeFisioterapeuta,
        TipoDocumento,
        CaminhoArquivo,
        Status,
        DataEnvio,
        DataValidacao,
        MotivoRejeicao,
        ScoreConfianca
      FROM dbo.vw_DocumentosFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND TipoDocumento = @TipoDocumento;
    `);

    return result.recordset;
  },
// ==============================
  // Confiabilidade (Fisioterapeuta)
  // Exige: CrefitoVerificado + EmailVerificado + TelefoneVerificado
  // ==============================
  async obterConfiabilidade({ fisioterapeutaId, usuario }) {
    const ctx = safeUsuario(usuario) || { id: fisioterapeutaId, tipo: 'Fisioterapeuta' };
    const resultado = await queryWithContext(
      ctx,
      (req) => req.input('Id', sql.Int, fisioterapeutaId),
      `
        SELECT TOP 1
          f.Id,
          f.CrefitoVerificado,
          f.EmailVerificado,
          f.TelefoneVerificado,
          f.EmailVerificadoEm,
          f.TelefoneVerificadoEm
        FROM dbo.Fisioterapeutas f
        WHERE f.Id = @Id;
      `,
      { requireContext: true }
    );


    const row = resultado?.recordset?.[0];
    if (!row) return null;

    const crefito = row.CrefitoVerificado ? 1 : 0;
    const email = row.EmailVerificado ? 1 : 0;
    const tel = row.TelefoneVerificado ? 1 : 0;

    const criterios = {
      crefitoVerificado: crefito,
      emailVerificado: email,
      telefoneVerificado: tel,
    };

    const total = 3;
    const ok = crefito + email + tel;
    const percentual = Math.round((ok / total) * 100);

    return {
      fisioterapeutaId: row.Id,
      criterios,
      percentual,
      confiavel: percentual === 100,
      emailVerificadoEm: row.EmailVerificadoEm ?? null,
      telefoneVerificadoEm: row.TelefoneVerificadoEm ?? null,
    };
  },

  // ==============================
  // Verificação de contato (Fisioterapeuta)
  // ==============================
  async solicitarVerificacaoContato(usuarioOrArgs, fisioterapeutaId, dados) {

    // Suporta chamada antiga (usuario, id, dados) e nova ({ usuario, fisioterapeutaId, canal, destino, ... })

    let usuario = usuarioOrArgs;

    if (

      usuarioOrArgs &&

      typeof usuarioOrArgs === 'object' &&

      (usuarioOrArgs.fisioterapeutaId != null ||

        usuarioOrArgs.FisioterapeutaId != null ||

        usuarioOrArgs.canal != null ||

        usuarioOrArgs.Canal != null ||

        usuarioOrArgs.destino != null ||

        usuarioOrArgs.Destino != null ||

        usuarioOrArgs.usuario != null)

    ) {

      const args = usuarioOrArgs;

      usuario = args.usuario ?? args.user ?? args.Usuario ?? args;

      fisioterapeutaId = args.fisioterapeutaId ?? args.FisioterapeutaId ?? fisioterapeutaId;

      dados = args;

    }
    const canal = dados?.canal ?? dados?.Canal;
    const canalNorm = normalizeCanalContato(canal);
    if (!canalNorm) {
      throw new HttpError(400, "Canal inválido. Use 'Email' ou 'Telefone'.");
    }

    const destinoRes = await queryWithContext(
      safeUsuario(usuario),
      (req) => {
        req.input('FisioterapeutaId', sql.Int, toIntOrNull(fisioterapeutaId));
      },
      `
        SELECT TOP 1
          Email,
          Telefone
        FROM dbo.Fisioterapeutas
        WHERE Id = @FisioterapeutaId;
      `,
      { requireContext: true }
    );

    const rowDestino = destinoRes?.recordset?.[0];
    const destino = canalNorm === 'Email' ? rowDestino?.Email : rowDestino?.Telefone;
    if (!destino) {
      throw new HttpError(400, `Destino não encontrado para o canal ${canalNorm}. Atualize seus dados antes de solicitar a verificação.`);
    }

    const destinoNormalizado = normalizeDestinoContato(canalNorm, destino);
    if (!destinoNormalizado) {
      throw new HttpError(400, 'Destino inválido para o canal informado.');
    }

    const codigo = gerarCodigo6();
    const salt = gerarSalt16();
    const secret = getContatoSecret();
    const codigoHash = calcularCodigoHash(secret, salt, canalNorm, codigo, destinoNormalizado);

    const expiraEm = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos
    const maxTentativas = 5;

    const upsertQuery = `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRAN;

      DECLARE @UltimoEnvioEm DATETIME2(7) = NULL;
      SELECT TOP 1 @UltimoEnvioEm = UltimoEnvioEm
      FROM dbo.VerificacoesContato WITH (UPDLOCK, HOLDLOCK)
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND Canal = @Canal;

      IF (@UltimoEnvioEm IS NOT NULL AND DATEDIFF(SECOND, @UltimoEnvioEm, SYSDATETIME()) < @CooldownSegundos)
      BEGIN
        SELECT
          CAST(0 AS BIT) AS PodeEnviar,
          DATEADD(SECOND, @CooldownSegundos, @UltimoEnvioEm) AS PodeReenviarEm,
          CAST(NULL AS DATETIME2(7)) AS ExpiraEm;
        COMMIT;
        RETURN;
      END

      MERGE dbo.VerificacoesContato AS t
      USING (SELECT @FisioterapeutaId AS FisioterapeutaId, @Canal AS Canal) AS s
        ON t.FisioterapeutaId = s.FisioterapeutaId AND t.Canal = s.Canal
      WHEN MATCHED THEN
        UPDATE SET
          Destino = @Destino,
          CodigoHash = @CodigoHash,
          CodigoSalt = @CodigoSalt,
          ExpiraEm = @ExpiraEm,
          Tentativas = 0,
          MaxTentativas = @MaxTentativas,
          Status = N'Pendente',
          UltimoEnvioEm = SYSDATETIME(),
          ConfirmadoEm = NULL
      WHEN NOT MATCHED THEN
        INSERT (FisioterapeutaId, Canal, Destino, CodigoHash, CodigoSalt, ExpiraEm, Tentativas, MaxTentativas, Status, CriadoEm, UltimoEnvioEm)
        VALUES (@FisioterapeutaId, @Canal, @Destino, @CodigoHash, @CodigoSalt, @ExpiraEm, 0, @MaxTentativas, N'Pendente', SYSDATETIME(), SYSDATETIME());

      SELECT TOP 1
        CAST(1 AS BIT) AS PodeEnviar,
        CAST(NULL AS DATETIME2(7)) AS PodeReenviarEm,
        ExpiraEm
      FROM dbo.VerificacoesContato
      WHERE FisioterapeutaId = @FisioterapeutaId AND Canal = @Canal;

      COMMIT;
    `;

    const res = await queryWithContext(safeUsuario(usuario),
      (req) => {
        req.input('FisioterapeutaId', sql.Int, toIntOrNull(fisioterapeutaId));
        req.input('Canal', sql.NVarChar(40), canalNorm);
        req.input('Destino', sql.NVarChar(510), destinoNormalizado);
        req.input('CodigoHash', sql.VarBinary(32), codigoHash);
        req.input('CodigoSalt', sql.VarBinary(16), salt);
        req.input('ExpiraEm', sql.DateTime2(7), expiraEm);
        req.input('MaxTentativas', sql.SmallInt, maxTentativas);
        req.input('CooldownSegundos', sql.Int, VERIFICACAO_CONTATO_COOLDOWN_SEGUNDOS);
      },
      upsertQuery,
      { requireContext: true }
    );

    const row = res?.recordset?.[0] ?? null;
    const podeEnviar = Number(row?.PodeEnviar ?? 0) === 1;
    if (!podeEnviar) {
      const podeReenviarEm = row?.PodeReenviarEm ? new Date(row.PodeReenviarEm) : null;
      const quando = (podeReenviarEm && !Number.isNaN(podeReenviarEm.getTime()))
        ? ` Tente novamente após ${podeReenviarEm.toLocaleString('pt-BR')}.`
        : '';
      throw new HttpError(429, `Muitas solicitações para este canal.${quando}`);
    }

    const envio = await contatoProvider.enviarCodigo({
      canal: canalNorm,
      destino: destinoNormalizado,            //  destino real
      destinoMascarado: contatoProvider?.mascararDestino
        ? contatoProvider.mascararDestino(canalNorm, destinoNormalizado)
        : destinoNormalizado,                 //  opcional (pra log/preview)
      codigo,
      contexto: { tipo: 'Fisioterapeuta', id: Number(fisioterapeutaId) },
    });
    if (!envio?.ok) {
      throw new HttpError(503, 'Falha ao enviar código de verificação. Tente novamente.');
    }

    return {
      canal: canalNorm,
      destinoMascarado: contatoProvider?.mascararDestino
        ? contatoProvider.mascararDestino(canalNorm, destinoNormalizado)
        : destinoNormalizado,
      expiraEm: row?.ExpiraEm ?? expiraEm,
      ...(envio?.codigo ? { codigoDev: envio.codigo } : {}),
    };

  },

  async confirmarVerificacaoContato(usuarioOrArgs, fisioterapeutaId, dadosParam) {
    // Suporta chamada antiga (usuario, id, dados) e nova ({ usuario, fisioterapeutaId, canal, codigo, ... }).
    const args = usuarioOrArgs;
    const ehObjetoArgs = !!args && typeof args === 'object';
    const pareceNovaAssinatura = ehObjetoArgs && [
      'fisioterapeutaId',
      'FisioterapeutaId',
      'canal',
      'Canal',
      'codigo',
      'Codigo',
      'usuario',
      'user',
      'Usuario',
    ].some((campo) => args[campo] != null);

    let usuario = usuarioOrArgs;
    if (pareceNovaAssinatura) {
      usuario = args.usuario ?? args.user ?? args.Usuario ?? args;
    }
    const fid = pareceNovaAssinatura
      ? (args.fisioterapeutaId ?? args.FisioterapeutaId ?? fisioterapeutaId)
      : fisioterapeutaId;
    const dadosReq = pareceNovaAssinatura ? args : dadosParam;

    const canal = dadosReq?.canal ?? dadosReq?.Canal;
    const codigo = dadosReq?.codigo ?? dadosReq?.Codigo;

    const destinoInput = dadosReq?.destino ?? dadosReq?.Destino;
    const canalNorm = normalizeCanalContato(canal) || inferirCanalPorDestino(destinoInput);
    if (!canalNorm) {
      throw new HttpError(400, "Canal inválido. Use 'Email' ou 'Telefone'.");
    }

    const codigoStr = String(codigo ?? '').trim();
    if (!/^[0-9]{6}$/.test(codigoStr)) {
      throw new HttpError(400, 'Código inválido. Use 6 dígitos.');
    }

    const sel = await queryWithContext(safeUsuario(usuario),
      (req) => {
        req.input('FisioterapeutaId', sql.Int, toIntOrNull(fid));
        req.input('Canal', sql.NVarChar(40), canalNorm);
      },
      `
        SELECT TOP 1
          Id, Destino, CodigoHash, CodigoSalt, ExpiraEm, Tentativas, MaxTentativas, Status
        FROM dbo.VerificacoesContato
        WHERE FisioterapeutaId = @FisioterapeutaId AND Canal = @Canal;
      `,
      { requireContext: true }
    );

    const row = sel?.recordset?.[0];
    if (!row) {
      throw new HttpError(404, 'Nenhuma verificação encontrada para este canal.');
    }

    // idempotente
    if (String(row.Status) === 'Confirmado') {
      return { canal: canalNorm, status: 'Confirmado' };
    }

    if (String(row.Status) === 'Bloqueado') {
      throw new HttpError(400, 'Verificação bloqueada. Solicite um novo código.');
    }

    const now = new Date();
    const expira = row.ExpiraEm ? new Date(row.ExpiraEm) : null;

    if (expira && expira.getTime() < now.getTime()) {
      await queryWithContext(safeUsuario(usuario),
        (req) => {
          req.input('Id', sql.Int, row.Id);
        },
        `
          UPDATE dbo.VerificacoesContato
          SET Status = N'Expirado'
          WHERE Id = @Id AND Status <> N'Confirmado';
        `,
        { requireContext: true }
      );
      throw new HttpError(400, 'Código expirado. Solicite um novo.');
    }

    if (Number(row.Tentativas ?? 0) >= Number(row.MaxTentativas ?? 5)) {
      await queryWithContext(safeUsuario(usuario),
        (req) => {
          req.input('Id', sql.Int, row.Id);
        },
        `
          UPDATE dbo.VerificacoesContato
          SET Status = N'Bloqueado'
          WHERE Id = @Id AND Status <> N'Confirmado';
        `,
        { requireContext: true }
      );
      throw new HttpError(400, 'Verificação bloqueada por excesso de tentativas. Solicite um novo código.');
    }

    const secret = getContatoSecret();
    const saltBuf = Buffer.isBuffer(row.CodigoSalt) ? row.CodigoSalt : Buffer.from(row.CodigoSalt);
    const hashCalc = calcularCodigoHash(secret, saltBuf, canalNorm, codigoStr, String(row.Destino));
    const hashDb = Buffer.isBuffer(row.CodigoHash) ? row.CodigoHash : Buffer.from(row.CodigoHash);

    const ok =
      hashDb?.length === hashCalc?.length &&
      crypto.timingSafeEqual(hashDb, hashCalc);

    if (!ok) {
      await queryWithContext(safeUsuario(usuario),
        (req) => {
          req.input('Id', sql.Int, row.Id);
        },
        `
          UPDATE dbo.VerificacoesContato
          SET Tentativas = ISNULL(Tentativas, 0) + 1,
              Status = CASE
                WHEN ISNULL(Tentativas, 0) + 1 >= ISNULL(MaxTentativas, 5) THEN N'Bloqueado'
                ELSE N'Pendente'
              END
          WHERE Id = @Id
            AND Status = N'Pendente';
        `,
        { requireContext: true }
      );
      throw new HttpError(400, 'Código incorreto.');
    }

    const confirmacaoTx = await queryWithContext(safeUsuario(usuario),
      (req) => {
        req.input('Id', sql.Int, row.Id);
        req.input('FisioterapeutaId', sql.Int, toIntOrNull(fid));
        req.input('Canal', sql.NVarChar(40), canalNorm);
      },
      `
        SET XACT_ABORT ON;
        BEGIN TRAN;
        DECLARE @ConfirmadoAgora BIT = 0;

        UPDATE dbo.VerificacoesContato
        SET Status = N'Confirmado',
            ConfirmadoEm = SYSDATETIME()
        WHERE Id = @Id
          AND Status = N'Pendente'
          AND ExpiraEm >= SYSDATETIME();

        IF @@ROWCOUNT = 1
          SET @ConfirmadoAgora = 1;

        IF @ConfirmadoAgora = 1
        BEGIN
          IF @Canal = N'Email'
          BEGIN
            UPDATE dbo.Fisioterapeutas
            SET EmailVerificado = 1,
                EmailVerificadoEm = SYSDATETIME()
            WHERE Id = @FisioterapeutaId;
          END
          ELSE IF @Canal = N'Telefone'
          BEGIN
            UPDATE dbo.Fisioterapeutas
            SET TelefoneVerificado = 1,
                TelefoneVerificadoEm = SYSDATETIME()
            WHERE Id = @FisioterapeutaId;
          END
        END

        SELECT TOP 1
          @ConfirmadoAgora AS ConfirmadoAgora,
          Status AS StatusFinal,
          ExpiraEm AS ExpiraEmFinal
        FROM dbo.VerificacoesContato
        WHERE Id = @Id;

        COMMIT;
      `,
      { requireContext: true }
    );

    const txRow = confirmacaoTx?.recordset?.[0];
    const confirmouAgora = Number(txRow?.ConfirmadoAgora ?? 0) === 1;
    if (!confirmouAgora) {
      const statusFinal = String(txRow?.StatusFinal ?? '');
      const expiraEmFinal = txRow?.ExpiraEmFinal ? new Date(txRow.ExpiraEmFinal) : null;
      if (statusFinal === 'Bloqueado') {
        throw new HttpError(400, 'Verificação bloqueada. Solicite um novo código.');
      }
      if (statusFinal === 'Expirado' || (expiraEmFinal && expiraEmFinal.getTime() < Date.now())) {
        throw new HttpError(400, 'Código expirado. Solicite um novo.');
      }
      throw new HttpError(409, 'Verificação já processada. Solicite um novo código.');
    }

    return { canal: canalNorm, status: 'Confirmado' };
  },

};



export default fisioterapeutasService;
