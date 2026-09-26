/**
 * Reopens a `.webnb` shown in a plain text editor as a Web Notebook.
 *
 * The notebook editor is the default for `.webnb`, but a file opened
 * programmatically as text stays text -- which is how the course lab opens its
 * first notebook (its launcher's `openFile` command). So for a short while
 * after activation, each `.webnb` that appears in a text editor tab is opened
 * with the notebook editor and that one text tab is closed.
 *
 * Deliberately narrow, because it closes an editor the reader did not ask to
 * close:
 * - only text editor tabs (never a notebook, a diff, or another editor);
 * - only files in the workspace (or on disk), not `git:` revisions and the like;
 * - each file at most once, and only during the window after activation, so a
 *   reader who reopens a notebook as text on purpose keeps the text editor;
 * - never a text editor with unsaved changes (closing it would prompt).
 */
import * as vscode from 'vscode';
import { logExecution, uriLabel, warnExecution } from './log';

const WEB_NOTEBOOK_VIEW_TYPE = 'web-notebook';
const WEBNB_EXTENSION = '.webnb';
/** How long after activation a `.webnb` opened as text is still taken to be the launcher's. */
const WATCH_WINDOW_MS = 20000;

function isReopenableUri(uri: vscode.Uri): boolean {
    return uri.path.toLowerCase().endsWith(WEBNB_EXTENSION)
        && (uri.scheme === 'file' || !!vscode.workspace.getWorkspaceFolder(uri));
}

export class WebnbTextReopener implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Files already reopened (or tried), so none is taken over twice. */
    private readonly _handled = new Set<string>();
    private readonly _timer: ReturnType<typeof setTimeout>;
    private _stopped = false;

    public constructor(watchWindowMs: number = WATCH_WINDOW_MS) {
        this._disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => this._check()),
            vscode.window.tabGroups.onDidChangeTabs(() => this._check())
        );
        this._timer = setTimeout(() => this.dispose(), watchWindowMs);
        this._check();
    }

    public dispose(): void {
        this._stopped = true;
        clearTimeout(this._timer);
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    private _check(): void {
        if (this._stopped) {
            return;
        }

        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (!(tab.input instanceof vscode.TabInputText) || !isReopenableUri(tab.input.uri)) {
                    continue;
                }
                const uri = tab.input.uri;
                if (this._handled.has(uri.toString())) {
                    continue;
                }
                if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.toString() === uri.toString())) {
                    continue;
                }
                this._handled.add(uri.toString());
                void this._reopen(tab, uri);
            }
        }
    }

    private async _reopen(tab: vscode.Tab, uri: vscode.Uri): Promise<void> {
        logExecution('Reopening %s, shown as text, as a notebook', uriLabel(uri));
        const hadFocus = tab.isActive && tab.group.isActive;
        try {
            // Open first, then close: closing the only tab of a group first can
            // close the group, and the notebook would land somewhere else.
            await vscode.commands.executeCommand('vscode.openWith', uri, WEB_NOTEBOOK_VIEW_TYPE, {
                viewColumn: tab.group.viewColumn,
                preserveFocus: !hadFocus,
                preview: false
            });
            // If the notebook did not open (the web workbench's trust prompt was
            // declined, say), the text editor is all the reader has: keep it.
            const opened = vscode.window.tabGroups.all.some(group => group.tabs.some(candidate =>
                candidate.input instanceof vscode.TabInputNotebook && candidate.input.uri.toString() === uri.toString()));
            if (!opened) {
                warnExecution('%s did not open as a notebook; leaving it open as text', uriLabel(uri));
                return;
            }
            await vscode.window.tabGroups.close(tab, !hadFocus);
        } catch (error) {
            warnExecution('Could not reopen %s as a notebook: %s', uriLabel(uri), String(error));
        }
    }
}
