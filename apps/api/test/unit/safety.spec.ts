import { evaluateRules, verdictFromRules, worstVerdict } from '@/modules/safety/safety.service';
import { SAFETY_RULES } from '@/modules/safety/safety-rules';
import { redact, redactString } from '@/common/utils/redact';

const SCRIPT = 'SCRIPT';

describe('safety rule catalogue', () => {
  it('has unique rule ids', () => {
    const ids = SAFETY_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every BLOCK rule full weight, which is what makes it blocking', () => {
    for (const rule of SAFETY_RULES.filter((r) => r.action === 'BLOCK')) {
      expect(rule.weight).toBe(1);
    }
  });

  it('gives every rule a human-readable description', () => {
    for (const rule of SAFETY_RULES) {
      expect(rule.description.length).toBeGreaterThan(10);
    }
  });
});

describe('evaluateRules', () => {
  it('passes wholesome content', () => {
    const findings = evaluateRules(
      'Baby Leo giggles as Ducky waddles across the sunny kitchen floor.',
      SCRIPT,
    );
    expect(findings).toEqual([]);
  });

  it('flags sexualised description of a character', () => {
    const findings = evaluateRules('the toddler wears a tiny bikini and poses', SCRIPT);
    expect(findings.some((f) => f.category === 'CHILD_SAFETY')).toBe(true);
  });

  it('flags a reference to a real child', () => {
    const findings = evaluateRules('a photo of a child from my neighbour', SCRIPT);
    expect(findings.some((f) => f.category === 'CHILD_SAFETY')).toBe(true);
  });

  it('flags third-party franchises', () => {
    const findings = evaluateRules('Baby Leo meets Peppa Pig in the garden', SCRIPT);
    expect(findings.some((f) => f.category === 'COPYRIGHT_RISK')).toBe(true);
  });

  it('flags intent to copy another creator', () => {
    const findings = evaluateRules('recreate this video from a popular channel', SCRIPT);
    expect(findings.some((f) => f.category === 'COPYRIGHT_RISK')).toBe(true);
  });

  it('flags dangerous challenges', () => {
    const findings = evaluateRules('the blackout challenge is trending', SCRIPT);
    expect(findings.some((f) => f.category === 'DANGEROUS_CHALLENGE')).toBe(true);
  });

  it('flags graphic violence', () => {
    const findings = evaluateRules('a scene full of gore and torture', SCRIPT);
    expect(findings.some((f) => f.category === 'VIOLENCE')).toBe(true);
  });

  it('uses word boundaries so innocent words are not matched', () => {
    // "gun" must not match inside "begun"; "shoot" must not match "shooting star"
    // via a partial word. Both of these are ordinary children's-story words.
    expect(evaluateRules('the story had begun at sunrise', SCRIPT)).toEqual([]);
    expect(evaluateRules('a classic scunthorpe problem', SCRIPT)).toEqual([]);
  });

  it('includes an excerpt so a reviewer can see the trigger', () => {
    const findings = evaluateRules(
      'a long and gentle story about a garden, then suddenly gore appears, then calm again',
      SCRIPT,
    );
    expect(findings[0]?.excerpt).toContain('gore');
  });

  it('is case-insensitive', () => {
    expect(evaluateRules('GORE everywhere', SCRIPT).length).toBeGreaterThan(0);
  });
});

describe('verdictFromRules', () => {
  it('allows content with no findings', () => {
    expect(verdictFromRules([], 'review')).toBe('ALLOW');
  });

  it('blocks when a categorical rule matched', () => {
    const findings = evaluateRules('explicit sex scene', SCRIPT);
    expect(verdictFromRules(findings, 'review')).toBe('BLOCK');
  });

  it('reviews a single low-confidence finding', () => {
    const findings = evaluateRules('he holds a knife to cut the cake', SCRIPT);
    expect(verdictFromRules(findings, 'review')).toBe('REVIEW');
  });

  it('escalates an accumulation of weak signals per configuration', () => {
    const weak = [
      { category: 'PROFANITY' as const, confidence: 0.6, reason: 'a' },
      { category: 'VIOLENCE' as const, confidence: 0.6, reason: 'b' },
      { category: 'REAL_PERSON' as const, confidence: 0.6, reason: 'c' },
    ];
    expect(verdictFromRules(weak, 'review')).toBe('REVIEW');
    expect(verdictFromRules(weak, 'block')).toBe('BLOCK');
  });

  it('never returns ALLOW once anything matched', () => {
    const findings = evaluateRules('a knife on the table', SCRIPT);
    expect(verdictFromRules(findings, 'review')).not.toBe('ALLOW');
  });
});

describe('worstVerdict', () => {
  it('picks the more severe of two verdicts', () => {
    expect(worstVerdict('ALLOW', 'REVIEW')).toBe('REVIEW');
    expect(worstVerdict('REVIEW', 'BLOCK')).toBe('BLOCK');
    expect(worstVerdict('BLOCK', 'ALLOW')).toBe('BLOCK');
    expect(worstVerdict('ALLOW', 'ALLOW')).toBe('ALLOW');
  });
});

describe('log redaction', () => {
  it('masks values under sensitive keys', () => {
    const result = redact({
      user: 'admin',
      password: 'hunter2',
      apiKey: 'sk-abcdefghijklmnop',
      nested: { clientSecret: 'shh' },
    }) as Record<string, unknown>;

    expect(result.user).toBe('admin');
    expect(result.password).toBe('[redacted]');
    expect(result.apiKey).toBe('[redacted]');
    expect((result.nested as Record<string, unknown>).clientSecret).toBe('[redacted]');
  });

  it('masks credential-shaped values even under innocuous keys', () => {
    expect(redactString('token is sk-abcdefghij1234567890')).not.toContain('sk-abcdefghij');
    expect(redactString('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain(
      'Bearer [redacted]',
    );
    expect(redactString('refresh 1//0abcdefghijklmnop')).not.toContain('1//0abcdefghij');
    expect(redactString('key AIzaSyA1234567890abcdefghijklmnop')).not.toContain('AIzaSy');
  });

  it('masks credentials embedded in a connection string', () => {
    const redacted = redactString('postgresql://shorts:s3cr3t@db:5432/shorts');
    expect(redacted).not.toContain('s3cr3t');
    expect(redacted).toContain('shorts:[redacted]@');
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect((redact(node) as Record<string, unknown>).self).toBe('[circular]');
  });

  it('serialises errors without losing the message', () => {
    const result = redact(new Error('something failed')) as Record<string, unknown>;
    expect(result.name).toBe('Error');
    expect(result.message).toBe('something failed');
  });

  it('summarises buffers rather than dumping bytes', () => {
    expect(redact(Buffer.alloc(1024))).toBe('[buffer 1024 bytes]');
  });

  it('bounds depth so a deep object cannot stall logging', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[max depth]');
  });
});
