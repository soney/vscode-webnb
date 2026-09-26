/** Nesting below this prints as `{...}` / `[...]`, like a collapsed devtools entry. */
const MAX_DEPTH = 6;
/** A logged element's markup is cut off here. */
const MAX_MARKUP_LENGTH = 300;

export default class ConsoleObjectView {
    constructor(private readonly value: any) {

    }
    public getElement(): HTMLElement|string {
        return this.render(this.value, new Set(), 0);
    }

    // `ancestors` holds the objects on the path from the root to this value, so
    // a structure that contains itself prints `[Circular]` instead of recursing
    // until the stack overflows (and the overflow getting reported as the
    // learner's own error).
    private render(value: any, ancestors: Set<object>, depth: number): HTMLElement|string {
        const isPlainObject = Object.prototype.toString.call(value) === '[object Object]';
        if ((isPlainObject || Array.isArray(value)) && ancestors.has(value)) {
            return '[Circular]';
        }
        if(isPlainObject) {
            if (depth >= MAX_DEPTH) {
                return '{...}';
            }
            ancestors.add(value);
            const el = document.createElement('span');
            el.append('{');
            for(const [key, val] of Object.entries(value)) {
                const keyEl = document.createElement('span');
                keyEl.classList.add('console-object-key');
                keyEl.innerText = key + ': ';
                const valueEl = this.render(val, ancestors, depth + 1);
                const item = document.createElement('span');
                item.classList.add('console-object-item');
                item.append(keyEl, valueEl);
                el.append(item, ', ');
            }
            ancestors.delete(value);
            if(el.lastChild && el.lastChild.nodeType === Node.TEXT_NODE && el.lastChild.textContent === ', ') {
                el.lastChild.remove(); // Remove the last comma
            }
            el.append('}');

            return el;
        } else if(Array.isArray(value)) {
            if (depth >= MAX_DEPTH) {
                return '[...]';
            }
            ancestors.add(value);
            const el = document.createElement('span');
            el.append('[');
            for(const val of value) {
                const valueEl = this.render(val, ancestors, depth + 1);
                const item = document.createElement('span');
                item.append(valueEl);
                el.append(item, ', ');
            }
            ancestors.delete(value);
            if(el.lastChild && el.lastChild.nodeType === Node.TEXT_NODE && el.lastChild.textContent === ', ') {
                el.lastChild.remove(); // Remove the last comma
            }
            el.append(']');

            return el;
        } else if(typeof value === 'string') {
            const el = document.createElement('span');
            el.innerText = `"${value}"`;
            return el;
        } else if (typeof Element !== 'undefined' && value instanceof Element) {
            // An element prints as its markup, the way a browser console
            // shows it, not as "[object HTMLParagraphElement]".
            const markup = value.outerHTML;
            return markup.length > MAX_MARKUP_LENGTH ? `${markup.slice(0, MAX_MARKUP_LENGTH)}...` : markup;
        } else if (value instanceof Promise) {
            // Its state cannot be read synchronously; name the object at least.
            return 'Promise {}';
        } else {
            return String(value);
        }
    }
}
