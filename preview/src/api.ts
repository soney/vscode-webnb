/** Thin client for the dev-server's /__webnb/api/* endpoints. */
import type {
    NotebookListResponse,
    SnapshotRequest,
    WorkspaceFileSnapshotEntry
} from './types';

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`);
    }
    return response.json() as Promise<T>;
}

export async function fetchNotebookList(): Promise<NotebookListResponse> {
    return getJson<NotebookListResponse>('/__webnb/api/notebooks');
}

export async function fetchNotebookSource(notebookPath: string): Promise<string> {
    const data = await getJson<{ path: string; content: string }>(
        `/__webnb/api/notebook?path=${encodeURIComponent(notebookPath)}`
    );
    return data.content;
}

/** Snapshot the on-disk state of the requested paths (browser overlay applied separately). */
export async function fetchDiskSnapshot(
    notebookPath: string,
    requests: SnapshotRequest[]
): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
    if (requests.length === 0) {
        return {};
    }
    const response = await fetch('/__webnb/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookPath, requests })
    });
    if (!response.ok) {
        throw new Error(`Snapshot request failed (${response.status})`);
    }
    const data = (await response.json()) as { files: Record<string, WorkspaceFileSnapshotEntry> };
    return data.files || {};
}

let assetVersion = 0;

/** Bump the asset cache-buster so changed images reload after a disk change. */
export function bumpAssetVersion(): void {
    assetVersion++;
}

/** Build a URL for a workspace asset (image/video/etc) referenced from markdown. */
export function assetUrl(workspaceRelPath: string): string {
    return `/__webnb/asset?path=${encodeURIComponent(workspaceRelPath)}&v=${assetVersion}`;
}
