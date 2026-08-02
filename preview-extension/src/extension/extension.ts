/**
 * Web Notebook Source Preview.
 *
 * A .webnb file normally opens as a notebook. This extension adds the other
 * half of authoring: the Markdown source in a text editor, and a live preview
 * of the rendered notebook beside it.
 */
import * as vscode from 'vscode';
import { isWebnb, WebnbPreviewManager } from './previewPanel';

/** The notebook type the Web Notebook extension registers for .webnb files. */
const NOTEBOOK_TYPE = 'web-notebook';
/** VS Code's built-in text editor, as "Reopen Editor With..." names it. */
const TEXT_EDITOR_VIEW_TYPE = 'default';

/** The .webnb this command should act on: an explicit argument, else what is focused. */
function targetUri(argument?: vscode.Uri): vscode.Uri | undefined {
    if (isWebnb(argument)) {
        return argument;
    }
    const activeText = vscode.window.activeTextEditor?.document.uri;
    if (isWebnb(activeText)) {
        return activeText;
    }
    const activeNotebook = vscode.window.activeNotebookEditor?.notebook.uri;
    return isWebnb(activeNotebook) ? activeNotebook : undefined;
}

function isOpenAsText(uri: vscode.Uri): boolean {
    return vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === uri.toString());
}

/** Open the document as Markdown text, in the column it is already in if possible. */
async function openAsText(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const column = vscode.window.activeNotebookEditor?.notebook.uri.toString() === uri.toString()
        ? vscode.window.activeNotebookEditor?.viewColumn
        : vscode.window.activeTextEditor?.viewColumn;
    await vscode.commands.executeCommand('vscode.openWith', uri, TEXT_EDITOR_VIEW_TYPE, {
        viewColumn: column ?? vscode.ViewColumn.One,
        preview: false
    });
    return vscode.workspace.openTextDocument(uri);
}

export function activate(context: vscode.ExtensionContext): void {
    const manager = new WebnbPreviewManager(context.extensionUri);
    context.subscriptions.push(manager);

    context.subscriptions.push(
        vscode.commands.registerCommand('webnbPreview.showPreview', async (argument?: vscode.Uri) => {
            const uri = targetUri(argument);
            if (!uri) {
                void vscode.window.showInformationMessage('Open a .webnb file to preview it.');
                return;
            }

            // Source and preview are the point, so bring the Markdown up unless
            // the author asked to keep the notebook editor.
            const wantsSource = vscode.workspace
                .getConfiguration('webnbPreview', uri)
                .get<boolean>('openSourceOnPreview', true);
            const document = wantsSource && !isOpenAsText(uri)
                ? await openAsText(uri)
                : await vscode.workspace.openTextDocument(uri);

            manager.show(document, vscode.ViewColumn.Beside);
        }),

        vscode.commands.registerCommand('webnbPreview.openSource', async (argument?: vscode.Uri) => {
            const uri = targetUri(argument);
            if (uri) {
                await openAsText(uri);
            }
        }),

        vscode.commands.registerCommand('webnbPreview.openNotebook', async (argument?: vscode.Uri) => {
            const uri = targetUri(argument);
            if (uri) {
                await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
            }
        }),

        vscode.commands.registerCommand('webnbPreview.refresh', () => {
            manager.runAll(vscode.window.activeTextEditor?.document);
        })
    );
}

export function deactivate(): void {
    // The manager is disposed through context.subscriptions.
}
