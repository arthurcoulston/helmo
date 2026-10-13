export type HistoryPeriod = 'day' | 'week' | 'month';

export type HistoryEvent = {
  at: string;
  actor?: string | null;
  ref: string;
};

export type TestResultEvent = HistoryEvent & { failed: number; total: number };

export type HistoryInput = {
  tokens: (HistoryEvent & { value: number })[];
  acceptance_failures: HistoryEvent[];
  test_results: TestResultEvent[];
  incidents: HistoryEvent[];
  recording_began_at: Partial<Record<'tokens' | 'acceptance_failures' | 'test_results' | 'incidents', string>>;
};

export type FailureReading = {
  count: number;
  per_million_tokens: number | null;
  evidence: string[];
  coverage: 'measured' | 'missing';
};

export type HistoryBucket = {
  from: string;
  to: string;
  tokens: number;
  token_coverage: 'measured' | 'missing';
  token_evidence: string[];
  acceptance_failures: FailureReading;
  test_failures: FailureReading & { measured_tests: number };
  incidents: FailureReading;
};

const DAY = 86_400_000;
const PERIODS: Record<HistoryPeriod, { duration: number; bucket: number }> = {
  day: { duration: DAY, bucket: 3_600_000 },
  week: { duration: 7 * DAY, bucket: DAY },
  month: { duration: 30 * DAY, bucket: DAY },
};

const instant = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`History needs an instant; got "${value}".`);
  return parsed;
};

export function history(input: HistoryInput, period: HistoryPeriod, asOf: string, actor?: string): HistoryBucket[] {
  const end = instant(asOf);
  const shape = PERIODS[period];
  const start = end - shape.duration;
  const selected = <T extends HistoryEvent>(events: T[], from: number, to: number) => events.filter((event) => {
    const at = instant(event.at);
    return at >= from && at < to && (!actor || event.actor === actor);
  });
  const coverage = (source: keyof HistoryInput['recording_began_at'], from: number) => {
    const began = input.recording_began_at[source];
    return began && instant(began) <= from ? 'measured' as const : 'missing' as const;
  };
  const reading = (events: HistoryEvent[], tokens: number, source: keyof HistoryInput['recording_began_at'], from: number, count = events.length): FailureReading => ({
    count,
    per_million_tokens: tokens > 0 ? count * 1_000_000 / tokens : null,
    evidence: events.map((event) => event.ref),
    coverage: coverage(source, from),
  });

  return Array.from({ length: shape.duration / shape.bucket }, (_, index) => {
    const from = start + index * shape.bucket;
    const to = from + shape.bucket;
    const tokenEvents = selected(input.tokens, from, to);
    const tokens = tokenEvents.reduce((sum, event) => sum + event.value, 0);
    const acceptance = selected(input.acceptance_failures, from, to);
    const tests = selected(input.test_results, from, to);
    const incidents = selected(input.incidents, from, to);
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      tokens,
      token_coverage: coverage('tokens', from),
      token_evidence: tokenEvents.map((event) => event.ref),
      acceptance_failures: reading(acceptance, tokens, 'acceptance_failures', from),
      test_failures: {
        ...reading(tests, tokens, 'test_results', from, tests.reduce((sum, event) => sum + event.failed, 0)),
        measured_tests: tests.reduce((sum, event) => sum + event.total, 0),
      },
      incidents: reading(incidents, tokens, 'incidents', from),
    };
  });
}
