import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { normalizeEmail } from '../common/email.js';
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

  async remove(organizationId: string, clientId: string): Promise<void> {
    await this.findOne(organizationId, clientId);
    await this.clientRepo.delete(clientId);
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
