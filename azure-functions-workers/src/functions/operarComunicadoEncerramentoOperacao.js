import { app } from '@azure/functions';

app.http('operarComunicadoEncerramentoOperacao', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'operacoes/encerramento/comunicado',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { executarComunicadoEncerramentoOperacao } = await import(
        '../../workers/comunicadoEncerramentoOperacaoWorker.js'
      );
      const result = await executarComunicadoEncerramentoOperacao({
        acao: body?.acao,
        confirmacao: body?.confirmacao,
      });

      context.log('[workers] Operação segura do comunicado concluída.', {
        acao: result.acao,
        inseridos: result.inseridos ?? 0,
        destinatariosElegiveis: result.destinatariosElegiveis ?? 0,
      });

      return { status: 200, jsonBody: result };
    } catch (error) {
      const status = Number(error?.statusCode);
      const statusCode = Number.isInteger(status) && status >= 400 && status < 600
        ? status
        : 500;
      context.error('[workers] Falha na operação do comunicado.', error?.message || error);
      return {
        status: statusCode,
        jsonBody: {
          erro: statusCode === 500
            ? 'Falha interna ao operar o comunicado.'
            : error.message,
        },
      };
    }
  },
});
