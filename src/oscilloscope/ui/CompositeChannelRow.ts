// src/oscilloscope/ui/CompositeChannelRow.ts
// ============================================================================
// КОМПОНЕНТ СОВМЕЩЁННОЙ СТРОКИ (Composite Channel Row)
// ============================================================================
// Этот класс представляет специальную строку осциллографа, которая отображает
// несколько каналов (от 2 до 5) одновременно в одной системе координат.
// Используется для детального анализа амплитудных и временных соотношений
// между сигналами.
//
// Особенности:
// - Все графики рисуются в одном PixiView (один холст)
// - Каждый канал сохраняет свой цвет для визуального различения
// - Автомасштабирование работает для каждого канала независимо (нормализация)
// - В верхней части строки отображается легенда с именами каналов и текущими
//   значениями (Вариант А из обсуждений)
// - Поддерживает как аналоговые, так и битовые каналы
// - Высота битовых каналов фиксирована (25px), аналоговых — настраиваемая
//
// Архитектура:
// CompositeChannelRow хранит массив Channel объектов и создаёт:
//   1) HTML-структуру строки (колонки: имя, значение, единица, график)
//   2) Легенду с цветными чипами и текущими значениями
//   3) Один общий контейнер для графика (div), в который рендерер будет
//      рисовать все выбранные каналы
//
// Связь с другими компонентами:
// - OscilloscopeRenderer создаёт PixiView для этой строки так же, как для
//   обычной ChannelRow, но передаёт специальный флаг "isComposite"
// - WaveformRenderer модифицируется так, чтобы при рендеринге composite-строки
//   НЕ очищать холст между каналами (все волны рисуются поверх друг друга)
// - Oscilloscope управляет жизненным циклом: создаёт composite-строку при
//   совмещении и удаляет при разгруппировке
// ============================================================================

import { Channel } from '../core/Channel';
import { ContextMenu } from './ContextMenu';

export class CompositeChannelRow {
    // ========================================================================
    // HTML-ЭЛЕМЕНТЫ СТРОКИ
    // ========================================================================
    // Основной контейнер строки (аналог element в ChannelRow)
    private readonly element: HTMLDivElement;
    
    // Колонка с именами каналов (через запятую)
    private readonly nameElement: HTMLDivElement;
    
    // Колонка HEX значения (col-description). Пустая для composite,
    // но ОБЯЗАТЕЛЬНА для выравнивания CSS grid — без неё колонка графика
    // попадёт в узкую колонку UNIT.
    private readonly descriptionElement: HTMLDivElement;
    
    // Колонка с текущими значениями (пустая для composite, значения в легенде)
    private readonly valueElement: HTMLDivElement;
    
    // Колонка с единицами измерения (пустая, у каждого канала свои единицы)
    private readonly unitElement: HTMLDivElement;
    
    // Контейнер для графика (сюда будет добавлен PixiView)
    private readonly graphElement: HTMLDivElement;
    
    // Легенда с цветными чипами и значениями (располагается поверх графика)
    private readonly legendElement: HTMLDivElement;

    // ========================================================================
    // СОСТОЯНИЕ
    // ========================================================================
    // Массив каналов, которые совмещены в этой строке (от 2 до 5 каналов)
    private readonly channels: Channel[];
    
    // Видимость строки (может быть скрыта при разгруппировке)
    private isVisible: boolean = true;

    // ========================================================================
    // КОЛБЭКИ ДЛЯ ВЗАИМОДЕЙСТВИЯ С ГЛАВНЫМ КЛАССОМ
    // ========================================================================
    // Callback для разгруппировки совмещённой строки.
    public onDisconnect?: () => void;

    // Callback для открытия свойств первого канала в группе.
    public onShowProperties?: () => void;

    // Callback для расчёта коэффициента первого канала в группе.
    public onCalculateCoefficient?: () => void;

    // ========================================================================
    // КОНСТРУКТОР
    // ========================================================================
    // Принимает массив каналов, которые нужно совместить.
    // Создаёт HTML-структуру строки, легенду и подготавливает контейнер для графика.
    constructor(channels: Channel[]) {
        this.channels = channels;

        // Создаём основной контейнер строки
        this.element = document.createElement('div');
        this.element.className = 'channel-row composite-row';
        
        // Высота строки: для начала берём сумму высот всех каналов.
        // Позже можно будет добавить возможность изменения высоты мышью.
        const totalHeight = channels.reduce((sum, ch) => sum + ch.rowHeight, 0);
        this.element.style.height = `${totalHeight}px`;

        // --------------------------------------------------------------------
        // КОЛОНКА ИМЁН
        // --------------------------------------------------------------------
        // Показываем все имена через запятую, например: "IttC, Vbus, Temp"
        this.nameElement = document.createElement('div');
        this.nameElement.className = 'col-name';
        this.nameElement.textContent = channels.map(ch => ch.name).join(', ');
        this.nameElement.title = 'Совмещённые каналы: ' + channels.map(ch => `${ch.name} (${ch.description})`).join('; ');

        // --------------------------------------------------------------------
        // КОЛОНКА HEX (col-description)
        // --------------------------------------------------------------------
        // Пустая колонка-заполнитель. Нужна, чтобы CSS grid правильно
        // выровнял колонку графика в 5-ю (широкую) позицию.
        this.descriptionElement = document.createElement('div');
        this.descriptionElement.className = 'col-description';

        // --------------------------------------------------------------------
        // КОЛОНКА ЗНАЧЕНИЙ
        // --------------------------------------------------------------------
        // Оставляем пустой, так как текущие значения будут в легенде поверх графика.
        // Это сделано, чтобы не дублировать информацию и не занимать место в таблице.
        this.valueElement = document.createElement('div');
        this.valueElement.className = 'col-value';

        // --------------------------------------------------------------------
        // КОЛОНКА ЕДИНИЦ
        // --------------------------------------------------------------------
        // Оставляем пустой, так как у каждого канала могут быть свои единицы,
        // и они будут показаны в легенде рядом с каждым значением.
        this.unitElement = document.createElement('div');
        this.unitElement.className = 'col-unit';

        // --------------------------------------------------------------------
        // КОНТЕЙНЕР ДЛЯ ГРАФИКА
        // --------------------------------------------------------------------
        // Создаём div, в который OscilloscopeRenderer добавит PixiView.
        // Это аналог graphElement в ChannelRow.
        this.graphElement = document.createElement('div');
        this.graphElement.className = 'col-graph';
        this.graphElement.style.position = 'relative'; // Для позиционирования легенды

        // --------------------------------------------------------------------
        // ЛЕГЕНДА (Вариант А)
        // --------------------------------------------------------------------
        // Создаём легенду, которая будет отображаться поверх графика в левом верхнем углу.
        // Все статические стили (позиция, фон, отступы) вынесены в grid.css для чистоты кода.
        // Здесь мы задаём только классы и динамические цвета (которые зависят от канала).
        this.legendElement = document.createElement('div');
        this.legendElement.className = 'composite-legend';

        // Создаём строку легенды для каждого канала
        for (const channel of channels) {
            const legendItem = document.createElement('div');
            legendItem.className = 'legend-item';
            // Динамический стиль: цвет текста совпадает с цветом графика канала
            legendItem.style.color = channel.color; 

            // Цветной чип (квадратик). Размеры и форма берутся из CSS (.legend-color-chip)
            const colorChip = document.createElement('span');
            colorChip.className = 'legend-color-chip';
            // Динамический стиль: цвет фона совпадает с цветом графика канала
            colorChip.style.backgroundColor = channel.color;

            // Текст: имя канала = значение единица
            const textSpan = document.createElement('span');
            textSpan.className = 'legend-text';
            // Форматируем значение: если оно целое, без нулей, иначе до 3 знаков после запятой
            const formattedValue = Number.isInteger(channel.scaledValue) 
                ? channel.scaledValue.toString() 
                : channel.scaledValue.toFixed(3);
            textSpan.textContent = `${channel.name}: ${formattedValue} ${channel.unit}`;

            legendItem.appendChild(colorChip);
            legendItem.appendChild(textSpan);
            this.legendElement.appendChild(legendItem);
        }

        // Добавляем легенду в контейнер графика (поверх него)
        this.graphElement.appendChild(this.legendElement);

        // --------------------------------------------------------------------
        // СБОРКА СТРОКИ
        // --------------------------------------------------------------------
        // Порядок должен точно соответствовать grid-template-columns
        // из grid.css: name, description, value, unit, graph(1fr)
        this.element.append(
            this.nameElement,
            this.descriptionElement,
            this.valueElement,
            this.unitElement,
            this.graphElement
        );

        // --------------------------------------------------------------------
        // ОБРАБОТЧИК КЛИКА: ВЫБОР СОВМЕЩЁННОЙ СТРОКИ
        // --------------------------------------------------------------------
        // При клике на совмещённую строку снимаем выделение со всех остальных
        // строк (обычных и совмещённых) и выделяем эту классом 'selected'.
        // Это повторяет ту же логику, что используется в ChannelRow.
        this.element.addEventListener('click', () => {
            const container = this.element.parentElement;
            if (!container) return;
            
            container.querySelectorAll('.channel-row.selected').forEach((el) => {
                if (el !== this.element) {
                    el.classList.remove('selected');
                }
            });
            this.element.classList.add('selected');
        });

        // --------------------------------------------------------------------
        // КОНТЕКСТНОЕ МЕНЮ СОВМЕЩЁННОЙ СТРОКИ
        // --------------------------------------------------------------------
        // Отключаем стандартное меню браузера и показываем своё кастомное меню.
        // Меню содержит пункты: Свойства, Посчитать коэффициент (если все аналоговые), Разъединить.
        this.element.addEventListener('contextmenu', (e) => {
            console.log('[CompositeChannelRow] ОТЛАДКА: contextmenu сработал');
            e.preventDefault();
            e.stopPropagation();

            const menuItems: any[] = [];

            // 1. Пункт "Свойства"
            menuItems.push({
                label: 'Свойства',
                icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
                onClick: () => {
                    console.log('[CompositeChannelRow] ОТЛАДКА: клик Свойства, onShowProperties=', !!this.onShowProperties);
                    if (this.onShowProperties) this.onShowProperties();
                }
            });

            // 2. Пункт "Разъединить"
            menuItems.push({
                label: 'Разъединить',
                icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
                onClick: () => {
                    console.log('[CompositeChannelRow] ОТЛАДКА: клик Разъединить, onDisconnect=', !!this.onDisconnect);
                    if (this.onDisconnect) this.onDisconnect();
                }
            });

            const ctx = ContextMenu.getInstance();
            console.log('[CompositeChannelRow] ОТЛАДКА: ContextMenu.getInstance()=', !!ctx);
            if (ctx) {
                ctx.show(e.clientX, e.clientY, menuItems);
            }
        });
    }

    // ========================================================================
    // ПУБЛИЧНЫЕ МЕТОДЫ
    // ========================================================================

    // Получить HTML-элемент строки (для добавления в DOM)
    public getElement(): HTMLElement {
        return this.element;
    }

    // Получить контейнер для графика (для добавления PixiView)
    public getGraphContainer(): HTMLElement {
        return this.graphElement;
    }

    // Получить массив совмещённых каналов
    public getChannels(): Channel[] {
        return this.channels;
    }

    // Добавить строку в DOM
    public attach(parent: HTMLElement): void {
        parent.appendChild(this.element);
    }

    // Удалить строку из DOM
    public remove(): void {
        if (this.element.parentElement) {
            this.element.parentElement.removeChild(this.element);
        }
    }

    // Показать/скрыть строку
    public setVisible(visible: boolean): void {
        this.isVisible = visible;
        this.element.style.display = visible ? '' : 'none';
    }

    // Получить текущее состояние видимости
    public getIsVisible(): boolean {
        return this.isVisible;
    }

    // Обновить значения в легенде (вызывается при каждом обновлении данных)
    // ========================================================================
    // ОБНОВЛЕНИЕ ЗНАЧЕНИЙ В ЛЕГЕНДЕ
    // ========================================================================
    // Этот метод вызывается из общего цикла обновления осциллографа (updateValues).
    // Он проходит по всем элементам легенды и обновляет текст с текущими значениями
    // каналов. Это позволяет пользователю видеть актуальные данные в режиме реального
    // времени, в том числе при остановке осциллограммы и использовании курсоров.
    public updateValues(): void {
        const legendItems = this.legendElement.querySelectorAll('.legend-item');
        
        for (let i = 0; i < this.channels.length; i++) {
            const channel = this.channels[i];
            const item = legendItems[i] as HTMLElement;
            if (item) {
                const textSpan = item.querySelector('.legend-text') as HTMLSpanElement;
                if (textSpan) {
                    // Форматируем значение: целые числа показываем без дробной части,
                    // дробные — с точностью до 3 знаков. Это делает легенду чище.
                    const formattedValue = Number.isInteger(channel.scaledValue) 
                        ? channel.scaledValue.toString() 
                        : channel.scaledValue.toFixed(3);
                    
                    // Обновляем текст с текущим значением и единицами измерения
                    textSpan.textContent = `${channel.name}: ${formattedValue} ${channel.unit}`;
                }
            }
        }
    }
}