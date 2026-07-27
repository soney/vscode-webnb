import * as vscode from 'vscode';

const NOTEBOOK_TYPE = 'web-notebook';
const CONFIG_SECTION = 'webnb';
const LOCK_SETTING = 'lockCellStructure';
/** How long before the same notebook may explain the lock again. */
const NOTICE_THROTTLE_MS = 5000;
/** Runaway guard: more than this many reverts inside the window means a feedback loop. */
const MAX_REVERTS_PER_WINDOW = 8;
const REVERT_BURST_WINDOW_MS = 2000;

const NOTICE_MESSAGE = 'This notebook\'s cells are locked. You can still edit and run cell contents, but cells cannot be added, removed, or reordered.';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new CellStructureLock());
}

export function deactivate() { }

/**
 * Keeps learners from changing the shape of a notebook.
 *
 * VS Code has no API to veto a structural notebook edit, so the lock is reactive: when
 * cells are spliced in or out we splice the originals back. Only structural changes are
 * touched, so editing a code example still works, and so does answering a multiple choice
 * question -- that persists as cell metadata, which arrives as a cell change rather than
 * a content change.
 */
export class CellStructureLock implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Notebooks whose own revert is in flight, so the echo of that edit is ignored. */
    private readonly _reverting = new Set<string>();
    private readonly _lastNoticeAt = new Map<string, number>();
    private readonly _revertBursts = new Map<string, { count: number; since: number }>();

    public constructor() {
        this._disposables.push(
            vscode.workspace.onDidChangeNotebookDocument(event => this._onDidChangeNotebook(event)),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                const key = notebook.uri.toString();
                this._lastNoticeAt.delete(key);
                this._revertBursts.delete(key);
            })
        );
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    private _isLocked(notebook: vscode.NotebookDocument): boolean {
        return vscode.workspace
            .getConfiguration(CONFIG_SECTION, notebook.uri)
            .get<boolean>(LOCK_SETTING, true);
    }

    private _onDidChangeNotebook(event: vscode.NotebookDocumentChangeEvent): void {
        const { notebook } = event;
        if (notebook.notebookType !== NOTEBOOK_TYPE || event.contentChanges.length === 0) {
            return;
        }

        const key = notebook.uri.toString();
        if (this._reverting.has(key) || !this._isLocked(notebook) || this._isRunawayLoop(key)) {
            return;
        }

        // A removed cell keeps a direct reference to its text document, but only until the
        // host tears that document down. Read every cell we need to restore up front, before
        // anything awaits.
        let edits: vscode.NotebookEdit[];
        try {
            edits = buildRevertEdits(event.contentChanges);
        } catch (error) {
            console.error('[webnb] Could not read cells removed from %s, leaving the change in place:', key, error);
            return;
        }

        if (edits.length > 0) {
            void this._revert(notebook, key, edits);
        }
    }

    private async _revert(notebook: vscode.NotebookDocument, key: string, edits: vscode.NotebookEdit[]): Promise<void> {
        this._reverting.add(key);
        try {
            // Each edit's indexes assume every later splice has already been undone, so they
            // are applied one at a time, back to front, against a settled document.
            for (const notebookEdit of edits) {
                const edit = new vscode.WorkspaceEdit();
                edit.set(notebook.uri, [notebookEdit]);
                if (!await vscode.workspace.applyEdit(edit)) {
                    console.warn('[webnb] Rejected edit while restoring locked cell structure for %s', key);
                    return;
                }
            }
            this._showNotice(key);
        } catch (error) {
            console.error('[webnb] Failed to restore locked cell structure for %s:', key, error);
        } finally {
            // The change event for our own edit crosses the same RPC channel as the reply to
            // applyEdit, so it has already been delivered by the time we get here. Clearing a
            // turn later keeps that echo on the ignored side of the guard.
            setTimeout(() => this._reverting.delete(key), 0);
        }
    }

    /**
     * Stands down if reverts keep firing, so a lock that somehow fights itself degrades into
     * an unlocked notebook instead of an editor that cannot settle. Going quiet ends the
     * burst, which lets the window lapse and the lock resume.
     */
    private _isRunawayLoop(key: string): boolean {
        const now = Date.now();
        const burst = this._revertBursts.get(key);
        if (!burst || now - burst.since > REVERT_BURST_WINDOW_MS) {
            this._revertBursts.set(key, { count: 1, since: now });
            return false;
        }

        burst.count++;
        if (burst.count > MAX_REVERTS_PER_WINDOW) {
            console.error('[webnb] Too many cell structure reverts for %s, leaving it unlocked briefly', key);
            return true;
        }

        return false;
    }

    private _showNotice(key: string): void {
        const now = Date.now();
        const lastNoticeAt = this._lastNoticeAt.get(key);
        if (lastNoticeAt !== undefined && now - lastNoticeAt < NOTICE_THROTTLE_MS) {
            return;
        }

        this._lastNoticeAt.set(key, now);
        void vscode.window.showWarningMessage(NOTICE_MESSAGE);
    }
}

/**
 * Turns the splices reported by a change event into the edits that undo them, ordered back
 * to front. Each change's range covers the cells it removed from the document as it stood
 * before that splice; whatever it added sits at the same start index once the splice lands.
 */
function buildRevertEdits(contentChanges: readonly vscode.NotebookDocumentContentChange[]): vscode.NotebookEdit[] {
    const edits: vscode.NotebookEdit[] = [];
    for (let index = contentChanges.length - 1; index >= 0; index--) {
        const change = contentChanges[index];
        if (change.addedCells.length === 0 && change.removedCells.length === 0) {
            continue;
        }

        const start = change.range.start;
        const addedRange = new vscode.NotebookRange(start, start + change.addedCells.length);
        edits.push(vscode.NotebookEdit.replaceCells(addedRange, change.removedCells.map(toCellData)));
    }

    return edits;
}

/** Copies a removed cell so it can be put back. Its `index` no longer resolves, so nothing here may read it. */
function toCellData(cell: vscode.NotebookCell): vscode.NotebookCellData {
    const data = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
    data.metadata = cell.metadata;
    data.outputs = cell.outputs.map(output => new vscode.NotebookCellOutput(
        output.items.map(item => new vscode.NotebookCellOutputItem(item.data, item.mime)),
        output.metadata
    ));
    return data;
}
