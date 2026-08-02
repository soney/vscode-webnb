/**
 * Snapshots the workspace files a cell's checks reference, for a .webnb file
 * open as TEXT.
 *
 * The notebook extension does the same job in src/extension/workspaceSnapshots.ts,
 * but its entry points take a `vscode.NotebookCell` (it reads the notebook's URI
 * off the cell) and a text preview has no notebook. Only the plumbing is
 * repeated here: every rule about which paths a cell requests, how a request
 * resolves against the notebook's folder, and how big a file may be comes from
 * @webnb/shared, so the preview cannot drift from what the notebook snapshots.
 */
import * as vscode from 'vscode';
import type { Addon, WorkspaceFileSnapshotEntry } from '@webnb/shared/protocol';
import {
    fileTooLargeError,
    getRequestedFilePaths,
    MAX_FILE_SNAPSHOT_BYTES,
    normalizeWorkspacePath,
    parseRequestedPathReference,
    RELATIVE_PATHS_ERROR,
    resolveWorkspaceRelativePath
} from '@webnb/shared/filePaths';

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

function getWorkspaceFolderFor(notebookUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(notebookUri) ?? vscode.workspace.workspaceFolders?.[0];
}

/** The notebook's own folder, workspace-relative: what `./` paths resolve against. */
function getNotebookRelativeDir(notebookUri: vscode.Uri): string {
    const notebookPath = vscode.workspace.asRelativePath(notebookUri, false).replace(/\\/g, '/');
    const slashIndex = notebookPath.lastIndexOf('/');
    return slashIndex < 0 ? '' : notebookPath.slice(0, slashIndex);
}

/** Resolves a `file:` path written in a cell to a workspace file URI. */
export function resolveWorkspaceFileUri(notebookUri: vscode.Uri, requestPath: string): vscode.Uri | undefined {
    const reference = parseRequestedPathReference(requestPath);
    const normalizedPath = normalizeWorkspacePath(reference.path);
    const workspaceFolder = getWorkspaceFolderFor(notebookUri);
    if (!normalizedPath || !workspaceFolder) {
        return undefined;
    }

    const resolved = resolveWorkspaceRelativePath(reference, normalizedPath, getNotebookRelativeDir(notebookUri));
    return vscode.Uri.joinPath(workspaceFolder.uri, ...resolved.split('/'));
}

export async function snapshotWorkspaceFiles(
    notebookUri: vscode.Uri,
    addons: Addon[],
    languageId: string,
    source: string
): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
    const requestedPaths = getRequestedFilePaths(addons, languageId, source);
    if (requestedPaths.length === 0) {
        return {};
    }

    const snapshots: Record<string, WorkspaceFileSnapshotEntry> = {};
    const workspaceFolder = getWorkspaceFolderFor(notebookUri);
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

    const notebookRelativeDir = getNotebookRelativeDir(notebookUri);

    for (const requestedPath of requestedPaths) {
        const normalizedPath = normalizeWorkspacePath(requestedPath.path);
        if (!normalizedPath) {
            snapshots[requestedPath.requestPath] = {
                path: requestedPath.requestPath,
                exists: false,
                error: RELATIVE_PATHS_ERROR
            };
            continue;
        }

        const resolved = resolveWorkspaceRelativePath(requestedPath, normalizedPath, notebookRelativeDir);
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...resolved.split('/'));
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

            snapshots[requestedPath.requestPath] = snapshot;
        } catch {
            snapshots[requestedPath.requestPath] = {
                path: requestedPath.requestPath,
                exists: false
            };
        }
    }

    return snapshots;
}
