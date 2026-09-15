// src/oscilloscope/ui/ToolbarComponents.ts

export class ToolbarComponents {
    public static createSelect(options: { label: string; val: number }[], selectedVal: number, onChange: (val: number) => void): HTMLSelectElement {
        const select = document.createElement('select');
        select.className = 'toolbar-select';
        options.forEach(optData => {
            const opt = document.createElement('option');
            opt.value = String(optData.val);
            opt.textContent = optData.label;
            if (optData.val === selectedVal) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', (e) => {
            const val = parseInt((e.target as HTMLSelectElement).value, 10);
            onChange(val);
        });
        return select;
    }

    public static createBaudSelect(currentBaud: number): HTMLSelectElement {
        const select = document.createElement('select');
        select.className = 'toolbar-select';
        [9600, 19200, 38400, 57600, 115200, 230400].forEach(baud => {
            const opt = document.createElement('option');
            opt.value = String(baud);
            opt.textContent = `${baud} Baud`;
            if (baud === currentBaud) opt.selected = true;
            select.appendChild(opt);
        });
        return select;
    }

    public static createButton(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = `toolbar-btn ${className}`.trim();
        btn.innerHTML = label;
        if (title) {
            btn.title = title;
        }
        btn.addEventListener('click', onClick);
        return btn;
    }
}