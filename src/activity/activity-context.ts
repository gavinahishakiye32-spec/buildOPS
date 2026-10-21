import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is making the request currently being handled.
 *
 * Captured by a global interceptor from the `authContext` that
 * `PermissionsGuard` resolves, and read by `ActivityService.record` when a
 * service mutation does not already carry an actor id of its own. The
 * alternative — threading an `actorId` argument through every service method —
 * would touch dozens of signatures for a value every request already has, and
 * would silently go stale wherever a caller forgot to pass it. Async-local
 * storage keeps the actor ambient and impossible to forget.
 *
 * Deliberately read-only: nothing writes to the store, and the interceptor is
 * the only place that opens a scope.
 */
export interface ActivityActor {
  userId: string;
  organizationId: string | null;
}

const storage = new AsyncLocalStorage<ActivityActor>();

/** Opens an actor scope for everything `fn` starts, including its async work. */
export function runWithActivityActor<T>(
  actor: ActivityActor,
  fn: () => T,
): T {
  return storage.run(actor, fn);
}

/** The current request's actor, or `null` outside a request (scripts, jobs). */
export function currentActivityActor(): ActivityActor | null {
  return storage.getStore() ?? null;
}
