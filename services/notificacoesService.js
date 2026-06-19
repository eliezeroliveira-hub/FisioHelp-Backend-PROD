import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { enviarEmail } from '../providers/emailProvider.js';
import { enviarPush } from '../providers/pushProvider.js';
import { enviarWhatsApp } from '../providers/whatsappProvider.js';
import { HttpError } from '../utils/httpError.js';
import { isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import { queryWithContext } from './_queryWithContext.js';
import { montarEmailNotificacao } from './emailTemplates.js';
import emailSupressaoService from './emailSupressaoService.js';

const USUARIOS_VALIDOS = new Set(['Paciente', 'Fisioterapeuta']);
const PLATAFORMAS_VALIDAS = new Set(['ios', 'android']);
const CANAIS_VALIDOS = new Set(['push', 'email', 'whatsapp']);
const TIPOS_VALIDOS = new Set([
  'Promocao',
  'Chat',
  'Pagamento',
  'Agendamento',
  'Disputa',
  'Chamado',
  'Credenciamento'
]);

function contextoSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function usuarioRegistro(usuario) {
  if (!usuario?.tipo || !usuario?.id) return null;
  return `${usuario.tipo}:${usuario.id}`;
}

function normalizarTipoUsuario(tipo) {
  const valor = String(tipo || '').trim();
  if (valor.toLowerCase() === 'paciente') return 'Paciente';
  if (valor.toLowerCase() === 'fisioterapeuta') return 'Fisioterapeuta';
  return valor;
}

function validarUsuarioDestino(usuarioTipo, usuarioId) {
  const tipo = normalizarTipoUsuario(usuarioTipo);
  const id = Number(usuarioId);

  if (!USUARIOS_VALIDOS.has(tipo)) {
    throw new HttpError(400, 'UsuarioTipo inválido.');
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'UsuarioId inválido.');
  }

  return { usuarioTipo: tipo, usuarioId: id };
}

function validarPlataforma(plataforma) {
  const valor = String(plataforma || '').trim().toLowerCase();
  if (!PLATAFORMAS_VALIDAS.has(valor)) {
    throw new HttpError(400, 'plataforma inválida. Use ios ou android.');
  }
  return valor;
}

function validarTokenPush(tokenPush) {
  const valor = String(tokenPush || '').trim();
  if (!valor) throw new HttpError(400, 'tokenPush é obrigatório.');
  if (valor.length > 512) throw new HttpError(400, 'tokenPush deve ter no máximo 512 caracteres.');
  return valor;
}

function normalizarTextoObrigatorio(valor, campo, max) {
  const texto = String(valor || '').trim();
  if (!texto) throw new HttpError(400, `${campo} é obrigatório.`);
  if (texto.length > max) throw new HttpError(400, `${campo} deve ter no máximo ${max} caracteres.`);
  return texto;
}

function normalizarTextoOpcional(valor, campo, max) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (!texto) return null;
  if (texto.length > max) throw new HttpError(400, `${campo} deve ter no máximo ${max} caracteres.`);
  return texto;
}

function validarCanal(canal) {
  const valor = String(canal || 'push').trim().toLowerCase();
  if (!CANAIS_VALIDOS.has(valor)) {
    throw new HttpError(400, 'canal inválido.');
  }
  return valor;
}

function normalizarCanaisAtivos(canaisAtivos) {
  if (canaisAtivos === undefined || canaisAtivos === null) return ['push'];
  if (!Array.isArray(canaisAtivos)) {
    throw new HttpError(400, 'canaisAtivos inválido.');
  }

  return [...new Set(canaisAtivos.map((canal) => validarCanal(canal)))];
}

function isBitAtivo(value) {
  return value === true || Number(value) === 1;
}

function normalizarTelefoneE164(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return `+${digits}`;
  }

  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  return '';
}

function validarTipo(tipo) {
  if (tipo === null || tipo === undefined || String(tipo).trim() === '') return null;
  const valor = String(tipo).trim();
  if (!TIPOS_VALIDOS.has(valor)) {
    throw new HttpError(400, 'tipo de notificação inválido.');
  }
  return valor;
}

function normalizarReferenciaId(referenciaId) {
  if (referenciaId === null || referenciaId === undefined || referenciaId === '') return null;
  const id = Number(referenciaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'referenciaId inválido.');
  }
  return id;
}

function normalizarDadosJson(dados) {
  if (dados === null || dados === undefined) return null;

  if (typeof dados === 'string') {
    const texto = dados.trim();
    if (!texto) return null;

    try {
      JSON.parse(texto);
      return texto;
    } catch {
      throw new HttpError(400, 'dados deve ser um JSON válido.');
    }
  }

  try {
    return JSON.stringify(dados);
  } catch {
    throw new HttpError(400, 'dados não pôde ser serializado como JSON.');
  }
}

function truncarInbox(mensagem) {
  return String(mensagem || '').slice(0, 255);
}

async function registrarDispositivo({ plataforma, tokenPush }, usuario) {
  const { usuarioTipo, usuarioId } = validarUsuarioDestino(usuario?.tipo, usuario?.id);
  const plataformaNorm = validarPlataforma(plataforma);
  const tokenNorm = validarTokenPush(tokenPush);
  const registro = usuarioRegistro(usuario);

  const result = await queryWithContext(contextoSistema(), (req) => {
    req.input('UsuarioTipo', sql.NVarChar(20), usuarioTipo);
    req.input('UsuarioId', sql.Int, usuarioId);
    req.input('Plataforma', sql.NVarChar(10), plataformaNorm);
    req.input('TokenPush', sql.NVarChar(512), tokenNorm);
    req.input('UsuarioRegistro', sql.NVarChar(200), registro);
  }, `
    MERGE [dbo].[DispositivosNotificacao] WITH (HOLDLOCK) AS alvo
    USING (SELECT @TokenPush AS TokenPush) AS origem
      ON alvo.[TokenPush] = origem.[TokenPush]
    WHEN MATCHED THEN
      UPDATE SET
        [UsuarioTipo] = @UsuarioTipo,
        [UsuarioId] = @UsuarioId,
        [Plataforma] = @Plataforma,
        [Ativo] = 1,
        [AtualizadoEm] = SYSDATETIME(),
        [UsuarioRegistro] = @UsuarioRegistro
    WHEN NOT MATCHED THEN
      INSERT ([UsuarioTipo], [UsuarioId], [Plataforma], [TokenPush], [Ativo], [CriadoEm], [AtualizadoEm], [UsuarioRegistro])
      VALUES (@UsuarioTipo, @UsuarioId, @Plataforma, @TokenPush, 1, SYSDATETIME(), SYSDATETIME(), @UsuarioRegistro)
    OUTPUT inserted.[Id] AS [Id], inserted.[Ativo] AS [Ativo];
  `, { requireContext: true });

  const row = result.recordset?.[0];
  if (!row?.Id) {
    throw new HttpError(500, 'Falha ao registrar dispositivo.');
  }

  return { id: row.Id, ativo: true };
}

async function desativarDispositivo({ tokenPush }, usuario) {
  const tokenNorm = validarTokenPush(tokenPush);
  const registro = usuarioRegistro(usuario);

  await queryWithContext(usuario, (req) => {
    req.input('TokenPush', sql.NVarChar(512), tokenNorm);
    req.input('UsuarioRegistro', sql.NVarChar(200), registro);
  }, `
    UPDATE [dbo].[DispositivosNotificacao]
    SET
      [Ativo] = 0,
      [AtualizadoEm] = SYSDATETIME(),
      [UsuarioRegistro] = @UsuarioRegistro
    WHERE [TokenPush] = @TokenPush;
  `, { requireContext: true });

  return { ativo: false };
}

async function enfileirarNotificacao(
  {
    usuarioTipo,
    usuarioId,
    canal = 'push',
    tipo = null,
    titulo = null,
    mensagem,
    dados = null,
    referenciaId = null
  },
  { usuarioRegistro: registroInput = null, gravarInbox = true } = {}
) {
  const destino = validarUsuarioDestino(usuarioTipo, usuarioId);
  const canalNorm = validarCanal(canal);
  const tipoNorm = validarTipo(tipo);
  const tituloNorm = normalizarTextoOpcional(titulo, 'titulo', 120);
  const mensagemNorm = normalizarTextoObrigatorio(mensagem, 'mensagem', 500);
  const dadosJson = normalizarDadosJson(dados);
  const referenciaIdNorm = normalizarReferenciaId(referenciaId);
  const registro = normalizarTextoOpcional(registroInput, 'usuarioRegistro', 200);

  const filaResult = await queryWithContext(contextoSistema(), (req) => {
    req.input('UsuarioTipo', sql.NVarChar(20), destino.usuarioTipo);
    req.input('UsuarioId', sql.Int, destino.usuarioId);
    req.input('Canal', sql.NVarChar(10), canalNorm);
    req.input('Tipo', sql.NVarChar(30), tipoNorm);
    req.input('Titulo', sql.NVarChar(120), tituloNorm);
    req.input('Mensagem', sql.NVarChar(500), mensagemNorm);
    req.input('DadosJson', sql.NVarChar(sql.MAX), dadosJson);
    req.input('ReferenciaId', sql.Int, referenciaIdNorm);
    req.input('UsuarioRegistro', sql.NVarChar(200), registro);
  }, `
    INSERT INTO [dbo].[FilaNotificacoes]
      ([UsuarioTipo], [UsuarioId], [Canal], [Tipo], [Titulo], [Mensagem], [DadosJson], [ReferenciaId], [UsuarioRegistro])
    OUTPUT inserted.[Id] AS [Id]
    VALUES
      (@UsuarioTipo, @UsuarioId, @Canal, @Tipo, @Titulo, @Mensagem, @DadosJson, @ReferenciaId, @UsuarioRegistro);
  `, { requireContext: true });

  const filaId = filaResult.recordset?.[0]?.Id;
  if (!filaId) {
    throw new HttpError(500, 'Falha ao enfileirar notificação.');
  }

  let inboxId = null;
  if (gravarInbox !== false) {
    try {
      const inboxResult = await queryWithContext(contextoSistema(), (req) => {
        req.input('UsuarioTipo', sql.NVarChar(20), destino.usuarioTipo);
        req.input('UsuarioId', sql.Int, destino.usuarioId);
        req.input('Tipo', sql.NVarChar(30), tipoNorm);
        req.input('Mensagem', sql.NVarChar(255), truncarInbox(mensagemNorm));
        req.input('ReferenciaId', sql.Int, referenciaIdNorm);
      }, `
        INSERT INTO [dbo].[Notificacoes]
          ([UsuarioTipo], [UsuarioId], [Tipo], [Mensagem], [Lida], [DataEnvio], [ReferenciaId])
        OUTPUT inserted.[Id] AS [Id]
        VALUES
          (@UsuarioTipo, @UsuarioId, @Tipo, @Mensagem, 0, GETDATE(), @ReferenciaId);
      `, { requireContext: true });

      inboxId = inboxResult.recordset?.[0]?.Id ?? null;
    } catch (erro) {
      log('warn', 'Falha ao gravar inbox in-app para notificação enfileirada', {
        filaId,
        usuarioTipo: destino.usuarioTipo,
        usuarioId: destino.usuarioId,
        erro: erro?.message
      });
    }
  }

  return { filaId, inboxId };
}

function normalizarIdPositivo(valor, campo = 'id') {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `${campo} inválido.`);
  }
  return id;
}

function normalizarErro(erro, fallback = 'Falha ao processar notificação.') {
  const texto = String(erro?.message ?? erro ?? fallback).trim() || fallback;
  return texto.length > 500 ? texto.slice(0, 500) : texto;
}

function calcularBackoffSeg(tentativas = 0) {
  const tentativaAtual = Math.max(0, Number(tentativas) || 0);
  return Math.min(60 * (2 ** tentativaAtual), 3600);
}

function parseDadosJsonSeguro(dadosJson) {
  if (dadosJson === null || dadosJson === undefined || dadosJson === '') return null;
  if (typeof dadosJson !== 'string') return dadosJson;

  try {
    return JSON.parse(dadosJson);
  } catch {
    return null;
  }
}

function classificarResultadoProvider(resultado) {
  const valor = String(resultado?.resultado || '').trim();
  if (valor === 'sucesso' || resultado?.sucesso === true) return 'sucesso';
  if (valor === 'invalido' || resultado?.tokenInvalido === true) return 'invalido';
  if (valor === 'permFalha' || resultado?.permanente === true) return 'permFalha';
  return 'tempFalha';
}

async function filaDisponivel(usuario = null) {
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();

  const result = await queryWithContext(ctx, () => {}, `
    SELECT CASE
      WHEN OBJECT_ID(N'dbo.FilaNotificacoes', N'U') IS NOT NULL
       AND OBJECT_ID(N'dbo.DispositivosNotificacao', N'U') IS NOT NULL
      THEN 1 ELSE 0 END AS Disponivel;
  `, { requireContext: true });

  return Number(result.recordset?.[0]?.Disponivel ?? 0) === 1;
}

async function recuperarProcessandoTravado({ staleMinutes = 10 } = {}, usuario = null) {
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();
  const minutes = Math.max(1, Number(staleMinutes) || 10);

  const result = await queryWithContext(ctx, (req) => {
    req.input('StaleMinutes', sql.Int, minutes);
  }, `
    UPDATE [dbo].[FilaNotificacoes]
    SET
      [Status] = N'Pendente',
      [ProcessandoEm] = NULL,
      [ProximaTentativaEm] = SYSDATETIME(),
      [UltimoErro] = N'Reivindicação expirada (worker reiniciado/travado).',
      [AtualizadoEm] = SYSDATETIME()
    WHERE [Status] = N'Processando'
      AND [ProcessandoEm] < DATEADD(MINUTE, -@StaleMinutes, SYSDATETIME());

    SELECT @@ROWCOUNT AS Recuperados;
  `, { requireContext: true });

  return Number(result.recordset?.[0]?.Recuperados ?? 0);
}

async function reivindicarLote({ batchSize = 10, canaisAtivos = ['push'] } = {}, usuario = null) {
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();
  const size = Math.max(1, Math.min(Number(batchSize) || 10, 50));
  const canais = normalizarCanaisAtivos(canaisAtivos);

  if (canais.length === 0) return [];

  const placeholders = canais.map((_, i) => `@Canal${i}`).join(', ');

  const result = await queryWithContext(ctx, (req) => {
    req.input('BatchSize', sql.Int, size);
    canais.forEach((canal, i) => {
      req.input(`Canal${i}`, sql.NVarChar(10), canal);
    });
  }, `
    ;WITH lote AS (
      SELECT TOP (@BatchSize) [Id]
      FROM [dbo].[FilaNotificacoes] WITH (UPDLOCK, READPAST, ROWLOCK, READCOMMITTEDLOCK)
      WHERE [Canal] IN (${placeholders})
        AND [Status] IN (N'Pendente', N'FalhaTemporaria')
        AND [Tentativas] < [MaxTentativas]
        AND ([ProximaTentativaEm] IS NULL OR [ProximaTentativaEm] <= SYSDATETIME())
      ORDER BY [ProximaTentativaEm] ASC, [CriadoEm] ASC
    )
    UPDATE f
    SET
      f.[Status] = N'Processando',
      f.[ProcessandoEm] = SYSDATETIME(),
      f.[AtualizadoEm] = SYSDATETIME()
    OUTPUT
      inserted.[Id],
      inserted.[UsuarioTipo],
      inserted.[UsuarioId],
      inserted.[Canal],
      inserted.[Titulo],
      inserted.[Mensagem],
      inserted.[DadosJson],
      inserted.[Tipo],
      inserted.[ReferenciaId],
      inserted.[Tentativas],
      inserted.[MaxTentativas]
    FROM [dbo].[FilaNotificacoes] f
    INNER JOIN lote ON lote.[Id] = f.[Id];
  `, { requireContext: true });

  return result.recordset || [];
}

async function listarDispositivosAtivos(usuarioTipo, usuarioId, usuario = null) {
  const destino = validarUsuarioDestino(usuarioTipo, usuarioId);
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();

  const result = await queryWithContext(ctx, (req) => {
    req.input('UsuarioTipo', sql.NVarChar(20), destino.usuarioTipo);
    req.input('UsuarioId', sql.Int, destino.usuarioId);
  }, `
    SELECT [Id], [Plataforma], [TokenPush]
    FROM [dbo].[DispositivosNotificacao]
    WHERE [UsuarioTipo] = @UsuarioTipo
      AND [UsuarioId] = @UsuarioId
      AND [Ativo] = 1;
  `, { requireContext: true });

  return result.recordset || [];
}

async function resolverEmailUsuario(usuarioTipo, usuarioId) {
  const destino = validarUsuarioDestino(usuarioTipo, usuarioId);
  const ctx = contextoSistema();
  let result;

  if (destino.usuarioTipo === 'Paciente') {
    result = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, destino.usuarioId);
    }, `
      SELECT TOP (1) [Email], [EmailVerificado]
      FROM [dbo].[Pacientes]
      WHERE [Id] = @Id;
    `, { requireContext: true });
  } else {
    result = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, destino.usuarioId);
    }, `
      SELECT TOP (1) [Email], [EmailVerificado]
      FROM [dbo].[Fisioterapeutas]
      WHERE [Id] = @Id;
    `, { requireContext: true });
  }

  const row = result.recordset?.[0] || null;
  const email = normalizeEmail(row?.Email);

  if (!email) {
    return { email: null, erro: 'sem e-mail cadastrado' };
  }

  if (!isValidEmail(email)) {
    return { email: null, erro: 'e-mail inválido' };
  }

  if (!isBitAtivo(row?.EmailVerificado)) {
    return { email: null, erro: 'e-mail não verificado' };
  }

  if (await emailSupressaoService.emailEstaSuprimido(email)) {
    return { email: null, erro: 'e-mail suprimido' };
  }

  return { email, erro: null };
}

async function resolverTelefoneUsuario(usuarioTipo, usuarioId) {
  const destino = validarUsuarioDestino(usuarioTipo, usuarioId);
  const ctx = contextoSistema();
  let result;

  if (destino.usuarioTipo === 'Paciente') {
    result = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, destino.usuarioId);
    }, `
      SELECT TOP (1) [Telefone], [TelefoneVerificado]
      FROM [dbo].[Pacientes]
      WHERE [Id] = @Id;
    `, { requireContext: true });
  } else {
    result = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, destino.usuarioId);
    }, `
      SELECT TOP (1) [Telefone], [TelefoneVerificado]
      FROM [dbo].[Fisioterapeutas]
      WHERE [Id] = @Id;
    `, { requireContext: true });
  }

  const row = result.recordset?.[0] || null;
  const telefoneRaw = String(row?.Telefone || '').trim();

  if (!telefoneRaw) {
    return { telefone: null, erro: 'sem telefone cadastrado' };
  }

  const telefone = normalizarTelefoneE164(telefoneRaw);
  if (!telefone) {
    return { telefone: null, erro: 'telefone inválido' };
  }

  if (!isBitAtivo(row?.TelefoneVerificado)) {
    return { telefone: null, erro: 'telefone não verificado' };
  }

  return { telefone, erro: null };
}

async function desativarDispositivoPorId(id, usuario = null) {
  const dispositivoId = normalizarIdPositivo(id, 'dispositivoId');
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, dispositivoId);
  }, `
    UPDATE [dbo].[DispositivosNotificacao]
    SET
      [Ativo] = 0,
      [AtualizadoEm] = SYSDATETIME()
    WHERE [Id] = @Id;
  `, { requireContext: true });
}

async function marcarEnviado(id, usuario = null) {
  const filaId = normalizarIdPositivo(id, 'filaId');
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, filaId);
  }, `
    UPDATE [dbo].[FilaNotificacoes]
    SET
      [Status] = N'Enviado',
      [EnviadoEm] = SYSDATETIME(),
      [ProcessandoEm] = NULL,
      [ProximaTentativaEm] = NULL,
      [UltimoErro] = NULL,
      [AtualizadoEm] = SYSDATETIME()
    WHERE [Id] = @Id;
  `, { requireContext: true });
}

async function marcarFalhaDefinitiva(id, erro, usuario = null) {
  const filaId = normalizarIdPositivo(id, 'filaId');
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, filaId);
    req.input('Erro', sql.NVarChar(500), normalizarErro(erro));
  }, `
    UPDATE [dbo].[FilaNotificacoes]
    SET
      [Status] = N'FalhaDefinitiva',
      [ProcessandoEm] = NULL,
      [ProximaTentativaEm] = NULL,
      [UltimoErro] = @Erro,
      [AtualizadoEm] = SYSDATETIME()
    WHERE [Id] = @Id;
  `, { requireContext: true });
}

async function marcarFalhaTemporaria(id, erro, backoffSeg = 60, usuario = null) {
  const filaId = normalizarIdPositivo(id, 'filaId');
  const ctx = usuario?.tipo && usuario?.id ? usuario : contextoSistema();
  const delaySeg = Math.max(1, Math.min(Number(backoffSeg) || 60, 3600));

  await queryWithContext(ctx, (req) => {
    req.input('Id', sql.Int, filaId);
    req.input('BackoffSeg', sql.Int, delaySeg);
    req.input('Erro', sql.NVarChar(500), normalizarErro(erro));
  }, `
    UPDATE [dbo].[FilaNotificacoes]
    SET
      [Tentativas] = [Tentativas] + 1,
      [Status] = CASE
        WHEN [Tentativas] + 1 >= [MaxTentativas] THEN N'FalhaDefinitiva'
        ELSE N'FalhaTemporaria'
      END,
      [ProximaTentativaEm] = CASE
        WHEN [Tentativas] + 1 >= [MaxTentativas] THEN NULL
        ELSE DATEADD(SECOND, @BackoffSeg, SYSDATETIME())
      END,
      [ProcessandoEm] = NULL,
      [UltimoErro] = @Erro,
      [AtualizadoEm] = SYSDATETIME()
    WHERE [Id] = @Id;
  `, { requireContext: true });
}

async function processarPushItem(item, usuario = null) {
  const filaId = normalizarIdPositivo(item?.Id, 'filaId');
  const dispositivos = await listarDispositivosAtivos(item.UsuarioTipo, item.UsuarioId, usuario);

  if (dispositivos.length === 0) {
    await marcarFalhaDefinitiva(filaId, 'Sem dispositivos ativos para entrega push.', usuario);
    return { status: 'FalhaDefinitiva', motivo: 'sem_dispositivos' };
  }

  const dados = parseDadosJsonSeguro(item.DadosJson);
  const resultados = {
    sucesso: 0,
    invalido: 0,
    tempFalha: 0,
    permFalha: 0,
    erros: []
  };

  for (const dispositivo of dispositivos) {
    try {
      const resultado = await enviarPush({
        tokenPush: dispositivo.TokenPush,
        plataforma: dispositivo.Plataforma,
        titulo: item.Titulo,
        mensagem: item.Mensagem,
        dados
      });

      const classificacao = classificarResultadoProvider(resultado);
      resultados[classificacao] += 1;

      if (classificacao === 'invalido') {
        await desativarDispositivoPorId(dispositivo.Id, usuario);
      }

      if (resultado?.erro) resultados.erros.push(resultado.erro);
    } catch (erro) {
      resultados.tempFalha += 1;
      resultados.erros.push(erro?.message || 'Falha temporária no provider.');
    }
  }

  if (resultados.sucesso > 0) {
    await marcarEnviado(filaId, usuario);
    return { status: 'Enviado', ...resultados };
  }

  if (resultados.tempFalha > 0) {
    const erro = resultados.erros[0] || 'Falha temporária ao enviar push.';
    await marcarFalhaTemporaria(filaId, erro, calcularBackoffSeg(item.Tentativas), usuario);
    return { status: 'FalhaTemporaria', ...resultados };
  }

  const erro = resultados.invalido > 0 && resultados.permFalha === 0
    ? 'Todos os dispositivos ativos foram invalidados pelo provider.'
    : (resultados.erros[0] || 'Falha permanente ao enviar push.');

  await marcarFalhaDefinitiva(filaId, erro, usuario);
  return { status: 'FalhaDefinitiva', ...resultados };
}

async function processarEmailItem(item, usuario = null) {
  const filaId = normalizarIdPositivo(item?.Id, 'filaId');
  const resolucao = await resolverEmailUsuario(item.UsuarioTipo, item.UsuarioId);

  if (!resolucao.email) {
    await marcarFalhaDefinitiva(filaId, resolucao.erro || 'sem e-mail cadastrado', usuario);
    return { status: 'FalhaDefinitiva', canal: 'email', motivo: 'email_indisponivel' };
  }

  const template = montarEmailNotificacao({
    titulo: item.Titulo,
    mensagem: item.Mensagem,
    dados: parseDadosJsonSeguro(item.DadosJson),
  });

  let resultado;
  try {
    resultado = await enviarEmail({
      destinatario: resolucao.email,
      assunto: template.assunto,
      corpoHtml: template.corpoHtml,
      corpoTexto: template.corpoTexto,
    });
  } catch (erro) {
    resultado = {
      resultado: 'tempFalha',
      erro: erro?.message || 'Falha temporária no provider de e-mail.',
    };
  }

  const classificacao = classificarResultadoProvider(resultado);
  const erro = resultado?.erro || (
    classificacao === 'invalido'
      ? 'Destinatário de e-mail inválido.'
      : 'Falha permanente ao enviar e-mail.'
  );

  if (classificacao === 'sucesso') {
    await marcarEnviado(filaId, usuario);
    return { status: 'Enviado', canal: 'email' };
  }

  if (classificacao === 'tempFalha') {
    await marcarFalhaTemporaria(filaId, erro, calcularBackoffSeg(item.Tentativas), usuario);
    return { status: 'FalhaTemporaria', canal: 'email', erro };
  }

  await marcarFalhaDefinitiva(filaId, erro, usuario);
  return { status: 'FalhaDefinitiva', canal: 'email', erro };
}

function montarMensagemWhatsAppItem(item) {
  const titulo = String(item?.Titulo || '').trim();
  const mensagem = String(item?.Mensagem || '').trim();

  if (titulo && mensagem) return `${titulo}\n\n${mensagem}`;
  return mensagem || titulo;
}

async function processarWhatsappItem(item, usuario = null) {
  const filaId = normalizarIdPositivo(item?.Id, 'filaId');
  const resolucao = await resolverTelefoneUsuario(item.UsuarioTipo, item.UsuarioId);

  if (!resolucao.telefone) {
    await marcarFalhaDefinitiva(filaId, resolucao.erro || 'sem telefone cadastrado', usuario);
    return { status: 'FalhaDefinitiva', canal: 'whatsapp', motivo: 'telefone_indisponivel' };
  }

  let resultado;
  try {
    resultado = await enviarWhatsApp({
      destinatario: resolucao.telefone,
      mensagem: montarMensagemWhatsAppItem(item),
    });
  } catch (erro) {
    resultado = {
      resultado: 'tempFalha',
      erro: erro?.message || 'Falha temporária no provider de WhatsApp.',
    };
  }

  const classificacao = classificarResultadoProvider(resultado);
  const erro = resultado?.erro || (
    classificacao === 'invalido'
      ? 'Destinatário de WhatsApp inválido.'
      : 'Falha permanente ao enviar WhatsApp.'
  );

  if (classificacao === 'sucesso') {
    await marcarEnviado(filaId, usuario);
    return { status: 'Enviado', canal: 'whatsapp', messageId: resultado?.messageId || null };
  }

  if (classificacao === 'tempFalha') {
    await marcarFalhaTemporaria(filaId, erro, calcularBackoffSeg(item.Tentativas), usuario);
    return { status: 'FalhaTemporaria', canal: 'whatsapp', erro };
  }

  await marcarFalhaDefinitiva(filaId, erro, usuario);
  return { status: 'FalhaDefinitiva', canal: 'whatsapp', erro };
}

async function processarItem(item, usuario = null) {
  const filaId = normalizarIdPositivo(item?.Id, 'filaId');
  const canal = validarCanal(item?.Canal || 'push');

  if (canal === 'email') {
    return processarEmailItem(item, usuario);
  }

  if (canal === 'whatsapp') {
    return processarWhatsappItem(item, usuario);
  }

  if (canal === 'push') {
    return processarPushItem(item, usuario);
  }

  await marcarFalhaDefinitiva(filaId, 'canal inválido', usuario);
  return { status: 'FalhaDefinitiva', motivo: 'canal_invalido' };
}

const notificacoesService = {
  registrarDispositivo,
  desativarDispositivo,
  enfileirarNotificacao,
  filaDisponivel,
  recuperarProcessandoTravado,
  reivindicarLote,
  listarDispositivosAtivos,
  resolverEmailUsuario,
  resolverTelefoneUsuario,
  desativarDispositivoPorId,
  marcarEnviado,
  marcarFalhaTemporaria,
  marcarFalhaDefinitiva,
  processarItem,
  calcularBackoffSeg
};

export {
  registrarDispositivo,
  desativarDispositivo,
  enfileirarNotificacao,
  filaDisponivel,
  recuperarProcessandoTravado,
  reivindicarLote,
  listarDispositivosAtivos,
  resolverEmailUsuario,
  resolverTelefoneUsuario,
  desativarDispositivoPorId,
  marcarEnviado,
  marcarFalhaTemporaria,
  marcarFalhaDefinitiva,
  processarItem,
  calcularBackoffSeg
};
export default notificacoesService;
