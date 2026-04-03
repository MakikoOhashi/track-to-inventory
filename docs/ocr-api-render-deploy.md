# OCR API Render Deploy Notes

This note documents how `apps/ocr-api` is expected to be deployed during the Cloudflare renewal transition.

## Purpose

- Keep the Shopify embedded app UI fast on Cloudflare
- Keep heavy OCR/PDF processing on Render for now
- Let `apps/web` call `apps/ocr-api` through an internal HTTP boundary

## Service Role

`apps/ocr-api` is not the public Shopify app entrypoint.

It is an internal backend for:

- PDF to image conversion
- Shipment file upload to Supabase Storage
- Signed URL generation for shipment files

## Current Endpoints

- `GET /health`
- `POST /pdf-to-image`
- `POST /shipment-files`
- `POST /shipment-files/signed-urls`

## Required Environment Variables

Render service:

- `PORT`
- `OCR_API_SHARED_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Cloudflare / `apps/web` side:

- `OCR_API_BASE_URL`
- `OCR_API_SHARED_SECRET`

## Shared Secret Rule

- `apps/web` should only call `apps/ocr-api` when both `OCR_API_BASE_URL` and `OCR_API_SHARED_SECRET` are set
- `apps/ocr-api` rejects requests with a missing or invalid `x-ocr-api-key`

## Suggested Render Service Setup

- Service type: Web Service
- Root directory: repository root
- Dockerfile path: `apps/ocr-api/Dockerfile`
- Branch: `codex/cloudflare-renewal` during migration, later `main`

## Suggested First Validation

1. Deploy `apps/ocr-api` alone on Render
2. Confirm `/health` returns `200`
3. Set `OCR_API_BASE_URL` and `OCR_API_SHARED_SECRET` in `apps/web`
4. Confirm PDF preview and shipment file upload still work

## Important Notes

- `apps/ocr-api` still uses Node-only libraries such as `pdf2pic`
- This service is intentionally Render-friendly rather than Cloudflare-friendly
- The long-term goal may still be reducing or replacing this service if OCR moves closer to Gemini-only processing
