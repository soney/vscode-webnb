# WebNB Debug Minimal

This is a deliberately tiny notebook extension for reproducing `.webnb` notebook URI/execution issues without the main renderer, fallback opener, or web notebook runtime.

It contributes one notebook type:

- extension: `.webnb-debug`
- notebook type: `webnb-debug`
- controller: `webnb-debug-kernel`

The serializer only understands markdown plus fenced code blocks. Code fences can include `autorun`:

````markdown
```{javascript autorun}
console.log('runs on open')
```
````

The kernel does not evaluate JavaScript. It only creates a VS Code notebook cell execution and writes a plain text output containing URI/debug details. That is enough to reproduce failures like `Notebook not found: vscode-remote://...`.

Useful command:

- `WebNB Debug: Dump Notebook State`

That command prints active/visible notebook editors, notebook documents, and tabs to the Extension Host console.

## Run It

Package and install it into code-server:

```sh
cd webnb-debug-extension
npx vsce package --no-dependencies
code-server --install-extension webnb-debug-minimal-0.0.1.vsix
```

Then open:

```text
samplenotebooks/debug-minimal.webnb-debug
```

You can also copy or rename a problematic `.webnb` file to `.webnb-debug`; this serializer understands basic markdown plus fenced code blocks such as `javascript autorun` fences.
