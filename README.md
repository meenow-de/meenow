# meenow

A decentralized, serverless, cat-themed spontaneous photo-sharing PWA for Pixelfed - hosted on meenow.de.

Users receive a daily prompt at a pseudo-random local time (between 9 AM and 9 PM) to take a dual-camera photo — back camera for surroundings, front camera for a selfie — stitched into one composite image and shared with friends via the Fediverse. No custom backend or database: the Pixelfed/Mastodon API is the entire backend.

---

## Architecture

```
   ┌────────────────────────────────────────────────────────┐
   │                     meenow PWA                         │
   │           Vite + Vanilla TypeScript + Tailwind         │
   └───────────┬────────────────────────┬───────────┘
               │                                │
               ▼                                ▼
   [ LocalStorage ]                   [ Pixelfed API Engine ]
   • PRNG daily timer                 • Dynamic OAuth registration
   • Camera capture state             • Token management (PKCE)
   • "Posted today" cache             • Post with #meenowApp
                                      • Feed filter + blur logic
```

**Hosting:** Static only — GitHub Pages.
**Platform targets:** Android and iOS mobile browsers are first-class. Desktop browsers are supported but deprioritized in UX design.
**Tech stack:** Vite + Vanilla TypeScript + Tailwind CSS. No framework runtime.

---

## How It Works

### Pseudo-Random Daily Trigger

Each user gets a trigger time derived from their local date using a deterministic xorshift PRNG, placing the moment somewhere in the 9 AM–9 PM window. Friends in different timezones trigger at different moments — intentionally spontaneous rather than globally simultaneous.

**State machine:**
- Before trigger time: show a countdown arc.
- After trigger time, no post today: prompt the user to capture (up to 2 times per day).
- After posting: show the filtered feed with a "+ Post" button for the second daily shot.

On app load, if `localStorage` shows no posts today, the app fetches the user’s own recent statuses from the server to detect whether a `#meenowApp` post already exists (enabling multi-device use).

### Dual-Camera Capture

Mobile browsers cannot stream two cameras simultaneously. The sequential flow:

1. Open back camera (`facingMode: "environment"`). Wait for `loadedmetadata` before capturing.
2. Stop the back-camera stream and open front camera (`facingMode: "user"`). Display a 3-second fullscreen countdown, then auto-capture the selfie.
3. **Canvas stitching:** Back frame as full background; selfie as a rounded rectangle inset (≈35% width, white border, top-left corner). Exported as JPEG at quality 0.92.

An orientation toggle lets users choose portrait (default, with auto-rotation for landscape streams) or landscape.

**Permission handling:** `NotAllowedError` and `NotFoundError` from `getUserMedia` surface a platform-aware error card with instructions for Android and iOS.

### Pixelfed OAuth — Dynamic App Registration

No hardcoded `client_id` or `client_secret`. On first use with a given instance:

1. `POST /api/v1/apps` to register the app at runtime.
2. Authorization Code Flow with PKCE: random `code_verifier`, SHA-256 derived `code_challenge`.
3. Tokens stored in `localStorage`, never sent anywhere other than the user’s own instance.

### Posting

1. Upload composite image via `POST /api/v1/media` (sequential first to guarantee gallery ordering), then back and front photos in parallel.
2. `POST /api/v1/statuses` with `visibility: "private"` and caption `#meenowApp`.
3. Write the incremented post count to `localStorage`.

### Feed

- Home timeline and own statuses merged and deduplicated.
- Filtered to the last 24 hours; only statuses tagged `#meenowApp` are shown.
- If the user has not posted today: images are blurred with a “Post yours to unblur” prompt.
- Empty state: sleeping cat illustration.

---

## Known Limitations

- **Push notifications on iOS:** Web Push requires the PWA to be installed to the home screen (iOS 16.4+). The install nudge directly addresses this.
- **Camera resolution:** Controlled by the browser, typically lower than the native camera app.
- **Instance compatibility:** Designed and tested against Pixelfed. Standard Mastodon instances expose the same API surface and are expected to work.

---

## Development

```bash
npm install
npm run dev
```

Deployed automatically to GitHub Pages on push to `main` via GitHub Actions.
