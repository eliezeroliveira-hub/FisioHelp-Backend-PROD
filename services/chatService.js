// 📁 services/chatService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import moderateChatMessage from './chatModerationService.js';
import notificacoesDispatch from './notificacoesDispatch.js';
import { HttpError } from '../utils/httpError.js';

const asTipo = (u) => String(u?.tipo || '').toLowerCase();
const isAdmin = (u) => asTipo(u) === 'admin';
const isFisio = (u) => asTipo(u) === 'fisioterapeuta';
const isPaciente = (u) => asTipo(u) === 'paciente';

function assertUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(v, maxLen = 8000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s.length) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function extractSqlLocalDateTimeParts(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      millisecond: value.getUTCMilliseconds(),
    };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/Z$/i, '')
    .replace(/([+-]\d{2}:\d{2})$/, '')
    .replace(' ', 'T');

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?/
  );
  if (!match) return null;

  const fraction = String(match[7] ?? '').padEnd(3, '0').slice(0, 3);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
    millisecond: Number(fraction || '0'),
  };
}

function formatSqlLocalDateTime(value) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return null;

  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}

function mapConversaRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataHora: formatSqlLocalDateTime(row.DataHora),
    ChatLiberadoEm: formatSqlLocalDateTime(row.ChatLiberadoEm),
    UltimaMensagemEm: formatSqlLocalDateTime(row.UltimaMensagemEm),
  };
}

function mapMensagemRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataEnvio: formatSqlLocalDateTime(row.DataEnvio),
  };
}

async function registrarModeracao(usuario, dados = {}) {
  try {
    await queryWithContext(
      usuario,
      (req) => {
        req.input('MensagemId', sql.Int, dados.mensagemId ?? null);
        req.input('Acao', sql.VarChar(20), String(dados.acao || 'BLOQUEADA'));
        req.input('Motivo', sql.NVarChar(510), dados.motivo ?? null);
        req.input('TrechoDetectado', sql.VarChar(200), dados.trechoDetectado ?? null);
        req.input('RemetenteId', sql.Int, dados.remetenteId ?? null);
        req.input('DestinatarioId', sql.Int, dados.destinatarioId ?? null);
        req.input('ConsultaId', sql.Int, dados.consultaId ?? null);
        req.input('Origem', sql.NVarChar(100), dados.origem ?? 'API_CHAT_PREMODERACAO');
      },
      `
        INSERT INTO dbo.ChatModerationLogs
        (
          MensagemId,
          Acao,
          Motivo,
          TrechoDetectado,
          RemetenteId,
          DestinatarioId,
          ConsultaId,
          Origem
        )
        VALUES
        (
          @MensagemId,
          @Acao,
          @Motivo,
          @TrechoDetectado,
          @RemetenteId,
          @DestinatarioId,
          @ConsultaId,
          @Origem
        );
      `
    );
  } catch {
    // A moderação não pode depender do log para bloquear ou permitir o fluxo.
  }
}

async function getConsultaOrThrow(usuario, consultaId) {
  const id = assertInt(consultaId, 'consultaId');

  const r = await queryWithContext(
    usuario,
    (req) => req.input('ConsultaId', sql.Int, id),
    `
      SELECT
        c.Id,
        c.PacienteId,
        c.FisioterapeutaId,
        c.Status,
        ISNULL(c.ChatLiberado, 0) AS ChatLiberado,
        c.ChatLiberadoEm
      FROM dbo.Consultas c
      WHERE c.Id = @ConsultaId;
    `
  );

  const consulta = r.recordset?.[0];
  if (!consulta) throw new HttpError(404, 'Consulta não encontrada.');

  // Permissão:
  const uid = assertInt(usuario.id, 'Usuário');
  if (!isAdmin(usuario)) {
    if (isPaciente(usuario) && consulta.PacienteId !== uid) throw new HttpError(403, 'Acesso negado.');
    if (isFisio(usuario) && consulta.FisioterapeutaId !== uid) throw new HttpError(403, 'Acesso negado.');
    if (!isPaciente(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');
  }

  return consulta;
}

function descricaoDocumentoChat(tipoDocumento) {
  const tipo = String(tipoDocumento || '').trim().toLowerCase();
  if (tipo === 'autorizacaoatendimento') return 'um pedido médico';
  return 'um documento';
}

function buildDocumentoMensagemPayload({ documentoPacienteId, tipoDocumento }) {
  // Conteudo em JSON (MVP) para o app conseguir renderizar “card de documento”
  return JSON.stringify({
    tipo: 'documento',
    texto: `Paciente enviou ${descricaoDocumentoChat(tipoDocumento)} para esta consulta.`,
    documentoPacienteId
  });
}

const chatService = {
  /**
   * GET /chat/conversas
   * Lista “conversas” por ConsultaId (somente do usuário logado; admin vê todas se quiser).
   */
  async listarConversas(usuario, { limit = 50, offset = 0, incluirNaoLiberado = 0 } = {}) {
    assertUser(usuario);

    const lim = clamp(Number(limit) || 50, 1, 200);
    const off = Math.max(0, Number(offset) || 0);

    const tipo = asTipo(usuario);
    const usuarioId = assertInt(usuario.id, 'Usuário');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('UsuarioId', sql.Int, usuarioId);
        req.input('Tipo', sql.NVarChar(30), tipo);
        req.input('Limit', sql.Int, lim);
        req.input('Offset', sql.Int, off);
        req.input('IncluirNaoLiberado', sql.Bit, incluirNaoLiberado ? 1 : 0);
      },
      `
      ;WITH Base AS (
        SELECT
          c.Id AS ConsultaId,
          c.DataHora,
          c.Status,
          ISNULL(c.ChatLiberado, 0) AS ChatLiberado,
          c.ChatLiberadoEm,
          p.Id AS PacienteId,
          p.Nome AS PacienteNome,
          ISNULL(p.CPFValido, 0) AS PacienteCpfValido,
          ISNULL(p.EmailVerificado, 0) AS PacienteEmailVerificado,
          ISNULL(p.TelefoneVerificado, 0) AS PacienteTelefoneVerificado,
          CAST(CASE
            WHEN ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1 ELSE 0
          END AS bit) AS PacienteContaVerificada,
          f.Id AS FisioterapeutaId,
          f.Nome AS FisioterapeutaNome,
          ISNULL(f.CrefitoVerificado, 0) AS CrefitoVerificado,
          ISNULL(f.EmailVerificado, 0) AS EmailVerificado,
          ISNULL(f.TelefoneVerificado, 0) AS TelefoneVerificado,
          vfp.FotoPerfilUrl AS FisioterapeutaFotoUrl,
          CASE
            WHEN @Tipo = 'paciente' THEN f.Id
            ELSE p.Id
          END AS OutroId,
          CASE
            WHEN @Tipo = 'paciente' THEN f.Nome
            ELSE p.Nome
          END AS OutroNome,
          CASE
            WHEN @Tipo = 'paciente' THEN vfp.FotoPerfilUrl
            ELSE NULL
          END AS OutroFotoUrl,
          CAST(CASE
            WHEN @Tipo = 'paciente'
             AND ISNULL(f.CrefitoVerificado, 0) = 1
             AND ISNULL(f.EmailVerificado, 0) = 1
             AND ISNULL(f.TelefoneVerificado, 0) = 1
            THEN 1
            WHEN @Tipo = 'fisioterapeuta'
             AND ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1
            ELSE 0
          END AS bit) AS OutroContaVerificada
        FROM dbo.Consultas c
        INNER JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        LEFT JOIN dbo.vw_FisioterapeutaPerfilPublico vfp ON vfp.FisioterapeutaId = f.Id
        WHERE
          (
            @Tipo = 'admin'
            OR (@Tipo = 'paciente' AND c.PacienteId = @UsuarioId)
            OR (@Tipo = 'fisioterapeuta' AND c.FisioterapeutaId = @UsuarioId)
          )
          AND (
            @IncluirNaoLiberado = 1
            OR ISNULL(c.ChatLiberado, 0) = 1
          )
      )
      SELECT
        b.*,
        lm.Id AS UltimaMensagemId,
        lm.Conteudo AS UltimaMensagem,
        lm.DataEnvio AS UltimaMensagemEm,
        lm.RemetenteId AS UltimaMensagemRemetenteId,
        lm.TipoRemetente AS UltimaMensagemTipoRemetente,
        ISNULL(nl.NaoLidas, 0) AS NaoLidas
      FROM Base b
      OUTER APPLY (
        SELECT TOP 1 m.*
        FROM dbo.Mensagens m
        WHERE m.ConsultaId = b.ConsultaId
        ORDER BY m.DataEnvio DESC, m.Id DESC
      ) lm
      OUTER APPLY (
        SELECT COUNT(1) AS NaoLidas
        FROM dbo.Mensagens m
        WHERE m.ConsultaId = b.ConsultaId
          AND m.DestinatarioId = @UsuarioId
          AND ISNULL(m.Lida, 0) = 0
      ) nl
      ORDER BY
        COALESCE(lm.DataEnvio, b.DataHora) DESC,
        b.ConsultaId DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return (result.recordset || []).map(mapConversaRow);
  },

    /**
   * GET /chat/conversas/:consultaId/mensagens
   * - Marca como lidas as mensagens onde o usuário é destinatário.
   */
  async listarMensagens(usuario, consultaId, { limit = 200, offset = 0 } = {}) {
    assertUser(usuario);

    const consultaIdNum = assertInt(consultaId, 'consultaId');
    const consulta = await getConsultaOrThrow(usuario, consultaIdNum);

    // bloqueio se chat não liberado (exceto admin)
    if (!isAdmin(usuario) && !consulta.ChatLiberado) {
      throw new HttpError(409, 'Chat ainda não está liberado para esta consulta.');
    }

    const lim = clamp(Number(limit) || 200, 1, 500);
    const off = Math.max(0, Number(offset) || 0);

    const usuarioId = assertInt(usuario.id, 'Usuário');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, Number(consulta.Id));
        req.input('UsuarioId', sql.Int, usuarioId);
        req.input('Limit', sql.Int, lim);
        req.input('Offset', sql.Int, off);
      },
      `
      UPDATE dbo.Mensagens
      SET Lida = 1
      WHERE ConsultaId = @ConsultaId
        AND DestinatarioId = @UsuarioId
        AND ISNULL(Lida, 0) = 0;

      SELECT
        Id,
        ConsultaId,
        RemetenteId,
        DestinatarioId,
        TipoRemetente,
        Conteudo,
        DataEnvio,
        ISNULL(Lida, 0) AS Lida
      FROM dbo.Mensagens
      WHERE ConsultaId = @ConsultaId
      ORDER BY DataEnvio ASC, Id ASC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return (result.recordset || []).map(mapMensagemRow);
  },

  /**
   * POST /chat/mensagens
   * Body:
   * - consultaId (obrigatório)
   * - conteudo (obrigatório, a menos que documentoPacienteId seja informado)
   * - documentoPacienteId (opcional) => manda “card de documento” via JSON no Conteudo
   */
  async enviarMensagem(usuario, payload = {}, options = {}) {
    assertUser(usuario);
    if (isAdmin(usuario)) throw new HttpError(403, 'Admin não envia mensagens pelo chat (MVP).');

    const consultaId = assertInt(
      payload.consultaId ?? payload.ConsultaId ?? payload.conversaId ?? payload.ConversaId,
      'consultaId'
    );

    const conteudo = payload.conteudo ?? payload.Conteudo ?? payload.mensagem ?? payload.Mensagem ?? null;
    const documentoPacienteId = payload.documentoPacienteId ?? payload.DocumentoPacienteId ?? null;
    const enviandoDocumento = documentoPacienteId !== undefined && documentoPacienteId !== null;
    const permitirDocumentoAntesLiberacao = options?.permitirDocumentoAntesLiberacao === true;

    const consulta = await getConsultaOrThrow(usuario, consultaId);

    if (!consulta.ChatLiberado && !(enviandoDocumento && permitirDocumentoAntesLiberacao)) {
      throw new HttpError(409, 'Chat ainda não está liberado para esta consulta.');
    }

    const uid = assertInt(usuario.id, 'Usuário');

    let remetenteId;
    let destinatarioId;
    let tipoRemetente;

    if (isPaciente(usuario)) {
      remetenteId = consulta.PacienteId;
      destinatarioId = consulta.FisioterapeutaId;
      tipoRemetente = 'Paciente';
    } else if (isFisio(usuario)) {
      remetenteId = consulta.FisioterapeutaId;
      destinatarioId = consulta.PacienteId;
      tipoRemetente = 'Fisioterapeuta';
    } else {
      throw new HttpError(403, 'Acesso negado.');
    }

    // sanity (evita token com id inconsistente)
    if (remetenteId !== uid) throw new HttpError(403, 'Acesso negado.');

    let conteudoFinal = normalizeText(conteudo, 8000);

    // mensagem "anexo" via DocumentosPacientes
    if (documentoPacienteId !== undefined && documentoPacienteId !== null) {
      const docId = assertInt(documentoPacienteId, 'documentoPacienteId');

      const docRes = await queryWithContext(
        usuario,
        (req) => req.input('DocId', sql.Int, docId),
        `
          SELECT TOP 1
            Id,
            PacienteId,
            TipoDocumento,
            CaminhoArquivo,
            ConsultaId
          FROM dbo.DocumentosPacientes
          WHERE Id = @DocId;
        `
      );

      const doc = docRes.recordset?.[0];
      if (!doc) throw new HttpError(404, 'Documento do paciente não encontrado.');

      // documento tem que ser do paciente logado e da mesma consulta (se ConsultaId existir)
      if (doc.PacienteId !== consulta.PacienteId) throw new HttpError(403, 'Documento não pertence ao paciente desta consulta.');
      if (doc.ConsultaId && Number(doc.ConsultaId) !== Number(consulta.Id)) throw new HttpError(409, 'Documento não está vinculado a esta consulta.');

      conteudoFinal = buildDocumentoMensagemPayload({
        documentoPacienteId: doc.Id,
        tipoDocumento: doc.TipoDocumento
      });
    }

    if (!conteudoFinal) throw new HttpError(400, 'Conteúdo da mensagem é obrigatório.');
    if (conteudoFinal.length > 2000) throw new HttpError(400, 'Mensagem muito longa.');

    if (!enviandoDocumento) {
      const moderacao = moderateChatMessage(conteudoFinal);
      if (moderacao.blocked) {
        await registrarModeracao(usuario, {
          acao: 'BLOQUEADA',
          motivo: moderacao.motivo,
          trechoDetectado: moderacao.trechoDetectado,
          remetenteId,
          destinatarioId,
          consultaId: Number(consulta.Id),
        });

        throw new HttpError(400, moderacao.mensagemUsuario);
      }
    }

    const insert = await queryWithContext(
      usuario,
      (req) => {
        req.input('RemetenteId', sql.Int, remetenteId);
        req.input('DestinatarioId', sql.Int, destinatarioId);
        req.input('TipoRemetente', sql.NVarChar(40), tipoRemetente);
        req.input('Conteudo', sql.NVarChar(sql.MAX), conteudoFinal);
        req.input('ConsultaId', sql.Int, Number(consulta.Id));
      },
      `
      DECLARE @Novo TABLE (Id INT);

      INSERT INTO dbo.Mensagens (
        RemetenteId, DestinatarioId, TipoRemetente, Conteudo, ConsultaId
      )
      OUTPUT INSERTED.Id INTO @Novo(Id)
      VALUES (
        @RemetenteId, @DestinatarioId, @TipoRemetente, @Conteudo, @ConsultaId
      );

      SELECT TOP 1 Id FROM @Novo;
      `
    );

    const msgId = insert.recordset?.[0]?.Id;
    // Pedido medico pode ser anexado enquanto a consulta ainda esta aguardando.
    // Nesse caso registramos a mensagem para ela aparecer quando o chat for liberado,
    // mas nao disparamos notificacao de "nova mensagem" antes da conversa existir para o usuario.
    if (consulta.ChatLiberado) {
      void notificacoesDispatch.chatNovaMensagem({
        consultaId: Number(consulta.Id),
        mensagemId: msgId,
        remetenteTipo: tipoRemetente,
        conteudo: conteudoFinal
      });
    }

    return { sucesso: true, mensagemId: msgId };
  },

  /**
   * ✅ Função para o upload do paciente chamar após inserir DocumentosPacientes.
   * Ela cria a mensagem automática na conversa.
   */
  async notificarDocumentoPacienteEnviado(usuario, { consultaId, documentoPacienteId }) {
    return this.enviarMensagem(
      usuario,
      { consultaId, documentoPacienteId },
      { permitirDocumentoAntesLiberacao: true }
    );
  }
};

export { HttpError };
export default chatService;
