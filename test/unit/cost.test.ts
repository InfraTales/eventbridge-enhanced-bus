import { breakEvenKb, cheaperUpToKb, classicMonthly, enhancedMonthly, ingressCost } from '../../src/cost/model';

test('reproduces the worked example on the EventBridge pricing page', () => {
  // 1,000 events/s at 2 KB, 2 subscriptions (one JSONata), dedup on, 7-day retention,
  // 1% failures with 3 retries. The page lists $922, $518, $16, $778, $83 = $2,317.
  const b = enhancedMonthly({
    eventsPerMonth: 1000 * 86_400 * 30,
    avgEventKb: 2,
    subscribers: 2,
    retentionDays: 7,
    jsonataSubscribers: 1,
    contentBasedDedup: true,
    failureRate: 0.01,
    retriesPerFailure: 3,
  });
  expect(Math.round(b.ingress as number)).toBe(922);
  expect(Math.round(b.egress as number)).toBe(518);
  expect(Math.round(b.egressRetries as number)).toBe(16);
  expect(Math.round(b.evaluation as number)).toBe(778);
  expect(Math.round(b.storage as number)).toBe(83);
  expect(Math.round(b.total)).toBe(2317);
});

test('reproduces the pricing page ingress/egress example: 1M events at 2 KB to 2 subscriptions = $0.56', () => {
  const b = enhancedMonthly({ eventsPerMonth: 1_000_000, avgEventKb: 2, subscribers: 2, retentionDays: 1 });
  expect(b.total).toBe(0.56);
});

test('reproduces the Classic archive and replay example: $5.40', () => {
  const b = classicMonthly({ eventsPerMonth: 2_000_000, avgEventKb: 6, archive: true, replayedEvents: 2_000_000 });
  // The page rounds each line before adding: $2.00 + $1.14 + $0.26 + $2.00 = $5.40.
  expect([b.ingestion, b.archiveProcessing, b.archiveStorage, b.replay]).toEqual([2, 1.14, 0.26, 2]);
  expect(b.total).toBeCloseTo(5.4, 1);
});

test('events round up to a whole KB on the enhanced bus', () => {
  expect(enhancedMonthly({ eventsPerMonth: 1_000_000, avgEventKb: 0.2, subscribers: 0, retentionDays: 1 }).ingress).toBe(0.18);
});

test('Classic bills each 64 KB chunk as one event', () => {
  expect(classicMonthly({ eventsPerMonth: 1_000_000, avgEventKb: 256 }).ingestion).toBe(4);
});

test('ingress tiers apply in order', () => {
  expect(ingressCost(5_184)).toBeCloseTo(5_000 * 0.18 + 184 * 0.12, 6);
});

test('break-even size falls as subscribers grow', () => {
  expect(breakEvenKb(2)).toBeCloseTo(1 / 0.28, 6);
  expect(breakEvenKb(10)).toBeCloseTo(1 / 0.68, 6);
});

test('break-even counts retention past the first day', () => {
  // 7 days kept: 6 extra days of each GB at $0.08 per GB-month adds 0.016 per KB per million.
  expect(breakEvenKb(2, 7)).toBeCloseTo(1 / 0.296, 6);
  expect(breakEvenKb(2, 1)).toBeCloseTo(1 / 0.28, 6);
});

test('with two subscribers and 7 days kept, the enhanced bus is cheaper up to 3 KB billed', () => {
  expect(cheaperUpToKb(2, 7)).toBe(3);
  const at = (kb: number) => enhancedMonthly({ eventsPerMonth: 1_000_000, avgEventKb: kb, subscribers: 2, retentionDays: 7 }).total;
  expect(at(3)).toBeLessThan(1);
  expect(at(4)).toBeGreaterThan(1);
});

test('replaying the last 7 days: enhanced billed as egress (assumed), Classic as new events', () => {
  const replayed = (10_000_000 * 7) / 30;
  const e = enhancedMonthly({ eventsPerMonth: 10_000_000, avgEventKb: 1, subscribers: 2, retentionDays: 7, replayedEvents: replayed });
  expect(e.replay).toBe(0.12); // 2.33 GB x $0.05
  expect(e.total).toBe(3.08);
  const c = classicMonthly({ eventsPerMonth: 10_000_000, avgEventKb: 1, archive: true, archiveMonthsKept: 7 / 30, replayedEvents: replayed });
  expect(c.replay).toBe(2.33);
  expect(c.total).toBe(13.34);
});
