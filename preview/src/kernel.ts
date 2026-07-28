/**
 * In-browser "kernel": builds the output `value` the renderer consumes, exactly
 * as the extension's webnbProvider._doExecuteCell does — except file snapshots
 * come from the dev server (disk, read-only) overlaid with the virtual
 * filesystem (browser edits), instead of vscode.workspace.fs.
 *
 * Path discovery and addon handling come from src/shared, the same modules the
 * extension host uses, so the harness cannot drift from what VS Code snapshots.
 */
import { fetchDiskSnapshot } from './api';
import { getRequestedFilePaths } from '../../src/shared/filePaths';
import { getDefaultCaptureAddons, isAutoWidgetLanguage, isExternalCheckLanguage } from '../../src/shared/addons';
import type { VirtualFs } from './vfs';
import type { Addon, WebnbOutputValue, WorkspaceFileSnapshotEntry } from './types';
import type { CellModel } from './notebookModel';

export { isAutoWidgetLanguage, isExternalCheckLanguage } from '../../src/shared/addons';

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
        addons: getDefaultCaptureAddons(addons, source).addons,
        files,
        cellUri,
        checkedAt: Date.now()
    };
}
