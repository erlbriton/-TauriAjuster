// src/oscilloscope/ui/ChannelPropertiesModal.ts

import { Channel } from '../core/Channel';

export class ChannelPropertiesModal {
    private overlay: HTMLDivElement | null = null;

    constructor(
        private channel: Channel,
        private onSave: (updatedChannel: Channel, visible: boolean) => void
    ) {}

        public open(currentlyVisible: boolean = true, allowBitSave: boolean = false): void {
        this.close();

        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.zIndex = '20000';

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.maxWidth = '520px';
        content.style.width = '100%';

        const isBit = this.channel.isBit;
        const showSaveButton = allowBitSave || !isBit;
        const disabledAttr = isBit ? 'disabled' : '';
        const readonlyStyle = isBit ? 'opacity:0.6; cursor:not-allowed;' : '';

        content.innerHTML = `
            <div class="modal-header" style="background: linear-gradient(to right, #2a2a2c, #353538); border-bottom: 1px solid #444; padding: 16px 20px;">
                <div class="modal-title" style="display:flex; align-items:center; gap:10px; font-weight:600; color:#fff; font-size:16px;">
                    <span style="display:inline-block; width:14px; height:14px; border-radius:3px; background-color:${this.channel.color}; border: 1px solid rgba(255,255,255,0.2);"></span>
                    Переменная ${isBit ? '(Только чтение)' : ''}
                </div>
                <button class="modal-close" id="prop-modal-close" style="font-size:24px; color:#999; transition: color 0.2s; background:transparent; border:none; cursor:pointer;">&times;</button>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:16px; padding: 24px; background: #222225;">
                <div style="display:flex; gap:16px;">
                    <div class="form-group" style="flex:1.5; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Название</label>
                        <input type="text" id="prop-name" class="form-input" value="${this.escapeHtml(this.channel.name)}" ${disabledAttr} style="background:#1a1a1d; border-color:#3a3a3d; ${readonlyStyle}" />
                    </div>
                    <div class="form-group" style="flex:1; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Идентификатор</label>
                        <input type="text" class="form-input" value="${this.escapeHtml(this.channel.id)}" disabled style="opacity:0.6; cursor:not-allowed; background:#1a1a1d; border-color:#3a3a3d;" />
                    </div>
                </div>
                
                <div class="form-group" style="margin-bottom:0;">
                    <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Описание</label>
                    <input type="text" id="prop-desc" class="form-input" value="${this.escapeHtml(this.channel.description)}" ${disabledAttr} style="background:#1a1a1d; border-color:#3a3a3d; ${readonlyStyle}" />
                </div>
                
                <div style="display:flex; gap:16px; align-items: flex-end;">
                    <div class="form-group" style="flex:1; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Шкала</label>
                        <input type="number" step="any" id="prop-scale" class="form-input" value="${this.channel.scale}" ${disabledAttr} style="background:#1a1a1d; border-color:#3a3a3d; ${readonlyStyle}" />
                    </div>
                </div>
                
                <div style="display:flex; gap:16px; align-items: flex-end;">
                    <div class="form-group" style="flex:1; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Максимум</label>
                        <div style="position:relative; display:flex; align-items:center; gap: 8px;">
                            <input type="number" step="any" id="prop-custom-max" class="form-input" value="${this.channel.customMax}" ${disabledAttr} style="background:#1a1a1d; border-color:#3a3a3d; flex: 1; ${readonlyStyle}" />
                            <div style="position: relative; flex: 0 0 100px;">
                                <span style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: #666; font-family: monospace;">0x</span>
                                <input type="text" id="prop-max-hex" class="form-input" value="${Math.round(this.channel.customMax).toString(16).toUpperCase().padStart(4, '0')}" ${disabledAttr} style="background:#1a1a1d; border-color:#3a3a3d; font-family:monospace; color:#00d2ff; padding-left: 24px; text-transform: uppercase; ${readonlyStyle}" />
                            </div>
                        </div>
                    </div>
                    <div class="form-group" style="flex:1; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Высота строки (px)</label>
                        <input type="number" id="prop-height" class="form-input" value="${this.channel.rowHeight}" style="background:#1a1a1d; border-color:#3a3a3d; padding: 8px 12px; box-sizing: border-box;" />
                    </div>
                </div>

                <div style="display:flex; gap:16px; align-items: center; background: rgba(0,0,0,0.15); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                    <div class="form-group" style="flex:1; margin-bottom:0;">
                        <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Цвет графика</label>
                        <input type="color" id="prop-color" class="form-input" value="${this.channel.color}" ${disabledAttr} style="height:32px; padding:2px; cursor:${isBit ? 'not-allowed' : 'pointer'}; background:#1a1a1d; border-color:#3a3a3d; ${readonlyStyle}" />
                    </div>
                    <div class="form-group" style="flex:1; margin-bottom:0; display:flex; align-items:center; height:100%; margin-top: 18px;">
                        <label style="display:flex; align-items:center; gap:10px; cursor:${isBit ? 'not-allowed' : 'pointer'}; font-size:13px; color:#eee; user-select:none;">
                            <input type="checkbox" id="prop-autoscale" ${this.channel.autoScale ? 'checked' : ''} ${disabledAttr} style="width:18px; height:18px; accent-color:#00d2ff; cursor:${isBit ? 'not-allowed' : 'pointer'}; ${readonlyStyle}" />
                            Авто масштаб
                        </label>
                    </div>
                </div>

                <div class="form-group" style="margin-bottom:0;">
                    <label style="color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; display:block;">Modbus Регистр</label>
                    <input type="text" class="form-input" value="${this.escapeHtml(this.channel.modbusReg || '—')}" disabled style="opacity:0.6; cursor:not-allowed; background:#1a1a1d; border-color:#3a3a3d;" />
                </div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:12px; padding: 16px 24px; background: #1a1a1d; border-top:1px solid #333;">
                <button class="toolbar-btn" id="prop-btn-cancel" style="padding: 8px 20px; font-weight:500;">Отмена</button>
                ${showSaveButton ? '<button class="toolbar-btn primary" id="prop-btn-save" style="padding: 8px 24px; font-weight:600; background: linear-gradient(135deg, #00d2ff 0%, #3a7bd5 100%); border:none; box-shadow: 0 4px 15px rgba(0, 210, 255, 0.3);">Сохранить</button>' : ''}
            </div>
        `;

        this.overlay.appendChild(content);
        document.body.appendChild(this.overlay);

        const maxInput = content.querySelector('#prop-custom-max') as HTMLInputElement;
        const hexInput = content.querySelector('#prop-max-hex') as HTMLInputElement;
        
        maxInput?.addEventListener('input', () => {
            const val = parseFloat(maxInput.value);
            if (!isNaN(val)) {
                hexInput.value = Math.round(val).toString(16).toUpperCase().padStart(4, '0');
            }
        });

        hexInput?.addEventListener('input', () => {
            const hexVal = hexInput.value.replace(/[^0-9A-Fa-f]/g, '');
            hexInput.value = hexVal.toUpperCase();
            
            if (hexVal) {
                const decimalVal = parseInt(hexVal, 16);
                if (!isNaN(decimalVal)) {
                    maxInput.value = decimalVal.toString();
                }
            }
        });

        const scaleInput = content.querySelector('#prop-scale') as HTMLInputElement;
        scaleInput?.addEventListener('change', () => {
            const newScale = parseFloat(scaleInput.value);
            if (!isNaN(newScale) && newScale !== 0) {
                const oldScale = this.channel.scale;
                const ratio = newScale / oldScale;
                const newMax = this.channel.customMax * ratio;
                maxInput.value = newMax.toString();
                hexInput.value = Math.round(newMax).toString(16).toUpperCase().padStart(4, '0');
            }
        });

        const closeBtn = content.querySelector('#prop-modal-close') as HTMLButtonElement;
        const cancelBtn = content.querySelector('#prop-btn-cancel') as HTMLButtonElement;
        const saveBtn = content.querySelector('#prop-btn-save') as HTMLButtonElement;

        closeBtn?.addEventListener('click', () => this.close());
        cancelBtn?.addEventListener('click', () => this.close());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        // Общая функция сохранения: вызывается и при клике на кнопку, и по Enter.
        // Вынесена в отдельную константу, чтобы повесить её на два обработчика
        // без дублирования кода.
        const handleSave = (): void => {
            const nameInput = content.querySelector('#prop-name') as HTMLInputElement;
            const descInput = content.querySelector('#prop-desc') as HTMLInputElement;
            const scaleInput = content.querySelector('#prop-scale') as HTMLInputElement;
            const colorInput = content.querySelector('#prop-color') as HTMLInputElement;
            const maxInput = content.querySelector('#prop-custom-max') as HTMLInputElement;
            const heightInput = content.querySelector('#prop-height') as HTMLInputElement;
            const autoScaleInput = content.querySelector('#prop-autoscale') as HTMLInputElement;

            if (nameInput) this.channel.name = nameInput.value.trim() || this.channel.name;
            if (descInput) this.channel.description = descInput.value.trim();
            if (scaleInput && !isNaN(parseFloat(scaleInput.value))) {
                this.channel.scale = parseFloat(scaleInput.value);
            }
            if (colorInput) this.channel.color = colorInput.value;
            
            if (maxInput && !isNaN(parseFloat(maxInput.value))) {
                this.channel.customMax = parseFloat(maxInput.value);
            }
            if (heightInput && !isNaN(parseInt(heightInput.value))) {
                this.channel.rowHeight = Math.max(25, Math.min(600, parseInt(heightInput.value)));
            }
            if (autoScaleInput) {
                this.channel.autoScale = autoScaleInput.checked;
            }

            this.onSave(this.channel, true);
            this.close();
        };

        // Клик по кнопке "Сохранить" (если она есть — для битовых каналов её может не быть).
        saveBtn?.addEventListener('click', handleSave);

        // Обработка клавиши Enter на основной и цифровой клавиатуре.
        // Слушаем keydown на всём оверлее, чтобы Enter срабатывал из любого
        // поля ввода (название, описание, высота, шкала и т.д.).
        // Проверяем наличие кнопки "Сохранить", чтобы не срабатывать в модалках
        // битовых каналов, где эта кнопка отсутствует (там только "Отмена").
        this.overlay.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && saveBtn) {
                e.preventDefault(); // Предотвращаем возможную отправку формы
                handleSave();
            }
            // Дополнительно: Escape закрывает модалку без сохранения.
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
    }

    public close(): void {
        if (this.overlay && this.overlay.parentElement) {
            this.overlay.parentElement.removeChild(this.overlay);
            this.overlay = null;
        }
    }

    private escapeHtml(str: string): string {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
