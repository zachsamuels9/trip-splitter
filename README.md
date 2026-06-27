# Trip Split

Trip Split is a mobile-first PWA for scanning trip receipts, letting each traveler claim items, converting supported currencies to USD, and calculating settlement totals.

## Stack

- Framework: vanilla HTML, CSS, and JavaScript
- Runtime: Node.js serverless functions on Vercel
- Package manager: pnpm
- Shared data: Upstash Redis REST API
- OCR: OCR.space via a server-side API proxy

## Environment Variables

Copy `.env.example` to `.env.local` for local development and add the same variables to Vercel.

```bash
OCR_SPACE_API_KEY=your_ocr_space_api_key
UPSTASH_REDIS_REST_URL=https://your-upstash-redis-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
PORT=4174
```

The OCR key is only used by `/api/ocr`; it is never exposed in browser code.

## Local Development

```bash
pnpm install
OCR_SPACE_API_KEY=... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... pnpm dev
```

Open `http://127.0.0.1:4174/`.

For local-only group testing without Upstash, `server.js` stores data under `data/groups.json`. Vercel production uses Upstash Redis instead.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Vercel Deployment

1. Install dependencies:

```bash
pnpm install
```

2. Add environment variables to Vercel:

```bash
pnpm dlx vercel env add OCR_SPACE_API_KEY
pnpm dlx vercel env add UPSTASH_REDIS_REST_URL
pnpm dlx vercel env add UPSTASH_REDIS_REST_TOKEN
```

3. Deploy a preview:

```bash
pnpm dlx vercel
```

4. Test the preview URL on iPhone Safari:

- Create a trip group.
- Copy and open the invite link in another browser/device.
- Join with a name.
- Scan or manually create a receipt.
- Reopen the receipt from Totals and claim items.
- Use Share → Add to Home Screen.

5. Deploy production:

```bash
pnpm dlx vercel --prod
```

## Mobile Safari and PWA Support

- The app includes a manifest, theme color, app name, maskable SVG icon, Apple mobile web app metadata, and a service worker.
- Receipt upload uses:

```html
<input type="file" accept="image/*" capture="environment">
```

- If server OCR fails, the app falls back to local Tesseract OCR. If both fail, the user is sent to manual entry.

## Notes

- Invite links use `?group=<group-id>`.
- Each browser/device stores the joined person ID in local storage for that group.
- Receipt image references are saved with scanned receipts so travelers can review the original image later.
