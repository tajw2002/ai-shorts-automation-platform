import { Injectable } from '@nestjs/common';
import {
  type CharacterSummary,
  type CreateCharacterDto,
  type Paginated,
  type Pagination,
  type UpdateCharacterDto,
} from '@shorts/contracts';
import { PrismaService, translatePrismaError } from '@/prisma/prisma.service';
import { NotFoundError } from '@/common/errors';
import { type CharacterBrief } from '@/providers/llm/llm-provider.interface';

/**
 * The character library.
 *
 * Visual consistency across videos rests on two things this service guarantees:
 *   1. Prompt-relevant fields are stored once and injected verbatim into every
 *      scene prompt, so a character is described identically each time.
 *   2. `visualSeed` is stable per character, anchoring the generator's output.
 *
 * Editing a prompt-relevant field bumps `promptRevision` rather than silently
 * changing history — an old video records which revision produced it, so a
 * render stays explainable months later.
 */

/** Changing any of these alters how the character is drawn, so the revision moves. */
const PROMPT_RELEVANT_FIELDS = [
  'appearance',
  'outfit',
  'visualStyle',
  'promptDescription',
  'negativePrompt',
  'visualSeed',
  'species',
  'ageDescriptor',
] as const;

@Injectable()
export class CharactersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(pagination: Pagination, includeInactive = true): Promise<Paginated<CharacterSummary>> {
    const where = includeInactive ? {} : { isActive: true };
    const [rows, total] = await Promise.all([
      this.prisma.character.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
        include: { _count: { select: { ideas: true } } },
      }),
      this.prisma.character.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        species: row.species,
        description: row.description,
        isActive: row.isActive,
        promptRevision: row.promptRevision,
        usageCount: row._count.ideas,
        createdAt: row.createdAt.toISOString(),
      })),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
    };
  }

  async findById(id: string) {
    const character = await this.prisma.character.findUnique({ where: { id } });
    if (!character) throw new NotFoundError('Character', id);
    return character;
  }

  async create(dto: CreateCharacterDto) {
    try {
      return await this.prisma.character.create({
        data: {
          name: dto.name,
          description: dto.description,
          ageDescriptor: dto.ageDescriptor ?? null,
          species: dto.species,
          appearance: dto.appearance,
          outfit: dto.outfit ?? null,
          personality: dto.personality,
          voiceDescription: dto.voiceDescription ?? null,
          voiceId: dto.voiceId ?? null,
          visualStyle: dto.visualStyle,
          promptDescription: dto.promptDescription,
          negativePrompt: dto.negativePrompt ?? null,
          // A stable seed is what keeps the look consistent; deriving it from the
          // name means a re-created character looks the same as before.
          visualSeed: dto.visualSeed ?? seedFromName(dto.name),
          isActive: dto.isActive,
        },
      });
    } catch (error) {
      translatePrismaError(error, 'Character');
    }
  }

  async update(id: string, dto: UpdateCharacterDto) {
    const existing = await this.findById(id);
    const bumpsRevision = PROMPT_RELEVANT_FIELDS.some(
      (field) => dto[field] !== undefined && dto[field] !== existing[field],
    );

    try {
      return await this.prisma.character.update({
        where: { id },
        data: {
          ...stripUndefined({
            name: dto.name,
            description: dto.description,
            ageDescriptor: dto.ageDescriptor,
            species: dto.species,
            appearance: dto.appearance,
            outfit: dto.outfit,
            personality: dto.personality,
            voiceDescription: dto.voiceDescription,
            voiceId: dto.voiceId,
            visualStyle: dto.visualStyle,
            promptDescription: dto.promptDescription,
            negativePrompt: dto.negativePrompt,
            visualSeed: dto.visualSeed,
            isActive: dto.isActive,
          }),
          ...(bumpsRevision ? { promptRevision: { increment: 1 } } : {}),
        },
      });
    } catch (error) {
      translatePrismaError(error, 'Character');
    }
  }

  /**
   * Characters are deactivated rather than deleted when they have been used:
   * removing one would orphan the provenance of every video it appeared in.
   */
  async remove(id: string): Promise<{ deleted: boolean }> {
    const usage = await this.prisma.ideaCharacter.count({ where: { characterId: id } });
    if (usage > 0) {
      await this.prisma.character.update({ where: { id }, data: { isActive: false } });
      return { deleted: false };
    }
    await this.prisma.character.delete({ where: { id } });
    return { deleted: true };
  }

  /** The trimmed shape handed to the LLM and the prompt renderer. */
  async getBriefs(ids?: string[]): Promise<CharacterBrief[]> {
    const rows = await this.prisma.character.findMany({
      where: ids && ids.length > 0 ? { id: { in: ids } } : { isActive: true },
      orderBy: { name: 'asc' },
    });

    return rows.map(toBrief);
  }

  async getBriefsByName(names: string[]): Promise<CharacterBrief[]> {
    if (names.length === 0) return [];
    const rows = await this.prisma.character.findMany({
      where: { name: { in: names, mode: 'insensitive' } },
    });
    return rows.map(toBrief);
  }
}

function toBrief(row: {
  id: string;
  name: string;
  species: string;
  ageDescriptor: string | null;
  appearance: string;
  outfit: string | null;
  personality: string;
  visualStyle: string;
  promptDescription: string;
}): CharacterBrief {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    ageDescriptor: row.ageDescriptor,
    appearance: row.appearance,
    outfit: row.outfit,
    personality: row.personality,
    visualStyle: row.visualStyle,
    promptDescription: row.promptDescription,
  };
}

/** Deterministic seed in the range the video providers accept. */
export function seedFromName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2_147_483_647;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
