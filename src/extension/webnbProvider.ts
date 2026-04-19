import * as vscode from 'vscode';

interface WebNbAddon {
    type: string;
    content: string;
    id?: string;
}

interface WorkspaceFileSnapshotEntry {
    path: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

const FILE_SNAPSHOT_ADDON_TYPES = new Set(['file', 'files', 'workspace-files']);
const EXTERNAL_CHECK_LANGUAGES = new Set(['external', 'checklist']);
const RENDERER_ID = 'practical-javascript-reading-notebook';
const MAX_FILE_SNAPSHOT_BYTES = 1024 * 1024;

function normalizeAddonType(type: string | undefined): string {
    return (type || '').trim().toLowerCase().replace(/^\+/, '');
}

function isExternalCheckLanguage(languageId: string): boolean {
    return EXTERNAL_CHECK_LANGUAGES.has(languageId.toLowerCase());
}

function parseRequestedPathLine(line: string): string | undefined {
    let path = line.trim();
    if (!path || path.startsWith('#')) {
        return undefined;
    }

    path = path.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim();
    const backtickMatch = path.match(/^`([^`]+)`$/);
    if (backtickMatch) {
        path = backtickMatch[1].trim();
    }

    return path || undefined;
}

function stripChecklistLinePrefix(line: string): string {
    return line.trim()
        .replace(/^[-*]\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .trim();
}

function splitChecklistFields(value: string): string[] {
    const fields: string[] = [];
    let current = '';
    let escaped = false;

    for (const char of value) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '|') {
            fields.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    fields.push(current.trim());
    return fields;
}

function normalizeChecklistCheckKind(kind: string): string {
    const normalized = kind.toLowerCase().replace(/[\s_-]+/g, '');
    if (normalized === 'dir') {
        return 'directory';
    }
    if (normalized === 'exists') {
        return 'path';
    }
    if (normalized === 'include' || normalized === 'includes') {
        return 'contains';
    }
    if (normalized === 'notinclude' || normalized === 'notincludes' || normalized === 'doesnotcontain') {
        return 'notcontains';
    }
    if (normalized === 'match' || normalized === 'regex') {
        return 'matches';
    }
    if (normalized === 'equal') {
        return 'equals';
    }
    if (normalized === 'entry' || normalized === 'containsentry') {
        return 'hasentry';
    }
    return normalized;
}

function getRequestedChecklistFilePaths(source: string): string[] {
    const paths: string[] = [];
    for (const rawLine of source.split(/\r?\n/g)) {
        const line = stripChecklistLinePrefix(rawLine);
        if (!line || line.startsWith('#')) {
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
            continue;
        }

        const kind = normalizeChecklistCheckKind(line.slice(0, colonIndex));
        const fields = splitChecklistFields(line.slice(colonIndex + 1));
        const path = fields[0];
        if (
            path &&
            ['directory', 'file', 'path', 'contains', 'notcontains', 'matches', 'equals', 'hasentry'].includes(kind)
        ) {
            paths.push(path);
        }
    }

    return paths;
}

function getRequestedFilePathsFromTestSource(source: string): string[] {
    const paths: string[] = [];
    const patterns = [
        /\bcheck\s*\.\s*(?:file|directory|path|exists)\s*\(\s*(['"`])([^'"`]+)\1/g,
        /\bfile\s*\(\s*(['"`])([^'"`]+)\1/g
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            if (match[2]) {
                paths.push(match[2]);
            }
        }
    }

    return paths;
}

function normalizeWorkspacePath(path: string): string | undefined {
    const normalizedSlashes = path.trim().replace(/\\/g, '/');
    if (!normalizedSlashes || normalizedSlashes.startsWith('/') || /^[A-Za-z]:\//.test(normalizedSlashes)) {
        return undefined;
    }

    const parts = normalizedSlashes
        .split('/')
        .filter(part => part && part !== '.');

    if (parts.length === 0 || parts.some(part => part === '..')) {
        return undefined;
    }

    return parts.join('/');
}

function fileTypeToString(type: vscode.FileType): WorkspaceFileSnapshotEntry['type'] {
    if (type & vscode.FileType.Directory) {
        return 'directory';
    }
    if (type & vscode.FileType.File) {
        return 'file';
    }
    if (type & vscode.FileType.SymbolicLink) {
        return 'symlink';
    }
    return 'unknown';
}

function entryTypeToString(type: vscode.FileType): string {
    return fileTypeToString(type) || 'unknown';
}

function getCellAddons(cell: vscode.NotebookCell): WebNbAddon[] {
    const addons = cell.metadata?.addons;
    return Array.isArray(addons) ? addons : [];
}

function getRequestedFilePaths(addons: WebNbAddon[], languageId: string, source: string): string[] {
    const paths: string[] = [];
    for (const addon of addons) {
        if (!FILE_SNAPSHOT_ADDON_TYPES.has(normalizeAddonType(addon.type))) {
            continue;
        }

        for (const line of addon.content.split(/\r?\n/g)) {
            const path = parseRequestedPathLine(line);
            if (path) {
                paths.push(path);
            }
        }
    }

    if (isExternalCheckLanguage(languageId)) {
        paths.push(...getRequestedChecklistFilePaths(source));
        for (const addon of addons) {
            if (isScriptAddonType(addon.type)) {
                paths.push(...getRequestedFilePathsFromTestSource(addon.content));
            }
        }
    }

    return Array.from(new Set(paths));
}

function isScriptAddonType(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'test' || normalizedType === 'javascript' || normalizedType === 'js';
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new WebNotebookKernel());
}

export function deactivate() { }

export class WebNotebookKernel implements vscode.Disposable, vscode.NotebookController {
    public readonly id = 'webnb-kernel';
    public readonly notebookType = 'web-notebook';
    public readonly label = 'Web Notebook';
    public readonly supportedLanguages = ['javascript', 'node', 'html', 'css', 'js', 'javascriptreact', 'react', 'jsx', 'mcq', 'external', 'checklist'];
    public readonly supportsExecutionOrder = false;


    private readonly _controller: vscode.NotebookController;
    private readonly _disposables: vscode.Disposable[] = [];

    private readonly _autorunExecutedNotebooks = new Set<string>();
    private readonly _autorunPendingNotebooks = new Set<string>();

    public constructor() {
        this._controller = vscode.notebooks.createNotebookController(this.id, this.notebookType, this.label);
        this._controller.supportedLanguages = ['javascript', 'node', 'html', 'css', 'js', 'javascriptreact', 'react', 'jsx', 'mcq', 'external', 'checklist'];
        this._controller.description = "Web Notebook";
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.executeHandler.bind(this);
        const rendererMessaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);
        const runAutorunCells = (editor: vscode.NotebookEditor) => {
            const { notebook } = editor;
            if (notebook.notebookType !== this.notebookType) {
                return;
            }

            const notebookKey = notebook.uri.toString();
            if (this._autorunExecutedNotebooks.has(notebookKey) || this._autorunPendingNotebooks.has(notebookKey)) {
                return;
            }

            const cellsToRun = this._getAutorunCellRanges(notebook);
            if (cellsToRun.length === 0) {
                return;
            }

            this._autorunPendingNotebooks.add(notebookKey);
            setTimeout(() => {
                void this._executeAutorunCells(editor, cellsToRun);
            }, 0);
        };
        const collapseWidgetCells = (editor: vscode.NotebookEditor) => {
            if (editor.notebook.notebookType !== this.notebookType) {
                return;
            }

            const widgetIndexes = editor.notebook.getCells()
                .map((cell, index) => this._isAutoWidgetCell(cell) ? index : -1)
                .filter(index => index >= 0);

            if (widgetIndexes.length === 0) {
                return;
            }

            setTimeout(() => {
                void this._collapseCellInputs(editor, widgetIndexes);
            }, 700);
        };

        this._disposables.push(
            rendererMessaging.onDidReceiveMessage(({ editor, message }) => {
                if (
                    editor.notebook.notebookType !== this.notebookType ||
                    !message ||
                    message.type !== 'webnb.refreshCell' ||
                    typeof message.cellUri !== 'string'
                ) {
                    return;
                }

                const cell = editor.notebook.getCells()
                    .find(candidate => candidate.document.uri.toString() === message.cellUri);
                if (!cell || !this._isAutoRefreshingCell(cell)) {
                    return;
                }

                void this._doExecuteCell(cell);
            }),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                const notebookKey = notebook.uri.toString();
                this._autorunExecutedNotebooks.delete(notebookKey);
                this._autorunPendingNotebooks.delete(notebookKey);
            }),
            vscode.window.onDidChangeActiveNotebookEditor(editor => {
                if (!editor) {
                    return;
                }

                collapseWidgetCells(editor);
                runAutorunCells(editor);
            }),
            vscode.window.onDidChangeVisibleNotebookEditors(editors => {
                for (const editor of editors) {
                    collapseWidgetCells(editor);
                }
            })
        );

        for (const editor of vscode.window.visibleNotebookEditors) {
            collapseWidgetCells(editor);
        }
        if (vscode.window.activeNotebookEditor) {
            runAutorunCells(vscode.window.activeNotebookEditor);
        }
    }
    createNotebookCellExecution(cell: vscode.NotebookCell): vscode.NotebookCellExecution {
        throw new Error('Method not implemented.');
    }
    public interruptHandler(notebook: vscode.NotebookDocument): void | Thenable<void> {
    }

    public onDidChangeSelectedNotebooks: vscode.Event<{ readonly notebook: vscode.NotebookDocument; readonly selected: boolean; }> = new vscode.EventEmitter<{ readonly notebook: vscode.NotebookDocument; readonly selected: boolean; }>().event;

    public updateNotebookAffinity(notebook: vscode.NotebookDocument, affinity: vscode.NotebookControllerAffinity): void {
        throw new Error('Method not implemented.');
    }

    public dispose(): void {
        this._controller.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    public executeHandler(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument, controller: vscode.NotebookController): void {
        for (const cell of cells) {
            void this._doExecuteCell(cell);
        }
    }

    private _getAutorunCellRanges(notebook: vscode.NotebookDocument): vscode.NotebookRange[] {
        return notebook.getCells()
            .map((cell, index) =>
                cell.kind === vscode.NotebookCellKind.Code &&
                    (cell.metadata?.autorun || this._isAutoWidgetCell(cell))
                    ? new vscode.NotebookRange(index, index + 1)
                    : undefined
            )
            .filter((range): range is vscode.NotebookRange => !!range);
    }

    private _isAutoWidgetCell(cell: vscode.NotebookCell): boolean {
        return cell.document.languageId === 'mcq' || this._isAutoRefreshingCell(cell);
    }

    private _isAutoRefreshingCell(cell: vscode.NotebookCell): boolean {
        return isExternalCheckLanguage(cell.document.languageId);
    }

    private async _executeAutorunCells(editor: vscode.NotebookEditor, ranges: vscode.NotebookRange[]): Promise<void> {
        const notebookKey = editor.notebook.uri.toString();
        try {
            if (vscode.window.activeNotebookEditor?.notebook.uri.toString() !== notebookKey) {
                return;
            }

            const originalSelection = editor.selection;
            const originalSelections = editor.selections;

            try {
                editor.selection = ranges[0];
                editor.selections = ranges;
                await vscode.commands.executeCommand('notebook.cell.execute');
                this._autorunExecutedNotebooks.add(notebookKey);
            } finally {
                editor.selection = originalSelection;
                editor.selections = originalSelections;
            }
        } finally {
            this._autorunPendingNotebooks.delete(notebookKey);
        }
    }

    private async _collapseCellInputs(editor: vscode.NotebookEditor, indexes: number[]): Promise<void> {
        const originalSelection = editor.selection;
        const originalSelections = editor.selections;

        try {
            for (const index of indexes) {
                editor.selection = new vscode.NotebookRange(index, index + 1);
                editor.selections = [editor.selection];
                await vscode.commands.executeCommand('notebook.cell.collapseCellInput');
            }
        } finally {
            editor.selection = originalSelection;
            editor.selections = originalSelections;
        }
    }

    private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
        const source = cell.document.getText();
        const { languageId } = cell.document;
        const addons = getCellAddons(cell);
        const files = await this._snapshotWorkspaceFiles(cell, addons, languageId, source);

        const exec = this._controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        let success: boolean = true;

        /*
        if(languageId === 'javascript') {
            try {
                // eslint-disable-next-line no-eval
                const result = await eval(source);
                // this._appendOutput(exec, languageId, source, result);
                exec.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.json(result, 'application/json')
                ]));
            } catch (error) {
                exec.replaceOutput(new vscode.NotebookCellOutput([
                    vscode.NotebookCellOutputItem.error(new Error(error+''))
                ]));
                success = false;
            }
        } else {
            const output = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json({
                    source,
                    language: languageId,
                    addons: cell.metadata.addons || [],
                }, 'x-application/webnb-output')
            ]);
            exec.replaceOutput(output);
        }
            */
        const output = new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json({
                source,
                language: languageId,
                addons,
                files,
                cellUri: cell.document.uri.toString(),
                checkedAt: Date.now(),
            }, 'x-application/webnb-output')
        ]);
        exec.replaceOutput(output);

        exec.end(success, Date.now());
    }

    private async _snapshotWorkspaceFiles(cell: vscode.NotebookCell, addons: WebNbAddon[], languageId: string, source: string): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
        const requestedPaths = getRequestedFilePaths(addons, languageId, source);
        if (requestedPaths.length === 0) {
            return {};
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(cell.notebook.uri) ?? vscode.workspace.workspaceFolders?.[0];
        const snapshots: Record<string, WorkspaceFileSnapshotEntry> = {};

        if (!workspaceFolder) {
            for (const requestedPath of requestedPaths) {
                snapshots[requestedPath] = {
                    path: requestedPath,
                    exists: false,
                    error: 'No workspace folder is open.'
                };
            }
            return snapshots;
        }

        for (const requestedPath of requestedPaths) {
            const normalizedPath = normalizeWorkspacePath(requestedPath);
            const snapshotKey = normalizedPath || requestedPath;

            if (!normalizedPath) {
                snapshots[snapshotKey] = {
                    path: requestedPath,
                    exists: false,
                    error: 'File checks must use relative workspace paths without ".." segments.'
                };
                continue;
            }

            const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalizedPath.split('/'));
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                const type = fileTypeToString(stat.type);
                const snapshot: WorkspaceFileSnapshotEntry = {
                    path: normalizedPath,
                    exists: true,
                    type,
                    size: stat.size
                };

                if (type === 'file') {
                    if (stat.size <= MAX_FILE_SNAPSHOT_BYTES) {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        snapshot.content = new TextDecoder('utf-8').decode(bytes);
                    } else {
                        snapshot.error = `File is larger than ${MAX_FILE_SNAPSHOT_BYTES} bytes, so its contents were not loaded.`;
                    }
                } else if (type === 'directory') {
                    const entries = await vscode.workspace.fs.readDirectory(uri);
                    snapshot.entries = entries.map(([name, entryType]) => ({
                        name,
                        type: entryTypeToString(entryType)
                    }));
                }

                snapshots[normalizedPath] = snapshot;
            } catch (error) {
                snapshots[normalizedPath] = {
                    path: normalizedPath,
                    exists: false
                };
            }
        }

        return snapshots;
    }

}
