export const MAIL_CLIENT = Symbol('MAIL_CLIENT');

export interface MailClient {
  emails: {
    send: (payload: {
      from: string;
      to: string;
      subject: string;
      html: string;
    }) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}
