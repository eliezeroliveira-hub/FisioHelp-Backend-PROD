// 📁 middleware/sqlSessionContext.js
import { log } from '../config/logger.js';

/**
 * ✅ Middleware: apenas registra o contexto no req e (opcionalmente) tenta aplicar no pool.
 *
 * ⚠️ ATENÇÃO (importante):
 * Aplicar SESSION_CONTEXT aqui, “globalmente”, NÃO garante que as queries nos services
 * vão rodar na mesma conexão do pool.
 *
 * ✅ Por isso, use o helper `services/_queryWithContext.js` quando a query depender de RLS.
 */
export async function aplicarContextoSQL(req, _res, next) {
  try {
    // 🔐 Se não há usuário autenticado → segue sem contexto
    if (!req.usuario?.id || !req.usuario?.tipo) {
      req.sqlContext = null;
      return next();
    }

    // Armazena no req para uso posterior
    req.sqlContext = {
      UsuarioId: req.usuario.id,
      UsuarioTipo: req.usuario.tipo,
    };

    // 🚫 NÃO aplicar SESSION_CONTEXT “no pool” aqui.
    // Motivo: o pool escolhe conexões diferentes a cada request, então isso não garante RLS
    // e ainda pode “sujar” conexões do pool com contexto antigo, afetando SELECTs que NÃO usam queryWithContext.
    //
    // ✅ Regra de ouro: toda query que depende de RLS deve passar pelo helper `services/_queryWithContext.js`
    // (ou por uma SP que não dependa de SESSION_CONTEXT, como no login).
    return next();
  } catch (err) {
    log('error', '⚠️ Erro ao aplicar contexto SQL', { erro: err?.message || err });
    // Não interrompe fluxo — apenas sem contexto
    req.sqlContext = null;
    return next();
  }
}

// ⚠️ queryWithContext removido deste arquivo para evitar duplicidade.
// Use sempre: services/_queryWithContext.js
