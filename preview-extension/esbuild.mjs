/**
 * Builds the two bundles this extension ships:
 *
 *   out/extension.js  extension host (node + webworker safe), `vscode` external
 *   out/webview.js    the preview webview, including the REAL notebook renderer
 *
 * The webview bundle deliberately builds the extension's OWN ../src (client,
 * shared, extension/markdownParser) rather than a copy of it: the whole point
 * of the preview is that it renders through the same render() the notebook
 * editor uses. Bare imports inside those files (react, marked, @xterm/xterm,
 * ...) resolve against the repo's node_modules, so `npm install` at the repo
 * root is a prerequisite -- checked below.
 */
import { build, context } from 'esbuild';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const webnbDir = path.resolve(root, '..');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

if (!existsSync(path.join(webnbDir, 'node_modules', 'react'))) {
    console.error(`${webnbDir} has no node_modules; the renderer's dependencies cannot be resolved.`);
    console.error('Run `npm install` in the repo root first.');
    process.exit(1);
}

// webpack gives the renderer a `util` fallback; esbuild needs it spelled out.
const webnbRequire = createRequire(path.join(webnbDir, 'package.json'));

/** Reports failures the way the VS Code problem matcher expects. */
const logResults = {
    name: 'log-results',
    setup(pluginBuild) {
        pluginBuild.onEnd(result => {
            for (const error of result.errors) {
                console.error(`error: ${error.text}`);
                if (error.location) {
                    console.error(`    ${error.location.file}:${error.location.line}:${error.location.column}`);
                }
            }
            const label = pluginBuild.initialOptions.outfile;
            console.log(`[esbuild] ${path.basename(label)} ${result.errors.length ? 'failed' : 'built'}`);
        });
    }
};

const shared = {
    bundle: true,
    minify: production,
    sourcemap: production ? false : 'inline',
    logLevel: 'warning',
    // Carries the `@webnb/*` paths, so bundling resolves them the same way
    // type-checking does.
    tsconfig: path.join(root, 'tsconfig.json'),
    plugins: [logResults]
};

const extensionBuild = {
    ...shared,
    entryPoints: [path.join(root, 'src/extension/extension.ts')],
    outfile: path.join(root, 'out/extension.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode']
};

const webviewBuild = {
    ...shared,
    entryPoints: [path.join(root, 'src/webview/index.ts')],
    outfile: path.join(root, 'out/webview.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2021',
    // NEVER minify this bundle. render() deliberately exposes its locals
    // (`console`, `assert`, `cy`, `checklist`, `terminal`, ...) to notebook code
    // through direct eval(); renaming any of them breaks author cells at
    // runtime with no compile-time signal. esbuild does disable renaming in
    // scopes containing direct eval, but this is an authoring tool where the
    // bundle size buys nothing, so do not lean on that.
    minify: false,
    // Stylesheets are injected as text, exactly as webpack's asset/source does
    // for the extension's own renderer build.
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
    alias: { util: path.dirname(webnbRequire.resolve('util/package.json')) }
};

if (watch) {
    const contexts = await Promise.all([context(extensionBuild), context(webviewBuild)]);
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('[esbuild] watching');
} else {
    await Promise.all([build(extensionBuild), build(webviewBuild)]);
}
