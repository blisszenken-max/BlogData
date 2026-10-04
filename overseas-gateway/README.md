# Overseas Trend Gateway — Vercel Hobby prototype

Purpose: move execution authority out of the LLM. The gateway does not write blog content or render images/docs. It validates signed run state, stage transitions, hard gates, and tool grants against the frozen v9.76 compiled contract.

## Deploy
1. Create a Vercel Hobby project from this repository.
2. Set Root Directory to `overseas-gateway`.
3. Add environment variable `GATEWAY_SECRET` with a random value of at least 32 bytes. Never commit it.
4. Deploy.
5. `GET /api/health` must report policy `v9.76`, the frozen policy SHA-256, and 19 stages.

## Core operations
`boot`, `inspect`, `bump_context`, `grant`, `authorize`, `commit`, `close_stage`, `ready`.

## How the compact contract works
The full 5,426-clause contract does not have to live in the serverless bundle. Each stage stores a canonical `contract_digest`, required rule-unit count, and required clause count. On `close_stage`, the submitted unit/source/clause projection is re-hashed and must exactly equal that digest. A missing, extra, or modified clause changes the digest and blocks the stage.

## Security model
- HMAC-signed state and grant tokens.
- Payload hash binding for grants.
- PASS / NOT_APPLICABLE only; FAIL, REPAIR_REQUIRED, PENDING, and MISSING cannot close a stage.
- NOT_APPLICABLE requires original condition + reason + evidence.
- Hard-gate metrics are evaluated in code.
- F15 commit requires F14 closed and exact saved-byte readback.
- Model text cannot set READY. Only F18 close can produce terminal DONE.

## Hobby design choices
- No database.
- No image generation, crawling, DOCX rendering, or heavy compute in Vercel.
- Heavy work remains in GitHub Actions/native tools.
- Stateless mode has no global one-time replay ledger. Old valid state tokens can fork a run, but cannot skip stages or forge a later stage. Persistent replay protection can be added later only if needed.

## Important enforcement boundary
This Gateway can physically enforce execution only for tools that are actually routed through it. If a ChatGPT host still exposes native tools directly, those direct calls are outside the proxy. They must not be treated as valid execution evidence unless a matching Gateway grant/authorization receipt exists.
