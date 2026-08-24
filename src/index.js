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

module.exports = {
  register({ strapi }) {
    /**
     * Fires whenever an Edition document is created or updated. If
     * `sourcePdf` was part of THIS write, it notifies the ingest service so
     * it can rasterize the PDF into page images and extract candidate
     * story-hotspot sections.
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
      const isWrite = context.action === 'create' || context.action === 'update';
      const touchesPdf = Boolean(
        context.params?.data &&
        Object.prototype.hasOwnProperty.call(context.params.data, 'sourcePdf')
      );

      const result = await next();

      if (isEdition && isWrite && touchesPdf && result?.sourcePdf) {
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
