/**
 * Asset endpoints.
 *
 * Thin by design: parse with a shared schema, resolve the caller's scope, delegate, respond.
 * No handler here filters by owner — that is `repos/scope.ts` and `repos/asset.repo.ts`, and
 * keeping the two apart is what stops a forgotten `where` from leaking a household's assets.
 */

import { Router } from 'express';
import {
  assetQuerySchema,
  createAssetSchema,
  createTransactionSchema,
  createValuationSchema,
  updateAssetSchema,
  updateTransactionSchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { denyNomineeWrites } from '../middleware/readonly.js';
import { assetTypeCounts } from '../repos/asset.repo.js';
import { resolveScope } from '../repos/scope.js';
import { assetPerformance } from '../services/analytics.service.js';
import {
  addTransaction,
  archiveAsset,
  createAsset,
  deleteTransaction,
  getAsset,
  listAssets,
  listTransactions,
  listValuations,
  recordValuation,
  updateAsset,
  updateTransaction,
} from '../services/asset.service.js';

export function assetsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), denyNomineeWrites());

  router.get('/', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const query = assetQuerySchema.parse(req.query);
    res.json(listAssets(ctx, scope, query));
  });

  /** Counts per type and status, for the list's filter chips. */
  router.get('/counts', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ counts: assetTypeCounts(ctx, scope) });
  });

  router.post('/', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const body = createAssetSchema.parse(req.body);
    res.status(201).json({ asset: createAsset(ctx, scope, body, clientIp(req)) });
  });

  router.get('/:id', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ asset: getAsset(ctx, scope, pathParam(req, 'id')) });
  });

  router.patch('/:id', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const body = updateAssetSchema.parse(req.body);
    res.json({ asset: updateAsset(ctx, scope, pathParam(req, 'id'), body) });
  });

  /**
   * Archive, not delete. The asset keeps its valuations and transactions, because last
   * year's net worth was true and a closed deposit is part of it.
   */
  router.delete('/:id', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ asset: archiveAsset(ctx, scope, pathParam(req, 'id'), clientIp(req)) });
  });

  /**
   * How this one asset has done: invested, current value, XIRR and — where the shape of
   * the cashflows allows one — CAGR.
   */
  router.get('/:id/performance', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ performance: assetPerformance(ctx, scope, pathParam(req, 'id')) });
  });

  /* ---------------------------------------------------------------------- */
  /* valuations                                                             */
  /* ---------------------------------------------------------------------- */

  router.get('/:id/valuations', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ valuations: listValuations(ctx, scope, pathParam(req, 'id')) });
  });

  /** Append-only: there is no PATCH or DELETE counterpart, and there should not be. */
  router.post('/:id/valuations', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const body = createValuationSchema.parse(req.body);
    res.status(201).json({ valuation: recordValuation(ctx, scope, pathParam(req, 'id'), body) });
  });

  /* ---------------------------------------------------------------------- */
  /* transactions                                                           */
  /* ---------------------------------------------------------------------- */

  router.get('/:id/transactions', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ transactions: listTransactions(ctx, scope, pathParam(req, 'id')) });
  });

  router.post('/:id/transactions', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const body = createTransactionSchema.parse(req.body);
    res.status(201).json({ transaction: addTransaction(ctx, scope, pathParam(req, 'id'), body) });
  });

  router.patch('/:id/transactions/:transactionId', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const body = updateTransactionSchema.parse(req.body);
    res.json({
      transaction: updateTransaction(
        ctx,
        scope,
        pathParam(req, 'id'),
        pathParam(req, 'transactionId'),
        body,
      ),
    });
  });

  router.delete('/:id/transactions/:transactionId', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    deleteTransaction(
      ctx,
      scope,
      pathParam(req, 'id'),
      pathParam(req, 'transactionId'),
      clientIp(req),
    );
    res.status(204).end();
  });

  return router;
}
