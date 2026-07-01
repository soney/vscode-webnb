/**
 * Vite plugin that bridges the browser preview to the on-disk notebook workspace.
 *
 * Responsibilities:
 *  - Resolve the workspace root (the folder that contains the .webnb files). This
 *    is the same folder you would open in VS Code, so notebook-relative file
 *    checks (`{external}` / `+files`) resolve identically.
 *  - Serve a small JSON API under /__webnb/api/* for listing notebooks, reading
 *    notebook source, taking on-disk file snapshots (for file checks), and
 *    serving binary assets (images referenced from markdown).
 *  - Watch the workspace for changes and push a custom HMR event over Vite's
 *    websocket so the browser re-renders the moment a file changes on disk.
 *
 * IMPORTANT: This plugin NEVER writes to the workspace. All browser-side edits
 * live in the browser's virtual filesystem (see src/vfs.ts). Disk is read-only.
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_SNAPSHOT_BYTES = 1024 * 1024;
const WEBNB_EXTENSION = '.webnb';
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', '.vscode-test', '.vscode-test-web', 'out', 'dist']);
const ASSET_CONTENT_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8'
};

export interface WorkspaceFileSnapshotEntry {
    path: string;
    /** Workspace-relative path the request resolved to (used by the browser overlay). */
    resolvedPath?: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

interface SnapshotRequest {
    requestPath: string;
    path: string;
    base: 'notebook' | 'workspace';
}

/**
 * Resolve the workspace root in priority order:
 *  1. WEBNB_WORKSPACE environment variable
 *  2. ./webnb.config.json -> { "workspace": "..." }
 *  3. throw with guidance
 */
export function resolveWorkspaceRoot(previewDir: string): string {
    const fromEnv = process.env.WEBNB_WORKSPACE;
    if (fromEnv && fromEnv.trim()) {
        return path.resolve(fromEnv.trim());
    }

    const configPath = path.join(previewDir, 'webnb.config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (config && typeof config.workspace === 'string' && config.workspace.trim()) {
                return path.resolve(previewDir, config.workspace.trim());
            }
        } catch (error) {
            throw new Error(`Could not parse ${configPath}: ${(error as Error).message}`);
        }
    }

    throw new Error(
        'No notebook workspace configured. Set WEBNB_WORKSPACE=/path/to/workspace ' +
        'or create preview/webnb.config.json with { "workspace": "/path/to/workspace" }.'
    );
}

function toPosix(value: string): string {
    return value.split(path.sep).join('/');
}

/** Reject paths that escape the workspace root. Returns an absolute path or null. */
function safeResolve(workspaceRoot: string, relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(workspaceRoot, normalized);
    const rel = path.relative(workspaceRoot, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return abs;
    }
    return null;
}

/** Mirror of webnbProvider.normalizeWorkspacePath. */
function normalizeWorkspacePath(p: string): string | undefined {
    const normalizedSlashes = p.trim().replace(/\\/g, '/');
    if (!normalizedSlashes || normalizedSlashes.startsWith('/') || /^[A-Za-z]:\//.test(normalizedSlashes)) {
        return undefined;
    }
    const parts = normalizedSlashes.split('/').filter(part => part && part !== '.');
    if (parts.length === 0 || parts.some(part => part === '..')) {
        return undefined;
    }
    return parts.join('/');
}

function notebookRelativeDir(notebookRelPath: string): string {
    const p = notebookRelPath.replace(/\\/g, '/');
    const slashIndex = p.lastIndexOf('/');
    return slashIndex < 0 ? '' : p.slice(0, slashIndex);
}

function fileTypeFromStat(stat: fs.Stats): WorkspaceFileSnapshotEntry['type'] {
    if (stat.isDirectory()) { return 'directory'; }
    if (stat.isFile()) { return 'file'; }
    if (stat.isSymbolicLink()) { return 'symlink'; }
    return 'unknown';
}

async function walkNotebooks(root: string): Promise<string[]> {
    const results: string[] = [];
    async function walk(dir: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.') {
                if (IGNORED_DIR_NAMES.has(entry.name)) { continue; }
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORED_DIR_NAMES.has(entry.name)) { continue; }
                await walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(WEBNB_EXTENSION)) {
                results.push(full);
            }
        }
    }
    await walk(root);
    return results.sort((a, b) => a.localeCompare(b));
}

async function snapshotOne(
    workspaceRoot: string,
    notebookRelPath: string,
    request: SnapshotRequest
): Promise<WorkspaceFileSnapshotEntry> {
    const normalizedPath = normalizeWorkspacePath(request.path);
    if (!normalizedPath) {
        return {
            path: request.requestPath,
            exists: false,
            error: 'File checks must use relative paths without ".." segments.'
        };
    }

    const relDir = notebookRelativeDir(notebookRelPath);
    const workspaceResolvedPath = request.base === 'workspace' || !relDir
        ? normalizedPath
        : `${relDir}/${normalizedPath}`;

    const abs = safeResolve(workspaceRoot, workspaceResolvedPath);
    if (!abs) {
        return {
            path: request.requestPath,
            resolvedPath: workspaceResolvedPath,
            exists: false,
            error: 'Resolved path escaped the workspace.'
        };
    }

    try {
        // Follow symlinks like the extension's vscode.workspace.fs.stat, so a
        // symlink to a file/dir reports the target's type (not 'symlink').
        const stat = await fsp.stat(abs);
        const type = fileTypeFromStat(stat);
        const snapshot: WorkspaceFileSnapshotEntry = {
            path: request.requestPath,
            resolvedPath: workspaceResolvedPath,
            exists: true,
            type,
            size: stat.size
        };
        if (type === 'file') {
            if (stat.size <= MAX_FILE_SNAPSHOT_BYTES) {
                snapshot.content = await fsp.readFile(abs, 'utf-8');
            } else {
                snapshot.error = `File is larger than ${MAX_FILE_SNAPSHOT_BYTES} bytes, so its contents were not loaded.`;
            }
        } else if (type === 'directory') {
            const entries = await fsp.readdir(abs, { withFileTypes: true });
            snapshot.entries = entries.map(entry => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'unknown'
            }));
        }
        return snapshot;
    } catch {
        return { path: request.requestPath, resolvedPath: workspaceResolvedPath, exists: false };
    }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(payload);
}

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', chunk => {
            size += (chunk as Buffer).length;
            if (size > MAX_REQUEST_BODY_BYTES) {
                reject(new Error('Request body too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk as Buffer);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

export interface WebnbDevServerOptions {
    workspaceRoot: string;
}

export function webnbDevServer(options: WebnbDevServerOptions): Plugin {
    const workspaceRoot = options.workspaceRoot;

    let broadcastFsChange: (event: 'change' | 'add' | 'unlink', file: string) => boolean = () => false;

    return {
        name: 'webnb-dev-server',
        // A workspace file change is NOT a module change, so Vite's default
        // reaction is a full page reload. That wipes the soft re-render path
        // (and the scroll position) we want. Intercept changes to workspace
        // files here: push the custom event ourselves and return [] so Vite
        // does not also full-reload. Files outside the workspace fall through
        // to Vite's normal HMR (return undefined).
        handleHotUpdate(ctx) {
            if (broadcastFsChange('change', ctx.file)) {
                return [];
            }
            return undefined;
        },
        configureServer(server: ViteDevServer) {
            // Watch the (possibly external) workspace for changes and push a
            // custom event the browser listens for to re-render live.
            server.watcher.add(workspaceRoot);

            broadcastFsChange = (event, file) => {
                if (!file.startsWith(workspaceRoot)) { return false; }
                const rel = toPosix(path.relative(workspaceRoot, file));
                if (!rel || rel.startsWith('..')) { return false; }
                server.ws.send({
                    type: 'custom',
                    event: 'webnb:fs-change',
                    data: { event, path: rel, isNotebook: rel.toLowerCase().endsWith(WEBNB_EXTENSION) }
                });
                return true;
            };

            // 'change' is handled by handleHotUpdate (above) so we can also
            // suppress the full reload. add/unlink aren't reported there, so
            // broadcast them here to keep the notebook list live.
            server.watcher.on('add', file => broadcastFsChange('add', file));
            server.watcher.on('unlink', file => broadcastFsChange('unlink', file));

            server.middlewares.use(async (req, res, next) => {
                const url = req.url || '';
                if (!url.startsWith('/__webnb/')) { return next(); }

                try {
                    const parsed = new URL(url, 'http://localhost');
                    const route = parsed.pathname;

                    if (route === '/__webnb/api/notebooks') {
                        const files = await walkNotebooks(workspaceRoot);
                        const notebooks = files.map(file => {
                            const rel = toPosix(path.relative(workspaceRoot, file));
                            return {
                                path: rel,
                                name: path.basename(file, path.extname(file)),
                                dir: notebookRelativeDir(rel)
                            };
                        });
                        return sendJson(res, 200, { workspace: workspaceRoot, notebooks });
                    }

                    if (route === '/__webnb/api/notebook') {
                        const rel = parsed.searchParams.get('path') || '';
                        const abs = safeResolve(workspaceRoot, rel);
                        if (!abs || !rel.toLowerCase().endsWith(WEBNB_EXTENSION)) {
                            return sendJson(res, 400, { error: 'Invalid notebook path.' });
                        }
                        try {
                            const content = await fsp.readFile(abs, 'utf-8');
                            return sendJson(res, 200, { path: rel, content });
                        } catch {
                            return sendJson(res, 404, { error: 'Notebook not found.' });
                        }
                    }

                    if (route === '/__webnb/api/snapshot' && req.method === 'POST') {
                        let body: { notebookPath?: string; requests?: SnapshotRequest[] };
                        try {
                            body = JSON.parse((await readBody(req)) || '{}');
                        } catch {
                            return sendJson(res, 400, { error: 'Invalid request body.' });
                        }
                        const notebookPath: string = String(body.notebookPath || '');
                        const requests: SnapshotRequest[] = Array.isArray(body.requests) ? body.requests : [];
                        const result: Record<string, WorkspaceFileSnapshotEntry> = {};
                        for (const request of requests) {
                            result[request.requestPath] = await snapshotOne(workspaceRoot, notebookPath, request);
                        }
                        return sendJson(res, 200, { files: result });
                    }

                    if (route === '/__webnb/asset') {
                        const rel = parsed.searchParams.get('path') || '';
                        const abs = safeResolve(workspaceRoot, rel);
                        if (!abs) {
                            res.statusCode = 400;
                            return res.end('Invalid asset path.');
                        }
                        try {
                            const stat = await fsp.stat(abs);
                            if (!stat.isFile()) { throw new Error('not a file'); }
                            const ext = path.extname(abs).toLowerCase();
                            res.statusCode = 200;
                            res.setHeader('Content-Type', ASSET_CONTENT_TYPES[ext] || 'application/octet-stream');
                            res.setHeader('Cache-Control', 'no-cache');
                            const stream = fs.createReadStream(abs);
                            stream.on('error', () => {
                                if (!res.headersSent) {
                                    res.statusCode = 500;
                                    res.end('Asset read error.');
                                } else {
                                    res.destroy();
                                }
                            });
                            stream.pipe(res);
                            return;
                        } catch {
                            res.statusCode = 404;
                            return res.end('Asset not found.');
                        }
                    }

                    return sendJson(res, 404, { error: 'Unknown webnb endpoint.' });
                } catch (error) {
                    return sendJson(res, 500, { error: (error as Error).message });
                }
            });

            server.config.logger.info(`\n  webnb workspace: ${workspaceRoot}\n`);
        }
    };
}

/** Convenience for vite.config.ts so it can resolve __dirname under ESM. */
export function previewDirFromUrl(url: string): string {
    return path.dirname(fileURLToPath(url));
}
