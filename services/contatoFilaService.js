import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import contatoProvider from '../providers/contatoProvider.js';
import { queryWithContext } from './_queryWithContext.js';

const STATUS_REPROCESSAVEIS = ['Pendente', 'FalhaTemporaria'];

function systemUser() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function safeUser(usuario) {
  if (usuario?.tipo && usuario?.id) return usuario;
  return systemUser();
}

function text(value, max = 500) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function jsonText(value, max = 4000) {
  if (value === undefined || value === null) return null;
  try {
    return text(JSON.stringify(value), max);
  } catch {
    return null;
  }
}

function normalizarCanal(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'email' || raw === 'e-mail') return 'Email';
  if (raw === 'telefone' || raw === 'whatsapp' || raw === 'whats') return 'Telefone';
  throw new Error('Canal inválido para fila de contato transacional.');
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function calcularBackoffMinutos(tentativas) {
  const attempt = Math.max(1, Number(tentativas) || 1);
  return Math.min(60, Math.max(1, 2 ** Math.min(attempt - 1, 5)));
}

function erroMensagem(erro) {
  return text(erro?.message || erro || 'Falha ao processar contato transacional.', 500);
}

function erroPermanente(erro) {
  const resultado = String(erro?.resultado || '').trim();
  if (resultado === 'invalido' || resultado === 'permFalha') return true;

  const message = String(erro?.message || erro || '').toLowerCase();
  return (
    message.includes('não informado') ||
    message.includes('nao informado') ||
    message.includes('não suportado') ||
    message.includes('nao suportado') ||
    message.includes('inválido') ||
    message.includes('invalido') ||
    message.includes('invalid') ||
    message.includes('forbidden') ||
    message.includes('unauthorized') ||
    message.includes('not authorized')
  );
}

export async function filaDisponivel(usuario = null) {
  const ctx = safeUser(usuario);
  const result = await queryWithContext(ctx, () => {}, `
    SELECT CASE WHEN OBJECT_ID(N'dbo.FilaContatoTransacional', N'U') IS NULL THEN 0 ELSE 1 END AS Disponivel;
  `);

  return Number(result?.recordset?.[0]?.Disponivel ?? 0) === 1;
}

export async function enfileirarCodigo({
  tipo = 'CodigoTransacional',
  canal,
  destino,
  assunto = null,
  html = null,
  texto: textoMensagem = null,
  payload = null,
  maxTentativas = 5,
} = {}, usuario = null) {
  const ctx = safeUser(usuario);
  const canalNorm = normalizarCanal(canal);
  const destinoNorm = text(destino, 255);
  if (!destinoNorm) throw new Error('Destino é obrigatório para fila de contato transacional.');

  const payloadSafe = jsonText(payload);
  const maxTentativasNorm = clampInt(maxTentativas, 5, 1, 20);

  const result = await queryWithContext(ctx, (req) => {
    req.input('Tipo', sql.NVarChar(60), text(tipo, 60) || 'CodigoTransacional');
    req.input('Canal', sql.NVarChar(20), canalNorm);
    req.input('Destino', sql.NVarChar(255), destinoNorm);
    req.input('Assunto', sql.NVarChar(200), text(assunto, 200));
    req.input('Html', sql.NVarChar(sql.MAX), text(html, 200000));
    req.input('Texto', sql.NVarChar(sql.MAX), text(textoMensagem, 200000));
    req.input('PayloadJson', sql.NVarChar(sql.MAX), payloadSafe);
    req.input('MaxTentativas', sql.TinyInt, maxTentativasNorm);
    req.input('UsuarioRegistro', sql.NVarChar(200), text(`${ctx.tipo}:${ctx.id}`, 200));
  }, `
    INSERT INTO dbo.FilaContatoTransacional
      (Tipo, Canal, Destino, Assunto, Html, Texto, PayloadJson, Status, Tentativas, MaxTentativas,
       ProximaTentativaEm, UsuarioRegistro)
    OUTPUT INSERTED.*
    VALUES
      (@Tipo, @Canal, @Destino, @Assunto, @Html, @Texto, @PayloadJson, N'Pendente', 0, @MaxTentativas,
       SYSDATETIME(), @UsuarioRegistro);
  `);

  return result?.recordset?.[0] ?? null;
}

export async function recuperarProcessandoTravado({ staleMinutes = 10 } = {}, usuario = null) {
  const ctx = safeUser(usuario);
  const minutes = clampInt(staleMinutes, 10, 1, 240);

  const result = await queryWithContext(ctx, (req) => {
    req.input('StaleMinutes', sql.Int, minutes);
  }, `
    UPDATE dbo.FilaContatoTransacional
    SET Status = N'FalhaTemporaria',
        ProcessandoEm = NULL,
        ProximaTentativaEm = SYSDATETIME(),
        ErroMensagem = N'Worker interrompido ou processamento excedeu o tempo limite.',
        AtualizadoEm = SYSDATETIME()
    WHERE Status = N'Processando'
      AND ProcessandoEm < DATEADD(MINUTE, -@StaleMinutes, SYSDATETIME());

    SELECT @@ROWCOUNT AS Recuperados;
  `);

  return Number(result?.recordset?.[0]?.Recuperados ?? 0);
}

export async function claimProximo(usuario = null) {
  const ctx = safeUser(usuario);

  const result = await queryWithContext(ctx, () => {}, `
    ;WITH Proximo AS (
      SELECT TOP (1) *
      FROM dbo.FilaContatoTransacional WITH (UPDLOCK, READPAST, ROWLOCK, READCOMMITTEDLOCK)
      WHERE Status IN (N'Pendente', N'FalhaTemporaria')
        AND Tentativas < MaxTentativas
        AND (ProximaTentativaEm IS NULL OR ProximaTentativaEm <= SYSDATETIME())
      ORDER BY
        COALESCE(ProximaTentativaEm, CriadoEm),
        Id
    )
    UPDATE Proximo
    SET Status = N'Processando',
        ProcessandoEm = SYSDATETIME(),
        Tentativas = CASE WHEN Tentativas < 255 THEN Tentativas + 1 ELSE Tentativas END,
        ErroMensagem = NULL,
        AtualizadoEm = SYSDATETIME()
    OUTPUT INSERTED.*;
  `);

  return result?.recordset?.[0] ?? null;
}

export async function marcarProcessado(item, _resultado = null, usuario = null) {
  const ctx = safeUser(usuario);
  const id = Number(item?.Id);
  if (!Number.isInteger(id) || id <= 0) return;

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, id);
  }, `
    UPDATE dbo.FilaContatoTransacional
    SET Status = N'Processado',
        ProcessandoEm = NULL,
        ProximaTentativaEm = NULL,
        ErroMensagem = NULL,
        Html = NULL,
        Texto = NULL,
        PayloadJson = NULL,
        ProcessadoEm = SYSDATETIME(),
        AtualizadoEm = SYSDATETIME()
    WHERE Id = @Id;
  `);
}

export async function marcarFalhaTemporaria(item, erro, usuario = null) {
  const ctx = safeUser(usuario);
  const id = Number(item?.Id);
  if (!Number.isInteger(id) || id <= 0) return;

  const tentativas = Number(item?.Tentativas ?? 1);
  const maxTentativas = Number(item?.MaxTentativas ?? 5);
  const statusFinal = tentativas >= maxTentativas || erroPermanente(erro)
    ? 'FalhaPermanente'
    : 'FalhaTemporaria';
  const delayMinutes = calcularBackoffMinutos(tentativas);

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, id);
    req.input('Status', sql.NVarChar(30), statusFinal);
    req.input('DelayMinutes', sql.Int, delayMinutes);
    req.input('ErroMensagem', sql.NVarChar(500), erroMensagem(erro));
  }, `
    UPDATE dbo.FilaContatoTransacional
    SET Status = @Status,
        ProcessandoEm = NULL,
        ProximaTentativaEm = CASE
          WHEN @Status = N'FalhaTemporaria' THEN DATEADD(MINUTE, @DelayMinutes, SYSDATETIME())
          ELSE NULL
        END,
        Html = CASE WHEN @Status = N'FalhaPermanente' THEN NULL ELSE Html END,
        Texto = CASE WHEN @Status = N'FalhaPermanente' THEN NULL ELSE Texto END,
        PayloadJson = CASE WHEN @Status = N'FalhaPermanente' THEN NULL ELSE PayloadJson END,
        ErroMensagem = @ErroMensagem,
        AtualizadoEm = SYSDATETIME()
    WHERE Id = @Id;
  `);
}

export async function processarItem(item, usuario = null) {
  const canal = normalizarCanal(item?.Canal);
  const resultado = await contatoProvider.enviarCodigo({
    canal,
    destino: item?.Destino,
    codigo: '',
    assunto: item?.Assunto,
    html: item?.Html,
    texto: item?.Texto,
  });

  await marcarProcessado(item, resultado, usuario);
  return resultado;
}

export async function processarPendentes({ batchSize = 10 } = {}, usuario = null) {
  const ctx = safeUser(usuario);
  const limit = clampInt(batchSize, 10, 1, 50);
  const resumo = { processados: 0, falhas: 0 };

  for (let i = 0; i < limit; i += 1) {
    const item = await claimProximo(ctx);
    if (!item) break;

    try {
      await processarItem(item, ctx);
      resumo.processados += 1;
    } catch (err) {
      resumo.falhas += 1;
      await marcarFalhaTemporaria(item, err, ctx);
      log('warn', 'Falha ao processar fila de contato transacional', {
        id: item.Id,
        tipo: item.Tipo,
        canal: item.Canal,
        tentativa: item.Tentativas,
        erro: err?.message,
        resultado: err?.resultado,
      });
    }
  }

  return resumo;
}

const contatoFilaService = {
  filaDisponivel,
  enfileirarCodigo,
  recuperarProcessandoTravado,
  claimProximo,
  marcarProcessado,
  marcarFalhaTemporaria,
  processarItem,
  processarPendentes,
  STATUS_REPROCESSAVEIS,
};

export default contatoFilaService;
