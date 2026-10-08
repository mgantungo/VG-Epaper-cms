'use strict';

/**
 * apps/cms/scripts/backfill-org-management.js
 * Phase 1 file, UPDATED in Phase 2 (an org row with a transaction counts as org_contract)
 *
 * Fills the new fields on rows that existed before the schema change.
 * Strapi adds new columns as NULL on existing rows; it does not apply
 * schema defaults retroactively.
 *
 *   epaper-organization  status        <- from `active`   (null active counts as true)
 *   epaper-org-seat      status        <- from `active`
 *                        role          <- 'admin' if the seat's user is the org's owner, else 'member'
 *                        source        <- 'legacy'
 *   epaper-entitlement   scope         <- org+transaction or org+no user: org_contract | org+user: org_member | else: personal
 *                        grantSource   <- 'purchase' when linked to a transaction
 *   epaper-user          accountSource <- 'self_registered'
 *   handle-admin         canManageEditions=true, canManageOrganizations=false, isSuperAdmin=false
 *
 * It is idempotent: it only touches rows where the new field is still NULL,
 * so it is safe to run twice. Nothing existing is changed, only filled in.
 *
 * Usage (from apps/cms, AFTER deploying the new schemas and restarting
 * Strapi once so the columns exist):
 *   node scripts/backfill-org-management.js            # dry run: reports counts only
 *   node scripts/backfill-org-management.js --apply    # writes
 *
 * This boots Strapi in-process without starting the HTTP server, so the
 * pm2 instance can stay up while it runs.
 */

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const APPLY = process.argv.includes('--apply');

const ORG = 'api::epaper-organization.epaper-organization';
const SEAT = 'api::epaper-org-seat.epaper-org-seat';
const ENT = 'api::epaper-entitlement.epaper-entitlement';
const USER = 'api::epaper-user.epaper-user';
const HADMIN = 'api::handle-admin.handle-admin';

async function backfillOrganizations(strapi) {
  const rows = await strapi.db.query(ORG).findMany({
    where: { status: { $null: true } },
    select: ['id', 'active']
  });
  for (const row of rows) {
    if (APPLY) {
      await strapi.db.query(ORG).update({
        where: { id: row.id },
        data: { status: row.active === false ? 'suspended' : 'active' }
      });
    }
  }
  return rows.length;
}

async function backfillSeats(strapi) {
  const rows = await strapi.db.query(SEAT).findMany({
    where: { $or: [{ status: { $null: true } }, { role: { $null: true } }, { source: { $null: true } }] },
    select: ['id', 'active', 'status', 'role', 'source'],
    populate: { user: { select: ['id'] }, organization: { select: ['id'], populate: { owner: { select: ['id'] } } } }
  });
  for (const row of rows) {
    const data = {};
    if (!row.status) data.status = row.active === false ? 'suspended' : 'active';
    if (!row.role) {
      const ownerId = row.organization?.owner?.id;
      data.role = ownerId && row.user?.id === ownerId ? 'admin' : 'member';
    }
    if (!row.source) data.source = 'legacy';
    if (APPLY) await strapi.db.query(SEAT).update({ where: { id: row.id }, data });
  }
  return rows.length;
}

async function backfillEntitlements(strapi) {
  const rows = await strapi.db.query(ENT).findMany({
    where: { $or: [{ scope: { $null: true } }, { grantSource: { $null: true } }] },
    select: ['id', 'scope', 'grantSource'],
    populate: { user: { select: ['id'] }, organization: { select: ['id'] }, transaction: { select: ['id'] } }
  });
  const counts = { changed: 0, personal: 0, org_contract: 0, org_member: 0 };
  for (const row of rows) {
    const data = {};
    if (!row.scope) {
      data.scope = row.organization ? (row.transaction || !row.user ? 'org_contract' : 'org_member') : 'personal';
      counts[data.scope]++;
    }
    if (!row.grantSource && row.transaction) data.grantSource = 'purchase';
    if (!Object.keys(data).length) continue; // grantSource legitimately stays empty without a transaction
    counts.changed++;
    if (APPLY) await strapi.db.query(ENT).update({ where: { id: row.id }, data });
  }
  return counts;
}

async function backfillUsers(strapi) {
  const where = { accountSource: { $null: true } };
  const count = await strapi.db.query(USER).count({ where });
  if (APPLY && count) {
    await strapi.db.query(USER).updateMany({ where, data: { accountSource: 'self_registered' } });
  }
  return count;
}

async function backfillHandleAdmins(strapi) {
  const q = strapi.db.query(HADMIN);
  const res = {
    canManageEditions: await q.count({ where: { canManageEditions: { $null: true } } }),
    canManageOrganizations: await q.count({ where: { canManageOrganizations: { $null: true } } }),
    isSuperAdmin: await q.count({ where: { isSuperAdmin: { $null: true } } })
  };
  if (APPLY) {
    await q.updateMany({ where: { canManageEditions: { $null: true } }, data: { canManageEditions: true } });
    await q.updateMany({ where: { canManageOrganizations: { $null: true } }, data: { canManageOrganizations: false } });
    await q.updateMany({ where: { isSuperAdmin: { $null: true } }, data: { isSuperAdmin: false } });
  }
  return res;
}

async function main() {
  const appContext = await compileStrapi();
  const strapi = await createStrapi(appContext).load();
  strapi.log.level = 'error';

  console.log(APPLY ? '== APPLYING backfill ==' : '== DRY RUN (pass --apply to write) ==');
  try {
    console.log('organizations   :', await backfillOrganizations(strapi));
    console.log('org seats       :', await backfillSeats(strapi));
    console.log('entitlements    :', await backfillEntitlements(strapi));
    console.log('epaper users    :', await backfillUsers(strapi));
    console.log('handle admins   :', await backfillHandleAdmins(strapi));
    console.log(APPLY ? 'Done.' : 'Dry run complete — nothing written.');
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  } finally {
    await strapi.destroy();
  }
}

main();