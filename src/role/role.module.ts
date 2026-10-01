import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MembershipResolver } from '../common/membership.js';
import { UserModule } from '../user/user.module.js';
import { Permission } from './permission.entity.js';
import { RoleController } from './role.controller.js';
import { Role } from './role.entity.js';
import { RoleService } from './role.service.js';
// AuthModule (not AuthorizationModule) avoids the module cycle:
// AuthorizationModule already imports RoleModule for the membership resolver.
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([Role, Permission]),
    UserModule,
  ],
  controllers: [RoleController],
  providers: [
    RoleService,
    { provide: MembershipResolver, useExisting: RoleService },
  ],
  exports: [RoleService, MembershipResolver, TypeOrmModule],
})
export class RoleModule {}
