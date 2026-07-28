/**
 * The `![alt](url =WIDTHxHEIGHT)` image-size syntax, shared by the marked
 * extension (src/client/markedImageSize.ts) and the markdown-it plugin
 * (src/markdownItPlugin) so both renderers of the same notebook agree.
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
 */

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
export const SIZED_IMAGE_RE =
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
