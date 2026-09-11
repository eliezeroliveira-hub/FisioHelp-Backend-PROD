import seoPublicoService from '../services/seoPublicoService.js';

const seoPublicoController = {
  async listarFisioterapeutas(req, res, next) {
    try {
      const catalogo = await seoPublicoService.obterCatalogo();
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
      res.set('ETag', catalogo.etag);
      if (req.headers['if-none-match'] === catalogo.etag) return res.status(304).end();
      return res.type('application/json').send(catalogo.body);
    } catch (error) {
      return next(error);
    }
  },
};

export default seoPublicoController;
