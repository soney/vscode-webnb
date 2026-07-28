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

function getNotebookRelativeDir(cell: vscode.NotebookCell): string {
    const notebookPath = vscode.workspace.asRelativePath(cell.notebook.uri, false).replace(/\\/g, '/');
    const slashIndex = notebookPath.lastIndexOf('/');
    if (slashIndex < 0) {
        return '';
    }

    return notebookPath.slice(0, slashIndex);
}

function getWorkspaceFolderFor(cell: vscode.NotebookCell): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(cell.notebook.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

/** Resolves a `file:` path written in a cell to a workspace file URI. */
export function resolveWorkspaceFileUri(cell: vscode.NotebookCell, requestPath: string): vscode.Uri | undefined {
    const reference = parseRequestedPathReference(requestPath);
    const normalizedPath = normalizeWorkspacePath(reference.path);
    const workspaceFolder = getWorkspaceFolderFor(cell);
    if (!normalizedPath || !workspaceFolder) {
        return undefined;
    }

    const notebookRelativeDir = getNotebookRelativeDir(cell);
    const workspaceResolvedPath = resolveWorkspaceRelativePath(reference, normalizedPath, notebookRelativeDir);
    return vscode.Uri.joinPath(workspaceFolder.uri, ...workspaceResolvedPath.split('/'));
}

export async function snapshotWorkspaceFiles(cell: vscode.NotebookCell, addons: Addon[], languageId: string, source: string): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
    const requestedPaths = getRequestedFilePaths(addons, languageId, source);
    if (requestedPaths.length === 0) {
        return {};
    }

    const workspaceFolder = getWorkspaceFolderFor(cell);
    const snapshots: Record<string, WorkspaceFileSnapshotEntry> = {};
    const notebookRelativeDir = workspaceFolder ? getNotebookRelativeDir(cell) : '';

    if (!workspaceFolder) {
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

        const workspaceResolvedPath = resolveWorkspaceRelativePath(requestedPath, normalizedPath, notebookRelativeDir);
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...workspaceResolvedPath.split('/'));
        try {
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
