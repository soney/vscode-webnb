import * as vscode from 'vscode';
import type { Addon } from '../shared/protocol';
import { getAddonContent, isAutoWidgetLanguage, upsertAddon } from '../shared/addons';
import { errorExecution, logExecution } from './log';

const NOTEBOOK_TYPE = 'web-notebook';

interface ShadowEntry {
    /** The notebook the cell belongs to, to prune entries when it closes. */
    notebookUri: vscode.Uri;
    /** The cell's text as of open — what "Reset code" should restore. */
    text: string;
}

let current: DefaultCapture | undefined;

export function activate(context: vscode.ExtensionContext) {
    current = new DefaultCapture();
    context.subscriptions.push(current);
}

export function deactivate() {
    current = undefined;
}

/**
 * The text `cell` had before its first edit, when it is still awaiting one.
 *
 * The kernel asks this before recording a starter, so an empty `+default` is
 * filled with the same pre-edit text this module would capture rather than
 * with the cell's live (possibly already edited) source. One notion of
 * "starter", whichever writer gets there first.
 */
export function getCapturedStarter(cell: vscode.NotebookCell): string | undefined {
    return current?.starterFor(cell.document.uri.toString());
}

/**
 * Remembers a code cell's pre-edit text as its `+default` starter.
 *
 * Authors can ship an explicit `+default` addon, but most cells have none.
 * This watches the code cells that lack one (or carry an empty one) and, the
 * first time somebody edits such a cell, writes the text the cell had when the
 * notebook opened into its `default` addon. From then on the cell behaves as
 * if the author had shipped that starter: the renderer offers "Reset code",
 * and saving the notebook persists the captured block into the file.
 *
 * Widget cells (mcq / checklist / walkthrough) are skipped — their source is
 * not learner-editable prose, and markup cells are not code at all.
 */
export class DefaultCapture implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Open-time text per capture-eligible cell (keyed by cell document uri). */
    private readonly _shadow = new Map<string, ShadowEntry>();
    /** Cells whose capture write is in flight, so keystrokes don't stack edits. */
    private readonly _capturing = new Set<string>();

    public constructor() {
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => this._onDidChangeTextDocument(event)),
            vscode.workspace.onDidChangeNotebookDocument(event => this._onDidChangeNotebook(event)),
            vscode.workspace.onDidOpenNotebookDocument(notebook => this._trackNotebook(notebook)),
            vscode.workspace.onDidCloseNotebookDocument(notebook => this._untrackNotebook(notebook))
        );

        vscode.workspace.notebookDocuments.forEach(notebook => this._trackNotebook(notebook));
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
        if (current === this) {
            current = undefined;
        }
    }

    /** The pre-edit text shadowed for a cell, if it is still awaiting its first edit. */
    public starterFor(cellKey: string): string | undefined {
        return this._shadow.get(cellKey)?.text;
    }

    private _onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0) {
            return;
        }

        // The shadow holds exactly the cells still awaiting their first edit,
        // so a miss means this document is none of our business.
        const cellKey = event.document.uri.toString();
        const entry = this._shadow.get(cellKey);
        if (!entry || this._capturing.has(cellKey)) {
            return;
        }

        if (event.document.getText() === entry.text) {
            return;
        }

        this._capturing.add(cellKey);
        void this._capture(cellKey, entry).finally(() => this._capturing.delete(cellKey));
    }

    private async _capture(cellKey: string, entry: ShadowEntry): Promise<void> {
        const cell = this._findCell(entry.notebookUri, cellKey);
        if (!cell) {
            this._shadow.delete(cellKey);
            return;
        }

        const currentMetadata = (cell.metadata ?? {}) as Record<string, unknown>;
        const currentAddons: Addon[] = Array.isArray(currentMetadata.addons) ? currentMetadata.addons as Addon[] : [];
        // Someone else (a first run's empty-default capture) may have beaten us.
        if ((getAddonContent(currentAddons, 'default') ?? '').trim().length > 0) {
            this._shadow.delete(cellKey);
            return;
        }

        const metadata: Record<string, unknown> = {
            ...currentMetadata,
            addons: upsertAddon(currentAddons, 'default', entry.text)
        };

        try {
            const edit = new vscode.WorkspaceEdit();
            edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);
            if (await vscode.workspace.applyEdit(edit)) {
                // Captured for good; stop watching this cell.
                this._shadow.delete(cellKey);
                logExecution('Captured pre-edit default for cell %d of %s', cell.index, entry.notebookUri.toString());
            }
        } catch (error) {
            errorExecution('Could not capture default source for %s: %s', cellKey, String(error));
        }
    }

    private _findCell(notebookUri: vscode.Uri, cellKey: string): vscode.NotebookCell | undefined {
        const notebook = vscode.workspace.notebookDocuments
            .find(candidate => candidate.uri.toString() === notebookUri.toString());
        return notebook?.getCells().find(cell => cell.document.uri.toString() === cellKey);
    }

    private _onDidChangeNotebook(event: vscode.NotebookDocumentChangeEvent): void {
        if (event.notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }

        for (const change of event.contentChanges) {
            for (const cell of change.removedCells) {
                this._shadow.delete(cell.document.uri.toString());
            }
            for (const cell of change.addedCells) {
                this._trackCell(event.notebook.uri, cell);
            }
        }
    }

    private _trackNotebook(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }

        for (const cell of notebook.getCells()) {
            this._trackCell(notebook.uri, cell);
        }
    }

    private _trackCell(notebookUri: vscode.Uri, cell: vscode.NotebookCell): void {
        if (cell.kind !== vscode.NotebookCellKind.Code || isAutoWidgetLanguage(cell.document.languageId)) {
            return;
        }

        // Cells that already have a starter need no capture — skipping them here
        // keeps the keystroke path a cheap map miss for most of the notebook.
        const addons = cell.metadata?.addons;
        const existingDefault = Array.isArray(addons) ? getAddonContent(addons as Addon[], 'default') : undefined;
        if ((existingDefault ?? '').trim().length > 0) {
            return;
        }

        this._shadow.set(cell.document.uri.toString(), { notebookUri, text: cell.document.getText() });
    }

    private _untrackNotebook(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }

        const notebookKey = notebook.uri.toString();
        for (const [key, entry] of this._shadow) {
            if (entry.notebookUri.toString() === notebookKey) {
                this._shadow.delete(key);
            }
        }
    }
}
