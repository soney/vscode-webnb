/**
 * Virtual filesystem overlay — the "fake filesystem".
 *
 * Disk (served read-only by the dev server) is the base layer. This overlay
 * holds every file the user creates or edits *in the browser*. Reads fall
 * through: overlay first, then disk. Writes never leave the browser; they live
 * in localStorage so they survive reloads.
 *
 * Paths are workspace-relative, posix, with no leading/trailing slash.
 */
import type { WorkspaceFileSnapshotEntry } from './types';

type VfsNode =
    | { kind: 'file'; content: string }
    | { kind: 'dir' }
    | { kind: 'deleted' };

const STORAGE_PREFIX = 'webnb:vfs:v1:';

export function normalizeVfsPath(p: string): string {
    return p.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/');
}

/**
 * Resolve a path the user typed (the way a notebook author writes a file check)
 * into the workspace-relative key the overlay uses. Mirrors the dev server's
 * resolution: `workspace:` paths are workspace-relative, everything else is
 * relative to the current notebook's directory.
 */
export function resolveAgainstNotebook(notebookDir: string, typed: string): string {
    const trimmed = typed.trim().replace(/\\/g, '/');
    const workspaceScoped = trimmed.match(/^workspace\s*:\s*(.*)$/i);
    if (workspaceScoped) {
        return normalizeVfsPath(workspaceScoped[1]);
    }
    const norm = normalizeVfsPath(trimmed);
    if (!norm) { return ''; }
    return notebookDir ? normalizeVfsPath(`${notebookDir}/${norm}`) : norm;
}

function parentOf(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx < 0 ? '' : p.slice(0, idx);
}

function baseName(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx < 0 ? p : p.slice(idx + 1);
}

export interface VfsFileListing {
    path: string;
    type: 'file' | 'directory';
}

export class VirtualFs {
    private nodes = new Map<string, VfsNode>();
    private readonly storageKey: string;
    private listeners = new Set<() => void>();

    constructor(workspaceId: string) {
        this.storageKey = STORAGE_PREFIX + workspaceId;
        this.load();
    }

    // ---- persistence -------------------------------------------------------

    private load(): void {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) { return; }
            const data = JSON.parse(raw) as Record<string, VfsNode>;
            this.nodes = new Map(Object.entries(data));
        } catch {
            this.nodes = new Map();
        }
    }

    private save(): void {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.nodes)));
        } catch {
            // Storage full / unavailable — overlay still works in-memory this session.
        }
    }

    // ---- change notification ----------------------------------------------

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        this.save();
        for (const listener of this.listeners) {
            listener();
        }
    }

    // ---- mutation ----------------------------------------------------------

    writeFile(rawPath: string, content: string): void {
        const p = normalizeVfsPath(rawPath);
        if (!p) { return; }
        // Clear any tombstone on an ancestor so the new file is visible.
        this.unmaskAncestors(p);
        this.nodes.set(p, { kind: 'file', content });
        this.emit();
    }

    makeDir(rawPath: string): void {
        const p = normalizeVfsPath(rawPath);
        if (!p) { return; }
        this.unmaskAncestors(p);
        this.nodes.set(p, { kind: 'dir' });
        this.emit();
    }

    /**
     * Ancestor directories are inferred from child paths (see hasOverlayChildren),
     * so we don't store nodes for them — but we must lift any ancestor tombstone
     * that would otherwise mask the new path.
     */
    private unmaskAncestors(p: string): void {
        let dir = parentOf(p);
        while (dir) {
            if (this.nodes.get(dir)?.kind === 'deleted') {
                this.nodes.delete(dir);
            }
            dir = parentOf(dir);
        }
    }

    /** Remove an overlay path and mask any disk version of it (and its subtree). */
    remove(rawPath: string): void {
        const p = normalizeVfsPath(rawPath);
        if (!p) { return; }
        // Drop overlay descendants.
        for (const key of Array.from(this.nodes.keys())) {
            if (key === p || key.startsWith(p + '/')) {
                this.nodes.delete(key);
            }
        }
        // Tombstone so a disk version (if any) is hidden too.
        this.nodes.set(p, { kind: 'deleted' });
        this.emit();
    }

    /** Forget any overlay edits for this exact path (revert to disk). */
    revert(rawPath: string): void {
        const p = normalizeVfsPath(rawPath);
        for (const key of Array.from(this.nodes.keys())) {
            if (key === p || key.startsWith(p + '/')) {
                this.nodes.delete(key);
            }
        }
        this.emit();
    }

    clearAll(): void {
        this.nodes.clear();
        this.emit();
    }

    // ---- queries -----------------------------------------------------------

    private isMaskedByDeletedAncestor(p: string): boolean {
        let dir = parentOf(p);
        while (dir) {
            if (this.nodes.get(dir)?.kind === 'deleted') { return true; }
            dir = parentOf(dir);
        }
        return false;
    }

    private directChildren(dirPath: string): Map<string, 'file' | 'directory'> {
        const children = new Map<string, 'file' | 'directory'>();
        const prefix = dirPath ? dirPath + '/' : '';
        for (const [key, node] of this.nodes) {
            if (node.kind === 'deleted') { continue; }
            if (!key.startsWith(prefix) || key === dirPath) { continue; }
            const rest = key.slice(prefix.length);
            if (!rest) { continue; }
            const slashIdx = rest.indexOf('/');
            if (slashIdx < 0) {
                // Direct child.
                children.set(rest, node.kind === 'file' ? 'file' : 'directory');
            } else {
                // Indirect descendant implies an intermediate directory.
                const childName = rest.slice(0, slashIdx);
                if (!children.has(childName)) {
                    children.set(childName, 'directory');
                }
            }
        }
        return children;
    }

    private hasOverlayChildren(dirPath: string): boolean {
        const prefix = dirPath ? dirPath + '/' : '';
        for (const [key, node] of this.nodes) {
            if (node.kind === 'deleted') { continue; }
            if (key !== dirPath && key.startsWith(prefix)) { return true; }
        }
        return false;
    }

    /**
     * Apply the overlay on top of a disk snapshot entry. The returned entry keeps
     * the original request `path` (what the notebook author wrote) so feedback
     * messages match the extension exactly.
     */
    mergeSnapshot(diskEntry: WorkspaceFileSnapshotEntry): WorkspaceFileSnapshotEntry {
        const requestPath = diskEntry.path;
        const resolved = diskEntry.resolvedPath;
        if (resolved === undefined) {
            return diskEntry;
        }
        const norm = normalizeVfsPath(resolved);

        if (this.nodes.get(norm)?.kind === 'deleted' || this.isMaskedByDeletedAncestor(norm)) {
            return { path: requestPath, resolvedPath: resolved, exists: false };
        }

        const node = this.nodes.get(norm);
        if (node?.kind === 'file') {
            return {
                path: requestPath,
                resolvedPath: resolved,
                exists: true,
                type: 'file',
                content: node.content,
                size: node.content.length
            };
        }

        const isDir = node?.kind === 'dir' || diskEntry.type === 'directory' || this.hasOverlayChildren(norm);
        if (isDir) {
            const merged = new Map<string, string>();
            if (diskEntry.type === 'directory' && diskEntry.entries) {
                for (const entry of diskEntry.entries) {
                    const childPath = norm ? `${norm}/${entry.name}` : entry.name;
                    if (this.nodes.get(childPath)?.kind === 'deleted') { continue; }
                    merged.set(entry.name, entry.type);
                }
            }
            for (const [name, type] of this.directChildren(norm)) {
                merged.set(name, type);
            }
            return {
                path: requestPath,
                resolvedPath: resolved,
                exists: true,
                type: 'directory',
                entries: Array.from(merged, ([name, type]) => ({ name, type }))
            };
        }

        // No overlay for this path: defer to disk exactly as the extension would.
        return diskEntry;
    }

    /** Flat listing of everything the overlay holds, for the Virtual Files panel. */
    listAll(): VfsFileListing[] {
        const out: VfsFileListing[] = [];
        for (const [key, node] of this.nodes) {
            if (node.kind === 'file') {
                out.push({ path: key, type: 'file' });
            } else if (node.kind === 'dir') {
                out.push({ path: key, type: 'directory' });
            }
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    listDeleted(): string[] {
        const out: string[] = [];
        for (const [key, node] of this.nodes) {
            if (node.kind === 'deleted') { out.push(key); }
        }
        return out.sort();
    }

    readOverlayFile(rawPath: string): string | undefined {
        const node = this.nodes.get(normalizeVfsPath(rawPath));
        return node?.kind === 'file' ? node.content : undefined;
    }

    isEmpty(): boolean {
        return this.nodes.size === 0;
    }

    fileName(p: string): string {
        return baseName(p);
    }
}
