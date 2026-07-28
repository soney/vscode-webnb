/**
 * Notebook URI identity helpers. In remote/web hosts the same notebook can
 * surface under a `vscode-remote:` alias of its `file:` URI; execution always
 * targets the file-scheme document, so comparisons and map keys normalize
 * through that alias first.
 */
import * as vscode from 'vscode';

const FILE_SCHEME = 'file';
const VSCODE_REMOTE_SCHEME = 'vscode-remote';
const WEBNB_EXTENSION = '.webnb';

export function isRemoteNotebookAlias(uri: vscode.Uri): boolean {
    return uri.scheme === VSCODE_REMOTE_SCHEME
        && uri.path.toLowerCase().endsWith(WEBNB_EXTENSION);
}

export function getExecutionNotebookUri(uri: vscode.Uri): vscode.Uri {
    if (isRemoteNotebookAlias(uri)) {
        return uri.with({ scheme: FILE_SCHEME, authority: '' });
    }

    return uri;
}

/** A stable map key for a notebook, indifferent to the remote alias. */
export function getNotebookKey(uri: vscode.Uri): string {
    const executionUri = getExecutionNotebookUri(uri);
    return [
        executionUri.scheme,
        executionUri.authority,
        executionUri.path.replace(/\/+$/, '') || '/',
        executionUri.query,
        executionUri.fragment
    ].join('\n');
}

export function notebookUrisMatch(a: vscode.Uri, b: vscode.Uri): boolean {
    const normalizedA = getExecutionNotebookUri(a);
    const normalizedB = getExecutionNotebookUri(b);
    if (normalizedA.toString() === normalizedB.toString()) {
        return true;
    }

    return normalizedA.scheme === normalizedB.scheme
        && normalizedA.path === normalizedB.path
        && normalizedA.query === normalizedB.query
        && normalizedA.fragment === normalizedB.fragment
        && (!normalizedA.authority || !normalizedB.authority || normalizedA.authority === normalizedB.authority);
}
