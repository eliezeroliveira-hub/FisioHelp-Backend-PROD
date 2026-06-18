import sql from 'mssql';
import { queryWithContext } from '../services/_queryWithContext.js';
import { isValidCNPJ, isValidCPF, isValidEmail, normalizeCNPJ, normalizeEmail } from '../utils/identityValidators.js';

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizeCrefito(v) {
  const digits = onlyDigits(v);
  if (digits.length < 4 || digits.length > 6) return null;
  return `${digits}-F`;
}

const cadastroController = {
  async verificar(req, res) {
    const { campo, valor } = req.query;

    if (!campo || !valor) {
      return res.status(400).json({ erro: 'Parâmetros "campo" e "valor" são obrigatórios.' });
    }

    try {
      const c = String(campo).toLowerCase();

      if (c === 'email') {
        const email = normalizeEmail(valor);
        if (!isValidEmail(email)) {
          return res.json({ disponivel: false, mensagem: 'E-mail inválido.' });
        }

        const result = await queryWithContext(
          null,
          (request) => {
            request.input('Email', sql.NVarChar(300), email);
          },
          `SELECT TOP 1 1 AS Encontrado
           FROM dbo.UsuariosEmailsUnicos
           WHERE EmailNormalizado = @Email`
        );

        const encontrado = result.recordset?.length > 0;
        return res.json({
          disponivel: !encontrado,
          mensagem: encontrado ? 'E-mail já cadastrado.' : null,
        });
      }

      if (c === 'telefone') {
        const telefone = onlyDigits(valor);
        if (telefone.length < 10 || telefone.length > 11) {
          return res.json({ disponivel: false, mensagem: 'Telefone inválido.' });
        }

        const result = await queryWithContext(
          null,
          (request) => {
            request.input('Telefone', sql.NVarChar(60), telefone);
          },
          `SELECT TOP 1 1 AS Encontrado
           FROM dbo.UsuariosTelefonesUnicos
           WHERE TelefoneNormalizado = @Telefone`
        );

        const encontrado = result.recordset?.length > 0;
        return res.json({
          disponivel: !encontrado,
          mensagem: encontrado ? 'Telefone já cadastrado.' : null,
        });
      }

      if (c === 'cpf') {
        const cpf = onlyDigits(valor);
        if (cpf.length !== 11 || !isValidCPF(cpf)) {
          return res.json({ disponivel: false, mensagem: 'CPF inválido.' });
        }

        const result = await queryWithContext(
          null,
          (request) => {
            request.input('CPF', sql.NVarChar(40), cpf);
          },
          `SELECT TOP 1 1 AS Encontrado
           FROM dbo.Pacientes
           WHERE CPF = @CPF`
        );

        const encontrado = result.recordset?.length > 0;
        return res.json({
          disponivel: !encontrado,
          mensagem: encontrado ? 'CPF já cadastrado.' : null,
        });
      }

      if (c === 'crefito') {
        const crefito = normalizeCrefito(valor);
        if (!crefito) {
          return res.json({ disponivel: false, mensagem: 'CREFITO inválido.' });
        }

        const result = await queryWithContext(
          null,
          (request) => {
            request.input('CREFITO', sql.NVarChar(20), crefito);
          },
          `SELECT TOP 1 1 AS Encontrado
           FROM dbo.Fisioterapeutas
           WHERE CREFITO = @CREFITO`
        );

        const encontrado = result.recordset?.length > 0;
        return res.json({
          disponivel: !encontrado,
          mensagem: encontrado ? 'CREFITO já cadastrado.' : null,
        });
      }

      if (c === 'cnpj') {
        const cnpj = normalizeCNPJ(valor);
        if (!isValidCNPJ(cnpj)) {
          return res.json({ disponivel: false, mensagem: 'CNPJ inválido.' });
        }

        const result = await queryWithContext(
          null,
          (request) => {
            request.input('CNPJ', sql.NVarChar(20), cnpj);
          },
          `SELECT TOP 1 1 AS Encontrado
           FROM dbo.Fisioterapeutas
           WHERE CNPJ = @CNPJ`
        );

        const encontrado = result.recordset?.length > 0;
        return res.json({
          disponivel: !encontrado,
          mensagem: encontrado ? 'CNPJ já cadastrado.' : null,
        });
      }

      return res.status(400).json({
        erro: `Campo "${campo}" não suportado. Use: email, telefone, cpf, crefito, cnpj.`,
      });
    } catch (_err) {
      return res.status(500).json({ erro: 'Erro ao verificar disponibilidade.' });
    }
  },
};

export default cadastroController;
