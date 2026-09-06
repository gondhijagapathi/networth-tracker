import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { AppContext } from './context.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { adminRouter } from './routes/admin.js';
import { assetsRouter } from './routes/assets.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { instrumentsRouter } from './routes/instruments.js';

export function createApp(ctx: AppContext): Express {
  const { config } = ctx;
  const app = express();

  // Behind a reverse proxy the client address arrives in `X-Forwarded-For`. Trust exactly
  // one hop — the proxy the operator runs — so a caller cannot prepend a fake address and
  // slip past the per-address login backoff. Direct binds see the socket address.
  app.set('trust proxy', config.API_HOST === '127.0.0.1' ? false : 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // No third-party scripts, analytics or fonts: the only outbound requests this
          // app makes are the price providers, and those are server-side.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // The vault does key derivation in a WASM worker in P4, which needs cross-origin
      // isolation to use SharedArrayBuffer.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(csrfProtection());

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter(ctx));
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api/assets', assetsRouter(ctx));
  app.use('/api/instruments', instrumentsRouter(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeStack: config.NODE_ENV === 'development' }));

  return app;
}
