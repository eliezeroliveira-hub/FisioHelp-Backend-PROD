// 📁 controllers/localizacoesController.js
import localizacoesService from '../services/localizacoesService.js';

function getUsuario(req) {
  // deixa resiliente a variações tipo req.user / req.usuario / id vs Id etc
  const u = req.usuario || req.user;
  if (!u) return null;

  const usuarioId = u.Id ?? u.id ?? u.UsuarioId ?? u.usuarioId;
  const usuarioTipo = u.Tipo ?? u.tipo ?? u.UsuarioTipo ?? u.usuarioTipo;

  if (!usuarioId || !usuarioTipo) return null;
  return { usuarioId: Number(usuarioId), usuarioTipo: String(usuarioTipo) };
}

function asNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function validaLatLonObrigatorio(latitude, longitude) {
  const lat = asNumber(latitude);
  const lon = asNumber(longitude);

  if (lat === null || lon === null) {
    return { ok: false, msg: 'latitude e longitude são obrigatórios e devem ser numéricos.' };
  }
  if (lat < -90 || lat > 90) return { ok: false, msg: 'latitude inválida (de -90 a 90).' };
  if (lon < -180 || lon > 180) return { ok: false, msg: 'longitude inválida (de -180 a 180).' };

  return { ok: true, lat, lon };
}

const localizacoesController = {
  async putMinha(req, res, next) {
    try {
      const usuario = getUsuario(req);
      if (!usuario) return res.status(401).json({ sucesso: false, mensagem: 'Usuário não autenticado.' });

      const { latitude, longitude, raioAtendimentoKm, cidade, estado, cep, logradouro, numero } = req.body;
      let latFinal = null;
      let lonFinal = null;

      if (latitude != null || longitude != null) {
        const check = validaLatLonObrigatorio(latitude, longitude);
        if (!check.ok) return res.status(400).json({ sucesso: false, mensagem: check.msg });
        latFinal = check.lat;
        lonFinal = check.lon;
      }

      const raio = asNumber(raioAtendimentoKm);
      if (raio === null) return res.status(400).json({ sucesso: false, mensagem: 'raioAtendimentoKm é obrigatório e numérico.' });
      if (raio < 1 || raio > 100) return res.status(400).json({ sucesso: false, mensagem: 'raioAtendimentoKm inválido (1 a 100).' });
      const estadoFinal = estado ? String(estado).toUpperCase().trim() : null;
      const cepLimpo = cep ? String(cep).replace(/\D/g, '') : null;
      if (cepLimpo !== null && cepLimpo.length !== 8) {
        return res.status(400).json({ sucesso: false, mensagem: 'CEP inválido. Use 8 dígitos.' });
      }
      const cepFormatado = cepLimpo ? `${cepLimpo.slice(0, 5)}-${cepLimpo.slice(5)}` : null;

      const salvo = await localizacoesService.upsertMinhaLocalizacao(
        usuario,
        {
          latitude: latFinal,
          longitude: lonFinal,
          raioAtendimentoKm: raio,
          cidade: cidade ?? null,
          estado: estadoFinal,
          cep: cepFormatado,
          logradouro: logradouro ?? null,
          numero: numero ?? null,
        }
      );

      return res.json({
        sucesso: true,
        mensagem: 'Localização atualizada com sucesso.',
        dados: salvo,
      });
    } catch (err) {
      return next(err);
    }
  },

  async getMinha(req, res, next) {
    try {
      const usuario = getUsuario(req);
      if (!usuario) return res.status(401).json({ sucesso: false, mensagem: 'Usuário não autenticado.' });

      const atual = await localizacoesService.obterMinhaLocalizacao(usuario);

      return res.json({
        sucesso: true,
        dados: atual,
      });
    } catch (err) {
      return next(err);
    }
  },

  // opcional
  async getFisiosProximos(req, res, next) {
    try {
      const usuario = getUsuario(req);
      if (!usuario) return res.status(401).json({ sucesso: false, mensagem: 'Usuário não autenticado.' });

      const lat = asNumber(req.query.lat);
      const lon = asNumber(req.query.lon);
      const raioBuscaKm = asNumber(req.query.raioBuscaKm ?? req.query.raio);
      const limit = asNumber(req.query.limit);
      const offset = asNumber(req.query.offset);

      if (lat === null || lon === null || raioBuscaKm === null) {
        return res.status(400).json({ sucesso: false, mensagem: 'Informe lat, lon e raioBuscaKm na query string.' });
      }

      const lista = await localizacoesService.buscarFisioterapeutasProximos(usuario, {
        lat,
        lon,
        raioBuscaKm,
        limit: limit ?? undefined,
        offset: offset ?? undefined
      });
      return res.json({
        sucesso: true,
        total: lista?.total ?? 0,
        limit: lista?.limit ?? 50,
        offset: lista?.offset ?? 0,
        dados: lista?.itens ?? []
      });
    } catch (err) {
      return next(err);
    }
  },
};

export default localizacoesController;
