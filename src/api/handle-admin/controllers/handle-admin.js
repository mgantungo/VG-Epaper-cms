'use strict';

/**
 * apps/cms/src/api/handle-admin/controllers/handle-admin.js
 *
 * Genuine two-factor login for handle.epapers admins:
 *   1. login (email + password) — the admin's own real password, set at
 *      provisioning time. Wrong password never gets a token emailed.
 *   2. verifyToken (email + alphanumeric code) — only reachable after
 *      step 1 succeeds; the code is the required second factor, not an
 *      alternative to the password.
 *
 * Completely separate identity system from api::epaper-user (readers):
 * own collection, own JWT secret (HANDLE_ADMIN_JWT_SECRET, not the
 * reader-facing JWT_ACCESS_SECRET), own token lifecycle.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const UID = 'api::handle-admin.handle-admin';
const TOKEN_TTL_MINUTES = 15;
const SESSION_TTL = '12h'; // an editorial shift, not a long-lived session — re-login required daily

// Excludes visually ambiguous characters (0/O, 1/I/l) — this gets typed by
// hand from an email, not pasted, so a code that's easy to misread costs a
// real support headache, not just an inconvenience.
const TOKEN_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateAlphanumericToken(length = 8) {
  let token = '';
  for (let i = 0; i < length; i++) {
    token += TOKEN_CHARSET[crypto.randomInt(0, TOKEN_CHARSET.length)];
  }
  return token;
}

function isNewVisionEmail(email) {
  return typeof email === 'string' && /@newvision\.co\.ug$/i.test(email.trim());
}

// A fixed, valid bcrypt hash of an arbitrary, non-real password — verified
// separately (see the delivery notes) to actually parse and compare
// without throwing, so it's genuinely safe to use in the code path below.
// Compared against on a login attempt for an email that doesn't exist, so
// verifying a nonexistent account takes the same time as verifying a
// wrong password for a real one — without this, response timing alone
// reveals which emails are provisioned admins.
const DUMMY_HASH = '$2b$10$lIzdj/IbK/VKIfNe0ox6v.G7VYYi2EFU/OVJtZDCC68oIvWY2ozGm';

module.exports = createCoreController(UID, ({ strapi }) => ({
  // POST /api/handle-admins/login
  // Body: { email, password }
  // Verifies the FIRST factor only. On success, emails the second-factor
  // token and tells the client to proceed to verify-token — it does NOT
  // issue a session by itself.
  async login(ctx) {
    const email = (ctx.request.body?.email || '').trim().toLowerCase();
    const password = ctx.request.body?.password || '';

    if (!isNewVisionEmail(email) || !password) {
      ctx.status = 400;
      ctx.body = { error: 'A @newvision.co.ug email and password are required' };
      return;
    }

    const admin = await strapi.db.query(UID).findOne({ where: { email, active: true } });

    // Always run a bcrypt.compare, even with no matching admin — see
    // DUMMY_HASH above for why.
    const passwordMatches = await bcrypt.compare(password, admin?.passwordHash || DUMMY_HASH);

    if (!admin || !passwordMatches) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid email or password' };
      return;
    }

    const token = generateAlphanumericToken();
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
      strapi.log.error(`[handle-admin.login] password verified but failed to send second-factor email to ${admin.email}:`, err);
      ctx.status = 502;
      ctx.body = { error: 'Password correct, but the login code could not be sent — try again shortly' };
      return;
    }

    ctx.body = { success: true, message: 'A login code has been sent to your email.' };
  },

  // POST /api/handle-admins/verify-token
  // Body: { email, token }
  // Only reachable meaningfully after login() has succeeded and emailed a
  // code — an admin with no pending token (never called login, or the
  // code already expired/was used) gets the same generic failure as a
  // wrong code, not a distinguishing error.
  async verifyToken(ctx) {
    const email = (ctx.request.body?.email || '').trim().toLowerCase();
    const token = (ctx.request.body?.token || '').trim().toUpperCase();

    if (!email || !token) {
      ctx.status = 400;
      ctx.body = { error: 'email and token are required' };
      return;
    }

    const admin = await strapi.db.query(UID).findOne({ where: { email, active: true } });

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