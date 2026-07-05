// 📁 routes/auth.js
import express from 'express';
import authController from '../controllers/authController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import { loginLimiter } from '../middleware/loginLimiter.js';
import { refreshLimiter } from '../middleware/refreshLimiter.js';
import {
  forgotPasswordConfirmLimiter,
  forgotPasswordRequestLimiter,
  forgotPasswordResetLimiter,
} from '../middleware/forgotPasswordLimiter.js';

const router = express.Router();

router.post('/login', loginLimiter, authController.login);
router.post('/oauth', loginLimiter, authController.loginOAuth);
router.post('/oauth/cadastro-token', loginLimiter, authController.criarOAuthCadastroToken);
router.post('/refresh', refreshLimiter, authController.refreshToken);
router.post('/senha/esqueci', forgotPasswordRequestLimiter, authController.solicitarRedefinicaoSenha);
router.post('/senha/confirmar-codigo', forgotPasswordConfirmLimiter, authController.confirmarCodigoRedefinicaoSenha);
router.post('/senha/redefinir', forgotPasswordResetLimiter, authController.redefinirSenha);

// 🔒 logout exige token válido (garante req.usuario)
router.post('/logout', autenticarJWT, authController.logout);

export default router;
