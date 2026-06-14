# meenow — project notes for Claude Code

## What this is

A minimal PWA that prompts users once a day to take a dual-camera photo (back + selfie stitched together) and post it to a Pixelfed instance via the Mastodon-compatible API. No backend — everything runs in the browser. Auth is OAuth PKCE stored in localStorage.

## Local development

```
npm install
npm run dev      # Vite dev server on localhost:5173
npm run build    # production build to dist/
npx tsc --noEmit # type-check without building
```

## Tech stack

- Vanilla TypeScript, no framework
- Vite + vite-plugin-pwa (workbox service worker)
- Tailwind CSS v3
- GitHub Pages for hosting

## Two-repo deployment setup

There are two separate GitHub repositories, each deploying to its own domain via GitHub Pages:

| Repo | Domain | Deploy trigger |
|------|--------|---------------|
| `hannesrauhe/meenow` (this repo) | `dev.meenow.de` | every push to any branch, deploys immediately |
| `meenow-de/meenow` | `meenow.de` | every push to any branch, but requires manual approval |

The workflow file `.github/workflows/deploy.yml` is **identical in both repos**. The difference in behaviour comes entirely from the `github-pages` environment protection rule configured in `meenow-de/meenow` (Settings → Environments → github-pages → Required reviewers). The `deploy` job pauses there until a reviewer approves; on the dev repo there is no such rule so it deploys immediately.

Custom domains are configured in each repo's GitHub Pages settings (Settings → Pages → Custom domain). No `CNAME` file is needed in the source tree because both repos use the artifact-based Pages deployment (`actions/upload-pages-artifact` + `actions/deploy-pages`), which preserves the custom domain setting stored in GitHub's backend across deployments.

DNS for both domains points to GitHub Pages IPs (185.199.108–111.153 / 2606:50c0::/32).

To ship to production: open a PR from `hannesrauhe/meenow:main` into `meenow-de/meenow:main` and approve the deployment in the `github-pages` environment.

## Dev instance indicator

`src/main.ts` appends a small fixed `dev` badge to `<body>` when `window.location.hostname` is `dev.meenow.de` or `localhost`. The same code runs in production where it is a no-op. No build-time configuration needed.

## Key architecture notes

- **State machine** lives in `src/timer.ts` (`computeState`) and is driven by a 1-second `setInterval` tick in `src/main.ts`. States: `before_trigger` → `awaiting_capture` → `feed`.
- **`activeScreen`** in `main.ts` tracks what is currently mounted. The special `'capturing'` value pauses the tick loop during the second-post flow so it does not unmount the in-progress capture screen.
- **Screen mounting** is done by `mount()` and `mountCapture()` in `main.ts`. Screens must not manipulate `#app` directly — use the `onRequestCapture` / `onDone` callbacks instead.
- **Auth** is read from localStorage via `getAuthState()`. The app auto-registers itself as an OAuth client on first login per Pixelfed instance, so each domain (`dev.meenow.de`, `meenow.de`) registers independently.
- **Service worker** caches aggressively in production. On the dev domain, users may need a hard refresh after a new deployment.
