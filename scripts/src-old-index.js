'use strict';

const INGEST_SERVICE_URL = process.env.INGEST_SERVICE_URL || 'http://localhost:4158';
const INGEST_WEBHOOK_SECRET = process.env.INGEST_WEBHOOK_SECRET;

// Guards against notifying ingest twice for what is logically ONE save.
// The `update` branch below already protects against a false trigger on
// saves that never touched sourcePdf (comparing against a fetched "before"
// state) — but there was no equivalent protection on `create`, and Strapi
// 5's document-service internals are documented (see this file's own
// comment further down) to sometimes invoke a single logical operation's
// middleware more than once. A second invocation for the SAME create
// necessarily produces the SAME resulting documentId, so a short in-memory
// window keyed by documentId is enough to catch it — this is a real,
// specific incident, not theoretical: one PDF upload produced two full
// sets of Pages/Story hotspots under the one Edition it should have
// created, all correctly sharing one editionSku (that part was working as
// designed), just doubled.
// 10s is generous relative to how close together two invocations of the
// SAME save would land (milliseconds), while short enough that a genuine,
// deliberate re-upload moments later still triggers normally.
const DEDUPE_WINDOW_MS = 10_000;
const recentlyNotified = new Map(); // documentId -> timestamp of last notify

function alreadyNotifiedRecently(documentId) {
  const last = recentlyNotified.get(documentId);
  const now = Date.now();
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recentlyNotified.set(documentId, now);
  // Opportunistic cleanup so this Map doesn't grow forever over a long-running process.
  for (const [id, ts] of recentlyNotified) {
    if (now - ts > DEDUPE_WINDOW_MS) recentlyNotified.delete(id);
  }
  return false;
}

async function notifyIngest(strapi, editionDocumentId) {
  if (alreadyNotifiedRecently(editionDocumentId)) {
    strapi.log.warn(`[edition ingest middleware] suppressed a duplicate ingest trigger for ${editionDocumentId} within ${DEDUPE_WINDOW_MS}ms of the last one`);
    return;
  }
  try {
    await fetch(`${INGEST_SERVICE_URL}/ingest/edition/${editionDocumentId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-secret': INGEST_WEBHOOK_SECRET || ''
      },
      body: JSON.stringify({ triggeredAt: new Date().toISOString() })
    });
  } catch (err) {
    // Don't throw — a failed notification shouldn't fail the save that
    // triggered it. The edition just sits at pipelineStatus "pending"; add a
    // retry/cron sweep here if that needs to be more robust.
    strapi.log.error('[edition ingest middleware] failed to notify ingest service', err);
  }
}

/** Pull a media field's id out of whatever shape it arrives in — a raw
 * id (number/string), an object with an id, or null/undefined for "no file". */
function extractMediaId(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value.id ?? null;
  return value;
}

module.exports = {
  register({ strapi }) {
    /**
     * Fires whenever an Edition document is created or updated. If
     * `sourcePdf` was PART OF THIS WRITE AND ITS VALUE ACTUALLY CHANGED, it
     * notifies the ingest service so it can rasterize the PDF into page
     * images and extract candidate story-hotspot sections.
     *
     * The "actually changed" check matters more than it might look: Strapi's
     * admin panel resends the ENTIRE form on every Save — including the
     * currently-attached sourcePdf's id — even when you only touched an
     * unrelated field like pipelineStatus. Checking merely "is sourcePdf
     * present in the payload" (an earlier version of this file did exactly
     * that) means every single save looks identical to "a new PDF was just
     * uploaded," re-triggering the whole pipeline — including re-ingesting
     * every page as a duplicate — on saves that never touched the PDF at
     * all. Comparing against the pre-write stored value fixes that.
     *
     * This is Document Service Middleware, not a content-type
     * `lifecycles.js` file — deliberately. In Strapi 5, database lifecycle
     * hooks fire inconsistently around the Document Service's draft/publish
     * mechanics (e.g. afterCreate can fire twice, or fire again on what
     * looks like an update). Document Service Middleware operates at the
     * level Strapi's own docs recommend for anything beyond raw DB-row
     * bookkeeping. See: https://docs.strapi.io/cms/api/document-service/middlewares
     *
     * That said, Document Service Middleware isn't automatically immune to
     * the same category of double-invocation — see notifyIngest()'s own
     * dedupe guard above, added after exactly that was observed for a
     * `create`.
     */
    strapi.documents.use(async (context, next) => {
      const isEdition = context.uid === 'api::edition.edition';
      const touchesPdfKey = Boolean(
        context.params?.data &&
        Object.prototype.hasOwnProperty.call(context.params.data, 'sourcePdf')
      );

      strapi.log.debug(`[edition ingest middleware] documents.use fired: uid=${context.uid} action=${context.action} touchesPdfKey=${touchesPdfKey}`);

      let pdfActuallyChanged = false;

      if (isEdition && context.action === 'create' && touchesPdfKey) {
        // Brand-new edition, PDF attached from the start — no "before" state to compare against.
        pdfActuallyChanged = extractMediaId(context.params.data.sourcePdf) != null;
      }

      if (isEdition && context.action === 'update' && touchesPdfKey && context.params.documentId) {
        const before = await strapi.documents('api::edition.edition').findOne({
          documentId: context.params.documentId,
          populate: ['sourcePdf']
        });
        const oldId = extractMediaId(before?.sourcePdf);
        const newId = extractMediaId(context.params.data.sourcePdf);
        pdfActuallyChanged = oldId !== newId;
      }

      const result = await next();

      if (pdfActuallyChanged && result?.sourcePdf) {
        await strapi.documents('api::edition.edition').update({
          documentId: result.documentId,
          data: { pipelineStatus: 'processing', pipelineError: null }
        });
        await notifyIngest(strapi, result.documentId);
      }

      return result;
    });
  },

  bootstrap(/*{ strapi }*/) {}
};