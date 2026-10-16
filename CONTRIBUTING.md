# Contributing

Thanks for helping. This repo shows the enhanced EventBridge bus with tests you can trust, so every change has to keep the tests honest about which parts are the model and which parts are real.

## Setup

You need Node.js 24 and npm. Docker is only needed for the integration tests.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
docker run -d --rm -p 8025:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8025 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `src/contract/` | The event contract shared by the publisher and both subscribers |
| `src/publisher/` | Per-order ordered publishing with retries, and the Lambda handler |
| `src/ledger/` | The ledger's conditional write and the Lambda handler |
| `src/model/` | The bus model used by tests. Not EventBridge |
| `src/cost/` | The monthly cost model |
| `infra/lib/` | The CDK stack and the typed `AWS::EventsV2` wrappers |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/int` | Tests against DynamoDB Local, including the end-to-end flow |
| `scripts/` | Bundling, the cost tables and the smoke test |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. Then break your safeguard once on purpose and check that a test goes red.
- **A source for any new bus behaviour.** If you change the model, link the EventBridge doc page in a comment. If the docs don't say, mark the choice `ASSUMPTION`.
- **Property names from the CloudFormation reference** for anything in `infra/lib/eventsv2.ts`.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour or prices change.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
