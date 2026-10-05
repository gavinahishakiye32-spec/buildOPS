import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import {
  resolvePage,
  toPaginated,
  type Paginated,
  type PaginationQueryDto,
} from '../common/pagination.dto.js';
import { Organization } from '../organization/organization.entity.js';
import { RoleService } from '../role/role.service.js';
import { User } from '../user/user.entity.js';
import { UserService } from '../user/user.service.js';
import { Team } from './team.entity.js';
import { TeamMember } from './team-member.entity.js';
import {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/team.dto.js';
import {
  restoreBy,
  softDeleteBy,
  type TrashEntryDto,
} from '../common/soft-delete.js';

/**
 * Teams live inside an organization (spec §7). A team member must already be an
 * organization member; team membership is what validates subtask assignment.
 */
@Injectable()
export class TeamService {
  constructor(
    @InjectRepository(Team)
    private readonly teamRepo: Repository<Team>,
    @InjectRepository(TeamMember)
    private readonly teamMemberRepo: Repository<TeamMember>,
    @InjectRepository(Organization)
    private readonly organizationRepo: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly roleService: RoleService,
    private readonly userService: UserService,
  ) {}

  async list(
    organizationId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<Team>> {
    const { page, limit, skip } = resolvePage(query);

    const [items, total] = await this.teamRepo.findAndCount({
      where: { organizationId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return toPaginated(items, total, page, limit);
  }

  async findOne(organizationId: string, teamId: string): Promise<Team> {
    const team = await this.teamRepo.findOne({
      where: { id: teamId, organizationId },
    });

    if (!team) {
      throw new NotFoundException('Team not found in this organization');
    }

    return team;
  }

  async create(organizationId: string, dto: CreateTeamDto): Promise<Team> {
    return this.teamRepo.save(
      this.teamRepo.create({
        organizationId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        status: dto.status ?? 'active',
      }),
    );
  }

  async update(
    organizationId: string,
    teamId: string,
    dto: UpdateTeamDto,
  ): Promise<Team> {
    const team = await this.findOne(organizationId, teamId);

    if (dto.name !== undefined) {
      team.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      team.description = dto.description;
    }
    if (dto.status !== undefined) {
      team.status = dto.status;
    }

    return this.teamRepo.save(team);
  }

  /**
   * Soft-deletes a team.
   *
   * Its memberships and the `teamId` on its tasks are left alone, and that is
   * the point rather than an oversight. Memberships are an association rather
   * than content, so there is nothing there to make recoverable -- but keeping
   * the rows is what lets a restored team come back with the people still on it.
   * Tasks are unaffected either way: `tasks.team_id` is `ON DELETE SET NULL`.
   */
  async remove(
    organizationId: string,
    teamId: string,
    actorId: string,
  ): Promise<void> {
    await this.findOne(organizationId, teamId);
    await softDeleteBy(this.teamRepo, 'id = :id', { id: teamId }, actorId, new Date());
  }

  async restore(organizationId: string, teamId: string): Promise<Team> {
    const team = await this.teamRepo.findOne({
      where: { id: teamId, organizationId },
      withDeleted: true,
    });

    if (!team) {
      throw new NotFoundException('Team not found');
    }

    if (!team.deletedAt) {
      throw new ConflictException('Team is not deleted');
    }

    await restoreBy(this.teamRepo, 'id = :id', { id: teamId });

    return this.findOne(organizationId, teamId);
  }

  async listDeleted(organizationId: string): Promise<TrashEntryDto[]> {
    const rows = await this.teamRepo.find({
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

  // --- membership -----------------------------------------------------------

  async listMembers(
    organizationId: string,
    teamId: string,
  ): Promise<TeamMember[]> {
    await this.findOne(organizationId, teamId);

    return this.teamMemberRepo.find({
      where: { teamId },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });
  }

  async addMember(
    organizationId: string,
    teamId: string,
    dto: AddTeamMemberDto,
  ): Promise<TeamMember> {
    await this.findOne(organizationId, teamId);

    if (!dto.userId && !dto.email) {
      throw new BadRequestException('userId or email is required');
    }

    const user = await this.resolveUser(dto.userId, dto.email);

    const membership = await this.roleService.resolve(organizationId, user.id);

    if (!membership) {
      throw new BadRequestException(
        'The user must belong to the organization before joining a team',
      );
    }

    const existing = await this.teamMemberRepo.findOne({
      where: { teamId, userId: user.id },
    });

    if (existing) {
      throw new ConflictException('User is already a member of this team');
    }

    const member = await this.teamMemberRepo.save(
      this.teamMemberRepo.create({
        teamId,
        userId: user.id,
        role: dto.role ?? 'member',
        status: dto.status ?? 'active',
      }),
    );

    return this.loadMember(teamId, member.id);
  }

  async updateMember(
    organizationId: string,
    teamId: string,
    memberId: string,
    dto: UpdateTeamMemberDto,
  ): Promise<TeamMember> {
    await this.findOne(organizationId, teamId);

    const member = await this.teamMemberRepo.findOne({
      where: { id: memberId, teamId },
    });

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    if (dto.role !== undefined) {
      member.role = dto.role;
    }
    if (dto.status !== undefined) {
      member.status = dto.status;
    }

    await this.teamMemberRepo.save(member);
    return this.loadMember(teamId, member.id);
  }

  async removeMember(
    organizationId: string,
    teamId: string,
    memberId: string,
  ): Promise<void> {
    await this.findOne(organizationId, teamId);

    const member = await this.teamMemberRepo.findOne({
      where: { id: memberId, teamId },
    });

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    await this.teamMemberRepo.delete(member.id);
  }

  /** Validates the subtask assignment rule (spec §11). */
  async assertActiveMember(teamId: string, userId: string): Promise<void> {
    const member = await this.teamMemberRepo.findOne({
      where: { teamId, userId, status: 'active' },
    });

    if (!member) {
      throw new BadRequestException(
        'The assignee must be an active member of the team assigned to this task',
      );
    }
  }

  private async resolveUser(userId?: string, email?: string): Promise<User> {
    const user = userId
      ? await this.userService.findById(userId)
      : await this.userService.findByEmail(email as string);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async loadMember(
    teamId: string,
    memberId: string,
  ): Promise<TeamMember> {
    const member = await this.teamMemberRepo.findOne({
      where: { id: memberId, teamId },
      relations: { user: true },
    });

    if (!member) {
      throw new NotFoundException('Team member not found');
    }

    return member;
  }
}
