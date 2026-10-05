/**
 * The vocabulary shared by every soft-deleted resource.
 *
 * A delete here is a flag, not a `DELETE FROM`, which makes two things possible
 * that were not before: a resource can come back exactly as it was, and a whole
 * subtree can be taken down and put back as a unit.
 *
 * The timestamp is the mechanism for that second part. `softDelete` stamps a
 * single `Date` across a parent and every descendant it takes with it, so a
 * restore can select the exact set of rows that went down together instead of
 * guessing with a time window. Guessing is how a restore ends up resurrecting
 * something deleted deliberately an hour later, or leaving a subtask behind
 * because the clock ticked over a second boundary mid-cascade.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ObjectLiteral, Repository } from 'typeorm';

/**
 * The value a client must send to confirm a delete that would take work with it.
 *
 * Deliberately a magic word rather than `force=true`. The delete that needs
 * this is the one that removes every task under a project along with the hours
 * logged against them, and the cost of getting that wrong is a project nobody
 * can reconstruct. A flag called `force` invites a client library to set it by
 * default; a word that has to be typed does not.
 */
export const CASCADE_CONFIRMATION = 'cascade';

export const CASCADE_CONFIRMATION_REQUIRED =
  `This delete takes the resource's contents with it, including time logged ` +
  `against them. Repeat the request with ?confirm=${CASCADE_CONFIRMATION} to ` +
  `confirm. The contents are recoverable afterwards, but not by re-typing them.`;

/** Query parameter acknowledging a cascading delete. */
export class ConfirmCascadeDto {
  @ApiPropertyOptional({
    enum: [CASCADE_CONFIRMATION],
    description:
      'Required only for a delete that would take the resource contents with it. ' +
      'Without it the request is refused with 409 and nothing is deleted.',
  })
  @IsOptional()
  @IsIn([CASCADE_CONFIRMATION])
  confirm?: typeof CASCADE_CONFIRMATION;
}

/**
 * Query parameter for the one delete in this system that cannot be undone.
 *
 * Every other destructive route confirms a fixed token, because a client can
 * read the token out of this file. Deleting an organization cannot offer that:
 * it removes the rows behind every other resource, including the soft-deleted
 * ones, so there is nothing left to restore from. The caller has to type
 * something only a deliberate human would type -- the organization's own name.
 */
export class ConfirmOrganizationDeletionDto {
  @ApiPropertyOptional({
    description:
      'The organization name, typed exactly, to confirm permanent deletion. ' +
      'Anything else is refused with 409 and nothing is deleted.',
    example: 'Acme Field Services',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  confirm?: string;
}

/** The two columns every soft-deletable resource carries. */
export interface SoftDeletable {
  deletedAt: Date | null;
  deletedBy: string | null;
}

/*
 * `Repository.softDelete` and `Repository.restore` are deliberately not used
 * here. Neither accepts a partial, and both halves of that are a problem:
 * `softDelete` will not let a caller choose the timestamp, and `restore` clears
 * only `deleted_at`, leaving a restored row still claiming who deleted it.
 *
 * The criteria are a `where` string plus parameters rather than a typed object
 * for two reasons. The cascade needs `IN (...)` over a freshly collected list of
 * ids, and TypeORM cannot express `QueryDeepPartialEntity` through a generic
 * entity type at all -- the mapped type collapses to `unknown` -- so a typed
 * helper would either not compile or need a cast that lies about the columns.
 * The call sites are all `id = :id` or `id IN (:...ids)`; nothing here
 * interpolates a value.
 */
type AnyRepo = Repository<ObjectLiteral>;

const update = async (
  repo: AnyRepo,
  where: string,
  params: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<number> => {
  const result = await repo
    .createQueryBuilder()
    .update()
    .set(values)
    .where(where, params)
    .execute();

  return result.affected ?? 0;
};

/**
 * Flags matching rows as deleted at `at`, on behalf of `actorId`.
 *
 * The timestamp is a parameter rather than a by-product of the call so a whole
 * subtree can be given the *same* value. That is what makes a restore exact:
 * the rows that went down together are the rows sharing that value, with no
 * time window to get wrong.
 *
 * Returns how many rows it flagged, so a caller can tell "nothing to delete"
 * from "deleted" and report it honestly.
 */
export async function softDeleteBy(
  repo: AnyRepo,
  where: string,
  params: Record<string, unknown>,
  actorId: string,
  at: Date,
): Promise<number> {
  return update(repo, where, params, { deletedAt: at, deletedBy: actorId });
}

/**
 * Brings matching rows back, clearing `deleted_by` as well as `deleted_at`.
 *
 * A restored row that still named the person who deleted it would be a small
 * lie in an audit column, so the two are always cleared together.
 */
export async function restoreBy(
  repo: AnyRepo,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  return update(repo, where, params, { deletedAt: null, deletedBy: null });
}

/** What the trash listing returns, on top of the resource's own fields. */
export class TrashEntryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'When the resource was deleted.' })
  deletedAt: Date;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Who deleted it, or null if that account has since been removed.',
  })
  deletedBy: string | null;

  /**
   * The deleted record itself, under the name of its own response type.
   *
   * One wrapper for every trash listing rather than a union of seven: the three
   * fields above are the part a client has to handle generically (to show a
   * restore button, or who to ask about a deletion), and the record beside them
   * is what it renders. A client that wants to display a deleted row should not
   * have to switch on the resource type first.
   */
  @ApiProperty({
    description: 'The deleted record, as its own resource type would be returned.',
    type: 'object',
    additionalProperties: true,
  })
  resource: Record<string, unknown>;
}
