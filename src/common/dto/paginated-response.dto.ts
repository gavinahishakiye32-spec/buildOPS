import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import type { Type } from '@nestjs/common';
import type { Paginated } from '../pagination.dto.js';

/**
 * Builds the OpenAPI schema of the shared pagination envelope for a concrete
 * item type, e.g. `PaginatedSchema(ClientResponseDto, 'ClientPage')` (spec §16).
 */
export function PaginatedSchema<T>(
  itemType: Type<T>,
  name = `Paginated${itemType.name}`,
): Type<Paginated<T>> {
  @ApiExtraModels(itemType)
  class ConcretePaginatedSchema {
    @ApiProperty({
      type: itemType,
      isArray: true,
      description: 'Records of the current page',
    })
    items: T[];

    @ApiProperty({ example: 42, description: 'Total matching records' })
    total: number;

    @ApiProperty({ example: 1, description: 'Current page (1-based)' })
    page: number;

    @ApiProperty({ example: 20, description: 'Items per page' })
    limit: number;

    @ApiProperty({ example: 3, description: 'Total number of pages' })
    totalPages: number;
  }

  Object.defineProperty(ConcretePaginatedSchema, 'name', { value: name });

  return ConcretePaginatedSchema;
}
