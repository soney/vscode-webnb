/**
 * The `height=` fence attribute: how tall a cell's HTML output pane should be.
 *
 * The attribute travels as the author wrote it (so saving a notebook gives back
 * the same text) and only becomes CSS here, at the one place that turns it into
 * a length the renderer sets on `#html-output`. Shared so the notebook
 * renderer, the preview harness, and the preview extension cannot disagree
 * about what `height=300` means.
 *
 *   height=300     300px -- a bare number is pixels, as in `![alt](img =WxH)`
 *   height=20em    any CSS length unit is kept as written
 *   height=50vh
 *   height=auto    no fixed height: the pane shrinks to fit its content
 *
 * Anything else parses to `undefined` and leaves the pane at its default size,
 * rather than writing a broken value into the page's style.
 */

const CSS_LENGTH_RE = /^(\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|ch|ex|pt|pc|cm|mm|in)?$/;

/** `auto`, when the author asked the pane to size itself. */
export const AUTO_OUTPUT_HEIGHT = 'auto';

/**
 * Turns a raw `height=` value into a CSS length, `'auto'`, or `undefined` when
 * it is not a height at all.
 */
export function parseOutputHeight(raw: string | undefined): string | undefined {
    if (typeof raw !== 'string') {
        return undefined;
    }

    const value = raw.trim().toLowerCase();
    if (value === AUTO_OUTPUT_HEIGHT) {
        return AUTO_OUTPUT_HEIGHT;
    }

    const match = CSS_LENGTH_RE.exec(value);
    if (!match) {
        return undefined;
    }

    const [, amount, unit] = match;
    return unit ? `${amount}${unit}` : `${amount}px`;
}
