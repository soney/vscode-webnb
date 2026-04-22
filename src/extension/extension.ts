// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { activate as activateSerializer, deactivate as deactivateSerializer } from './serializer';
import { activate as activateKernel, deactivate as deactivateKernel } from './webnbProvider';

const WEB_NOTEBOOK_VIEW_TYPE = 'web-notebook';
const WEBNB_EXTENSION = '.webnb';
const STARTUP_OPEN_SWEEP_DELAYS_MS = [0, 250, 1000, 2500];
const DUPLICATE_TAB_CLEANUP_DELAYS_MS = [0, 100, 500, 1500, 3000];
const pendingNotebookReopens = new Set<string>();
const scheduledDuplicateTabCleanups = new Set<string>();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    activateSerializer(context);
    activateKernel(context);
    activateTextOpenFallback(context);
}

// This method is called when your extension is deactivated
export function deactivate() {
    deactivateSerializer();
    deactivateKernel();
}

function activateTextOpenFallback(context: vscode.ExtensionContext): void {
    const reopenVisibleWebnbTextEditors = () => {
        for (const editor of vscode.window.visibleTextEditors) {
            void reopenTextEditorAsNotebook(editor);
        }
    };
    const reopenVisibleRemoteWebnbNotebooks = () => {
        for (const editor of vscode.window.visibleNotebookEditors) {
            void reopenRemoteNotebookAsLocalFile(editor.notebook);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('webnb.focusSingleFile', async (resource?: vscode.Uri) => {
            const targetUri = getCommandTargetUri(resource);
            if (!targetUri || !isWebnbFileUri(targetUri)) {
                vscode.window.showWarningMessage('Open a .webnb file to use Web Notebook.');
                return;
            }

            await openAsWebNotebook(targetUri);
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            reopenVisibleWebnbTextEditors();
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                void reopenTextEditorAsNotebook(editor);
            }
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (!isWebnbFileUri(document.uri)) {
                return;
            }

            setTimeout(reopenVisibleWebnbTextEditors, 0);
        }),
        vscode.window.onDidChangeVisibleNotebookEditors(() => {
            reopenVisibleRemoteWebnbNotebooks();
        }),
        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            if (editor) {
                void reopenRemoteNotebookAsLocalFile(editor.notebook);
            }
        }),
        vscode.workspace.onDidOpenNotebookDocument(notebook => {
            void reopenRemoteNotebookAsLocalFile(notebook);
        }),
        vscode.window.tabGroups.onDidChangeTabs(event => {
            for (const tab of [...event.opened, ...event.changed]) {
                const uri = getTabInputUri(tab.input);
                if (!uri || !isWebnbFileUri(uri)) {
                    continue;
                }

                scheduleDuplicateTabCleanup(uri);
                if (isTextTab(tab)) {
                    void openAsWebNotebook(uri);
                }
            }
        })
    );

    // URL payloads in code-server can restore the raw text editor before the
    // notebook contribution wins editor resolution, so sweep a few startup ticks.
    for (const delayMs of STARTUP_OPEN_SWEEP_DELAYS_MS) {
        setTimeout(() => {
            reopenVisibleWebnbTextEditors();
            reopenVisibleRemoteWebnbNotebooks();
        }, delayMs);
    }
}

function getCommandTargetUri(resource?: vscode.Uri): vscode.Uri | undefined {
    if (resource) {
        return resource;
    }

    return vscode.window.activeNotebookEditor?.notebook.uri
        ?? vscode.window.activeTextEditor?.document.uri;
}

function isWebnbFileUri(uri: vscode.Uri): boolean {
    return uri.scheme !== 'vscode-notebook-cell'
        && uri.path.toLowerCase().endsWith(WEBNB_EXTENSION);
}

function getWebnbUriKey(uri: vscode.Uri): string {
    return [
        uri.scheme,
        normalizeUriPath(uri),
        uri.query,
        uri.fragment
    ].join('\n');
}

function normalizeUriPath(uri: vscode.Uri): string {
    return uri.path.replace(/\/+$/, '') || '/';
}

function urisReferToSameWebnbFile(a: vscode.Uri, b: vscode.Uri): boolean {
    return isWebnbFileUri(a)
        && isWebnbFileUri(b)
        && a.scheme === b.scheme
        && normalizeUriPath(a) === normalizeUriPath(b)
        && (!a.authority || !b.authority || a.authority === b.authority)
        && (!a.query || !b.query || a.query === b.query)
        && (!a.fragment || !b.fragment || a.fragment === b.fragment);
}

function getVisibleNotebookEditor(uri: vscode.Uri): vscode.NotebookEditor | undefined {
    return vscode.window.visibleNotebookEditors.find(editor => urisReferToSameWebnbFile(editor.notebook.uri, uri));
}

function isUri(value: unknown): value is vscode.Uri {
    if (value instanceof vscode.Uri) {
        return true;
    }

    const candidate = value as Partial<vscode.Uri> | undefined;
    return typeof candidate?.scheme === 'string'
        && typeof candidate.path === 'string'
        && typeof candidate.toString === 'function';
}

function getTabInputUri(input: unknown): vscode.Uri | undefined {
    if (input instanceof vscode.TabInputText
        || input instanceof vscode.TabInputCustom
        || input instanceof vscode.TabInputNotebook) {
        return input.uri;
    }

    const candidate = input as { uri?: unknown } | undefined;
    return isUri(candidate?.uri) ? candidate.uri : undefined;
}

function isTextTab(tab: vscode.Tab): boolean {
    const { input } = tab;
    if (input instanceof vscode.TabInputText) {
        return true;
    }

    const candidate = input as {
        uri?: unknown;
        notebookType?: unknown;
        viewType?: unknown;
        original?: unknown;
        modified?: unknown;
    } | undefined;

    return isUri(candidate?.uri)
        && candidate.notebookType === undefined
        && candidate.viewType === undefined
        && candidate.original === undefined
        && candidate.modified === undefined;
}

function isWebNotebookTab(tab: vscode.Tab, uri: vscode.Uri): boolean {
    const input = tab.input;
    const tabUri = getTabInputUri(input);
    if (!tabUri || !urisReferToSameWebnbFile(tabUri, uri)) {
        return false;
    }

    if (input instanceof vscode.TabInputNotebook) {
        return input.notebookType === WEB_NOTEBOOK_VIEW_TYPE;
    }

    const candidate = input as { notebookType?: unknown } | undefined;
    return candidate?.notebookType === WEB_NOTEBOOK_VIEW_TYPE;
}

function getAllTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
        .flatMap(group => [...group.tabs]);
}

function getTextTabsForUri(uri: vscode.Uri): vscode.Tab[] {
    return getAllTabs()
        .filter(tab => isTextTab(tab))
        .filter(tab => {
            const tabUri = getTabInputUri(tab.input);
            return tabUri !== undefined && urisReferToSameWebnbFile(tabUri, uri);
        });
}

function getNotebookTabsForUri(uri: vscode.Uri): vscode.Tab[] {
    return getAllTabs()
        .filter(tab => isWebNotebookTab(tab, uri));
}

function tabInputLabel(input: unknown): string {
    const inputUri = getTabInputUri(input)?.toString() ?? 'no-uri';
    if (input instanceof vscode.TabInputText) {
        return `text ${inputUri}`;
    }
    if (input instanceof vscode.TabInputNotebook) {
        return `notebook:${input.notebookType} ${inputUri}`;
    }
    if (input instanceof vscode.TabInputCustom) {
        return `custom:${input.viewType} ${inputUri}`;
    }
    if (input instanceof vscode.TabInputTextDiff) {
        return `text-diff ${input.original.toString()} -> ${input.modified.toString()}`;
    }
    if (input instanceof vscode.TabInputNotebookDiff) {
        return `notebook-diff:${input.notebookType} ${input.original.toString()} -> ${input.modified.toString()}`;
    }
    if (input instanceof vscode.TabInputWebview) {
        return `webview:${input.viewType}`;
    }
    if (input instanceof vscode.TabInputTerminal) {
        return 'terminal';
    }

    const candidate = input as {
        constructor?: { name?: string };
        notebookType?: unknown;
        viewType?: unknown;
    } | undefined;
    const details = [
        typeof candidate?.notebookType === 'string' ? `notebookType:${candidate.notebookType}` : undefined,
        typeof candidate?.viewType === 'string' ? `viewType:${candidate.viewType}` : undefined,
        inputUri
    ].filter((value): value is string => value !== undefined);

    return `${candidate?.constructor?.name ?? typeof input} ${details.join(' ')}`;
}

function tabLabel(tab: vscode.Tab): string {
    return `${tab.label} [active=${tab.isActive} dirty=${tab.isDirty} preview=${tab.isPreview}] ${tabInputLabel(tab.input)}`;
}

function scheduleDuplicateTabCleanup(uri: vscode.Uri): void {
    const uriKey = getWebnbUriKey(uri);
    if (scheduledDuplicateTabCleanups.has(uriKey)) {
        return;
    }

    scheduledDuplicateTabCleanups.add(uriKey);
    let remainingRuns = DUPLICATE_TAB_CLEANUP_DELAYS_MS.length;
    for (const delayMs of DUPLICATE_TAB_CLEANUP_DELAYS_MS) {
        setTimeout(() => {
            void closeDuplicateTabs(uri).finally(() => {
                remainingRuns -= 1;
                if (remainingRuns === 0) {
                    scheduledDuplicateTabCleanups.delete(uriKey);
                }
            });
        }, delayMs);
    }
}

async function closeDuplicateTabs(uri: vscode.Uri): Promise<void> {
    const notebookTabs = getNotebookTabsForUri(uri);
    const textTabs = getTextTabsForUri(uri);
    const notebookTabToKeep = notebookTabs.find(tab => tab.isActive)
        ?? notebookTabs.find(tab => !tab.isPreview)
        ?? notebookTabs[0];
    const duplicateNotebookTabs = notebookTabToKeep
        ? notebookTabs.filter(tab => tab !== notebookTabToKeep)
        : [];
    console.log(
        '[webnb] duplicate tab scan target=%s notebookTabs=%d textTabs=%d keep=%s tabs=%s',
        uri.toString(),
        notebookTabs.length,
        textTabs.length,
        notebookTabToKeep ? tabLabel(notebookTabToKeep) : 'none',
        getAllTabs().map(tabLabel).join(' | ')
    );

    if (notebookTabs.length === 0) {
        return;
    }

    const tabsToClose = [
        ...textTabs.filter(tab => !tab.isDirty),
        ...duplicateNotebookTabs.filter(tab => !tab.isDirty)
    ];
    const dirtyTabs = [
        ...textTabs.filter(tab => tab.isDirty),
        ...duplicateNotebookTabs.filter(tab => tab.isDirty)
    ];

    if (dirtyTabs.length > 0) {
        console.warn(
            '[webnb] Leaving dirty duplicate tab open for %s: %s',
            uri.toString(),
            dirtyTabs.map(tabLabel).join(' | ')
        );
    }

    if (tabsToClose.length === 0) {
        return;
    }

    console.log(
        '[webnb] closing duplicate tabs for %s: %s',
        uri.toString(),
        tabsToClose.map(tabLabel).join(' | ')
    );
    await vscode.window.tabGroups.close(tabsToClose, true);
}

async function reopenTextEditorAsNotebook(editor: vscode.TextEditor): Promise<void> {
    const { document } = editor;
    if (!isWebnbFileUri(document.uri)) {
        return;
    }

    await openAsWebNotebook(document.uri);
}

async function reopenRemoteNotebookAsLocalFile(notebook: vscode.NotebookDocument): Promise<void> {
    if (notebook.notebookType !== WEB_NOTEBOOK_VIEW_TYPE) {
        return;
    }

    scheduleDuplicateTabCleanup(notebook.uri);
    await openAsWebNotebook(notebook.uri);
}

async function openAsWebNotebook(uri: vscode.Uri): Promise<void> {
    const uriKey = getWebnbUriKey(uri);
    if (pendingNotebookReopens.has(uriKey)) {
        scheduleDuplicateTabCleanup(uri);
        return;
    }

    scheduleDuplicateTabCleanup(uri);
    const visibleEditor = getVisibleNotebookEditor(uri);
    if (visibleEditor) {
        await vscode.window.showNotebookDocument(visibleEditor.notebook, {
            viewColumn: visibleEditor.viewColumn,
            preserveFocus: false,
            preview: false
        });
        scheduleDuplicateTabCleanup(visibleEditor.notebook.uri);
        return;
    }

    pendingNotebookReopens.add(uriKey);
    try {
        await vscode.commands.executeCommand('vscode.openWith', uri, WEB_NOTEBOOK_VIEW_TYPE);
        scheduleDuplicateTabCleanup(uri);
    } catch (error) {
        console.error('[webnb] Could not reopen %s as a Web Notebook:', uri.toString(), error);
    } finally {
        pendingNotebookReopens.delete(uriKey);
    }
}


async function getWebNBFilesInCurrentDirectory(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace is open");
        return [];
    }

    const rootUri = workspaceFolders[0].uri; // Get the first workspace folder
    try {
        const entries = await vscode.workspace.fs.readDirectory(rootUri);

        // Filter only files (not directories)
        // only .webnb files
        const files = entries
            .filter(([name, type]) => type === vscode.FileType.File)
            .filter(([name]) => name.endsWith('.webnb'))
            .map(([name]) => name);

        // vscode.window.showInformationMessage(`Files: ${files.join(', ')}`);
        return files;
    } catch (err) {
        vscode.window.showErrorMessage(`Error reading directory: ${err}`);
        return [];
    }
}
