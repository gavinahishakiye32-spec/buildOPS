import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const SKIP_ORGANIZATION_KEY = 'skipOrganization';

/** Marks a route as reachable without a JWT (spec §17). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires a JWT but no organization context (tenant-level endpoints). */
export const SkipOrganization = () => SetMetadata(SKIP_ORGANIZATION_KEY, true);