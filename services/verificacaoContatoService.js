import crypto from 'crypto';
import contatoProvider from '../providers/contatoProvider.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import contatoFilaService from './contatoFilaService.js';
import { HttpError } from '../utils/httpError.js';
import { getContatoSecret } from '../utils/contactSecret.js';
import { normalizeEmail } from '../utils/identityValidators.js';

const VERIFICACAO_CONTATO_COOLDOWN_SEGUNDOS = 60;
const MAX_TENTATIVAS = 5;

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarUsuarioTipo(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'paciente') return 'Paciente';
  if (v === 'fisioterapeuta' || v === 'fisio') return 'Fisioterapeuta';
  return null;
}

function normalizarCanalContato(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'email' || v === 'e-mail') return 'Email';
  if (v === 'telefone' || v === 'tel' || v === 'celular' || v === 'phone') return 'Telefone';
  return null;
}

function normalizarTelefoneE164(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function normalizarDestino(canal, destino) {
  if (!destino) return '';
  if (canal === 'Email') return normalizeEmail(destino);
  return normalizarTelefoneE164(destino);
}

function gerarCodigo6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function gerarSalt16() {
  return crypto.randomBytes(16);
}

function calcularCodigoHash({ salt, canal, codigo, destinoNormalizado }) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt || '');
  const base = `${saltHex}:${String(canal)}:${String(codigo)}:${String(destinoNormalizado)}`;
  return crypto.createHmac('sha256', getContatoSecret()).update(base, 'utf8').digest();
}

function normalizarExpiracaoMinutos(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.trunc(n), 10080);
}

function formatarExpiracao(minutos) {
  const n = Number(minutos);
  if (!Number.isFinite(n) || n <= 0) return '10 minutos';
  if (n % 1440 === 0) {
    const dias = n / 1440;
    return dias === 1 ? '24 horas' : `${dias * 24} horas`;
  }
  if (n % 60 === 0) {
    const horas = n / 60;
    return horas === 1 ? '1 hora' : `${horas} horas`;
  }
  return n === 1 ? '1 minuto' : `${n} minutos`;
}

function montarTextoWhatsAppVerificacao({ codigo, expiraEmMinutos }) {
  return [
    `Seu codigo de verificacao FisioHelp e: ${codigo}`,
    '',
    'No app FisioHelp, acesse Minha Conta > Verificacao de contato, toque em "Verificar agora" no telefone e digite este codigo.',
    '',
    `Este codigo expira em ${formatarExpiracao(expiraEmMinutos)}.`,
    '',
    'Nao compartilhe este codigo.',
  ].join('\n');
}

async function buscarUsuarioContato({ usuarioTipo, usuarioId }) {
  const table = usuarioTipo === 'Paciente' ? 'dbo.Pacientes' : 'dbo.Fisioterapeutas';
  const result = await queryWithContext(
    null,
    (req) => req.input('Id', sql.Int, usuarioId),
    `
      SELECT TOP 1
        Id,
        Nome,
        Email,
        Telefone
      FROM ${table}
      WHERE Id = @Id;
    `
  );

  return result.recordset?.[0] || null;
}

export async function solicitarVerificacaoContatoInterna({
  usuarioTipo,
  usuarioId,
  canal = 'Email',
  forcarReenvio = true,
  destinoInformado = null,
  assunto = null,
  html = null,
  texto = null,
  montarConteudo = null,
  expiraEmMinutos = 10,
  usuario = null,
} = {}) {
  const tipo = normalizarUsuarioTipo(usuarioTipo);
  const id = toInt(usuarioId);
  const canalNorm = normalizarCanalContato(canal);

  if (!tipo || !id) {
    throw new HttpError(400, 'Usuário inválido para verificação de contato.');
  }
  if (!canalNorm) {
    throw new HttpError(400, "Canal inválido. Use 'Email' ou 'Telefone'.");
  }

  const usuarioContato = await buscarUsuarioContato({ usuarioTipo: tipo, usuarioId: id });
  if (!usuarioContato) {
    throw new HttpError(404, `${tipo} não encontrado.`);
  }

  const destino = canalNorm === 'Email' ? usuarioContato.Email : usuarioContato.Telefone;
  if (!destino) {
    throw new HttpError(400, `Destino não encontrado para o canal ${canalNorm}. Atualize seus dados antes de solicitar a verificação.`);
  }

  const destinoNormalizado = normalizarDestino(canalNorm, destino);
  if (!destinoNormalizado) {
    throw new HttpError(400, 'Destino inválido para o canal informado.');
  }

  if (destinoInformado !== null && destinoInformado !== undefined && String(destinoInformado).trim()) {
    const destinoInformadoNormalizado = normalizarDestino(canalNorm, destinoInformado);
    if (!destinoInformadoNormalizado || destinoInformadoNormalizado !== destinoNormalizado) {
      throw new HttpError(
        400,
        `Por segurança, a verificação só pode ser enviada para o ${canalNorm === 'Email' ? 'e-mail' : 'telefone'} cadastrado no seu perfil.`
      );
    }
  }

  const codigo = gerarCodigo6();
  const salt = gerarSalt16();
  const codigoHash = calcularCodigoHash({ canal: canalNorm, destinoNormalizado, codigo, salt });
  const minutos = normalizarExpiracaoMinutos(expiraEmMinutos);
  const expiraEm = new Date(Date.now() + minutos * 60 * 1000);
  const conteudo = typeof montarConteudo === 'function'
    ? montarConteudo({
        codigo,
        usuario: usuarioContato,
        expiraEm,
        expiraEmMinutos: minutos,
      }) || {}
    : {};

  const idColumn = tipo === 'Paciente' ? 'PacienteId' : 'FisioterapeutaId';

  const throttle = await queryWithContext(
    usuario,
    (req) => {
      req.input('UsuarioId', sql.Int, id);
      req.input('Canal', sql.NVarChar(40), canalNorm);
      req.input('Destino', sql.NVarChar(510), destinoNormalizado);
      req.input('CodigoHash', sql.VarBinary(32), codigoHash);
      req.input('CodigoSalt', sql.VarBinary(16), salt);
      req.input('ExpiraEm', sql.DateTime2(7), expiraEm);
      req.input('MaxTentativas', sql.SmallInt, MAX_TENTATIVAS);
      req.input('CooldownSegundos', sql.Int, VERIFICACAO_CONTATO_COOLDOWN_SEGUNDOS);
      req.input('ForcarReenvio', sql.Bit, forcarReenvio !== false ? 1 : 0);
    },
    `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRAN;

      DECLARE @UltimoEnvioEm DATETIME2(7) = NULL;
      DECLARE @ExpiraEmAtual DATETIME2(7) = NULL;
      DECLARE @StatusAtual NVARCHAR(20) = NULL;

      SELECT TOP 1
        @UltimoEnvioEm = UltimoEnvioEm,
        @ExpiraEmAtual = ExpiraEm,
        @StatusAtual = Status
      FROM dbo.VerificacoesContato WITH (UPDLOCK, HOLDLOCK)
      WHERE ${idColumn} = @UsuarioId
        AND Canal = @Canal;

      IF (
        @StatusAtual = N'Pendente'
        AND @ExpiraEmAtual > SYSDATETIME()
      )
      BEGIN
        IF @ForcarReenvio = 0
        BEGIN
          SELECT
            CAST(0 AS BIT) AS PodeEnviar,
            CAST(1 AS BIT) AS CodigoJaEnviado,
            DATEADD(SECOND, @CooldownSegundos, @UltimoEnvioEm) AS PodeReenviarEm,
            @ExpiraEmAtual AS ExpiraEm;
          COMMIT;
          RETURN;
        END

        IF (
          @UltimoEnvioEm IS NOT NULL
          AND DATEDIFF(SECOND, @UltimoEnvioEm, SYSDATETIME()) < @CooldownSegundos
        )
        BEGIN
          SELECT
            CAST(0 AS BIT) AS PodeEnviar,
            CAST(0 AS BIT) AS CodigoJaEnviado,
            DATEADD(SECOND, @CooldownSegundos, @UltimoEnvioEm) AS PodeReenviarEm,
            @ExpiraEmAtual AS ExpiraEm;
          COMMIT;
          RETURN;
        END
      END

      MERGE dbo.VerificacoesContato AS t
      USING (SELECT @UsuarioId AS UsuarioId, @Canal AS Canal) AS s
        ON t.${idColumn} = s.UsuarioId AND t.Canal = s.Canal
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
        INSERT (${idColumn}, Canal, Destino, CodigoHash, CodigoSalt, ExpiraEm, Tentativas, MaxTentativas, Status, CriadoEm, UltimoEnvioEm)
        VALUES (@UsuarioId, @Canal, @Destino, @CodigoHash, @CodigoSalt, @ExpiraEm, 0, @MaxTentativas, N'Pendente', SYSDATETIME(), SYSDATETIME());

      SELECT TOP 1
        CAST(1 AS BIT) AS PodeEnviar,
        CAST(0 AS BIT) AS CodigoJaEnviado,
        DATEADD(SECOND, @CooldownSegundos, UltimoEnvioEm) AS PodeReenviarEm,
        ExpiraEm
      FROM dbo.VerificacoesContato
      WHERE ${idColumn} = @UsuarioId
        AND Canal = @Canal;

      COMMIT;
    `
  );

  const row = throttle?.recordset?.[0] || null;
  const destinoMascarado = contatoProvider?.mascararDestino
    ? contatoProvider.mascararDestino(canalNorm, destinoNormalizado)
    : destinoNormalizado;

  if (Number(row?.CodigoJaEnviado ?? 0) === 1) {
    return {
      canal: canalNorm,
      destinoMascarado,
      expiraEm: row?.ExpiraEm || null,
      podeReenviarEm: row?.PodeReenviarEm || null,
      codigoJaEnviado: true,
    };
  }

  if (Number(row?.PodeEnviar ?? 0) !== 1) {
    const podeReenviarEm = row?.PodeReenviarEm ? new Date(row.PodeReenviarEm) : null;
    const quando = podeReenviarEm && !Number.isNaN(podeReenviarEm.getTime())
      ? ` Tente novamente após ${podeReenviarEm.toLocaleString('pt-BR')}.`
      : '';
    throw new HttpError(429, `Muitas solicitações para este canal.${quando}`);
  }

  const cancelarCodigoPendenteGerado = async () => {
    await queryWithContext(
      usuario,
      (req) => {
        req.input('UsuarioId', sql.Int, id);
        req.input('Canal', sql.NVarChar(40), canalNorm);
        req.input('CodigoHash', sql.VarBinary(32), codigoHash);
      },
      `
        UPDATE dbo.VerificacoesContato
        SET Status = N'Cancelado'
        WHERE ${idColumn} = @UsuarioId
          AND Canal = @Canal
          AND CodigoHash = @CodigoHash
          AND Status = N'Pendente';
      `
    );
  };

  try {
    const textoEnvio = canalNorm === 'Telefone'
      ? montarTextoWhatsAppVerificacao({ codigo, expiraEmMinutos: minutos })
      : (conteudo.corpoTexto || conteudo.texto || texto);

    const itemFila = await contatoFilaService.enfileirarCodigo({
      tipo: 'VerificacaoContato',
      canal: canalNorm,
      destino: destinoNormalizado,
      assunto: canalNorm === 'Telefone' ? null : (conteudo.assunto || assunto),
      html: canalNorm === 'Telefone' ? null : (conteudo.corpoHtml || conteudo.html || html),
      texto: textoEnvio,
      payload: {
        usuarioTipo: tipo,
        usuarioId: id,
        canal: canalNorm,
        destino: destinoNormalizado,
        codigo,
        codigoHashHex: codigoHash.toString('hex'),
        origem: 'verificacao.contato',
      },
    }, usuario);

    if (!itemFila?.Id) {
      throw new Error('Não foi possível registrar o envio na fila transacional.');
    }
  } catch (err) {
    await cancelarCodigoPendenteGerado();
    throw err;
  }

  return {
    canal: canalNorm,
    destinoMascarado,
    expiraEm: row?.ExpiraEm || expiraEm,
    podeReenviarEm: row?.PodeReenviarEm || null,
    codigoJaEnviado: false,
    envioPendente: true,
  };
}

export default {
  solicitarVerificacaoContatoInterna,
};
