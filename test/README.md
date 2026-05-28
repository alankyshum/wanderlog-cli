# Wanderlog CLI Test Guide

Run the in-repo CLI unit tests from the repository root:

```bash
node --test test/
```

Run Worker subscription tests separately:

```bash
node --test worker/test/
```

These tests use `node:test` and `node:assert/strict` only. They do not make real network calls, do not require real Wanderlog credentials, and use sanitized fixtures only.

Live smoke tests for authenticated Wanderlog mutations and calendar deployment checks are intentionally not in this directory. Phase F/P live checks must be gated behind explicit environment variables and run separately.
