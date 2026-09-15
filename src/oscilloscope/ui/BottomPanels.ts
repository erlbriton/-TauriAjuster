// oscilloscope/ui/BottomPanels.ts

/**
 * Нижние панели осциллографа.
 *
 * Класс единолично владеет DOM-элементами нижних панелей
 * (командная строка + строка индикаторов) и предоставляет
 * наружу только типизированный API. Внешний код не обращается
 * к этим элементам через document.getElementById(...).
 */

/** Ячейки строки индикаторов (только чтение). */
export enum ReadoutSlot {
    /** Зарезервировано под будущие алгоритмы. */
    Reserved1 = 0,
    /** Зарезервировано под будущие алгоритмы. */
    Reserved2 = 1,
    /** Зарезервировано под будущие алгоритмы. */
    Reserved3 = 2,
    /** Процент горизонтальной развертки. */
    TimeScale = 3
}

export class BottomPanels {
    public static readonly READOUT_COUNT = 4;

    private readonly commandInput: HTMLInputElement;
    private readonly readCells: HTMLElement[];
    private readonly multiplyButton: HTMLButtonElement;

    private onCommandInputCallback?: (text: string) => void;
    private onCommandSubmitCallback?: (text: string) => void;
    private onMultiplyCommandCallback?: () => void;

    /**
     * @param root Контейнер #bottom-panels, переданный из Layout.createSkeleton().
     * @throws Ошибка сразу (fail-fast), если скелет разметки не содержит ожидаемых элементов.
     */
    constructor(root: HTMLElement) {
        const input = root.querySelector<HTMLInputElement>('#bottom-edit-input');
        if (!input) {
            throw new Error('[BottomPanels] В скелете не найден #bottom-edit-input.');
        }
        this.commandInput = input;

        // Создаем кнопку x10 слева от командной строки
        this.multiplyButton = document.createElement('button');
        this.multiplyButton.textContent = 'x10';
        this.multiplyButton.className = 'multiply-button';
        // Объёмный вид: градиент сверху вниз, тени и подсветка
        this.multiplyButton.style.background = 'linear-gradient(180deg, #2d3a4f 0%, #1e293b 50%, #141c2a 100%)';
        this.multiplyButton.style.color = '#e2e8f0';
        this.multiplyButton.style.border = '1px solid #334155';
        this.multiplyButton.style.borderTop = '1px solid #475569';    // светлее сверху
        this.multiplyButton.style.borderBottom = '1px solid #0f172a'; // темнее снизу
        this.multiplyButton.style.borderRadius = '4px';
        this.multiplyButton.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.08)';
        this.multiplyButton.style.padding = '4px 12px';
        this.multiplyButton.style.cursor = 'pointer';
        this.multiplyButton.style.fontFamily = 'monospace';
        this.multiplyButton.style.fontWeight = '600';
        this.multiplyButton.style.fontSize = '13px';
        this.multiplyButton.style.marginRight = '8px';
        this.multiplyButton.style.height = '24px';
        this.multiplyButton.style.width = '48px'; // ширина = 2 * высота
        this.multiplyButton.style.transition = 'all 0.1s ease';

        // Эффекты при наведении и нажатии
        this.multiplyButton.addEventListener('mouseenter', () => {
            this.multiplyButton.style.background = 'linear-gradient(180deg, #3a4a62 0%, #253348 50%, #1a2436 100%)';
        });
        this.multiplyButton.addEventListener('mouseleave', () => {
            this.multiplyButton.style.background = 'linear-gradient(180deg, #2d3a4f 0%, #1e293b 50%, #141c2a 100%)';
        });
        this.multiplyButton.addEventListener('mousedown', () => {
            this.multiplyButton.style.boxShadow = 'inset 0 2px 4px rgba(0, 0, 0, 0.6)';
            this.multiplyButton.style.transform = 'translateY(1px)';
        });
        this.multiplyButton.addEventListener('mouseup', () => {
            this.multiplyButton.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.08)';
            this.multiplyButton.style.transform = 'translateY(0)';
        });

        // Обработчик клика на кнопку x10
        this.multiplyButton.addEventListener('click', () => {
            if (this.onMultiplyCommandCallback) {
                this.onMultiplyCommandCallback();
            }
        });

        // Вставляем кнопку перед командной строкой
        const parent = this.commandInput.parentElement;
        if (parent) {
            parent.insertBefore(this.multiplyButton, this.commandInput);
        }

        this.readCells = [];
        for (let i = 0; i < BottomPanels.READOUT_COUNT; i++) {
            const cell = root.querySelector<HTMLElement>(`#read-cell-${i + 1}`);
            if (!cell) {
                throw new Error(`[BottomPanels] В скелете не найден #read-cell-${i + 1}.`);
            }
            this.readCells.push(cell);
        }

        this.commandInput.addEventListener('input', () => {
            if (this.onCommandInputCallback) {
                this.onCommandInputCallback(this.commandInput.value);
            }
        });

        this.commandInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && this.onCommandSubmitCallback) {
                this.onCommandSubmitCallback(this.commandInput.value);
            }
        });
    }

    // ---------------------------------------------------- Подписки

    /** Вызывается при каждом изменении текста командной строки. */
    public onCommandInput(cb: (text: string) => void): void {
        this.onCommandInputCallback = cb;
    }

    /** Вызывается при нажатии Enter в командной строке. */
    public onCommandSubmit(cb: (text: string) => void): void {
        this.onCommandSubmitCallback = cb;
    }

    /** Вызывается при нажатии кнопки x10. */
    public onMultiplyCommand(cb: () => void): void {
        this.onMultiplyCommandCallback = cb;
    }

    // ---------------------------------------------------- Командная строка

    public setCommandText(text: string): void {
        this.commandInput.value = text;
    }

    public getCommandText(): string {
        return this.commandInput.value;
    }

    /** Фокус на командной строке, курсор — в конец текста. */
    public focusCommand(caretAtEnd: boolean = true): void {
        this.commandInput.focus();
        if (caretAtEnd) {
            const len = this.commandInput.value.length;
            this.commandInput.setSelectionRange(len, len);
        }
    }

    // ---------------------------------------------------- Индикаторы

    public setReadout(slot: ReadoutSlot, text: string): void {
        const cell = this.readCells[slot];
        if (cell) {
            cell.textContent = text;
        }
    }

    public getReadout(slot: ReadoutSlot): string {
        return this.readCells[slot]?.textContent ?? '';
    }
}