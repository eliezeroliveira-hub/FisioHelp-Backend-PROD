//  controllers/fisioterapeutasController.js
import fisioterapeutasService from '../services/fisioterapeutasService.js';
import { formatarCrefito } from '../utils/formatarCrefito.js';
import { HttpError } from '../utils/httpError.js';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Helpers
const asTipo = (u) => String(u?.tipo || '').toLowerCase();
const isFisio = (u) => asTipo(u) === 'fisioterapeuta';
const isAdmin = (u) => asTipo(u) === 'admin';
const isAuth = (u) => !!(u?.id && u?.tipo);

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

function handleError(res, erro) {
  const status = (erro instanceof HttpError && erro.statusCode)
    || erro?.statusCode
    || erro?.httpStatus
    || 500;
  return res.status(status).json({
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.')
  });
}

function toBool(value) {
  return value === true || value === 1 || value === '1';
}

function normalizarFotoPerfilUrl(rawFoto) {
  if (!rawFoto) return null;
  const foto = String(rawFoto).trim();
  if (!foto) return null;
  if (foto.startsWith('/uploads/')) return foto;
  if (/^https?:\/\//i.test(foto)) return foto;
  return `/uploads/fotos_perfil/${foto.split(/[/\\]/).pop()}`;
}

// 🔧 Função para padronizar retorno limpo
function filtrarRetorno(f) {
  if (!f) return null;

  return {
    Id: f.Id,
    Nome: f.Nome,
    CREFITO: formatarCrefito(f.CREFITO, f.Estado),
    Email: f.Email,
    Telefone: f.Telefone,
    Genero: f.Genero ?? null,
    Especialidade: f.Especialidade,
    Cidade: f.Cidade,
    Estado: f.Estado,
    ValorConsultaBase: f.ValorConsultaBase,
    TipoConta: f.TipoConta,
    Ativo: f.Ativo,
    CrefitoVerificado: f.CrefitoVerificado,
    DataCadastro: f.DataCadastro
  };
}

//  Monta o perfil COMPLETO (área logada) baseado em dbo.vw_FisioterapeutaPerfilCompleto
function montarPerfilCompleto(f) {
  if (!f) return null;

  const fotoUrl = normalizarFotoPerfilUrl(f.FotoPerfilUrl ?? null);

  return {
    FisioterapeutaId: f.FisioterapeutaId ?? f.Id,
    Nome: f.Nome,
    Email: f.Email ?? null,
    EmailVerificado: f.EmailVerificado ?? 0,
    Telefone: f.Telefone ?? null,
    TelefoneVerificado: f.TelefoneVerificado ?? 0,
    Genero: f.Genero ?? null,
    Especialidade: f.Especialidade,
    Cidade: f.Cidade,
    Estado: f.Estado,
    Descricao: f.Descricao ?? null,

    //  Foto de perfil
    FotoPerfilDocumentoId: f.FotoPerfilDocumentoId ?? null,
    FotoPerfilUrl: fotoUrl,

    CREFITO: formatarCrefito(f.CREFITO, f.Estado),
    CNPJ: f.CNPJ ?? null,
    CrefitoVerificado: f.CrefitoVerificado,

    ToleranciaCancelamentoMinutos: f.ToleranciaCancelamentoMinutos,
    ConfirmacaoAutomatica: f.ConfirmacaoAutomatica,

    LinkVideoApresentacao: f.LinkVideoApresentacao ?? null,

    ValorConsultaBase: f.ValorConsultaBase,
    DescontoPacote: f.DescontoPacote,
    ValorLiquidoFisioterapeuta: f.ValorLiquidoFisioterapeuta,

    TipoContaBancaria: f.TipoContaBancaria ?? null,
    Banco: f.Banco ?? null,
    Agencia: f.Agencia ?? null,
    Conta: f.Conta ?? null,
    ChavePix: f.ChavePix ?? null,
    TipoChavePix: f.TipoChavePix ?? null,
    PixAtualizadoEm: f.PixAtualizadoEm ?? null,

    SaldoAtual: f.SaldoAtual ?? null,
    TotalRecebido: f.TotalRecebido ?? null,
    UltimoPagamento: f.UltimoPagamento ?? null,

    MediaAvaliacoes: f.MediaAvaliacoes ?? null,
    TotalAvaliacoes: f.TotalAvaliacoes ?? 0,
    TotalAtendimentos: f.TotalAtendimentos ?? 0,

    Ativo: f.Ativo,
    IsBloqueado: f.IsBloqueado,
    DataCadastro: f.DataCadastro,

    Formacoes: Array.isArray(f.Formacoes) ? f.Formacoes : [],
    Especialidades: Array.isArray(f.Especialidades) ? f.Especialidades : []
  };
}

function montarPerfilPublico(f) {
  if (!f) return null;

  return {
    ...f,
    FotoPerfilUrl: normalizarFotoPerfilUrl(f.FotoPerfilUrl ?? null),
    CREFITO: formatarCrefito(f.CREFITO, f.Estado),
    CrefitoVerificado: toBool(f.CrefitoVerificado),
    EmailVerificado: toBool(f.EmailVerificado),
    TelefoneVerificado: toBool(f.TelefoneVerificado),
  };
}


/**
 * Blindagem de campos sensíveis (fisio não pode setar sozinho).
 * Também evita que o usuário tente alterar Id, hashes etc.
 */
function sanitizarBodyFisio(body) {
  const dados = { ...(body || {}) };

  const proibidos = [
    'Id', 'id',
    'SenhaHash', 'senhaHash',
        'SenhaAtual', 'senhaAtual',
    'NovaSenha', 'novaSenha',
    'Senha', 'senha',
    'Password', 'password',
'DataCadastro', 'dataCadastro',
    'Ativo', 'ativo',
    'CrefitoVerificado', 'crefitoVerificado',
    'TipoConta', 'tipoConta',

    // vídeo: fisio NÃO define link de youtube
    'LinkVideoApresentacao', 'linkVideoApresentacao',
    'VideoApresentacao', 'videoApresentacao',
    'Youtube', 'youtube', 'YouTube', 'youTube',
    'LinkYoutube', 'linkYoutube', 'LinkYouTube', 'linkYouTube'
  ];

  for (const k of proibidos) delete dados[k];
  return dados;
}

function pick(body, allowed) {
  const out = {};
  for (const k of allowed) {
    if (body?.[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function toBit(v, label = 'valor') {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  if (v === '1' || v === '0') return Number(v);
  throw new Error(`${label} inválido (use true/false ou 1/0).`);
}

function assertNumber(v, label, min = 0, max = 999999999) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} inválido.`);
  return n;
}

function retornoSomenteAlterados(fisioAtualizado, patchEnviado) {
  const out = {};
  for (const k of Object.keys(patchEnviado || {})) {
    if (fisioAtualizado && Object.prototype.hasOwnProperty.call(fisioAtualizado, k)) {
      out[k] = fisioAtualizado[k];
    } else {
      // fallback: caso o SELECT de perfil não traga aquela coluna por algum motivo
      out[k] = patchEnviado[k];
    }
  }
  return out;
}

const fisioterapeutasController = {
  //  Lista interna (rota ADMIN)
  async listar(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      let dados = await fisioterapeutasService.listarTodos(true, usuario, {
        page: req.query.page,
        pageSize: req.query.pageSize
      });
      dados = (dados || []).map((f) => ({ ...f, CREFITO: formatarCrefito(f.CREFITO, f.Estado) }));

      return res.json(dados);
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  //  Busca pública com filtros
  async buscar(req, res) {
    try {
      const usuario = req.usuario || null;

      const toNumOrUndef = (v) => {
        if (v == null || v === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      const filtros = {
        cidade: req.query.cidade,
        estado: req.query.estado,
        especialidade: req.query.especialidade,
        precoMax: req.query.precoMax,
        data: req.query.data || undefined,
        lat: toNumOrUndef(req.query.lat),
        lon: toNumOrUndef(req.query.lon),
        raioKm: toNumOrUndef(req.query.raioKm),
        page: req.query.page,
        pageSize: req.query.pageSize
      };

      let lista = await fisioterapeutasService.buscarComFiltros(filtros, usuario);
      lista = (lista || []).map((f) => {
        const { Ativo, IsBloqueado, ...publico } = f || {};
        return {
          ...publico,
          FotoPerfilUrl: normalizarFotoPerfilUrl(publico.FotoPerfilUrl ?? null),
          CREFITO: formatarCrefito(publico.CREFITO, publico.Estado),
          CrefitoVerificado: toBool(publico.CrefitoVerificado),
          EmailVerificado: toBool(publico.EmailVerificado),
          TelefoneVerificado: toBool(publico.TelefoneVerificado),
        };
      });

      return res.json(lista);
    } catch (erro) {
      const status = erro?.statusCode ?? 500;
      const mensagem = status < 500 ? erro.message : 'Erro interno do servidor.';
      return res.status(status).json({ erro: mensagem });
    }
  },

  //  Perfil público (SEM login)
  async perfilPublico(req, res) {
    try {
      const usuario = req.usuario || null;

      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const fisio = await fisioterapeutasService.buscarPerfilPublico(id, usuario);
      if (!fisio) return res.status(404).json({ erro: 'Fisioterapeuta não encontrado.' });

      return res.json(montarPerfilPublico(fisio));
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async buscarPorId(req, res) {
    return fisioterapeutasController.perfilPublico(req, res);
  },

  //  Disponibilidade por data (PACIENTE) — GET /fisioterapeutas/:id/disponibilidade?data=YYYY-MM-DD
  async disponibilidadePorData(req, res) {
    try {
      const usuario = req.usuario || null;

      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const dataStr = String(req.query.data || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
        return res.status(400).json({ erro: 'Parâmetro "data" inválido. Use YYYY-MM-DD.' });
      }

      const slotsRaw = await fisioterapeutasService.obterDisponibilidadePorData(id, dataStr, usuario);

      const pad2 = (n) => String(n).padStart(2, '0');
      const formatDT = (v) => {
        const parts = extractSqlDateParts(v);
        if (!parts) return null;
        return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
      };
      const formatHora = (v) => {
        const parts = extractSqlDateParts(v);
        if (!parts) return null;
        return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
      };

      const slots = (slotsRaw || []).map((r) => ({
        DataHora: formatDT(r.DataHora),
        Hora: formatHora(r.DataHora),
        Disponivel: (r.Disponivel === true || r.Disponivel === 1) ? 1 : 0
      }));

      const horariosDisponiveis = slots.filter((s) => s.Disponivel === 1).map((s) => s.Hora);

      return res.json({
        FisioterapeutaId: id,
        Data: dataStr,
        Slots: slots,
        HorariosDisponiveis: horariosDisponiveis
      });
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  //  Calendário do mês (agrupado por dia + horários) — GET /fisioterapeutas/:id/calendario?mes=YYYY-MM
  async calendarioMensal(req, res) {
    try {
      const usuario = req.usuario || null;

      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const mesQuery = String(req.query.mes || '').trim();
      let ano, mes;

      // preferido: ?mes=2026-01
      if (/^\d{4}-\d{2}$/.test(mesQuery)) {
        const [y, m] = mesQuery.split('-').map(Number);
        ano = y;
        mes = m;
      } else {
        // alternativo: ?ano=2026&mes=1 (ou mes=01 / mesNumero=1)
        ano = Number(req.query.ano);
        mes = Number(req.query.mesNumero ?? req.query.mes);
      }

      if (!Number.isInteger(ano) || ano < 2020 || ano > 2100 || !Number.isInteger(mes) || mes < 1 || mes > 12) {
        return res.status(400).json({ erro: 'Informe o mês como ?mes=YYYY-MM (ex.: 2026-01) ou ?ano=YYYY&mes=MM.' });
      }

      const calendario = await fisioterapeutasService.obterCalendarioMensal(id, ano, mes, usuario);
      return res.json(calendario);
    } catch (erro) {
      const status = erro?.statusCode ?? erro?.status ?? 500;
      const mensagem = status < 500 ? erro.message : 'Erro interno do servidor.';
      return res.status(status).json({ erro: mensagem });
    }
  },

  //  Perfil completo (área logada)
  async perfilCompleto(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const fisio = await fisioterapeutasService.buscarPerfilCompleto(usuario.id, usuario);
      if (!fisio) return res.status(404).json({ erro: 'Fisioterapeuta não encontrado.' });

      return res.json(montarPerfilCompleto(fisio));
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  //  Avaliações & reputação (somente fisioterapeuta logado)
  async listarAvaliacoesMe(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);
      if (!id) return res.status(400).json({ erro: 'Id do fisioterapeuta inválido.' });

      const avaliacoes = await fisioterapeutasService.listarAvaliacoesFisioterapeuta(id, usuario);
      return res.json(avaliacoes || []);
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async minhasAvaliacoesMedia(req, res) {
  try {
    const usuario = req.usuario;
    if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
    if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });
    const id = usuario.id;

    const resumo = await fisioterapeutasService.obterResumoAvaliacoesFisioterapeuta(id, usuario);

    return res.json({
      sucesso: true,
      fisioterapeutaId: id,
      resumo
    });
  } catch (erro) {
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
  },


  //  Cadastro público
  async criar(req, res) {
    try {
      const novo = await fisioterapeutasService.criar(req.body);
      if (!novo) return res.status(501).json({ erro: 'Serviço de criação não implementado.' });

      const retorno = filtrarRetorno(novo);

      return res.status(201).json({
        sucesso: true,
        mensagem: 'Fisioterapeuta criado com sucesso!',
        fisioterapeuta: retorno
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  Update genérico (rota /me) — mantém por compatibilidade
  async atualizarMe(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const dadosAtualizacao = sanitizarBodyFisio(req.body);

      if (dadosAtualizacao.Especialidade !== undefined && !dadosAtualizacao.EspecialidadeId) {
        return res.status(400).json({ erro: 'Para alterar a especialidade use o campo EspecialidadeId.' });
      }

      const fisio = await fisioterapeutasService.atualizar(id, dadosAtualizacao, usuario);
      if (!fisio) return res.status(403).json({ erro: 'Atualização não permitida.' });

      const retorno = filtrarRetorno(fisio);

      return res.json({ sucesso: true, mensagem: 'Dados atualizados com sucesso!', perfil: retorno });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/dados

  //  Alterar senha (somente o fisioterapeuta logado)
  async alterarSenhaMe(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const senhaAtual =
        req.body?.senhaAtual ?? req.body?.SenhaAtual ?? req.body?.senhaAntiga ?? req.body?.SenhaAntiga ?? null;

      const novaSenha =
        req.body?.novaSenha ?? req.body?.NovaSenha ?? req.body?.senhaNova ?? req.body?.SenhaNova ?? null;

      if (!senhaAtual || !novaSenha) {
        return res.status(400).json({ erro: 'Informe senhaAtual e novaSenha.' });
      }

      const resultado = await fisioterapeutasService.alterarSenhaMe(
        id,
        String(senhaAtual),
        String(novaSenha),
        usuario
      );

      return res.json({ sucesso: true, ...(resultado || {}) });
    } catch (erro) {
      const status = erro?.statusCode || 500;
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async atualizarMeDados(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const dados = pick(req.body, ['Nome', 'Email', 'Telefone', 'Cidade', 'Estado', 'Descricao', 'Genero']);
      const dadosFinal = sanitizarBodyFisio(dados);

      if (!Object.keys(dadosFinal).length) {
        return res.status(400).json({ erro: 'Nenhum campo válido para atualização.' });
      }

      const fisio = await fisioterapeutasService.atualizar(id, dadosFinal, usuario);
      const perfil = retornoSomenteAlterados(fisio, dadosFinal);

      return res.json({sucesso: true, mensagem: 'Dados atualizados.', perfil});
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/banco
  async atualizarMeBanco(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const dados = pick(req.body, ['Banco', 'Agencia', 'Conta', 'TipoContaBancaria', 'ChavePix', 'TipoChavePix']);
      const dadosFinal = sanitizarBodyFisio(dados);

      if (!Object.keys(dadosFinal).length) {
        return res.status(400).json({ erro: 'Nenhum campo válido para atualização.' });
      }

      const fisio = await fisioterapeutasService.atualizar(id, dadosFinal, usuario);
      const perfil = retornoSomenteAlterados(fisio, dadosFinal);

      return res.json({sucesso: true, mensagem: 'Dados bancários atualizados.', perfil});
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/preco
  async atualizarMePreco(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const valor = assertNumber(req.body?.ValorConsultaBase, 'ValorConsultaBase', 1, 999999);
      const desconto = assertNumber(req.body?.DescontoPacote, 'DescontoPacote', 0, 100);

      const dados = {};
      if (valor !== undefined) dados.ValorConsultaBase = valor;
      if (desconto !== undefined) dados.DescontoPacote = desconto;

      const dadosFinal = sanitizarBodyFisio(dados);

      if (!Object.keys(dadosFinal).length) {
        return res.status(400).json({ erro: 'Nenhum campo válido para atualização.' });
      }

      const fisio = await fisioterapeutasService.atualizar(id, dadosFinal, usuario);
      const perfil = retornoSomenteAlterados(fisio, dadosFinal);

      return res.json({sucesso: true, mensagem: 'Preço atualizado.', perfil});
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/especialidade (valida contra vw_Especialidades)
  async atualizarMeEspecialidade(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);
      const especialidade = String(req.body?.Especialidade ?? req.body?.especialidade ?? '').trim();

      if (!especialidade) return res.status(400).json({ erro: 'Especialidade é obrigatória.' });

      const ok = await fisioterapeutasService.validarEspecialidade(especialidade);
      if (!ok) return res.status(400).json({ erro: 'Especialidade inválida (não encontrada em vw_Especialidades).' });

      const dadosFinal = sanitizarBodyFisio({ Especialidade: especialidade });

      const fisio = await fisioterapeutasService.atualizar(id, dadosFinal, usuario);
      const perfil = retornoSomenteAlterados(fisio, dadosFinal);

      return res.json({sucesso: true, mensagem: 'Especialidade atualizada.', perfil});
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/cancelamento
  async atualizarMeCancelamento(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const tol = assertNumber(
        req.body?.ToleranciaCancelamentoMinutos ?? req.body?.toleranciaCancelamentoMinutos,
        'ToleranciaCancelamentoMinutos',
        0,
        1440
      );

      if (tol === undefined) return res.status(400).json({ erro: 'ToleranciaCancelamentoMinutos é obrigatória.' });

      const fisio = await fisioterapeutasService.atualizar(
        id,
        sanitizarBodyFisio({ ToleranciaCancelamentoMinutos: tol }),
        usuario
      );
      const perfil = {ToleranciaCancelamentoMinutos: fisio.ToleranciaCancelamentoMinutos};

      return res.json({ sucesso: true, mensagem: 'Política de cancelamento atualizada.', perfil });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  (B) PATCH /me/confirmacao-automatica
  async atualizarMeConfirmacaoAutomatica(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);

      const v = req.body?.ConfirmacaoAutomatica ?? req.body?.confirmacaoAutomatica;
      if (v === undefined) return res.status(400).json({ erro: 'confirmacaoAutomatica é obrigatória.' });

      const bit = toBit(v, 'confirmacaoAutomatica');
      const patchEnviado = { ConfirmacaoAutomatica: bit };

      const fisio = await fisioterapeutasService.atualizar(
        id,
        sanitizarBodyFisio(patchEnviado),
        usuario
      );
      const perfil = retornoSomenteAlterados(fisio, patchEnviado);

      return res.json({sucesso: true, mensagem: 'Confirmação automática atualizada.', perfil});
    } catch (erro) {
          const msg = String(erro?.message || '');
          const status = erro?.statusCode || erro?.httpStatus || 500;
          return res.status(status).json({
            erro: status >= 500 ? 'Erro interno do servidor.' : msg
          });
        }
  },

  //  Atualização por ID (ADMIN)
  async atualizar(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const idParam = parseInt(req.params.id, 10);
      if (!idParam) return res.status(400).json({ erro: 'Id inválido.' });

      const fisio = await fisioterapeutasService.atualizar(idParam, req.body, usuario);
      if (!fisio) return res.status(404).json({ erro: 'Fisioterapeuta não encontrado.' });

      const retorno = filtrarRetorno(fisio);

      return res.json({ sucesso: true, mensagem: 'Dados atualizados com sucesso!', perfil: retorno });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  Bloqueio (soft delete) - ME
  async removerMe(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(usuario.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const resultado = await fisioterapeutasService.remover(id, req.body || {}, usuario);
      return res.json(resultado);
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  //  Bloqueio (soft delete) - ADMIN
  async remover(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });

      const resultado = await fisioterapeutasService.remover(id, {}, usuario);
      return res.json(resultado);
    } catch (erro) {
      return handleError(res, erro);
    }
  },


  //  Pré-cadastrar paciente (somente o fisioterapeuta logado)
  async preCadastrarPaciente(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const fisioId = Number(usuario.id);

      const b = req.body || {};
      const payload = {
        Nome: b.Nome ?? b.nome,
        CPF: b.CPF ?? b.cpf,
        Email: b.Email ?? b.email,
        Telefone: b.Telefone ?? b.telefone,

        DataNascimento: b.DataNascimento ?? b.dataNascimento,
        Cidade: b.Cidade ?? b.cidade,
        Estado: b.Estado ?? b.estado,
        Naturalidade: b.Naturalidade ?? b.naturalidade,
        EstadoCivil: b.EstadoCivil ?? b.estadoCivil,
        Genero: b.Genero ?? b.genero,
        Profissao: b.Profissao ?? b.profissao,

        EnderecoResidencial: b.EnderecoResidencial ?? b.enderecoResidencial,
        BairroResidencial: b.BairroResidencial ?? b.bairroResidencial,
        ComplementoResidencial: b.ComplementoResidencial ?? b.complementoResidencial,
        EnderecoComercial: b.EnderecoComercial ?? b.enderecoComercial,
        BairroComercial: b.BairroComercial ?? b.bairroComercial,

        // Compat: você pode enviar Cep diretamente, ou usar os campos antigos (CEPResidencial/CEPComercial)
        Cep: b.Cep ?? b.cep ?? b.CEP ?? b.CEPResidencial ?? b.cepResidencial ?? b.CEPComercial ?? b.cepComercial,

        ObservacoesVinculo: b.ObservacoesVinculo ?? b.observacoesVinculo,

        // (compat antigos - opcional)
        CEPResidencial: b.CEPResidencial ?? b.cepResidencial,
        CEPComercial: b.CEPComercial ?? b.cepComercial
      };

      const resultado = await fisioterapeutasService.preCadastrarPaciente(fisioId, payload, usuario);

      // Padroniza resposta no padrão do backend (evita duplicar campos da SP)
      const PacienteId = resultado?.PacienteId ?? resultado?.pacienteId ?? null;
      const FisioterapeutaId = resultado?.FisioterapeutaId ?? resultado?.fisioterapeutaId ?? fisioId;

      const mensagem = resultado?.Mensagem || resultado?.mensagem || 'Paciente pré-cadastrado com sucesso.';

      return res.status(201).json({
        sucesso: true,
        mensagem,
        PacienteId,
        FisioterapeutaId
      });
} catch (erro) {
      const status = erro?.statusCode || 500;
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // ==================
  //  FOTO DE PERFIL (Opção B)
  // ==================
  async uploadFotoPerfil(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Apenas fisioterapeuta pode enviar foto de perfil.' });

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ erro: 'Arquivo não enviado. Use o campo "arquivo".' });
      }

      const fisioId = Number(usuario.id);
      const ts = Date.now();
      const filename = `fisio_${fisioId}_${ts}.webp`;
      const caminhoStorage = `fotos_perfil/${filename}`;

      const buffer = await sharp(req.file.buffer)
        .resize(320, 320, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toBuffer();

      await fileStorageProvider.uploadBuffer(caminhoStorage, buffer, {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=86400',
      });

      // Para FOTO_PERFIL, salvar só o filename em CaminhoArquivo.
      const documento = await fisioterapeutasService.salvarFotoPerfil({
        fisioterapeutaId: fisioId,
        caminhoArquivo: filename,
        usuario
      });

      return res.status(201).json({
        sucesso: true,
        FotoPerfilDocumentoId: documento.FotoPerfilDocumentoId,
        FotoPerfilUrl: `/uploads/fotos_perfil/${filename}`
      });
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async removerFotoPerfil(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Apenas fisioterapeuta pode remover foto de perfil.' });

      const fisioId = Number(usuario.id);

      await fisioterapeutasService.removerFotoPerfil({
        fisioterapeutaId: fisioId,
        usuario
      });

      return res.json({ sucesso: true, mensagem: 'Foto de perfil removida (desvinculada).' });
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },


  //  Upload de documento (mantido)
  async uploadDocumento(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      if (!req.file?.path) {
        return res.status(400).json({ erro: 'Arquivo não enviado. Use o campo "arquivo".' });
      }

      const formacao = {
        Curso: req.body.Curso || req.body.curso,
        Instituicao: req.body.Instituicao || req.body.instituicao,
        AnoConclusao: req.body.AnoConclusao || req.body.anoConclusao,
        TipoFormacao: req.body.TipoFormacao || req.body.tipoFormacao,
        MesInicio: req.body.MesInicio || req.body.mesInicio,
        AnoInicio: req.body.AnoInicio || req.body.anoInicio,
        MesFim: req.body.MesFim || req.body.mesFim,
        AnoFim: req.body.AnoFim || req.body.anoFim,
        IdCredencial: req.body.IdCredencial || req.body.idCredencial,
        UrlCredencial: req.body.UrlCredencial || req.body.urlCredencial,
        Descricao: req.body.Descricao || req.body.descricao,};

      const caminhoRelativo = `certificados/${req.file.filename}`;
      let arquivoSubido = false;

      try {
        await fileStorageProvider.uploadFile(caminhoRelativo, req.file.path, {
          contentType: req.file.mimetype,
          cacheControl: 'no-store',
        });
        arquivoSubido = true;

        const registro = await fisioterapeutasService.processarDocumento(
          Number(usuario.id),
          caminhoRelativo,
          formacao,
          usuario
        );

        if (fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        }

        return res.json({
          sucesso: true,
          mensagem: 'Formação cadastrada com sucesso. O certificado ficará visível no seu perfil.',
          caminho: caminhoRelativo,
          formacao: registro
        });
      } catch (err) {
        if (arquivoSubido) await fileStorageProvider.deleteFile(caminhoRelativo).catch(() => {});
        if (fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        }
        throw err;
      }
    } catch (erro) {
      const status = erro?.statusCode || erro?.httpStatus || 500;
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async atualizarFormacao(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const fisioterapeutaId = Number(usuario.id);
      const formacaoId = Number(req.params.id);

      if (!Number.isInteger(formacaoId) || formacaoId <= 0) {
        return res.status(400).json({ erro: 'Id da formação inválido.' });
      }

      const formacao = {
        Curso: req.body.Curso ?? req.body.curso,
        Instituicao: req.body.Instituicao ?? req.body.instituicao,
        AnoConclusao: req.body.AnoConclusao ?? req.body.anoConclusao,
        TipoFormacao: req.body.TipoFormacao ?? req.body.tipoFormacao,
        MesInicio: req.body.MesInicio ?? req.body.mesInicio,
        AnoInicio: req.body.AnoInicio ?? req.body.anoInicio,
        MesFim: req.body.MesFim ?? req.body.mesFim,
        AnoFim: req.body.AnoFim ?? req.body.anoFim,
        IdCredencial: req.body.IdCredencial ?? req.body.idCredencial,
        UrlCredencial: req.body.UrlCredencial ?? req.body.urlCredencial,
        Descricao: req.body.Descricao ?? req.body.descricao,
      };

      const enviouAlgo = Object.values(formacao).some((value) => value !== undefined);
      if (!enviouAlgo) {
        return res.status(400).json({ erro: 'Nenhum campo válido para atualização.' });
      }

      const registro = await fisioterapeutasService.atualizarFormacao(
        fisioterapeutaId,
        formacaoId,
        formacao,
        usuario
      );

      return res.json({
        sucesso: true,
        mensagem: 'Formação atualizada com sucesso.',
        formacao: registro,
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },
  async removerFormacao(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const fisioterapeutaId = Number(usuario.id);
      const formacaoId = Number(req.params.id);

      if (!Number.isInteger(formacaoId) || formacaoId <= 0) {
        return res.status(400).json({ erro: 'Id da formação inválido.' });
      }

      const registro = await fisioterapeutasService.removerFormacao(
        fisioterapeutaId,
        formacaoId,
        usuario
      );

      return res.json({
        sucesso: true,
        mensagem: 'Formação removida com sucesso.',
        formacao: registro,
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  async statusDocumento(req, res) {
    try {
      const usuario = req.usuario;

      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const lista = await fisioterapeutasService.obterStatusDocumento(Number(usuario.id), usuario);
      return res.json(lista);
    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  //  Rota antiga de upload de vídeo removida do router.

  // ==============================
  // Confiabilidade + Verificação de contato (Email/Telefone)
  // ==============================
  async obterConfiabilidade(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });

      // Se for Fisioterapeuta, só pode consultar a própria confiabilidade
      if (req.usuario?.tipo === 'Fisioterapeuta' && Number(req.usuario?.id) !== id) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const confiab = await fisioterapeutasService.obterConfiabilidade({
        fisioterapeutaId: id,
        usuario: {
          tipoUsuario: req.usuario?.tipo,
          usuarioId: req.usuario?.id,
        },
      });

      if (!confiab) return res.status(404).json({ sucesso: false, erro: 'Fisioterapeuta não encontrado.' });

      return res.json({ sucesso: true, confiabilidade: confiab });
    } catch (err) {
      return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor.' });
    }
  },

  async solicitarVerificacaoContato(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });

      if (req.usuario?.tipo === 'Fisioterapeuta' && Number(req.usuario?.id) !== id) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const { Canal, canal, canal_contato, canalContato } = req.body || {};
      const canalUsar = Canal ?? canal ?? canal_contato ?? canalContato;

      const resultado = await fisioterapeutasService.solicitarVerificacaoContato({
        fisioterapeutaId: id,
        canal: canalUsar,
        usuario: {
          tipoUsuario: req.usuario?.tipo,
          usuarioId: req.usuario?.id,
        },
      });

      return res.json({ sucesso: true, ...resultado });
    } catch (err) {
      const status = err?.statusCode || err?.httpStatus || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao solicitar verificação.'),
      });
    }
  },

  async confirmarVerificacaoContato(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });

      if (req.usuario?.tipo === 'Fisioterapeuta' && Number(req.usuario?.id) !== id) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const { Canal, canal, canal_contato, canalContato, Codigo, codigo } = req.body || {};
      const canalUsar = Canal ?? canal ?? canal_contato ?? canalContato;
      const codigoUsar = Codigo ?? codigo;

      const resultado = await fisioterapeutasService.confirmarVerificacaoContato({
        fisioterapeutaId: id,
        canal: canalUsar,
        codigo: codigoUsar,
        usuario: {
          tipoUsuario: req.usuario?.tipo,
          usuarioId: req.usuario?.id,
        },
      });

      return res.json({ sucesso: true, ...resultado });
    } catch (err) {
      const status = err?.statusCode || err?.httpStatus || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao confirmar verificação.'),
      });
    }
  },

  async listarMinhasEspecialidades(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const especialidades = await fisioterapeutasService.listarEspecialidades(Number(usuario.id), usuario);
      return res.json({ sucesso: true, especialidades });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  async salvarMinhasEspecialidades(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isFisio(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const especialidades = req.body?.Especialidades ?? req.body?.especialidades;
      if (!Array.isArray(especialidades)) {
        return res.status(400).json({ erro: 'Especialidades deve ser um array.' });
      }

      await fisioterapeutasService.salvarEspecialidades(Number(usuario.id), especialidades, usuario);
      const lista = await fisioterapeutasService.listarEspecialidades(Number(usuario.id), usuario);
      return res.json({ sucesso: true, especialidades: lista });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  async listarEspecialidadesPublico(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id || id <= 0) return res.status(400).json({ erro: 'Id inválido.' });

      const especialidades = await fisioterapeutasService.listarEspecialidades(id, req.usuario ?? null);
      return res.json({ sucesso: true, especialidades });
    } catch (erro) {
      return handleError(res, erro);
    }
  },
};

export default fisioterapeutasController;


