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

const { errors } = require('@strapi/utils');
const { editionCover } = require('./utils/epaper-dates');

const EDITION_UID = 'api::edition.edition';
const PUBLICATION_UID = 'api::publication.publication';

/**
 * Publication rules for every Edition write that goes through the Document
 * Service (REST, the admin panel, the middleware's POST /api/editions):
 *   - the publication can be given as the relation or just as
 *     publicationCode; the other one is filled in, so they never disagree
 *   - coversFrom/coversTo are derived from date + the publication's
 *     coverDays (a weekend edition dated Saturday covers Saturday–Sunday)
 *   - one edition per publication per date (date alone is no longer unique)
 * Refusals are ValidationErrors, so REST callers get a 400 with the reason.
 */
async function applyPublicationRules(strapi, context) {
  const data = context.params?.data;
  if (!data) return;
  const touchesPub = 'publicationCode' in data || 'publication' in data;
  const touchesDate = 'date' in data;
  if (context.action === 'update' && !touchesPub && !touchesDate) return;

  let before = null;
  if (context.action === 'update' && context.params.documentId) {
    before = await strapi.documents(EDITION_UID).findOne({
      documentId: context.params.documentId,
      status: 'draft',
      populate: { publication: { fields: ['code'] } }
    });
  }

  let code = data.publicationCode ? String(data.publicationCode).trim().toUpperCase() : null;
  if (!code && !('publicationCode' in data)) code = before?.publication?.code || before?.publicationCode || null;
  if (!code && context.action === 'create') code = 'NV';
  if (!code) throw new errors.ValidationError('publicationCode is required');

  const pub = await strapi.db.query(PUBLICATION_UID).findOne({ where: { code } });
  if (!pub) throw new errors.ValidationError(`Unknown publication "${code}". Create it in handle under Publications first.`);

  const date = data.date || before?.date;
  if (!date) throw new errors.ValidationError('date is required');

  const clash = await strapi.db.query(EDITION_UID).findOne({
    where: {
      publication: { id: pub.id },
      date,
      ...(context.params.documentId ? { documentId: { $ne: context.params.documentId } } : {})
    },
    select: ['id', 'documentId']
  });
  if (clash) throw new errors.ValidationError(`There is already a ${code} edition for ${date}. Open that edition instead of creating another.`);

  const cover = editionCover(String(date).slice(0, 10), pub.coverDays);
  data.publicationCode = code;
  data.publication = { connect: [{ documentId: pub.documentId }] };
  data.coversFrom = cover.coversFrom;
  data.coversTo = cover.coversTo;
}

/**
 * One-time, idempotent backfill run at every start:
 *   1. every publicationCode used by an edition gets a Publication row
 *      (named after its code; rename it in handle)
 *   2. every edition row without a publication or cover dates gets them
 * Uses strapi.db.query directly, so it does not trigger ingest.
 */
async function backfillPublications(strapi) {
  const db = (uid) => strapi.db.query(uid);
  const rows = await db(EDITION_UID).findMany({
    select: ['id', 'date', 'publicationCode', 'coversFrom', 'coversTo'],
    populate: { publication: { select: ['id', 'code', 'coverDays'] } }
  });
  if (!rows.length) return;

  const codes = [...new Set(rows.map((r) => (r.publicationCode || 'NV').toUpperCase()))];
  const pubs = new Map((await db(PUBLICATION_UID).findMany({ where: { code: { $in: codes } } })).map((p) => [p.code, p]));
  for (const code of codes) {
    if (pubs.has(code)) continue;
    const created = await db(PUBLICATION_UID).create({
      data: { code, title: code, name: code, frequency: 'daily', coverDays: 1, active: true, sortOrder: 0 }
    });
    pubs.set(code, created);
    strapi.log.info(`[publications] created publication ${code} for existing editions — rename it in handle`);
  }

  let fixed = 0;
  for (const r of rows) {
    const pub = r.publication?.id ? r.publication : pubs.get((r.publicationCode || 'NV').toUpperCase());
    if (!pub || !r.date) continue;
    const cover = editionCover(r.date, pub.coverDays);
    if (r.publication?.id && r.coversFrom === cover.coversFrom && r.coversTo === cover.coversTo) continue;
    await db(EDITION_UID).update({
      where: { id: r.id },
      data: { publication: pub.id, publicationCode: pub.code, coversFrom: cover.coversFrom, coversTo: cover.coversTo }
    });
    fixed += 1;
  }
  if (fixed) strapi.log.info(`[publications] linked ${fixed} edition rows to their publication and cover dates`);
}

module.exports = {
  register({ strapi }) {
    // Publication rules run first, so a refused edition never reaches the ingest trigger below.
    strapi.documents.use(async (context, next) => {
      if (context.uid === EDITION_UID && (context.action === 'create' || context.action === 'update')) {
        await applyPublicationRules(strapi, context);
      }
      return next();
    });

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

  async bootstrap({ strapi }) {
    try {
      await backfillPublications(strapi);
    } catch (err) {
      strapi.log.error(`[publications] backfill failed: ${err.message}`);
    }

    // Reader analytics (Phases 1–4): create the tables if missing, then keep
    // today's and yesterday's daily totals fresh every 15 minutes.
    // ANALYTICS_ROLLUP=off stops the job (e.g. on a second CMS instance).
    try {
      const analytics = strapi.service('api::analytics.analytics-store');
      await analytics.ensureTables();
      if (String(process.env.ANALYTICS_ROLLUP || '').toLowerCase() !== 'off') {
        let running = false;
        const tick = async () => {
          if (running) return;
          running = true;
          try {
            await analytics.rollupRecent();
          } catch (err) {
            strapi.log.error(`[analytics] rollup failed: ${err.message}`);
          } finally {
            running = false;
          }
        };
        setTimeout(tick, 30 * 1000).unref();
        setInterval(tick, 15 * 60 * 1000).unref();
      }
    } catch (err) {
      strapi.log.error(`[analytics] setup failed: ${err.message}`);
    }

    // Idempotent: creates FULLTEXT indexes on stories.headline / stories.body if missing.
    // Runs after Strapi's schema sync. Never blocks startup if it fails.
    try {
      await strapi.service('api::story.story-search').ensureFulltextIndexes();
    } catch (err) {
      strapi.log.error(`[story-search] bootstrap index check failed: ${err.message}`);
    }
  }
};