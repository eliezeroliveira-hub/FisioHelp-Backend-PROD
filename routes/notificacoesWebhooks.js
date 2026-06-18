import express from 'express';
import notificacoesWebhookController from '../controllers/notificacoesWebhookController.js';
import { emailWebhookLimiter, twilioWhatsappWebhookLimiter } from '../middleware/apiLimiter.js';

const router = express.Router();

router.post('/eventgrid', emailWebhookLimiter, notificacoesWebhookController.eventGrid);
router.post(
  '/ses-sns',
  express.text({ type: ['text/plain', 'text/*'] }),
  emailWebhookLimiter,
  notificacoesWebhookController.sesSns
);
router.post(
  '/twilio-whatsapp/status',
  express.urlencoded({ extended: false }),
  twilioWhatsappWebhookLimiter,
  notificacoesWebhookController.twilioWhatsappStatus
);

export default router;
