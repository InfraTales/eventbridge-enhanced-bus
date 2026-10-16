# Cost

All prices are for us-east-1. They come from the AWS Price List API offer file for `AWSEvents` (publication 2026-09-24) and from the [EventBridge pricing page](https://aws.amazon.com/eventbridge/pricing/), both read on 2026-10-16. Check them again before you rely on them.

## How the enhanced bus bills

| Item | Price | Note |
|---|---|---|
| Ingress, first 5,000 GB a month | $0.18 per GB | Then $0.12, $0.08 and $0.05 per GB in higher tiers |
| Egress to subscribers | $0.05 per GB | Charged once per subscriber that receives the event |
| Retention past 24 hours | $0.08 per GB-month | The first 24 hours are included |
| JSONata transformation | $0.15 per million events | Per subscriber that uses it, metered in 64 KB chunks |
| Content-based deduplication | $0.15 per million events | A `DeduplicationId` you supply isn't billed |
| Avro or Protobuf deserialization | $0.15 per million events | Not used here |

Every event rounds up to a whole KB. The pricing page counts 1 GB as 1,000,000 KB, and the cost model does the same. The AWS News Blog puts it this way: "Publishers pay for events ingested, and subscribers pay for events delivered." AWS lists no free tier for the enhanced bus.

The Classic bus charges $1.00 per million custom events, where each 64 KB chunk counts as one event. Delivery to a target in the same account is free. Replay needs an archive: $0.10 per GB archived, $0.023 per GB-month stored, and replayed events billed again as new events.

## This stack at 10 million events a month

The table below comes from `npm run cost`. It assumes two same-account subscribers and 7 days of retention, and leaves out Lambda, SQS and DynamoDB:

| Event size | Enhanced | Enhanced + JSONata on one subscriber | Classic | Classic + archive and one full replay |
|---|---|---|---|---|
| 1 KB | $2.96 | $4.46 | $10.00 | $21.00 |
| 2 KB | $5.92 | $7.42 | $10.00 | $22.01 |
| 4 KB | $11.84 | $13.34 | $10.00 | $24.02 |
| 16 KB | $47.36 | $48.86 | $10.00 | $36.08 |
| 64 KB | $189.44 | $190.94 | $10.00 | $84.31 |

The enhanced bus charges by size, and the Classic bus charges by count. A million events of S KB is S GB, so with N subscribers the enhanced bus costs S x (0.18 + 0.05 x N) dollars per million events in the first ingress tier. That equals the Classic bus's $1.00 at:

| Subscribers | Break-even event size |
|---|---|
| 1 | 4.35 KB |
| 2 | 3.57 KB |
| 5 | 2.33 KB |
| 10 | 1.47 KB |

Below that size the enhanced bus costs less, before you count retention and evaluation features. Above it the Classic bus costs less, unless you need ordering, deduplication, or retention you'd otherwise build yourself.

## Checking the model

`test/unit/cost.test.ts` runs the model against the three worked examples on the pricing page and gets the same numbers:

- The enhanced bus example: 1,000 events per second at 2 KB with two subscriptions comes to $2,317 a month.
- The ingress and egress example comes to $0.56.
- The Classic archive and replay example comes to $5.40.

The storage line follows the pricing page's method: daily GB times the days kept past the first.

Two things on the pricing page don't match the docs. The worked example says the default retry policy makes 3 retries, while the retry docs say 5 attempts or 300 seconds. The example also counts content-based deduplication without saying it's turned on.

## Keeping it low

- Supply a `DeduplicationId` instead of `CONTENT_BASED`. It deduplicates the same way and costs nothing extra.
- Keep events small, because every subscriber pays egress on every byte. Put large payloads in Amazon S3 and send a pointer.
- Each subscriber adds egress. If two teams want the same events with the same filter, one subscriber and a fan-out downstream may cost less.
- Retention past 24 hours costs $0.08 per GB-month. Pick the shortest window that still covers your longest outage and your rebuild needs.
