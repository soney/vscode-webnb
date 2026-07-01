import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webnbDevServer, resolveWorkspaceRoot } from './plugin/webnbDevServer';

const previewDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolveWorkspaceRoot(previewDir);

export default defineConfig({
    root: previewDir,
    // Allow Vite to read the extension repo root (one level up): the renderer
    // source under ../src and the deps under ../node_modules (incl. xterm's
    // CSS imported with ?raw). Also allow the (possibly external) workspace.
    server: {
        fs: {
            allow: [path.resolve(previewDir, '..'), workspaceRoot]
        }
    },
    resolve: {
        // markdownParser.ts imports `vscode`; map it to a tiny browser shim that
        // provides just the NotebookCellKind enum it uses at runtime.
        alias: {
            vscode: path.resolve(previewDir, 'src/vscode-shim.ts')
        },
        // render.ts pulls in React; make sure there is exactly one copy so React
        // cells that use hooks work.
        dedupe: ['react', 'react-dom']
    },
    define: {
        // render.ts ends with `if (module.hot) { ... }`, a webpack-ism. Under
        // Vite there is no `module` global, so neutralize the reference.
        'module.hot': 'undefined'
    },
    optimizeDeps: {
        include: ['react', 'react-dom', 'react-dom/client', '@babel/standalone', 'marked', 'smartypants', '@xterm/xterm']
    },
    plugins: [webnbDevServer({ workspaceRoot })]
});
