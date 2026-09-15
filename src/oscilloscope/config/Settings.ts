// src/config/Settings.ts

export interface ColumnWidths {
    name: number;
    description: number;
    value: number;
    unit: number;
}

export class Settings {
    public columnWidths: ColumnWidths = {
        name: 130,
        description: 80,
        value: 70,
        unit: 40,
    };

    public minRowHeight: number = 25; // minimum line height in px
    public rowHeight: number = 25; // height in px of each channel row (min 25px)
    public fontSize: number = 14; // font height/size in px corresponding to 25px row height
    public timeWindowMs: number = 2000; // total duration visible on screen (ms) (2s default)
    private baseTimeWindowMs: number = 2000;
    // Горизонтальная развертка: коэффициент масштаба времени (1 = норма)
    public timeScale: number = 1;
    public readonly minTimeScale: number = 0.1;  // «−» в 2 раза
    public readonly maxTimeScale: number = 10;    // «+» в 3 раза
    // Включена ли регулировка развертки колесом мыши (кнопка «Развертка»)
    public timeZoomEnabled: boolean = false;
    public setTimeScale(z: number): void {
        this.timeScale = Math.min(this.maxTimeScale, Math.max(this.minTimeScale, z));
        this.timeWindowMs = Math.round(this.baseTimeWindowMs / this.timeScale);
    }
    public showGrid: boolean = true;
    public gridDivisionsX: number = 10;
    public gridDivisionsY: number = 4;
    public autoScale: boolean = true;

    // Color theme
    public backgroundColor: string = '#050505';
    public gridColor: string = '#1f293d';
    public textColor: string = '#94a3b8';

    // Half window mode (default: true - occupy left half of browser)
    public isHalfWindow: boolean = true;

    // Timebase options in ms (100ms, 200ms, 500ms, 1s, 2s, 5s, 10s, 20s)
    public availableTimeWindows: number[] = [200, 500, 1000, 2000, 5000, 10000, 20000];

    // === УПРАВЛЕНИЕ ЗАПИСЬЮ И ПРОСМОТРОМ ИСТОРИИ ===
    
    // Идёт ли опрос контроллера (false = стоп, true = пуск)
    public isPolling: boolean = true;

    // === РЕЖИМ ИЗМЕРЕНИЯ ВЕЛИЧИНЫ СИГНАЛА ===

    // Активен ли режим измерения (false = выключен, true = включен)
    public isAmplitudeMode: boolean = false;

    // Момент времени вертикальной черты (timestamp в мс), null = черты нет
    public amplitudeMarkerTime: number | null = null;

    // Состояние режима измерения временных интервалов
    public isIntervalMode: boolean = false;
    // Время первого маркера (начало интервала) в мс, null если не установлен
    public intervalMarker1Time: number | null = null;
    // Время второго маркера (конец интервала) в мс, null если не установлен
    public intervalMarker2Time: number | null = null;

    // Шли ли графики до входа в режим измерения (для восстановления при выходе)
    public wasPollingBeforeMeasure: boolean = false;
    
    // Шли ли графики до входа в режим измерения интервалов (для восстановления при выходе)
    public wasPollingBeforeInterval: boolean = false;
    
    // Момент времени, относительно которого показываем данные (timestamp в мс)
    private timeOffset: number = 0;
    
    // Зафиксированное время (когда опрос остановлен)
    private frozenTime: number | null = null;

    /**
     * Переключает в режим просмотра истории
     * @param timestamp - момент времени для просмотра
     */
    public setViewTime(timestamp: number): void {
        if (!this.isPolling) {
            this.frozenTime = timestamp;
        } else {
            this.timeOffset = timestamp - Date.now();
        }
    }

    /**
     * Возвращает в режим слежения за реальным временем
     */
    public followLive(): void {
        this.timeOffset = 0;
        this.frozenTime = null;
    }

    /**
     * Фиксирует текущее время (вызывается при остановке опроса)
     */
    public freezeTime(): void {
        this.frozenTime = this.getCurrentViewTime();
    }

    /**
     * Возвращает текущий момент времени для отрисовки
     */
    public getCurrentViewTime(): number {
        if (!this.isPolling && this.frozenTime !== null) {
            return this.frozenTime;
        }
        return Date.now() + this.timeOffset;
    }

    /**
     * Проверяет, находимся ли мы в "живом" режиме (смещение близко к нулю)
     */
    public isLive(): boolean {
        return Math.abs(this.timeOffset) < 100;
    }

    public updateColumnWidth(column: keyof ColumnWidths, width: number): void {
        this.columnWidths[column] = Math.max(30, width);
        this.applyCSSTemplateVariables();
    }

    public setRowHeight(height: number): void {
        this.rowHeight = Math.max(this.minRowHeight, height);
        this.applyCSSTemplateVariables();
    }

    public setFontSize(size: number): void {
        this.fontSize = Math.max(11, size);
        this.applyCSSTemplateVariables();
    }

    public applyCSSTemplateVariables(): void {
        document.documentElement.style.setProperty('--col-name', `${this.columnWidths.name}px`);
        document.documentElement.style.setProperty('--col-description', `${this.columnWidths.description}px`);
        document.documentElement.style.setProperty('--col-value', `${this.columnWidths.value}px`);
        document.documentElement.style.setProperty('--col-unit', `${this.columnWidths.unit}px`);
        document.documentElement.style.setProperty('--row-height', `${this.rowHeight}px`);
        document.documentElement.style.setProperty('--font-size', `${this.fontSize}px`);
    }
}