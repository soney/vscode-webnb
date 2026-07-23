// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { activate as activateSerializer, deactivate as deactivateSerializer } from './serializer';
import { activate as activateKernel, deactivate as deactivateKernel } from './webnbProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    activateSerializer(context);
    activateKernel(context);
    reopenWebnbFiles(); // For some reason, when we open .webnb files programmatically (via a payload openFile command), it doesn't properly open the file
}

// This method is called when your extension is deactivated
export function deactivate() {
    deactivateSerializer();
    deactivateKernel();
}



function reopenWebnbFiles(): void {
    const WEB_NOTEBOOK_VIEW_TYPE = 'web-notebook';
    const WEBNB_EXTENSION = '.webnb';
    const SWEEP_INTERVAL_MS = 1000;

    function checkIfOneWebnbEditorOpen(): vscode.TextEditor | vscode.NotebookEditor | undefined {
        function isWebnbFileUri(uri: vscode.Uri): boolean {
            return uri.scheme !== 'vscode-notebook-cell'
                && uri.path.toLowerCase().endsWith(WEBNB_EXTENSION);
        }

        const webnbEditors = vscode.window.visibleNotebookEditors.filter(editor => editor.notebook && isWebnbFileUri(editor.notebook.uri));
        if (webnbEditors.length === 1) {
            return webnbEditors[0];
        }

        const textEditorsWithWebnb = vscode.window.visibleTextEditors.filter(editor => isWebnbFileUri(editor.document.uri));
        if (textEditorsWithWebnb.length === 1) {
            return textEditorsWithWebnb[0];
        }

        return undefined;
    }

    function getEditorUri(editor: vscode.TextEditor | vscode.NotebookEditor): vscode.Uri | undefined {
        if ('notebook' in editor && editor.notebook) {
            return editor.notebook.uri;
        }

        if ('document' in editor) {
            return editor.document.uri;
        }

        return undefined;
    }

    // if there is just one .webnb file open, assume that it was opened programmatically. keep checking every SWEEP_INTERVAL_MS indefinitely, and once we find a single webnb editor, stop checking, close it, and reopen it as a web notebook.

    const sweepInterval: NodeJS.Timeout = setInterval(async () => {
        const editor = checkIfOneWebnbEditorOpen();
        if (editor) {
            const uri = getEditorUri(editor);
            if (!uri) {
                return;
            }

            const notebookUri = vscode.Uri.parse(uri.toString());

            // stop sweeping since we found the single editor
            clearInterval(sweepInterval);

            console.log(`[webnb] Found a single open .webnb editor for ${uri.toString()}, reopening as notebook`);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            console.log(`--------------------------------------------------------------------------`);
            await vscode.commands.executeCommand('vscode.openWith', notebookUri, WEB_NOTEBOOK_VIEW_TYPE);
        }
    }, SWEEP_INTERVAL_MS);
}
