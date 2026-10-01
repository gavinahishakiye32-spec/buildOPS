
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
} from '@jest/globals';

const mockCreateTransport = jest.fn();

jest.unstable_mockModule('nodemailer', () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

const { MailService } = await import('./mail.service.js');

describe('MailService', () => {
  let mailService: InstanceType<typeof MailService>;
  let config: any;
  let mockSendMail: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockSendMail = jest.fn(async () => ({
      messageId: 'test-message-id',
    }));

    mockCreateTransport.mockReturnValue({
      sendMail: mockSendMail,
    });

    config = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'EMAIL_FROM':
            return 'ops-app <onboarding@resend.dev>';

          case 'APP_BASE_URL':
            return 'http://localhost:3000';

          case 'SMTP_HOST':
            return 'smtp.gmail.com';

          case 'SMTP_PORT':
            return '465';

          case 'SMTP_SECURE':
            return 'true';

          case 'SMTP_USER':
            return 'test@gmail.com';

          case 'SMTP_PASSWORD':
            return 'test-password';

          default:
            return '';
        }
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MailService,
        {
          provide: ConfigService,
          useValue: config,
        },
      ],
    }).compile();

    mailService = moduleRef.get(MailService);
  });

  it('sends a verification email via Nodemailer', async () => {
    await mailService.sendVerificationEmail(
      'user@example.com',
      'token-abc',
    );

    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const payload = mockSendMail.mock.calls[0][0] as {
      to: string;
      from: string;
      subject: string;
      html: string;
    };

    expect(payload.to).toBe('user@example.com');

    expect(payload.from).toBe(
      'ops-app <onboarding@resend.dev>',
    );

    expect(payload.subject).toBe('Verify your email');

    expect(payload.html).toContain(
      'http://localhost:3000/auth/verify-email?token=token-abc',
    );

    expect(payload.html).toContain('Verify your email');
  });

  it('sends a reset password email via Nodemailer', async () => {
    await mailService.sendResetPasswordEmail(
      'user@example.com',
      'token-abc',
    );

    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const payload = mockSendMail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
    };

    expect(payload.to).toBe('user@example.com');

    expect(payload.subject).toBe('Reset your password');

    expect(payload.html).toContain(
      'http://localhost:3000/auth/reset-password?token=token-abc',
    );
  });

  it('throws when Nodemailer fails to send an email', async () => {
    mockSendMail.mockRejectedValue(
      new Error('SMTP connection failed'),
    );

    await expect(
      mailService.sendVerificationEmail(
        'user@example.com',
        'token-abc',
      ),
    ).rejects.toThrow(
      'Failed to send email: SMTP connection failed',
    );
  });
});

