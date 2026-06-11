// 📁 routes/auth.js
import express from 'express';
import authController from '../controllers/authController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import { loginLimiter } from '../middleware/loginLimiter.js';
import { refreshLimiter } from '../middleware/refreshLimiter.js';

const router = express.Router();

router.post('/login', loginLimiter, authController.login);
router.post('/oauth', loginLimiter, authController.loginOAuth);
router.post('/refresh', refreshLimiter, authController.refreshToken);

// 🔒 logout exige token válido (garante req.usuario)
router.post('/logout', autenticarJWT, authController.logout);

export default router;
