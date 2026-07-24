# Web Notebook

Web Notebook files are Markdown documents with executable tutorial cells. Use fenced code blocks for learner-editable cells, and attach addon blocks for fixtures, styles, tests, or references.

Authoring reference: **[SYNTAX.md](SYNTAX.md)** documents every cell type, addon, test helper, and widget — cell format, tests, automatic running, multiple choice questions, external checks, and code walkthroughs. This file covers building and developing the extension itself.

## Coursera Docker Dev

From this repo, build/import the extension into the Practical JavaScript
Coursera Docker harness and start code-server with:

```bash
npm run coursera:start
```

That command looks for `~/teaching/Practical-JavaScript` by default. If the
course repo lives somewhere else, pass it once:

```bash
npm run coursera:start -- --repo /path/to/Practical-JavaScript
```

or set:

```bash
export PRACTICAL_JAVASCRIPT_REPO=/path/to/Practical-JavaScript
```

To import the VSIX without starting the container:

```bash
npm run coursera:import
```

To stop the Coursera Docker dev container:

```bash
npm run coursera:stop
```

Both commands use this extension checkout as the source, so they do not depend
on your shell being inside the course repo.

## Development Loop

For a faster VS Code Web development loop, run:

```sh
npm run in-browser:watch
```

This watches the source files, runs webpack development builds as they change, waits for the first successful build, launches VS Code Web, opens `samplenotebooks/sample.webnb`, and reloads VS Code Web whenever the compiled output changes. The wrapper also reopens the target notebook on each reload signal so the file stays in front.

If you only want webpack watching without opening VS Code Web, run:

```sh
npm run dev:web
```

The browser launch uses `scripts/vscode-test-web.js`, a small wrapper around the `@vscode/test-web` API. It opens `samplenotebooks/sample.webnb` by default through the npm scripts above. With `--watch`, the wrapper rebuilds with webpack after source changes, watches the compiled extension output in `out/` plus `package.json`, and reloads VS Code Web after a rebuild.

You can launch once without the reload watcher:

```sh
npm run in-browser:open
```

You can also pass a different file path with `--file`:

```sh
npm run test-web -- --file sample.webnb
npm run test-web -- --workspace . samplenotebooks/sample.webnb
```

`vscode-test-web` does not watch or reload by itself. The `--watch` flag in `scripts/vscode-test-web.js` adds that development loop around it. The regular `npm run in-browser` command still does a one-time development build before launching.

### Remote Development

When this repo runs on a remote machine (SSH, a container, code-server), the launcher cannot open a browser there. Use remote mode instead:

```sh
npm run in-browser:remote
```

This runs the same watch/rebuild/reload loop but skips launching a browser and prints the URLs to open from your own machine. The rebuild-and-reload signal resolves against whatever origin your browser connected through, so live reload works across tunnels and mapped ports.

If you forget `--remote` on a machine with no display, the launcher notices ($DISPLAY / $WAYLAND_DISPLAY are unset on Linux) and falls back to this server-only mode automatically instead of crashing on the browser launch.

The server binds to `localhost` by default, so forward the port from your local machine first:

```sh
ssh -L 3000:localhost:3000 <user>@<remote-host>
```

then open `http://localhost:3000/` locally.

The address in your browser must literally be `localhost` — not `127.0.0.1`, not a LAN IP, not a machine name. Two separate things break on any other origin:

- Browsers grant plain-HTTP [secure-context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) APIs (like `crypto.subtle`, which VS Code Web requires) only to `localhost`.
- `@vscode/test-web` serves the web-worker extension host from a generated subdomain of whatever host the browser used (`v--<uuid>.localhost` resolves to loopback in every browser; subdomains of IP addresses are invalid URLs and subdomains of ordinary hostnames do not resolve).

On a non-localhost origin the workbench shell still loads, but the extension host cannot start, so the Explorer shows no files (`ENOPRO: no file system provider for vscode-test-web://mount`) and no extensions run. The launcher prints a warning about this when it binds a non-localhost host.

`--host 0.0.0.0` is still useful whenever the port is reached through a mapping that ends in a localhost URL: a Docker/devcontainer port map (`-p 3000:3000`), `kubectl port-forward`, or an SSH tunnel all qualify.

`--remote` is shorthand for `--browser none` and works with any of the launcher's modes. Anyone who can reach the port gets a full VS Code Web session with the mounted workspace (edits stay in browser memory and are not written back to disk) — another reason to keep it behind a tunnel on shared networks.
