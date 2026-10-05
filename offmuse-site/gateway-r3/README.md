# Overseas Trend Gateway R3 — Candidate

R3 is an isolated candidate endpoint. It does not replace the current R2 production gateway.

Key changes: authoritative Redis run state with atomic CAS, stale-token rejection, one-time grant authorization, executor-signed tool/commit attestations, server evidence ledger, and server-derived hard-gate metrics.

R3 boot is intentionally fail-closed until a Redis integration and EXECUTOR_SHARED_SECRET are configured in Vercel. GitHub remains source/deployment transport only and has no PASS/NEXT/COMMIT/READY authority.

Policy authority: v9.76, SHA-256 c12d7cc5a87981d6cc6af52b92fa19c6f5e276a73a37ecf2026984a74fcb0226.
