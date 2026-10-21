import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../common/types.js';
import { runWithActivityActor } from './activity-context.js';

/**
 * Publishes "who is calling" into async-local storage for the duration of each
 * request, so `ActivityService.record` can attribute an event without every
 * service method growing an `actorId` parameter it did not otherwise need.
 *
 * Runs after the guards (guards → interceptors → pipes → controller in Nest's
 * pipeline), so `request.authContext` — resolved by `PermissionsGuard` — is
 * always populated here on protected routes. Public routes pass straight
 * through with no actor at all.
 *
 * The observable subscription has to happen *inside* `runWithActivityActor`:
 * Nest subscribes to the returned observable after this method returns, and an
 * async context is only propagated from the call stack that opened it. Merely
 * wrapping the `next.handle()` call would lose the store by the time the
 * handler actually runs.
 */
@Injectable()
export class ActivityContextInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType<'http' | 'ws' | 'rpc'>() !== 'http') {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<Partial<AuthenticatedRequest>>();
    const userId = request.authContext?.userId;

    if (!userId) {
      return next.handle();
    }

    const actor = {
      userId,
      organizationId: request.authContext?.organizationId ?? null,
    };

    return new Observable((subscriber) => {
      runWithActivityActor(actor, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
