import * as vscode from 'vscode';
import { GSFS } from './gsfs';

declare const navigator: unknown;

export async function activate(context: vscode.ExtensionContext) {
	if (typeof navigator === 'object') { // do not run under node.js
		const gsfs = enableFs(context);
		gsfs.seed();
		const searchLocation: string = await vscode.commands.executeCommand('gamma-samples-extension.location', 'get', 'search') as string;

		const params = new URLSearchParams(searchLocation);
		if (params.has('path')) {
			const path = params.get('path');
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`gsfs:/samples/${path}`));
		} else {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`gsfs:/samples/README.dpage`));
		}

		if (params.has('oaikey')) {
			const apiKey = params.get('oaikey');
			const gammaConfig = vscode.workspace.getConfiguration('gamma');
			gammaConfig.update('apiKey', apiKey, vscode.ConfigurationTarget.Workspace);
		}
		vscode.workspace.getConfiguration("workbench.statusBar").update("visible", false);
	}
}

function enableFs(context: vscode.ExtensionContext): GSFS {
	const gsfs = new GSFS();
	context.subscriptions.push(gsfs);

	return gsfs;
}