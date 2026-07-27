/**
 * Light/dark theme for the preview shell.
 *
 * The resolved theme is a `data-theme` attribute on <html>; styles.css keys
 * both palettes off it. Because custom properties inherit through shadow
 * boundaries, setting it also retints the renderer's shadow roots and the
 * syntax highlighting inside them — nothing has to be re-rendered.
 *
 * The *choice* is a third state: `auto` tracks the OS and keeps tracking it, so
 * a reader whose machine switches at sunset gets the same from the preview.
 * `light` and `dark` pin it regardless of the OS.
 */

/** What is actually painted. */
export type Theme = 'light' | 'dark';
/** What the reader picked; `auto` resolves against the OS. */
export type ThemeChoice = Theme | 'auto';

const STORAGE_KEY = 'webnb-preview-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type Listener = (theme: Theme, choice: ThemeChoice) => void;

const listeners = new Set<Listener>();

/** localStorage throws in some privacy modes; the theme is not worth failing over. */
function readStored(): ThemeChoice | undefined {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return value === 'light' || value === 'dark' || value === 'auto' ? value : undefined;
    } catch {
        return undefined;
    }
}

function writeStored(choice: ThemeChoice): void {
    try {
        localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        // Ignore: the choice still applies for this session.
    }
}

function systemTheme(): Theme {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** The reader's current choice, defaulting to `auto`. */
export function getChoice(): ThemeChoice {
    return readStored() ?? 'auto';
}

export function resolveTheme(choice: ThemeChoice): Theme {
    return choice === 'auto' ? systemTheme() : choice;
}

/** The theme currently painted. */
export function getTheme(): Theme {
    return resolveTheme(getChoice());
}

function apply(choice: ThemeChoice): void {
    const theme = resolveTheme(choice);
    document.documentElement.dataset.theme = theme;
    for (const listener of listeners) {
        listener(theme, choice);
    }
}

/** Switches to a choice and remembers it. */
export function setChoice(choice: ThemeChoice): void {
    writeStored(choice);
    apply(choice);
}

/** Subscribes to theme changes. Returns an unsubscribe function. */
export function onThemeChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Applies the startup theme and starts following the OS. Call once, early.
 *
 * index.html sets `data-theme` inline before first paint so the page never
 * flashes the wrong palette; this re-applies the same value so listeners
 * registered later still see a consistent state.
 */
export function initTheme(): void {
    apply(getChoice());

    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
        // A pinned light/dark choice outranks the OS; `auto` follows it.
        if (getChoice() !== 'auto') { return; }
        apply('auto');
    });
}
