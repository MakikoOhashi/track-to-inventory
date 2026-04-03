# Cloudflare Renewal Branch Spec

This document is a branch-specific working spec for `codex/cloudflare-renewal`.

Its purpose is to keep the renewal direction clear while the app is gradually refactored.

## Goal

Modernize the current Shopify app so the user-facing app can move toward Cloudflare, while keeping heavy OCR/PDF processing on Render for now.

This is not a full rewrite at once.
This branch is for a staged migration.

## Target Direction

- Shopify embedded app UI runs on Cloudflare
- Shopify app `app URL` and OAuth redirect URLs point to Cloudflare
- Heavy OCR/PDF processing stays on Render during the transition
- Render becomes an internal backend for OCR/PDF and other heavy tasks
- The codebase moves toward a monorepo structure
- The Shopify app runtime moves away from Node-specific Remix assumptions
- React Router is the target direction for the app shell

## Why This Direction

Current pain points:

- Render cold starts hurt first-load UX
- Current app is tightly coupled to Node-specific server behavior
- OCR/PDF processing is heavy and not a good fit for Cloudflare Workers
- The codebase contains legacy layers from earlier implementation stages

Expected benefits:

- Faster initial app load on Cloudflare
- Safer staged migration instead of a risky full rewrite
- Better separation between UI/auth and heavy processing
- Easier long-term maintenance

## Architecture Goal

Planned structure:

- `apps/web`
  Shopify embedded app
  Cloudflare-oriented frontend + auth + lightweight actions/loaders
- `apps/ocr-api`
  Render-hosted OCR/PDF backend
  Heavy processing only
- `packages/shared`
  Shared types, validation, utility code, API contracts

## Platform Responsibility Split

Cloudflare side:

- Embedded app UI
- Shopify auth entry points
- App Bridge-facing routes
- Lightweight API routes
- Calls to internal OCR backend

Render side:

- OCR processing
- PDF conversion
- Any remaining Node-only workloads
- Transitional backend endpoints used by Cloudflare app
- Shared-secret-protected internal APIs for OCR/PDF work

## Important Constraint

Do not try to move the current OCR/PDF implementation directly to Cloudflare Workers.

Current blockers include:

- `fs`
- `formidable`
- `pdf2pic`
- Node adapter usage
- Prisma server assumptions

These must either be removed, replaced, or isolated.

## Migration Principles

- Keep `main` stable
- Use this branch for staged structural changes
- Prefer separation before replacement
- Avoid rewriting working business logic unless needed
- Preserve evidence of the shipped Shopify app while modernizing internals

## Planned Stages

### Stage 1: Branch planning and structure

- Add branch-specific planning docs
- Define monorepo folder layout
- Decide what stays in `apps/web` vs `apps/ocr-api`

### Stage 2: Monorepo preparation

- Introduce top-level workspace structure
- Move current app into `apps/web`
- Create placeholder service structure for OCR backend
- Extract shared types/contracts into `packages/shared`

### Stage 3: Runtime boundary cleanup

- Isolate Node-only OCR/PDF code
- Reduce direct dependencies between UI routes and heavy processing
- Replace direct local heavy processing calls with backend API boundaries
- Allow `apps/web` to switch between local OCR logic and external `apps/ocr-api` via env vars

### Stage 4: React Router migration

- Move app shell toward React Router-compatible structure
- Replace Remix-specific assumptions where needed
- Keep Shopify embedded behavior working during transition

### Stage 5: Cloudflare readiness

- Prepare Cloudflare-compatible app runtime
- Keep Shopify-facing app URL on Cloudflare
- Keep OCR backend on Render until replacement is justified

### Stage 5.5: Post-React-Router cleanup priorities

- Remove client-side `Tesseract.js` dependence from `apps/web`
- Keep PDF/image OCR behind `apps/ocr-api` or another backend boundary
- Reduce Node-only SSR assumptions where possible
- Revisit Prisma session storage strategy for longer-term Cloudflare compatibility
- Audit any route code that still depends on Node-only APIs or server-only crypto assumptions

### Stage 6: Optional OCR redesign

- Evaluate reducing or removing `Tesseract.js`
- Evaluate sending images/PDFs directly to Gemini API
- Keep privacy and disclosure requirements in mind

## Non-Goals For The First Pass

- Full one-shot Cloudflare migration
- Full OCR redesign immediately
- Perfect architecture before shipping incremental progress
- Rebuilding every feature from scratch

## Validation Checklist

Before merging major milestones from this branch, verify:

- App builds successfully
- Shopify embedded app still loads
- OAuth still works
- Main dashboard still renders
- Pricing/contact routes still render
- OCR backend boundary still works for current flows
- Shopify inventory sync still works

## Notes

- If Shopify app URLs change, app configuration and app version release steps will be required later
- Normal web app code changes do not require a Shopify app version release by themselves
- Shopify-facing configuration should only be changed once Cloudflare app hosting is actually ready
- Transitional env vars:
  - `OCR_API_BASE_URL`
  - `OCR_API_SHARED_SECRET`
- If `OCR_API_BASE_URL` is enabled, `OCR_API_SHARED_SECRET` should be treated as required
- Current Cloudflare blockers after the React Router step:
  - OCR now routes through the backend boundary, but `apps/ocr-api` still depends on `tesseract.js`
  - `apps/web` still uses Prisma-backed Shopify session storage, even though it is now isolated behind `app/sessionStorage.server.ts`
  - `apps/web/app/entry.server.jsx` now uses Web Streams SSR, but the app still needs a Cloudflare runtime pass before switching hosting
  - `apps/ocr-api/src/server.js` still uses Node-only OCR/PDF libraries
  - `apps/web` now expects OCR/PDF/file operations to be available via `OCR_API_BASE_URL`
