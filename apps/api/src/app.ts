import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import type { AppContext } from './context.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { adminRouter } from './routes/admin.js';
import { analyticsRouter } from './routes/analytics.js';
import { assetsRouter } from './routes/assets.js';
import { backupRouter } from './routes/backup.js';
import { authRouter } from './routes/auth.js';
import { checkinRouter } from './routes/checkin.js';
import { estateRouter } from './routes/estate.js';
import { exportRouter } from './routes/export.js';
import { healthRouter } from './routes/health.js';
import { householdsRouter } from './routes/households.js';
import { indiaRouter } from './routes/india.js';
import { instrumentsRouter } from './routes/instruments.js';
import { nomineesRouter } from './routes/nominees.js';
import { vaultRouter } from './routes/vault.js';

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
      // Off, and it stays off. The plan assumed the vault's Argon2id would need
      // SharedArrayBuffer and therefore cross-origin isolation; `hash-wasm` computes its
      // lanes without one, so requiring COEP would buy nothing and would break any future
      // embed for no reason. This matches helmet's own default and is written down so the
      // next person does not have to re-derive it.
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
  app.use('/api/analytics', analyticsRouter(ctx));
  app.use('/api/instruments', instrumentsRouter(ctx));
  app.use('/api/households', householdsRouter(ctx));
  app.use('/api/vault', vaultRouter(ctx));
  app.use('/api/nominees', nomineesRouter(ctx));
  app.use('/api/estate', estateRouter(ctx));
  app.use('/api/india', indiaRouter(ctx));
  // Public by design and mounted at the top level rather than under `/api/estate`, whose
  // router is behind `requireAuth` in its entirety. See the file for why it is two
  // endpoints rather than one link that just works.
  app.use('/api/check-in', checkinRouter(ctx));
  app.use('/api/backup', backupRouter(ctx));
  app.use('/api/export', exportRouter(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler({ exposeStack: config.NODE_ENV === 'development' }));

  return app;
}
