# OCR API Placeholder

This workspace is reserved for the future Render-hosted OCR/PDF backend.

Planned responsibilities:

- PDF processing
- OCR execution
- Heavy Node-only processing
- Internal APIs consumed by `apps/web`

Planned API boundary candidates:

- `POST /pdf-to-image`
- `POST /ocr-text`
- `POST /shipment-files`
- `POST /shipment-files/signed-urls`
- `GET /health`

Expected request model during the transition:

- `apps/web` calls this service only when `OCR_API_BASE_URL` is configured
- `apps/web` must send `x-ocr-api-key` using `OCR_API_SHARED_SECRET`
- Multipart routes keep the current form field names:
  - `/pdf-to-image`: `file`
  - `/ocr-text`: `file`
  - `/shipment-files`: `si_number`, `type`, `file`
- `/shipment-files/signed-urls` accepts JSON and includes `shopId` from the authenticated Shopify session

Transition rule:

- If `OCR_API_BASE_URL` is not set, `apps/web` keeps using the local Node implementation
- If `OCR_API_BASE_URL` is set, `apps/web` treats this workspace as the source of truth for OCR/PDF work

Current scaffold:

- `src/server.js` runs a small Node 20 HTTP service
- PDF preview currently returns a `data:image/png;base64,...` URL so the web app can keep the same `url` contract during the transition
- OCR endpoint currently uses `tesseract.js` on the Render side for image/PDF/text input
- `Dockerfile` is prepared for a dedicated Render service
