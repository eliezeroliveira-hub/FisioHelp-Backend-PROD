import { sql } from '../config/dbConfig.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';

function normalizeText(value, max) {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeUsuarioTipo(tipo) {
  const value = String(tipo || '').trim().toLowerCase();
  if (value === 'paciente') return 'Paciente';
  if (value === 'fisioterapeuta' || value === 'fisio') return 'Fisioterapeuta';
  if (value === 'admin' || value === 'administrador') return 'Admin';
  if (value === 'sistema') return 'Sistema';
  return null;
}

function toPositiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const intValue = Math.trunc(number);
  return intValue > 0 ? intValue : null;
}

export async function registrarCancelamentoLog({
  usuario,
  consultaId = null,
  pacoteId = null,
  motivo,
  observacao = null,
  origemAcao = null,
}) {
  const usuarioId = toPositiveInt(usuario?.id);
  const usuarioTipo = normalizeUsuarioTipo(usuario?.tipo);
  const consultaIdInt = toPositiveInt(consultaId);
  const pacoteIdInt = toPositiveInt(pacoteId);
  const motivoFinal = normalizeText(motivo, 300) || 'Cancelamento sem motivo informado.';
  const observacaoFinal = normalizeText(observacao, 1000);
  const origemAcaoFinal = normalizeText(origemAcao, 100);
  const nomeSnapshot =
    normalizeText(usuario?.nome ?? usuario?.Nome ?? usuario?.email ?? usuario?.Email ?? null, 200);

  if (!usuarioId || !usuarioTipo) {
    log('warn', '[cancelamentosLogService] Contexto de usuario invalido para log.', {
      usuarioId: usuario?.id ?? null,
      usuarioTipo: usuario?.tipo ?? null,
      consultaId: consultaIdInt,
      pacoteId: pacoteIdInt,
    });
    return;
  }

  if ((consultaIdInt ? 1 : 0) + (pacoteIdInt ? 1 : 0) !== 1) {
    log('warn', '[cancelamentosLogService] Origem de cancelamento invalida para log.', {
      consultaId: consultaIdInt,
      pacoteId: pacoteIdInt,
      usuarioId,
      usuarioTipo,
    });
    return;
  }

  try {
    await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, consultaIdInt);
        req.input('PacoteId', sql.Int, pacoteIdInt);
        req.input('Motivo', sql.NVarChar(300), motivoFinal);
        req.input('Observacao', sql.NVarChar(1000), observacaoFinal);
        req.input('UsuarioId', sql.Int, usuarioId);
        req.input('UsuarioTipo', sql.NVarChar(40), usuarioTipo);
        req.input('UsuarioNomeSnapshot', sql.NVarChar(200), nomeSnapshot);
        req.input('OrigemAcao', sql.NVarChar(100), origemAcaoFinal);
      },
      `
        IF OBJECT_ID(N'dbo.CancelamentosLogs', N'U') IS NOT NULL
        BEGIN
          INSERT INTO dbo.CancelamentosLogs (
            ConsultaId,
            PacoteId,
            Motivo,
            Observacao,
            UsuarioId,
            UsuarioTipo,
            UsuarioNomeSnapshot,
            OrigemAcao
          )
          VALUES (
            @ConsultaId,
            @PacoteId,
            @Motivo,
            @Observacao,
            @UsuarioId,
            @UsuarioTipo,
            @UsuarioNomeSnapshot,
            @OrigemAcao
          );
        END
      `
    );
  } catch (err) {
    log('error', '[cancelamentosLogService] Falha ao registrar log de cancelamento.', {
      erro: err?.message || err,
      consultaId: consultaIdInt,
      pacoteId: pacoteIdInt,
      usuarioId,
      usuarioTipo,
    });
  }
}

export default {
  registrarCancelamentoLog,
};
