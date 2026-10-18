import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));

// Injection is only for offline tests; production always uses Telegram's Bot API.
export function createApp({ token = '', chatId = '', publicOrigin = '', telegramFetch = fetch, now = Date.now } = {}) {
  let publicHost = '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin) throw new Error('Public origin must be an HTTPS origin.');
    publicHost = url.host;
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    next();
  });
  // Render probes the service internally; this endpoint reveals no configuration.
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    const host = req.get('host') || '';
    if (publicHost ? host !== publicHost : !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return res.status(403).json({ error: 'Откройте демо по его основному адресу.' });
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не поддерживается.' });
    if (req.get('origin') !== (publicOrigin || `http://${req.get('host')}`) || !req.is('application/json')) {
      return res.status(403).json({ error: 'Отправка доступна только со страницы демо.' });
    }
    next();
  });
  app.use(express.json({ limit: '3mb' }));

  let sending = false;
  let windowStart = now();
  let attempts = 0;
  app.post('/api/check-in', async (req, res) => {
    const { consent, photo, location } = req.body || {};
    const validNumber = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    if (consent !== true || !location ||
        !validNumber(location.latitude, -90, 90) || !validNumber(location.longitude, -180, 180) ||
        !validNumber(location.accuracy, 0, 100000000) ||
        typeof photo !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) {
      return res.status(400).json({ error: 'Нужны согласие, фото JPEG и корректные координаты.' });
    }
    const encoded = photo.slice('data:image/jpeg;base64,'.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 4 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== encoded ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      return res.status(400).json({ error: 'Некорректное фото: нужен JPEG до 2 МБ.' });
    }
    if (!token || !chatId) {
      return res.status(503).json({ error: 'Отправка не настроена. Владелец должен задать настройки Telegram на сервере.' });
    }
    if (sending) return res.status(429).json({ error: 'Дождитесь завершения предыдущей отправки.' });
    // A single demo-wide budget avoids storing visitor IPs or other identifiers.
    if (publicOrigin) {
      const current = now();
      if (current - windowStart >= 60000) { windowStart = current; attempts = 0; }
      if (attempts >= 10) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((60000 - (current - windowStart)) / 1000))));
        return res.status(429).json({ error: 'Лимит демо: 10 отправок в минуту. Попробуйте позже.' });
      }
      attempts++;
    }
    sending = true;
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'check-in.jpg');
      form.set('caption', `Демо чек-ина: посетитель подтвердил отправку.\nШирота: ${location.latitude}\nДолгота: ${location.longitude}\nТочность: ±${location.accuracy} м`);
      // One message carries both photo and coordinates, avoiding partial two-message delivery.
      const response = await telegramFetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error('Telegram rejected request');
      res.json({ ok: true });
    } catch {
      // Never log request bodies, bot URLs, upstream errors, photos or coordinates.
      res.status(502).json({ error: 'Подтверждение Telegram не получено. Сообщение могло дойти: проверьте чат перед повтором.' });
    } finally {
      sending = false;
    }
  });
  app.use(express.static(path.join(directory, 'public'), { dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).json({ error: 'Не найдено.' }));
  app.use((error, req, res, next) => {
    const status = error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Слишком большой запрос.' : 'Некорректный запрос.' });
  });
  return app;
}

export function resolveConfig(environment = {}, local = {}) {
  const render = environment.RENDER === 'true';
  // Local runs never inherit credentials belonging to other bots.
  const config = render ? environment : local;
  const port = Number(config.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT должен быть целым числом от 1 до 65535.');
  }
  let publicOrigin = '';
  if (render) {
    let url;
    try { url = new URL(config.RENDER_EXTERNAL_URL); } catch { throw new Error('Не задан корректный RENDER_EXTERNAL_URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('RENDER_EXTERNAL_URL должен быть HTTPS-адресом сайта без пути и параметров.');
    }
    publicOrigin = url.origin;
  }
  return { port, host: render ? '0.0.0.0' : '127.0.0.1', publicOrigin,
    token: config.TELEGRAM_BOT_TOKEN || '', chatId: config.TELEGRAM_CHAT_ID || '' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const local = process.env.RENDER === 'true' ? {} : (dotenv.config({ path: path.join(directory, '.env') }).parsed || {});
    const config = resolveConfig(process.env, local);
    const app = createApp(config);
    app.listen(config.port, config.host, () => {
      console.log(`Consent demo: ${config.publicOrigin || `http://localhost:${config.port}`}`);
      if (!config.token || !config.chatId) console.log('Telegram не настроен: доступны страница и предпросмотр.');
    }).on('error', () => {
      console.error('Не удалось запустить сервер. Проверьте PORT.');
      process.exitCode = 1;
    });
  } catch {
    console.error('Ошибка конфигурации: проверьте PORT и HTTPS-адрес RENDER_EXTERNAL_URL для Render.');
    process.exitCode = 1;
  }
}
