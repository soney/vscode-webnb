/**
 * In-browser "kernel": builds the output `value` the renderer consumes, exactly
 * as the extension's webnbProvider._doExecuteCell does — except file snapshots
 * come from the dev server (disk, read-only) overlaid with the virtual
 * filesystem (browser edits), instead of vscode.workspace.fs.
 */
import { fetchDiskSnapshot } from './api';
import { getRequestedFilePaths } from './fileChecks';
import type { VirtualFs } from './vfs';
import type { Addon, WebnbOutputValue, WorkspaceFileSnapshotEntry } from './types';
import type { CellModel } from './notebookModel';

function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

/** Mirror of webnbProvider.getDefaultCaptureAddons: fill an empty `default` addon with the source. */
function applyDefaultCapture(addons: Addon[], source: string): Addon[] {
    const idx = addons.findIndex(addon => normalizeAddonType(addon.type) === 'default');
    if (idx < 0) { return addons; }
    const existing = addons[idx];
    if (existing.content.trim().length > 0) { return addons; }
    const updated = addons.slice();
    updated[idx] = { ...existing, content: source };
    return updated;
}

export function isExternalCheckLanguage(languageId: string): boolean {
    return languageId === 'external' || languageId === 'checklist';
}

export function isAutoWidgetLanguage(languageId: string): boolean {
    return languageId === 'mcq' || languageId === 'walkthrough' || isExternalCheckLanguage(languageId);
}

/** Cells that run on open (autorun/runonstart) or are auto-widgets (mcq/external/checklist). */
export function shouldAutorun(model: CellModel): boolean {
    return (
        model.kind === 'code' &&
        (!!model.metadata.autorun || !!model.metadata.runonstart || isAutoWidgetLanguage(model.languageId))
    );
}

/** Whether a cell reads the (virtual) filesystem, so it should re-run when the VFS changes. */
export function dependsOnFiles(languageId: string, source: string, addons: Addon[]): boolean {
    return isExternalCheckLanguage(languageId) || getRequestedFilePaths(addons, languageId, source).length > 0;
}

export interface BuildOutputParams {
    notebookPath: string;
    cellUri: string;
    source: string;
    languageId: string;
    addons: Addon[];
    vfs: VirtualFs;
}

export async function buildOutputValue(params: BuildOutputParams): Promise<WebnbOutputValue> {
    const { notebookPath, cellUri, source, languageId, addons, vfs } = params;

    const requests = getRequestedFilePaths(addons, languageId, source);
    const disk = await fetchDiskSnapshot(notebookPath, requests);

    const files: Record<string, WorkspaceFileSnapshotEntry> = {};
    for (const request of requests) {
        const diskEntry: WorkspaceFileSnapshotEntry =
            disk[request.requestPath] ?? { path: request.requestPath, exists: false };
        files[request.requestPath] = vfs.mergeSnapshot(diskEntry);
    }

    return {
        source,
        language: languageId,
        addons: applyDefaultCapture(addons, source),
        files,
        cellUri,
        checkedAt: Date.now()
    };
}
