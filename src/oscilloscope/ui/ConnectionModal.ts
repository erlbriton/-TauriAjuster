// oscilloscope/ui/ConnectionModal.ts

/**
 * Модальное окно «Нет связи».
 *
 * Показывается при обрыве связи или открытии осциллографа без связи.
 * Закрывается кнопкой «Закрыть» или клавишей Enter (основная и
 * дополнительная клавиатура дают e.key === 'Enter').
 * Вся визуализация — в CSS-классах, инлайн-стилей нет.
 */
export class ConnectionModal {
    private overlay: HTMLElement | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    public get isOpen(): boolean {
        return this.overlay !== null;
    }

    public show(message: string): void {
        if (this.overlay) return; // уже открыто — не спамим

        const overlay = document.createElement('div');
        overlay.className = 'osc-connection-overlay';

        const modal = document.createElement('div');
        modal.className = 'osc-connection-modal';

        const icon = document.createElement('div');
        icon.className = 'osc-connection-icon';
        icon.textContent = '⚠️';

        const title = document.createElement('h2');
        title.className = 'osc-connection-title';
        title.textContent = 'Нет связи';

                const text = document.createElement('p');
        text.className = 'osc-connection-message';
        text.textContent = message;

        const btn = document.createElement('button');
        btn.className = 'osc-connection-close-btn';
        btn.textContent = 'Закрыть';
        btn.addEventListener('click', () => this.close());

        modal.append(icon, title, text, btn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        this.overlay = overlay;

        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.close();
            }
        };
        document.addEventListener('keydown', this.keyHandler);
    }

    public close(): void {
        if (!this.overlay) return;

        this.overlay.remove();
        this.overlay = null;

        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
    }
}