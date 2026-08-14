# Approval Guardian

This repository publishes host-specific approval gates from one npm workspace:

- [`pi-approval-guardian`](packages/pi-approval-guardian/README.md) for Pi
- [`prime-approval-guardian`](packages/prime-approval-guardian/README.md) for Prime Agent (alpha)

Both host adapters normalize their native tool calls into the same hard-policy and decision contract. Pi and Prime classification, lifecycle wiring, configuration, and defaults remain explicit and separate. Neither package currently implements grants. See each package README for installation and usage.
