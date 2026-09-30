import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { EMERGENCY_FOOTER, type EmailContent } from './copy';

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Wrap template content with the required footer, as plain text plus simple HTML. */
export function renderEmail(to: string[], content: EmailContent, dashboardUrl: string): OutgoingEmail {
  const text = `${content.text}\n\nOpen your dashboard: ${dashboardUrl}\n\n${EMERGENCY_FOOTER}\n`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:18px;line-height:1.5;color:#1a1a1a">
<p>${escapeHtml(content.text)}</p>
<p><a href="${escapeHtml(dashboardUrl)}">Open your Care Circle dashboard</a></p>
<hr><p style="font-size:14px;color:#555">${escapeHtml(EMERGENCY_FOOTER)}</p>
</body></html>`;
  return { to, subject: content.subject, text, html };
}

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: email.to, subject: email.subject, text: email.text, html: email.html });
  }
}

export class SesMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly client = new SESv2Client({}),
  ) {}

  async send(email: OutgoingEmail): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: email.to },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  }
}

/** Collects emails in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly outbox: OutgoingEmail[] = [];
  failNext = 0;

  async send(email: OutgoingEmail): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated mail failure');
    }
    this.outbox.push(email);
  }
}
