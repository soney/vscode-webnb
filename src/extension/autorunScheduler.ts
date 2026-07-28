/**
 * Decides when autorun cells (metadata `autorun`/`runonstart`, plus auto-widget
 * languages like mcq/external/walkthrough) execute, and makes sure they only
 * execute once per notebook state.
 *
 * Two retry mechanisms cover editor-startup races:
 *  - per-notebook discovery retries, for when an editor is visible before its
 *    cells are populated;
 *  - a timed sweep over all visible editors, for when open/select events fire
 *    before the workbench is ready to execute anything.
 * Executed-signature tracking keeps the retries idempotent: a notebook whose
 * autorun cells already ran at their current versions is never re-run.
 */
import * as vscode from 'vscode';
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
    /** True for cells that render interactive widgets and should run on open. */
    isAutoWidgetCell(cell: vscode.NotebookCell): boolean;
    /** Executes the ranges; resolves true when every cell actually ran. */
    executeRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean>;
}

export class AutorunScheduler {
    private readonly _executedNotebookSignatures = new Map<string, string>();
    private readonly _pendingNotebooks = new Set<string>();
    private readonly _discoveryRetries = new Map<string, number>();
    private readonly _runOnStartExecutedNotebooks = new Set<string>();

    public constructor(private readonly _deps: AutorunSchedulerDeps) { }

    /** Runs the notebook's autorun cells unless they already ran at these versions. */
    public runForEditor(editor: vscode.NotebookEditor): void {
        const { notebook } = editor;
        if (notebook.notebookType !== this._deps.notebookType) {
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

        const cellsToRun = this._getAutorunCells(notebook);
        if (cellsToRun.length === 0) {
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

        const autorunSignature = this._getAutorunSignature(cellsToRun);
        if (this._executedNotebookSignatures.get(notebookKey) === autorunSignature) {
            return;
        }

        this._discoveryRetries.delete(notebookKey);

        this._pendingNotebooks.add(notebookKey);
        setTimeout(() => {
            void this._executeAutorunCells(editor, this._getCellRanges(cellsToRun), autorunSignature);
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
        if (attemptsLeft <= 0) {
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
        this._executedNotebookSignatures.delete(notebookKey);
        this._pendingNotebooks.delete(notebookKey);
        this._discoveryRetries.delete(notebookKey);
        this._runOnStartExecutedNotebooks.delete(notebookKey);
    }

    private _getAutorunCells(notebook: vscode.NotebookDocument): vscode.NotebookCell[] {
        const notebookKey = getNotebookKey(notebook.uri);
        const runOnStartAlreadyDone = this._runOnStartExecutedNotebooks.has(notebookKey);
        return notebook.getCells()
            .filter(cell =>
                cell.kind === vscode.NotebookCellKind.Code &&
                    (
                        cell.metadata?.autorun ||
                        this._deps.isAutoWidgetCell(cell) ||
                        (cell.metadata?.runonstart && !runOnStartAlreadyDone)
                    )
            );
    }

    private _getAutorunSignature(cells: vscode.NotebookCell[]): string {
        return cells
            .map(cell => `${cell.document.uri.toString()}@${cell.document.version}`)
            .join('\n');
    }

    private _getCellRanges(cells: vscode.NotebookCell[]): vscode.NotebookRange[] {
        return cells
            .filter(cell => cell.index >= 0)
            .map(cell => new vscode.NotebookRange(cell.index, cell.index + 1));
    }

    private async _executeAutorunCells(editor: vscode.NotebookEditor, ranges: vscode.NotebookRange[], autorunSignature: string): Promise<void> {
        const notebookKey = getNotebookKey(editor.notebook.uri);
        logExecution('autorun start notebook=%s ranges=%s signature=%s',
            uriLabel(editor.notebook.uri),
            rangesLabel(ranges),
            autorunSignature);
        try {
            const executed = await this._deps.executeRanges(editor.notebook, ranges);
            if (executed) {
                this._runOnStartExecutedNotebooks.add(notebookKey);
                this._executedNotebookSignatures.set(notebookKey, this._getAutorunSignature(this._getAutorunCells(editor.notebook)));
                this._discoveryRetries.delete(notebookKey);
            }
            logExecution('autorun end notebook=%s executed=%s', notebookKey, String(executed));
        } finally {
            this._pendingNotebooks.delete(notebookKey);
        }
    }
}
