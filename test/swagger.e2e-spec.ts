
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { hash } from 'bcryptjs';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { JwtStrategy } from '../src/auth/jwt.strategy.js';
import { MailService } from '../src/mail/mail.service.js';
import { UserService } from '../src/user/user.service.js';
import { setupSwagger } from '../src/swagger.setup.js';

interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        responses?: Record<string, unknown>;
        requestBody?: {
          content?: Record<
            string,
            {
              schema?: {
                $ref?: string;
              };
            }
          >;
        };
      }
    >
  >;
  components: {
    schemas: Record<string, unknown>;
  };
}

interface FakeUser {
  id: string;
  organizationId: string | null;
  email: string;
  name: string | null;
  status: string | null;
  passwordHash: string;
  isVerified: boolean;
  verificationToken: string | null;
  verificationTokenExpires: Date | null;
  resetToken: string | null;
  resetTokenExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
  toResponse(): Omit<
    FakeUser,
    | 'passwordHash'
    | 'verificationToken'
    | 'verificationTokenExpires'
    | 'resetToken'
    | 'resetTokenExpires'
  >;
}

class InMemoryUserService {
  private users: FakeUser[] = [];
  private nextId = 1;

  async findByEmail(email: string): Promise<FakeUser | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }

  async findById(id: string): Promise<FakeUser | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }

  async create(
    email: string,
    password: string,
    name?: string,
  ): Promise<FakeUser> {
    const user = this.makeUser({
      id: `user-${this.nextId++}`,
      email,
      name: name ?? null,
      passwordHash: await hash(password, 10),
    });

    this.users.push(user);

    return user;
  }

  async findByVerificationToken(
    token: string,
  ): Promise<FakeUser | null> {
    return (
      this.users.find((u) => u.verificationToken === token) ?? null
    );
  }

  async findByResetToken(token: string): Promise<FakeUser | null> {
    return this.users.find((u) => u.resetToken === token) ?? null;
  }

  async setVerificationToken(
    userId: string,
    token: string,
    expires: Date,
  ): Promise<void> {
    this.patch(userId, {
      verificationToken: token,
      verificationTokenExpires: expires,
    });
  }

  async markVerified(userId: string): Promise<void> {
    this.patch(userId, {
      isVerified: true,
      verificationToken: null,
      verificationTokenExpires: null,
    });
  }

  async setResetToken(
    userId: string,
    token: string,
    expires: Date,
  ): Promise<void> {
    this.patch(userId, {
      resetToken: token,
      resetTokenExpires: expires,
    });
  }

  async updatePassword(
    userId: string,
    password: string,
  ): Promise<void> {
    this.patch(userId, {
      passwordHash: await hash(password, 10),
      resetToken: null,
      resetTokenExpires: null,
    });
  }

  async updateProfile(
    userId: string,
    fields: {
      name?: string;
      email?: string;
      status?: string;
      passwordHash?: string;
      isVerified?: boolean;
      verificationToken?: string | null;
      verificationTokenExpires?: Date | null;
    },
  ): Promise<FakeUser | null> {
    const user = this.users.find((u) => u.id === userId) ?? null;
    if (!user) {
      return null;
    }
    if (fields.name !== undefined) {
      user.name = fields.name;
    }
    if (fields.email !== undefined) {
      user.email = fields.email;
    }
    if (fields.status !== undefined) {
      user.status = fields.status;
    }
    if (fields.passwordHash !== undefined) {
      user.passwordHash = fields.passwordHash;
    }
    if (fields.isVerified !== undefined) {
      user.isVerified = fields.isVerified;
    }
    if (fields.verificationToken !== undefined) {
      user.verificationToken = fields.verificationToken;
    }
    if (fields.verificationTokenExpires !== undefined) {
      user.verificationTokenExpires = fields.verificationTokenExpires;
    }
    return user;
  }

  private makeUser(overrides: Partial<FakeUser>): FakeUser {
    const user: FakeUser = {
      id: 'user-0',
      organizationId: null,
      email: '',
      name: null,
      status: 'active',
      passwordHash: '',
      isVerified: false,
      verificationToken: null,
      verificationTokenExpires: null,
      resetToken: null,
      resetTokenExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),

      toResponse() {
        const {
          passwordHash: _passwordHash,
          verificationToken: _verificationToken,
          verificationTokenExpires: _verificationTokenExpires,
          resetToken: _resetToken,
          resetTokenExpires: _resetTokenExpires,
          ...rest
        } = user;

        return rest;
      },

      ...overrides,
    };

    return user;
  }

  private patch(
    userId: string,
    fields: Partial<FakeUser>,
  ): void {
    const user = this.users.find((u) => u.id === userId);

    if (user) {
      Object.assign(user, fields);
    }
  }
}

const endpointDocumentation = [
  {
    path: '/auth/register',
    method: 'post',
    documentedStatus: ['201', '409'],
  },
  {
    path: '/auth/login',
    method: 'post',
    documentedStatus: ['201', '401', '403'],
  },
  {
    path: '/auth/verify-email',
    method: 'get',
    documentedStatus: ['200', '400'],
  },
  {
    path: '/auth/forgot-password',
    method: 'post',
    documentedStatus: ['201'],
  },
  {
    path: '/auth/reset-password',
    method: 'post',
    documentedStatus: ['201', '400'],
  },
  {
    path: '/auth/profile',
    method: 'get',
    documentedStatus: ['200', '401'],
  },
  {
    path: '/auth/profile',
    method: 'patch',
    documentedStatus: ['200', '400', '401', '409'],
  },
] as const;

describe('Swagger documentation (e2e)', () => {
  let app: INestApplication;

  let server: ReturnType<INestApplication['getHttpServer']>;

  const mailTokens: {
    verify?: string;
    reset?: string;
  } = {};

  const userService = new InMemoryUserService();

  const registerUser = async (
    email: string,
    password = 'password123',
    name?: string,
  ) => {
    return request(server)
      .post('/auth/register')
      .send({
        email,
        password,
        ...(name ? { name } : {}),
      })
      .expect(201);
  };

  const registerVerified = async (
    email: string,
    password = 'password123',
    name?: string,
  ) => {
    await registerUser(email, password, name);

    const { verify } = mailTokens;

    expect(verify).toBeDefined();

    await request(server)
      .get('/auth/verify-email')
      .query({ token: verify })
      .expect(200);

    const loginRes = await request(server)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);

    return { access_token: loginRes.body.access_token as string };
  };

  beforeEach(async () => {
    mailTokens.verify = undefined;
    mailTokens.reset = undefined;

    const moduleFixture: TestingModule =
      await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
          }),

          PassportModule.register({
            defaultStrategy: 'jwt',
          }),

          JwtModule.registerAsync({
            imports: [ConfigModule],

            useFactory: (config: ConfigService) => ({
              secret: config.get<string>(
                'JWT_SECRET',
                'fallback-secret',
              ),

              signOptions: {
                expiresIn: Number(
                  config.get<string>(
                    'JWT_EXPIRATION',
                    '3600',
                  ),
                ),
              },
            }),

            inject: [ConfigService],
          }),
        ],

        controllers: [AuthController],

        providers: [
          AuthService,

          JwtStrategy,

          {
            provide: UserService,
            useValue: userService,
          },

          {
            provide: MailService,
            useValue: {
              sendVerificationEmail: async (
                _email: string,
                token: string,
              ) => {
                mailTokens.verify = token;
              },

              sendResetPasswordEmail: async (
                _email: string,
                token: string,
              ) => {
                mailTokens.reset = token;
              },
            },
          },
        ],
      }).compile();

    app = moduleFixture.createNestApplication();

    setupSwagger(app);

    await app.init();

    server = app.getHttpServer();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('OpenAPI document', () => {
    it('exposes the document as JSON on /api-json', async () => {
      const res = await request(server)
        .get('/api-json')
        .expect(200);

      const doc = res.body as OpenApiDocument;

      expect(res.headers['content-type']).toContain(
        'application/json',
      );

      expect(doc.info.title).toBe('OPS API');

      expect(doc.openapi).toBeDefined();
    });

    it('does not expose the document as YAML', async () => {
      await request(server)
        .get('/api-yaml')
        .expect(404);
    });

    it('documents every auth endpoint', async () => {
      const res = await request(server)
        .get('/api-json')
        .expect(200);

      const doc = res.body as OpenApiDocument;

      for (const { path, method } of endpointDocumentation) {
        expect(doc.paths[path]).toBeDefined();

        expect(doc.paths[path][method]).toBeDefined();
      }
    });

    it('documents the exact status codes each endpoint returns', async () => {
      const res = await request(server)
        .get('/api-json')
        .expect(200);

      const doc = res.body as OpenApiDocument;

      for (const {
        path,
        method,
        documentedStatus,
      } of endpointDocumentation) {
        const responses =
          doc.paths[path][method].responses ?? {};

        expect(Object.keys(responses).sort()).toEqual(
          [...documentedStatus].sort(),
        );
      }
    });

    it('documents request payloads and response schemas', async () => {
      const res = await request(server)
        .get('/api-json')
        .expect(200);

      const doc = res.body as OpenApiDocument;

      const schemas = doc.components.schemas;

      const registerBody =
        doc.paths['/auth/register']
          .post
          .requestBody
          ?.content
          ?.['application/json']
          ?.schema;

      expect(registerBody?.$ref).toContain(
        'RegisterDto',
      );

      for (const model of [
        'RegisterDto',
        'LoginDto',
        'ForgotPasswordDto',
        'ResetPasswordDto',
        'UpdateProfileDto',
        'UserResponseDto',
        'RegisterResponseDto',
        'LoginResponseDto',
        'MessageResponseDto',
      ]) {
        expect(schemas[model]).toBeDefined();
      }
    });
  });

  describe('POST /auth/register', () => {
    it('returns 201 with a message and the documented user shape, no token', async () => {
      const res = await registerUser(
        'alice@example.com',
        'password123',
        'Alice',
      );

      expect(
        typeof res.body.message,
      ).toBe('string');

      expect(res.body.user).toEqual(
        expect.objectContaining({
          email: 'alice@example.com',
          name: 'Alice',
        }),
      );

      expect(
        res.body.access_token,
      ).toBeUndefined();

      expect(
        res.body.user.passwordHash,
      ).toBeUndefined();
    });

    it('returns 409 when the email is already registered', async () => {
      await registerUser('dupe@example.com');

      await request(server)
        .post('/auth/register')
        .send({
          email: 'dupe@example.com',
          password: 'password123',
        })
        .expect(409);
    });
  });

  describe('POST /auth/login', () => {
    it('returns 201 with a JWT once the email is verified', async () => {
      await registerUser('bob@example.com');

      const { verify } = mailTokens;

      expect(verify).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: verify })
        .expect(200);

      const res = await request(server)
        .post('/auth/login')
        .send({
          email: 'bob@example.com',
          password: 'password123',
        })
        .expect(201);

      expect(
        typeof res.body.access_token,
      ).toBe('string');
    });

    it('returns 403 for an unverified email and sends a fresh verification link', async () => {
      await registerUser('frank@example.com');

      const first = mailTokens.verify;

      expect(first).toBeDefined();

      await request(server)
        .post('/auth/login')
        .send({
          email: 'frank@example.com',
          password: 'password123',
        })
        .expect(403);

      const second = mailTokens.verify;

      expect(second).toBeDefined();
      expect(second).not.toBe(first);

      await request(server)
        .get('/auth/verify-email')
        .query({ token: second })
        .expect(200);

      await request(server)
        .post('/auth/login')
        .send({
          email: 'frank@example.com',
          password: 'password123',
        })
        .expect(201);
    });

    it('returns 401 for invalid credentials', async () => {
      await registerUser('carol@example.com');

      await request(server)
        .post('/auth/login')
        .send({
          email: 'carol@example.com',
          password: 'wrong-password',
        })
        .expect(401);
    });
  });

  describe('GET /auth/verify-email', () => {
    it('returns 200 with a success message for a valid token', async () => {
      await registerUser('dave@example.com');

      const { verify } = mailTokens;

      expect(verify).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: verify })
        .expect(200)
        .expect({
          message: 'Email verified successfully',
        });
    });

    it('returns 400 when a consumed token is reused', async () => {
      await registerUser('dave2@example.com');

      const { verify } = mailTokens;

      expect(verify).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: verify })
        .expect(200)
        .expect({
          message: 'Email verified successfully',
        });

      await request(server)
        .get('/auth/verify-email')
        .query({ token: verify })
        .expect(400);
    });

    it('does not reissue a verification email once the account is verified', async () => {
      await registerUser('erin@example.com');

      const first = mailTokens.verify;

      expect(first).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: first })
        .expect(200)
        .expect({
          message: 'Email verified successfully',
        });

      await request(server)
        .post('/auth/login')
        .send({
          email: 'erin@example.com',
          password: 'password123',
        })
        .expect(201);

      expect(mailTokens.verify).toBe(first);
    });

    it('returns 400 for an invalid token', async () => {
      await request(server)
        .get('/auth/verify-email')
        .query({
          token: 'not-a-real-token',
        })
        .expect(400);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('returns 201 with a generic message', async () => {
      const res = await request(server)
        .post('/auth/forgot-password')
        .send({
          email: 'ghost@example.com',
        })
        .expect(201);

      expect(res.body).toEqual({
        message:
          'If an account with that email exists, a reset link was sent',
      });
    });
  });

  describe('POST /auth/reset-password', () => {
    it('returns 201 and allows login with the new password', async () => {
      await registerUser('nora@example.com');

      const { verify } = mailTokens;

      expect(verify).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: verify })
        .expect(200)
        .expect({
          message: 'Email verified successfully',
        });

      await request(server)
        .post('/auth/forgot-password')
        .send({
          email: 'nora@example.com',
        })
        .expect(201);

      const { reset } = mailTokens;

      expect(reset).toBeDefined();

      await request(server)
        .post('/auth/reset-password')
        .send({
          token: reset,
          password: 'newPassword123!',
        })
        .expect(201)
        .expect({
          message: 'Password reset successfully',
        });

      await request(server)
        .post('/auth/login')
        .send({
          email: 'nora@example.com',
          password: 'password123',
        })
        .expect(401);

      await request(server)
        .post('/auth/login')
        .send({
          email: 'nora@example.com',
          password: 'newPassword123!',
        })
        .expect(201);
    });

    it('returns 400 for an invalid token', async () => {
      await request(server)
        .post('/auth/reset-password')
        .send({
          token: 'not-a-real-token',
          password: 'newPassword123!',
        })
        .expect(400);
    });
  });

  describe('GET /auth/profile', () => {
    it('returns 401 without a bearer token', async () => {
      await request(server)
        .get('/auth/profile')
        .expect(401);
    });

    it('returns 200 with the current user for a valid JWT from a verified account', async () => {
      const { access_token } = await registerVerified(
        'sam@example.com',
        'password123',
        'Sam',
      );

      const res = await request(server)
        .get('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${access_token}`,
        )
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          email: 'sam@example.com',
          name: 'Sam',
        }),
      );

      expect(
        res.body.passwordHash,
      ).toBeUndefined();
    });

    it('rejects a JWT issued to an unverified account', async () => {
      const res = await registerUser('pat@example.com');

      expect(res.body.access_token).toBeUndefined();

      const userId = res.body.user.id as string;

      const token = app
        .get(JwtService)
        .sign({ sub: userId, email: 'pat@example.com' });

      await request(server)
        .get('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${token}`,
        )
        .expect(401);

      await request(server)
        .get('/auth/verify-email')
        .query({ token: mailTokens.verify })
        .expect(200);

      await request(server)
        .get('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${token}`,
        )
        .expect(200);
    });
  });

  describe('PATCH /auth/profile', () => {
    it('returns 401 without a bearer token', async () => {
      await request(server)
        .patch('/auth/profile')
        .send({ name: 'X' })
        .expect(401);
    });

    it('returns 200 and updates the profile', async () => {
      const { access_token } = await registerVerified(
        'mallory@example.com',
        'password123',
        'Mallory',
      );

      const res = await request(server)
        .patch('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${access_token}`,
        )
        .send({ name: 'Mal' })
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          email: 'mallory@example.com',
          name: 'Mal',
        }),
      );
    });

    it('changing the email resets verification and requires re-verification before login', async () => {
      await registerUser(
        'nick@example.com',
        'password123',
      );

      const first = mailTokens.verify;

      expect(first).toBeDefined();

      await request(server)
        .get('/auth/verify-email')
        .query({ token: first })
        .expect(200);

      const loginRes = await request(server)
        .post('/auth/login')
        .send({
          email: 'nick@example.com',
          password: 'password123',
        })
        .expect(201);

      const { access_token } = loginRes.body;

      const patched = await request(server)
        .patch('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${access_token}`,
        )
        .send({ email: 'nick-new@example.com' })
        .expect(200);

      expect(patched.body.email).toBe(
        'nick-new@example.com',
      );
      expect(patched.body.isVerified).toBe(false);

      const fresh = mailTokens.verify;

      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(first);

      await request(server)
        .post('/auth/login')
        .send({
          email: 'nick-new@example.com',
          password: 'password123',
        })
        .expect(403);

      const reissued = mailTokens.verify;

      expect(reissued).toBeDefined();
      expect(reissued).not.toBe(fresh);

      await request(server)
        .get('/auth/verify-email')
        .query({ token: reissued })
        .expect(200);

      await request(server)
        .post('/auth/login')
        .send({
          email: 'nick-new@example.com',
          password: 'password123',
        })
        .expect(201);
    });

    it('returns 409 when the new email is already registered', async () => {
      await registerUser('olivia@example.com');

      const { access_token } = await registerVerified(
        'oscar@example.com',
        'password123',
      );

      await request(server)
        .patch('/auth/profile')
        .set(
          'Authorization',
          `Bearer ${access_token}`,
        )
        .send({ email: 'olivia@example.com' })
        .expect(409);
    });
  });
});



