// src/oscilloscope/ui/ChannelRow.ts

import { Channel } from '../core/Channel';
import { ChannelPropertiesModal } from './ChannelPropertiesModal';
import { CoefficientModal } from './CoefficientModal.js';
import { getTableEditorState } from '../../ini-manager/table-editor.js';
import { processValueWrite } from '../../table-editor/value-write.js';
import { updateRowValues } from '../../ini-manager/tree-ui.js';
import { hexToFloat32, float32ToHex } from '../../ini-manager/tree-core.js';
import { showChannelRowContextMenu } from './ChannelRowContextMenu.js';

export class ChannelRow {
    // ========================================================================
    // СОСТОЯНИЕ ВЫБОРА КАНАЛОВ ДЛЯ АНАЛИЗА (совмещение графиков)
    // ========================================================================
    // Глобальный счётчик каналов, выбранных пользователем для последующего
    // совмещения в одну строку. Используется для двух целей:
    //   1) Ограничить выбор максимум 5 каналами (лимит совмещения).
    //   2) Определять, показывать ли пункт меню «Удалить все из анализа».
    // Поле статическое, чтобы быть общим для всех экземпляров ChannelRow.
    private static analysisSelectedCount: number = 0;

    // Список экземпляров ChannelRow, которые сейчас выбраны для анализа.
    // Нужен для того, чтобы по команде «Удалить все из анализа» можно было
    // пройтись по всем выбранным строкам и снять с них подсветку и флаг.
    // Без этого списка пришлось бы искать выбранные каналы перебором всех строк.
    private static analysisSelectedRows: ChannelRow[] = [];

    private readonly element: HTMLDivElement;
    private readonly nameElement: HTMLDivElement;
    private readonly hexElement: HTMLDivElement;
    private readonly unitElement: HTMLDivElement;
    private readonly valueElement: HTMLDivElement;
    private readonly graphElement: HTMLDivElement;
    private readonly colorIndicator: HTMLSpanElement;
    private isVisible: boolean = true;
    private lastHex: string = "";
    private lastValue: string = "";
    private lastUpdateTime: number = 0; // Троттлинг обновления цифр: 5 Гц вместо ~50 Гц
    private coefficientModal: CoefficientModal | null = null;

    // Флаг выбора данного конкретного канала для анализа (совмещения графиков).
    // Когда пользователь кликает «Выбрать для анализа», флаг становится true,
    // строка подсвечивается красноватым цветом, а канал добавляется в общий
    // список выбранных. Когда кликает «Убрать из анализа» — флаг сбрасывается.
    // Флаг нужен, чтобы при повторном правом клике показать правильный текст
    // пункта меню («Выбрать» или «Убрать») и правильную иконку.
    private isSelectedForAnalysis: boolean = false;

    // ========================================================================
    // ОБРАБОТЧИКИ СОБЫТИЙ (Callbacks)
    // ========================================================================
    // Эти поля являются публичными опциональными функциями, которые внешний
    // код (например, OscilloscopeBindings) может установить для реакции на
    // действия пользователя в строке канала.
    
    // Вызывается при обновлении данных канала (новое значение с контроллера).
    public onChannelUpdated?: (channel: Channel) => void;
    
    // Вызывается при клике на пункт меню «Удалить».
    public onDelete?: (channel: Channel) => void;
    
    // Вызывается при клике на пункт меню «Совместить».
    // Передаёт массив каналов, которые были выбраны для анализа.
    // OscilloscopeBindings слушает это событие и создаёт совмещённую строку
    // (CompositeChannelRow), скрывая исходные строки выбранных каналов.
    public onCreateComposite?: (channels: Channel[]) => void;
    public onSelect?: (channel: Channel) => void;
    public onToggleBit?: (channel: Channel) => void;

    constructor(public readonly channel: Channel) {
        this.element = document.createElement('div');
        this.element.className = 'channel-row';
        this.element.style.height = `${this.channel.rowHeight}px`;
        this.element.dataset.channelId = channel.id;

        // 1. Колонка Имя (Name)
        this.nameElement = document.createElement('div');
        this.nameElement.className = 'col-name';

        this.colorIndicator = document.createElement('span');
        this.colorIndicator.className = 'channel-color-indicator';
        this.colorIndicator.style.backgroundColor = channel.color;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'channel-title';
        titleSpan.textContent = channel.name;
        titleSpan.title = `${channel.name} (${channel.description})`;

        this.nameElement.append(this.colorIndicator, titleSpan);

        // 2. Колонка HEX значение (hex)
        this.hexElement = document.createElement('div');
        this.hexElement.className = 'col-description';
        this.hexElement.textContent = channel.hexValue;
        this.hexElement.style.fontFamily = 'monospace';
        this.hexElement.style.color = '#38bdf8';

        // 3. Колонка Unit
        this.unitElement = document.createElement('div');
        this.unitElement.className = 'col-unit';
        this.unitElement.textContent = channel.unit;

        // 4. Колонка Physical (Value)
        this.valueElement = document.createElement('div');
        this.valueElement.className = 'col-value';

        // 5. Колонка Graph
        this.graphElement = document.createElement('div');
        this.graphElement.className = 'col-graph';

        this.element.append(
            this.nameElement,
            this.hexElement,
            this.valueElement,
            this.unitElement,
            this.graphElement,
        );

        this.updateValue();

        this.element.addEventListener("click", () => {
            const container = this.element.parentElement;
            if (container) {
                container
                    .querySelectorAll(".channel-row.selected")
                    .forEach((el) => {
                        if (el !== this.element) el.classList.remove("selected");
                        this.element.addEventListener("dblclick", () => {
                            if (this.channel.isBit && this.onToggleBit) {
                                this.onToggleBit(this.channel);
                            }
                        });
                    });
            }
            this.element.classList.add("selected");
            if (this.onSelect) {
                this.onSelect(this.channel);
            }
        });

        this.element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Снимаем выделение со всех строк, кроме текущей, и выделяем её.
            const container = this.element.parentElement;
            if (container) {
                container.querySelectorAll('.channel-row.selected').forEach(el => {
                    if (el !== this.element) el.classList.remove('selected');
                });
            }
            this.element.classList.add('selected');
            if (this.onSelect) {
                this.onSelect(this.channel);
            }

            // Вся сборка пунктов меню вынесена в ChannelRowContextMenu.ts.
            showChannelRowContextMenu({
                channel: this.channel,
                event: e,
                isSelectedForAnalysis: this.isSelectedForAnalysis,
                getSelectedCount: () => ChannelRow.analysisSelectedCount,
                getSelectedChannels: () => ChannelRow.analysisSelectedRows.map(r => r.channel),
                onOpenProperties: () => this.openProperties(),
                onCalculateCoefficient: () => this.calculateCoefficient(),
                onToggleAnalysisSelection: () => this.toggleAnalysisSelection(),
                onClearAllAnalysisSelection: () => ChannelRow.clearAllAnalysisSelection(),
                onCreateComposite: (channels) => { this.onCreateComposite?.(channels); },
                onDelete: () => this.handleDelete(),
            });
        });
    }

    public openProperties(allowBitSave: boolean = false): void {
        const modal = new ChannelPropertiesModal(this.channel, (updatedChannel, visible) => {
            this.updateHeaderUI();
            this.setVisible(visible);

            // Если канал входит в текущую совмещённую группу — повторно скрываем
            // его строку. Модалка всегда передаёт visible=true, что вернуло бы
            // канал в таблицу и разрушило бы вид совмещённой строки.
            const osc = (window as any).osc;
            if (osc && Array.isArray(osc.compositeChannels) && osc.compositeChannels.length > 0) {
                const isInGroup = osc.compositeChannels.some((ch: any) => ch.id === updatedChannel.id);
                if (isInGroup) {
                    this.setVisible(false);
                }
            }

            if (this.onChannelUpdated) {
                this.onChannelUpdated(updatedChannel);
            }

            // Проверка обновления высоты для совмещённой строки
            if (osc && typeof osc.checkAndUpdateCompositeHeight === 'function') {
                osc.checkAndUpdateCompositeHeight(updatedChannel.id);
            }

            // Принудительная перерисовка для просмотрщика (viewerMode).
            // В просмотрщике отключён живой цикл, поэтому после изменения
            // высоты строки график не перерисовывается автоматически.
            if (osc && osc.viewerMode && typeof osc.renderVisibleGraphs === 'function') {
                osc.renderVisibleGraphs();
            }
        });
        modal.open(this.isVisible, allowBitSave);
    }

        public calculateCoefficient(): void {
        if (!this.coefficientModal) {
            this.coefficientModal = new CoefficientModal();
        }

        this.coefficientModal.open((measuredValue: number) => {
            this.runCoefficientCalculation(measuredValue);
        });
    }

    private runCoefficientCalculation(measuredValue: number): void {
        const osc = (window as any).osc;
        if (!osc || typeof osc.getArchive !== 'function') {
            console.error('[Коэффициент] Осциллограф недоступен');
            return;
        }

        const selectedRow = document.querySelector('#grid-data-rows tr.selected') as HTMLTableRowElement | null;
        if (!selectedRow) {
            console.error('[Коэффициент] Не выделен параметр в таблице');
            return;
        }

        const samples: number[] = [];
        const intervalMs = 500;
        const totalMeasurements = 10;
        let count = 0;

        const timer = setInterval(() => {
            const archive = osc.getArchive();
            const recent = archive.getRecentSamples(this.channel.id, 1000);
            if (recent.length > 0) {
                samples.push(recent[recent.length - 1].value);
            }
            count++;
            if (count >= totalMeasurements) {
                clearInterval(timer);
                this.finishCoefficientCalculation(measuredValue, samples, selectedRow);
            }
        }, intervalMs);
    }
    private async finishCoefficientCalculation(measuredValue: number, samples: number[], row: HTMLTableRowElement): Promise<void> {
        if (samples.length === 0) {
            console.error('[Коэффициент] Нет данных для расчёта');
            return;
        }

        const average = samples.reduce((a, b) => a + b, 0) / samples.length;
        const ratio = measuredValue / average;

        const tds = row.querySelectorAll('td');
        const currentValue = parseFloat((tds[7]?.textContent || '0').trim());

        const newValue = ratio * currentValue;

        console.log('[Коэффициент] Среднее:', average, '| Частное:', ratio, '| Текущее в таблице:', currentValue, '| Новое:', newValue);

        const stateObj = getTableEditorState();
        if (!stateObj) {
            console.error('[Коэффициент] Редактор таблицы недоступен');
            return;
        }

        const newValueStr = newValue.toFixed(4);
        const success = await processValueWrite(row, 'physical', newValueStr, stateObj, 7);

        if (success) {
            console.log('[Коэффициент] Значение успешно записано в контроллер');
        } else {
            console.error('[Коэффициент] Ошибка записи значения в контроллер');
        }
    }
                      
    public updateHeaderUI(): void {
        this.colorIndicator.style.backgroundColor = this.channel.color;
        const titleSpan = this.nameElement.querySelector('.channel-title');
        if (titleSpan) {
            titleSpan.textContent = this.channel.name;
            titleSpan.setAttribute('title', `${this.channel.name} (${this.channel.description})`);
        }
        this.unitElement.textContent = this.channel.unit;
        this.element.style.height = `${this.channel.rowHeight}px`;
    }

    public setVisible(visible: boolean): void {
        this.isVisible = visible;
        this.element.style.display = visible ? '' : 'none';
    }

    public getIsVisible(): boolean {
        return this.isVisible;
    }

    public attach(parent: HTMLElement): void {
        parent.appendChild(this.element);
    }

    public remove(): void {
        if (this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
    }

    private getContrastColor(hexColor: string): string {
        if (!hexColor || !hexColor.startsWith('#')) return '#000000';
        let hex = hexColor.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.substring(0, 2), 16) || 0;
        const g = parseInt(hex.substring(2, 4), 16) || 0;
        const b = parseInt(hex.substring(4, 6), 16) || 0;
        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        return yiq >= 128 ? '#0a0a0b' : '#ffffff';
    }

    public updateValue(): void {
        if (!this.isVisible) return;

        // Троттлинг: обновляем цифры не чаще раза в 200 мс (5 Гц вместо 50 Гц)
        // Опрос устройства и отрисовка графиков остаются на прежней частоте
        const now = Date.now();
        if (now - this.lastUpdateTime < 200) {//Период вывода значений величины сигнала.
            return;
        }
        this.lastUpdateTime = now;

        if (this.channel.dataType.toUpperCase() === 'TIPADDR') {
            const num = Math.floor(this.channel.rawDecValue) >>> 0;
            const hex = 'x' + num.toString(16).toUpperCase().padStart(8, '0');
            const ip = `${(num >>> 24) & 0xFF}.${(num >>> 16) & 0xFF}.${(num >>> 8) & 0xFF}.${num & 0xFF}`;
            this.applyHexText(hex);
            this.applyValueText(ip);
            return;
        }

        const isDiscrete = this.channel.isBit || this.channel.type === 'digital';

        if (isDiscrete) {
            const val = this.channel.scaledValue;
            const displayVal = typeof val === 'number' ? val.toString() : String(val);
            const textColor = this.getContrastColor(this.channel.color);
            this.applyHexHtml(`<span class="discrete-value-square" style="background-color: ${this.channel.color}; color: ${textColor};">${displayVal}</span>`);
            this.applyValueText('');
        } else {
            const val = this.channel.scaledValue;
            const valueText = typeof val === 'number'
                ? (Number.isInteger(val) ? val.toString() : val.toFixed(3))
                : String(val);
            this.applyHexText(this.channel.hexValue);
            this.applyValueText(valueText);
        }
    }

    private applyHexText(text: string): void {
        if (text === this.lastHex) return;
        this.lastHex = text;
        this.hexElement.textContent = text;
    }

    private applyHexHtml(html: string): void {
        if (html === this.lastHex) return;
        this.lastHex = html;
        this.hexElement.innerHTML = html;
    }

    private applyValueText(text: string): void {
        if (text === this.lastValue) return;
        this.lastValue = text;
        this.valueElement.textContent = text;
    }

    public getGraphContainer(): HTMLElement {
        return this.graphElement;
    }

    public getElement(): HTMLElement {
        return this.element;
    }
        // ========================================================================
    // СБРОС ВСЕХ ВЫБРАННЫХ ДЛЯ АНАЛИЗА КАНАЛОВ
    // ========================================================================
    // Статический метод, который вызывается из пункта меню «Удалить все из анализа».
    // Проходит по всем строкам, которые сейчас выбраны для анализа, и для каждой:
    //   1) Сбрасывает флаг выбора (isSelectedForAnalysis = false).
    //   2) Убирает визуальную подсветку (класс 'analysis-selected').
    // После этого очищает глобальный список выбранных строк и обнуляет счётчик.
    // Метод статический, потому что работает с общим состоянием всех каналов,
    // а не с одним конкретным экземпляром.
    // Важно: обращение к приватным полям экземпляров того же класса разрешено
    // в TypeScript, поэтому мы можем менять row.isSelectedForAnalysis напрямую.
    /**
     * Переключает флаг выбора этого канала для анализа.
     * Содержит проверку лимита (не более 5 каналов), обновляет счётчик,
     * список выбранных строк, визуальную подсветку и логирует действие.
     * Вызывается из пункта меню «Выбрать/Убрать из анализа».
     */
    private toggleAnalysisSelection(): void {
        // Ограничение: для совмещения можно выбрать не более 5 каналов.
        // Если пользователь пытается выбрать 6-й канал, показываем предупреждение
        // и прерываем выполнение, не меняя состояние.
        if (!this.isSelectedForAnalysis && ChannelRow.analysisSelectedCount >= 5) {
            alert('Можно выбрать не более 5 каналов для анализа');
            return;
        }

        // Инвертируем флаг выбора: если был не выбран — выбираем, и наоборот.
        this.isSelectedForAnalysis = !this.isSelectedForAnalysis;

        // Обновляем глобальный счётчик выбранных каналов:
        // +1 если канал только что выбран, -1 если убран из анализа.
        ChannelRow.analysisSelectedCount += this.isSelectedForAnalysis ? 1 : -1;

        // Обновляем глобальный список выбранных строк.
        // При выборе добавляем текущий экземпляр в конец списка.
        // При снятии выбора убираем текущий экземпляр из списка через filter.
        if (this.isSelectedForAnalysis) {
            ChannelRow.analysisSelectedRows.push(this);
        } else {
            ChannelRow.analysisSelectedRows = ChannelRow.analysisSelectedRows.filter(r => r !== this);
        }

        // Включаем или выключаем визуальную подсветку строки.
        // Класс 'analysis-selected' задаёт прозрачный красноватый фон,
        // чтобы пользователь видел, какие каналы выбраны для совмещения.
        this.element.classList.toggle('analysis-selected', this.isSelectedForAnalysis);

        // Логирование для отладки: показываем действие и текущее число выбранных.
        console.log(`[Oscilloscope] Канал ${this.isSelectedForAnalysis ? 'выбран' : 'убран'} для анализа:`, this.channel.id, this.channel.name, `(выбрано: ${ChannelRow.analysisSelectedCount})`);
    }

    /**
     * Удаляет текущую строку с корректной очисткой структур выбора анализа.
     * Если строка была выбрана — снимает флаг, обновляет счётчик и список,
     * убирает визуальную подсветку. Затем скрывает строку и вызывает
     * внешний обработчик onDelete, чтобы осциллограф удалил канал.
     * Вызывается из пункта меню «Удалить».
     */
    private handleDelete(): void {
        // Если удаляемый канал был выбран для анализа, нужно корректно
        // убрать его из всех структур выбора, иначе счётчик и список
        // останутся с «призраком» удалённого канала. Это важно, чтобы
        // после удаления можно было выбрать новый канал вместо него.
        if (this.isSelectedForAnalysis) {
            // Уменьшаем глобальный счётчик выбранных каналов.
            ChannelRow.analysisSelectedCount -= 1;
            // Убираем текущий экземпляр из глобального списка выбранных строк.
            ChannelRow.analysisSelectedRows = ChannelRow.analysisSelectedRows.filter(r => r !== this);
            // Сбрасываем флаг выбора.
            this.isSelectedForAnalysis = false;
            // Убираем визуальную подсветку строки.
            this.element.classList.remove('analysis-selected');
        }

        // Скрываем строку и вызываем внешний обработчик удаления,
        // чтобы осциллограф удалил канал из своего списка.
        this.setVisible(false);
        if (this.onDelete) {
            this.onDelete(this.channel);
        }
    }

    private static clearAllAnalysisSelection(): void {
        // Проходим по всем выбранным строкам и сбрасываем их состояние.
        for (const row of ChannelRow.analysisSelectedRows) {
            row.isSelectedForAnalysis = false;
            row.element.classList.remove('analysis-selected');
        }
        // Очищаем список выбранных строк.
        ChannelRow.analysisSelectedRows = [];
        // Обнуляем глобальный счётчик выбранных каналов.
        ChannelRow.analysisSelectedCount = 0;
        // Логирование для отладки.
        console.log('[Oscilloscope] Все каналы убраны из анализа');
    }
}