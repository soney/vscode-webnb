import * as vscode from 'vscode';

interface WebNbAddon {
    type: string;
    content: string;
    id?: string;
}

interface WebNbRefreshCellMessage {
    type: 'webnb.refreshCell';
    cellUri: string;
}

interface WebNbUpsertCellAddonMessage {
    type: 'webnb.upsertCellAddon';
    cellUri: string;
    addonType: string;
    content: string;
}

type WebNbRendererMessage = WebNbRefreshCellMessage | WebNbUpsertCellAddonMessage;

interface WorkspaceFileSnapshotEntry {
    path: string;
    exists: boolean;
    type?: 'file' | 'directory' | 'symlink' | 'unknown';
    content?: string;
    entries?: { name: string; type: string }[];
    size?: number;
    error?: string;
}

type RequestedPathBase = 'notebook' | 'workspace';

interface RequestedPathReference {
    requestPath: string;
    path: string;
    base: RequestedPathBase;
}

const SUPPORTED_LANGUAGES = ['javascript', 'node', 'html', 'css', 'js', 'javascriptreact', 'react', 'jsx', 'mcq', 'external', 'checklist'];
const FILE_SNAPSHOT_ADDON_TYPES = new Set(['file', 'files', 'workspace-files']);
const EXTERNAL_CHECK_LANGUAGES = new Set(['external', 'checklist']);
const RENDERER_ID = 'practical-javascript-reading-notebook';
const MAX_FILE_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_AUTORUN_DISCOVERY_RETRIES = 10;
const AUTORUN_RETRY_DELAY_MS = 150;
const AUTORUN_SWEEP_ATTEMPTS = 12;
const AUTORUN_SWEEP_DELAY_MS = 250;
const FILE_SCHEME = 'file';
const VSCODE_REMOTE_SCHEME = 'vscode-remote';
const WEBNB_EXTENSION = '.webnb';
// VS Code's public API can mark this controller as preferred, but web notebooks
// still need the internal command to select it before programmatic autorun.
const SELECT_KERNEL_COMMAND = '_notebook.selectKernel';

function isRemoteNotebookAlias(uri: vscode.Uri): boolean {
    return uri.scheme === VSCODE_REMOTE_SCHEME
        && uri.path.toLowerCase().endsWith(WEBNB_EXTENSION);
}

function getExecutionNotebookUri(uri: vscode.Uri): vscode.Uri {
    if (isRemoteNotebookAlias(uri)) {
        return uri.with({ scheme: FILE_SCHEME, authority: '' });
    }

    return uri;
}

function getNotebookKey(uri: vscode.Uri): string {
    const executionUri = getExecutionNotebookUri(uri);
    return [
        executionUri.scheme,
        executionUri.authority,
        executionUri.path.replace(/\/+$/, '') || '/',
        executionUri.query,
        executionUri.fragment
    ].join('\n');
}

function notebookUrisMatch(a: vscode.Uri, b: vscode.Uri): boolean {
    const normalizedA = getExecutionNotebookUri(a);
    const normalizedB = getExecutionNotebookUri(b);
    if (normalizedA.toString() === normalizedB.toString()) {
        return true;
    }

    return normalizedA.scheme === normalizedB.scheme
        && normalizedA.path === normalizedB.path
        && normalizedA.query === normalizedB.query
        && normalizedA.fragment === normalizedB.fragment
        && (!normalizedA.authority || !normalizedB.authority || normalizedA.authority === normalizedB.authority);
}

function logExecution(message: string, ...args: unknown[]): void {
    console.log(`[webnb] ${message}`, ...args);
}

function warnExecution(message: string, ...args: unknown[]): void {
    console.warn(`[webnb] ${message}`, ...args);
}

function uriLabel(uri: vscode.Uri | undefined): string {
    return uri?.toString() ?? '<none>';
}

function cellLabel(cell: vscode.NotebookCell): string {
    return `index=${cell.index} kind=${cell.kind} language=${cell.document.languageId} notebook=${uriLabel(cell.notebook.uri)} document=${uriLabel(cell.document.uri)} version=${cell.document.version}`;
}

function rangesLabel(ranges: vscode.NotebookRange[]): string {
    return ranges.map(range => `${range.start}:${range.end}`).join(',') || '<none>';
}

function visibleNotebookLabels(): string {
    return vscode.window.visibleNotebookEditors
        .map(editor => uriLabel(editor.notebook.uri))
        .join(' | ') || '<none>';
}

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

function parseRequestedPathReference(requestPath: string): RequestedPathReference {
    const trimmed = requestPath.trim().replace(/\\/g, '/');
    const workspaceScopedMatch = trimmed.match(/^workspace\s*:\s*(.*)$/i);
    if (workspaceScopedMatch) {
        const scopedPath = workspaceScopedMatch[1].trim();
        return {
            requestPath: `workspace:${scopedPath}`,
            path: scopedPath,
            base: 'workspace'
        };
    }

    return {
        requestPath: trimmed,
        path: trimmed,
        base: 'notebook'
    };
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

    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === '\\') {
            const nextChar = value[index + 1];
            if (nextChar === '|' || nextChar === '\\') {
                current += nextChar;
                index++;
            } else {
                current += char;
            }
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

function getRequestedChecklistFilePaths(source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
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
            paths.push(parseRequestedPathReference(path));
        }
    }

    return paths;
}

function getRequestedFilePathsFromTestSource(source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    const patterns = [
        /\bcheck\s*\.\s*(?:file|directory|path|exists)\s*\(\s*(['"`])([^'"`]+)\1/g,
        /\bfile\s*\(\s*(['"`])([^'"`]+)\1/g
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            if (match[2]) {
                paths.push(parseRequestedPathReference(match[2]));
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

function getRequestedFilePaths(addons: WebNbAddon[], languageId: string, source: string): RequestedPathReference[] {
    const paths: RequestedPathReference[] = [];
    for (const addon of addons) {
        if (!FILE_SNAPSHOT_ADDON_TYPES.has(normalizeAddonType(addon.type))) {
            continue;
        }

        for (const line of addon.content.split(/\r?\n/g)) {
            const path = parseRequestedPathLine(line);
            if (path) {
                paths.push(parseRequestedPathReference(path));
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

    const uniquePaths = new Map<string, RequestedPathReference>();
    for (const pathRef of paths) {
        uniquePaths.set(pathRef.requestPath, pathRef);
    }
    return Array.from(uniquePaths.values());
}

function getNotebookRelativeDir(cell: vscode.NotebookCell, workspaceFolder: vscode.WorkspaceFolder): string {
    const notebookPath = vscode.workspace.asRelativePath(cell.notebook.uri, false).replace(/\\/g, '/');
    const slashIndex = notebookPath.lastIndexOf('/');
    if (slashIndex < 0) {
        return '';
    }

    return notebookPath.slice(0, slashIndex);
}

function isScriptAddonType(type: string | undefined): boolean {
    const normalizedType = normalizeAddonType(type);
    return normalizedType === 'test' || normalizedType === 'javascript' || normalizedType === 'js';
}

function upsertAddon(addons: WebNbAddon[], type: string, content: string): WebNbAddon[] {
    const normalizedType = normalizeAddonType(type);
    const existingIndex = addons.findIndex(addon => normalizeAddonType(addon.type) === normalizedType);
    if (existingIndex >= 0) {
        const updated = addons.slice();
        updated[existingIndex] = {
            ...updated[existingIndex],
            type,
            content
        };
        return updated;
    }

    return [...addons, { type, content }];
}

function getDefaultCaptureAddons(addons: WebNbAddon[], source: string): { addons: WebNbAddon[]; changed: boolean } {
    const defaultIndex = addons.findIndex(addon => normalizeAddonType(addon.type) === 'default');
    if (defaultIndex < 0) {
        return { addons, changed: false };
    }

    const existing = addons[defaultIndex];
    if (existing.content.trim().length > 0) {
        return { addons, changed: false };
    }

    const updated = addons.slice();
    updated[defaultIndex] = {
        ...existing,
        content: source
    };

    return { addons: updated, changed: true };
}

function isRendererMessage(message: unknown): message is WebNbRendererMessage {
    if (!message || typeof message !== 'object') {
        return false;
    }

    const candidate = message as Partial<WebNbRendererMessage>;
    if (candidate.type === 'webnb.refreshCell') {
        return typeof candidate.cellUri === 'string';
    }

    if (candidate.type === 'webnb.upsertCellAddon') {
        return typeof candidate.cellUri === 'string' && typeof candidate.addonType === 'string' && typeof candidate.content === 'string';
    }

    return false;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new WebNotebookKernel(context.extension.id));
}

export function deactivate() { }

export class WebNotebookKernel implements vscode.Disposable {
    public readonly id = 'webnb-kernel';
    public readonly notebookType = 'web-notebook';
    public readonly label = 'Web Notebook';


    private readonly _controller: vscode.NotebookController;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _extensionId: string;

    private readonly _autorunExecutedNotebookSignatures = new Map<string, string>();
    private readonly _autorunPendingNotebooks = new Set<string>();
    private readonly _autorunDiscoveryRetries = new Map<string, number>();
    private readonly _cellExecutionVersions = new Map<string, number>();

    private _ensureControllerAssociation(notebook: vscode.NotebookDocument): void {
        if (notebook.notebookType !== this.notebookType || isRemoteNotebookAlias(notebook.uri)) {
            return;
        }

        try {
            this._controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
        } catch {
            // Some hosts may reject affinity updates transiently.
            // Execution has a fallback path if association is unavailable.
        }
    }

    public constructor(extensionId: string) {
        this._extensionId = extensionId;
        this._controller = vscode.notebooks.createNotebookController(this.id, this.notebookType, this.label);
        this._controller.supportedLanguages = SUPPORTED_LANGUAGES;
        this._controller.description = 'Web Notebook';
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = this.executeHandler.bind(this);
        const rendererMessaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);
        const runAutorunCells = (editor: vscode.NotebookEditor) => {
            const { notebook } = editor;
            if (notebook.notebookType !== this.notebookType) {
                return;
            }
            if (isRemoteNotebookAlias(notebook.uri)) {
                warnExecution('autorun skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
                return;
            }

            this._ensureControllerAssociation(notebook);

            const notebookKey = getNotebookKey(notebook.uri);
            if (this._autorunPendingNotebooks.has(notebookKey)) {
                return;
            }

            const cellsToRun = this._getAutorunCells(notebook);
            if (cellsToRun.length === 0) {
                const nextRetry = (this._autorunDiscoveryRetries.get(notebookKey) ?? 0) + 1;
                if (nextRetry <= MAX_AUTORUN_DISCOVERY_RETRIES) {
                    this._autorunDiscoveryRetries.set(notebookKey, nextRetry);
                    setTimeout(() => {
                        const retryEditor = vscode.window.visibleNotebookEditors
                            .find(candidate => !isRemoteNotebookAlias(candidate.notebook.uri) && notebookUrisMatch(candidate.notebook.uri, notebook.uri));
                        if (retryEditor) {
                            runAutorunCells(retryEditor);
                        }
                    }, AUTORUN_RETRY_DELAY_MS);
                }
                return;
            }

            const autorunSignature = this._getAutorunSignature(cellsToRun);
            if (this._autorunExecutedNotebookSignatures.get(notebookKey) === autorunSignature) {
                return;
            }

            this._autorunDiscoveryRetries.delete(notebookKey);

            this._autorunPendingNotebooks.add(notebookKey);
            setTimeout(() => {
                void this._executeAutorunCells(editor, this._getCellRanges(cellsToRun), autorunSignature);
            }, 0);
        };
        const collapseWidgetCells = (editor: vscode.NotebookEditor) => {
            if (editor.notebook.notebookType !== this.notebookType || isRemoteNotebookAlias(editor.notebook.uri)) {
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

        const initializeEditor = (editor: vscode.NotebookEditor) => {
            collapseWidgetCells(editor);
            runAutorunCells(editor);
        };

        const scheduleAutorunSweep = (attemptsLeft: number = AUTORUN_SWEEP_ATTEMPTS) => {
            if (attemptsLeft <= 0) {
                return;
            }

            setTimeout(() => {
                for (const visibleEditor of vscode.window.visibleNotebookEditors) {
                    runAutorunCells(visibleEditor);
                }
                scheduleAutorunSweep(attemptsLeft - 1);
            }, AUTORUN_SWEEP_DELAY_MS);
        };

        const runAutorunForNotebook = (notebook: vscode.NotebookDocument) => {
            if (notebook.notebookType !== this.notebookType) {
                return;
            }

            const matchingEditors = vscode.window.visibleNotebookEditors
                .filter(editor => !isRemoteNotebookAlias(editor.notebook.uri) && notebookUrisMatch(editor.notebook.uri, notebook.uri));
            for (const editor of matchingEditors) {
                runAutorunCells(editor);
            }
        };

        this._disposables.push(
            this._controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
                if (selected) {
                    runAutorunForNotebook(notebook);
                }
            }),
            rendererMessaging.onDidReceiveMessage(({ editor, message }) => {
                if (editor.notebook.notebookType !== this.notebookType || !isRendererMessage(message)) {
                    return;
                }

                const cell = editor.notebook.getCells()
                    .find(candidate => candidate.document.uri.toString() === message.cellUri);
                if (!cell) {
                    return;
                }

                if (message.type === 'webnb.refreshCell') {
                    if (!this._isAutoRefreshingCell(cell)) {
                        return;
                    }
                    void this._executeNotebookRanges(editor.notebook, [
                        new vscode.NotebookRange(cell.index, cell.index + 1)
                    ]);
                    return;
                }

                void this._upsertCellAddon(cell, message.addonType, message.content);
            }),
            vscode.workspace.onDidCloseNotebookDocument(notebook => {
                const notebookKey = getNotebookKey(notebook.uri);
                this._autorunExecutedNotebookSignatures.delete(notebookKey);
                this._autorunPendingNotebooks.delete(notebookKey);
                this._autorunDiscoveryRetries.delete(notebookKey);
                for (const cell of notebook.getCells()) {
                    this._cellExecutionVersions.delete(cell.document.uri.toString());
                }
            }),
            vscode.workspace.onDidOpenNotebookDocument(notebook => {
                this._ensureControllerAssociation(notebook);
                runAutorunForNotebook(notebook);
                scheduleAutorunSweep();
            }),
            vscode.workspace.onDidChangeNotebookDocument(event => {
                if (event.notebook.notebookType !== this.notebookType) {
                    return;
                }

                // Cells can appear after initial open events; retry autorun when the
                // notebook structure changes so autorun cells still execute.
                if (event.cellChanges.length === 0 && event.contentChanges.length === 0) {
                    return;
                }

                runAutorunForNotebook(event.notebook);
                scheduleAutorunSweep(4);
            }),
            vscode.window.onDidChangeActiveNotebookEditor(editor => {
                if (!editor) {
                    return;
                }

                void this._selectControllerForEditor(editor);
                initializeEditor(editor);
            }),
            vscode.window.onDidChangeVisibleNotebookEditors(editors => {
                for (const editor of editors) {
                    initializeEditor(editor);
                }
            })
        );

        for (const editor of vscode.window.visibleNotebookEditors) {
            this._ensureControllerAssociation(editor.notebook);
            initializeEditor(editor);
        }
        if (vscode.window.activeNotebookEditor) {
            this._ensureControllerAssociation(vscode.window.activeNotebookEditor.notebook);
            void this._selectControllerForEditor(vscode.window.activeNotebookEditor);
            runAutorunCells(vscode.window.activeNotebookEditor);
        }
        scheduleAutorunSweep();
    }

    public dispose(): void {
        this._controller.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    public async executeHandler(cells: vscode.NotebookCell[], _notebook: vscode.NotebookDocument, _controller: vscode.NotebookController): Promise<void> {
        logExecution('executeHandler start cells=%d notebook=%s activeNotebook=%s visible=%s',
            cells.length,
            uriLabel(_notebook.uri),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri),
            visibleNotebookLabels());

        for (const cell of cells) {
            const executableCell = this._resolveExecutableCell(cell);
            if (!executableCell) {
                warnExecution('executeHandler skipped remote alias cell with no executable notebook: %s', cellLabel(cell));
                continue;
            }

            logExecution('executeHandler cell %s', cellLabel(executableCell));
            const prepared = await this._prepareNotebookForExecution(executableCell.notebook);
            if (!prepared) {
                warnExecution('executeHandler skipped cell because notebook was not prepared: %s', cellLabel(executableCell));
                continue;
            }

            await this._doExecuteCell(executableCell);
        }

        logExecution('executeHandler end notebook=%s', uriLabel(_notebook.uri));
    }

    private _getAutorunCells(notebook: vscode.NotebookDocument): vscode.NotebookCell[] {
        return notebook.getCells()
            .filter(cell =>
                cell.kind === vscode.NotebookCellKind.Code &&
                    (cell.metadata?.autorun || this._isAutoWidgetCell(cell))
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

    private _isAutoWidgetCell(cell: vscode.NotebookCell): boolean {
        return cell.document.languageId === 'mcq' || this._isAutoRefreshingCell(cell);
    }

    private _isAutoRefreshingCell(cell: vscode.NotebookCell): boolean {
        return isExternalCheckLanguage(cell.document.languageId);
    }

    private async _executeAutorunCells(editor: vscode.NotebookEditor, ranges: vscode.NotebookRange[], autorunSignature: string): Promise<void> {
        const notebookKey = getNotebookKey(editor.notebook.uri);
        logExecution('autorun start notebook=%s ranges=%s signature=%s',
            uriLabel(editor.notebook.uri),
            rangesLabel(ranges),
            autorunSignature);
        try {
            const executed = await this._executeNotebookRanges(editor.notebook, ranges);
            if (executed) {
                this._autorunExecutedNotebookSignatures.set(notebookKey, autorunSignature);
                this._autorunDiscoveryRetries.delete(notebookKey);
            }
            logExecution('autorun end notebook=%s executed=%s', notebookKey, String(executed));
        } finally {
            this._autorunPendingNotebooks.delete(notebookKey);
        }
    }

    private async _executeNotebookRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): Promise<boolean> {
        logExecution('executeNotebookRanges start notebook=%s ranges=%s visible=%s',
            uriLabel(notebook.uri),
            rangesLabel(ranges),
            visibleNotebookLabels());

        if (ranges.length === 0) {
            logExecution('executeNotebookRanges no ranges notebook=%s', uriLabel(notebook.uri));
            return true;
        }

        const canExecute = await this._prepareNotebookForExecution(notebook);
        if (!canExecute) {
            warnExecution('executeNotebookRanges notebook was not prepared notebook=%s visible=%s',
                uriLabel(notebook.uri),
                visibleNotebookLabels());
            return false;
        }

        const expectedCells = this._getCellsInRanges(notebook, ranges);
        if (expectedCells.length === 0) {
            warnExecution('executeNotebookRanges found no cells notebook=%s ranges=%s',
                uriLabel(notebook.uri),
                rangesLabel(ranges));
            return false;
        }

        logExecution('executeNotebookRanges resolved cells=%d notebook=%s cellIndexes=%s',
            expectedCells.length,
            uriLabel(notebook.uri),
            expectedCells.map(cell => String(cell.index)).join(','));

        const executionVersionsBefore = new Map(
            expectedCells.map(cell => [
                cell.document.uri.toString(),
                this._cellExecutionVersions.get(cell.document.uri.toString()) ?? 0
            ])
        );

        try {
            for (const cell of expectedCells) {
                await this._doExecuteCell(cell);
            }
            const executed = expectedCells.every(cell => {
                const cellKey = cell.document.uri.toString();
                return (this._cellExecutionVersions.get(cellKey) ?? 0) > (executionVersionsBefore.get(cellKey) ?? 0);
            });
            logExecution('executeNotebookRanges end notebook=%s executed=%s',
                uriLabel(notebook.uri),
                String(executed));
            return executed;
        } catch (error) {
            console.error('[webnb] Could not execute notebook cells for %s:', notebook.uri.toString(), error);
            return false;
        }
    }

    private async _prepareNotebookForExecution(notebook: vscode.NotebookDocument): Promise<boolean> {
        if (isRemoteNotebookAlias(notebook.uri)) {
            warnExecution('prepareNotebook skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
            return false;
        }

        logExecution('prepareNotebook start notebook=%s activeNotebook=%s visible=%s',
            uriLabel(notebook.uri),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri),
            visibleNotebookLabels());

        const editor = vscode.window.visibleNotebookEditors
            .find(candidate => !isRemoteNotebookAlias(candidate.notebook.uri) && notebookUrisMatch(candidate.notebook.uri, notebook.uri));
        if (!editor) {
            warnExecution('prepareNotebook no visible editor notebook=%s visible=%s',
                uriLabel(notebook.uri),
                visibleNotebookLabels());
            return false;
        }

        const selected = await this._selectControllerForEditor(editor);
        logExecution('prepareNotebook end notebook=%s selected=%s activeNotebook=%s',
            uriLabel(notebook.uri),
            String(selected),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
        return true;
    }

    private async _selectControllerForEditor(editor: vscode.NotebookEditor): Promise<boolean> {
        const { notebook } = editor;
        if (notebook.notebookType !== this.notebookType) {
            logExecution('selectController skipped non-webnb notebookType=%s notebook=%s',
                notebook.notebookType,
                uriLabel(notebook.uri));
            return false;
        }
        if (isRemoteNotebookAlias(notebook.uri)) {
            warnExecution('selectController skipped remote notebook alias notebook=%s', uriLabel(notebook.uri));
            return false;
        }

        logExecution('selectController start notebook=%s viewColumn=%s activeNotebook=%s',
            uriLabel(notebook.uri),
            String(editor.viewColumn),
            uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));

        this._ensureControllerAssociation(notebook);

        try {
            if (!vscode.window.activeNotebookEditor || !notebookUrisMatch(vscode.window.activeNotebookEditor.notebook.uri, notebook.uri)) {
                logExecution('selectController showing notebook notebook=%s currentActive=%s',
                    uriLabel(notebook.uri),
                    uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
                await vscode.window.showNotebookDocument(notebook, {
                    viewColumn: editor.viewColumn,
                    preserveFocus: false,
                    preview: false
                });
                logExecution('selectController showed notebook notebook=%s activeNotebook=%s',
                    uriLabel(notebook.uri),
                    uriLabel(vscode.window.activeNotebookEditor?.notebook.uri));
            }

            const selected = await vscode.commands.executeCommand<boolean>(SELECT_KERNEL_COMMAND, {
                id: this.id,
                extension: this._extensionId,
                notebookEditor: editor,
                skipIfAlreadySelected: true
            });
            logExecution('selectController command result notebook=%s selected=%s',
                uriLabel(notebook.uri),
                String(selected));
            return selected !== false;
        } catch (error) {
            console.error('[webnb] Could not select notebook controller for %s:', notebook.uri.toString(), error);
            return false;
        }
    }

    private _getCellsInRanges(notebook: vscode.NotebookDocument, ranges: vscode.NotebookRange[]): vscode.NotebookCell[] {
        return ranges.flatMap(range => notebook.getCells(range));
    }

    private _resolveExecutableCell(cell: vscode.NotebookCell): vscode.NotebookCell | undefined {
        if (!isRemoteNotebookAlias(cell.notebook.uri)) {
            return cell;
        }

        const notebook = vscode.workspace.notebookDocuments
            .find(candidate =>
                candidate.notebookType === this.notebookType
                && !isRemoteNotebookAlias(candidate.uri)
                && notebookUrisMatch(candidate.uri, cell.notebook.uri)
            );
        if (!notebook || cell.index < 0 || cell.index >= notebook.cellCount) {
            return undefined;
        }

        return notebook.cellAt(cell.index);
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
        logExecution('cell execute start %s', cellLabel(cell));
        const source = cell.document.getText();
        const { languageId } = cell.document;
        let addons = getCellAddons(cell);
        logExecution('cell source loaded index=%d language=%s sourceLength=%d addonTypes=%s',
            cell.index,
            languageId,
            source.length,
            addons.map(addon => normalizeAddonType(addon.type)).join(',') || '<none>');
        const defaultCapture = getDefaultCaptureAddons(addons, source);
        if (defaultCapture.changed) {
            logExecution('cell default capture addon updated index=%d', cell.index);
            addons = defaultCapture.addons;
            await this._replaceCellAddons(cell, addons);
        }
        const files = await this._snapshotWorkspaceFiles(cell, addons, languageId, source);
        logExecution('cell snapshots ready index=%d snapshotKeys=%s',
            cell.index,
            Object.keys(files).join(',') || '<none>');

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

        try {
            logExecution('cell creating execution %s', cellLabel(cell));
            const exec = this._controller.createNotebookCellExecution(cell);
            logExecution('cell execution created index=%d', cell.index);
            exec.start(Date.now());
            logExecution('cell execution started index=%d', cell.index);
            await exec.replaceOutput(output);
            logExecution('cell output replaced index=%d outputItems=%d', cell.index, output.items.length);
            exec.end(true, Date.now());
            logExecution('cell execution ended index=%d success=true', cell.index);
            const cellKey = cell.document.uri.toString();
            this._cellExecutionVersions.set(cellKey, (this._cellExecutionVersions.get(cellKey) ?? 0) + 1);
            logExecution('cell execute complete %s executionVersion=%d',
                cellLabel(cell),
                this._cellExecutionVersions.get(cellKey) ?? 0);
        } catch (error) {
            console.error('[webnb] Cell execution failed for %s:', cellLabel(cell), error);
            throw error;
        }
    }

    private async _replaceCellAddons(cell: vscode.NotebookCell, addons: WebNbAddon[]): Promise<boolean> {
        const cellIndex = cell.index;
        if (cellIndex < 0) {
            return false;
        }

        const currentMetadata = (cell.metadata ?? {}) as Record<string, unknown>;
        const currentAddons = getCellAddons(cell);
        const currentSerialized = JSON.stringify(currentAddons);
        const nextSerialized = JSON.stringify(addons);
        if (currentSerialized === nextSerialized) {
            return false;
        }

        const metadata: Record<string, unknown> = {
            ...currentMetadata,
            addons
        };

        const edit = new vscode.WorkspaceEdit();
        edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cellIndex, metadata)]);
        return vscode.workspace.applyEdit(edit);
    }

    private async _upsertCellAddon(cell: vscode.NotebookCell, addonType: string, content: string): Promise<void> {
        const currentAddons = getCellAddons(cell);
        const nextAddons = upsertAddon(currentAddons, addonType, content);
        await this._replaceCellAddons(cell, nextAddons);
    }

    private async _snapshotWorkspaceFiles(cell: vscode.NotebookCell, addons: WebNbAddon[], languageId: string, source: string): Promise<Record<string, WorkspaceFileSnapshotEntry>> {
        const requestedPaths = getRequestedFilePaths(addons, languageId, source);
        if (requestedPaths.length === 0) {
            return {};
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(cell.notebook.uri) ?? vscode.workspace.workspaceFolders?.[0];
        const snapshots: Record<string, WorkspaceFileSnapshotEntry> = {};
        const notebookRelativeDir = workspaceFolder ? getNotebookRelativeDir(cell, workspaceFolder) : '';

        if (!workspaceFolder) {
            for (const requestedPath of requestedPaths) {
                snapshots[requestedPath.requestPath] = {
                    path: requestedPath.requestPath,
                    exists: false,
                    error: 'No workspace folder is open.'
                };
            }
            return snapshots;
        }

        for (const requestedPath of requestedPaths) {
            const normalizedPath = normalizeWorkspacePath(requestedPath.path);
            const snapshotKey = requestedPath.requestPath;

            if (!normalizedPath) {
                snapshots[snapshotKey] = {
                    path: requestedPath.requestPath,
                    exists: false,
                    error: 'File checks must use relative paths without ".." segments.'
                };
                continue;
            }

            const workspaceResolvedPath = requestedPath.base === 'workspace' || !notebookRelativeDir
                ? normalizedPath
                : `${notebookRelativeDir}/${normalizedPath}`;

            const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...workspaceResolvedPath.split('/'));
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                const type = fileTypeToString(stat.type);
                const snapshot: WorkspaceFileSnapshotEntry = {
                    path: requestedPath.requestPath,
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

                snapshots[snapshotKey] = snapshot;
            } catch (error) {
                snapshots[snapshotKey] = {
                    path: requestedPath.requestPath,
                    exists: false
                };
            }
        }

        return snapshots;
    }

}
