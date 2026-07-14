/**
 * Parsing and resolution logic for `{walkthrough}` cells.
 *
 * A walkthrough cell narrates snippets of a larger codebase. Its source is a
 * sequence of steps; each step points at a workspace file and selects which
 * lines to show, either with explicit `lines:` ranges or with a named
 * `#region` comment marker placed in the target file. Markdown commentary and
 * `@line:` annotations attach the narration to specific lines.
 *
 * This module is DOM-free so the renderer, the preview harness, and tests can
 * all share it.
 */

export interface WalkthroughRange {
    start: number;
    end: number;
}

export type WalkthroughAnchor =
    | { kind: 'lines'; start: number; end: number }
    | { kind: 'text'; text: string };

export interface WalkthroughAnnotation {
    anchor: WalkthroughAnchor;
    text: string;
}

export interface WalkthroughStep {
    title?: string;
    /** The path exactly as the author wrote it (trimmed). */
    file?: string;
    lines: WalkthroughRange[];
    region?: string;
    highlights: WalkthroughRange[];
    /** Markdown shown above the code. */
    commentary: string;
    annotations: WalkthroughAnnotation[];
}

export interface ParsedWalkthrough {
    title?: string;
    /** Markdown shown before the first step. */
    intro: string;
    steps: WalkthroughStep[];
    /** 0 means "do not poll for file changes". */
    watchIntervalMs: number;
    errors: string[];
}

export interface WalkthroughDisplayLine {
    /** 1-based line number in the real file. */
    number: number;
    text: string;
}

export interface WalkthroughSegment {
    lines: WalkthroughDisplayLine[];
}

export interface ResolvedWalkthroughStep {
    segments: WalkthroughSegment[];
    error?: string;
    warnings: string[];
}

export interface WalkthroughLineDecoration {
    highlight: boolean;
    /** Markdown notes rendered directly under this line. */
    notes: string[];
}

export interface DecoratedWalkthroughStep {
    byLine: Map<number, WalkthroughLineDecoration>;
    /** Annotations whose anchor is not among the displayed lines. */
    orphanNotes: { label: string; text: string }[];
}

const DEFAULT_WATCH_INTERVAL_MS = 2000;
const MIN_WATCH_INTERVAL_MS = 500;

const KEY_LINE = /^(title|step|file|lines|region|highlight|watch)\s*:\s*(.*)$/i;
const ANNOTATION_LINE = /^@\s*(?:(\d+)(?:\s*-\s*(\d+))?|"([^"]+)"|'([^']+)')\s*:\s*(.*)$/;
const ANNOTATION_CONTINUATION = /^(?:[ ]{2,}|\t)\S/;
const REGION_START = /#region\b[ \t]*(.*)$/;
const REGION_END = /#endregion\b/;

function parseRangeList(value: string): { ranges: WalkthroughRange[]; errors: string[] } {
    const ranges: WalkthroughRange[] = [];
    const errors: string[] = [];

    for (const rawPart of value.split(',')) {
        const part = rawPart.trim();
        if (!part) {
            continue;
        }

        const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!match) {
            errors.push(`Could not read the line range \`${part}\`. Use forms like \`12\` or \`10-25\`.`);
            continue;
        }

        const first = parseInt(match[1], 10);
        const second = match[2] ? parseInt(match[2], 10) : first;
        if (first < 1 || second < 1) {
            errors.push(`Line numbers start at 1, so \`${part}\` is out of range.`);
            continue;
        }

        ranges.push({ start: Math.min(first, second), end: Math.max(first, second) });
    }

    return { ranges, errors };
}

export function parseWalkthroughWatchValue(value: string): number {
    const normalized = value.trim().toLowerCase();
    if (!normalized || ['off', 'false', 'no', 'none', '0'].includes(normalized)) {
        return 0;
    }
    if (['on', 'true', 'yes'].includes(normalized)) {
        return DEFAULT_WATCH_INTERVAL_MS;
    }

    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
    if (!match) {
        return 0;
    }

    const amount = parseFloat(match[1]);
    const unit = match[2] || 's';
    const milliseconds = unit === 'ms' ? amount : unit === 'm' ? amount * 60000 : amount * 1000;
    return Math.max(MIN_WATCH_INTERVAL_MS, Math.round(milliseconds));
}

export function parseWalkthroughSource(source: string): ParsedWalkthrough {
    const parsed: ParsedWalkthrough = {
        intro: '',
        steps: [],
        watchIntervalMs: 0,
        errors: []
    };

    const introLines: string[] = [];
    let currentStep: WalkthroughStep | undefined;
    let currentCommentary: string[] = introLines;
    let openAnnotation: WalkthroughAnnotation | undefined;

    const startStep = (title?: string): WalkthroughStep => {
        if (currentStep) {
            currentStep.commentary = currentCommentary.join('\n').trim();
        }
        const step: WalkthroughStep = {
            title,
            lines: [],
            highlights: [],
            commentary: '',
            annotations: []
        };
        parsed.steps.push(step);
        currentStep = step;
        currentCommentary = [];
        return step;
    };

    const ensureStep = (): WalkthroughStep => currentStep ?? startStep();

    for (const rawLine of source.split(/\r?\n/g)) {
        const keyMatch = rawLine.match(KEY_LINE);
        if (keyMatch) {
            openAnnotation = undefined;
            const key = keyMatch[1].toLowerCase();
            const value = keyMatch[2].trim();

            if (key === 'watch') {
                parsed.watchIntervalMs = parseWalkthroughWatchValue(value);
            } else if (key === 'title') {
                if (currentStep) {
                    currentStep.title = value || currentStep.title;
                } else {
                    parsed.title = value || parsed.title;
                }
            } else if (key === 'step') {
                startStep(value || undefined);
            } else if (key === 'file') {
                if (!value) {
                    parsed.errors.push('A `file:` line needs a path.');
                } else if (currentStep && !currentStep.file) {
                    currentStep.file = value;
                } else {
                    startStep().file = value;
                }
            } else if (key === 'lines') {
                const { ranges, errors } = parseRangeList(value);
                ensureStep().lines.push(...ranges);
                parsed.errors.push(...errors);
            } else if (key === 'region') {
                if (!value) {
                    parsed.errors.push('A `region:` line needs the region name to look for.');
                } else {
                    ensureStep().region = value;
                }
            } else if (key === 'highlight') {
                const { ranges, errors } = parseRangeList(value);
                ensureStep().highlights.push(...ranges);
                parsed.errors.push(...errors);
            }
            continue;
        }

        const annotationMatch = rawLine.match(ANNOTATION_LINE);
        if (annotationMatch) {
            if (!currentStep) {
                parsed.errors.push('Annotations (`@line: note`) need a step with a `file:` line above them.');
                openAnnotation = undefined;
                continue;
            }

            let anchor: WalkthroughAnchor;
            if (annotationMatch[1]) {
                const first = parseInt(annotationMatch[1], 10);
                const second = annotationMatch[2] ? parseInt(annotationMatch[2], 10) : first;
                anchor = { kind: 'lines', start: Math.min(first, second), end: Math.max(first, second) };
            } else {
                anchor = { kind: 'text', text: annotationMatch[3] ?? annotationMatch[4] ?? '' };
            }

            openAnnotation = { anchor, text: annotationMatch[5].trim() };
            currentStep.annotations.push(openAnnotation);
            continue;
        }

        if (openAnnotation && ANNOTATION_CONTINUATION.test(rawLine)) {
            openAnnotation.text += (openAnnotation.text ? '\n' : '') + rawLine.trim();
            continue;
        }

        openAnnotation = undefined;
        currentCommentary.push(rawLine);
    }

    if (currentStep) {
        currentStep.commentary = currentCommentary.join('\n').trim();
    }
    parsed.intro = introLines.join('\n').trim();

    return parsed;
}

/**
 * Builds the snapshot-map key the kernel uses for a `file:` path. Mirrors
 * parseRequestedPathReference in webnbProvider.ts / preview fileChecks.ts.
 */
export function toWalkthroughSnapshotKey(path: string): string {
    const trimmed = path.trim().replace(/\\/g, '/');
    const workspaceScopedMatch = trimmed.match(/^workspace\s*:\s*(.*)$/i);
    if (workspaceScopedMatch) {
        return `workspace:${workspaceScopedMatch[1].trim()}`;
    }
    return trimmed;
}

/** Extracts the `file:` paths a walkthrough cell references, in source order. */
export function getWalkthroughFilePaths(source: string): string[] {
    const paths: string[] = [];
    for (const rawLine of source.split(/\r?\n/g)) {
        const match = rawLine.match(/^file\s*:\s*(.+)$/i);
        if (match && match[1].trim()) {
            paths.push(match[1].trim());
        }
    }
    return paths;
}

function stripRegionCommentTail(rest: string): string {
    return rest.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
}

function regionNameMatches(markerRest: string, name: string): boolean {
    const normalizedRest = stripRegionCommentTail(markerRest).toLowerCase();
    const normalizedName = name.trim().toLowerCase();
    if (normalizedRest === normalizedName) {
        return true;
    }
    // Allow trailing words after the name ("#region setup — middleware"), but
    // require whitespace so "setup" does not match "#region setup-extra".
    return normalizedRest.startsWith(normalizedName)
        && /\s/.test(normalizedRest.charAt(normalizedName.length));
}

function findRegion(fileLines: string[], name: string): { range: WalkthroughRange } | { error: string } {
    for (let index = 0; index < fileLines.length; index++) {
        const startMatch = fileLines[index].match(REGION_START);
        if (!startMatch || !regionNameMatches(startMatch[1], name)) {
            continue;
        }

        let depth = 1;
        for (let scan = index + 1; scan < fileLines.length; scan++) {
            if (REGION_START.test(fileLines[scan])) {
                depth++;
            } else if (REGION_END.test(fileLines[scan])) {
                depth--;
                if (depth === 0) {
                    // Show the lines between (not including) the marker comments,
                    // numbered as they appear in the real file.
                    return { range: { start: index + 2, end: scan } };
                }
            }
        }

        return { error: `Found \`#region ${name}\` but no matching \`#endregion\`.` };
    }

    return { error: `Region \`${name}\` was not found. Mark it in the file with \`#region ${name}\` … \`#endregion\` comments.` };
}

function mergeRanges(ranges: WalkthroughRange[]): WalkthroughRange[] {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: WalkthroughRange[] = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

export function resolveWalkthroughStep(step: WalkthroughStep, fileContent: string): ResolvedWalkthroughStep {
    const fileLines = fileContent.split(/\r?\n/g);
    if (fileLines.length > 1 && fileLines[fileLines.length - 1] === '') {
        fileLines.pop();
    }

    const warnings: string[] = [];
    let ranges: WalkthroughRange[];

    if (step.region) {
        const found = findRegion(fileLines, step.region);
        if ('error' in found) {
            return { segments: [], error: found.error, warnings };
        }
        if (step.lines.length > 0) {
            warnings.push('This step has both `region:` and `lines:`; the region is used and `lines:` is ignored.');
        }
        ranges = found.range.start > found.range.end ? [] : [found.range];
    } else if (step.lines.length > 0) {
        ranges = [];
        for (const requested of step.lines) {
            if (requested.start > fileLines.length) {
                warnings.push(`Lines ${requested.start}-${requested.end} are past the end of the file (${fileLines.length} lines).`);
                continue;
            }
            ranges.push({ start: requested.start, end: Math.min(requested.end, fileLines.length) });
        }
        ranges = mergeRanges(ranges);
    } else {
        ranges = fileLines.length > 0 ? [{ start: 1, end: fileLines.length }] : [];
    }

    const segments: WalkthroughSegment[] = ranges.map(range => ({
        lines: fileLines.slice(range.start - 1, range.end).map((text, offset) => ({
            number: range.start + offset,
            text
        }))
    }));

    return { segments, warnings };
}

function anchorLabel(anchor: WalkthroughAnchor): string {
    if (anchor.kind === 'text') {
        return `\`${anchor.text}\``;
    }
    return anchor.start === anchor.end ? `line ${anchor.start}` : `lines ${anchor.start}-${anchor.end}`;
}

export function decorateWalkthroughStep(step: WalkthroughStep, segments: WalkthroughSegment[]): DecoratedWalkthroughStep {
    const byLine = new Map<number, WalkthroughLineDecoration>();
    const orphanNotes: { label: string; text: string }[] = [];
    const displayed: WalkthroughDisplayLine[] = segments.flatMap(segment => segment.lines);
    const displayedNumbers = new Set(displayed.map(line => line.number));

    const decorationFor = (lineNumber: number): WalkthroughLineDecoration => {
        let decoration = byLine.get(lineNumber);
        if (!decoration) {
            decoration = { highlight: false, notes: [] };
            byLine.set(lineNumber, decoration);
        }
        return decoration;
    };

    for (const highlight of step.highlights) {
        for (let line = highlight.start; line <= highlight.end; line++) {
            if (displayedNumbers.has(line)) {
                decorationFor(line).highlight = true;
            }
        }
    }

    for (const annotation of step.annotations) {
        if (annotation.anchor.kind === 'text') {
            const anchorText = annotation.anchor.text;
            const target = displayed.find(line => line.text.includes(anchorText));
            if (target) {
                const decoration = decorationFor(target.number);
                decoration.highlight = true;
                decoration.notes.push(annotation.text);
            } else {
                orphanNotes.push({ label: anchorLabel(annotation.anchor), text: annotation.text });
            }
            continue;
        }

        let lastShown: number | undefined;
        for (let line = annotation.anchor.start; line <= annotation.anchor.end; line++) {
            if (displayedNumbers.has(line)) {
                decorationFor(line).highlight = true;
                lastShown = line;
            }
        }

        if (lastShown === undefined) {
            orphanNotes.push({ label: anchorLabel(annotation.anchor), text: annotation.text });
        } else {
            decorationFor(lastShown).notes.push(annotation.text);
        }
    }

    return { byLine, orphanNotes };
}

/** Human-readable summary of what a step displays, e.g. "lines 4–18". */
export function describeWalkthroughSegments(segments: WalkthroughSegment[]): string {
    const parts = segments
        .filter(segment => segment.lines.length > 0)
        .map(segment => {
            const first = segment.lines[0].number;
            const last = segment.lines[segment.lines.length - 1].number;
            return first === last ? `${first}` : `${first}–${last}`;
        });

    if (parts.length === 0) {
        return '';
    }
    return `line${parts.length === 1 && !parts[0].includes('–') ? '' : 's'} ${parts.join(', ')}`;
}
