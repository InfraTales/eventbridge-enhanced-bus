/**
 * Prints monthly cost comparisons for the enhanced and Classic buses (us-east-1).
 * npm run cost
 */
import { breakEvenKb, cheaperUpToKb, classicMonthly, enhancedMonthly } from '../src/cost/model';

const fmt = (n: number) => `$${n.toFixed(2)}`;
const EVENTS = 10_000_000;
const RETENTION_DAYS = 7;
// Both buses can only replay what they still hold: the last 7 days, about 7/30 of the month.
const REPLAYED = (EVENTS * RETENTION_DAYS) / 30;

console.log('10 million order events a month, two same-account subscribers, 7-day retention');
console.log('Replay = read the last 7 days again. Enhanced replay billed as egress: an assumption, no AWS page says.\n');
console.log('| Event size | Enhanced (no extras) | Enhanced + JSONata on 1 sub | Enhanced + replay of 7 days | Classic | Classic + 7-day archive and replay of 7 days |');
console.log('|---|---|---|---|---|---|');
for (const kb of [1, 2, 4, 16, 64]) {
  const base = { eventsPerMonth: EVENTS, avgEventKb: kb, subscribers: 2, retentionDays: RETENTION_DAYS };
  const e = enhancedMonthly(base);
  const ej = enhancedMonthly({ ...base, jsonataSubscribers: 1 });
  const er = enhancedMonthly({ ...base, replayedEvents: REPLAYED });
  const c = classicMonthly({ eventsPerMonth: EVENTS, avgEventKb: kb });
  const ca = classicMonthly({ eventsPerMonth: EVENTS, avgEventKb: kb, archive: true, archiveMonthsKept: RETENTION_DAYS / 30, replayedEvents: REPLAYED });
  console.log(`| ${kb} KB | ${fmt(e.total)} | ${fmt(ej.total)} | ${fmt(er.total)} | ${fmt(c.total)} | ${fmt(ca.total)} |`);
}

console.log('\nBreak-even event size against Classic $1 per million (enhanced: ingress + egress + retention past day 1):');
console.log('| Subscribers | 1-day retention | 7-day retention | Enhanced cheaper up to (whole KB, 7 days) |');
console.log('|---|---|---|---|');
for (const n of [1, 2, 5, 10]) {
  console.log(`| ${n} | ${breakEvenKb(n).toFixed(2)} KB | ${breakEvenKb(n, RETENTION_DAYS).toFixed(2)} KB | ${cheaperUpToKb(n, RETENTION_DAYS)} KB |`);
}
