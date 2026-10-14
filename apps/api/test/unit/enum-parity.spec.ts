import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contracts from '@shorts/contracts';

/**
 * The Prisma schema cannot import TypeScript, so the enums in
 * `packages/contracts/src/enums.ts` are mirrored by hand in `schema.prisma`.
 *
 * This test is what keeps the two honest. Without it, adding a `VideoStatus`
 * value in one place and forgetting the other produces a runtime failure at the
 * database boundary — and only for the code path that happens to use it.
 */

const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

/** Extracts `enum Name { A B C }` blocks from the Prisma schema. */
function parsePrismaEnums(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const pattern = /^enum\s+(\w+)\s*\{([^}]*)\}/gms;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, name, body] = match;
    const values = (body ?? '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0 && /^\w+$/.test(line));
    result.set(name as string, values);
  }
  return result;
}

const prismaEnums = parsePrismaEnums(readFileSync(SCHEMA_PATH, 'utf8'));

/**
 * Contract enum → Prisma enum name. Every entry must exist on both sides.
 * `FingerprintKind` is intentionally absent: it is a storage detail with no
 * contract counterpart.
 */
const MIRRORED: Array<[string, Record<string, string>]> = [
  ['VideoStatus', contracts.VideoStatus],
  ['SceneStatus', contracts.SceneStatus],
  ['IdeaStatus', contracts.IdeaStatus],
  ['JobStatus', contracts.JobStatus],
  ['JobType', contracts.JobType],
  ['GenerationJobStatus', contracts.GenerationJobStatus],
  ['UploadJobStatus', contracts.UploadJobStatus],
  ['ApprovalMode', contracts.ApprovalMode],
  ['PrivacyStatus', contracts.PrivacyStatus],
  ['AssetKind', contracts.AssetKind],
  ['LicenseStatus', contracts.LicenseStatus],
  ['SafetyVerdict', contracts.SafetyVerdict],
  ['SafetyCategory', contracts.SafetyCategory],
  ['QualityCheckStatus', contracts.QualityCheckStatus],
  ['ProviderKind', contracts.ProviderKind],
  ['HealthStatus', contracts.HealthStatus],
  ['LogLevel', contracts.LogLevel],
  ['ScheduleStatus', contracts.ScheduleStatus],
  ['CostCategory', contracts.CostCategory],
  ['UserRole', contracts.UserRole],
];

describe('enum parity between contracts and the Prisma schema', () => {
  it('parsed the schema at all (guards against a silently passing test)', () => {
    expect(prismaEnums.size).toBeGreaterThan(15);
    expect(prismaEnums.get('VideoStatus')).toContain('PUBLISHED');
  });

  it.each(MIRRORED)('%s matches the Prisma enum exactly', (name, contractEnum) => {
    const prismaValues = prismaEnums.get(name);
    expect(prismaValues).toBeDefined();

    const contractValues = Object.values(contractEnum).sort();
    expect([...(prismaValues as string[])].sort()).toEqual(contractValues);
  });

  it.each(MIRRORED)('%s uses its value as its key, so lookups are safe', (_name, contractEnum) => {
    for (const [key, value] of Object.entries(contractEnum)) {
      expect(key).toBe(value);
    }
  });
});

describe('derived enum groupings', () => {
  it('lists only real statuses as terminal', () => {
    for (const status of contracts.TERMINAL_VIDEO_STATUSES) {
      expect(Object.values(contracts.VideoStatus)).toContain(status);
    }
  });

  it('does not treat a terminal status as a human gate', () => {
    for (const status of contracts.HUMAN_GATE_VIDEO_STATUSES) {
      expect(contracts.TERMINAL_VIDEO_STATUSES).not.toContain(status);
    }
  });

  it('excludes UNKNOWN from the publishable licence statuses', () => {
    expect(contracts.PUBLISHABLE_LICENSE_STATUSES).not.toContain(contracts.LicenseStatus.UNKNOWN);
    expect(contracts.PUBLISHABLE_LICENSE_STATUSES).toContain(contracts.LicenseStatus.AI_GENERATED);
  });
});

describe('money helpers', () => {
  it('round-trips USD through micro-USD', () => {
    expect(contracts.microsToUsd(contracts.usdToMicros(12.34))).toBeCloseTo(12.34, 6);
  });

  it('avoids float drift when summing many small charges', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in integer micros it is exact.
    const total = contracts.usdToMicros(0.1) + contracts.usdToMicros(0.2);
    expect(total).toBe(contracts.usdToMicros(0.3));
  });
});
