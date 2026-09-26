/**
 * Resolves the workspace-file paths a cell references and snapshots them
 * (contents, directory listings) into the output payload the renderer's
 * checks and walkthroughs read. Path grammar and resolution rules come from
 * src/shared so the preview harness snapshots identically.
 */
import * as vscode from 'vscode';
import type { Addon, WorkspaceFileSnapshotEntry } from '../shared/protocol';
import {
    fileTooLargeError,
    getRequestedFilePaths,
    MAX_FILE_SNAPSHOT_BYTES,
    normalizeWorkspacePath,
    parseRequestedPathReference,
    RELATIVE_PATHS_ERROR,
    resolveWorkspaceRelativePath
} from '../shared/filePaths';
import { isRealPathInside } from './workspaceContainment';

function fileTypeToString(type: vscode.FileType): WorkspaceFileSnapshotEntry['type'] {
    if (type & vscode.FileType.Directory) {
        return 'directory';
    }
    if (type & vscode.FileType.File) {
        return 'file';
    }
    if (type & vscode.FileType.SymbolicLink) {
        return 'symlink';
    }
    return 'unknown';
}

/** Where a cell's paths resolve from, and the notebook's own directory within it. */
interface ResolutionRoot {
    root: vscode.Uri;
    notebookRelativeDir: string;
}

/**
 * The workspace folder holding the notebook, with the notebook's directory
 * relative to it. A notebook no folder holds -- one opened on its own -- uses
 * its own directory for both, so its relative paths still resolve where the
 * author meant; an untitled notebook has no directory at all.
 */
function getResolutionRoot(cell: vscode.NotebookCell): ResolutionRoot | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(cell.notebook.uri);
    if (folder) {
        const notebookPath = vscode.workspace.asRelativePath(cell.notebook.uri, false).replace(/\\/g, '/');
        const slashIndex = notebookPath.lastIndexOf('/');
        return { root: folder.uri, notebookRelativeDir: slashIndex < 0 ? '' : notebookPath.slice(0, slashIndex) };
    }
    if (cell.notebook.isUntitled || cell.notebook.uri.scheme === 'untitled') {
        return undefined;
    }
    return { root: vscode.Uri.joinPath(cell.notebook.uri, '..'), notebookRelativeDir: '' };
}

function resolveInRoot(resolution: ResolutionRoot, reference: Parameters<typeof resolveWorkspaceRelativePath>[0], normalizedPath: string): vscode.Uri {
    const workspaceResolvedPath = resolveWorkspaceRelativePath(reference, normalizedPath, resolution.notebookRelativeDir);
    return vscode.Uri.joinPath(resolution.root, ...workspaceResolvedPath.split('/'));
}

/** Resolves a `file:` path written in a cell to a workspace file URI. */
export function resolveWorkspaceFileUri(cell: vscode.NotebookCell, requestPath: string): vscode.Uri | undefined {
    const reference = parseRequestedPathReference(requestPath);
    const normalizedPath = normalizeWorkspacePath(reference.path);
    const resolution = getResolutionRoot(cell);
    if (!normalizedPath || !resolution) {
        return undefined;
    }

    return resolveInRoot(resolution, reference, normalizedPath);
}

/**
 * resolveWorkspaceFileUri, for a file that is about to be read or opened: also
 * undefined when the path escapes the workspace through a symlink.
 */
export async function resolveContainedWorkspaceFileUri(cell: vscode.NotebookCell, requestPath: string): Promise<vscode.Uri | undefined> {
    const uri = resolveWorkspaceFileUri(cell, requestPath);
    const resolution = getResolutionRoot(cell);
    if (!uri || !resolution) {
        return undefined;
    }
    return await isRealPathInside(resolution.root, uri) ? uri : undefined;
}

export async function snapshotWorkspaceFiles(cell: vscode.NotebookCell, addons: Addon[], languageId: string, source: string): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
    const requestedPaths = getRequestedFilePaths(addons, languageId, source);
    if (requestedPaths.length === 0) {
        return {};
    }

    const resolution = getResolutionRoot(cell);
    const snapshots: Record<string, WorkspaceFileSnapshotEntry> = {};

    if (!resolution) {
        for (const requestedPath of requestedPaths) {
            snapshots[requestedPath.requestPath] = {
                path: requestedPath.requestPath,
                exists: false,
                error: 'No workspace folder is open.'
            };
        }
        return snapshots;
    }

    for (const requestedPath of requestedPaths) {
        const normalizedPath = normalizeWorkspacePath(requestedPath.path);
        const snapshotKey = requestedPath.requestPath;

        if (!normalizedPath) {
            snapshots[snapshotKey] = {
                path: requestedPath.requestPath,
                exists: false,
                error: RELATIVE_PATHS_ERROR
            };
            continue;
        }

        const uri = resolveInRoot(resolution, requestedPath, normalizedPath);
        try {
            // A symlink that leads outside the workspace reads as missing:
            // a check must never report on, or show, a file outside it.
            if (!await isRealPathInside(resolution.root, uri)) {
                throw new Error('outside the workspace');
            }
            const stat = await vscode.workspace.fs.stat(uri);
            const type = fileTypeToString(stat.type);
            const snapshot: WorkspaceFileSnapshotEntry = {
                path: requestedPath.requestPath,
                exists: true,
                type,
                size: stat.size
            };

            if (type === 'file') {
                if (stat.size <= MAX_FILE_SNAPSHOT_BYTES) {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    snapshot.content = new TextDecoder('utf-8').decode(bytes);
                } else {
                    snapshot.error = fileTooLargeError();
                }
            } else if (type === 'directory') {
                const entries = await vscode.workspace.fs.readDirectory(uri);
                snapshot.entries = entries.map(([name, entryType]) => ({
                    name,
                    type: fileTypeToString(entryType) || 'unknown'
                }));
            }

            snapshots[snapshotKey] = snapshot;
        } catch {
            snapshots[snapshotKey] = {
                path: requestedPath.requestPath,
                exists: false
            };
        }
    }

    return snapshots;
}
