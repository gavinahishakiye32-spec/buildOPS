import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organization } from '../organization/organization.entity.js';
import { RoleModule } from '../role/role.module.js';
import { User } from '../user/user.entity.js';
import { UserModule } from '../user/user.module.js';
import { TeamController } from './team.controller.js';
import { Team } from './team.entity.js';
import { TeamMember } from './team-member.entity.js';
import { TeamService } from './team.service.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([Team, TeamMember, Organization, User]),
    UserModule,
    RoleModule,
  ],
  controllers: [TeamController],
  providers: [TeamService],
  exports: [TeamService, TypeOrmModule],
})
export class TeamModule {}
