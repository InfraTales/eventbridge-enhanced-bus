# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

[docs/security.md](docs/security.md) has the details and the reasons. In short:

- The publisher can only call `events:PutEvents` on this one bus.
- Each subscriber has its own delivery role, trusted only by EventBridge, with access to one target and its dead-letter queue.
- The publisher checks every event against a strict contract, and the ledger checks it again on delivery.
- Every queue uses encryption and refuses plain HTTP. Every subscriber has a dead-letter queue with an alarm.
