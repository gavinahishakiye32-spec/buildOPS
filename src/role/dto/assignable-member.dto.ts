import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A member as the assignment picker sees them.
 *
 * Distinct from {@link AssigneeSummaryDto}, which describes somebody *already*
 * on a task. This one is for choosing who goes on one, and it needs an address
 * as the fallback label: a member whose `name` is null still has to be
 * identifiable in a dropdown, and a column of identical "Unnamed" rows is not a
 * list anybody can pick from.
 */
export class AssignableMemberDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiPropertyOptional({ example: 'Alex Morgan', nullable: true })
  name: string | null;

  @ApiProperty({ example: 'alex.morgan@example.com' })
  email: string;
}