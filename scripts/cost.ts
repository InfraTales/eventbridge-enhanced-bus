/**
 * Prints monthly cost comparisons for the enhanced and Classic buses (us-east-1).
 * npm run cost
 */
import { breakEvenKb, classicMonthly, enhancedMonthly } from '../src/cost/model';

const fmt = (n: number) => `$${n.toFixed(2)}`;

console.log('10 million order events a month, two same-account subscribers, 7-day retention\n');
console.log('| Event size | Enhanced (no extras) | Enhanced + JSONata on 1 sub | Classic | Classic + archive and one full replay |');
console.log('|---|---|---|---|---|');
for (const kb of [1, 2, 4, 16, 64]) {
  const base = { eventsPerMonth: 10_000_000, avgEventKb: kb, subscribers: 2, retentionDays: 7 };
  const e = enhancedMonthly(base);
  const ej = enhancedMonthly({ ...base, jsonataSubscribers: 1 });
  const c = classicMonthly({ eventsPerMonth: 10_000_000, avgEventKb: kb });
  const ca = classicMonthly({ eventsPerMonth: 10_000_000, avgEventKb: kb, archive: true, archiveMonthsKept: 7 / 30, replayedEvents: 10_000_000 });
  console.log(`| ${kb} KB | ${fmt(e.total)} | ${fmt(ej.total)} | ${fmt(c.total)} | ${fmt(ca.total)} |`);
}

console.log('\nBreak-even event size (enhanced ingress + egress vs Classic $1 per million):');
for (const n of [1, 2, 5, 10]) console.log(`  ${n} subscriber(s): ${breakEvenKb(n).toFixed(2)} KB`);
