/**
 * Ambient module shims so `tsc -p src/test` (CommonJS output / Node16
 * resolution) can typecheck the client modules these unit tests import.
 *
 * - `marked` ships ESM-only, which is a TS1479 error when imported from a
 *   CommonJS module under Node16 resolution. At runtime Node >= 22.12 loads it
 *   fine via require(esm), so this only needs to satisfy the typechecker. The
 *   declaration mirrors the small surface src/client/markdown.ts and
 *   src/client/markedImageSize.ts actually use.
 * - `smartypants` ships no type declarations at all.
 *
 * These shims apply to the test build only; the real client build (webpack,
 * bundler resolution) still uses the packages' own types.
 */
declare module 'marked' {
    export namespace Tokens {
        interface Generic {
            [index: string]: unknown;
            type: string;
            raw: string;
        }
    }
    export interface TokenizerAndRendererExtension {
        name: string;
        level: 'block' | 'inline';
        start?: (src: string) => number | undefined;
        tokenizer?: (src: string, tokens?: unknown) => unknown;
        renderer?: (token: Tokens.Generic) => string | false | undefined;
    }
     
    export const marked: any;
}

declare module 'smartypants';
