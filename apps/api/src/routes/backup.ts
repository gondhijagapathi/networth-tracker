/**
 * Backup and restore endpoints.
 *
 * Admin only, all of them, and for a different reason than the rest of `/api/admin`. That
 * router is careful to note that administration is an operational role rather than a
 * privileged view of the household's finances — but a backup bundle *is* the household's
 * finances, every account of it, and a restore replaces everyone's data at once. Those are
 * operator actions on the installation, so they live behind the operator's role and nowhere
 * near an ordinary member's screens.
 *
 * The passphrase never reaches the database or the log. It is used to derive a key, and
 * then it is whatever the garbage collector does with it.
 */

import { Router, raw } from 'express';
import { createBackupSchema, restoreBackupSchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext, requireRole } from '../middleware/auth.js';
import {
  createBackup,
  deleteBackup,
  listBackups,
  readBackup,
  restoreBackup,
} from '../services/backup.service.js';

/**
 * A generous ceiling on an uploaded bundle.
 *
 * The database is small — a household's entire financial history is a few megabytes — but
 * the uploads are not: ten documents at the 10 MB limit is already 100 MB before the
 * snapshot. This is the one endpoint in the application that legitimately handles a large
 * body, and it is behind the admin role.
 */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/** The passphrase for a restore rides in a header, because the body is the bundle itself. */
const PASSPHRASE_HEADER = 'x-backup-passphrase';

export function backupRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), requireRole('admin'));

  /** What is on disk, where, and whether the nightly job is actually configured. */
  router.get('/', (_req, res) => {
    res.json(listBackups(ctx));
  });

  /**
   * Take a backup now.
   *
   * The bundle is written to `BACKUP_DIR` and the response describes it; downloading is a
   * second request. Splitting the two means a backup taken from the UI is also on the
   * machine — which is where the retention policy and the operator's off-site copy expect
   * to find it — rather than existing only in whatever the browser did with the download.
   */
  router.post('/', (req, res, next) => {
    const auth = requireAuthContext(req);
    const body = createBackupSchema.parse(req.body);

    void createBackup(ctx, {
      passphrase: body.passphrase,
      actorUserId: auth.userId,
      ip: clientIp(req),
    })
      .then((backup) => res.status(201).json({ backup }))
      .catch(next);
  });

  router.get('/:filename', (req, res) => {
    const filename = pathParam(req, 'filename');
    const bundle = readBackup(ctx, filename);

    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('content-length', String(bundle.length));
    res.send(bundle);
  });

  router.delete('/:filename', (req, res) => {
    const auth = requireAuthContext(req);
    deleteBackup(ctx, pathParam(req, 'filename'), auth.userId);
    res.status(204).end();
  });

  /**
   * Restore from an uploaded bundle.
   *
   * The body is the bundle's bytes, so everything else travels in headers: the passphrase
   * in `x-backup-passphrase` and the confirmation as a query parameter. Both are re-parsed
   * through the same schema a JSON body would have been.
   */
  router.post(
    '/restore',
    raw({ type: 'application/octet-stream', limit: MAX_BUNDLE_BYTES }),
    (req, res, next) => {
      const auth = requireAuthContext(req);

      const body = restoreBackupSchema.parse({
        passphrase: req.get(PASSPHRASE_HEADER) ?? '',
        confirm: req.query.confirm === 'true',
      });

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw badRequest('Upload the backup bundle as the request body');
      }

      void restoreBackup(ctx, req.body, body.passphrase, auth.userId, clientIp(req))
        .then((result) => res.json(result))
        .catch(next);
    },
  );

  return router;
}
