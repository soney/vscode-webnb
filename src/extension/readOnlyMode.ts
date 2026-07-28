import * as vscode from 'vscode';
import { errorExecution } from './log';

const CONFIG_SECTION = 'webnb';
const READ_ONLY_SETTING = 'readOnly';
const FILES_SECTION = 'files';
const READONLY_INCLUDE_SETTING = 'readonlyInclude';
/** The one entry this module owns in `files.readonlyInclude`; everything else there is left alone. */
const WEBNB_GLOB = '**/*.webnb';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new ReadOnlyMode());
}

export function deactivate() { }

/**
 * Makes Web Notebooks fully read-only when `webnb.readOnly` is on.
 *
 * Nothing in the extension API marks a `file:` resource read-only, so this mirrors the
 * setting onto VS Code's own `files.readonlyInclude`, which is what actually flips the
 * editor. That is a real write to settings.json, so it only happens when the two have
 * drifted apart, and only ever touches this extension's own glob.
 *
 * This is a much heavier lock than the one in `cellStructureLock`: a read-only notebook
 * cannot be edited at all, and nothing the notebook records -- cell outputs, or the metadata
 * that holds a multiple choice answer -- can be written back to the file. Prefer
 * `webnb.lockCellStructure` unless a notebook is meant purely for reading.
 */
export class ReadOnlyMode implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];

    public constructor() {
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.${READ_ONLY_SETTING}`)) {
                    void this._sync();
                }
            }),
            // A folder opening or closing moves where the mirrored setting belongs.
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this._sync())
        );

        void this._sync();
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    private async _sync(): Promise<void> {
        const readOnly = vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<boolean>(READ_ONLY_SETTING, false);

        // Workspace settings travel with a course folder; without one there is nowhere to put
        // them but the user's own settings.
        const target = vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        const filesConfig = vscode.workspace.getConfiguration(FILES_SECTION);
        const inspected = filesConfig.inspect<Record<string, boolean>>(READONLY_INCLUDE_SETTING);
        const existing = (target === vscode.ConfigurationTarget.Workspace
            ? inspected?.workspaceValue
            : inspected?.globalValue) ?? {};

        if ((existing[WEBNB_GLOB] === true) === readOnly) {
            return;
        }

        const next = { ...existing };
        if (readOnly) {
            next[WEBNB_GLOB] = true;
        } else {
            delete next[WEBNB_GLOB];
        }

        try {
            // Dropping the last entry writes `undefined` so the key leaves settings.json
            // rather than lingering as an empty object.
            await filesConfig.update(
                READONLY_INCLUDE_SETTING,
                Object.keys(next).length > 0 ? next : undefined,
                target
            );
        } catch (error) {
            errorExecution('Could not mirror %s.%s onto %s.%s: %s',
                CONFIG_SECTION, READ_ONLY_SETTING, FILES_SECTION, READONLY_INCLUDE_SETTING, String(error));
        }
    }
}
