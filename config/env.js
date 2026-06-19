
function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`${name} não configurado.`);
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name];
  const s = String(value || '').trim();
  return s || null;
}

function requiredInProduction(name) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProd) return requiredEnv(name);
  return optionalEnv(name);
}

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} inválido. Use inteiro positivo.`);
  }
  return n;
}

const tokenExpirationRaw = process.env.TOKEN_EXPIRATION || '1d';
if (!/^\d+[smhd]$/.test(tokenExpirationRaw)) {
  throw new Error('TOKEN_EXPIRATION inválido. Use formato como 15m, 1h, 7d.');
}

const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// OAuth: exigido em produção para evitar falha tardia em login social.
const googleClientId = requiredInProduction('GOOGLE_CLIENT_ID');
const appleClientId = requiredInProduction('APPLE_CLIENT_ID');

// Gateway webhook/admin de sistema: obrigatório em produção.
const gatewayWebhookSecret = requiredInProduction('GATEWAY_WEBHOOK_SECRET');
const systemAdminId = parsePositiveIntEnv('SYSTEM_ADMIN_ID', 1);
if (isProd && !gatewayWebhookSecret) {
  throw new Error('GATEWAY_WEBHOOK_SECRET não configurado.');
}
if (isProd && (!Number.isInteger(systemAdminId) || systemAdminId <= 0)) {
  throw new Error('SYSTEM_ADMIN_ID inválido.');
}

// Asaas: obrigatório em produção, opcional em dev até o checkout ser testado.
const asaasApiKey = requiredInProduction('ASAAS_API_KEY');
const asaasBaseUrl = process.env.ASAAS_BASE_URL || 'https://api-sandbox.asaas.com/v3';
const asaasCheckoutBaseUrl = process.env.ASAAS_CHECKOUT_BASE_URL || 'https://sandbox.asaas.com/checkoutSession/show';
const asaasSuccessUrl = process.env.ASAAS_SUCCESS_URL || 'https://fisiohelp.com.br/pagamento/sucesso';
const asaasCancelUrl = process.env.ASAAS_CANCEL_URL || 'https://fisiohelp.com.br/pagamento/cancelado';
const asaasExpiredUrl = process.env.ASAAS_EXPIRED_URL || 'https://fisiohelp.com.br/pagamento/expirado';
const asaasWebhookToken = requiredInProduction('ASAAS_WEBHOOK_TOKEN');
const asaasWithdrawalWebhookToken = optionalEnv('ASAAS_WITHDRAWAL_WEBHOOK_TOKEN') ?? asaasWebhookToken;

const pushProviderMode = String(process.env.PUSH_PROVIDER_MODE || 'stub').trim().toLowerCase();
if (!['stub', 'expo', 'fcm', 'apns'].includes(pushProviderMode)) {
  throw new Error('PUSH_PROVIDER_MODE inválido. Use stub, expo, fcm ou apns.');
}
const expoPushAccessToken = optionalEnv('EXPO_PUSH_ACCESS_TOKEN');

const emailProviderMode = String(process.env.EMAIL_PROVIDER_MODE || 'stub').trim().toLowerCase();
if (!['stub', 'ses', 'acs'].includes(emailProviderMode)) {
  throw new Error('EMAIL_PROVIDER_MODE inválido. Use stub, ses ou acs.');
}
const contatoProviderMode = String(process.env.CONTATO_PROVIDER_MODE || 'stub').trim().toLowerCase();
if (!['stub', 'ses', 'acs'].includes(contatoProviderMode)) {
  throw new Error('CONTATO_PROVIDER_MODE inválido. Use stub, ses ou acs.');
}
const whatsappProviderMode = String(process.env.WHATSAPP_PROVIDER_MODE || 'stub').trim().toLowerCase();
if (!['stub', 'twilio'].includes(whatsappProviderMode)) {
  throw new Error('WHATSAPP_PROVIDER_MODE inválido. Use stub ou twilio.');
}
const awsRegion = optionalEnv('AWS_REGION') || 'sa-east-1';
const emailFrom = optionalEnv('EMAIL_FROM') || 'nao-responda@notificacoes.fisiohelp.com.br';
const emailReplyTo = optionalEnv('EMAIL_REPLY_TO');
const acsConnectionString = optionalEnv('ACS_CONNECTION_STRING');
const acsSenderAddress = optionalEnv('ACS_SENDER_ADDRESS');
const acsEventGridWebhookSecret = requiredInProduction('ACS_EVENTGRID_WEBHOOK_SECRET');
const sesSnsTopicArn = optionalEnv('SES_SNS_TOPIC_ARN');
const twilioAccountSid = optionalEnv('TWILIO_ACCOUNT_SID');
const twilioAuthToken = optionalEnv('TWILIO_AUTH_TOKEN');
const twilioWhatsappFrom = optionalEnv('TWILIO_WHATSAPP_FROM') || 'whatsapp:+14155238886';
const twilioWhatsappStatusCallbackUrl = optionalEnv('TWILIO_WHATSAPP_STATUS_CALLBACK_URL');
const contatoPublicoDestino = optionalEnv('CONTATO_PUBLICO_DESTINO') || 'suporte@fisiohelp.com.br';

const refreshTokenDays = parsePositiveIntEnv('REFRESH_TOKEN_DAYS', 30);

/**
 * Variáveis globais do ambiente
 * - Centraliza acesso às variáveis de configuração
 * - Aplica valores padrão para ambiente de desenvolvimento
 */
export const ENV = {
  // Servidor
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Banco de Dados
  DB_USER: requiredEnv('DB_USER'),
  DB_PASS: requiredEnv('DB_PASS'),
  DB_SERVER: requiredEnv('DB_SERVER'),
  DB_NAME: requiredEnv('DB_NAME'),
  DB_PORT: process.env.DB_PORT || 1433,

  // Autenticação e Segurança
  JWT_SECRET: requiredEnv('JWT_SECRET'),
  TOKEN_EXPIRATION: tokenExpirationRaw,
  OAUTH_AUTOCREATE: process.env.OAUTH_AUTOCREATE, // agora incluído
  REFRESH_TOKEN_DAYS: refreshTokenDays,

  // Logs e informações gerais
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  APP_NAME: process.env.APP_NAME || 'MVP Fisioterapia Backend',

  // (opcionais) URLs de callback OAuth
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  APPLE_REDIRECT_URI: process.env.APPLE_REDIRECT_URI,
  GOOGLE_CLIENT_ID: googleClientId,
  APPLE_CLIENT_ID: appleClientId,

  // Gateway
  GATEWAY_WEBHOOK_SECRET: gatewayWebhookSecret,
  SYSTEM_ADMIN_ID: systemAdminId,
  ASAAS_API_KEY: asaasApiKey,
  ASAAS_BASE_URL: asaasBaseUrl,
  ASAAS_CHECKOUT_BASE_URL: asaasCheckoutBaseUrl,
  ASAAS_SUCCESS_URL: asaasSuccessUrl,
  ASAAS_CANCEL_URL: asaasCancelUrl,
  ASAAS_EXPIRED_URL: asaasExpiredUrl,
  ASAAS_WEBHOOK_TOKEN: asaasWebhookToken,
  ASAAS_WITHDRAWAL_WEBHOOK_TOKEN: asaasWithdrawalWebhookToken,

  // Notificações
  PUSH_PROVIDER_MODE: pushProviderMode,
  EXPO_PUSH_ACCESS_TOKEN: expoPushAccessToken,
  EMAIL_PROVIDER_MODE: emailProviderMode,
  CONTATO_PROVIDER_MODE: contatoProviderMode,
  WHATSAPP_PROVIDER_MODE: whatsappProviderMode,
  AWS_REGION: awsRegion,
  EMAIL_FROM: emailFrom,
  EMAIL_REPLY_TO: emailReplyTo,
  ACS_CONNECTION_STRING: acsConnectionString,
  ACS_SENDER_ADDRESS: acsSenderAddress,
  ACS_EVENTGRID_WEBHOOK_SECRET: acsEventGridWebhookSecret,
  SES_SNS_TOPIC_ARN: sesSnsTopicArn,
  TWILIO_ACCOUNT_SID: twilioAccountSid,
  TWILIO_AUTH_TOKEN: twilioAuthToken,
  TWILIO_WHATSAPP_FROM: twilioWhatsappFrom,
  TWILIO_WHATSAPP_STATUS_CALLBACK_URL: twilioWhatsappStatusCallbackUrl,
  CONTATO_PUBLICO_DESTINO: contatoPublicoDestino,
  NOTIF_WORKER_ENABLED: process.env.NOTIF_WORKER_ENABLED,
  NOTIF_WORKER_INTERVAL_MS: process.env.NOTIF_WORKER_INTERVAL_MS,
  NOTIF_WORKER_STALE_MINUTES: process.env.NOTIF_WORKER_STALE_MINUTES,
  NOTIF_WORKER_BATCH_SIZE: process.env.NOTIF_WORKER_BATCH_SIZE,
  AVALIACAO_WORKER_ENABLED: process.env.AVALIACAO_WORKER_ENABLED,
  AVALIACAO_WORKER_EMAIL_ENABLED: process.env.AVALIACAO_WORKER_EMAIL_ENABLED,
  AVALIACAO_WORKER_INTERVAL_MS: process.env.AVALIACAO_WORKER_INTERVAL_MS,
  AVALIACAO_WORKER_DELAY_MINUTES: process.env.AVALIACAO_WORKER_DELAY_MINUTES,
  AVALIACAO_WORKER_LOOKBACK_DAYS: process.env.AVALIACAO_WORKER_LOOKBACK_DAYS,
  AVALIACAO_WORKER_BATCH_SIZE: process.env.AVALIACAO_WORKER_BATCH_SIZE,
  CONSULTA_LEMBRETE_WORKER_ENABLED: process.env.CONSULTA_LEMBRETE_WORKER_ENABLED,
  CONSULTA_LEMBRETE_EMAIL_ENABLED: process.env.CONSULTA_LEMBRETE_EMAIL_ENABLED,
  CONSULTA_LEMBRETE_WORKER_INTERVAL_MS: process.env.CONSULTA_LEMBRETE_WORKER_INTERVAL_MS,
  CONSULTA_LEMBRETE_HORAS_ANTES: process.env.CONSULTA_LEMBRETE_HORAS_ANTES,
  CONSULTA_LEMBRETE_BATCH_SIZE: process.env.CONSULTA_LEMBRETE_BATCH_SIZE,
};

