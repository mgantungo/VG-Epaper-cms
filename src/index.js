'use strict';

const INGEST_SERVICE_URL = process.env.INGEST_SERVICE_URL || 'http://localhost:4158';
const INGEST_WEBHOOK_SECRET = process.env.INGEST_WEBHOOK_SECRET;

async function notifyIngest(strapi, editionDocumentId) {
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
     */
    strapi.documents.use(async (context, next) => {
      const isEdition = context.uid === 'api::edition.edition';
      const touchesPdfKey = Boolean(
        context.params?.data &&
        Object.prototype.hasOwnProperty.call(context.params.data, 'sourcePdf')
      );

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