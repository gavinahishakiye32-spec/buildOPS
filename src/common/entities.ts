import { User } from '../user/user.entity.js';
import { Plan } from '../plan/plan.entity.js';
import { Tenant } from '../tenant/tenant.entity.js';
import { Organization } from '../organization/organization.entity.js';
import { Role } from '../role/role.entity.js';
import { Permission } from '../role/permission.entity.js';
import { Badge } from '../badge/badge.entity.js';
import { Team } from '../team/team.entity.js';
import { TeamMember } from '../team/team-member.entity.js';
import { Client } from '../client/client.entity.js';
import { Project } from '../project/project.entity.js';
import { Task } from '../task/task.entity.js';
import { Subtask } from '../subtask/subtask.entity.js';
import { TimeEntry } from '../time-entry/time-entry.entity.js';
import { TimeComplexity } from '../time-complexity/time-complexity.entity.js';

/** Every entity mapped by the ORM; the single source of truth for TypeORM. */
export const ENTITIES = [
  User,
  Plan,
  Tenant,
  Organization,
  Role,
  Permission,
  Badge,
  Team,
  TeamMember,
  Client,
  Project,
  Task,
  Subtask,
  TimeEntry,
  TimeComplexity,
];