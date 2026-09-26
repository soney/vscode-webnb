import * as vscode from 'vscode';
import { errorExecution, warnExecution } from './log';

const NOTEBOOK_TYPE = 'web-notebook';
const CONFIG_SECTION = 'webnb';
const LOCK_SETTING = 'lockMarkdown';
/** How long before the same notebook may explain the lock again. */
const NOTICE_THROTTLE_MS = 5000;
/** Trailing debounce, so a typing burst is undone once when it pauses, not fought per keystroke. */
const REVERT_DEBOUNCE_MS = 200;
/** Runaway guard: more than this many reverts inside the window means a feedback loop. */
const MAX_REVERTS_PER_WINDOW = 8;
const REVERT_BURST_WINDOW_MS = 2000;

const NOTICE_MESSAGE = 'This notebook\'s markdown cells are locked and cannot be edited. Code cells can still be edited and run.';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new MarkdownLock());
}

export function deactivate() { }

/** The revert debounce and runaway guard's limits; tests shorten them. */
export interface MarkdownLockTiming {
    debounceMs: number;
    maxRevertsPerWindow: number;
    burstWindowMs: number;
}

interface ShadowEntry {
    /** The notebook the cell belongs to, for the config lookup and to prune entries when it closes. */
    notebookUri: vscode.Uri;
    /** The last text this lock accepted for the cell. */
    text: string;
}

/**
 * Keeps the markdown (markup) cells of a Web Notebook from being edited while
 * `webnb.lockMarkdown` is on, leaving code cells editable and runnable.
 *
 * VS Code has no API to veto a cell text edit, so -- like `cellStructureLock` -- the lock is
 * reactive. A text change event does not carry the text it deleted, so each markup cell's
 * last accepted text is shadowed here, and an edit that arrives while the lock is on is
 * overwritten with that shadow. The revert trails the last keystroke by a debounce rather
 * than following every change event: a typing burst collapses into a single restore, which
 * both reads better and keeps ordinary typing from looking like the runaway feedback loop
 * the burst guard exists to catch. While the lock is off the shadow follows every edit, so
 * turning the setting on locks whatever the notebook says at that moment. A change whose
 * result already matches the shadow is the echo of our own revert and is left alone, which
 * is also what keeps the revert from feeding itself.
 */
export class MarkdownLock implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Last accepted text per markup cell document (keyed by cell document uri). */
    private readonly _shadow = new Map<string, ShadowEntry>();
    /** Debounce timers for reverts not yet applied (keyed by cell document uri). */
    private readonly _pendingReverts = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly _lastNoticeAt = new Map<string, number>();
    /** Recent reverts per markup cell (keyed by cell document uri), for the runaway guard. */
    private readonly _revertBursts = new Map<string, { count: number; since: number }>();
    private readonly _timing: MarkdownLockTiming;

    public constructor(timing: Partial<MarkdownLockTiming> = {}) {
        this._timing = { debounceMs: REVERT_DEBOUNCE_MS, maxRevertsPerWindow: MAX_REVERTS_PER_WINDOW, burstWindowMs: REVERT_BURST_WINDOW_MS, ...timing };
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
        this._pendingReverts.forEach(timer => clearTimeout(timer));
        this._pendingReverts.clear();
    }

    private _isLocked(notebookUri: vscode.Uri): boolean {
        return vscode.workspace
            .getConfiguration(CONFIG_SECTION, notebookUri)
            .get<boolean>(LOCK_SETTING, false);
    }

    private _onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0) {
            return;
        }

        // The shadow holds exactly the markup cells of open Web Notebooks, so a miss means
        // this document is none of our business.
        const cellKey = event.document.uri.toString();
        const entry = this._shadow.get(cellKey);
        if (!entry) {
            return;
        }

        const text = event.document.getText();
        if (text === entry.text) {
            return;
        }

        if (!this._isLocked(entry.notebookUri)) {
            // Author mode accepts the edit, so turning the lock on later starts from here.
            entry.text = text;
            return;
        }

        this._scheduleRevert(cellKey, event.document);
    }

    private _scheduleRevert(cellKey: string, document: vscode.TextDocument, delayMs: number = this._timing.debounceMs): void {
        const pending = this._pendingReverts.get(cellKey);
        if (pending !== undefined) {
            clearTimeout(pending);
        }
        this._pendingReverts.set(cellKey, setTimeout(() => {
            this._pendingReverts.delete(cellKey);
            void this._revert(cellKey, document);
        }, delayMs));
    }

    private async _revert(cellKey: string, document: vscode.TextDocument): Promise<void> {
        // Everything may have moved while the debounce ran; judge the document as it is now.
        const entry = this._shadow.get(cellKey);
        if (!entry) {
            return;
        }

        const text = document.getText();
        if (text === entry.text) {
            return;
        }

        const notebookKey = entry.notebookUri.toString();
        if (this._isRunawayLoop(cellKey)) {
            // Something keeps re-applying this edit. Pause rather than fight, and put the
            // locked text back once the burst window has passed: the lock never accepts
            // an edit because it arrived too often.
            this._scheduleRevert(cellKey, document, this._timing.burstWindowMs + 1);
            return;
        }

        try {
            const fullRange = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, entry.text);
            if (!await vscode.workspace.applyEdit(edit)) {
                warnExecution('Rejected edit while restoring locked markdown text for %s', notebookKey);
                return;
            }
            this._showNotice(notebookKey);
        } catch (error) {
            errorExecution('Failed to restore locked markdown text for %s: %s', notebookKey, String(error));
        }
    }

    /**
     * Pauses if one cell's reverts keep firing, so a lock that somehow fights another writer
     * cannot spin. Counted per cell: one Replace All across many locked cells is one revert
     * each, not a runaway. Going quiet ends the burst, which lets the window lapse.
     */
    private _isRunawayLoop(key: string): boolean {
        const now = Date.now();
        const burst = this._revertBursts.get(key);
        if (!burst || now - burst.since > this._timing.burstWindowMs) {
            this._revertBursts.set(key, { count: 1, since: now });
            return false;
        }

        burst.count++;
        if (burst.count > this._timing.maxRevertsPerWindow) {
            warnExecution('Too many markdown reverts for %s, pausing before restoring it', key);
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

    private _onDidChangeNotebook(event: vscode.NotebookDocumentChangeEvent): void {
        if (event.notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }

        // Keep the shadow aligned with the cells that actually exist. This also covers
        // `cellStructureLock` restoring a removed cell: the restored cell arrives here as an
        // added cell and is shadowed with its restored text.
        for (const change of event.contentChanges) {
            for (const cell of change.removedCells) {
                this._untrackCell(cell.document.uri.toString());
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
        if (cell.kind === vscode.NotebookCellKind.Markup) {
            this._shadow.set(cell.document.uri.toString(), { notebookUri, text: cell.document.getText() });
        }
    }

    private _untrackCell(cellKey: string): void {
        this._shadow.delete(cellKey);
        this._revertBursts.delete(cellKey);
        const pending = this._pendingReverts.get(cellKey);
        if (pending !== undefined) {
            clearTimeout(pending);
            this._pendingReverts.delete(cellKey);
        }
    }

    private _untrackNotebook(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }

        const notebookKey = notebook.uri.toString();
        for (const [key, entry] of this._shadow) {
            if (entry.notebookUri.toString() === notebookKey) {
                this._untrackCell(key);
            }
        }
        this._lastNoticeAt.delete(notebookKey);
    }
}
