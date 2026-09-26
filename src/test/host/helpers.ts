/**
 * Shared scaffolding for the extension-host tests: opening a fake notebook
 * from .webnb text through the real serializer, and waiting for the host
 * modules' timers and promise chains.
 */
import * as stub from './vscodeStub';
import { deserializeWebnb, serializeWebnb } from '../../extension/serializer';

export const NOTEBOOK_URI = stub.Uri.file('/ws/lesson.webnb');
export const WORKSPACE_FOLDER = { uri: stub.Uri.file('/ws'), name: 'ws', index: 0 };

export function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Lets pending timers of 0 ms and promise chains run. */
export async function settle(rounds = 5): Promise<void> {
    for (let round = 0; round < rounds; round++) {
        await wait(0);
    }
}

export function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

export function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

/** Opens `.webnb` text as a fake notebook, visible and active, as the host would. */
export function openNotebook(text: string, options: { uri?: stub.Uri; visible?: boolean; fireOpen?: boolean } = {}): {
    notebook: stub.FakeNotebook;
    editor: stub.FakeNotebookEditor;
} {
    const uri = options.uri ?? NOTEBOOK_URI;
    const data = deserializeWebnb(encode(text));
    const notebook = new stub.FakeNotebook(uri, data.cells.map(cell => ({
        kind: cell.kind as number as stub.NotebookCellKind,
        value: cell.value,
        languageId: cell.languageId,
        metadata: cell.metadata as Record<string, unknown>
    })));
    notebook.metadata = { ...(data.metadata ?? {}) };
    stub.workspace.notebookDocuments.push(notebook);
    const editor = new stub.FakeNotebookEditor(notebook);
    if (options.visible !== false) {
        stub.window.visibleNotebookEditors.push(editor);
        stub.window.activeNotebookEditor = editor;
    }
    if (options.fireOpen !== false) {
        stub.testing.emitters.openNotebookDocument.fire(notebook);
    }
    return { notebook, editor };
}

/** The notebook's current state as the .webnb text a save would write. */
export function saveNotebook(notebook: stub.FakeNotebook): string {
    return decode(serializeWebnb({
        metadata: notebook.metadata,
        cells: notebook.getCells().map(cell => ({
            kind: cell.kind as number,
            value: cell.document.getText(),
            languageId: cell.document.languageId,
            metadata: JSON.parse(JSON.stringify(cell.metadata))
        }))
    } as never));
}

/** Serves `files` (path -> text) through the stub's workspace.fs. */
export function serveFiles(files: Record<string, string>): void {
    stub.testing.fs.stat = async uri => {
        const text = files[uri.path];
        if (text === undefined) {
            throw new Error('ENOENT');
        }
        return { type: stub.FileType.File, size: text.length };
    };
    stub.testing.fs.readFile = async uri => {
        const text = files[uri.path];
        if (text === undefined) {
            throw new Error('ENOENT');
        }
        return encode(text);
    };
}
