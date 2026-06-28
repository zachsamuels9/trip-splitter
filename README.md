# Trip Split

Trip Split is a mobile-first PWA for scanning trip receipts, letting each traveler claim items, converting supported currencies to USD, and calculating settlement totals.

## Stack

- Framework: vanilla HTML, CSS, and JavaScript
- Runtime: Node.js serverless functions on Vercel
- Package manager: pnpm
- Shared data: Supabase Postgres through server-side API routes
- OCR: Google Cloud Document AI Expense Parser via a server-side API proxy

## Environment Variables

Copy `.env.example` to `.env.local` for local development and add the same variables to Vercel.

```bash
GOOGLE_DOCUMENT_AI_PROJECT_ID=your_google_cloud_project_id
GOOGLE_DOCUMENT_AI_LOCATION=us
GOOGLE_DOCUMENT_AI_PROCESSOR_ID=your_document_ai_receipt_processor_id
GOOGLE_DOCUMENT_AI_CLIENT_EMAIL=your_service_account_email
GOOGLE_DOCUMENT_AI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nyour_private_key\n-----END PRIVATE KEY-----\n"
OPENAI_API_KEY=optional_for_line_item_normalization
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
PORT=4174
```

OCR and GPT keys are only used by server routes; they are never exposed in browser code.

Run `supabase-account-migration.sql` once to enable cross-device account sign-in with email and a 4-digit passcode.

## Local Development

```bash
pnpm install
GOOGLE_DOCUMENT_AI_PROJECT_ID=... GOOGLE_DOCUMENT_AI_PROCESSOR_ID=... SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... pnpm dev
```

Open `http://127.0.0.1:4174/`.

If Supabase environment variables are missing or unavailable, the group API falls back to in-memory data for the running Node process. This keeps local smoke tests from crashing, but shared trips need Supabase for durable persistence.

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
pnpm dlx vercel env add GOOGLE_DOCUMENT_AI_PROJECT_ID
pnpm dlx vercel env add GOOGLE_DOCUMENT_AI_LOCATION
pnpm dlx vercel env add GOOGLE_DOCUMENT_AI_PROCESSOR_ID
pnpm dlx vercel env add GOOGLE_DOCUMENT_AI_CLIENT_EMAIL
pnpm dlx vercel env add GOOGLE_DOCUMENT_AI_PRIVATE_KEY
pnpm dlx vercel env add SUPABASE_URL
pnpm dlx vercel env add SUPABASE_PUBLISHABLE_KEY
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

- If Document AI is not configured or cannot parse a receipt, the user is sent to review the partial receipt and can add items manually.

## Notes

- Invite links use `?group=<group-id>`.
- Users can sign in with email and a 4-digit passcode after the account migration is applied.
- Receipt image references are saved with scanned receipts so travelers can review the original image later.
