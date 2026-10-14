import {
  addDays,
  dayKey,
  formatDuration,
  getZonedParts,
  hoursBetween,
  isValidTimezone,
  monthKey,
  nextSlotOccurrence,
  startOfDayInZone,
  startOfMonthInZone,
  zonedWallTimeToUtc,
} from '@/common/utils/time';

const BERLIN = 'Europe/Berlin';

describe('isValidTimezone', () => {
  it('accepts IANA zones and rejects nonsense', () => {
    expect(isValidTimezone(BERLIN)).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('getZonedParts', () => {
  it('converts an instant to Berlin wall-clock time in winter (UTC+1)', () => {
    const parts = getZonedParts(new Date('2026-01-15T08:30:00Z'), BERLIN);
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 15, hour: 9, minute: 30 });
  });

  it('accounts for summer time (UTC+2)', () => {
    const parts = getZonedParts(new Date('2026-07-15T08:30:00Z'), BERLIN);
    expect(parts.hour).toBe(10);
  });

  it('reports weekday with Sunday as 0', () => {
    // 2026-09-06 is a Sunday.
    expect(getZonedParts(new Date('2026-09-06T12:00:00Z'), BERLIN).weekday).toBe(0);
    expect(getZonedParts(new Date('2026-09-07T12:00:00Z'), BERLIN).weekday).toBe(1);
  });
});

describe('zonedWallTimeToUtc', () => {
  it('maps 09:00 Berlin winter time to 08:00 UTC', () => {
    const utc = zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, BERLIN);
    expect(utc.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('maps 09:00 Berlin summer time to 07:00 UTC', () => {
    const utc = zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, BERLIN);
    expect(utc.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('round-trips through getZonedParts', () => {
    const utc = zonedWallTimeToUtc({ year: 2026, month: 3, day: 20, hour: 15, minute: 45 }, BERLIN);
    expect(getZonedParts(utc, BERLIN)).toMatchObject({ hour: 15, minute: 45, day: 20 });
  });

  it('resolves a spring-forward gap to a real instant rather than hanging', () => {
    // 2026-03-29 02:30 Berlin does not exist; clocks jump 02:00 -> 03:00.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN);
    expect(Number.isNaN(utc.getTime())).toBe(false);
    // It must land on the far side of the transition, i.e. already at UTC+2.
    expect(getZonedParts(utc, BERLIN).hour).toBe(3);
  });

  it('resolves a fall-back overlap deterministically', () => {
    // 2026-10-25 02:30 Berlin happens twice; the earlier (CEST) one is chosen.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN);
    expect(utc.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('dayKey / monthKey', () => {
  it('uses local calendar boundaries, not UTC ones', () => {
    // 22:30 UTC on 14 Jan is already 23:30 on 14 Jan in Berlin.
    expect(dayKey(new Date('2026-01-14T22:30:00Z'), BERLIN)).toBe('2026-01-14');
    // 23:30 UTC is 00:30 on 15 Jan in Berlin — a different quota day.
    expect(dayKey(new Date('2026-01-14T23:30:00Z'), BERLIN)).toBe('2026-01-15');
  });

  it('formats month keys with padding', () => {
    expect(monthKey(new Date('2026-03-05T12:00:00Z'), BERLIN)).toBe('2026-03');
  });
});

describe('startOfDayInZone / startOfMonthInZone', () => {
  it('returns local midnight as a UTC instant', () => {
    const start = startOfDayInZone(new Date('2026-07-15T14:00:00Z'), BERLIN);
    expect(start.toISOString()).toBe('2026-07-14T22:00:00.000Z');
  });

  it('returns the first day of the local month', () => {
    const start = startOfMonthInZone(new Date('2026-07-15T14:00:00Z'), BERLIN);
    expect(getZonedParts(start, BERLIN)).toMatchObject({ day: 1, hour: 0, month: 7 });
  });
});

describe('nextSlotOccurrence', () => {
  it('returns null when there are no slots', () => {
    expect(nextSlotOccurrence([], BERLIN, new Date('2026-01-15T08:00:00Z'))).toBeNull();
  });

  it('picks the next daily slot later today', () => {
    const from = new Date('2026-01-15T08:00:00Z'); // 09:00 Berlin
    const next = nextSlotOccurrence(
      [
        { dayOfWeek: null, hour: 15, minute: 0 },
        { dayOfWeek: null, hour: 20, minute: 0 },
      ],
      BERLIN,
      from,
    );
    expect(next?.toISOString()).toBe('2026-01-15T14:00:00.000Z'); // 15:00 Berlin
  });

  it('rolls over to tomorrow when every slot has passed', () => {
    const from = new Date('2026-01-15T21:00:00Z'); // 22:00 Berlin
    const next = nextSlotOccurrence([{ dayOfWeek: null, hour: 9, minute: 0 }], BERLIN, from);
    expect(next?.toISOString()).toBe('2026-01-16T08:00:00.000Z');
  });

  it('honours a weekday restriction', () => {
    const from = new Date('2026-09-07T06:00:00Z'); // Monday
    // Only Wednesdays (3).
    const next = nextSlotOccurrence([{ dayOfWeek: 3, hour: 9, minute: 0 }], BERLIN, from);
    expect(getZonedParts(next!, BERLIN).weekday).toBe(3);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('returns the earliest of several competing slots', () => {
    const from = new Date('2026-01-15T08:00:00Z');
    const next = nextSlotOccurrence(
      [
        { dayOfWeek: null, hour: 20, minute: 0 },
        { dayOfWeek: null, hour: 11, minute: 30 },
        { dayOfWeek: null, hour: 15, minute: 0 },
      ],
      BERLIN,
      from,
    );
    expect(getZonedParts(next!, BERLIN)).toMatchObject({ hour: 11, minute: 30 });
  });

  it('includes a slot occurring exactly now', () => {
    const from = zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, BERLIN);
    const next = nextSlotOccurrence([{ dayOfWeek: null, hour: 9, minute: 0 }], BERLIN, from);
    expect(next?.getTime()).toBe(from.getTime());
  });

  it('stays correct across a DST boundary', () => {
    // Friday 27 March 2026, asking for 09:00 daily; the change is on the 29th.
    const from = new Date('2026-03-27T12:00:00Z');
    const next = nextSlotOccurrence([{ dayOfWeek: null, hour: 9, minute: 0 }], BERLIN, from);
    expect(getZonedParts(next!, BERLIN).hour).toBe(9);
  });
});

describe('date arithmetic helpers', () => {
  it('adds days as fixed 24h increments', () => {
    expect(addDays(new Date('2026-01-01T00:00:00Z'), 3).toISOString()).toBe(
      '2026-01-04T00:00:00.000Z',
    );
  });

  it('measures fractional hours between instants', () => {
    expect(
      hoursBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T06:30:00Z')),
    ).toBeCloseTo(6.5);
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(5_400)).toBe('5.4s');
    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(formatDuration(7_200_000)).toBe('2h 0m');
  });
});
