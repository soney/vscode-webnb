/** Shared types for the preview app. Wire-protocol shapes come from
 * src/shared/protocol.ts — the same declarations the extension host and the
 * renderer compile against — so the preview cannot drift from VS Code. */

export type {
    Addon,
    RequestedPathReference as SnapshotRequest,
    WebnbOutputValue,
    WebNbRendererMessage as RendererMessage,
    WorkspaceFileSnapshotEntry
} from '../../src/shared/protocol';

export interface NotebookSummary {
    path: string;
    name: string;
    dir: string;
}

export interface NotebookListResponse {
    workspace: string;
    notebooks: NotebookSummary[];
}

/** Custom HMR event payload pushed by the dev server when disk changes. */
export interface FsChangeEvent {
    event: 'change' | 'add' | 'unlink';
    path: string;
    isNotebook: boolean;
}
