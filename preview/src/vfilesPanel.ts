/**
 * UI for the virtual filesystem — the place to create/edit/delete the files that
 * notebook `{external}` / `+files` checks look for. Nothing here is written to
 * disk; it all lives in the browser overlay (localStorage).
 */
import { resolveAgainstNotebook, type VirtualFs } from './vfs';

export class VFilesPanel {
    readonly element: HTMLElement;
    private readonly listEl: HTMLElement;
    private editingPath: string | null = null;
    private suppressRerender = false;
    private notebookDir = '';

    constructor(private readonly vfs: VirtualFs) {
        this.element = document.createElement('div');
        this.element.className = 'vfiles-panel';
        this.element.hidden = true;

        this.element.innerHTML = `
            <div class="vfiles-header">
                <div>
                    <div class="vfiles-title">Virtual Files</div>
                    <div class="vfiles-subtitle">A fake filesystem for exercises. Never written to disk.</div>
                </div>
                <button type="button" class="vfiles-close" aria-label="Close">✕</button>
            </div>
            <div class="vfiles-new">
                <form class="vfiles-new-file">
                    <input type="text" name="path" placeholder="path/to/new-file.html" autocomplete="off" />
                    <button type="submit">New file</button>
                </form>
                <form class="vfiles-new-dir">
                    <input type="text" name="path" placeholder="path/to/new-folder" autocomplete="off" />
                    <button type="submit">New folder</button>
                </form>
            </div>
            <div class="vfiles-list"></div>
            <div class="vfiles-footer">
                <button type="button" class="vfiles-clear">Clear all virtual files</button>
            </div>
        `;

        this.listEl = this.element.querySelector('.vfiles-list') as HTMLElement;

        this.element.querySelector('.vfiles-close')!.addEventListener('click', () => this.hide());

        const newFileForm = this.element.querySelector('.vfiles-new-file') as HTMLFormElement;
        newFileForm.addEventListener('submit', event => {
            event.preventDefault();
            const input = newFileForm.querySelector('input') as HTMLInputElement;
            const path = input.value.trim();
            if (path) {
                const resolved = resolveAgainstNotebook(this.notebookDir, path);
                this.editingPath = resolved || null;
                this.vfs.writeFile(resolved, '');
                input.value = '';
            }
        });

        const newDirForm = this.element.querySelector('.vfiles-new-dir') as HTMLFormElement;
        newDirForm.addEventListener('submit', event => {
            event.preventDefault();
            const input = newDirForm.querySelector('input') as HTMLInputElement;
            const path = input.value.trim();
            if (path) {
                this.vfs.makeDir(resolveAgainstNotebook(this.notebookDir, path));
                input.value = '';
            }
        });

        this.element.querySelector('.vfiles-clear')!.addEventListener('click', () => {
            if (confirm('Remove all virtual files? This cannot be undone.')) {
                this.vfs.clearAll();
            }
        });

        this.vfs.onChange(() => {
            if (this.suppressRerender) { return; }
            this.renderList();
        });
        this.renderList();
    }

    /** Tell the panel which notebook is active, so typed paths resolve like the author's checks. */
    setNotebookContext(notebookDir: string): void {
        this.notebookDir = notebookDir;
        const subtitle = this.element.querySelector('.vfiles-subtitle');
        if (subtitle) {
            subtitle.textContent = notebookDir
                ? `Paths are relative to ${notebookDir}/. Never written to disk.`
                : 'A fake filesystem for exercises. Never written to disk.';
        }
        if (!this.element.hidden) { this.renderList(); }
    }

    /** Display a workspace-relative key as the author would write it (relative to the notebook). */
    private displayPath(key: string): string {
        if (this.notebookDir && key.startsWith(this.notebookDir + '/')) {
            return key.slice(this.notebookDir.length + 1);
        }
        return key;
    }

    toggle(): void {
        if (this.element.hidden) { this.show(); } else { this.hide(); }
    }

    show(): void {
        this.element.hidden = false;
        this.renderList();
    }

    hide(): void {
        this.element.hidden = true;
        this.editingPath = null;
    }

    private renderList(): void {
        const items = this.vfs.listAll();
        const deleted = this.vfs.listDeleted();
        this.listEl.innerHTML = '';

        if (items.length === 0 && deleted.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'vfiles-empty';
            empty.textContent = 'No virtual files yet. Create one above to satisfy a file checklist.';
            this.listEl.append(empty);
            return;
        }

        for (const item of items) {
            this.listEl.append(this.renderRow(item.path, item.type));
        }

        for (const path of deleted) {
            const row = document.createElement('div');
            row.className = 'vfiles-row vfiles-row-deleted';
            const name = document.createElement('span');
            name.className = 'vfiles-path';
            name.textContent = `${this.displayPath(path)} (hidden)`;
            name.title = path;
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.textContent = 'Restore disk version';
            restore.addEventListener('click', () => this.vfs.revert(path));
            row.append(name, restore);
            this.listEl.append(row);
        }
    }

    private renderRow(path: string, type: 'file' | 'directory'): HTMLElement {
        const row = document.createElement('div');
        row.className = `vfiles-row vfiles-row-${type}`;

        const header = document.createElement('div');
        header.className = 'vfiles-row-header';

        const icon = document.createElement('span');
        icon.className = 'vfiles-icon';
        icon.textContent = type === 'directory' ? '📁' : '📄';

        const name = document.createElement('span');
        name.className = 'vfiles-path';
        name.textContent = this.displayPath(path);
        name.title = path;

        const actions = document.createElement('span');
        actions.className = 'vfiles-actions';

        if (type === 'file') {
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.textContent = this.editingPath === path ? 'Close' : 'Edit';
            edit.addEventListener('click', () => {
                this.editingPath = this.editingPath === path ? null : path;
                this.renderList();
            });
            actions.append(edit);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'vfiles-delete';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => {
            if (this.editingPath === path) { this.editingPath = null; }
            this.vfs.remove(path);
        });
        actions.append(remove);

        header.append(icon, name, actions);
        row.append(header);

        if (type === 'file' && this.editingPath === path) {
            const editor = document.createElement('textarea');
            editor.className = 'vfiles-editor';
            editor.spellcheck = false;
            editor.value = this.vfs.readOverlayFile(path) ?? '';
            // Live-save while typing so file checks re-run immediately. Suppress
            // our own list re-render so the textarea keeps focus; other VFS
            // listeners (notebook re-run) still fire.
            editor.addEventListener('input', () => {
                this.suppressRerender = true;
                this.vfs.writeFile(path, editor.value);
                this.suppressRerender = false;
            });
            row.append(editor);
        }

        return row;
    }
}
