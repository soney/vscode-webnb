import * as vscode from 'vscode';
import { activate as activateSerializer, deactivate as deactivateSerializer } from './serializer';
import { activate as activateKernel, deactivate as deactivateKernel } from './webnbProvider';
import { activate as activateCellStructureLock, deactivate as deactivateCellStructureLock } from './cellStructureLock';
import { activate as activateDefaultCapture, deactivate as deactivateDefaultCapture } from './defaultCapture';
import { activate as activateMarkdownLock, deactivate as deactivateMarkdownLock } from './markdownLock';
import { activate as activateNotebookLinks, deactivate as deactivateNotebookLinks } from './notebookLinkNavigator';
import { activate as activateReadOnlyMode, deactivate as deactivateReadOnlyMode } from './readOnlyMode';
import { WebnbTextReopener } from './reopenAsNotebook';

export function activate(context: vscode.ExtensionContext) {
    activateSerializer(context);
    activateKernel(context);
    activateCellStructureLock(context);
    activateDefaultCapture(context);
    activateMarkdownLock(context);
    activateNotebookLinks(context);
    activateReadOnlyMode(context);
    // Files opened programmatically (the lab launcher's openFile) open as text;
    // for a short while after activation, reopen those with the notebook editor.
    context.subscriptions.push(new WebnbTextReopener());
}

export function deactivate() {
    deactivateSerializer();
    deactivateKernel();
    deactivateCellStructureLock();
    deactivateDefaultCapture();
    deactivateMarkdownLock();
    deactivateNotebookLinks();
    deactivateReadOnlyMode();
}
