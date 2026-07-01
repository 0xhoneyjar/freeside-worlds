/**
 * Manifest HTTP handlers — POST /v1/worlds/manifest + GET /v1/worlds/lookup.
 */

import { checkWorldsApiToken } from '../auth.js';
import {
  ManifestService,
  ManifestValidationError,
  SlugCollisionError,
} from './service.js';
import { toPublicView } from './types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleManifestRoutes(
  req: Request,
  url: URL,
  manifestService: ManifestService,
): Promise<Response | null> {
  if (url.pathname === '/v1/worlds/manifest' && req.method === 'POST') {
    if (!checkWorldsApiToken(req)) {
      return json({ error: 'unauthorized' }, 401);
    }

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const body = parsed as Record<string, unknown>;
    try {
      const result = manifestService.createManifest({
        chainId: String(body.chain_id ?? ''),
        contractAddress: String(body.contract_address ?? ''),
        displayName: String(body.display_name ?? ''),
        contactEmail: String(body.contact_email ?? ''),
        orderId: String(body.order_id ?? ''),
        source: body.source !== undefined ? String(body.source) : undefined,
      });

      const view = toPublicView(result.record);
      return json(view, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof ManifestValidationError) {
        return json({ error: err.code, issues: err.issues }, 422);
      }
      if (err instanceof SlugCollisionError) {
        return json(
          {
            error: err.code,
            world_slug: err.attemptedSlug,
            suggested_slug: err.suggestedSlug,
          },
          409,
        );
      }
      throw err;
    }
  }

  if (url.pathname === '/v1/worlds/lookup' && req.method === 'GET') {
    if (!checkWorldsApiToken(req)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const chainId = url.searchParams.get('chain_id') ?? '';
    const contractAddress = url.searchParams.get('contract_address') ?? '';
    if (!chainId || !contractAddress) {
      return json({ error: 'bad_request', detail: 'chain_id and contract_address are required' }, 400);
    }

    const record = manifestService.lookup(chainId, contractAddress);
    if (!record) {
      return json({ error: 'not_found' }, 404);
    }
    return json(toPublicView(record));
  }

  return null;
}
