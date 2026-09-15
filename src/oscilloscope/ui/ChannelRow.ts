// src/oscilloscope/ui/ChannelRow.ts

import { Channel } from '../core/Channel';
import { ContextMenu } from './ContextMenu';
import { ChannelPropertiesModal } from './ChannelPropertiesModal';
import { CoefficientModal } from './CoefficientModal.js';
import { getTableEditorState } from '../../ini-manager/table-editor.js';
import { processValueWrite } from '../../table-editor/value-write.js';
import { updateRowValues } from '../../ini-manager/tree-ui.js';
import { hexToFloat32, float32ToHex } from '../../ini-manager/tree-core.js';

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
            const isAnalog = this.channel.type !== 'digital';

            const menuItems: any[] = [
                {
                    label: 'Свойства',
                    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
                    onClick: () => {
                        this.openProperties();
                    }
                }
            ];

                       if (isAnalog) {
                menuItems.push({
                    label: 'Посчитать коэффициент',
                    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="8" y2="10.01"/><line x1="12" y1="10" x2="12" y2="10.01"/><line x1="16" y1="10" x2="16" y2="10.01"/><line x1="8" y1="14" x2="8" y2="14.01"/><line x1="12" y1="14" x2="12" y2="14.01"/><line x1="16" y1="14" x2="16" y2="14.01"/><line x1="8" y1="18" x2="8" y2="18.01"/><line x1="12" y1="18" x2="12" y2="18.01"/><line x1="16" y1="18" x2="16" y2="18.01"/></svg>`,
                    onClick: () => {
                        this.calculateCoefficient();
                    }
                });
            }

            // Пункт меню «Выбрать для анализа / Убрать из анализа».
            // Текст и иконка пункта меняются динамически в зависимости от того,
            // выбран ли данный канал для анализа в текущий момент.
            // Если канал ещё не выбран — показываем «Выбрать для анализа» и иконку графика.
            // Если уже выбран — показываем «Убрать из анализа» и иконку крестика.
            menuItems.push({
                label: this.isSelectedForAnalysis ? 'Убрать из анализа' : 'Выбрать для анализа',
                icon: this.isSelectedForAnalysis
                    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
                    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
                onClick: () => {
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
            });
            // Пункт меню «Удалить все из анализа».
            // Показывается только в том случае, если выбран хотя бы один канал.
            // Позволяет пользователю одним кликом сбросить выбор всех каналов,
            // если он передумал делать совмещение. Это удобнее, чем убирать
            // каждый канал по отдельности.
                       // Пункт меню «Удалить все из анализа».
            // Показывается только в том случае, если выбран хотя бы один канал.
            // Позволяет пользователю одним кликом сбросить выбор всех каналов,
            // если он передумал делать совмещение. Это удобнее, чем убирать
            // каждый канал по отдельности.
            if (ChannelRow.analysisSelectedCount > 0) {
                menuItems.push({
                    label: 'Удалить все из анализа',
                    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
                    onClick: () => {
                        // Вызываем статический метод, который сбрасывает выбор
                        // у всех выбранных каналов, очищает список и счётчик.
                        ChannelRow.clearAllAnalysisSelection();
                    }
                });
            }

            // ==========================================================================
            // ПУНКТ МЕНЮ «СОВМЕСТИТЬ» (Объединение графиков в одну строку)
            // ==========================================================================
            // Этот пункт появляется в контекстном меню ТОЛЬКО тогда, когда пользователь
            // выбрал для анализа 2 или более каналов. Если выбран 0 или 1 канал, пункт
            // полностью скрыт (а не просто неактивен). Это позволяет не перегружать меню
            // недоступными действиями и избавляет нас от необходимости модифицировать
            // сам компонент ContextMenu для поддержки состояния 'disabled'.
            // Совмещение имеет смысл только при сравнении нескольких сигналов.
            if (ChannelRow.analysisSelectedCount >= 2) {
                menuItems.push({
                    label: `Совместить (${ChannelRow.analysisSelectedCount})`,
                    // Иконка: несколько наложенных друг на друга слоев (графиков)
                    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
                    onClick: () => {
                        // Собираем массив объектов Channel из всех выбранных строк.
                        // Это нужно передать в обработчик onCreateComposite, чтобы
                        // внешний код (OscilloscopeBindings) мог создать совмещённую
                        // строку с этими каналами.
                        const selectedChannels = ChannelRow.analysisSelectedRows.map(r => r.channel);
                        
                        // Логируем действие для отладки.
                        console.log(`[Oscilloscope] Запрошено совмещение ${ChannelRow.analysisSelectedCount} каналов.`);
                        console.log('[Oscilloscope] Список каналов для совмещения:', selectedChannels.map(ch => ch.name));
                        
                        // Вызываем внешний обработчик, если он установлен.
                        // OscilloscopeBindings установит этот callback при создании
                        // строки канала и будет реагировать на него созданием
                        // CompositeChannelRow.
                        if (this.onCreateComposite) {
                            this.onCreateComposite(selectedChannels);
                        }
                    }
                });
            }

            menuItems.push({
                label: 'Удалить',
                danger: true,
                icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
                onClick: () => {
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
            });

            ContextMenu.getInstance().show(e.clientX, e.clientY, menuItems);
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