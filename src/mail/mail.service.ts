import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

import { API_PREFIX } from '../bootstrap.js';
import type { SendEmailInput } from './mail.constants.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transporter: Transporter;

  constructor(private readonly config: ConfigService) {
    // No provider-specific default: `EMAIL_FROM` has to be an address the
    // configured SMTP server is willing to relay.
    this.from = this.config.get<string>('EMAIL_FROM', 'no-reply@localhost');

    this.transporter = this.createTransport();
  }

  private createTransport(): Transporter {
    return nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: Number(this.config.get<string>('SMTP_PORT', '465')),
      secure: this.config.get<string>('SMTP_SECURE', 'true') === 'true',
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const link = `${this.baseUrl}/${API_PREFIX}/auth/verify-email?token=${token}`;

    await this.send({
      to: email,
      subject: 'Verify your email',
      html: this.verificationTemplate({
        link,
        email,
      }),
    });
  }

  async sendResetPasswordEmail(email: string, token: string): Promise<void> {
    const link = `${this.baseUrl}/${API_PREFIX}/auth/reset-password?token=${token}`;

    await this.send({
      to: email,
      subject: 'Reset your password',
      html: this.resetTemplate({
        link,
        email,
      }),
    });
  }

  private get baseUrl(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:3000');
  }

  private async send({ to, subject, html }: SendEmailInput): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html,
      });

      this.logger.log(`Email sent to=${to} subject="${subject}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Failed to send email to=${to} subject="${subject}": ${message}`,
      );

      throw new Error(`Failed to send email: ${message}`);
    }
  }

  private verificationTemplate({
    link,
    email,
  }: {
    link: string;
    email: string;
  }): string {
    return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; background:#f4f4f7; margin:0; padding:0;">
    <table
      role="presentation"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="background:#f4f4f7; padding:32px 0;"
    >
      <tr>
        <td align="center">
          <table
            role="presentation"
            width="480"
            cellpadding="0"
            cellspacing="0"
            style="background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e6e6eb;"
          >
            <tr>
              <td style="padding:32px;">
                <h2
                  style="margin:0 0 16px; font-size:20px; color:#1a1a2e;"
                >
                  Verify your email
                </h2>

                <p
                  style="margin:0 0 24px; font-size:15px; color:#4a4a5a; line-height:1.5;"
                >
                  Hi, we received a request to verify the email address for
                  <strong>${email}</strong>.
                  Click the button below to confirm your email.
                </p>

                <a
                  href="${link}"
                  style="display:inline-block; background:#ef4444; color:#ffffff; text-decoration:none; font-size:15px; font-weight:600; padding:12px 24px; border-radius:6px;"
                >
                  Verify email
                </a>

                <p
                  style="margin:24px 0 0; font-size:13px; color:#8a8a9a; line-height:1.5;"
                >
                  This link will expire in 24 hours.
                  If you did not create an account, you can safely ignore this email.
                </p>

                <p
                  style="margin:16px 0 0; font-size:13px; color:#8a8a9a;"
                >
                  Or paste this link into your browser:<br/>
                  <span style="color:#4a4a5a;">${link}</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private resetTemplate({
    link,
    email,
  }: {
    link: string;
    email: string;
  }): string {
    return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; background:#f4f4f7; margin:0; padding:0;">
    <table
      role="presentation"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="background:#f4f4f7; padding:32px 0;"
    >
      <tr>
        <td align="center">
          <table
            role="presentation"
            width="480"
            cellpadding="0"
            cellspacing="0"
            style="background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e6e6eb;"
          >
            <tr>
              <td style="padding:32px;">
                <h2
                  style="margin:0 0 16px; font-size:20px; color:#1a1a2e;"
                >
                  Reset your password
                </h2>

                <p
                  style="margin:0 0 24px; font-size:15px; color:#4a4a5a; line-height:1.5;"
                >
                  Hi, we received a request to reset the password for
                  <strong>${email}</strong>.
                  Click the button below to choose a new password.
                </p>

                <a
                  href="${link}"
                  style="display:inline-block; background:#ef4444; color:#ffffff; text-decoration:none; font-size:15px; font-weight:600; padding:12px 24px; border-radius:6px;"
                >
                  Reset password
                </a>

                <p
                  style="margin:24px 0 0; font-size:13px; color:#8a8a9a; line-height:1.5;"
                >
                  This link will expire in 1 hour.
                  If you did not request a password reset, you can safely ignore this email.
                </p>

                <p
                  style="margin:16px 0 0; font-size:13px; color:#8a8a9a;"
                >
                  Or paste this link into your browser:<br/>
                  <span style="color:#4a4a5a;">${link}</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }
}
