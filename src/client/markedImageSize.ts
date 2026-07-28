/**
 * Marked extension: image-size syntax `![alt](url =WIDTHxHEIGHT)`.
 *
 * The syntax itself (regex + parser) lives in src/shared/imageSize.ts, shared
 * with the markdown-it plugin that teaches VS Code's builtin notebook markdown
 * engine the same convention. This module only adapts it to marked.
 */
import { marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import { parseSizedImage } from '../shared/imageSize';

export { parseSizedImage, SIZED_IMAGE_RE, type SizedImage } from '../shared/imageSize';

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
