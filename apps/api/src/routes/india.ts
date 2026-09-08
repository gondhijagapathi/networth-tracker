/**
 * The India-specific endpoints: nomination hygiene, the due calendar, the FY report.
 *
 * Read-only, like `/api/analytics`, and for the same reason — every figure here is derived
 * from assets, transactions and valuations, and the moment one of them can be edited
 * directly it stops being derived from anything. A nomination is registered at the bank and
 * then recorded against the asset through the ordinary asset endpoints; there is
 * deliberately no "mark as nominated" here, because this router does not own that flag.
 */

import { Router } from 'express';
import {
  calendarQuerySchema,
  financialYearQuerySchema,
  nominationQuerySchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { resolveScope } from '../repos/scope.js';
import { dueCalendar, financialYearReport, nominationReport } from '../services/india.service.js';

export function indiaRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx));

  router.get('/nomination', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    const { asOf } = nominationQuerySchema.parse(req.query);
    res.json(nominationReport(ctx, scope, asOf));
  });

  router.get('/calendar', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json(dueCalendar(ctx, scope, calendarQuerySchema.parse(req.query)));
  });

  /**
   * The financial-year report.
   *
   * `senior` is a query parameter rather than a stored preference because it is a property
   * of the person the report is *about* — an owner may be running it for a parent's TDS
   * threshold — and because getting it wrong changes a number rather than breaking a screen.
   */
  router.get('/financial-year', (req, res) => {
    const scope = resolveScope(ctx, requireAuthContext(req));
    res.json(financialYearReport(ctx, scope, financialYearQuerySchema.parse(req.query)));
  });

  return router;
}
