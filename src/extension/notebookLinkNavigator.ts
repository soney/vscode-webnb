/**
 * Follows a link from one notebook to another.
 *
 * The markdown renderer catches the click (see
 * `src/markdownItPlugin/notebookLinkClicks.ts`) and posts the target here; this
 * side resolves the path against the linking notebook, opens the target as a
 * Web Notebook, and scrolls to the section the link named.
 *
 * That renderer extends VS Code's markdown renderer, so it runs in every
 * notebook's webview, Jupyter's included. It takes over no click until it has
 * asked, and been told, that its notebook is a Web Notebook; any other notebook
 * keeps VS Code's own link handling, and a link request from one is ignored.
 */
import * as vscode from 'vscode';
import { logExecution, warnExecution } from './log';
import {
    findSectionCell,
    isLinkHandlerHelloMessage,
    isOpenNotebookLinkMessage,
    LINK_HANDLER_CONFIG_MESSAGE,
    NotebookLinkTarget,
    WebNbLinkHandlerConfigMessage,
    WEBNB_FILE_EXTENSION
} from '../shared/notebookLinks';
import { isRealPathInside } from './workspaceContainment';

/** Must match the `notebookRenderer` id in package.json. */
export const WEBNB_MARKDOWN_RENDERER_ID = 'webnb-markdown-extensions';
const NOTEBOOK_TYPE = 'web-notebook';

export function activate(context: vscode.ExtensionContext): void {
    const messaging = vscode.notebooks.createRendererMessaging(WEBNB_MARKDOWN_RENDERER_ID);
    context.subscriptions.push(messaging.onDidReceiveMessage(async ({ editor, message }) => {
        const isWebNotebook = editor.notebook.notebookType === NOTEBOOK_TYPE;

        if (isLinkHandlerHelloMessage(message)) {
            // Answer the asking editor only: each notebook's webview decides for itself.
            const reply: WebNbLinkHandlerConfigMessage = { type: LINK_HANDLER_CONFIG_MESSAGE, enabled: isWebNotebook };
            void messaging.postMessage(reply, editor);
            return;
        }

        if (!isOpenNotebookLinkMessage(message) || !isWebNotebook) {
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
    const uri = await resolveNotebookUri(source.notebook.uri, path);
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
 *
 * Either way the target must stay inside the linking notebook's workspace
 * folder (or, for a notebook opened on its own, inside its own directory):
 * a link is never a way to open some other `.webnb` elsewhere on disk.
 */
async function resolveNotebookUri(sourceUri: vscode.Uri, path: string): Promise<vscode.Uri | undefined> {
    if (!path.toLowerCase().endsWith(WEBNB_FILE_EXTENSION)) {
        return undefined;
    }

    const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
    let root: vscode.Uri;
    let uri: vscode.Uri;
    if (path.startsWith('/')) {
        const workspaceRoot = folder ?? vscode.workspace.workspaceFolders?.[0];
        if (!workspaceRoot) {
            return undefined;
        }
        root = workspaceRoot.uri;
        uri = vscode.Uri.joinPath(root, path);
    } else {
        root = folder?.uri ?? vscode.Uri.joinPath(sourceUri, '..');
        uri = vscode.Uri.joinPath(sourceUri, '..', path);
    }

    return await isRealPathInside(root, uri) ? uri : undefined;
}

/** Scrolls a notebook to the cell holding a section's heading. */
function revealSection(editor: vscode.NotebookEditor, section: string, href: string): void {
    const sources = editor.notebook.getCells().map(cell =>
        cell.kind === vscode.NotebookCellKind.Markup ? cell.document.getText() : undefined);
    const cellIndex = findSectionCell(sources, section);
    if (cellIndex === undefined) {
        warnExecution('notebook link section not found href=%s section=%s', href, section);
        // Names the link as written too: a spelled-out heading arrives here
        // already slugified, and the author has to find their own text.
        void vscode.window.showWarningMessage(
            `"${editor.notebook.uri.path.split('/').pop()}" has no section called "#${section}" (from the link "${href}").`
        );
        return;
    }

    const range = new vscode.NotebookRange(cellIndex, cellIndex + 1);
    editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
    editor.selection = range;
}
