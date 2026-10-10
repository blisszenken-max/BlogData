# Trend Blog v23.145 — Image pipeline route boundary

This file is operational routing documentation only; it does not change the existing downloader code or GitHub issue workflow.

## GP04.5 real-photo download — UNCHANGED
- Public repository: `blisszenken-max/BlogData`
- Existing singleton request issue: #60, reopened, JSON body `{request_id, assets:[{id,url}]}`
- Existing workflow: `.github/workflows/image_asset_fetch.yml`
- Existing results: `image-fetch-results-{workflow_run_id}`; 1-day artifact retention.
- Current rights/source/identity candidate screening and GitHub remote download verification remain mandatory.
- A workflow PASS without actual downloaded file bytes and matching SHA is NOT a real asset acquisition PASS.
- Never put private Codex prompts or ChatGPT login credentials in the public issue or repository.

## GP04.6 generated-scene image — NEW SEPARATE ROUTE
- Private repository: `blisszenken-max/codex-image-runner`.
- Workflow: `.github/workflows/codex-image-private-request.yml`, triggered by a new private issue with title `CODEX_IMAGE_JOB: <request_id>`.
- Ephemeral input: `CODEX_PRIVATE_IMAGE_REQUEST_V1` derived from the SAME canonical current-run Google Drive plan, verified `PRODUCTION_READY` and prompt SHA; per Visual ID locked original prompt only.
- Each Visual ID invokes a separate ChatGPT-authenticated Codex CLI process with the built-in ImageGen capability. Never call Images API directly or copy source from another target.
- Private result: `codex-private-image-result-{github_run_id}` artifact (PNG + `result.json` + sanitized event types only), 7-day retention.
- Re-fetch actual artifact bytes and independently verify image SHA/dimensions/decode. `PNG_PASS_SEMANTIC_PENDING` is NOT GP04.7 semantic/editorial acceptance.
- Original Google Drive image plan remains the sole authoritative plan, with normal `PLANNED -> PRODUCTION_READY -> FINAL` writes. No additional persistent master or unverified PASS.

## Safety and fallbacks
- `CODEX_AUTH_JSON` is PRIVATE runner GitHub Secret; no tokens in BlogData. CI refresh/expiration remains unproven for indefinite unattended use; fail closed on unavailable auth.
- No GP order, image quantity, Content QA/Visual QA or full-article summary infographic restrictions are relaxed.
- Do not repurpose the existing downloader issue #60, change `image_asset_fetch_cleanup.yml`, or treat a private output as a genuine sourced real product photo.
- A user-requested runtime integration tests cross-repo orchestration via connected GitHub issue creation and result artifacts. Native automatic invocation from a generic scheduled blog Run remains a distinct E2E evidence requirement.
