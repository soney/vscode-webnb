/**
 * Collapses the source of cells whose code is not the point: the widget
 * languages (mcq / external / checklist / walkthrough), whose source is the
 * widget's definition, and cells flagged `hidecode`.
 *
 * VS Code keeps a cell's collapse state in the editor's view state and ignores
 * `inputCollapsed` in cell metadata, so the collapse command is the only way
 * in. It is always given its targets explicitly -- the notebook and the cell
 * ranges -- because without them it collapses whatever the active editor has
 * selected, which may be another notebook's cells.
 *
 * Each cell is collapsed once per notebook session. A reader who expands one
 * keeps it expanded: showing the notebook again (switching tabs, splitting the
 * editor) does not fold it back up.
 */
import * as vscode from 'vscode';
import { isAutoWidgetLanguage } from '../shared/addons';
import { logExecution, uriLabel, warnExecution } from './log';
import { getNotebookKey, isRemoteNotebookAlias } from './notebookUris';

const NOTEBOOK_TYPE = 'web-notebook';
const COLLAPSE_INPUT_COMMAND = 'notebook.cell.collapseCellInput';
/**
 * Collapsing lands only once the notebook editor has laid out its cells. An
 * editor with visible ranges has; this short delay covers the rest of that
 * first render.
 */
const COLLAPSE_DELAY_MS = 300;

/** Cells that open with their source collapsed. */
export function collapsesInput(cell: vscode.NotebookCell): boolean {
    return cell.kind === vscode.NotebookCellKind.Code
        && (cell.metadata?.hidecode === true || isAutoWidgetLanguage(cell.document.languageId));
}

export class InputCollapser implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Per notebook (getNotebookKey): the cells already collapsed this session, by cell document uri. */
    private readonly _collapsed = new Map<string, Set<string>>();
    private _disposed = false;

    public constructor(private readonly _delayMs: number = COLLAPSE_DELAY_MS) {
        this._disposables.push(
            vscode.workspace.onDidCloseNotebookDocument(notebook => this._collapsed.delete(getNotebookKey(notebook.uri))),
            // An editor reports visible ranges once its cells are laid out, which
            // can be well after it is reported visible (the web workbench asks
            // whether to trust a notebook before rendering it).
            vscode.window.onDidChangeNotebookEditorVisibleRanges(event => this.collapseForEditor(event.notebookEditor))
        );
    }

    public dispose(): void {
        this._disposed = true;
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
        this._collapsed.clear();
    }

    /** Collapses, once, every cell of the editor's notebook that should open collapsed. */
    public collapseForEditor(editor: vscode.NotebookEditor): void {
        const { notebook } = editor;
        if (notebook.notebookType !== NOTEBOOK_TYPE || isRemoteNotebookAlias(notebook.uri)) {
            return;
        }
        if (editor.visibleRanges.length === 0) {
            // Not laid out yet; the visible-ranges event brings us back.
            return;
        }

        const key = getNotebookKey(notebook.uri);
        let done = this._collapsed.get(key);
        if (!done) {
            done = new Set<string>();
            this._collapsed.set(key, done);
        }

        const cells = notebook.getCells().filter(cell => collapsesInput(cell) && !done.has(cell.document.uri.toString()));
        if (cells.length === 0) {
            return;
        }

        // Claimed now: opening a notebook fires several editor events in a
        // row, and each must not queue the same cells again.
        for (const cell of cells) {
            done.add(cell.document.uri.toString());
        }
        setTimeout(() => void this._collapse(notebook, cells, done), this._delayMs);
    }

    private async _collapse(notebook: vscode.NotebookDocument, cells: vscode.NotebookCell[], done: Set<string>): Promise<void> {
        const release = () => cells.forEach(cell => done.delete(cell.document.uri.toString()));
        if (this._disposed) {
            return;
        }

        // Given a document with no editor, the command falls back to the active
        // notebook editor, so only issue it while this notebook is on screen.
        // Cells not collapsed now are tried again the next time it is shown.
        if (!vscode.window.visibleNotebookEditors.some(editor => editor.notebook === notebook)) {
            release();
            return;
        }

        const ranges = cells
            .filter(cell => cell.index >= 0)
            .map(cell => ({ start: cell.index, end: cell.index + 1 }));
        if (ranges.length === 0) {
            return;
        }

        try {
            await vscode.commands.executeCommand(COLLAPSE_INPUT_COMMAND, { ranges, document: notebook.uri });
            logExecution('collapsed %d cell input(s) in %s', ranges.length, uriLabel(notebook.uri));
        } catch (error) {
            release();
            warnExecution('Could not collapse cell inputs in %s: %s', uriLabel(notebook.uri), String(error));
        }
    }
}
