/**
 * A small fake of the `vscode` module, so the extension-host modules can run
 * under plain mocha: the API surface they use, a fake notebook model that
 * applies edits and fires change events the way the extension host does, and
 * `testing` controls for the tests. setup/vscodeHook.ts loads this in place of
 * `vscode`. Everything here is test scaffolding: keep it to what the tests
 * exercise, not a general-purpose emulation of VS Code.
 */

type Listener<T> = (event: T) => unknown;

export interface Disposable { dispose(): void }

export class EventEmitter<T> {
    private _listeners: Listener<T>[] = [];
    public readonly event = (listener: Listener<T>): Disposable => {
        this._listeners.push(listener);
        return { dispose: () => { this._listeners = this._listeners.filter(candidate => candidate !== listener); } };
    };
    public fire(event: T): void {
        for (const listener of [...this._listeners]) {
            listener(event);
        }
    }
    public get listenerCount(): number {
        return this._listeners.length;
    }
}

export enum NotebookCellKind { Markup = 1, Code = 2 }
export enum EndOfLine { LF = 1, CRLF = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum NotebookControllerAffinity { Default = 1, Preferred = 2 }
export enum NotebookEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }
export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }

export class Uri {
    private constructor(
        public readonly scheme: string,
        public readonly authority: string,
        public readonly path: string,
        public readonly query: string,
        public readonly fragment: string
    ) { }
    public static file(path: string): Uri {
        return new Uri('file', '', path, '', '');
    }
    public static parse(value: string): Uri {
        const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
        if (!match) {
            throw new Error(`bad uri ${value}`);
        }
        return new Uri(match[1], match[2] ?? '', decodeURIComponent(match[3] || '/'), match[4] ?? '', match[5] ?? '');
    }
    public static joinPath(base: Uri, ...segments: string[]): Uri {
        const parts: string[] = [];
        for (const part of [base.path, ...segments].join('/').split('/')) {
            if (part === '..') {
                parts.pop();
            } else if (part && part !== '.') {
                parts.push(part);
            }
        }
        return base.with({ path: '/' + parts.join('/') });
    }
    public with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path,
            change.query ?? this.query, change.fragment ?? this.fragment);
    }
    public get fsPath(): string {
        return this.path;
    }
    public toString(): string {
        return `${this.scheme}://${this.authority}${encodeURI(this.path)}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`;
    }
    public toJSON(): unknown {
        return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
    }
}

export class Position {
    public constructor(public readonly line: number, public readonly character: number) { }
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;
    public constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

export class NotebookRange {
    public constructor(public readonly start: number, public readonly end: number) { }
    public get isEmpty(): boolean {
        return this.start === this.end;
    }
}

export class NotebookCellOutputItem {
    public constructor(public readonly data: Uint8Array, public readonly mime: string) { }
    public static json(value: unknown, mime = 'application/json'): NotebookCellOutputItem {
        return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(value)), mime);
    }
}

export class NotebookCellOutput {
    public constructor(public readonly items: NotebookCellOutputItem[], public readonly metadata?: Record<string, unknown>) { }
}

export class NotebookCellData {
    public metadata?: Record<string, unknown>;
    public outputs?: NotebookCellOutput[];
    public constructor(public kind: NotebookCellKind, public value: string, public languageId: string) { }
}

export class ThemeColor {
    public constructor(public readonly id: string) { }
}

export class TabInputText {
    public constructor(public readonly uri: Uri) { }
}

export class TabInputNotebook {
    public constructor(public readonly uri: Uri, public readonly notebookType: string) { }
}

export type NotebookEditLike =
    | { kind: 'replaceCells'; range: NotebookRange; newCells: NotebookCellData[] }
    | { kind: 'updateCellMetadata'; index: number; newCellMetadata: Record<string, unknown> };

export const NotebookEdit = {
    replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEditLike {
        return { kind: 'replaceCells', range, newCells };
    },
    updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEditLike {
        return { kind: 'updateCellMetadata', index, newCellMetadata };
    }
};

export class WorkspaceEdit {
    public readonly notebookEdits: { uri: Uri; edits: NotebookEditLike[] }[] = [];
    public readonly textEdits: { uri: Uri; range: Range; text: string }[] = [];
    public set(uri: Uri, edits: NotebookEditLike[]): void {
        this.notebookEdits.push({ uri, edits });
    }
    public replace(uri: Uri, range: Range, text: string): void {
        this.textEdits.push({ uri, range, text });
    }
}

// ---- fake documents -------------------------------------------------------------------

let nextCellId = 0;

export class FakeTextDocument {
    public version = 1;
    public eol = EndOfLine.LF;
    public isDirty = false;
    public constructor(public readonly uri: Uri, public languageId: string, private _text: string) { }
    public getText(): string {
        return this._text;
    }
    public get lineCount(): number {
        return this._text.split('\n').length;
    }
    public validateRange(range: Range): Range {
        return range;
    }
    /** Replaces the whole text (the only text edit the host modules make), firing events. */
    public setText(text: string, notebook?: FakeNotebook): void {
        this._text = text;
        this.version++;
        emitters.changeTextDocument.fire({ document: this, contentChanges: [{ text }], reason: undefined });
        const cell = notebook?.getCells().find(candidate => candidate.document === this);
        if (notebook && cell) {
            notebook.isDirty = true;
            emitters.changeNotebookDocument.fire({
                notebook, metadata: undefined, contentChanges: [],
                cellChanges: [{ cell, document: this, metadata: undefined, outputs: undefined, executionSummary: undefined }]
            });
        }
    }
}

export class FakeCell {
    public outputs: NotebookCellOutput[] = [];
    public readonly document: FakeTextDocument;
    public constructor(
        public readonly notebook: FakeNotebook,
        public readonly kind: NotebookCellKind,
        text: string,
        languageId: string,
        public metadata: Record<string, unknown> = {}
    ) {
        this.document = new FakeTextDocument(
            notebook.uri.with({ scheme: 'vscode-notebook-cell', fragment: `c${nextCellId++}` }), languageId, text);
    }
    public get index(): number {
        return this.notebook.getCells().indexOf(this);
    }
}

export interface FakeCellInit {
    kind?: NotebookCellKind;
    value: string;
    languageId?: string;
    metadata?: Record<string, unknown>;
}

export class FakeNotebook {
    public isDirty = false;
    public isClosed = false;
    public isUntitled = false;
    public metadata: Record<string, unknown> = {};
    private _cells: FakeCell[] = [];
    public constructor(public readonly uri: Uri, cells: FakeCellInit[] = [], public readonly notebookType = 'web-notebook') {
        this._cells = cells.map(init => this.createCell(init));
    }
    public createCell(init: FakeCellInit | NotebookCellData): FakeCell {
        const kind = init.kind ?? NotebookCellKind.Code;
        const languageId = init.languageId ?? (kind === NotebookCellKind.Markup ? 'markdown' : 'javascript');
        const cell = new FakeCell(this, kind, init.value, languageId, { ...(init.metadata ?? {}) });
        if (init instanceof NotebookCellData && init.outputs) {
            cell.outputs = init.outputs;
        }
        return cell;
    }
    public get cellCount(): number {
        return this._cells.length;
    }
    public cellAt(index: number): FakeCell {
        return this._cells[index];
    }
    public getCells(range?: NotebookRange): FakeCell[] {
        return range ? this._cells.slice(range.start, range.end) : [...this._cells];
    }
    /** Splices cells the way the host reports it: one content change, then the event. */
    public splice(start: number, deleteCount: number, added: FakeCell[], options: { dirty?: boolean } = {}): void {
        const removed = this._cells.splice(start, deleteCount, ...added);
        this.isDirty = options.dirty ?? true;
        emitters.changeNotebookDocument.fire({
            notebook: this, metadata: undefined, cellChanges: [],
            contentChanges: [{ range: new NotebookRange(start, start + deleteCount), removedCells: removed, addedCells: added }]
        });
    }
    public setCellMetadata(index: number, metadata: Record<string, unknown>): void {
        const cell = this._cells[index];
        cell.metadata = metadata;
        this.isDirty = true;
        emitters.changeNotebookDocument.fire({
            notebook: this, metadata: undefined, contentChanges: [],
            cellChanges: [{ cell, document: undefined, metadata, outputs: undefined, executionSummary: undefined }]
        });
    }
}

export class FakeNotebookEditor {
    public selection = new NotebookRange(0, 0);
    /** Laid out by default; tests set [] for an editor that has not rendered yet. */
    public visibleRanges: NotebookRange[];
    public selections: NotebookRange[] = [];
    public revealed: NotebookRange[] = [];
    public constructor(public readonly notebook: FakeNotebook, public viewColumn: number = 1) {
        this.visibleRanges = [new NotebookRange(0, notebook.cellCount)];
    }
    public revealRange(range: NotebookRange): void {
        this.revealed.push(range);
    }
}

// ---- the module surface ---------------------------------------------------------------

const emitters = {
    changeNotebookDocument: new EventEmitter<unknown>(),
    openNotebookDocument: new EventEmitter<unknown>(),
    closeNotebookDocument: new EventEmitter<unknown>(),
    changeTextDocument: new EventEmitter<unknown>(),
    changeConfiguration: new EventEmitter<unknown>(),
    changeWorkspaceFolders: new EventEmitter<unknown>(),
    changeActiveNotebookEditor: new EventEmitter<unknown>(),
    changeVisibleNotebookEditors: new EventEmitter<unknown>(),
    changeVisibleTextEditors: new EventEmitter<unknown>(),
    changeNotebookEditorVisibleRanges: new EventEmitter<unknown>(),
    changeTabs: new EventEmitter<unknown>(),
    rendererMessage: new EventEmitter<unknown>()
};

type ConfigScope = 'defaultValue' | 'globalValue' | 'workspaceValue';

class ConfigStore {
    public readonly values: Record<ConfigScope, Record<string, unknown>> = { defaultValue: {}, globalValue: {}, workspaceValue: {} };
    public readonly writes: { key: string; scope: ConfigScope; value: unknown }[] = [];
    public effective(key: string): unknown {
        const { defaultValue, globalValue, workspaceValue } = this.values;
        for (const value of [workspaceValue[key], globalValue[key], defaultValue[key]]) {
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }
}

export interface FileSystemHooks {
    stat?(uri: Uri): Promise<{ type: FileType; size: number }>;
    readFile?(uri: Uri): Promise<Uint8Array>;
    readDirectory?(uri: Uri): Promise<[string, FileType][]>;
}

export interface MessageAnswer { (message: string, items: unknown[]): string | undefined }

class MementoStub {
    public readonly values = new Map<string, unknown>();
    public get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }
    public async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, JSON.parse(JSON.stringify(value)));
        }
    }
    public keys(): readonly string[] {
        return [...this.values.keys()];
    }
}

function createTesting() {
    return {
        emitters,
        config: new ConfigStore(),
        fs: {} as FileSystemHooks,
        /** Answers warning/information prompts; undefined dismisses them. */
        answer: undefined as MessageAnswer | undefined,
        messages: [] as { message: string; items: unknown[] }[],
        executedCommands: [] as unknown[][],
        commandHandlers: new Map<string, (...args: unknown[]) => unknown>(),
        /** Replaces executeCommand's result for a command id. */
        commandResults: new Map<string, (...args: unknown[]) => unknown>(),
        appliedEdits: [] as WorkspaceEdit[],
        /** When set, decides applyEdit's result instead of applying the edit. */
        applyEditHook: undefined as ((edit: WorkspaceEdit) => boolean | undefined) | undefined,
        postedRendererMessages: [] as { message: unknown; editor: unknown }[],
        globalState: new MementoStub(),
        workspaceState: new MementoStub(),
        clearedOutputs: [] as unknown[],
        closedTabs: [] as unknown[],
        serializers: [] as { type: string; serializer: unknown; options: unknown }[]
    };
}

export let testing = createTesting();

/** Puts the stub back to an empty window. Call from each test's setup. */
export function resetStub(): void {
    testing = createTesting();
    workspace.notebookDocuments = [];
    workspace.textDocuments = [];
    workspace.workspaceFolders = undefined;
    window.visibleNotebookEditors = [];
    window.visibleTextEditors = [];
    window.activeNotebookEditor = undefined;
    window.tabGroups.all = [];
}

/** Applies a WorkspaceEdit to the fake documents, firing the events the host would. */
function applyToFakes(edit: WorkspaceEdit): boolean {
    // Only whole-document replaces are made by the host modules, so the range is not needed.
    for (const { uri, text } of edit.textEdits) {
        const target = findTextDocument(uri);
        if (!target) {
            return false;
        }
        target.document.setText(text, target.notebook);
    }
    for (const { uri, edits } of edit.notebookEdits) {
        const notebook = workspace.notebookDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!notebook) {
            return false;
        }
        for (const notebookEdit of edits) {
            if (notebookEdit.kind === 'replaceCells') {
                const added = notebookEdit.newCells.map(data => notebook.createCell(data));
                notebook.splice(notebookEdit.range.start, notebookEdit.range.end - notebookEdit.range.start, added);
            } else {
                notebook.setCellMetadata(notebookEdit.index, notebookEdit.newCellMetadata);
            }
        }
    }
    return true;
}

function findTextDocument(uri: Uri): { document: FakeTextDocument; notebook?: FakeNotebook } | undefined {
    for (const notebook of workspace.notebookDocuments) {
        const cell = notebook.getCells().find(candidate => candidate.document.uri.toString() === uri.toString());
        if (cell) {
            return { document: cell.document, notebook };
        }
    }
    const document = workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
    return document ? { document } : undefined;
}

export const workspace = {
    notebookDocuments: [] as FakeNotebook[],
    textDocuments: [] as FakeTextDocument[],
    workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
    onDidChangeNotebookDocument: emitters.changeNotebookDocument.event,
    onDidOpenNotebookDocument: emitters.openNotebookDocument.event,
    onDidCloseNotebookDocument: emitters.closeNotebookDocument.event,
    onDidChangeTextDocument: emitters.changeTextDocument.event,
    onDidChangeConfiguration: emitters.changeConfiguration.event,
    onDidChangeWorkspaceFolders: emitters.changeWorkspaceFolders.event,
    registerNotebookSerializer(type: string, serializer: unknown, options: unknown): Disposable {
        testing.serializers.push({ type, serializer, options });
        return { dispose() { } };
    },
    getConfiguration(section?: string) {
        const prefix = section ? section + '.' : '';
        return {
            get<T>(key: string, fallback?: T): T | undefined {
                const value = testing.config.effective(prefix + key) as T | undefined;
                return value === undefined ? fallback : value;
            },
            inspect<T>(key: string) {
                const full = prefix + key;
                const { defaultValue, globalValue, workspaceValue } = testing.config.values;
                return {
                    key: full,
                    defaultValue: defaultValue[full] as T | undefined,
                    globalValue: globalValue[full] as T | undefined,
                    workspaceValue: workspaceValue[full] as T | undefined
                };
            },
            async update(key: string, value: unknown, target: ConfigurationTarget): Promise<void> {
                const full = prefix + key;
                const scope: ConfigScope = target === ConfigurationTarget.Global ? 'globalValue' : 'workspaceValue';
                testing.config.writes.push({ key: full, scope, value });
                if (value === undefined) {
                    delete testing.config.values[scope][full];
                } else {
                    testing.config.values[scope][full] = value;
                }
            }
        };
    },
    getWorkspaceFolder(uri: Uri) {
        return (workspace.workspaceFolders ?? []).find(folder =>
            folder.uri.scheme === uri.scheme && (uri.path === folder.uri.path || uri.path.startsWith(folder.uri.path + '/')));
    },
    asRelativePath(uri: Uri, _includeFolder?: boolean): string {
        const folder = workspace.getWorkspaceFolder(uri);
        return folder ? uri.path.slice(folder.uri.path.length + 1) : uri.fsPath;
    },
    async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
        testing.appliedEdits.push(edit);
        const hooked = testing.applyEditHook?.(edit);
        if (hooked !== undefined) {
            return hooked;
        }
        return applyToFakes(edit);
    },
    async openNotebookDocument(uri: Uri): Promise<FakeNotebook> {
        let notebook = workspace.notebookDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!notebook) {
            notebook = new FakeNotebook(uri);
            workspace.notebookDocuments.push(notebook);
        }
        return notebook;
    },
    fs: {
        async stat(uri: Uri) {
            if (!testing.fs.stat) {
                throw new Error('ENOENT');
            }
            return testing.fs.stat(uri);
        },
        async readFile(uri: Uri) {
            if (!testing.fs.readFile) {
                throw new Error('ENOENT');
            }
            return testing.fs.readFile(uri);
        },
        async readDirectory(uri: Uri) {
            if (!testing.fs.readDirectory) {
                throw new Error('ENOENT');
            }
            return testing.fs.readDirectory(uri);
        }
    }
};

function recordMessage(message: string, rest: unknown[]): Promise<string | undefined> {
    const items = rest.filter(item => typeof item === 'string');
    testing.messages.push({ message, items: rest });
    return Promise.resolve(testing.answer?.(message, items));
}

const outputChannel = {
    trace() { }, debug() { }, info() { }, warn() { }, error() { }, append() { }, appendLine() { },
    show() { }, hide() { }, clear() { }, replace() { }, dispose() { }
};

export const window = {
    visibleNotebookEditors: [] as FakeNotebookEditor[],
    visibleTextEditors: [] as unknown[],
    activeNotebookEditor: undefined as FakeNotebookEditor | undefined,
    onDidChangeActiveNotebookEditor: emitters.changeActiveNotebookEditor.event,
    onDidChangeVisibleNotebookEditors: emitters.changeVisibleNotebookEditors.event,
    onDidChangeVisibleTextEditors: emitters.changeVisibleTextEditors.event,
    onDidChangeNotebookEditorVisibleRanges: emitters.changeNotebookEditorVisibleRanges.event,
    tabGroups: {
        all: [] as { viewColumn: number; isActive: boolean; tabs: { input: unknown; isActive: boolean; group: unknown }[] }[],
        onDidChangeTabs: emitters.changeTabs.event,
        async close(tab: unknown, _preserveFocus?: boolean): Promise<boolean> {
            testing.closedTabs.push(tab);
            for (const group of window.tabGroups.all) {
                group.tabs = group.tabs.filter(candidate => candidate !== tab);
            }
            return true;
        }
    },
    createOutputChannel(_name: string, _options?: unknown) {
        return outputChannel;
    },
    createTextEditorDecorationType(_options: unknown) {
        return { dispose() { } };
    },
    showWarningMessage(message: string, ...rest: unknown[]) {
        return recordMessage(message, rest);
    },
    showInformationMessage(message: string, ...rest: unknown[]) {
        return recordMessage(message, rest);
    },
    async showNotebookDocument(notebook: FakeNotebook, options?: { viewColumn?: number }) {
        let editor = window.visibleNotebookEditors.find(candidate => candidate.notebook === notebook);
        if (!editor) {
            editor = new FakeNotebookEditor(notebook, options?.viewColumn ?? 1);
            window.visibleNotebookEditors.push(editor);
        }
        return editor;
    },
    async showTextDocument() {
        return undefined;
    }
};

export const commands = {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
        testing.commandHandlers.set(id, handler);
        return { dispose: () => { testing.commandHandlers.delete(id); } };
    },
    async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
        testing.executedCommands.push([id, ...args]);
        const result = testing.commandResults.get(id);
        if (result) {
            return result(...args);
        }
        const handler = testing.commandHandlers.get(id);
        return handler ? handler(...args) : undefined;
    }
};

export const notebooks = {
    createNotebookController(id: string, notebookType: string, label: string) {
        const selectedEmitter = new EventEmitter<unknown>();
        return {
            id, notebookType, label,
            supportedLanguages: [] as string[],
            description: '',
            supportsExecutionOrder: false,
            executeHandler: undefined as unknown,
            onDidChangeSelectedNotebooks: selectedEmitter.event,
            fireSelected: (notebook: FakeNotebook, selected: boolean) => selectedEmitter.fire({ notebook, selected }),
            updateNotebookAffinity() { },
            createNotebookCellExecution(cell: FakeCell) {
                return {
                    start() { },
                    end() { },
                    async replaceOutput(output: NotebookCellOutput) { cell.outputs = [output]; },
                    async clearOutput() { cell.outputs = []; testing.clearedOutputs.push(cell); }
                };
            },
            dispose() { }
        };
    },
    createRendererMessaging(_rendererId: string) {
        return {
            onDidReceiveMessage: emitters.rendererMessage.event,
            async postMessage(message: unknown, editor?: unknown): Promise<boolean> {
                testing.postedRendererMessages.push({ message, editor });
                return true;
            }
        };
    }
};
