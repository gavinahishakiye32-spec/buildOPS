import type { EntityManager } from 'typeorm';
import { ActivityEvent } from './activity.entity.js';
import type { ActivityAction, ActivityEntityType } from './activity.entity.js';
import { currentActivityActor } from './activity-context.js';

export interface ActivityRecordInput {
  organizationId: string;
  entityType: ActivityEntityType;
  action: ActivityAction;
  entityId: string;
  actorId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends one activity event inside `manager`'s transaction.
 *
 * A free function rather than a method so services can use it without injecting
 * `ActivityService` — the caller only ever has an `EntityManager` in hand, which
 * is exactly what the write needs and what keeps the event in the same
 * transaction as the mutation it describes. It is the same logic the service's
 * `record()` exposes for callers that already depend on the service.
 *
 * The actor is resolved from the request-scoped context published by
 * `ActivityContextInterceptor`, unless the caller passes one explicitly.
 */
export async function recordActivity(
  manager: EntityManager,
  event: ActivityRecordInput,
): Promise<void> {
  const actorId =
    event.actorId !== undefined
      ? event.actorId
      : (currentActivityActor()?.userId ?? null);

  await manager.save(
    manager.create(ActivityEvent, {
      organizationId: event.organizationId,
      actorId,
      entityType: event.entityType,
      action: event.action,
      entityId: event.entityId,
      projectId: event.projectId ?? null,
      metadata: event.metadata ?? null,
    }),
  );
}
