import { schedulePublishSchema } from '@shorts/contracts';

/**
 * The publish request the dashboard actually sends.
 *
 * "Publish now" posts `{ publishAt: null }`. The schema required a channelId, so
 * the button failed with "Request validation failed" on the first real attempt.
 */
describe('schedulePublishSchema', () => {
  it("accepts the dashboard's Publish now payload", () => {
    const parsed = schedulePublishSchema.safeParse({ publishAt: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.channelId).toBeUndefined();
  });

  it('accepts an empty body, defaulting to publish immediately', () => {
    const parsed = schedulePublishSchema.parse({});
    expect(parsed.publishAt).toBeNull();
  });

  it('still validates a channel id when one is given', () => {
    expect(schedulePublishSchema.safeParse({ channelId: '' }).success).toBe(false);
  });

  it('still rejects a malformed publish time', () => {
    expect(schedulePublishSchema.safeParse({ publishAt: 'tomorrow-ish' }).success).toBe(false);
  });
});
