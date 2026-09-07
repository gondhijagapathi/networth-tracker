/**
 * Vault endpoints.
 *
 * Every body on this router is ciphertext, validated by a schema that rejects anything
 * which is not (`@networth/shared/vault`). The handlers are thin for the usual reason and
 * one extra: the less code sits between the request and the insert, the easier it is to
 * satisfy yourself by reading that no plaintext could pass through here.
 *
 * The nominee guard is mounted per route rather than across the router, which is the one
 * deliberate exception to the blanket rule in `middleware/readonly.ts`. A nominee has to be
 * able to create *their own* key material — an owner cannot wrap a data key to a public key
 * that does not exist — so setup, unlock and rekey are open to them and nothing else is.
 */

import { Router, raw } from 'express';
import {
  MAX_DOCUMENT_BYTES,
  createVaultItemSchema,
  rekeyVaultSchema,
  setupVaultSchema,
  updateVaultItemSchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/errors.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { denyNomineeWrites } from '../middleware/readonly.js';
import {
  deleteDocument,
  listDocuments,
  readDocument,
  uploadDocument,
} from '../services/document.service.js';
import {
  confirmUnlock,
  createVault,
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  rekeyVault,
  unlockVault,
  updateVaultItem,
  vaultStatus,
} from '../services/vault.service.js';

/** The header a document upload carries its encrypted `{filename, mime}` in. */
const META_HEADER = 'x-vault-meta';

export function vaultRouter(ctx: AppContext): Router {
  const router = Router();
  const ownerOnly = denyNomineeWrites();

  router.use(requireAuth(ctx));

  /* ---------------------------------------------------------------------- */
  /* Key material                                                           */
  /* ---------------------------------------------------------------------- */

  /** Whether a vault exists and how much is in it. Deliberately carries no key material. */
  router.get('/', (req, res) => {
    res.json(vaultStatus(ctx, requireAuthContext(req).userId));
  });

  router.post('/', (req, res) => {
    const auth = requireAuthContext(req);
    const body = setupVaultSchema.parse(req.body);
    res.status(201).json({ keys: createVault(ctx, auth.userId, body, clientIp(req)) });
  });

  /**
   * Hand over the wrapped key material.
   *
   * A POST rather than a GET, and not only for the CSRF token: this is metered and audited,
   * and a GET would be cached, prefetched and retried by anything that felt like it.
   */
  router.post('/unlock', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ keys: unlockVault(ctx, auth.userId, clientIp(req)) });
  });

  /** The client opened it. Clears the backoff the retrieval above charged. */
  router.post('/unlock/confirm', (req, res) => {
    const auth = requireAuthContext(req);
    confirmUnlock(ctx, auth.userId, clientIp(req));
    res.status(204).end();
  });

  router.post('/rekey', (req, res) => {
    const auth = requireAuthContext(req);
    const body = rekeyVaultSchema.parse(req.body);
    res.json({ keys: rekeyVault(ctx, auth.userId, body, clientIp(req)) });
  });

  /* ---------------------------------------------------------------------- */
  /* Items                                                                  */
  /* ---------------------------------------------------------------------- */

  router.get('/items', (req, res) => {
    const auth = requireAuthContext(req);
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
    res.json({ items: listVaultItems(ctx, auth.userId, { assetId }) });
  });

  router.post('/items', ownerOnly, (req, res) => {
    const auth = requireAuthContext(req);
    const body = createVaultItemSchema.parse(req.body);
    res.status(201).json({ item: createVaultItem(ctx, auth.userId, body, clientIp(req)) });
  });

  router.get('/items/:id', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ item: getVaultItem(ctx, auth.userId, pathParam(req, 'id')) });
  });

  router.patch('/items/:id', ownerOnly, (req, res) => {
    const auth = requireAuthContext(req);
    const body = updateVaultItemSchema.parse(req.body);
    res.json({
      item: updateVaultItem(ctx, auth.userId, pathParam(req, 'id'), body, clientIp(req)),
    });
  });

  router.delete('/items/:id', ownerOnly, (req, res) => {
    const auth = requireAuthContext(req);
    deleteVaultItem(ctx, auth.userId, pathParam(req, 'id'), clientIp(req));
    res.status(204).end();
  });

  /* ---------------------------------------------------------------------- */
  /* Documents                                                              */
  /* ---------------------------------------------------------------------- */

  router.get('/documents', (req, res) => {
    const auth = requireAuthContext(req);
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
    res.json({ documents: listDocuments(ctx, auth.userId, { assetId }) });
  });

  /**
   * Upload one encrypted file.
   *
   * The body is the raw ciphertext with its IV prefixed — not base64 inside JSON, which
   * would inflate a 10 MB scan to 13 MB and buy nothing. The encrypted filename rides in a
   * header instead, because it is a few hundred bytes and putting it in the body would
   * mean parsing a multipart encoding to find it.
   */
  router.post(
    '/documents',
    ownerOnly,
    raw({ type: 'application/octet-stream', limit: MAX_DOCUMENT_BYTES }),
    (req, res) => {
      const auth = requireAuthContext(req);
      const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      const document = uploadDocument(
        ctx,
        auth.userId,
        { assetId, meta: decodeMeta(req.get(META_HEADER)) },
        content,
        clientIp(req),
      );
      res.status(201).json({ document });
    },
  );

  router.get('/documents/:id/content', (req, res) => {
    const auth = requireAuthContext(req);
    const { row, content } = readDocument(ctx, auth.userId, pathParam(req, 'id'), clientIp(req));

    // No filename in the disposition: the server does not know it, and a browser saving
    // `<uuid>.bin` is the honest outcome. The app decrypts and renames client-side.
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(row.sizeBytes));
    res.setHeader('x-document-sha256', row.sha256);
    res.send(content);
  });

  router.delete('/documents/:id', ownerOnly, (req, res) => {
    const auth = requireAuthContext(req);
    deleteDocument(ctx, auth.userId, pathParam(req, 'id'), clientIp(req));
    res.status(204).end();
  });

  return router;
}

/** Decode the base64url JSON envelope the upload carries its encrypted metadata in. */
function decodeMeta(header: string | undefined): unknown {
  if (!header) throw badRequest(`Missing ${META_HEADER} header`);
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw badRequest(`${META_HEADER} is not a base64url-encoded JSON envelope`);
  }
}
