import contatoPublicoService from '../services/contatoPublicoService.js';

export async function enviar(req, res, next) {
  try {
    const resultado = await contatoPublicoService.enviarContatoPublico({
      body: req.body,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(200).json(resultado);
  } catch (err) {
    next(err);
  }
}

export default {
  enviar,
};
