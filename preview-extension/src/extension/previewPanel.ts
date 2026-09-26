/**
 * Live preview for a .webnb file opened as text.
 *
 * The text editor stays the source of truth. This panel re-parses the document
 * as you type with the notebook extension's own parser, hands the cells to a
 * webview that renders them through the notebook's own render(), and keeps its
 * scroll position lined up with the editor beside it. Nothing here ever writes
 * to the document.
 */
import * as vscode from 'vscode';
import type { Addon } from '@webnb/shared/protocol';
import { parseDocumentCells } from './parseDocument';
import { snapshotWorkspaceFiles } from './documentSnapshots';
import { followLink } from './links';
import { openWorkspaceFile, WorkspaceLineHighlighter } from './workspaceHighlight';
import type {
    PreviewCell,
    PreviewHostMessage,
    PreviewWebviewMessage
} from '../shared/previewProtocol';

export const PREVIEW_VIEW_TYPE = 'webnbPreview.preview';

/** Keystrokes coalesce into one re-parse at roughly this cadence. */
const UPDATE_DEBOUNCE_MS = 150;
/** How long to ignore editor scroll events after we scrolled the editor ourselves. */
const SCROLL_QUIET_MS = 250;
const WORKSPACE_DEBOUNCE_MS = 200;

const WEBNB_EXTENSION = '.webnb';

export function isWebnb(uri: vscode.Uri | undefined): boolean {
    return !!uri && uri.path.toLowerCase().endsWith(WEBNB_EXTENSION);
}

interface PreviewConfig {
    scrollSync: boolean;
    autoRunAll: boolean;
    /** The notebook extension's own setting, so both views agree. */
    reveal: boolean;
}

function readConfig(resource?: vscode.Uri): PreviewConfig {
    const preview = vscode.workspace.getConfiguration('webnbPreview', resource);
    const notebook = vscode.workspace.getConfiguration('webnb', resource);
    return {
        scrollSync: preview.get<boolean>('scrollSync', true),
        autoRunAll: preview.get<boolean>('autoRunAll', false),
        reveal: notebook.get<boolean>('allowRevealingSolutions', true)
    };
}

function followsActiveEditor(resource: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration('webnbPreview', resource).get<boolean>('followActiveEditor', true);
}

/** What a panel tells the manager that owns it. */
interface PanelHost {
    onDisposed(panel: PreviewPanel): void;
    /** The panel took focus, so it is the one that should follow the editor. */
    onActivated(panel: PreviewPanel): void;
}

/** One preview panel. The document it shows can change; see `bind`. */
class PreviewPanel implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly highlighter = new WorkspaceLineHighlighter();
    /** Every folder the page has been allowed to load assets from, so far. */
    private readonly resourceRootUris: vscode.Uri[];
    private updateTimer?: ReturnType<typeof setTimeout>;
    private suppressEditorSyncUntil = 0;
    private ready = false;
    private pendingText?: string;
    private assetVersion = 0;
    private config: PreviewConfig;
    /** Last text that parsed; a broken edit keeps the previous render up. */
    private lastGoodCells: PreviewCell[] = [];
    private parseError?: string;

    constructor(
        public readonly panel: vscode.WebviewPanel,
        private document: vscode.TextDocument,
        private readonly extensionUri: vscode.Uri,
        private readonly host: PanelHost
    ) {
        this.config = readConfig(document.uri);
        this.resourceRootUris = this.baseResourceRoots();
        this.addResourceRoot(this.notebookDirUri());

        panel.title = `Preview ${this.baseName()}`;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: this.resourceRootUris
        };
        panel.webview.html = this.buildHtml();

        this.disposables.push(
            panel.webview.onDidReceiveMessage((message: PreviewWebviewMessage) => {
                void this.onWebviewMessage(message);
            }),
            panel.onDidChangeViewState(() => {
                if (panel.active) {
                    this.host.onActivated(this);
                }
                if (panel.visible) {
                    this.syncFromEditor();
                }
            })
        );

        panel.onDidDispose(() => this.dispose());
    }

    public get documentKey(): string {
        return this.document.uri.toString();
    }

    private baseName(): string {
        return this.document.uri.path.split('/').pop() || 'notebook.webnb';
    }

    /** The folder holding the notebook: the base for its relative assets. */
    private notebookDirUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.document.uri, '..');
    }

    private baseResourceRoots(): vscode.Uri[] {
        const roots = [vscode.Uri.joinPath(this.extensionUri, 'out')];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            roots.push(folder.uri);
        }
        return roots;
    }

    /** Adds a folder to the roots if nothing already covers it. */
    private addResourceRoot(dir: vscode.Uri): boolean {
        const target = dir.toString().replace(/\/+$/, '');
        const covered = this.resourceRootUris.some(root => {
            const value = root.toString().replace(/\/+$/, '');
            return target === value || target.startsWith(`${value}/`);
        });
        if (covered) {
            return false;
        }
        this.resourceRootUris.push(dir);
        return true;
    }

    /**
     * Point the panel at another notebook, as the author moves between them.
     *
     * Everything queued belongs to the document being left, so it is dropped
     * rather than rendered into the new one. The page is told through a fresh
     * `init`, which it treats as a new document and rebuilds from.
     */
    public bind(document: vscode.TextDocument): void {
        if (document.uri.toString() === this.documentKey) {
            this.document = document; // same file, newer snapshot
            return;
        }

        this.cancelPendingUpdate();
        this.highlighter.clear();
        this.lastGoodCells = [];
        this.parseError = undefined;
        this.suppressEditorSyncUntil = 0;

        this.document = document;
        this.config = readConfig(document.uri);
        this.panel.title = `Preview ${this.baseName()}`;

        if (this.addResourceRoot(this.notebookDirUri())) {
            // A folder the page was never allowed to load from. Content options
            // only take hold on a reload, and that reload's `ready` sends the
            // init back around.
            this.ready = false;
            this.panel.webview.options = {
                enableScripts: true,
                localResourceRoots: this.resourceRootUris
            };
            this.panel.webview.html = this.buildHtml();
            return;
        }

        if (this.ready) {
            this.sendInit();
        }
    }

    private buildHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
        // Notebook cells run author-written JavaScript through eval()/new Function(),
        // exactly as they do in the notebook renderer, so 'unsafe-eval' is required.
        // Inline styles cover author <style> blocks and style attributes.
        //
        // 'unsafe-inline' lets inline event handlers run (`<button onclick=...>`,
        // `<input oninput=...>`): the notebook renderer supports them and course
        // notebooks rely on them (C1/M2 08's color sliders, C1/M3 03's inline-JS
        // lesson, C3/M4 10's WCAG demo), and a preview that silently drops them
        // is not showing what a reader sees. It cannot coexist with a script
        // nonce (a nonce switches 'unsafe-inline' off), so the bundle is
        // allowed by source instead. The cost is defense in depth against
        // markup injected from outside the author's content; it adds nothing a
        // cell cannot already do, since every cell's code is evaluated anyway.
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https: data: blob:`,
            `media-src ${webview.cspSource} https: data: blob:`,
            `font-src ${webview.cspSource} https: data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
            `connect-src ${webview.cspSource} https: data:`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview ${this.baseName()}</title>
</head>
<body>
    <div id="app"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    private post(message: PreviewHostMessage): void {
        void this.panel.webview.postMessage(message);
    }

    // ---- document -> preview -----------------------------------------------

    /**
     * Parse the document. A notebook mid-edit is often briefly malformed (an
     * addon block whose code block is not typed yet): the parser renders such
     * a block as text and warns, and the warnings go in the banner above the
     * cells. Should the parser ever throw, the last good render stays up.
     */
    private cellsFor(text: string): PreviewCell[] {
        const warnings: string[] = [];
        try {
            this.lastGoodCells = parseDocumentCells(text, message => warnings.push(message));
            this.parseError = warnings.length > 0 ? warnings.join('\n') : undefined;
        } catch (error) {
            this.parseError = error instanceof Error ? error.message : String(error);
        }
        return this.lastGoodCells;
    }

    /** Send the whole document; the webview reconciles only the cells that changed. */
    public sendInit(): void {
        this.config = readConfig(this.document.uri);
        const cells = this.cellsFor(this.document.getText());
        this.post({
            type: 'init',
            cells,
            title: vscode.workspace.asRelativePath(this.document.uri, false),
            assetBase: this.panel.webview.asWebviewUri(this.notebookDirUri()).toString(),
            documentKey: this.documentKey,
            scrollSync: this.config.scrollSync,
            autoRunAll: this.config.autoRunAll,
            reveal: this.config.reveal
        });
        this.post({ type: 'parseError', message: this.parseError });
        this.syncFromEditor();
    }

    private cancelPendingUpdate(): void {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = undefined;
        }
        this.pendingText = undefined;
    }

    public scheduleUpdate(document: vscode.TextDocument): void {
        this.document = document;
        this.pendingText = document.getText();
        if (this.updateTimer) {
            return;
        }
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            const text = this.pendingText;
            this.pendingText = undefined;
            if (text === undefined || !this.ready) {
                return;
            }
            this.post({ type: 'update', cells: this.cellsFor(text) });
            this.post({ type: 'parseError', message: this.parseError });
        }, UPDATE_DEBOUNCE_MS);
    }

    public sendConfig(): void {
        this.config = readConfig(this.document.uri);
        this.post({
            type: 'config',
            scrollSync: this.config.scrollSync,
            autoRunAll: this.config.autoRunAll,
            reveal: this.config.reveal
        });
    }

    public runAll(): void {
        this.post({ type: 'runAll' });
    }

    public notifyWorkspaceChanged(): void {
        this.assetVersion++;
        this.post({ type: 'workspaceChanged', assetVersion: this.assetVersion });
    }

    /** The visible editor showing this document, if any. */
    private editor(): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors
            .find(candidate => candidate.document.uri.toString() === this.documentKey);
    }

    public syncFromEditor(): void {
        if (!this.config.scrollSync) {
            return;
        }
        const range = this.editor()?.visibleRanges[0];
        if (range) {
            this.post({ type: 'scrollToLine', line: range.start.line });
        }
    }

    public onEditorVisibleRangesChanged(editor: vscode.TextEditor): void {
        if (Date.now() < this.suppressEditorSyncUntil) {
            return; // this scroll is the echo of one we just caused
        }
        const range = editor.visibleRanges[0];
        if (range && this.config.scrollSync) {
            this.post({ type: 'scrollToLine', line: range.start.line });
        }
    }

    public onEditorSelectionChanged(editor: vscode.TextEditor): void {
        this.post({ type: 'activeLine', line: editor.selection.active.line });
    }

    // ---- preview -> document -----------------------------------------------

    private async onWebviewMessage(message: PreviewWebviewMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.ready = true;
                this.sendInit();
                return;

            case 'snapshotRequest': {
                // Addons go back as they came: running never creates or fills a
                // `+default` (the notebook captures one on a cell's first edit,
                // and this preview never edits cells).
                const addons = message.addons as Addon[];
                const files = await snapshotWorkspaceFiles(
                    this.document.uri,
                    addons,
                    message.language,
                    message.source
                );
                this.post({
                    type: 'snapshotResult',
                    requestId: message.requestId,
                    addons,
                    files
                });
                return;
            }

            case 'revealLine': {
                const editor = this.editor();
                if (!editor || !this.config.scrollSync) {
                    return;
                }
                const line = this.clampLine(editor.document, message.line);
                this.suppressEditorSyncUntil = Date.now() + SCROLL_QUIET_MS;
                editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
                return;
            }

            case 'jumpToLine': {
                const line = this.clampLine(this.document, message.line);
                const selection = new vscode.Range(line, 0, line, 0);
                this.suppressEditorSyncUntil = Date.now() + SCROLL_QUIET_MS;
                await vscode.window.showTextDocument(this.document, {
                    viewColumn: this.editor()?.viewColumn ?? vscode.ViewColumn.One,
                    preserveFocus: false,
                    preview: false,
                    selection
                });
                return;
            }

            case 'openLink':
                await followLink(message.href, {
                    document: this.document,
                    viewColumn: this.editor()?.viewColumn,
                    showLine: line => this.showLine(line)
                });
                return;

            case 'openWorkspaceFile':
                await openWorkspaceFile(this.document.uri, message.path, message.line);
                return;

            case 'highlightWorkspaceLines':
                this.highlighter.highlight(this.document.uri, message.path, message.ranges, message.line);
                return;
        }
    }

    /**
     * A `#section` link into this notebook: the preview scrolls there, and so
     * does the source editor when scroll sync pairs them.
     */
    private showLine(line: number): void {
        this.post({ type: 'showLine', line });
        const editor = this.editor();
        if (editor && this.config.scrollSync) {
            const target = this.clampLine(editor.document, line);
            this.suppressEditorSyncUntil = Date.now() + SCROLL_QUIET_MS;
            editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.AtTop);
        }
    }

    private clampLine(document: vscode.TextDocument, line: number): number {
        const rounded = Math.round(Number.isFinite(line) ? line : 0);
        return Math.min(Math.max(0, rounded), Math.max(0, document.lineCount - 1));
    }

    public dispose(): void {
        this.cancelPendingUpdate();
        this.highlighter.clear();
        this.highlighter.dispose();
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
        this.host.onDisposed(this);
    }
}

export class WebnbPreviewManager implements vscode.Disposable {
    /** Most recently used first: the front of this list follows the editor. */
    private readonly panels: PreviewPanel[] = [];
    private readonly disposables: vscode.Disposable[] = [];
    private workspaceWatcher?: vscode.FileSystemWatcher;
    private workspaceTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const panel = this.panelFor(event.document.uri);
                if (panel && event.contentChanges.length > 0) {
                    panel.scheduleUpdate(event.document);
                }
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges(event => {
                this.panelFor(event.textEditor.document.uri)
                    ?.onEditorVisibleRangesChanged(event.textEditor);
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                this.panelFor(event.textEditor.document.uri)
                    ?.onEditorSelectionChanged(event.textEditor);
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                this.followActiveEditor(editor);
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('webnbPreview') || event.affectsConfiguration('webnb.allowRevealingSolutions')) {
                    for (const panel of this.panels) {
                        panel.sendConfig();
                    }
                }
            }),
            vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, {
                deserializeWebviewPanel: async (panel, state) => {
                    const uri = (state as { uri?: string } | undefined)?.uri;
                    if (!uri) {
                        panel.dispose();
                        return;
                    }
                    try {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
                        this.adopt(panel, document);
                    } catch {
                        panel.dispose();
                    }
                }
            })
        );
    }

    private panelFor(uri: vscode.Uri): PreviewPanel | undefined {
        const key = uri.toString();
        return this.panels.find(panel => panel.documentKey === key);
    }

    /** Move a panel to the front of the most-recently-used list. */
    private touch(panel: PreviewPanel): void {
        const index = this.panels.indexOf(panel);
        if (index > 0) {
            this.panels.splice(index, 1);
            this.panels.unshift(panel);
        }
    }

    /**
     * Follow the author from one notebook to the next.
     *
     * Opening a second .webnb beside an open preview should re-point that
     * preview, not leave it showing the file it happened to be opened for. A
     * notebook that already has its own preview keeps it: two previews open
     * side by side are two deliberate views, not one stale one.
     */
    private followActiveEditor(editor: vscode.TextEditor | undefined): void {
        const document = editor?.document;
        if (!document || !isWebnb(document.uri)) {
            return; // another file, or focus moved into the preview itself
        }

        const shown = this.panelFor(document.uri);
        if (shown) {
            this.touch(shown);
            shown.syncFromEditor();
            return;
        }

        if (!followsActiveEditor(document.uri)) {
            return;
        }
        // Prefer a preview the author can see over one buried behind a tab.
        const follower = this.panels.find(panel => panel.panel.visible) ?? this.panels[0];
        if (follower) {
            follower.bind(document);
            this.touch(follower);
        }
    }

    /** Open (or focus) the preview for a document. */
    public show(document: vscode.TextDocument, viewColumn: vscode.ViewColumn): void {
        const existing = this.panelFor(document.uri);
        if (existing) {
            this.touch(existing);
            existing.panel.reveal(existing.panel.viewColumn ?? viewColumn, true);
            existing.syncFromEditor();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            PREVIEW_VIEW_TYPE,
            `Preview ${document.uri.path.split('/').pop() ?? ''}`,
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                // Cell outputs are live: keep terminals, answers and DOM state
                // across tab switches instead of re-running everything.
                retainContextWhenHidden: true
            }
        );
        this.adopt(panel, document);
    }

    /** Re-run every cell in the preview for a document, if one is open. */
    public runAll(document: vscode.TextDocument | undefined): void {
        if (document) {
            this.panelFor(document.uri)?.runAll();
            return;
        }
        for (const panel of this.panels) {
            panel.runAll();
        }
    }

    private adopt(panel: vscode.WebviewPanel, document: vscode.TextDocument): void {
        const preview = new PreviewPanel(panel, document, this.extensionUri, {
            onDisposed: disposed => {
                const index = this.panels.indexOf(disposed);
                if (index >= 0) {
                    this.panels.splice(index, 1);
                }
                this.stopWatchingWorkspaceIfIdle();
            },
            onActivated: activated => this.touch(activated)
        });
        this.panels.unshift(preview);
        this.startWatchingWorkspace();
    }

    // ---- workspace changes -------------------------------------------------

    /**
     * File checks and markup images read the real workspace, so a preview needs
     * to know when it changes. The watcher only runs while a preview is open.
     */
    private startWatchingWorkspace(): void {
        if (this.workspaceWatcher || this.panels.length === 0) {
            return;
        }
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        const onChange = () => this.scheduleWorkspaceNotification();
        watcher.onDidChange(onChange);
        watcher.onDidCreate(onChange);
        watcher.onDidDelete(onChange);
        this.workspaceWatcher = watcher;
    }

    private stopWatchingWorkspaceIfIdle(): void {
        if (this.panels.length > 0) {
            return;
        }
        this.workspaceWatcher?.dispose();
        this.workspaceWatcher = undefined;
        if (this.workspaceTimer) {
            clearTimeout(this.workspaceTimer);
            this.workspaceTimer = undefined;
        }
    }

    private scheduleWorkspaceNotification(): void {
        if (this.workspaceTimer) {
            return;
        }
        this.workspaceTimer = setTimeout(() => {
            this.workspaceTimer = undefined;
            for (const panel of this.panels) {
                panel.notifyWorkspaceChanged();
            }
        }, WORKSPACE_DEBOUNCE_MS);
    }

    public dispose(): void {
        for (const panel of Array.from(this.panels)) {
            panel.panel.dispose();
        }
        this.panels.length = 0;
        this.stopWatchingWorkspaceIfIdle();
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}
