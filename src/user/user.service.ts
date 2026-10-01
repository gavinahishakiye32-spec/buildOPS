import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hash } from 'bcryptjs';
import { User } from './user.entity.js';
import { normalizeEmail } from '../common/email.js';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Lookups normalise the address so casing/whitespace never duplicates a user. */
  async findByEmail(email: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { email: normalizeEmail(email) } });
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async create(email: string, password: string, name?: string): Promise<User> {
    const user = this.userRepo.create({
      email: normalizeEmail(email),
      passwordHash: password,
      name,
      status: 'active',
    });
    return this.userRepo.save(user);
  }

  async findByVerificationToken(token: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { verificationToken: token } });
  }

  async findByResetToken(token: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { resetToken: token } });
  }

  async setVerificationToken(
    userId: string,
    token: string,
    expires: Date,
  ): Promise<void> {
    await this.userRepo.update(userId, {
      verificationToken: token,
      verificationTokenExpires: expires,
    });
  }

  async markVerified(userId: string): Promise<void> {
    await this.userRepo.update(userId, {
      isVerified: true,
      verificationToken: null,
      verificationTokenExpires: null,
    });
  }

  async setResetToken(userId: string, token: string, expires: Date): Promise<void> {
    await this.userRepo.update(userId, {
      resetToken: token,
      resetTokenExpires: expires,
    });
  }

  async updatePassword(userId: string, password: string): Promise<void> {
    const passwordHash = await hash(password, 10);
    await this.userRepo.update(userId, {
      passwordHash,
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
      organizationId?: string | null;
      verificationToken?: string | null;
      verificationTokenExpires?: Date | null;
    },
  ): Promise<User | null> {
    const update: Partial<User> = {};
    if (fields.name !== undefined) {
      update.name = fields.name;
    }
    if (fields.email !== undefined) {
      update.email = fields.email;
    }
    if (fields.status !== undefined) {
      update.status = fields.status;
    }
    if (fields.passwordHash !== undefined) {
      update.passwordHash = fields.passwordHash;
    }
    if (fields.isVerified !== undefined) {
      update.isVerified = fields.isVerified;
    }
    if (fields.organizationId !== undefined) {
      update.organizationId = fields.organizationId;
    }
    if (fields.verificationToken !== undefined) {
      update.verificationToken = fields.verificationToken;
    }
    if (fields.verificationTokenExpires !== undefined) {
      update.verificationTokenExpires = fields.verificationTokenExpires;
    }

    await this.userRepo.update(userId, update);
    return this.findById(userId);
  }
}
