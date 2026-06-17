import express from 'express';
import notificacoesWebhookController from '../controllers/notificacoesWebhookController.js';
import { emailWebhookLimiter } from '../middleware/apiLimiter.js';

const router = express.Router();

router.post('/eventgrid', emailWebhookLimiter, notificacoesWebhookController.eventGrid);
router.post(
  '/ses-sns',
  express.text({ type: ['text/plain', 'text/*'] }),
  emailWebhookLimiter,
  notificacoesWebhookController.sesSns
);

export default router;
