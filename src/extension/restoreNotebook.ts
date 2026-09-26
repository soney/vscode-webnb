import * as vscode from 'vscode';
import type { Addon } from '../shared/protocol';
import { getAddonContent, hasAddon, isAutoWidgetLanguage, normalizeAddonType, runsOnOpen } from '../shared/addons';
import { errorExecution, logExecution, uriLabel } from './log';

const NOTEBOOK_TYPE = 'web-notebook';
const COMMAND_ID = 'webnb.restoreNotebook';

const CONFIRM_MESSAGE = 'Restore this notebook to its starter state? Edited code cells go back to their starter code, and saved multiple choice answers and terminal history are cleared.';
const CONFIRM_BUTTON = 'Restore';

/** The learner state a restore throws away, by addon type. */
const LEARNER_STATE_ADDONS = new Set(['selection', 'history']);

export interface NotebookRestorerOptions {
    /** Runs cells through the kernel so restored widgets re-render. */
    executeRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean>;
    /** Drops the outputs of these cells, which all belong to one notebook. */
    clearOutputs(cells: vscode.NotebookCell[]): Promise<void>;
    /** Tells the renderer to forget these cells' in-memory terminal history. */
    forgetTerminalHistory?(notebook: vscode.NotebookDocument, cellUris: string[]): Promise<void>;
}

/**
 * The "Restore Notebook to Starter State" command: one action that undoes
 * learner-style state across the whole notebook — every code cell with a
 * `+default` (authored, or captured on first edit; an empty one restores an
 * empty cell) gets its starter text back, and `+selection` (saved MCQ answers)
 * and `+history` (terminal history) addons are removed. Everything lands in a
 * single WorkspaceEdit, so one undo brings the previous state back. Made for
 * the author who accidentally works through a notebook in a source checkout.
 */
export class NotebookRestorer implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];

    public constructor(private readonly options: NotebookRestorerOptions) {
        this._disposables.push(
            vscode.commands.registerCommand(COMMAND_ID, (target?: unknown) => this._restoreNotebook(target))
        );
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    /**
     * The notebook the command was invoked on: the notebook toolbar passes the
     * notebook itself, the editor title menu passes its resource, and the
     * command palette passes nothing (the active notebook, then).
     */
    private _targetNotebook(target: unknown): vscode.NotebookDocument | undefined {
        if (target instanceof vscode.Uri) {
            return vscode.workspace.notebookDocuments.find(notebook => notebook.uri.toString() === target.toString());
        }
        if (target && typeof target === 'object' && typeof (target as vscode.NotebookDocument).getCells === 'function'
            && typeof (target as vscode.NotebookDocument).notebookType === 'string') {
            return target as vscode.NotebookDocument;
        }
        return vscode.window.activeNotebookEditor?.notebook;
    }

    private async _restoreNotebook(target?: unknown): Promise<void> {
        // Bound before the prompt: whatever the reader looks at while it is up,
        // this is the notebook they asked to restore.
        const notebook = this._targetNotebook(target);
        if (!notebook || notebook.notebookType !== NOTEBOOK_TYPE) {
            void vscode.window.showInformationMessage('Open a Web Notebook to restore it.');
            return;
        }

        const choice = await vscode.window.showWarningMessage(CONFIRM_MESSAGE, { modal: true }, CONFIRM_BUTTON);
        if (choice !== CONFIRM_BUTTON) {
            return;
        }
        if (notebook.isClosed) {
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const notebookEdits: vscode.NotebookEdit[] = [];
        let restoredCells = 0;
        let clearedAnswers = 0;
        let clearedHistories = 0;
        const clearedHistoryCells: string[] = [];

        for (const cell of notebook.getCells()) {
            if (cell.kind !== vscode.NotebookCellKind.Code) {
                continue;
            }

            const metadata = (cell.metadata ?? {}) as Record<string, unknown>;
            const addons: Addon[] = Array.isArray(metadata.addons) ? metadata.addons as Addon[] : [];

            const keep = addons.map(addon => !LEARNER_STATE_ADDONS.has(normalizeAddonType(addon.type)));
            if (keep.includes(false)) {
                clearedAnswers += addons.filter(addon => normalizeAddonType(addon.type) === 'selection').length;
                const histories = addons.filter(addon => normalizeAddonType(addon.type) === 'history').length;
                clearedHistories += histories;
                if (histories > 0) {
                    clearedHistoryCells.push(cell.document.uri.toString());
                }
                // The gap in front of each addon is index-aligned with it; drop
                // the removed addons' gaps too, or the rest shift onto the wrong blocks.
                const gaps = metadata.addonWhitespace;
                notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, {
                    ...metadata,
                    addons: addons.filter((_addon, index) => keep[index]),
                    ...(Array.isArray(gaps) ? { addonWhitespace: gaps.filter((_gap, index) => keep[index] ?? true) } : {})
                }));
            }

            if (isAutoWidgetLanguage(cell.document.languageId) || !hasAddon(addons, 'default')) {
                continue;
            }

            // An empty `+default` is a starter too: the cell shipped empty.
            const defaultContent = getAddonContent(addons, 'default') ?? '';
            if (cell.document.getText() !== defaultContent) {
                const fullRange = cell.document.validateRange(
                    new vscode.Range(0, 0, cell.document.lineCount, 0)
                );
                edit.replace(cell.document.uri, fullRange, defaultContent);
                restoredCells++;
            }
        }

        if (notebookEdits.length > 0) {
            edit.set(notebook.uri, notebookEdits);
        }

        if (restoredCells === 0 && clearedAnswers === 0 && clearedHistories === 0) {
            void vscode.window.showInformationMessage('This notebook is already in its starter state.');
            return;
        }

        try {
            if (!await vscode.workspace.applyEdit(edit)) {
                void vscode.window.showWarningMessage('Could not restore the notebook (the edit was rejected).');
                return;
            }
        } catch (error) {
            errorExecution('Failed to restore %s: %s', uriLabel(notebook.uri), String(error));
            return;
        }

        // Stale outputs would contradict the restored sources. The cells that
        // run on their own -- widgets, autorun and hidecode demos, runonstart
        // cells -- are run again to show their starter output, including the
        // ones the restore did not change (nothing else would re-run those);
        // every other output is dropped.
        const code = notebook.getCells().filter(cell => cell.kind === vscode.NotebookCellKind.Code);
        const rerun = code.filter(cell => runsOnOpen({
            languageId: cell.document.languageId,
            autorun: cell.metadata?.autorun,
            runonstart: cell.metadata?.runonstart,
            hidecode: cell.metadata?.hidecode
        }));
        try {
            await this.options.clearOutputs(code.filter(cell => cell.outputs.length > 0 && !rerun.includes(cell)));
        } catch {
            // Clearing outputs is cosmetic; the restore itself already landed.
        }
        // The renderer keeps each terminal's session in memory; it has to
        // forget the cleared ones before those cells re-render.
        if (clearedHistoryCells.length > 0) {
            try {
                await this.options.forgetTerminalHistory?.(notebook, clearedHistoryCells);
            } catch {
                // Worst case the terminal shows its old commands until reload.
            }
        }
        // One cell per call: a collision with a run already in flight must not
        // keep the cells after it from re-rendering.
        for (const cell of rerun) {
            await this.options.executeRanges(notebook, [new vscode.NotebookRange(cell.index, cell.index + 1)]);
        }

        logExecution('Restored %s: %d cell(s) reset, %d answer(s) and %d terminal history(ies) cleared',
            uriLabel(notebook.uri), restoredCells, clearedAnswers, clearedHistories);
        const historyNote = clearedHistories > 0 ? `, ${clearedHistories} terminal history(ies) cleared` : '';
        void vscode.window.showInformationMessage(
            `Notebook restored: ${restoredCells} cell(s) reset, ${clearedAnswers} answer(s) cleared${historyNote}.`
        );
    }
}
