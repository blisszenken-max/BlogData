# Overseas Trend Gateway R3 Lite

Practical blog-automation controller. Redis keeps authoritative run/stage state and prevents stale-token stage forks. Stage-internal tools are not individually gated. At the end of each stage, `complete_stage` receives a structured result packet, derives the policy hard-gate metrics in code, and advances only when every hard gate passes.

Runtime operations: `boot`, `inspect`, `complete_stage`, `ready`.

This is intentionally less restrictive than R3 strict mode. It is designed to prevent skipped stages and arbitrary PASS/READY while keeping blog research, image work, Drive work, and document generation flexible inside each stage.
