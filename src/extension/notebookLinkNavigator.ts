/**
 * Follows a link from one notebook to another.
 *
 * The markdown renderer catches the click (see
 * `src/markdownItPlugin/notebookLinkClicks.ts`) and posts the target here; this
 * side resolves the path against the linking notebook, opens the target as a
 * Web Notebook, and scrolls to the section the link named.
 */
import * as vscode from 'vscode';
import { logExecution, warnExecution } from './log';
import {
    findSectionCell,
    isOpenNotebookLinkMessage,
    NotebookLinkTarget,
    WEBNB_FILE_EXTENSION
} from '../shared/notebookLinks';

/** Must match the `notebookRenderer` id in package.json. */
export const WEBNB_MARKDOWN_RENDERER_ID = 'webnb-markdown-extensions';

export function activate(context: vscode.ExtensionContext): void {
    const messaging = vscode.notebooks.createRendererMessaging(WEBNB_MARKDOWN_RENDERER_ID);
    context.subscriptions.push(messaging.onDidReceiveMessage(async ({ editor, message }) => {
        if (!isOpenNotebookLinkMessage(message)) {
            return;
        }

        try {
            await followNotebookLink(editor, message, message.href);
        } catch (error) {
            warnExecution('notebook link failed href=%s error=%s', message.href, String(error));
            void vscode.window.showWarningMessage(`Could not open the link "${message.href}".`);
        }
    }));
}

export function deactivate(): void { }

async function followNotebookLink(
    source: vscode.NotebookEditor,
    target: NotebookLinkTarget,
    href: string
): Promise<void> {
    const targetEditor = target.path
        ? await openLinkedNotebook(source, target.path, href)
        : source;
    if (!targetEditor) {
        return;
    }

    if (!target.section) {
        return;
    }

    revealSection(targetEditor, target.section, href);
}

/** Opens the notebook a link names, in the group the reader is reading in. */
async function openLinkedNotebook(
    source: vscode.NotebookEditor,
    path: string,
    href: string
): Promise<vscode.NotebookEditor | undefined> {
    const uri = resolveNotebookUri(source.notebook.uri, path);
    if (!uri) {
        void vscode.window.showWarningMessage(
            `The link "${href}" points outside this workspace, so there is nothing to open.`
        );
        return undefined;
    }

    try {
        await vscode.workspace.fs.stat(uri);
    } catch {
        warnExecution('notebook link target missing href=%s uri=%s', href, uri.toString());
        void vscode.window.showWarningMessage(`There is no notebook at "${href}".`);
        return undefined;
    }

    logExecution('notebook link opening href=%s uri=%s', href, uri.toString());
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    return vscode.window.showNotebookDocument(notebook, {
        viewColumn: source.viewColumn,
        preview: false
    });
}

/**
 * A link's path is relative to the notebook it was written in, except when it
 * starts with `/` -- then it is relative to the workspace folder, which is how a
 * notebook in one module points at one in another without counting `../`s.
 */
function resolveNotebookUri(sourceUri: vscode.Uri, path: string): vscode.Uri | undefined {
    if (!path.toLowerCase().endsWith(WEBNB_FILE_EXTENSION)) {
        return undefined;
    }

    if (!path.startsWith('/')) {
        return vscode.Uri.joinPath(sourceUri, '..', path);
    }

    const folder = vscode.workspace.getWorkspaceFolder(sourceUri) ?? vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, path) : undefined;
}

/** Scrolls a notebook to the cell holding a section's heading. */
function revealSection(editor: vscode.NotebookEditor, section: string, href: string): void {
    const sources = editor.notebook.getCells().map(cell =>
        cell.kind === vscode.NotebookCellKind.Markup ? cell.document.getText() : undefined);
    const cellIndex = findSectionCell(sources, section);
    if (cellIndex === undefined) {
        warnExecution('notebook link section not found href=%s section=%s', href, section);
        void vscode.window.showWarningMessage(
            `"${editor.notebook.uri.path.split('/').pop()}" has no section called "#${section}".`
        );
        return;
    }

    const range = new vscode.NotebookRange(cellIndex, cellIndex + 1);
    editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
    editor.selection = range;
}
