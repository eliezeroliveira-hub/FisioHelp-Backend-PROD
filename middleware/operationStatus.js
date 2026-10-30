import {
  createOperationDisabledError,
  isOperationEnabled,
} from '../utils/operationStatus.js';

function operationGate(operation) {
  return function requireOperationEnabled(_req, res, next) {
    if (isOperationEnabled(operation, process.env)) return next();

    const error = createOperationDisabledError(operation);
    return res.status(403).json({
      sucesso: false,
      erro: error.message,
      codigo: error.code,
    });
  };
}

export const requireNewRegistrationsEnabled = operationGate('cadastro');
export const requireNewAppointmentsEnabled = operationGate('agendamento');
export const requireNewContractsEnabled = operationGate('contratacao');

