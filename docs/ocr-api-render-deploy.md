# Archive: OCR API on Render (removed)

Status: **retired in Stage H (2026-07-24)**

`apps/ocr-api` and the Render service `track-to-inventory-1` are no longer part of the production path.

Workers now handles:

- document parse (Gemini)
- shipment file upload / signed URLs (Supabase Storage)
- stock sync (Shopify Admin API)

Do not redeploy this backend for Inbound Tracking unless intentionally rolling back a historical investigation.
