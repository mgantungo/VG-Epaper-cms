'use strict';

/**
 * apps/cms/src/api/handle-admin/controllers/handle-admin.js
 *
 * Two-step, passwordless login for handle.epapers admins — no password at
 * all, every login requires a fresh emailed code. Completely separate
 * identity system from api::epaper-user (readers): own collection, own
 * JWT secret (HANDLE_ADMIN_JWT_SECRET, not the reader-facing
 * JWT_ACCESS_SECRET), own token lifecycle. Nothing here should ever be
 * reachable by a reader's session, and vice versa.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const UID = 'api::handle-admin.handle-admin';
const TOKEN_TTL_MINUTES = 15;
const SESSION_TTL = '12h'; // an editorial shift, not a long-lived session — re-login required daily

function generateNumericToken() {
  // 6 digits, zero-padded — crypto.randomInt is CSPRNG-backed, unlike Math.random.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function isNewVisionEmail(email) {
  return typeof email === 'string' && /@newvision\.co\.ug$/i.test(email.trim());
}

module.exports = createCoreController(UID, ({ strapi }) => ({
  // POST /api/handle-admins/request-token
  // Body: { email }
  // Always responds the same way regardless of whether the email
  // corresponds to a real, active admin — same reasoning as
  // epaper-user's own login: a response that differs based on account
  // existence lets an attacker enumerate valid admin emails one guess at
  // a time. The real work only happens silently, inside this branch.
  async requestToken(ctx) {
    const email = (ctx.request.body?.email || '').trim().toLowerCase();

    if (!isNewVisionEmail(email)) {
      ctx.status = 400;
      ctx.body = { error: 'A @newvision.co.ug email address is required' };
      return;
    }

    const admin = await strapi.db.query(UID).findOne({ where: { email, active: true } });

    if (admin) {
      const token = generateNumericToken();
      const tokenHash = await bcrypt.hash(token, 10);
      const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

      await strapi.db.query(UID).update({
        where: { id: admin.id },
        data: { tokenHash, tokenExpiresAt }
      });

      try {
        const emailService = require('../../../services/handle-admin-email.js');
        await emailService.sendLoginToken(admin.email, token, admin.displayName);
      } catch (err) {
        // Logged, not surfaced to the client — same "don't reveal whether
        // the account exists" reasoning applies to send failures too.
        strapi.log.error(`[handle-admin.requestToken] failed to send login email to ${admin.email}:`, err);
      }
    }

    ctx.body = { success: true, message: 'If that email is a registered admin, a login code has been sent.' };
  },

  // POST /api/handle-admins/verify-token
  // Body: { email, token }
  async verifyToken(ctx) {
    const email = (ctx.request.body?.email || '').trim().toLowerCase();
    const token = (ctx.request.body?.token || '').trim();

    if (!email || !token) {
      ctx.status = 400;
      ctx.body = { error: 'email and token are required' };
      return;
    }

    const admin = await strapi.db.query(UID).findOne({ where: { email, active: true } });

    // Constant-shape failure regardless of which check actually failed
    // (no account, no pending token, expired, wrong code) — same
    // enumeration-prevention reasoning as requestToken above.
    const genericError = () => {
      ctx.status = 401;
      ctx.body = { error: 'Invalid or expired code' };
    };

    if (!admin || !admin.tokenHash || !admin.tokenExpiresAt) return genericError();
    if (new Date(admin.tokenExpiresAt) < new Date()) return genericError();

    const matches = await bcrypt.compare(token, admin.tokenHash);
    if (!matches) return genericError();

    const newTokenVersion = (admin.tokenVersion || 0) + 1;
    const updated = await strapi.db.query(UID).update({
      where: { id: admin.id },
      data: {
        tokenHash: null,
        tokenExpiresAt: null,
        tokenVersion: newTokenVersion,
        lastLoginAt: new Date()
      }
    });

    const jwtToken = jwt.sign(
      { sub: updated.id, email: updated.email, tokenVersion: newTokenVersion, type: 'handle-admin' },
      process.env.HANDLE_ADMIN_JWT_SECRET,
      { expiresIn: SESSION_TTL }
    );

    ctx.body = {
      jwt: jwtToken,
      admin: { id: updated.id, email: updated.email, displayName: updated.displayName }
    };
  }
}));