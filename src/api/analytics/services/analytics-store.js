'use strict';

/**
 * src/api/analytics/services/analytics-store.js            NEW FILE (Phases 1–4)
 *
 * Reader analytics: where events are stored, how they roll up into daily
 * tables, and every query behind the dashboards.
 *
 * Storage. Four plain tables in the CMS database, created here at startup
 * (not Strapi content types: an event needs one batched INSERT, and the
 * reports need GROUP BY queries the Document Service can't express):
 *   ana_events      one row per event (sign-in, edition open, page view with
 *                   time on page, story open, search, paywall view, checkout)
 *   ana_reader_day  reader × Kampala day × publication: sessions, editions
 *                   opened with access (front-page previews excluded), pages
 *                   read, minutes, stories, sign-ins
 *   ana_page_day    edition page × day: readers, views, read views, time
 *   ana_story_day   story × day: opens, readers, time
 * All dates are 'YYYY-MM-DD' strings (Kampala), so MySQL and SQLite behave
 * the same and no DATE ↔ JS Date conversion can shift a day.
 *
 * Rules:
 *   - a page is READ after 3 seconds on screen; shorter views are kept
 *   - pages read and reading time count reading with access only; a
 *     front-page preview of a locked edition is kept as a page view but
 *     not as reading
 *   - time on one page view is capped at 10 minutes (set at ingest)
 *   - a reader is a signed-in user (u:<id>) or an anonymous visitor (v:<id>)
 *   - "active on a day" = any event that day, sign-in included
 *   - events are kept 13 months; the daily tables are kept for good
 *
 * Organisation views (portal and the handle Usage tab) only ever return
 * days and publications — never pages, sections or stories (agreed 23 Oct 2026).
 *
 * Writers: the middleware only (POST /api/analytics/ingest, API token).
 */

const { kampalaToday, isIsoDate, addDays } = require('../../../utils/epaper-dates');

const READ_MS = 3000;
const MAX_DWELL_MS = 10 * 60 * 1000;
const RETAIN_DAYS = 400;
const TYPES = new Set([
  'auth.login', 'auth.refresh', 'edition.open', 'page.view', 'story.open',
  'search.query', 'paywall.view', 'checkout.start'
]);

const ENT = 'api::epaper-entitlement.epaper-entitlement';
const SEAT = 'api::epaper-org-seat.epaper-org-seat';
const ORG = 'api::epaper-organization.epaper-organization';
const USER = 'api::epaper-user.epaper-user';
const PUB = 'api::publication.publication';
const STORY = 'api::story.story';
const EDITION = 'api::edition.edition';

class AnalyticsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const num = (v) => Number(v) || 0;
const month = (d) => d.slice(0, 7);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function monthStart(d) {
  return `${d.slice(0, 7)}-01`;
}
function monthEnd(d) {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function addMonthsToMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** { from, to } from a query, default: this month to today. Max 400 days. */
function range(query = {}) {
  const today = kampalaToday();
  let from = query.from && isIsoDate(String(query.from)) ? String(query.from) : monthStart(today);
  let to = query.to && isIsoDate(String(query.to)) ? String(query.to) : today;
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to).length > 400) throw new AnalyticsError(400, 'Choose a range of 400 days or less');
  return { from, to };
}

function previousRange({ from, to }) {
  const n = daysBetween(from, to).length;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

const normPub = (p) => (p ? String(p).trim().toUpperCase().slice(0, 12) : null);

module.exports = ({ strapi }) => {
  const knex = () => strapi.db.connection;
  const q = (uid) => strapi.db.query(uid);

  // ---- tables ----------------------------------------------------------------

  async function ensureTables() {
    const k = knex();
    if (!(await k.schema.hasTable('ana_events'))) {
      await k.schema.createTable('ana_events', (t) => {
        t.bigIncrements('id');
        t.bigInteger('occurred_at').notNullable();
        t.string('local_date', 10).notNullable();
        t.smallint('local_hour');
        t.string('type', 32).notNullable();
        t.string('reader_key', 72);
        t.integer('user_id');
        t.string('visitor_id', 64);
        t.string('session_id', 64);
        t.integer('org_id');
        t.integer('seat_id');
        t.string('access_via', 12);
        t.string('publication', 12);
        t.string('edition_date', 10);
        t.integer('page_number');
        t.string('section', 120);
        t.string('story_id', 64);
        t.integer('dwell_ms');
        t.boolean('locked');
        t.string('device', 12);
        t.string('browser', 24);
        t.string('os', 24);
        t.string('ip_hash', 64);
        t.text('meta');
        t.index(['local_date', 'type'], 'ana_ev_date_type');
        t.index(['user_id', 'local_date'], 'ana_ev_user_date');
        t.index(['org_id', 'local_date'], 'ana_ev_org_date');
        t.index(['publication', 'edition_date'], 'ana_ev_pub_edition');
        t.index(['session_id'], 'ana_ev_session');
      });
      strapi.log.info('[analytics] created table ana_events');
    }
    if (!(await k.schema.hasTable('ana_reader_day'))) {
      await k.schema.createTable('ana_reader_day', (t) => {
        t.string('local_date', 10).notNullable();
        t.string('reader_key', 72).notNullable();
        t.string('publication', 12).notNullable().defaultTo('');
        t.integer('user_id');
        t.integer('org_id');
        t.integer('sessions').defaultTo(0);
        t.integer('editions').defaultTo(0);
        t.integer('page_views').defaultTo(0);
        t.integer('pages_read').defaultTo(0);
        t.bigInteger('read_ms').defaultTo(0);
        t.integer('stories').defaultTo(0);
        t.integer('logins').defaultTo(0);
        t.string('access_via', 12);
        t.primary(['local_date', 'reader_key', 'publication']);
        t.index(['org_id', 'local_date'], 'ana_rd_org_date');
        t.index(['user_id', 'local_date'], 'ana_rd_user_date');
        t.index(['publication', 'local_date'], 'ana_rd_pub_date');
      });
      strapi.log.info('[analytics] created table ana_reader_day');
    }
    if (!(await k.schema.hasTable('ana_page_day'))) {
      await k.schema.createTable('ana_page_day', (t) => {
        t.string('local_date', 10).notNullable();
        t.string('publication', 12).notNullable();
        t.string('edition_date', 10).notNullable();
        t.integer('page_number').notNullable();
        t.string('section', 120);
        t.integer('readers').defaultTo(0);
        t.integer('views').defaultTo(0);
        t.integer('read_views').defaultTo(0);
        t.bigInteger('dwell_ms').defaultTo(0);
        t.primary(['local_date', 'publication', 'edition_date', 'page_number']);
        t.index(['publication', 'edition_date'], 'ana_pd_pub_edition');
      });
      strapi.log.info('[analytics] created table ana_page_day');
    }
    if (!(await k.schema.hasTable('ana_story_day'))) {
      await k.schema.createTable('ana_story_day', (t) => {
        t.string('local_date', 10).notNullable();
        t.string('publication', 12).notNullable();
        t.string('edition_date', 10);
        t.string('story_id', 64).notNullable();
        t.integer('opens').defaultTo(0);
        t.integer('readers').defaultTo(0);
        t.bigInteger('dwell_ms').defaultTo(0);
        t.primary(['local_date', 'publication', 'story_id']);
      });
      strapi.log.info('[analytics] created table ana_story_day');
    }
  }

  // ---- ingest ----------------------------------------------------------------

  /** events: already enriched by the middleware. Invalid rows are skipped, never fatal. */
  async function ingest(events) {
    if (!Array.isArray(events) || !events.length) return { stored: 0 };
    const rows = [];
    for (const e of events.slice(0, 2000)) {
      if (!e || !TYPES.has(e.type)) continue;
      const occurredAt = int(e.occurredAt) || Date.now();
      const local = new Date(occurredAt + 3 * 3600 * 1000);
      const userId = int(e.userId);
      const visitorId = str(e.visitorId, 64);
      const dwell = e.dwellMs === undefined || e.dwellMs === null ? null : Math.max(0, Math.min(MAX_DWELL_MS, int(e.dwellMs) || 0));
      rows.push({
        occurred_at: occurredAt,
        local_date: local.toISOString().slice(0, 10),
        local_hour: local.getUTCHours(),
        type: e.type,
        reader_key: userId ? `u:${userId}` : visitorId ? `v:${visitorId}` : null,
        user_id: userId,
        visitor_id: visitorId,
        session_id: str(e.sessionId, 64),
        org_id: int(e.orgId),
        seat_id: int(e.seatId),
        access_via: str(e.accessVia, 12),
        publication: normPub(e.publication),
        edition_date: e.editionDate && isIsoDate(String(e.editionDate)) ? String(e.editionDate) : null,
        page_number: int(e.pageNumber),
        section: str(e.section, 120),
        story_id: str(e.storyId, 64),
        dwell_ms: dwell,
        locked: e.locked === undefined ? null : Boolean(e.locked),
        device: str(e.device, 12),
        browser: str(e.browser, 24),
        os: str(e.os, 24),
        ip_hash: str(e.ipHash, 64),
        meta: e.meta ? JSON.stringify(e.meta).slice(0, 2000) : null
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      await knex()('ana_events').insert(rows.slice(i, i + 200));
    }
    return { stored: rows.length };
  }

  // ---- rollups ---------------------------------------------------------------

  /** Rebuilds the daily tables for the given Kampala dates from raw events. */
  async function rollupDates(dates) {
    const list = [...new Set(dates.filter((d) => isIsoDate(d)))];
    if (!list.length) return { days: 0 };
    await knex().transaction(async (trx) => {
      await trx('ana_reader_day').whereIn('local_date', list).del();
      await trx('ana_page_day').whereIn('local_date', list).del();
      await trx('ana_story_day').whereIn('local_date', list).del();
      const marks = list.map(() => '?').join(',');
      await trx.raw(
        `INSERT INTO ana_reader_day (local_date, reader_key, publication, user_id, org_id, sessions, editions, page_views, pages_read, read_ms, stories, logins, access_via)
         SELECT local_date, reader_key, COALESCE(publication, ''), MAX(user_id), MAX(org_id),
                COUNT(DISTINCT session_id),
                COUNT(DISTINCT CASE WHEN type IN ('edition.open', 'page.view', 'story.open') AND COALESCE(locked, 0) = 0 THEN edition_date END),
                SUM(CASE WHEN type = 'page.view' THEN 1 ELSE 0 END),
                SUM(CASE WHEN type = 'page.view' AND dwell_ms >= ${READ_MS} AND COALESCE(locked, 0) = 0 THEN 1 ELSE 0 END),
                SUM(CASE WHEN type = 'page.view' AND COALESCE(locked, 0) = 0 THEN COALESCE(dwell_ms, 0) ELSE 0 END),
                SUM(CASE WHEN type = 'story.open' THEN 1 ELSE 0 END),
                SUM(CASE WHEN type IN ('auth.login', 'auth.refresh') THEN 1 ELSE 0 END),
                MAX(access_via)
           FROM ana_events
          WHERE local_date IN (${marks}) AND reader_key IS NOT NULL
          GROUP BY local_date, reader_key, COALESCE(publication, '')`,
        list
      );
      await trx.raw(
        `INSERT INTO ana_page_day (local_date, publication, edition_date, page_number, section, readers, views, read_views, dwell_ms)
         SELECT local_date, publication, edition_date, page_number, MAX(section),
                COUNT(DISTINCT reader_key), COUNT(*),
                SUM(CASE WHEN dwell_ms >= ${READ_MS} THEN 1 ELSE 0 END),
                SUM(COALESCE(dwell_ms, 0))
           FROM ana_events
          WHERE local_date IN (${marks}) AND type = 'page.view'
            AND publication IS NOT NULL AND edition_date IS NOT NULL AND page_number IS NOT NULL
          GROUP BY local_date, publication, edition_date, page_number`,
        list
      );
      await trx.raw(
        `INSERT INTO ana_story_day (local_date, publication, edition_date, story_id, opens, readers, dwell_ms)
         SELECT local_date, publication, MAX(edition_date), story_id, COUNT(*), COUNT(DISTINCT reader_key), SUM(COALESCE(dwell_ms, 0))
           FROM ana_events
          WHERE local_date IN (${marks}) AND type = 'story.open' AND publication IS NOT NULL AND story_id IS NOT NULL
          GROUP BY local_date, publication, story_id`,
        list
      );
    });
    return { days: list.length };
  }

  let lastPurge = null;
  /** The scheduled job: today and yesterday, plus a daily purge of old events. */
  async function rollupRecent() {
    const today = kampalaToday();
    await rollupDates([addDays(today, -1), today]);
    if (lastPurge !== today) {
      const cutoff = addDays(today, -RETAIN_DAYS);
      const removed = await knex()('ana_events').where('local_date', '<', cutoff).del();
      if (removed) strapi.log.info(`[analytics] purged ${removed} events older than ${cutoff}`);
      lastPurge = today;
    }
  }

  async function rebuild(query) {
    const { from, to } = range(query);
    const days = daysBetween(from, to);
    for (let i = 0; i < days.length; i += 7) await rollupDates(days.slice(i, i + 7));
    return { rebuilt: days.length, from, to };
  }

  // ---- lookups ---------------------------------------------------------------

  async function usersById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await q(USER).findMany({ where: { id: { $in: list } }, select: ['id', 'email', 'displayName'] });
    return new Map(rows.map((u) => [u.id, u]));
  }
  async function orgsById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await q(ORG).findMany({ where: { id: { $in: list } }, select: ['id', 'name'] });
    return new Map(rows.map((o) => [o.id, o]));
  }
  async function storiesById(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await q(STORY).findMany({
      where: { documentId: { $in: list } },
      select: ['documentId', 'headline'],
      populate: { page: { select: ['pageNumber', 'section'] } }
    });
    return new Map(rows.map((s) => [s.documentId, s]));
  }
  async function publicationList() {
    const rows = await q(PUB).findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    return rows.map((p) => ({ code: p.code, name: p.name, title: p.title, colour: p.colour || null, category: p.category || 'newspaper' }));
  }

  /** Kept so the second half of this file (queries) can share these helpers. */
  const ctx = {
    knex, q, range, previousRange, daysBetween, month, monthStart, monthEnd, addMonthsToMonth, pct, num,
    usersById, orgsById, storiesById, publicationList, normPub, READ_MS, AnalyticsError,
    ENT, SEAT, ORG, USER, PUB, STORY, EDITION
  };

  return {
    AnalyticsError,
    ensureTables,
    ingest,
    rollupDates,
    rollupRecent,
    rebuild,
    ...require('./analytics-queries')(strapi, ctx)
  };
};
