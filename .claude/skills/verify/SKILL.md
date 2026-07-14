---
name: verify
description: Verify renderer/kernel changes by driving the browser preview harness, which uses the exact same render() as the VS Code extension.
---

# Verifying webnb changes

The fastest runtime surface is the vite preview harness (`preview/`) — it hosts
the extension's real `src/client/render.ts` in a browser and mirrors the
kernel's output shape, so anything cell-rendering or file-snapshot related can
be observed there without launching VS Code.

## Launch

```bash
WEBNB_WORKSPACE=$PWD/samplenotebooks npm run preview -- --port 5199 --strictPort
```

- `WEBNB_WORKSPACE` is required (or `preview/webnb.config.json`); point it at a
  directory of `.webnb` notebooks. `samplenotebooks/` works.
- Sanity check: `curl http://localhost:5199/__webnb/api/notebooks` lists notebooks.
- Select a notebook via URL hash: `http://localhost:5199/#walkthrough.webnb`.
  The app is an SPA — a hash-only `page.goto` does NOT reload/switch notebooks;
  go through `about:blank` first (or click the sidebar entry).

## Drive headlessly

Playwright is available via the repo's dependency tree; from the scratchpad use
`NODE_PATH=<repo-root>/node_modules node script.js`. Cell outputs render inside
**nested shadow DOM**; `page.locator()` pierces it, but `page.evaluate` +
`querySelectorAll` does not — walk `el.shadowRoot` recursively.

Auto-widget cells (`mcq`, `external`, `walkthrough`) run on open; other cells
need their Run button clicked.

## Live file updates

Cells that snapshot workspace files re-run automatically when the underlying
disk files change (dev-server fs events). Editing a file under
`WEBNB_WORKSPACE` and waiting ~2s is a valid way to observe snapshot-driven
re-rendering.

## What the preview cannot verify

Extension-host behavior: kernel selection, autorun on notebook open, input
collapsing, and the `webnb.openWorkspaceFile` message (preview ignores it —
clicking a file link is a no-op there). For those, launch real VS Code Web
headlessly:

```bash
node scripts/vscode-test-web.js samplenotebooks/<file>.webnb --watch --remote --port 3066
```

- `--remote` starts the server without a local browser; connect Playwright (or
  any browser) to the printed URL. The session runner auto-opens the file and
  reload-on-rebuild works in whichever browser is connected.
- A cached VS Code build lives in `.vscode-test-web/` (gitignored); symlink it
  from the main checkout into a worktree to skip the download.
- Notebook cell outputs live in nested webview **iframes** — `page.locator()`
  does not pierce iframes; iterate `page.frames()` and locate within each.
- Give the workbench ~20–25s to boot before asserting.
