/**
 * Export endpoints.
 *
 * Open to any signed-in account, including a nominee — these are reads, and the only rows
 * they touch are the caller's own. A nominee who owns nothing exports nothing, which is the
 * correct answer rather than a special case.
 *
 * Both endpoints set `Content-Disposition`, because the entire point is a file on somebody's
 * computer rather than JSON in a developer console.
 */

import { Router } from 'express';
import { exportQuerySchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp } from '../lib/request.js';
import { isoNow } from '../lib/time.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.service.js';
import { exportCsv, exportJson } from '../services/export.service.js';

export function exportRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx));

  router.get('/json', (req, res) => {
    const auth = requireAuthContext(req);
    const bundle = exportJson(ctx, auth.userId);

    recordAudit(ctx, {
      actorUserId: auth.userId,
      action: 'export.generated',
      ip: clientIp(req),
      meta: { format: 'json', assets: bundle.assets.length },
    });

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${filename(ctx, 'export', 'json')}"`,
    );
    res.send(JSON.stringify(bundle, null, 2));
  });

  router.get('/csv', (req, res) => {
    const auth = requireAuthContext(req);
    const { dataset } = exportQuerySchema.parse(req.query);
    const csv = exportCsv(ctx, auth.userId, dataset);

    recordAudit(ctx, {
      actorUserId: auth.userId,
      action: 'export.generated',
      ip: clientIp(req),
      meta: { format: 'csv', dataset },
    });

    // The BOM is what makes Excel on Windows read this as UTF-8 rather than as the local
    // code page — without it, a name with a rupee sign or a Devanagari character arrives as
    // mojibake, which is exactly the population this application serves.
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename(ctx, dataset, 'csv')}"`);
    res.send(`\ufeff${csv}`);
  });

  return router;
}

function filename(ctx: AppContext, part: string, extension = part): string {
  return `networth-${part}-${isoNow(ctx.now()).slice(0, 10)}.${extension}`;
}
