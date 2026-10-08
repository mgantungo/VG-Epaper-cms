'use strict';

/**
 * apps/cms/src/services/handle-admin-email.js
 *
 * Adapted directly from VGDashboardCMS's own email-service.js (a proven,
 * working token-email sender already in production for a different
 * system) — same transporter configuration, same overall shape. Changed:
 * content specific to the E-Paper Handle app rather than "New Vision
 * Editor", and the credentials moved to environment variables rather than
 * being hardcoded in the file — the original had the real SMTP password
 * committed directly in source, which is worth not repeating here even
 * though it's the same mailbox.
 *
 * Required env vars (apps/cms/.env):
 *   HANDLE_EMAIL_SMTP_USER=notifications@visiongroup.co.ug
 *   HANDLE_EMAIL_SMTP_PASS=<the real password>
 */

const nodemailer = require('nodemailer');

class HandleAdminEmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    this.transporter = nodemailer.createTransport({
      host: 'smtp-mail.outlook.com',
      port: 587,
      secure: false, // true for 465, false for other ports
      requireTLS: true,
      auth: {
        user: process.env.HANDLE_EMAIL_SMTP_USER,
        pass: process.env.HANDLE_EMAIL_SMTP_PASS
      },
      logger: false,
      debug: false
    });

    this.transporter.verify()
      .then(() => {
        strapi.log.info('[handle-admin-email] transporter is ready');
      })
      .catch((error) => {
        strapi.log.error('[handle-admin-email] transporter failed to initialize:', error);
      });
  }

  async sendLoginToken(toEmail, token, displayName) {
    const mailOptions = {
      from: { name: 'New Vision E-Paper Admin', address: process.env.HANDLE_EMAIL_SMTP_USER },
      to: toEmail,
      replyTo: process.env.HANDLE_EMAIL_SMTP_USER,
      subject: 'Your E-Paper Admin Login Code',
      html: this.tokenEmailHtml(displayName, token),
      text: this.tokenEmailText(displayName, token),
      headers: {
        'Precedence': 'bulk',
        'List-Unsubscribe': `<mailto:${process.env.HANDLE_EMAIL_SMTP_USER}>`,
        'X-Mailer': ' '
      }
    };

    try {
      strapi.log.info(`[handle-admin-email] sending login token to ${toEmail}`);
      const result = await this.transporter.sendMail(mailOptions);
      strapi.log.info(`[handle-admin-email] sent to ${toEmail}, messageId: ${result.messageId}`);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      strapi.log.error('[handle-admin-email] failed to send login token:', error);
      throw new Error(`Email sending failed: ${error.message}`);
    }
  }

  tokenEmailHtml(displayName, token) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>E-Paper Admin Login Code</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: #1a1a1a; padding: 30px; text-align: center; color: white; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
        .content { padding: 40px; }
        .token-display { background: #f8f9fa; border: 2px dashed #dee2e6; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0; font-family: 'Courier New', monospace; }
        .token-code { font-size: 32px; font-weight: bold; color: #1a1a1a; letter-spacing: 8px; margin: 10px 0; }
        .expiry-notice { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 4px; padding: 12px; margin: 20px 0; font-size: 14px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #6c757d; border-top: 1px solid #dee2e6; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>New Vision E-Paper Admin</h1></div>
        <div class="content">
            <h2>Login Code</h2>
            <p>Hello ${displayName || 'there'},</p>
            <p>Use this code to sign in to the E-Paper admin dashboard:</p>
            <div class="token-display">
                <div class="token-code">${token}</div>
                <p style="margin:0;color:#6c757d;">Enter this code to complete login</p>
            </div>
            <div class="expiry-notice"><strong>⚠️ This code expires in 15 minutes.</strong></div>
            <p>If you didn't request this, you can ignore this email — no login will happen without the code above.</p>
            <p>New Vision E-Paper</p>
        </div>
        <div class="footer">
            <p>This is an automated message. Please do not reply.</p>
            <p>Vision Group &copy; ${new Date().getFullYear()}</p>
        </div>
    </div>
</body>
</html>`;
  }

  tokenEmailText(displayName, token) {
    return `NEW VISION E-PAPER ADMIN — LOGIN CODE

Hello ${displayName || 'there'},

Use this code to sign in to the E-Paper admin dashboard:

CODE: ${token}

This code expires in 15 minutes.

If you didn't request this, you can ignore this email.

New Vision E-Paper
---
This is an automated message. Please do not reply.
Vision Group © ${new Date().getFullYear()}`;
  }
}

module.exports = new HandleAdminEmailService();