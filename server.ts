import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {createServer as createViteServer} from 'vite';
import {createApiRouter} from './server/routes.ts';
import {startTelegramBot, stopTelegramBot} from './server/telegramBot.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({limit: '4mb'}));

  app.use('/api', createApiRouter());

  // Start Telegram bot (registers /api/telegram/webhook before SPA fallback if webhook mode)
  await startTelegramBot(app);

  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const publicDir = path.resolve(process.cwd(), 'public');
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir));
    }
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClientFy server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = async () => {
    await stopTelegramBot().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

startServer().catch((err) => {
  console.error('Failed to start ClientFy server:', err);
  process.exit(1);
});
