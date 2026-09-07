/**
 * Dashboard endpoints.
 *
 * Read-only, every one of them. There is nothing to write here — analytics are derived
 * from assets, valuations and transactions, and the moment a figure on this page can be
 * edited directly it stops being derived from anything.
 *
 * As thin as the other routers: parse with a shared schema, resolve the caller's scope,
 * delegate. The scope is what makes these safe; no handler here filters by owner.
 */

import { Router } from 'express';
import {
  allocationQuerySchema,
  dashboardQuerySchema,
  netWorthQuerySchema,
  performanceQuerySchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { resolveScope } from '../repos/scope.js';
import {
  allocation,
  allocationBreakdown,
  dashboard,
  netWorth,
  performance,
} from '../services/analytics.service.js';

export function analyticsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx));

  /** Everything the dashboard needs in one round trip: summary, allocation, risk, series. */
  router.get('/dashboard', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json(dashboard(ctx, scope, dashboardQuerySchema.parse(req.query)));
  });

  router.get('/networth', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ series: netWorth(ctx, scope, netWorthQuerySchema.parse(req.query)) });
  });

  router.get('/allocation', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json({ allocation: allocation(ctx, scope, allocationQuerySchema.parse(req.query)) });
  });

  /**
   * Every dimension at once. One portfolio load answers all four, so a client that lets
   * the reader flip between class, institution and liquidity should ask for them together
   * rather than four times over.
   */
  router.get('/allocation/all', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const { asOf } = allocationQuerySchema.parse(req.query);
    res.json({ allocations: allocationBreakdown(ctx, scope, asOf) });
  });

  router.get('/performance', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const { asOf } = performanceQuerySchema.parse(req.query);
    res.json(performance(ctx, scope, asOf));
  });

  return router;
}
