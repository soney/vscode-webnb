/** Shared types for the preview app. */

export interface NotebookSummary {
    path: string;
    name: string;
    dir: string;
}

export interface NotebookListResponse {
    workspace: string;
    notebooks: NotebookSummary[];
}

export interface Addon {
    type: string;
    content: string;
    id?: string;
}

export interface WorkspaceFileSnapshotEntry {
    path: string;
    resolvedPath?: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

export interface SnapshotRequest {
    requestPath: string;
    path: string;
    base: 'notebook' | 'workspace';
}

/** The output payload consumed by the extension's render() function. */
export interface WebnbOutputValue {
    source: string;
    language: string;
    addons: Addon[];
    files: Record<string, WorkspaceFileSnapshotEntry>;
    cellUri: string;
    checkedAt: number;
}

/** Messages render() posts back through the (faked) renderer context. */
export type RendererMessage =
    | { type: 'webnb.refreshCell'; cellUri: string }
    | { type: 'webnb.upsertCellAddon'; cellUri: string; addonType: string; content: string }
    | { type: 'webnb.openWorkspaceFile'; cellUri: string; path: string; line?: number };

/** Custom HMR event payload pushed by the dev server when disk changes. */
export interface FsChangeEvent {
    event: 'change' | 'add' | 'unlink';
    path: string;
    isNotebook: boolean;
}
