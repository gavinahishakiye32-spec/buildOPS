import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsController } from './settings.controller.js';
import { AccountController } from './account.controller.js';
import { SettingsService } from './settings.service.js';
import { AccountService } from './account.service.js';
import { UserSettings } from './user-settings.entity.js';
import { OrganizationSettings } from './organization-settings.entity.js';
import { User } from '../user/user.entity.js';
import { Organization } from '../organization/organization.entity.js';
import { AuthorizationModule } from '../auth/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';

/**
 * `User` and `Organization` are registered alongside the two settings entities
 * because the service looks each owner up before inserting a defaults row. That
 * check is what turns a stale id into a 404 rather than a foreign key violation
 * surfaced as a 500, and it is the reason this module reaches for the entity
 * repositories rather than only its own two.
 *
 * The account delete reaches further than that -- it releases `Role` assignments,
 * `TeamMember` rows and the `UserSettings` row of the account being closed -- but
 * it does it through the transaction's own manager, so nothing else has to be
 * registered here for it: an injected repository would run outside the transaction
 * that has to hold those writes together. It also imports nothing from the role or
 * team services, because a delete that cleans up after them does not need to ask
 * them for anything.
 */
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    TypeOrmModule.forFeature([
      UserSettings,
      OrganizationSettings,
      User,
      Organization,
    ]),
  ],
  controllers: [SettingsController, AccountController],
  providers: [SettingsService, AccountService],
  exports: [SettingsService],
})
export class SettingsModule {}
