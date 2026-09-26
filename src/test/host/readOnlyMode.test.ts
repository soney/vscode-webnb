import './tdd';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReadOnlyMode } from '../../extension/readOnlyMode';
import * as stub from './vscodeStub';

const KEY = 'files.readonlyInclude';
const GLOB = '**/*.webnb';

suite('extension/readOnlyMode', () => {
    setup(() => stub.resetStub());

    function create(): ReadOnlyMode {
        return new ReadOnlyMode({
            global: stub.testing.globalState as unknown as vscode.Memento,
            workspace: stub.testing.workspaceState as unknown as vscode.Memento
        });
    }

    function user(): Record<string, boolean> | undefined {
        return stub.testing.config.values.globalValue[KEY] as Record<string, boolean> | undefined;
    }

    function workspaceSetting(): Record<string, boolean> | undefined {
        return stub.testing.config.values.workspaceValue[KEY] as Record<string, boolean> | undefined;
    }

    async function changeReadOnly(scope: 'globalValue' | 'workspaceValue', value: boolean | undefined, mode: ReadOnlyMode): Promise<void> {
        if (value === undefined) {
            delete stub.testing.config.values[scope]['webnb.readOnly'];
        } else {
            stub.testing.config.values[scope]['webnb.readOnly'] = value;
        }
        stub.testing.emitters.changeConfiguration.fire({ affectsConfiguration: (key: string) => key === 'webnb.readOnly' });
        await mode.sync();
    }

    test('a user-level setting writes the glob to user settings, never into an opened folder', async () => {
        stub.testing.config.values.globalValue['webnb.readOnly'] = true;
        stub.workspace.workspaceFolders = [{ uri: stub.Uri.file('/home/u/unrelated'), name: 'unrelated', index: 0 }];
        const mode = create();
        await mode.sync();
        assert.deepStrictEqual(user(), { [GLOB]: true });
        assert.strictEqual(workspaceSetting(), undefined);

        await changeReadOnly('globalValue', false, mode);
        assert.strictEqual(user(), undefined, 'the glob this extension added is removed');
        mode.dispose();
    });

    test('a workspace-level setting writes the glob to workspace settings and removes it cleanly', async () => {
        stub.workspace.workspaceFolders = [{ uri: stub.Uri.file('/home/u/course'), name: 'course', index: 0 }];
        stub.testing.config.values.workspaceValue[KEY] = { 'secret/**': true };
        stub.testing.config.values.workspaceValue['webnb.readOnly'] = true;
        const mode = create();
        await mode.sync();
        assert.deepStrictEqual(workspaceSetting(), { 'secret/**': true, [GLOB]: true });
        assert.strictEqual(user(), undefined);

        await changeReadOnly('workspaceValue', undefined, mode);
        assert.deepStrictEqual(workspaceSetting(), { 'secret/**': true });
        mode.dispose();
    });

    test('a hand-written glob is never removed', async () => {
        stub.testing.config.values.workspaceValue[KEY] = { [GLOB]: true, 'secret/**': true };
        const mode = create();
        await mode.sync();
        await changeReadOnly('workspaceValue', true, mode);
        await changeReadOnly('workspaceValue', false, mode);
        assert.deepStrictEqual(workspaceSetting(), { [GLOB]: true, 'secret/**': true });
        assert.strictEqual(stub.testing.config.writes.length, 0);
        mode.dispose();
    });

    test('an explicit false the glob had is put back when read-only mode ends', async () => {
        stub.testing.config.values.globalValue[KEY] = { [GLOB]: false };
        const mode = create();
        await changeReadOnly('globalValue', true, mode);
        assert.deepStrictEqual(user(), { [GLOB]: true });
        await changeReadOnly('globalValue', false, mode);
        assert.deepStrictEqual(user(), { [GLOB]: false });
        mode.dispose();
    });

    test('moving the setting from user to workspace scope moves the glob with it', async () => {
        const mode = create();
        await changeReadOnly('globalValue', true, mode);
        assert.deepStrictEqual(user(), { [GLOB]: true });
        stub.testing.config.values.workspaceValue['webnb.readOnly'] = true;
        await changeReadOnly('globalValue', undefined, mode);
        assert.strictEqual(user(), undefined);
        assert.deepStrictEqual(workspaceSetting(), { [GLOB]: true });
        mode.dispose();
    });
});
