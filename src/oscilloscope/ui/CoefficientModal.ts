export class CoefficientModal {
    private overlay: HTMLDivElement | null = null;
    private input: HTMLInputElement | null = null;
    private errorEl: HTMLDivElement | null = null;
    private resultCallback: ((measuredValue: number) => void) | null = null;

    public open(resultCallback: (measuredValue: number) => void): void {
        this.createModal();
        this.resultCallback = resultCallback;
    }

    private createModal(): void {
        this.close();

        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.zIndex = '20000';

        const content = document.createElement('div');
        content.className = 'modal-content coef-modal-content';

        content.innerHTML = `
            <div class="modal-header coef-modal-header">
                <div class="modal-title">Посчитать коэффициент</div>
                <button class="modal-close" id="coef-modal-close">&times;</button>
            </div>
            <div class="coef-modal-body">
                <div class="form-group">
                    <label class="coef-label">Измеренное значение параметра</label>
                    <input type="number" step="any" id="coef-value" class="form-input coef-input" placeholder="Например: 220.5" />
                    <div id="coef-error" class="coef-error"></div>
                </div>
                <div class="coef-buttons">
                    <button id="coef-calculate-btn" class="coef-btn-calculate">Посчитать</button>
                    <button id="coef-cancel-btn" class="coef-btn-cancel">Отмена</button>
                </div>
            </div>
        `;

        this.overlay.appendChild(content);
        document.body.appendChild(this.overlay);

        this.input = content.querySelector('#coef-value');
        this.errorEl = content.querySelector('#coef-error');
        const closeBtn = content.querySelector('#coef-modal-close');
        const calculateBtn = content.querySelector('#coef-calculate-btn');
        const cancelBtn = content.querySelector('#coef-cancel-btn');

        if (this.input) {
            this.input.focus();
            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    this.handleCalculate();
                } else if (e.key === 'Escape') {
                    this.close();
                }
            });
        }

        closeBtn?.addEventListener('click', () => this.close());
        calculateBtn?.addEventListener('click', () => this.handleCalculate());
        cancelBtn?.addEventListener('click', () => this.close());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });
    }

    private showError(message: string): void {
        if (this.errorEl) {
            this.errorEl.textContent = message;
            this.errorEl.style.display = 'block';
        }
    }

    private handleCalculate(): void {
        if (!this.input || !this.resultCallback) return;

        const value = parseFloat(this.input.value);
        if (isNaN(value)) {
            this.showError('Введите корректное числовое значение');
            return;
        }

        this.resultCallback(value);
        this.close();
    }

    public close(): void {
        if (this.overlay && this.overlay.parentElement) {
            this.overlay.parentElement.removeChild(this.overlay);
        }
        this.overlay = null;
        this.input = null;
        this.errorEl = null;
        this.resultCallback = null;
    }
}