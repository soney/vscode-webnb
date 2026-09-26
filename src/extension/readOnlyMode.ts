import * as vscode from 'vscode';
import { errorExecution } from './log';

const CONFIG_SECTION = 'webnb';
const READ_ONLY_SETTING = 'readOnly';
const FILES_SECTION = 'files';
const READONLY_INCLUDE_SETTING = 'readonlyInclude';
/** The one entry this module manages in `files.readonlyInclude`; everything else there is left alone. */
const WEBNB_GLOB = '**/*.webnb';
/** Memento key recording that this extension, not the user, put the glob into that scope's settings. */
const OWNERSHIP_KEY = 'webnb.readOnly.addedReadonlyInclude';

type SettingsScope = 'global' | 'workspace';

/** What this extension added to a scope's `files.readonlyInclude`, and what the glob was before. */
interface AddedEntry {
    /** The glob's value before it was set to true; absent when it was not in the setting at all. */
    previous?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new ReadOnlyMode({ global: context.globalState, workspace: context.workspaceState }));
}

export function deactivate() { }

/**
 * Makes Web Notebooks fully read-only when `webnb.readOnly` is on.
 *
 * Nothing in the extension API marks a `file:` resource read-only, so this mirrors the
 * setting onto VS Code's own `files.readonlyInclude`, which is what actually flips the
 * editor. That is a real write to settings.json, so it is kept as narrow as it can be:
 * - The glob goes in the scope `webnb.readOnly` is set in. A user-level setting gets a
 *   user-level glob; a workspace setting (a course folder's .vscode/settings.json) gets a
 *   workspace glob. Opening an unrelated folder never writes into it.
 * - Turning the setting off removes only a glob this extension added -- recorded in the
 *   matching Memento -- and puts back whatever value it replaced. A `**\/*.webnb` entry
 *   the user wrote by hand is theirs, and is never touched.
 *
 * This is a much heavier lock than the one in `cellStructureLock`: a read-only notebook
 * cannot be edited at all, and nothing the notebook records -- cell outputs, or the metadata
 * that holds a multiple choice answer -- can be written back to the file. Prefer
 * `webnb.lockCellStructure` unless a notebook is meant purely for reading.
 */
export class ReadOnlyMode implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    /** Serializes syncs, so two configuration events cannot interleave their writes. */
    private _chain: Promise<void> = Promise.resolve();

    public constructor(private readonly _state: Record<SettingsScope, vscode.Memento>) {
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.${READ_ONLY_SETTING}`)) {
                    void this.sync();
                }
            }),
            // A folder opening or closing changes which workspace settings apply.
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync())
        );

        void this.sync();
    }

    public dispose(): void {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables.length = 0;
    }

    /** Brings `files.readonlyInclude` in line with `webnb.readOnly`; resolves when done. */
    public sync(): Promise<void> {
        this._chain = this._chain.then(() => this._sync());
        return this._chain;
    }

    private async _sync(): Promise<void> {
        // `webnb.readOnly` is window-scoped, so it lives in user or workspace
        // settings, and the workspace value wins when both are set.
        const inspected = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<boolean>(READ_ONLY_SETTING);
        const scope: SettingsScope | undefined = inspected?.workspaceValue !== undefined
            ? 'workspace'
            : inspected?.globalValue !== undefined ? 'global' : undefined;
        const readOnly = scope === 'workspace' ? inspected?.workspaceValue === true
            : scope === 'global' ? inspected?.globalValue === true
                : false;

        for (const target of ['global', 'workspace'] as const) {
            await this._syncScope(target, readOnly && target === scope);
        }
    }

    private async _syncScope(target: SettingsScope, wanted: boolean): Promise<void> {
        const memento = this._state[target];
        const added = memento.get<AddedEntry>(OWNERSHIP_KEY);
        const filesConfig = vscode.workspace.getConfiguration(FILES_SECTION);
        const inspected = filesConfig.inspect<Record<string, boolean>>(READONLY_INCLUDE_SETTING);
        const current = (target === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue) ?? {};
        const configurationTarget = target === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        if (wanted) {
            if (current[WEBNB_GLOB] === true) {
                // Already read-only here, by this extension or by the user.
                return;
            }
            // Ownership is recorded before the write, so a write that lands is
            // never orphaned; one that fails is disowned again below.
            const entry: AddedEntry = typeof current[WEBNB_GLOB] === 'boolean' ? { previous: current[WEBNB_GLOB] } : {};
            await memento.update(OWNERSHIP_KEY, entry);
            if (!await this._write(filesConfig, { ...current, [WEBNB_GLOB]: true }, configurationTarget)) {
                await memento.update(OWNERSHIP_KEY, undefined);
            }
            return;
        }

        if (!added) {
            // Nothing of ours in this scope. A glob here is the user's own.
            return;
        }
        await memento.update(OWNERSHIP_KEY, undefined);
        if (current[WEBNB_GLOB] !== true) {
            // Already gone (or changed) by hand; nothing to undo.
            return;
        }

        const next: Record<string, boolean> = { ...current };
        if (typeof added.previous === 'boolean') {
            next[WEBNB_GLOB] = added.previous;
        } else {
            delete next[WEBNB_GLOB];
        }
        // Dropping the last entry writes `undefined` so the key leaves settings.json
        // rather than lingering as an empty object.
        await this._write(filesConfig, Object.keys(next).length > 0 ? next : undefined, configurationTarget);
    }

    private async _write(
        filesConfig: vscode.WorkspaceConfiguration,
        value: Record<string, boolean> | undefined,
        target: vscode.ConfigurationTarget
    ): Promise<boolean> {
        try {
            await filesConfig.update(READONLY_INCLUDE_SETTING, value, target);
            return true;
        } catch (error) {
            errorExecution('Could not mirror %s.%s onto %s.%s: %s',
                CONFIG_SECTION, READ_ONLY_SETTING, FILES_SECTION, READONLY_INCLUDE_SETTING, String(error));
            return false;
        }
    }
}
