/**
 * Enough of the `vscode` API to run previewPanel.ts under plain node: file
 * URIs, settings, the editor events the manager listens to, and a webview panel
 * that records what the host posts to it.
 *
 * Tests drive the workbench through `state` (what is open, what is configured)
 * and `events` (the author switching editors), and read the result off
 * `state.panels[n].webview.messages`.
 */
export { NotebookCellKind, NotebookCellData } from './vscode-stub';

type Listener<T> = (value: T) => void;

class Emitter<T> {
    private readonly listeners = new Set<Listener<T>>();

    public readonly event = (listener: Listener<T>): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => void this.listeners.delete(listener) };
    };

    public fire(value: T): void {
        for (const listener of Array.from(this.listeners)) {
            listener(value);
        }
    }
}

function normalizePath(value: string): string {
    const segments: string[] = [];
    for (const part of value.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            segments.pop();
            continue;
        }
        segments.push(part);
    }
    return `/${segments.join('/')}`;
}

export class Uri {
    private constructor(public readonly path: string) {}

    public static file(value: string): Uri {
        return new Uri(normalizePath(value));
    }

    public static parse(value: string): Uri {
        return Uri.file(value.replace(/^file:\/\//, ''));
    }

    public static joinPath(base: Uri, ...parts: string[]): Uri {
        return Uri.file(`${base.path}/${parts.join('/')}`);
    }

    public get scheme(): string {
        return 'file';
    }

    public get fsPath(): string {
        return this.path;
    }

    public toString(): string {
        return `file://${this.path}`;
    }
}

export interface TextDocumentLike {
    uri: Uri;
    getText(): string;
    lineCount: number;
}

export interface TextEditorLike {
    document: TextDocumentLike;
    viewColumn?: number;
    visibleRanges: { start: { line: number } }[];
    selection: { active: { line: number } };
}

export class FakeWebview {
    public readonly cspSource = 'vscode-webview://stub';
    public options: { enableScripts?: boolean; localResourceRoots?: Uri[] } = {};
    /** Everything the host has posted, oldest first. */
    public readonly messages: Record<string, unknown>[] = [];
    /** Counts page loads: a rebind that changes the roots forces a new one. */
    public htmlLoads = 0;

    private currentHtml = '';
    private readonly incoming = new Emitter<unknown>();
    public readonly onDidReceiveMessage = this.incoming.event;

    public get html(): string {
        return this.currentHtml;
    }

    public set html(value: string) {
        this.currentHtml = value;
        this.htmlLoads++;
    }

    public asWebviewUri(uri: Uri): Uri {
        return uri;
    }

    public postMessage(message: Record<string, unknown>): Promise<boolean> {
        this.messages.push(message);
        return Promise.resolve(true);
    }

    /** The page talking back, as the real webview would. */
    public send(message: unknown): void {
        this.incoming.fire(message);
    }
}

export class FakeWebviewPanel {
    public readonly webview = new FakeWebview();
    public visible = true;
    public active = true;
    public disposed = false;

    private readonly viewState = new Emitter<{ webviewPanel: FakeWebviewPanel }>();
    private readonly disposal = new Emitter<void>();
    public readonly onDidChangeViewState = this.viewState.event;
    public readonly onDidDispose = this.disposal.event;

    constructor(
        public readonly viewType: string,
        public title: string,
        public viewColumn: number | undefined
    ) {}

    public reveal(column?: number, _preserveFocus?: boolean): void {
        this.viewColumn = column ?? this.viewColumn;
        this.visible = true;
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.disposal.fire();
    }

    /** Focus or bury the panel, as switching tabs in the workbench would. */
    public setViewState(next: { visible?: boolean; active?: boolean }): void {
        this.visible = next.visible ?? this.visible;
        this.active = next.active ?? this.active;
        this.viewState.fire({ webviewPanel: this });
    }
}

export const state = {
    /** Flat `section.key` -> value; anything unset falls back to the default. */
    settings: {} as Record<string, unknown>,
    workspaceFolders: [] as { uri: Uri; name: string; index: number }[],
    visibleTextEditors: [] as TextEditorLike[],
    panels: [] as FakeWebviewPanel[]
};

export const events = {
    activeTextEditor: new Emitter<TextEditorLike | undefined>(),
    textDocumentChanged: new Emitter<{ document: TextDocumentLike; contentChanges: unknown[] }>(),
    visibleRanges: new Emitter<{ textEditor: TextEditorLike }>(),
    selection: new Emitter<{ textEditor: TextEditorLike }>(),
    configuration: new Emitter<{ affectsConfiguration(section: string): boolean }>()
};

export function reset(): void {
    state.settings = {};
    state.workspaceFolders = [];
    state.visibleTextEditors = [];
    state.panels = [];
}

export class ThemeColor {
    constructor(public readonly id: string) {}
}

export class Range {
    constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number
    ) {}
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;
export const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const;
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

export const window = {
    get visibleTextEditors(): TextEditorLike[] {
        return state.visibleTextEditors;
    },
    get activeTextEditor(): TextEditorLike | undefined {
        return state.visibleTextEditors[0];
    },
    onDidChangeActiveTextEditor: events.activeTextEditor.event,
    onDidChangeTextEditorVisibleRanges: events.visibleRanges.event,
    onDidChangeTextEditorSelection: events.selection.event,
    createWebviewPanel(
        viewType: string,
        title: string,
        showOptions: number | { viewColumn: number },
        _options?: unknown
    ): FakeWebviewPanel {
        const column = typeof showOptions === 'number' ? showOptions : showOptions.viewColumn;
        const panel = new FakeWebviewPanel(viewType, title, column);
        state.panels.push(panel);
        return panel;
    },
    registerWebviewPanelSerializer(): { dispose(): void } {
        return { dispose: () => undefined };
    },
    createTextEditorDecorationType(_options: unknown): { dispose(): void } {
        return { dispose: () => undefined };
    },
    showTextDocument(): Promise<never> {
        return Promise.reject(new Error('showTextDocument is not stubbed'));
    }
};

export const workspace = {
    get workspaceFolders(): { uri: Uri; name: string; index: number }[] {
        return state.workspaceFolders;
    },
    getConfiguration(section: string, _resource?: Uri) {
        return {
            get<T>(key: string, fallback: T): T {
                const value = state.settings[`${section}.${key}`];
                return value === undefined ? fallback : (value as T);
            }
        };
    },
    getWorkspaceFolder(uri: Uri): { uri: Uri; name: string; index: number } | undefined {
        return state.workspaceFolders.find(folder => uri.path.startsWith(`${folder.uri.path}/`));
    },
    asRelativePath(uri: Uri, _includeWorkspaceFolder?: boolean): string {
        const folder = workspace.getWorkspaceFolder(uri);
        return folder ? uri.path.slice(folder.uri.path.length + 1) : uri.path;
    },
    onDidChangeTextDocument: events.textDocumentChanged.event,
    onDidChangeConfiguration: events.configuration.event,
    createFileSystemWatcher(_glob: string) {
        const changes = new Emitter<Uri>();
        return {
            onDidChange: changes.event,
            onDidCreate: changes.event,
            onDidDelete: changes.event,
            dispose: () => undefined
        };
    },
    openTextDocument(): Promise<never> {
        return Promise.reject(new Error('openTextDocument is not stubbed'));
    },
    fs: {
        stat(): Promise<never> {
            return Promise.reject(new Error('fs is not stubbed'));
        },
        readFile(): Promise<never> {
            return Promise.reject(new Error('fs is not stubbed'));
        },
        readDirectory(): Promise<never> {
            return Promise.reject(new Error('fs is not stubbed'));
        }
    }
};
