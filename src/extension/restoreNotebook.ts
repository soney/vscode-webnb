import * as vscode from 'vscode';
import type { Addon } from '../shared/protocol';
import { getAddonContent, isAutoWidgetLanguage, normalizeAddonType } from '../shared/addons';
import { errorExecution, logExecution, uriLabel } from './log';

const NOTEBOOK_TYPE = 'web-notebook';
const COMMAND_ID = 'webnb.restoreNotebook';

const CONFIRM_MESSAGE = 'Restore this notebook to its starter state? Edited code cells go back to their starter code, and saved multiple choice answers are cleared.';
const CONFIRM_BUTTON = 'Restore';

export interface NotebookRestorerOptions {
    /** Runs cells through the kernel so restored widgets re-render. */
    executeRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean>;
}

/**
 * The "Restore Notebook to Starter State" command: one action that undoes
 * learner-style state across the whole notebook — every code cell with a
 * `+default` (authored, or captured on first edit) gets its starter text back,
 * and `+selection` addons (saved MCQ answers) are removed. Everything lands in
 * a single WorkspaceEdit, so one undo brings the previous state back. Made for
 * the author who accidentally works through a notebook in a source checkout.
 */
export class NotebookRestorer implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];

    public constructor(private readonly options: NotebookRestorerOptions) {
        this._disposables.push(
            vscode.commands.registerCommand(COMMAND_ID, () => this._restoreActiveNotebook())
        );
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    private async _restoreActiveNotebook(): Promise<void> {
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== NOTEBOOK_TYPE) {
            void vscode.window.showInformationMessage('Open a Web Notebook to restore it.');
            return;
        }

        // A plain (non-modal) confirmation: modal dialogs do not surface from
        // the web worker extension host in every workbench this runs in.
        const choice = await vscode.window.showWarningMessage(CONFIRM_MESSAGE, CONFIRM_BUTTON);
        if (choice !== CONFIRM_BUTTON) {
            return;
        }

        const edit = new vscode.WorkspaceEdit();
        const notebookEdits: vscode.NotebookEdit[] = [];
        const widgetRanges: vscode.NotebookRange[] = [];
        let restoredCells = 0;
        let clearedAnswers = 0;

        for (const cell of notebook.getCells()) {
            if (cell.kind !== vscode.NotebookCellKind.Code) {
                continue;
            }

            const metadata = (cell.metadata ?? {}) as Record<string, unknown>;
            const addons: Addon[] = Array.isArray(metadata.addons) ? metadata.addons as Addon[] : [];

            const withoutSelections = addons.filter(addon => normalizeAddonType(addon.type) !== 'selection');
            if (withoutSelections.length !== addons.length) {
                notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, {
                    ...metadata,
                    addons: withoutSelections
                }));
                clearedAnswers++;
            }

            if (isAutoWidgetLanguage(cell.document.languageId)) {
                // Re-render after the restore so the widget shows its clean state.
                widgetRanges.push(new vscode.NotebookRange(cell.index, cell.index + 1));
                continue;
            }

            const defaultContent = getAddonContent(addons, 'default');
            if (defaultContent !== undefined && defaultContent.trim().length > 0
                && cell.document.getText() !== defaultContent) {
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

        if (restoredCells === 0 && clearedAnswers === 0) {
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

        // Stale outputs would contradict the restored sources; drop them, then
        // re-render the widget cells (MCQs, checklists) fresh.
        try {
            await vscode.commands.executeCommand('notebook.clearAllCellsOutputs');
        } catch {
            // Clearing outputs is cosmetic; the restore itself already landed.
        }
        if (widgetRanges.length > 0) {
            await this.options.executeRanges(notebook, widgetRanges);
        }

        logExecution('Restored %s: %d cell(s) reset, %d answer(s) cleared',
            uriLabel(notebook.uri), restoredCells, clearedAnswers);
        void vscode.window.showInformationMessage(
            `Notebook restored: ${restoredCells} cell(s) reset, ${clearedAnswers} answer(s) cleared.`
        );
    }
}
