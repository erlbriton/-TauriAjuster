// oscilloscope/ui/CursorsFooter.ts

/**
 * Курсорный футер осциллографа (нижняя панель со статистикой курсоров).
 *
 * Класс единолично владеет DOM-элементами:
 *  - #cur-x1 (позиция курсора X1 в процентах)
 *  - #cur-x2 (позиция курсора X2 в процентах)
 *  - #cur-dt (разница по времени между курсорами)
 *  - #cur-freq (частота, вычисленная из dt)
 *
 * Внешний код (Oscilloscope) не обращается к этим элементам напрямую,
 * а использует метод update() для обновления значений.
 */
export class CursorsFooter {
    private readonly curX1: HTMLElement;
    private readonly curX2: HTMLElement;
    private readonly curDt: HTMLElement;
    private readonly curFreq: HTMLElement;
    private readonly statsInfo: HTMLElement;
    private amplitudeTimeText: string | null = null; // Храним отформатированное время

    /**
     * @param root Контейнер, содержащий элементы курсорного футера (обычно #footer).
     * @throws Ошибка сразу (fail-fast), если скелет разметки не содержит ожидаемых элементов.
     */
    constructor(root: HTMLElement) {
        const curX1 = root.querySelector<HTMLElement>('#cur-x1');
        const curX2 = root.querySelector<HTMLElement>('#cur-x2');
        const curDt = root.querySelector<HTMLElement>('#cur-dt');
        const curFreq = root.querySelector<HTMLElement>('#cur-freq');

        if (!curX1) {
            throw new Error('[CursorsFooter] В скелете не найден #cur-x1.');
        }
        if (!curX2) {
            throw new Error('[CursorsFooter] В скелете не найден #cur-x2.');
        }
        if (!curDt) {
            throw new Error('[CursorsFooter] В скелете не найден #cur-dt.');
        }
        if (!curFreq) {
            throw new Error('[CursorsFooter] В скелете не найден #cur-freq.');
        }

        this.curX1 = curX1;
        this.curX2 = curX2;
        this.curDt = curDt;
        this.curFreq = curFreq;

        // Статистика (параметры · частота) — в первую видимую ячейку подвала
        const readCell = document.getElementById('read-cell-1');
        if (readCell) {
            readCell.style.color = '#4ade80';
            readCell.style.fontWeight = 'bold';
            readCell.textContent = '—';
            this.statsInfo = readCell;
        } else {
            const statsInfo = document.createElement('span');
            statsInfo.id = 'stats-info';
            statsInfo.style.color = '#4ade80';
            statsInfo.style.fontWeight = 'bold';
            statsInfo.style.marginRight = '16px';
            statsInfo.textContent = '—';
            curX1.parentElement?.insertBefore(statsInfo, curX1);
            this.statsInfo = statsInfo;
        }
    }

    /**
     * Обновляет строку статистики: количество параметров · частота опроса.
     */
    public setStats(paramsCount: number, hz: number): void {
        this.statsInfo.textContent = `${paramsCount} · ${hz.toFixed(1)} Гц`;
    }

    /**
     * Обновляет значения курсорного футера.
     *
     * @param x1Pct Позиция курсора X1 в процентах (0-100).
     * @param x2Pct Позиция курсора X2 в процентах (0-100).
     * @param timeWindowMs Длительность видимого окна в миллисекундах (для вычисления dt и freq).
     */
    public update(x1Pct: number, x2Pct: number, timeWindowMs: number): void {
        const dtMs = (Math.abs(x2Pct - x1Pct) / 100) * timeWindowMs;
        const freqHz = dtMs > 0 ? (1000 / dtMs).toFixed(2) : '0';

        this.curX1.textContent = `${x1Pct.toFixed(1)}%`;
        this.curX2.textContent = `${x2Pct.toFixed(1)}%`;

        // Если активно время амплитуды, сохраняем его в 3-й ячейке, иначе показываем dt
        if (this.amplitudeTimeText !== null) {
            this.curDt.textContent = this.amplitudeTimeText;
            this.curDt.style.color = '#00d2ff';
            this.curDt.style.fontWeight = 'bold';
        } else {
            this.curDt.textContent = `${dtMs.toFixed(1)} ms`;
            this.curDt.style.color = '';
            this.curDt.style.fontWeight = '';
        }

        this.curFreq.textContent = `${freqHz} Hz`;
    }

    /**
     * Отображает абсолютное время маркера измерения во 2-й ячейке.
     * Если timeMs === null, ячейка очищается (или возвращается в дефолтное состояние).
     */
    public setAmplitudeTime(timeMs: number | null): void {
        if (timeMs !== null) {
            const date = new Date(timeMs);
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const year = String(date.getFullYear()).slice(-2); // Берем последние 2 цифры года (например, "26")
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');

            // Формат: 15.08.26 11:25:38
            this.amplitudeTimeText = `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;

            this.curDt.textContent = this.amplitudeTimeText;
            this.curDt.style.color = '#00d2ff';
            this.curDt.style.fontWeight = 'bold';

            this.curX2.textContent = '0.0%';
            this.curX2.style.color = '';
            this.curX2.style.fontWeight = '';
        } else {
            this.amplitudeTimeText = null;

            this.curDt.textContent = '0.0 ms';
            this.curDt.style.color = '';
            this.curDt.style.fontWeight = '';

            this.curX2.textContent = '0.0%';
            this.curX2.style.color = '';
            this.curX2.style.fontWeight = '';
        }
    }
}