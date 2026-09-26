/**
 * Whether a resolved URI stays inside a root folder.
 *
 * By path everywhere; and for `file:` URIs in a Node extension host (desktop,
 * remote, Codespaces, the course lab) also by real path, so a symlink inside
 * the workspace cannot lead a notebook to read or open something outside it.
 * The web worker extension host has no `fs` module -- and its file systems no
 * symlinks to follow -- so there the path check is the whole check. `fs` is
 * reached through `process.getBuiltinModule` rather than an import, which
 * keeps the web worker bundle free of Node modules.
 */
import * as vscode from 'vscode';

type RealpathFn = (path: string) => Promise<string>;

function nodeRealpath(): RealpathFn | undefined {
    try {
        const nodeProcess = typeof process === 'object' ? process as { getBuiltinModule?: (id: string) => unknown } : undefined;
        const fs = nodeProcess?.getBuiltinModule?.('node:fs') as { promises?: { realpath?: RealpathFn } } | undefined;
        return fs?.promises?.realpath;
    } catch {
        return undefined;
    }
}

function normalizeFsPath(path: string): string {
    const slashes = path.replace(/\\/g, '/').replace(/\/+$/, '');
    // Windows paths compare case-insensitively.
    return /^[a-zA-Z]:/.test(slashes) ? slashes.toLowerCase() : slashes;
}

function isUnder(root: string, target: string): boolean {
    return target === root || target.startsWith(root === '' ? '/' : root + '/');
}

/** `target` is `root` or somewhere below it, judged by URI path alone. */
export function isUriInside(root: vscode.Uri, target: vscode.Uri): boolean {
    if (root.scheme !== target.scheme || root.authority !== target.authority) {
        return false;
    }
    return isUnder(root.path.replace(/\/+$/, ''), target.path);
}

/**
 * `target` is inside `root` by path and, where it can be checked, by real
 * path. A target that does not exist passes the real-path half: nothing can
 * be read through it, and the caller's own stat reports it missing.
 */
export async function isRealPathInside(root: vscode.Uri, target: vscode.Uri): Promise<boolean> {
    if (!isUriInside(root, target)) {
        return false;
    }
    if (target.scheme !== 'file') {
        return true;
    }
    const realpath = nodeRealpath();
    if (!realpath) {
        return true;
    }

    let realRoot: string;
    try {
        realRoot = normalizeFsPath(await realpath(root.fsPath));
    } catch {
        return false;
    }
    try {
        return isUnder(realRoot, normalizeFsPath(await realpath(target.fsPath)));
    } catch (error) {
        return (error as { code?: string })?.code === 'ENOENT';
    }
}
