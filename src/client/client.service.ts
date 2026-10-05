import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { normalizeEmail } from '../common/email.js';
import {
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';
import {
  resolvePage,
  toPaginated,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.dto.js';
import { Client } from './client.entity.js';
import { CreateClientDto, UpdateClientDto } from './dto/client.dto.js';

/** Clients are organization-owned CRM records (spec §8). */
@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<Client>> {
    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.clientRepo.findAndCount({
      where: { organizationId },
      order: { name: 'ASC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, clientId: string): Promise<Client> {
    const client = await this.clientRepo.findOne({
      where: { id: clientId, organizationId },
    });

    if (!client) {
      throw new NotFoundException('Client not found in this organization');
    }

    return client;
  }

  async create(organizationId: string, dto: CreateClientDto): Promise<Client> {
    const email = dto.email ? normalizeEmail(dto.email) : null;

    if (email) {
      await this.assertEmailAvailable(email);
    }

    return this.clientRepo.save(
      this.clientRepo.create({
        organizationId,
        name: dto.name.trim(),
        email,
        phone: dto.phone ?? null,
        industry: dto.industry ?? null,
        website: dto.website ?? null,
        status: dto.status ?? 'active',
      }),
    );
  }

  async update(
    organizationId: string,
    clientId: string,
    dto: UpdateClientDto,
  ): Promise<Client> {
    const client = await this.findOne(organizationId, clientId);

    if (dto.name !== undefined) {
      client.name = dto.name.trim();
    }

    if (dto.email !== undefined) {
      const email = normalizeEmail(dto.email);
      if (email !== client.email) {
        await this.assertEmailAvailable(email, client.id);
        client.email = email;
      }
    }

    if (dto.phone !== undefined) {
      client.phone = dto.phone;
    }
    if (dto.industry !== undefined) {
      client.industry = dto.industry;
    }
    if (dto.website !== undefined) {
      client.website = dto.website;
    }
    if (dto.status !== undefined) {
      client.status = dto.status;
    }

    return this.clientRepo.save(client);
  }

  /**
   * Soft-deletes a client.
   *
   * No confirmation is required, and none is needed: a client owns no work. Its
   * projects survive with `clientId: null`, which is the pre-existing behaviour
   * (`clients -> projects` is `ON DELETE SET NULL`), and because the row is only
   * flagged they reattach to the client if it is restored.
   */
  async remove(
    organizationId: string,
    clientId: string,
    actorId: string,
  ): Promise<void> {
    await this.findOne(organizationId, clientId);
    await softDeleteBy(this.clientRepo, 'id = :id', { id: clientId }, actorId, new Date());
  }

  /** Brings a deleted client back, projects included. */
  async restore(
    organizationId: string,
    clientId: string,
  ): Promise<Client> {
    const client = await this.clientRepo.findOne({
      where: { id: clientId, organizationId },
      withDeleted: true,
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (!client.deletedAt) {
      throw new ConflictException('Client is not deleted');
    }

    // Deleting a client releases its address -- that is the point of the
    // partial unique index -- so somebody may have taken it in the meantime.
    // Without this the restore would fail as a raw unique violation, which the
    // client would see as a 500 and read as "the restore is broken" rather than
    // "somebody else has that address now".
    if (client.email) {
      await this.assertEmailAvailable(client.email, clientId);
    }

    await restoreBy(this.clientRepo, 'id = :id', { id: clientId });

    return this.findOne(organizationId, clientId);
  }

  /** Deleted clients, newest first, so a restore endpoint is reachable. */
  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    const rows = await this.clientRepo.find({
      where: { organizationId, deletedAt: Not(IsNull()) },
      order: { deletedAt: 'DESC' },
      withDeleted: true,
    });

    return rows.map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt as Date,
      deletedBy: row.deletedBy,
      resource: row.toResponse(),
    }));
  }

  private async assertEmailAvailable(
    email: string,
    currentId?: string,
  ): Promise<void> {
    const existing = await this.clientRepo.findOne({
      where: currentId ? { email, id: Not(currentId) } : { email },
    });

    if (existing) {
      throw new ConflictException('Client email already registered');
    }
  }
}
