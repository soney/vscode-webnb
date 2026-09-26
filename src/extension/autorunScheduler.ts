/**
 * Decides when autorun cells (metadata `autorun`/`runonstart`, plus auto-widget
 * languages like mcq/external/walkthrough) execute, and makes sure each one
 * only executes once per version of its own text.
 *
 * Two retry mechanisms cover editor-startup races:
 *  - per-notebook discovery retries, for when an editor is visible before its
 *    cells are populated;
 *  - a timed sweep over all visible editors, for when open/select events fire
 *    before the workbench is ready to execute anything.
 * Per-cell executed-version tracking keeps the retries idempotent and keeps
 * edits local: editing one autorun cell re-runs that cell, not every autorun
 * and widget cell in the notebook (which re-rendered, and reset, every multiple
 * choice question on each typing pause).
 */
import * as vscode from 'vscode';
import { runsOnOpen } from '../shared/addons';
import { logExecution, rangesLabel, uriLabel, warnExecution } from './log';
import { getNotebookKey, isRemoteNotebookAlias, notebookUrisMatch } from './notebookUris';

const MAX_AUTORUN_DISCOVERY_RETRIES = 10;
const AUTORUN_RETRY_DELAY_MS = 150;
const AUTORUN_SWEEP_ATTEMPTS = 12;
const AUTORUN_SWEEP_DELAY_MS = 250;

export interface AutorunSchedulerDeps {
    notebookType: string;
    /** Marks the kernel's controller as preferred for the notebook. */
    ensureControllerAssociation(notebook: vscode.NotebookDocument): void;
    /** Executes the ranges; resolves true when every cell actually ran. */
    executeRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean>;
}

export class AutorunScheduler implements vscode.Disposable {
    /** Set once the kernel is disposed; pending retries and sweeps then do nothing. */
    private _disposed = false;
    /** Per notebook: the document version each autorun cell last ran at, by cell document uri. */
    private readonly _executedVersions = new Map<string, Map<string, number>>();
    private readonly _pendingNotebooks = new Set<string>();
    private readonly _discoveryRetries = new Map<string, number>();
    private readonly _runOnStartExecutedNotebooks = new Set<string>();

    public constructor(private readonly _deps: AutorunSchedulerDeps) { }

    public dispose(): void {
        this._disposed = true;
    }

    /** Runs the notebook's autorun cells that have not run at their current versions. */
    public runForEditor(editor: vscode.NotebookEditor): void {
        const { notebook } = editor;
        if (this._disposed || notebook.notebookType !== this._deps.notebookType) {
            return;
        }
        if (isRemoteNotebookAlias(notebook.uri)) {
            warnExecution('autorun skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
            return;
        }

        this._deps.ensureControllerAssociation(notebook);

        const notebookKey = getNotebookKey(notebook.uri);
        if (this._pendingNotebooks.has(notebookKey)) {
            return;
        }

        const autorunCells = this._getAutorunCells(notebook);
        if (autorunCells.length === 0) {
            const nextRetry = (this._discoveryRetries.get(notebookKey) ?? 0) + 1;
            if (nextRetry <= MAX_AUTORUN_DISCOVERY_RETRIES) {
                this._discoveryRetries.set(notebookKey, nextRetry);
                setTimeout(() => {
                    const retryEditor = vscode.window.visibleNotebookEditors
                        .find(candidate => !isRemoteNotebookAlias(candidate.notebook.uri) && notebookUrisMatch(candidate.notebook.uri, notebook.uri));
                    if (retryEditor) {
                        this.runForEditor(retryEditor);
                    }
                }, AUTORUN_RETRY_DELAY_MS);
            }
            return;
        }

        const executed = this._executedVersions.get(notebookKey);
        const staleCells = autorunCells.filter(cell => executed?.get(cell.document.uri.toString()) !== cell.document.version);
        if (staleCells.length === 0) {
            return;
        }

        this._discoveryRetries.delete(notebookKey);

        // The versions these runs will show, taken now: an edit that lands
        // while the batch is running leaves its cell stale, so it runs again.
        const versions = new Map(staleCells.map(cell => [cell.document.uri.toString(), cell.document.version]));
        this._pendingNotebooks.add(notebookKey);
        setTimeout(() => {
            void this._executeAutorunCells(editor, this._getCellRanges(staleCells), versions);
        }, 0);
    }

    /** Runs autorun for every visible editor showing this notebook. */
    public runForNotebook(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== this._deps.notebookType) {
            return;
        }

        const matchingEditors = vscode.window.visibleNotebookEditors
            .filter(editor => !isRemoteNotebookAlias(editor.notebook.uri) && notebookUrisMatch(editor.notebook.uri, notebook.uri));
        for (const editor of matchingEditors) {
            this.runForEditor(editor);
        }
    }

    /** Re-checks all visible editors on a timer, for events that fire too early. */
    public scheduleSweep(attemptsLeft: number = AUTORUN_SWEEP_ATTEMPTS): void {
        if (attemptsLeft <= 0 || this._disposed) {
            return;
        }

        setTimeout(() => {
            for (const visibleEditor of vscode.window.visibleNotebookEditors) {
                this.runForEditor(visibleEditor);
            }
            this.scheduleSweep(attemptsLeft - 1);
        }, AUTORUN_SWEEP_DELAY_MS);
    }

    /** Forgets a closed notebook so reopening it autoruns again. */
    public forgetNotebook(uri: vscode.Uri): void {
        const notebookKey = getNotebookKey(uri);
        this._executedVersions.delete(notebookKey);
        this._pendingNotebooks.delete(notebookKey);
        this._discoveryRetries.delete(notebookKey);
        this._runOnStartExecutedNotebooks.delete(notebookKey);
    }

    private _getAutorunCells(notebook: vscode.NotebookDocument): vscode.NotebookCell[] {
        const notebookKey = getNotebookKey(notebook.uri);
        const runOnStartAlreadyDone = this._runOnStartExecutedNotebooks.has(notebookKey);
        return notebook.getCells()
            .filter(cell =>
                cell.kind === vscode.NotebookCellKind.Code
                && runsOnOpen(
                    {
                        languageId: cell.document.languageId,
                        autorun: cell.metadata?.autorun,
                        runonstart: cell.metadata?.runonstart,
                        hidecode: cell.metadata?.hidecode
                    },
                    { runOnStartAlreadyDone }
                )
            );
    }

    private _getCellRanges(cells: vscode.NotebookCell[]): vscode.NotebookRange[] {
        return cells
            .filter(cell => cell.index >= 0)
            .map(cell => new vscode.NotebookRange(cell.index, cell.index + 1));
    }

    private async _executeAutorunCells(editor: vscode.NotebookEditor, ranges: vscode.NotebookRange[], versions: Map<string, number>): Promise<void> {
        const notebookKey = getNotebookKey(editor.notebook.uri);
        logExecution('autorun start notebook=%s ranges=%s cells=%s',
            uriLabel(editor.notebook.uri),
            rangesLabel(ranges),
            [...versions].map(([cellKey, version]) => `${cellKey}@${version}`).join(' '));
        let executed = false;
        try {
            executed = await this._deps.executeRanges(editor.notebook, ranges);
            if (executed) {
                this._runOnStartExecutedNotebooks.add(notebookKey);
                let executedVersions = this._executedVersions.get(notebookKey);
                if (!executedVersions) {
                    executedVersions = new Map();
                    this._executedVersions.set(notebookKey, executedVersions);
                }
                for (const [cellKey, version] of versions) {
                    executedVersions.set(cellKey, version);
                }
                // Cells replaced since (a reload) would otherwise pile up here.
                const current = new Set(editor.notebook.getCells().map(cell => cell.document.uri.toString()));
                for (const cellKey of [...executedVersions.keys()]) {
                    if (!current.has(cellKey)) {
                        executedVersions.delete(cellKey);
                    }
                }
                this._discoveryRetries.delete(notebookKey);
            }
            logExecution('autorun end notebook=%s executed=%s', notebookKey, String(executed));
        } finally {
            this._pendingNotebooks.delete(notebookKey);
        }

        // Edits made while the batch ran were turned away by the pending
        // guard; look again now, so the last of them is not left unrun.
        if (executed && !editor.notebook.isClosed) {
            this.runForNotebook(editor.notebook);
        }
    }
}
