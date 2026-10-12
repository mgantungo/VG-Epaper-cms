'use strict';

/**
 * story-search service  (uid: api::story.story-search)
 *
 * Hybrid full-text search over published stories:
 *   1. RANK     - one knex query on the `stories` table only, using MySQL/MariaDB
 *                 MATCH ... AGAINST (natural language mode). Returns documentIds + scores.
 *   2. HYDRATE  - Strapi Document Service loads those stories with page + image (+ edition),
 *                 Query Engine batch-resolves editions by `editionSku` for the epaper link.
 *   3. FALLBACK - if the database is not MySQL/MariaDB or the FULLTEXT indexes are missing,
 *                 a tiered `$containsi` search through the Document Service is used instead.
 */

const { errors } = require('@strapi/utils');

const { ValidationError } = errors;

const STORY_UID = 'api::story.story';
const EDITION_UID = 'api::edition.edition';

const MIN_WORDS = 5;
const MAX_QUERY_LENGTH = 300;
const MAX_TERMS = 12;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const HEADLINE_WEIGHT = 3; // headline match counts 3x a body match
const FALLBACK_CANDIDATE_CAP = 200;

const envMinScore = Number(process.env.STORY_SEARCH_MIN_SCORE);
const MIN_SCORE = Number.isFinite(envMinScore) ? envMinScore : 0.1;

const EPAPER_BASE_URL = (process.env.EPAPER_BASE_URL || 'https://epapers.new.visiongroup.co.ug').replace(/\/+$/, '');

const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below between both but by ' +
    'can did do does doing down during each few for from further had has have having he her here hers him his how i if ' +
    'in into is it its just me more most my no nor not now of off on once only or other our out over own same she should ' +
    'so some such than that the their them then there these they this those through to too under until up very was we ' +
    'were what when where which while who whom why will with would you your'
  ).split(' ')
);

/* ----------------------------- pure helpers ----------------------------- */

const parseDate = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${label} must be in yyyy-mm-dd format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${label} is not a valid calendar date`);
  }
  return date;
};

const extractTerms = (phrase) => {
  const seen = new Set();
  for (const raw of phrase.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    const term = raw.replace(/^'+|'+$/g, '');
    if (term.length >= 3 && !STOPWORDS.has(term)) seen.add(term);
  }
  return [...seen].slice(0, MAX_TERMS);
};

const parseParams = (params = {}) => {
  const phrase = String(params.query ?? '').trim().replace(/\s+/g, ' ');

  if (!phrase) throw new ValidationError('query (search phrase) is required');
  if (phrase.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(`query must not exceed ${MAX_QUERY_LENGTH} characters`);
  }
  if (phrase.split(' ').length < MIN_WORDS) {
    throw new ValidationError(`query must contain at least ${MIN_WORDS} words`);
  }

  const start = parseDate(params.startDate, 'startDate');
  const endInclusive = parseDate(params.endDate, 'endDate');
  if (start && endInclusive && start > endInclusive) {
    throw new ValidationError('startDate must not be later than endDate');
  }
  // endDate is inclusive -> query uses an exclusive upper bound of the next midnight
  const endExclusive = endInclusive ? new Date(endInclusive.getTime() + 24 * 60 * 60 * 1000) : null;

  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(params.pageSize, 10) || DEFAULT_PAGE_SIZE));

  return { phrase, terms: extractTerms(phrase), start, endExclusive, page, pageSize };
};

const stripMarkdown = (text = '') =>
  String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const makeSnippet = (body, terms, length = 220) => {
  const text = stripMarkdown(body);
  if (!text) return null;
  const lower = text.toLowerCase();
  const positions = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const from = Math.max(0, first - 60);
  const slice = text.slice(from, from + length).trim();
  return `${from > 0 ? '…' : ''}${slice}${from + length < text.length ? '…' : ''}`;
};

const toDateString = (value) => {
  if (!value) return null;
  const str = value instanceof Date ? value.toISOString() : String(value);
  const day = str.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

const matchedInLabel = (inHeadline, inBody) => {
  if (inHeadline && inBody) return 'both';
  return inHeadline ? 'headline' : 'body';
};

const isMissingFulltextIndex = (err) =>
  err && (err.errno === 1191 || err.code === 'ER_FT_MATCHING_KEY_NOT_FOUND');

/* -------------------------------- service -------------------------------- */

module.exports = ({ strapi }) => {
  const isMysql = () => ['mysql', 'mysql2'].includes(strapi.db.config.connection.client);

  /** Resolve real table/column names from Strapi's own metadata instead of hard-coding them. */
  const storyColumns = () => {
    const meta = strapi.db.metadata.get(STORY_UID);
    const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const col = (attr) => meta.attributes[attr]?.columnName ?? snake(attr);
    return { table: meta.tableName, col };
  };

  const absoluteUrl = (url) => {
    if (!url) return null;
    if (/^https?:\/\//i.test(url) || url.startsWith('//')) return url; // cloud provider
    const base = (process.env.PUBLIC_URL || strapi.config.get('server.url') || '').replace(/\/+$/, '');
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const epaperLink = (date) => {
    const day = toDateString(date);
    return day ? `${EPAPER_BASE_URL}/${day.replace(/-/g, '/')}` : null;
  };

  const POPULATE = {
    page: {
      fields: ['pageNumber', 'section'],
      populate: {
        image: { fields: ['url', 'alternativeText'] },
        edition: { fields: ['date', 'sku'] },
      },
    },
  };

  const STORY_FIELDS = [
    'headline', 'kicker', 'byline', 'teaser', 'body',
    'editionSku', 'continuesToPage', 'createdAt',
  ];

  /** editionSku -> edition.date, resolved in ONE batched query (draft/published rows share sku + date). */
  const loadEditionDates = async (entries) => {
    const skus = [...new Set(entries.map((e) => e.editionSku).filter(Boolean))];
    const map = new Map();
    if (!skus.length) return map;
    const editions = await strapi.db.query(EDITION_UID).findMany({
      where: { sku: { $in: skus } },
      select: ['sku', 'date'],
    });
    for (const ed of editions) map.set(ed.sku, ed.date);
    return map;
  };

  const shape = (entry, editionDates, terms, { score, matchedIn }) => {
    const page = entry.page ?? null;
    const date = (entry.editionSku && editionDates.get(entry.editionSku)) || page?.edition?.date || null;
    return {
      documentId: entry.documentId,
      headline: entry.headline,
      kicker: entry.kicker ?? null,
      byline: entry.byline ?? null,
      teaser: entry.teaser ?? null,
      snippet: makeSnippet(entry.body, terms),
      section: page?.section ?? null,
      pageNumber: page?.pageNumber ?? null,
      continuesToPage: entry.continuesToPage ?? null,
      imageUrl: absoluteUrl(page?.image?.url),
      editionSku: entry.editionSku ?? null,
      epaperLink: epaperLink(date),
      createdAt: entry.createdAt,
      score: Math.round(score * 1000) / 1000,
      matchedIn,
    };
  };

  /* ---------- 1. FULLTEXT path ---------- */

  const searchFulltext = async ({ phrase, terms, start, endExclusive, page, pageSize }) => {
    const knex = strapi.db.connection;
    const { table, col } = storyColumns();
    const h = col('headline');
    const b = col('body');

    const hSql = 'MATCH(??) AGAINST(? IN NATURAL LANGUAGE MODE)';
    const bSql = 'MATCH(??) AGAINST(? IN NATURAL LANGUAGE MODE)';
    const scoreSql = `(${hSql} * ${HEADLINE_WEIGHT} + ${bSql})`;
    const scoreBindings = [h, phrase, b, phrase];

    const applyFilters = (qb) => {
      qb.whereNotNull(col('publishedAt'))
        .andWhere((w) => w.whereNull(col('reviewState')).orWhere(col('reviewState'), 'active'))
        .whereRaw(`${scoreSql} >= ?`, [...scoreBindings, MIN_SCORE]);
      if (start) qb.andWhere(col('createdAt'), '>=', start);
      if (endExclusive) qb.andWhere(col('createdAt'), '<', endExclusive);
      return qb;
    };

    const countRow = await applyFilters(knex(table)).count({ total: '*' }).first();
    const total = Number(countRow?.total ?? 0);

    const rows = total
      ? await applyFilters(knex(table))
          .select({ documentId: col('documentId') })
          .select(knex.raw(`${hSql} AS headline_score`, [h, phrase]))
          .select(knex.raw(`${bSql} AS body_score`, [b, phrase]))
          .select(knex.raw(`${scoreSql} AS score`, scoreBindings))
          .orderBy('score', 'desc')
          .orderBy(col('createdAt'), 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
      : [];

    const ranking = new Map(rows.map((r) => [r.documentId, r]));
    const ids = [...ranking.keys()];

    let data = [];
    if (ids.length) {
      const entries = await strapi.documents(STORY_UID).findMany({
        filters: { documentId: { $in: ids } },
        status: 'published',
        fields: STORY_FIELDS,
        populate: POPULATE,
        limit: ids.length,
      });
      const editionDates = await loadEditionDates(entries);
      data = entries
        .map((entry) => {
          const r = ranking.get(entry.documentId);
          return shape(entry, editionDates, terms, {
            score: Number(r.score),
            matchedIn: matchedInLabel(Number(r.headline_score) > 0, Number(r.body_score) > 0),
          });
        })
        .sort((a, c) => c.score - a.score);
    }

    return { data, total, engine: 'fulltext' };
  };

  /* ---------- 2. $containsi fallback path ---------- */

  const searchContains = async ({ phrase, terms, start, endExclusive, page, pageSize }) => {
    if (!terms.length) return { data: [], total: 0, engine: 'fallback' };

    const and = [
      { $or: [{ reviewState: { $null: true } }, { reviewState: 'active' }] },
      {
        $or: terms.flatMap((t) => [{ headline: { $containsi: t } }, { body: { $containsi: t } }]),
      },
    ];
    if (start) and.push({ createdAt: { $gte: start.toISOString() } });
    if (endExclusive) and.push({ createdAt: { $lt: endExclusive.toISOString() } });

    const candidates = await strapi.documents(STORY_UID).findMany({
      filters: { $and: and },
      status: 'published',
      fields: STORY_FIELDS,
      populate: POPULATE,
      sort: ['createdAt:desc'],
      limit: FALLBACK_CANDIDATE_CAP,
    });

    const phraseLower = phrase.toLowerCase();
    const needed = Math.ceil(terms.length / 2);

    const scored = candidates
      .map((entry) => {
        const hText = String(entry.headline ?? '').toLowerCase();
        const bText = stripMarkdown(entry.body).toLowerCase();
        const hHits = terms.filter((t) => hText.includes(t)).length;
        const bHits = terms.filter((t) => bText.includes(t)).length;
        const matched = terms.filter((t) => hText.includes(t) || bText.includes(t)).length;
        const score =
          (hHits / terms.length) * HEADLINE_WEIGHT +
          bHits / terms.length +
          (hText.includes(phraseLower) ? HEADLINE_WEIGHT : 0) +
          (bText.includes(phraseLower) ? 1 : 0);
        return { entry, matched, score, hHits, bHits };
      })
      .filter((x) => x.matched >= needed)
      .sort((a, b) => b.score - a.score);

    const total = scored.length;
    const slice = scored.slice((page - 1) * pageSize, page * pageSize);
    const editionDates = await loadEditionDates(slice.map((x) => x.entry));

    const data = slice.map((x) =>
      shape(x.entry, editionDates, terms, {
        score: x.score,
        matchedIn: matchedInLabel(x.hHits > 0, x.bHits > 0),
      })
    );

    return { data, total, engine: 'fallback' };
  };

  /* ------------------------------ public API ------------------------------ */

  return {
    /**
     * @param {{ query: string, startDate?: string, endDate?: string, page?: number, pageSize?: number }} params
     */
    async search(params) {
      const parsed = parseParams(params);

      let result;
      if (isMysql()) {
        try {
          result = await searchFulltext(parsed);
        } catch (err) {
          if (!isMissingFulltextIndex(err)) throw err;
          strapi.log.warn('[story-search] FULLTEXT indexes missing - using $containsi fallback.');
        }
      }
      if (!result) result = await searchContains(parsed);

      return {
        data: result.data,
        meta: {
          engine: result.engine,
          search: {
            query: parsed.phrase,
            terms: parsed.terms,
            startDate: params.startDate || null,
            endDate: params.endDate || null,
          },
          pagination: {
            page: parsed.page,
            pageSize: parsed.pageSize,
            pageCount: Math.ceil(result.total / parsed.pageSize),
            total: result.total,
          },
        },
      };
    },

    /**
     * Idempotent: creates FULLTEXT indexes on stories.headline and stories.body if absent.
     * Call from bootstrap in src/index.js (runs after Strapi's schema sync).
     */
    async ensureFulltextIndexes() {
      if (!isMysql()) {
        strapi.log.info('[story-search] Non-MySQL database - FULLTEXT indexes skipped, fallback search will be used.');
        return;
      }
      const knex = strapi.db.connection;
      const { table, col } = storyColumns();
      try {
        const [rows] = await knex.raw('SHOW INDEX FROM ?? WHERE Index_type = ?', [table, 'FULLTEXT']);
        const existing = new Set(rows.map((r) => r.Column_name));
        for (const attr of ['headline', 'body']) {
          const column = col(attr);
          if (existing.has(column)) continue;
          await knex.raw('ALTER TABLE ?? ADD FULLTEXT INDEX ?? (??)', [table, `${table}_${column}_ft`, column]);
          strapi.log.info(`[story-search] Created FULLTEXT index on ${table}.${column}`);
        }
      } catch (err) {
        strapi.log.error(`[story-search] Could not ensure FULLTEXT indexes: ${err.message}`);
      }
    },
  };
};