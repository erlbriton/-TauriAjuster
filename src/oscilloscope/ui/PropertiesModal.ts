// src/ui/PropertiesModal.ts

import { Channel } from '../core/Channel';

export class PropertiesModal {
    private overlay: HTMLElement;
    private modal: HTMLElement;
    private leftListEl!: HTMLElement;
    private rightListEl!: HTMLElement;

    private allChannels: Channel[] = [];
    private currentLeft: Channel[] = [];
    private currentRight: Channel[] = [];

    private selectedLeftIds: Set<string> = new Set();
    private selectedRightIds: Set<string> = new Set();

    private lastClickedLeftIndex: number | null = null;
    private lastClickedRightIndex: number | null = null;

    private onApplyCallback?: (newVisibleChannels: Channel[]) => void;
    private onSettingsApplyCallback?: (settings: { pollDelayMs: number }) => void;

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay properties-modal-overlay';
        this.overlay.style.display = 'none';

        this.modal = document.createElement('div');
        this.modal.className = 'properties-modal-content';

        this.overlay.appendChild(this.modal);
        document.body.appendChild(this.overlay);

        this.renderSkeleton();
        this.bindEvents();
    }

    public onApply(cb: (newVisibleChannels: Channel[]) => void): void {
        this.onApplyCallback = cb;
    }

    public onSettingsApply(cb: (settings: { pollDelayMs: number }) => void): void {
        this.onSettingsApplyCallback = cb;
    }

    public setPollDelay(value: number): void {
        const input = this.modal.querySelector('#prop-poll-delay') as HTMLInputElement;
        if (input) {
            input.value = String(value);
        }
    }

    public open(allChannels: Channel[], visibleChannels: Channel[]): void {
        this.allChannels = allChannels;

        const visibleIds = new Set(visibleChannels.map(c => c.id));
        this.currentRight = [...visibleChannels];
        this.currentLeft = allChannels.filter(c => !visibleIds.has(c.id));

        this.selectedLeftIds.clear();
        this.selectedRightIds.clear();
        this.lastClickedLeftIndex = null;
        this.lastClickedRightIndex = null;

        this.updateLists();
        this.overlay.style.display = 'flex';
    }

    public close(): void {
        this.overlay.style.display = 'none';
    }

    private renderSkeleton(): void {
        this.modal.innerHTML = `
            <div class="properties-modal-header">
                <h3>⚙️ Свойства просмотра параметров</h3>
                <button class="modal-close-btn" id="prop-close-x">✕</button>
            </div>
            <div class="properties-modal-body">
                <div class="prop-fieldset prop-fieldset-left">
                    <legend class="prop-legend">Все параметры</legend>
                    <div class="prop-list-container" id="prop-left-list"></div>
                    <div class="prop-panel-actions">
                        <button class="prop-action-btn" id="prop-invert-left" title="Инвертировать выделение">🔄 Инвертировать</button>
                    </div>
                </div>

                <div class="prop-middle-controls">
                    <button class="prop-btn" id="prop-move-right" title="Добавить выбранные">&gt;</button>
                    <button class="prop-btn" id="prop-move-all-right" title="Добавить все">&gt;&gt;</button>
                    <button class="prop-btn" id="prop-move-left" title="Убрать выбранные">&lt;</button>
                    <button class="prop-btn" id="prop-move-all-left" title="Убрать все">&lt;&lt;</button>
                </div>

                <div class="prop-fieldset prop-fieldset-right">
                    <legend class="prop-legend">Просмотр</legend>
                    <div class="prop-right-content">
                        <div class="prop-list-container" id="prop-right-list"></div>
                        <div class="prop-vertical-controls">
                            <button class="prop-btn" id="prop-move-up" title="Переместить вверх">▲</button>
                            <button class="prop-btn" id="prop-move-down" title="Переместить вниз">▼</button>
                        </div>
                    </div>
                    <div class="prop-panel-actions">
                        <button class="prop-action-btn" id="prop-invert-right" title="Инвертировать выделение">🔄 Инвертировать</button>
                    </div>
                </div>
            </div>
            <div class="properties-modal-footer">
                <div class="prop-settings-group">
                    <label class="prop-settings-label" for="prop-poll-delay">Пауза (мс):</label>
                    <input class="prop-settings-input" type="number" id="prop-poll-delay" min="1" max="200" value="20" />
                </div>
                <button class="toolbar-btn primary" id="prop-apply-btn">Применить</button>
                <button class="toolbar-btn" id="prop-cancel-btn">Отмена</button>
            </div>
        `;

        this.leftListEl = this.modal.querySelector('#prop-left-list')!;
        this.rightListEl = this.modal.querySelector('#prop-right-list')!;
    }

    private bindEvents(): void {
        this.modal.querySelector('#prop-close-x')?.addEventListener('click', () => this.close());
        this.modal.querySelector('#prop-cancel-btn')?.addEventListener('click', () => this.close());

        this.modal.querySelector('#prop-apply-btn')?.addEventListener('click', () => {
            const pollDelayInput = this.modal.querySelector('#prop-poll-delay') as HTMLInputElement;
            let pollDelayMs = 20;
            if (pollDelayInput) {
                const val = parseInt(pollDelayInput.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 200) {
                    pollDelayMs = val;
                }
            }

            if (this.onApplyCallback) {
                this.onApplyCallback(this.currentRight);
            }
            if (this.onSettingsApplyCallback) {
                this.onSettingsApplyCallback({ pollDelayMs });
            }
            this.close();
        });

        this.modal.querySelector('#prop-move-right')?.addEventListener('click', () => this.moveSelectedRight());
        this.modal.querySelector('#prop-move-all-right')?.addEventListener('click', () => this.moveAllRight());
        this.modal.querySelector('#prop-move-left')?.addEventListener('click', () => this.moveSelectedLeft());
        this.modal.querySelector('#prop-move-all-left')?.addEventListener('click', () => this.moveAllLeft());

        this.modal.querySelector('#prop-move-up')?.addEventListener('click', () => this.moveUp());
        this.modal.querySelector('#prop-move-down')?.addEventListener('click', () => this.moveDown());

        this.modal.querySelector('#prop-invert-left')?.addEventListener('click', () => this.invertSelection('left'));
        this.modal.querySelector('#prop-invert-right')?.addEventListener('click', () => this.invertSelection('right'));
    }

    private updateLists(): void {
        this.renderList(this.leftListEl, this.currentLeft, this.selectedLeftIds, (index, e) => {
            this.handleItemClick('left', index, e);
        });

        this.renderList(this.rightListEl, this.currentRight, this.selectedRightIds, (index, e) => {
            this.handleItemClick('right', index, e);
        });
    }

    private renderList(
        container: HTMLElement,
        channels: Channel[],
        selectedSet: Set<string>,
        onItemClick: (index: number, e: MouseEvent) => void
    ): void {
        container.innerHTML = '';
        channels.forEach((ch, index) => {
            const item = document.createElement('div');
            item.className = 'prop-list-item' + (selectedSet.has(ch.id) ? ' selected' : '');
            
            const text = `${ch.id} : ${ch.name}${ch.description ? ' - ' + ch.description : ''}`;
            item.textContent = text;
            item.title = text;

            item.addEventListener('click', (e) => {
                onItemClick(index, e);
            });

            container.appendChild(item);
        });
    }

    private handleItemClick(side: 'left' | 'right', index: number, e: MouseEvent): void {
        const channels = side === 'left' ? this.currentLeft : this.currentRight;
        const selectedSet = side === 'left' ? this.selectedLeftIds : this.selectedRightIds;
        let lastIndex = side === 'left' ? this.lastClickedLeftIndex : this.lastClickedRightIndex;

        if (e.ctrlKey || e.metaKey) {
            const chId = channels[index].id;
            if (selectedSet.has(chId)) {
                selectedSet.delete(chId);
            } else {
                selectedSet.add(chId);
            }
            lastIndex = index;
        } else if (e.shiftKey && lastIndex !== null) {
            const start = Math.min(lastIndex, index);
            const end = Math.max(lastIndex, index);
            selectedSet.clear();
            for (let i = start; i <= end; i++) {
                selectedSet.add(channels[i].id);
            }
        } else {
            selectedSet.clear();
            selectedSet.add(channels[index].id);
            lastIndex = index;
        }

        if (side === 'left') {
            this.lastClickedLeftIndex = lastIndex;
        } else {
            this.lastClickedRightIndex = lastIndex;
        }

        this.updateLists();
    }

    private moveSelectedRight(): void {
        const toMove = this.currentLeft.filter(c => this.selectedLeftIds.has(c.id));
        if (toMove.length === 0) return;

        this.currentLeft = this.currentLeft.filter(c => !this.selectedLeftIds.has(c.id));
        this.currentRight.push(...toMove);

        this.selectedLeftIds.clear();
        this.lastClickedLeftIndex = null;
        this.updateLists();
    }

    private moveAllRight(): void {
        if (this.currentLeft.length === 0) return;

        this.currentRight.push(...this.currentLeft);
        this.currentLeft = [];

        this.selectedLeftIds.clear();
        this.lastClickedLeftIndex = null;
        this.updateLists();
    }

    private moveSelectedLeft(): void {
        const toMove = this.currentRight.filter(c => this.selectedRightIds.has(c.id));
        if (toMove.length === 0) return;

        this.currentRight = this.currentRight.filter(c => !this.selectedRightIds.has(c.id));
        this.currentLeft.push(...toMove);

        this.selectedRightIds.clear();
        this.lastClickedRightIndex = null;
        this.updateLists();
    }

    private moveAllLeft(): void {
        if (this.currentRight.length === 0) return;

        this.currentLeft.push(...this.currentRight);
        this.currentRight = [];

        this.selectedRightIds.clear();
        this.lastClickedRightIndex = null;
        this.updateLists();
    }

    private moveUp(): void {
        if (this.selectedRightIds.size === 0) return;

        const arr = this.currentRight;
        for (let i = 0; i < arr.length; i++) {
            if (this.selectedRightIds.has(arr[i].id)) {
                if (i > 0 && !this.selectedRightIds.has(arr[i - 1].id)) {
                    const temp = arr[i];
                    arr[i] = arr[i - 1];
                    arr[i - 1] = temp;
                }
            }
        }

        this.updateLists();
    }

    private moveDown(): void {
        if (this.selectedRightIds.size === 0) return;

        const arr = this.currentRight;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (this.selectedRightIds.has(arr[i].id)) {
                if (i < arr.length - 1 && !this.selectedRightIds.has(arr[i + 1].id)) {
                    const temp = arr[i];
                    arr[i] = arr[i + 1];
                    arr[i + 1] = temp;
                }
            }
        }

        this.updateLists();
    }

    private invertSelection(side: 'left' | 'right'): void {
        const channels = side === 'left' ? this.currentLeft : this.currentRight;
        const selectedSet = side === 'left' ? this.selectedLeftIds : this.selectedRightIds;

        channels.forEach(ch => {
            if (selectedSet.has(ch.id)) {
                selectedSet.delete(ch.id);
            } else {
                selectedSet.add(ch.id);
            }
        });

        this.updateLists();
    }
}
