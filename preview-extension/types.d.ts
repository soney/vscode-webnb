/** Stylesheets are bundled as text (esbuild's `text` loader), like the
 * notebook renderer's webpack `asset/source` rule. */
declare module '*.css' {
    const content: string;
    export default content;
}

/** The webview API VS Code injects into the preview page. */
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};
