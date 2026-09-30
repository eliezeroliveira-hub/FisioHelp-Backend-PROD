import { ENV } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

function montarQueryString(params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, String(value));
  });

  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

async function asaasFetch(path, { method = 'GET', body = null, timeoutMs = null } = {}) {
  if (!ENV.ASAAS_API_KEY) {
    throw new HttpError(500, 'ASAAS_API_KEY não configurada.');
  }

  const parsedTimeoutMs = Number(timeoutMs);
  const controller = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? new AbortController()
    : null;
  let timeoutHandle = null;
  try {
    if (controller) {
      timeoutHandle = setTimeout(() => controller.abort(), parsedTimeoutMs);
      timeoutHandle.unref?.();
    }
    const resp = await fetch(`${ENV.ASAAS_BASE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        access_token: ENV.ASAAS_API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      const descriptions = errors
        .map((err) => String(err?.description ?? '').trim())
        .filter(Boolean);
      const msg = descriptions.length > 0
        ? descriptions.join(' ')
        : `Erro Asaas (HTTP ${resp.status})`;
      throw new HttpError(resp.status, msg, data);
    }

    return data;
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new HttpError(504, 'O gateway de pagamento demorou para responder. Tente novamente.');
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

}

export const asaasClient = {
  criarCheckout(payload, { timeoutMs = null } = {}) {
    return asaasFetch('/checkouts', { method: 'POST', body: payload, timeoutMs });
  },

  listarPagamentos(params = {}) {
    return asaasFetch(`/payments${montarQueryString(params)}`);
  },

  obterPagamento(paymentId) {
    const id = encodeURIComponent(String(paymentId ?? '').trim());
    if (!id) {
      throw new HttpError(400, 'paymentId Asaas é obrigatório.');
    }
    return asaasFetch(`/payments/${id}`);
  },

  estornarPagamento(paymentId, payload = {}) {
    const id = encodeURIComponent(String(paymentId ?? '').trim());
    if (!id) {
      throw new HttpError(400, 'paymentId Asaas é obrigatório para estorno.');
    }
    return asaasFetch(`/payments/${id}/refund`, { method: 'POST', body: payload });
  },

  estornarParcelamento(installmentId, payload = {}) {
    const id = encodeURIComponent(String(installmentId ?? '').trim());
    if (!id) {
      throw new HttpError(400, 'installmentId Asaas é obrigatório para estorno.');
    }
    return asaasFetch(`/installments/${id}/refund`, { method: 'POST', body: payload });
  },

  listarEstornos(paymentId) {
    const id = encodeURIComponent(String(paymentId ?? '').trim());
    if (!id) {
      throw new HttpError(400, 'paymentId Asaas é obrigatório para listar estornos.');
    }
    return asaasFetch(`/payments/${id}/refunds`);
  },

  criarTransferencia(payload) {
    return asaasFetch('/transfers', { method: 'POST', body: payload });
  },

  obterTransferencia(transferId) {
    const id = encodeURIComponent(String(transferId ?? '').trim());
    if (!id) {
      throw new HttpError(400, 'transferId Asaas é obrigatório.');
    }
    return asaasFetch(`/transfers/${id}`);
  },
};

export default asaasClient;
