// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { activate as activateSerializer, deactivate as deactivateSerializer } from './serializer';
import { activate as activateKernel, deactivate as deactivateKernel } from './webnbProvider';

declare const window: any;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    activateSerializer(context);
    activateKernel(context);

    const config = vscode.workspace.getConfiguration("webnb");
    const autoFocus = config.get<boolean>("focusSingleFileAutomatically", false);

    if(autoFocus) {
        async function onDidChangeWorkspaceFolders() {
            const webnbFiles = await getWebNBFilesInCurrentDirectory();
            if(webnbFiles.length === 1) {
                // open the first file
                const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, webnbFiles[0]);
                // open the file
                vscode.commands.executeCommand('vscode.open', uri);
                // await vscode.workspace.openNotebookDocument(uri);

                // hide the tab bar
                // vscode.commands.executeCommand('workbench.action.toggleEditorVisibility');
                // enter zen mode
                // vscode.commands.executeCommand('workbench.action.toggleZenMode');
            }
        }
        // if a folder is already opened
        if(vscode.workspace.workspaceFolders) {
            onDidChangeWorkspaceFolders();
        } else {
            vscode.workspace.onDidChangeWorkspaceFolders(onDidChangeWorkspaceFolders);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('webnb.focusSingleFile', async () => {
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() {
    deactivateSerializer();
    deactivateKernel();
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