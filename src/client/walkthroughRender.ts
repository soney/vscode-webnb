/**
 * DOM rendering for walkthrough cells: steps, highlighted snippets, file links,
 * and the hover bridge that mirrors what the reader points at into the editor.
 * The walkthrough *parser* lives in walkthrough.ts (DOM-free); this is its
 * presentation half.
 */
import {
    decorateWalkthroughStep,
    describeWalkthroughSegments,
    resolveWalkthroughStep,
    toWalkthroughSnapshotKey,
    type ParsedWalkthrough,
    type WalkthroughRange,
    type WalkthroughStep
} from './walkthrough';
import {
    detectHighlightLanguage,
    highlightToLines,
    isPlainLanguageName,
    resolveHighlightLanguage
} from './syntaxHighlight';
import { renderMarkdownBlock, renderMarkdownInline } from './markdown';
import type { WorkspaceFileSnapshotEntry } from '../shared/protocol';

function createWalkthroughMessage(markdown: string, kind: 'info' | 'warning' | 'error'): HTMLElement {
    const message = document.createElement('div');
    message.classList.add('walkthrough-message', kind);
    message.innerHTML = renderMarkdownInline(markdown);
    return message;
}

/**
 * What a walkthrough can do beyond rendering, when the renderer can reach the
 * extension host. Both are absent in the preview harness and in plain webviews.
 */
export interface WalkthroughInteractions {
    openFile?: (path: string, line?: number) => void;
    /** Mirrors what the reader is hovering into an editor that has the file open. */
    hover?: WalkthroughHoverBridge;
}

/**
 * What the reader is pointing at: the step's shown ranges, plus the one line
 * under the pointer when they are over the code itself.
 */
export interface WalkthroughHoverFocus {
    path: string;
    ranges: WalkthroughRange[];
    line?: number;
}

export interface WalkthroughHoverBridge {
    /** Reports what the pointer is on now; the last report wins. */
    enter(focus: WalkthroughHoverFocus): void;
    leave(): void;
    dispose(): void;
}

/** How long the pointer rests before the editor follows it. */
const WALKTHROUGH_HOVER_DELAY_MS = 120;

/**
 * Debounces hover reports to the extension host. Sweeping the pointer down a
 * walkthrough should not send one message — and one editor scroll — per line or
 * per step it crosses on the way.
 */
export function createWalkthroughHoverBridge(
    send: (focus?: WalkthroughHoverFocus) => void
): WalkthroughHoverBridge {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focus: WalkthroughHoverFocus | undefined;
    let sent: string | undefined;

    const describe = (candidate?: WalkthroughHoverFocus): string => candidate
        ? `${candidate.path}|${candidate.ranges.map(range => `${range.start}-${range.end}`).join(',')}|${candidate.line ?? ''}`
        : '';

    const schedule = (next?: WalkthroughHoverFocus) => {
        focus = next;
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            const key = describe(focus);
            if (key === sent) {
                return;
            }
            sent = key;
            send(focus);
        }, WALKTHROUGH_HOVER_DELAY_MS);
    };

    return {
        enter(next) {
            schedule(next);
        },
        leave() {
            schedule();
        },
        dispose() {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            if (sent) {
                sent = undefined;
                send();
            }
        }
    };
}

/** "Open in editor" glyph: an arrow leaving a box, drawn to match codicons. */
const OPEN_FILE_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">'
    + '<path d="M9.75 2.75h3.5v3.5M13.25 2.75 8.25 7.75" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M11.75 9.5v2.75a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

/**
 * The file name shown above a snippet: a link that opens the real file when the
 * renderer can talk to the extension host, plain text otherwise.
 */
function createWalkthroughFileLink(
    path: string,
    line: number | undefined,
    openFile?: (path: string, line?: number) => void
): HTMLElement {
    const separator = path.lastIndexOf('/');
    const label = document.createElement('span');
    label.classList.add('walkthrough-file-label');
    if (separator >= 0) {
        const directory = document.createElement('span');
        directory.classList.add('walkthrough-file-directory');
        directory.textContent = path.slice(0, separator + 1);
        label.appendChild(directory);
    }
    const basename = document.createElement('span');
    basename.classList.add('walkthrough-file-basename');
    basename.textContent = path.slice(separator + 1);
    label.appendChild(basename);

    if (!openFile) {
        const plain = document.createElement('span');
        plain.classList.add('walkthrough-file-name');
        plain.appendChild(label);
        return plain;
    }

    const link = document.createElement('button');
    link.type = 'button';
    link.classList.add('walkthrough-file-name');
    const description = line === undefined
        ? `Open ${path} in the editor`
        : `Open ${path} in the editor, at line ${line}`;
    link.title = description;
    link.setAttribute('aria-label', description);
    link.appendChild(label);

    const icon = document.createElement('span');
    icon.classList.add('walkthrough-file-open-icon');
    icon.innerHTML = OPEN_FILE_ICON;
    link.appendChild(icon);

    link.addEventListener('click', () => openFile(path, line));
    return link;
}

/** The line number beside a snippet line; clickable when the file can be opened. */
function createWalkthroughLineNumber(
    lineNumber: number,
    path: string,
    openFile?: (path: string, line?: number) => void
): HTMLElement {
    if (!openFile) {
        const gutter = document.createElement('span');
        gutter.classList.add('walkthrough-line-number');
        gutter.textContent = `${lineNumber}`;
        return gutter;
    }

    const gutter = document.createElement('button');
    gutter.type = 'button';
    gutter.classList.add('walkthrough-line-number');
    const description = `Open ${path} in the editor, at line ${lineNumber}`;
    gutter.title = description;
    gutter.setAttribute('aria-label', description);
    gutter.textContent = `${lineNumber}`;
    // The header link already reaches this file from the keyboard, so the
    // gutter stays out of the tab order instead of making every shown line a
    // tab stop.
    gutter.tabIndex = -1;
    gutter.addEventListener('click', () => openFile(path, lineNumber));
    return gutter;
}

/** Highlighted HTML per line (indexed by `lineNumber - 1`) for a step's file. */
function highlightWalkthroughFile(
    path: string,
    language: string | undefined,
    content: string,
    cache: Map<string, string[] | undefined>
): string[] | undefined {
    if (!language) {
        return undefined;
    }

    // Steps of one walkthrough often revisit the same file, and highlighting it
    // is by far the most expensive thing this renderer does per step.
    const key = `${language} ${toWalkthroughSnapshotKey(path)}`;
    if (!cache.has(key)) {
        cache.set(key, highlightToLines(content, language));
    }
    return cache.get(key);
}

function renderWalkthroughStep(
    step: WalkthroughStep,
    index: number,
    showStepNumbers: boolean,
    files: Record<string, WorkspaceFileSnapshotEntry>,
    highlightCache: Map<string, string[] | undefined>,
    interactions: WalkthroughInteractions
): HTMLElement {
    const { openFile, hover } = interactions;
    const stepEl = document.createElement('section');
    stepEl.classList.add('walkthrough-step');

    if (step.title || showStepNumbers) {
        const header = document.createElement('div');
        header.classList.add('walkthrough-step-header');
        if (showStepNumbers) {
            const badge = document.createElement('span');
            badge.classList.add('walkthrough-step-number');
            badge.textContent = `${index + 1}`;
            header.appendChild(badge);
        }
        if (step.title) {
            const title = document.createElement('span');
            title.classList.add('walkthrough-step-title');
            title.innerHTML = renderMarkdownInline(step.title);
            header.appendChild(title);
        }
        stepEl.appendChild(header);
    }

    if (step.commentary) {
        const commentary = document.createElement('div');
        commentary.classList.add('walkthrough-commentary');
        commentary.innerHTML = renderMarkdownBlock(step.commentary);
        stepEl.appendChild(commentary);
    }

    if (!step.file) {
        stepEl.appendChild(createWalkthroughMessage('This step needs a `file:` line pointing at a workspace file.', 'error'));
        return stepEl;
    }

    const snapshot = files[toWalkthroughSnapshotKey(step.file)];
    if (!snapshot) {
        stepEl.appendChild(createWalkthroughMessage(`Could not load \`${step.file}\` — run the cell again to snapshot it.`, 'error'));
        return stepEl;
    }
    if (!snapshot.exists) {
        // A path the kernel refused (a `..` segment, an absolute path) comes
        // back with its reason; only a missing file gets the not-found hint.
        stepEl.appendChild(createWalkthroughMessage(snapshot.error
            ? `\`${step.file}\`: ${snapshot.error}`
            : `\`${step.file}\` was not found. Paths are relative to the notebook file; use a \`workspace:\` prefix to resolve from the workspace root.`, 'error'));
        return stepEl;
    }
    if (snapshot.type === 'directory') {
        stepEl.appendChild(createWalkthroughMessage(`\`${step.file}\` is a directory. Point the step at a file instead.`, 'error'));
        return stepEl;
    }
    if (typeof snapshot.content !== 'string') {
        stepEl.appendChild(createWalkthroughMessage(snapshot.error || `Could not read the contents of \`${step.file}\`.`, 'error'));
        return stepEl;
    }

    const resolved = resolveWalkthroughStep(step, snapshot.content);
    for (const warning of resolved.warnings) {
        stepEl.appendChild(createWalkthroughMessage(warning, 'warning'));
    }
    if (resolved.error) {
        stepEl.appendChild(createWalkthroughMessage(resolved.error, 'error'));
        return stepEl;
    }

    const language = step.language
        ? resolveHighlightLanguage(step.language)
        : detectHighlightLanguage(step.file);
    if (step.language && !language && !isPlainLanguageName(step.language)) {
        stepEl.appendChild(createWalkthroughMessage(
            `\`language: ${step.language}\` is not a language this notebook can highlight; showing the snippet as plain text.`,
            'warning'
        ));
    }

    const decorated = decorateWalkthroughStep(step, resolved.segments);
    const highlightedLines = highlightWalkthroughFile(step.file, language, snapshot.content, highlightCache);
    const firstShownLine = resolved.segments.find(segment => segment.lines.length > 0)?.lines[0]?.number;

    const panel = document.createElement('figure');
    panel.classList.add('walkthrough-code');

    const codeHeader = document.createElement('figcaption');
    codeHeader.classList.add('walkthrough-code-header');
    codeHeader.appendChild(createWalkthroughFileLink(step.file, firstShownLine, openFile));

    const rangeParts: string[] = [];
    if (step.region) {
        rangeParts.push(`\`${step.region}\``);
    }
    const segmentSummary = describeWalkthroughSegments(resolved.segments);
    if (segmentSummary) {
        rangeParts.push(segmentSummary);
    }
    if (rangeParts.length > 0) {
        const rangeEl = document.createElement('span');
        rangeEl.classList.add('walkthrough-code-range');
        rangeEl.innerHTML = renderMarkdownInline(rangeParts.join(' · '));
        codeHeader.appendChild(rangeEl);
    }
    panel.appendChild(codeHeader);

    const hasLines = resolved.segments.some(segment => segment.lines.length > 0);
    if (!hasLines) {
        panel.appendChild(createWalkthroughMessage('There are no lines to show for this step.', 'warning'));
        stepEl.appendChild(panel);
        return stepEl;
    }

    const maxLineNumber = Math.max(...resolved.segments.flatMap(segment => segment.lines.map(line => line.number)));
    const codeBody = document.createElement('div');
    codeBody.classList.add('walkthrough-code-lines');
    codeBody.style.setProperty('--walkthrough-gutter-width', `${String(maxLineNumber).length}ch`);
    // The rows live in their own box so it can size to the longest line: row
    // backgrounds then span the whole scrollable width, not just their own text.
    const codeRows = document.createElement('div');
    codeRows.classList.add('walkthrough-code-rows');

    resolved.segments.forEach((segment, segmentIndex) => {
        if (segment.lines.length === 0) {
            return;
        }
        if (segmentIndex > 0) {
            const ellipsis = document.createElement('div');
            ellipsis.classList.add('walkthrough-ellipsis');
            ellipsis.textContent = '⋯';
            codeRows.appendChild(ellipsis);
        }

        for (const line of segment.lines) {
            const decoration = decorated.byLine.get(line.number);
            const row = document.createElement('div');
            row.classList.add('walkthrough-line');
            if (decoration?.highlight) {
                row.classList.add('highlighted');
            }

            row.dataset.line = `${line.number}`;

            const gutter = createWalkthroughLineNumber(line.number, step.file!, openFile);

            const text = document.createElement('span');
            text.classList.add('walkthrough-line-text');
            const highlighted = highlightedLines?.[line.number - 1];
            if (highlighted === undefined) {
                text.textContent = line.text;
            } else {
                text.innerHTML = highlighted;
            }

            row.append(gutter, text);
            codeRows.appendChild(row);

            for (const note of decoration?.notes ?? []) {
                const noteEl = document.createElement('div');
                noteEl.classList.add('walkthrough-note');
                noteEl.innerHTML = renderMarkdownBlock(note);
                codeRows.appendChild(noteEl);
            }
        }
    });

    if (hover) {
        // Pointing anywhere in the step marks everything it shows; pointing at a
        // line narrows that to the line.
        const focus: WalkthroughHoverFocus = {
            path: step.file,
            ranges: resolved.segments
                .filter(segment => segment.lines.length > 0)
                .map(segment => ({
                    start: segment.lines[0].number,
                    end: segment.lines[segment.lines.length - 1].number
                }))
        };
        stepEl.addEventListener('mouseenter', () => hover.enter(focus));
        stepEl.addEventListener('mouseleave', () => hover.leave());
        codeRows.addEventListener('mouseover', event => {
            const row = (event.target as HTMLElement | null)?.closest?.('.walkthrough-line');
            const line = row instanceof HTMLElement ? Number(row.dataset.line) : NaN;
            if (Number.isFinite(line)) {
                hover.enter({ ...focus, line });
            }
        });
        // Off the code but still in the step: back to the whole region.
        codeRows.addEventListener('mouseleave', () => hover.enter(focus));
    }

    codeBody.appendChild(codeRows);
    panel.appendChild(codeBody);
    stepEl.appendChild(panel);

    for (const orphan of decorated.orphanNotes) {
        const noteEl = document.createElement('div');
        noteEl.classList.add('walkthrough-note', 'walkthrough-note-orphan');
        noteEl.innerHTML = renderMarkdownBlock(`${orphan.label} (not shown): ${orphan.text}`);
        stepEl.appendChild(noteEl);
    }

    return stepEl;
}

export function renderParsedWalkthrough(
    container: HTMLElement,
    parsed: ParsedWalkthrough,
    files: Record<string, WorkspaceFileSnapshotEntry>,
    interactions: WalkthroughInteractions
): void {
    const wrapper = document.createElement('div');
    wrapper.classList.add('walkthrough');

    if (parsed.title) {
        const title = document.createElement('div');
        title.classList.add('walkthrough-title');
        title.innerHTML = renderMarkdownInline(parsed.title);
        wrapper.appendChild(title);
    }

    if (parsed.intro) {
        const intro = document.createElement('div');
        intro.classList.add('walkthrough-commentary', 'walkthrough-intro');
        intro.innerHTML = renderMarkdownBlock(parsed.intro);
        wrapper.appendChild(intro);
    }

    for (const error of parsed.errors) {
        wrapper.appendChild(createWalkthroughMessage(error, 'error'));
    }

    if (parsed.steps.length === 0) {
        wrapper.appendChild(createWalkthroughMessage('Add a `file:` line (plus optional `region:` or `lines:`) to show code from the workspace.', 'info'));
    }

    const showStepNumbers = parsed.steps.length > 1;
    const highlightCache = new Map<string, string[] | undefined>();
    parsed.steps.forEach((step, index) => {
        wrapper.appendChild(renderWalkthroughStep(step, index, showStepNumbers, files, highlightCache, interactions));
    });

    container.appendChild(wrapper);
}
