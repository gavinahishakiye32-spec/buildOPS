import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The person a task or subtask is assigned to, as the assignment routes report
 * them.
 *
 * Declared once and shared by both: `tasks.assignee_id` and
 * `subtasks.assigned_to` are the same concept pointing at the same table, and
 * two shapes for it would leave every client branching on which route it called.
 *
 * Carries no email and no role. An assignment list is a much wider surface than
 * the members administration screen, and the board needs a name and an id to
 * render an avatar -- nothing more.
 */
export class AssigneeSummaryDto {
  @ApiProperty({ example: '9a2b7c1d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' })
  id: string;

  @ApiPropertyOptional({ example: 'Alex Morgan', nullable: true })
  name: string | null;
}