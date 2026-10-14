import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';
import { ValidationError, formatZodError } from '@/common/errors';

/**
 * Validates and *narrows* a request payload with a zod schema.
 *
 * Using zod rather than class-validator keeps a single schema definition shared
 * between the API and the dashboard (`@shorts/contracts`), so the two cannot drift.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError('Request validation failed.', formatZodError(result.error));
    }
    return result.data;
  }
}

/** `@Body(zodBody(createIdeaSchema)) dto: CreateIdeaDto` */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/** `@Query(zodQuery(listIdeasSchema)) query: ListIdeasDto` */
export function zodQuery<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
