// src/ui/Resizer.ts

import { Settings, ColumnWidths } from '../config/Settings';

export class Resizer {
    private settings: Settings;
    private headerElement: HTMLElement;
    private isResizing: boolean = false;

    // Callback, вызывается после изменения ширины любой колонки.
    // Осциллограф использует его, чтобы пересчитать ширину и позицию графиков
    // сразу, без ожидания вертикальной прокрутки.
    public onResize?: () => void;

    constructor(settings: Settings, headerElement: HTMLElement) {
        this.settings = settings;
        this.headerElement = headerElement;
    }

    public initialize(): void {
        const columns: { name: keyof ColumnWidths; selector: string }[] = [
            { name: 'name', selector: '.col-name' },
            { name: 'description', selector: '.col-description' },
            { name: 'value', selector: '.col-value' },
            { name: 'unit', selector: '.col-unit' }
        ];

        columns.forEach(col => {
            const headerCol = this.headerElement.querySelector(col.selector) as HTMLElement;
            if (headerCol) {
                const handle = document.createElement('div');
                handle.className = 'col-resizer';
                headerCol.appendChild(handle);

                this.bindColumnResize(handle, col.name);
            }
        });
    }

        private bindColumnResize(handle: HTMLElement, colKey: keyof ColumnWidths): void {
        handle.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            this.isResizing = true;
            handle.classList.add('resizing');
            const startX = e.clientX;
            const startWidth = this.settings.columnWidths[colKey];
            let pendingWidth = startWidth;

            const onMouseMove = (moveEvent: MouseEvent) => {
                if (!this.isResizing) return;
                const deltaX = moveEvent.clientX - startX;
                pendingWidth = Math.max(35, startWidth + deltaX);
            };

            const onMouseUp = () => {
                if (this.isResizing) {
                    this.settings.updateColumnWidth(colKey, pendingWidth);
                    // Уведомляем осциллограф, что ширина колонки изменилась,
                    // чтобы он пересинхронизировал графики без ожидания прокрутки.
                    if (this.onResize) this.onResize();
                }
                this.isResizing = false;
                handle.classList.remove('resizing');
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }
}
