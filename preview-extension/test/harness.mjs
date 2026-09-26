/**
 * Bundles the real notebook parser together with our span mapper so tests can
 * exercise both under plain node. `vscode` is aliased to a stub -- the parser
 * only uses it for the NotebookCellKind enum.
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');
export const samplesDir = path.resolve(root, '..', 'samplenotebooks');

/**
 * The course notebooks, when this repo is the Practical JavaScript course's
 * vscode-extensions/vscode-webnb submodule: content/notebooks/ since the
 * course's 2026-08 restructure, notebooks/ before it. WEBNB_NOTEBOOKS points
 * anywhere else.
 */
function defaultNotebooksDir() {
    const courseRoot = path.resolve(root, '..', '..', '..');
    const candidates = [path.join(courseRoot, 'content', 'notebooks'), path.join(courseRoot, 'notebooks')];
    return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

export const notebooksDir = process.env.WEBNB_NOTEBOOKS
    ? path.resolve(process.env.WEBNB_NOTEBOOKS)
    : defaultNotebooksDir();

const ENTRY = `
export { parseMarkdown, writeCellsToMarkdown } from '@webnb/extension/markdownParser';
// The notebook's own open and save paths, metadata mapping and all, so a test
// round-trips a file exactly the way VS Code does.
export { deserializeWebnb, serializeWebnb } from '@webnb/extension/serializer';
export { computeCellSpans } from '../src/extension/cellSpans.ts';
export { parseDocumentCells } from '../src/extension/parseDocument.ts';
export { blockSourceLines } from '../src/webview/markdown.ts';
export const CODE = 2;
`;

/**
 * The panel manager, bundled against a fuller `vscode` stub. The stub is
 * re-exported from the same bundle so a test drives the very instance the
 * manager is wired to.
 */
const MANAGER_ENTRY = `
export { WebnbPreviewManager } from '../src/extension/previewPanel.ts';
export * as vscode from 'vscode';
`;

let cached;
let cachedManager;

async function bundle(name, contents, stub) {
    const dir = await mkdtemp(path.join(tmpdir(), 'webnb-preview-test-'));
    const outfile = path.join(dir, `${name}.mjs`);

    await build({
        stdin: { contents, resolveDir: testDir, sourcefile: path.join(testDir, `.${name}.generated.ts`), loader: 'ts' },
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        logLevel: 'error',
        tsconfig: path.join(root, 'tsconfig.json'),
        alias: { vscode: path.join(testDir, stub) }
    });

    const module = await import(`file://${outfile}`);
    return { ...module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Compile once per test run; every test file shares the result. */
export async function loadHarness() {
    cached ??= await bundle('harness', ENTRY, 'vscode-stub.ts');
    return cached;
}

export async function loadPreviewManager() {
    cachedManager ??= await bundle('manager', MANAGER_ENTRY, 'vscode-panel-stub.ts');
    return cachedManager;
}

/** Every .webnb file under a directory, recursively. Empty if it does not exist. */
export async function findNotebooks(dir) {
    const found = [];
    async function walk(current) {
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.name.endsWith('.webnb')) {
                found.push(full);
            }
        }
    }
    await walk(dir);
    return found.sort();
}

export async function readNotebook(file) {
    return readFile(file, 'utf8');
}
