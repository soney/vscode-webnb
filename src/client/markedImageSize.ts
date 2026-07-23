/**
 * Marked extension: image-size syntax `![alt](url =WIDTHxHEIGHT)`.
 *
 * Standard markdown has no way to size an image, so we add the widely used
 * Typora / GitLab / markdown-it-imsize convention: a ` =WxH` suffix inside the
 * image's parentheses. Either dimension may be omitted to preserve the aspect
 * ratio:
 *
 *   ![alt](img.png =200x100)          width=200 height=100
 *   ![alt](img.png =200x)             width=200 (height auto)
 *   ![alt](img.png =x100)             height=100 (width auto)
 *   ![alt](img.png =200)              width=200 (height auto)
 *   ![alt](img.png "a title" =200x100)
 *
 * Only images carrying a size suffix are handled here; plain images fall through
 * to marked's built-in image tokenizer. The identical syntax is implemented for
 * VS Code's built-in notebook markdown engine in `src/markdownItPlugin/index.ts`
 * — keep the two in sync.
 */
import { marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';

export interface SizedImage {
    alt: string;
    href: string;
    title?: string;
    width?: string;
    height?: string;
    /** Length of the matched `![...](... =WxH)` substring. */
    length: number;
}

// alt, href (bare or <bracketed>), optional "title"/'title', then a required
// ` =WxH` size where each of W and H is optional (but not both empty).
// The alt branch `[^\\\]]` excludes backslash (as well as `]`) so an escaped
// char is only ever consumed by the `\\.` branch — without that exclusion a run
// of backslashes has 2^n ambiguous parses (catastrophic backtracking).
const SIZED_IMAGE_RE =
    /^!\[((?:\\.|[^\\\]])*)\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s+=(?:(\d*)x(\d*)|(\d+))\s*\)/;

/**
 * Parse a sized-image at the start of `src`. Returns `null` when `src` does not
 * begin with a `![...](... =WxH)` (including plain images without a size, which
 * the caller should let the default image handling render).
 */
export function parseSizedImage(src: string): SizedImage | null {
    const match = SIZED_IMAGE_RE.exec(src);
    if (!match) {
        return null;
    }

    let href = match[2];
    if (href.startsWith('<') && href.endsWith('>')) {
        href = href.slice(1, -1);
    }

    // Regex capture groups: 1=alt, 2=href, 3="title", 4='title',
    // 5=W (of WxH), 6=H (of WxH), 7=plain-N shorthand.
    let width: string | undefined;
    let height: string | undefined;
    if (match[7] !== undefined) {
        // `=200` shorthand — width only.
        width = match[7];
    } else {
        // `=WxH` — either side may be empty.
        width = match[5] || undefined;
        height = match[6] || undefined;
    }
    if (width === undefined && height === undefined) {
        return null; // degenerate `=x`
    }

    return {
        alt: match[1],
        href,
        title: match[3] ?? match[4],
        width,
        height,
        length: match[0].length
    };
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

interface ImageSizeToken extends Tokens.Generic {
    type: 'imageSize';
    href: string;
    title?: string;
    text: string;
    width?: string;
    height?: string;
}

export const imageSizeExtension: TokenizerAndRendererExtension = {
    name: 'imageSize',
    level: 'inline',
    start(src: string) {
        const index = src.indexOf('![');
        return index < 0 ? undefined : index;
    },
    tokenizer(src: string) {
        const parsed = parseSizedImage(src);
        if (!parsed) {
            return undefined;
        }
        const token: ImageSizeToken = {
            type: 'imageSize',
            raw: src.slice(0, parsed.length),
            href: parsed.href,
            title: parsed.title,
            text: parsed.alt,
            width: parsed.width,
            height: parsed.height
        };
        return token;
    },
    renderer(token) {
        const image = token as ImageSizeToken;
        let attrs = `src="${escapeAttr(image.href)}" alt="${escapeAttr(image.text)}"`;
        if (image.title) {
            attrs += ` title="${escapeAttr(image.title)}"`;
        }
        if (image.width) {
            attrs += ` width="${escapeAttr(image.width)}"`;
        }
        if (image.height) {
            attrs += ` height="${escapeAttr(image.height)}"`;
        }
        return `<img ${attrs}>`;
    }
};

let installed = false;

/**
 * Register the image-size extension on the shared `marked` singleton. Safe to
 * call from multiple modules in the same bundle — it only installs once.
 */
export function installMarkedImageSize(): void {
    if (installed) {
        return;
    }
    installed = true;
    marked.use({ extensions: [imageSizeExtension] });
}
