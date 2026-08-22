import express from 'express';
import appVersionController from '../controllers/appVersionController.js';

const router = express.Router();

router.get('/status', appVersionController.status);

export default router;
