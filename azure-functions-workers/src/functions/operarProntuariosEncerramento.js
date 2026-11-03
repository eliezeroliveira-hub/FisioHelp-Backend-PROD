import { app } from '@azure/functions';

app.http('operarProntuariosEncerramento', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'operacoes/encerramento/prontuarios',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { executarOperacaoProntuariosEncerramento } = await import(
        '../../services/encerramentoProntuariosService.js'
      );
      const result = await executarOperacaoProntuariosEncerramento({
        acao: body?.acao,
        confirmacao: body?.confirmacao,
        prontuarioId: body?.prontuarioId,
      });

      if (result.tipo === 'pdf') {
        context.log('[workers] PDF protegido de prontuário gerado para validação local.', {
          bytes: result.bytes,
          excedeLimiteEmailIndividual: result.excedeLimiteEmailIndividual,
        });
        return {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${result.filename}"`,
            'Content-Length': String(result.bytes),
            'X-FH-Prontuario-Id': String(result.prontuarioId),
            'X-FH-Paciente-Id': String(result.pacienteId),
            'X-FH-Fisioterapeuta-Id': String(result.fisioterapeutaId),
            'X-FH-PDF-SHA256': result.sha256,
            'X-FH-PDF-Protected': 'true',
            'X-FH-Password-Type': result.senhaTipo,
            'X-FH-Password-Suffix': result.senhaFinal,
            'X-FH-Exceeds-Email-Limit': String(result.excedeLimiteEmailIndividual),
            'Cache-Control': 'no-store, private',
          },
          body: result.buffer,
        };
      }

      context.log('[workers] Inventário protegido de prontuários concluído.', {
        total: result.total,
        resumo: result.resumo,
      });
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store, private' },
        jsonBody: result,
      };
    } catch (error) {
      const status = Number(error?.statusCode);
      const statusCode = Number.isInteger(status) && status >= 400 && status < 600
        ? status
        : 500;
      context.error('[workers] Falha na operação protegida de prontuários.', {
        statusCode,
        message: error?.message || String(error),
      });
      return {
        status: statusCode,
        headers: { 'Cache-Control': 'no-store, private' },
        jsonBody: {
          erro: statusCode === 500
            ? 'Falha interna na operação de prontuários.'
            : error.message,
        },
      };
    }
  },
});
