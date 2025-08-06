export default class ConsoleObjectView {
    constructor(private readonly value: any) {

    }
    public getElement(): HTMLElement|string {
        if(Object.prototype.toString.call(this.value) === '[object Object]') {
            const el = document.createElement('span');
            el.append('{');
            for(const [key, val] of Object.entries(this.value)) {
                const cov = new ConsoleObjectView(val);
                const keyEl = document.createElement('span');
                keyEl.classList.add('console-object-key');
                keyEl.innerText = key + ': ';
                const valueEl = cov.getElement();
                const item = document.createElement('span');
                item.classList.add('console-object-item');
                item.append(keyEl, valueEl);
                el.append(item, ', ');
            }
            if(el.lastChild && el.lastChild.nodeType === Node.TEXT_NODE && el.lastChild.textContent === ', ') {
                el.lastChild.remove(); // Remove the last comma
            }
            el.append('}');

            return el;
        } else if(Array.isArray(this.value)) {
            const el = document.createElement('span');
            el.append('[');
            for(const val of this.value) {
                const cov = new ConsoleObjectView(val);
                const valueEl = cov.getElement();
                const item = document.createElement('span');
                item.append(valueEl);
                el.append(item, ', ');
            }
            if(el.lastChild && el.lastChild.nodeType === Node.TEXT_NODE && el.lastChild.textContent === ', ') {
                el.lastChild.remove(); // Remove the last comma
            }
            el.append(']');

            return el;
        } else if(typeof this.value === 'string') {
            const el = document.createElement('span');
            el.innerText = `"${this.value}"`;
            return el;
        } else {
            return String(this.value);
        }
    }
}