/**
 * Monthly cost model for the enhanced custom event bus and the Classic bus, us-east-1.
 *
 * Prices come from the AWS Price List API offer file for AWSEvents, us-east-1,
 * publication 2026-09-24T16:39:03Z, and from https://aws.amazon.com/eventbridge/pricing/
 * (both checked 2026-10-16). Each page's own unit conventions are kept:
 * - Enhanced bus: events round up to a whole KB; 1 GB = 1,000,000 KB, as in the
 *   pricing page's worked example ("Ingress tier assumes 1 TB = 1,000 GB").
 * - Classic bus: each 64 KB chunk of a payload is billed as one event. The archive
 *   example on the pricing page divides KB by 1024 * 1024 to get GB.
 */

export const ENHANCED = {
  /** Ingress per GB, tiered by monthly GB. */
  ingressTiers: [
    { upToGb: 5_000, perGb: 0.18 },
    { upToGb: 25_000, perGb: 0.12 },
    { upToGb: 125_000, perGb: 0.08 },
    { upToGb: Number.POSITIVE_INFINITY, perGb: 0.05 },
  ],
  egressPerGb: 0.05,
  /** Storage beyond the first 24 hours, which are included. */
  retentionPerGbMonth: 0.08,
  /** JSONata transformation, Avro/Protobuf deserialization, content-based dedup. Per 64 KB chunk. */
  evaluationPerMillion: 0.15,
} as const;

export const CLASSIC = {
  perMillionEvents: 1.0,
  /** Delivery to a target in the same account is free; another account costs $0.05 per million. */
  crossAccountPerMillion: 0.05,
  archivePerGb: 0.1,
  archiveStoragePerGbMonth: 0.023,
} as const;

export interface EnhancedInput {
  eventsPerMonth: number;
  avgEventKb: number;
  subscribers: number;
  retentionDays: number;
  /** Subscribers that run a JSONata transformation. */
  jsonataSubscribers?: number;
  /** Publish with DeduplicationType=CONTENT_BASED. A DeduplicationId you supply is not billed. */
  contentBasedDedup?: boolean;
  /** Share of deliveries that fail and are retried. */
  failureRate?: number;
  retriesPerFailure?: number;
  daysInMonth?: number;
}

export interface Breakdown {
  [line: string]: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function ingressCost(gb: number): number {
  let remaining = gb;
  let floor = 0;
  let cost = 0;
  for (const tier of ENHANCED.ingressTiers) {
    const inTier = Math.min(remaining, tier.upToGb - floor);
    if (inTier <= 0) break;
    cost += inTier * tier.perGb;
    remaining -= inTier;
    floor = tier.upToGb;
  }
  return cost;
}

export function enhancedMonthly(input: EnhancedInput): Breakdown {
  const billableKb = Math.ceil(input.avgEventKb);
  const chunks = Math.ceil(input.avgEventKb / 64);
  const ingressGb = (input.eventsPerMonth * billableKb) / 1_000_000;
  const egressGb = ingressGb * input.subscribers;
  const retryGb = egressGb * (input.failureRate ?? 0) * (input.retriesPerFailure ?? 0);
  const evaluations =
    input.eventsPerMonth * chunks * ((input.contentBasedDedup ? 1 : 0) + (input.jsonataSubscribers ?? 0));
  // Same method as the pricing page example: daily GB times the days kept beyond the included first day.
  const dailyGb = ingressGb / (input.daysInMonth ?? 30);
  const storedGb = dailyGb * Math.max(0, input.retentionDays - 1);
  const lines = {
    ingress: ingressCost(ingressGb),
    egress: egressGb * ENHANCED.egressPerGb,
    egressRetries: retryGb * ENHANCED.egressPerGb,
    evaluation: (evaluations / 1_000_000) * ENHANCED.evaluationPerMillion,
    storage: storedGb * ENHANCED.retentionPerGbMonth,
  };
  const out: Breakdown = { total: 0 };
  for (const [k, v] of Object.entries(lines)) out[k] = round2(v);
  out.total = round2(Object.values(lines).reduce((a, b) => a + b, 0));
  return out;
}

export interface ClassicInput {
  eventsPerMonth: number;
  avgEventKb: number;
  /** Targets in another account. Same-account targets are free. */
  crossAccountTargets?: number;
  /** Archive every event so you can replay it. */
  archive?: boolean;
  /** Archived data kept on average, in months. One month of retention is about 1. */
  archiveMonthsKept?: number;
  /** Events replayed from the archive this month. Billed like new custom events. */
  replayedEvents?: number;
}

export function classicMonthly(input: ClassicInput): Breakdown {
  const chunks = Math.ceil(input.avgEventKb / 64);
  const archiveGb = (input.eventsPerMonth * input.avgEventKb) / (1024 * 1024);
  const lines = {
    ingestion: ((input.eventsPerMonth * chunks) / 1_000_000) * CLASSIC.perMillionEvents,
    crossAccountDelivery:
      ((input.eventsPerMonth * chunks * (input.crossAccountTargets ?? 0)) / 1_000_000) * CLASSIC.crossAccountPerMillion,
    archiveProcessing: input.archive ? archiveGb * CLASSIC.archivePerGb : 0,
    archiveStorage: input.archive ? archiveGb * (input.archiveMonthsKept ?? 1) * CLASSIC.archiveStoragePerGbMonth : 0,
    replay: (((input.replayedEvents ?? 0) * chunks) / 1_000_000) * CLASSIC.perMillionEvents,
  };
  const out: Breakdown = { total: 0 };
  for (const [k, v] of Object.entries(lines)) out[k] = round2(v);
  out.total = round2(Object.values(lines).reduce((a, b) => a + b, 0));
  return out;
}

/**
 * Event size, in KB, where the enhanced bus's ingress plus egress (first ingress tier,
 * no evaluation features) costs the same as the Classic bus's $1 per million events.
 * A million events of s KB is s GB, so the enhanced bus costs s * (0.18 + 0.05 * n) dollars.
 */
export function breakEvenKb(subscribers: number): number {
  const perKbPerMillion = (ENHANCED.ingressTiers[0] as { perGb: number }).perGb + ENHANCED.egressPerGb * subscribers;
  return CLASSIC.perMillionEvents / perKbPerMillion;
}
