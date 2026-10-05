import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionName } from '../permissions.js';
import {
  REQUIRED_PERMISSIONS_KEY,
  SKIP_ORGANIZATION_KEY,
} from '../decorators/auth.decorator.js';
import { MembershipResolver } from '../membership.js';
import {
  ORGANIZATION_HEADER,
  type AuthContext,
  type AuthenticatedRequest,
} from '../types.js';

/**
 * Resolves the organization context and enforces the required permissions
 * (spec §5: `Subscription Context → Organization Context → Role/Permissions`).
 *
 * Runs **after** `JwtAuthGuard`, so `request.user` is always populated.
 * The active organization comes from the `x-organization-id` header or the
 * `:organizationId` route parameter. A client-provided id never grants access
 * on its own — membership is verified against the caller's role assignments.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MembershipResolver)
    private readonly membershipResolver: MembershipResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const authContext: AuthContext = {
      userId: request.user?.id,
      organizationId: null,
      roleId: null,
      permissions: [],
      sessionId: request.user?.sessionId,
    };
    request.authContext = authContext;

    const skipOrganization = this.reflector.getAllAndOverride<boolean>(
      SKIP_ORGANIZATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!skipOrganization) {
      const organizationId = this.resolveOrganizationId(request);

      if (!organizationId) {
        throw new NotFoundException(
          `Organization context is required: send the ${ORGANIZATION_HEADER} header or use an /organizations/:organizationId route`,
        );
      }

      const membership = await this.membershipResolver.resolve(
        organizationId,
        authContext.userId,
      );

      if (!membership) {
        throw new ForbiddenException(
          'You do not have access to this organization',
        );
      }

      authContext.organizationId = organizationId;
      authContext.roleId = membership.roleId;
      authContext.permissions = membership.permissions;
    }

    const required = this.reflector.getAllAndOverride<PermissionName[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (required?.length) {
      const missing = required.filter(
        (permission) => !authContext.permissions.includes(permission),
      );

      if (missing.length) {
        throw new ForbiddenException(
          `Missing required permission: ${missing.join(', ')}`,
        );
      }
    }

    return true;
  }

  /**
   * Guards run **before** pipes, so this reads the raw `:organizationId` segment
   * and the raw header. A non-UUID reaching the membership query would make
   * PostgreSQL raise `invalid input syntax for type uuid`, surfacing as an
   * undocumented `500`. Rejecting it here keeps the answer the documented `400`
   * and matches `ParseUUIDPipe`, which cannot run first.
   */
  private resolveOrganizationId(request: AuthenticatedRequest): string | null {
    const fromParam = (request.params as Record<string, string> | undefined)
      ?.organizationId;

    if (typeof fromParam === 'string' && fromParam.length > 0) {
      this.assertUuid(fromParam);
      return fromParam;
    }

    const header = request.headers[ORGANIZATION_HEADER];
    const value = Array.isArray(header) ? header[0] : header;

    if (typeof value === 'string' && value.length > 0) {
      this.assertUuid(value);
      return value;
    }

    return null;
  }

  private assertUuid(value: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new BadRequestException('Validation failed (uuid is expected)');
    }
  }
}
