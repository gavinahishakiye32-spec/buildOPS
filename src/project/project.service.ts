import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
} from '../common/pagination.dto.js';
import { TenantService } from '../tenant/tenant.service.js';
import { Client } from '../client/client.entity.js';
import { Project } from './project.entity.js';
import {
  CreateProjectDto,
  ProjectQueryDto,
  UpdateProjectDto,
} from './dto/project.dto.js';

/**
 * Projects belong to an organization and are connected to a client (spec §9).
 * Creation is bounded by the plan limit `max_projects`.
 */
@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Client)
    private readonly clientRepo: Repository<Client>,
    private readonly tenantService: TenantService,
  ) {}

  async list(
    organizationId: string,
    query: ProjectQueryDto,
  ): Promise<Paginated<Project>> {
    const { page, limit, skip } = resolvePage(query);

    const where: Record<string, unknown> = { organizationId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.clientId) {
      where.clientId = query.clientId;
    }

    const [items, total] = await this.projectRepo.findAndCount({
      where,
      order: { name: 'ASC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, projectId: string): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId, organizationId },
    });

    if (!project) {
      throw new NotFoundException('Project not found in this organization');
    }

    return project;
  }

  async create(
    organizationId: string,
    dto: CreateProjectDto,
  ): Promise<Project> {
    const tenant = await this.tenantService.requireByOrganizationId(
      organizationId,
    );
    await this.tenantService.assertCanConsume(tenant, 'projects');

    const clientId = await this.resolveClient(organizationId, dto.clientId);
    this.assertDateOrder(dto.startDate, dto.endDate);

    return this.projectRepo.save(
      this.projectRepo.create({
        organizationId,
        clientId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        status: dto.status ?? 'planned',
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        budget: dto.budget === undefined ? null : dto.budget.toFixed(2),
      }),
    );
  }

  async update(
    organizationId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    const project = await this.findOne(organizationId, projectId);

    if (dto.name !== undefined) {
      project.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      project.description = dto.description;
    }
    if (dto.clientId !== undefined) {
      project.clientId = await this.resolveClient(
        organizationId,
        dto.clientId ?? undefined,
      );
    }
    if (dto.status !== undefined) {
      project.status = dto.status;
    }
    if (dto.startDate !== undefined) {
      project.startDate = dto.startDate ? new Date(dto.startDate) : null;
    }
    if (dto.endDate !== undefined) {
      project.endDate = dto.endDate ? new Date(dto.endDate) : null;
    }
    if (dto.budget !== undefined) {
      project.budget = dto.budget === null ? null : dto.budget.toFixed(2);
    }

    this.assertDateOrder(project.startDate, project.endDate);

    return this.projectRepo.save(project);
  }

  async remove(organizationId: string, projectId: string): Promise<void> {
    await this.findOne(organizationId, projectId);
    await this.projectRepo.delete(projectId);
  }

  /** Client ownership is validated in the service layer even with a FK (spec §16). */
  private async resolveClient(
    organizationId: string,
    clientId?: string,
  ): Promise<string | null> {
    if (!clientId) {
      return null;
    }

    const client = await this.clientRepo.findOne({
      where: { id: clientId, organizationId },
    });

    if (!client) {
      throw new NotFoundException(
        'Client not found in this organization',
      );
    }

    return client.id;
  }

  private assertDateOrder(
    startDate: Date | string | null | undefined,
    endDate: Date | string | null | undefined,
  ): void {
    if (!startDate || !endDate) {
      return;
    }

    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    if (start > end) {
      throw new BadRequestException(
        'startDate must be before or equal to endDate',
      );
    }
  }
}