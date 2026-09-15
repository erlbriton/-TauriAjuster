// src/ui/modbus-scan-ui.ts
import { scanModbusNetwork } from '../core/modbus-scanner.js';
import type { FoundDevice } from '../core/modbus-scanner.js';

/** Зависимости, которые передаёт координатор UI (uiManager) */
export interface ModbusScanUiDeps {
    /** Открыт ли COM-порт */
    isPortOpen(): boolean;
    /** Приостановить обычный опрос устройства на время поиска */
    pausePolling(): void;
    /** Возобновить опрос после завершения поиска */
    resumePolling(): void;
    /** Подключиться к найденному устройству: переключить адрес опроса и передать ID для поиска INI */
    connectToDevice(addr: number, idText: string): void;
}

let deps: ModbusScanUiDeps | null = null;
let scanning = false;
let scanAbort: AbortController | null = null;

/** Точка входа: вешает обработчики кнопок модального окна поиска */
export function initModbusScanUI(uiDeps: ModbusScanUiDeps): void {
    deps = uiDeps;

    document.getElementById('modbusScanBtn')?.addEventListener('click', () => {
        resetView();
        getOverlay()?.classList.remove('hidden');
    });

    document.getElementById('scanCloseBtn')?.addEventListener('click', () => {
        stopScan();
        getOverlay()?.classList.add('hidden');
    });

    document.getElementById('scanStartBtn')?.addEventListener('click', () => {
        void startScan();
    });

    document.getElementById('scanStopBtn')?.addEventListener('click', () => {
        stopScan();
    });
}

function getOverlay(): HTMLElement | null {
    return document.getElementById('modbusScanOverlay');
}

function getEl(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function setProgress(text: string): void {
    const el = getEl('scanProgress');
    if (el) el.textContent = text;
}

/** Таймаут из поля ввода, ограничен диапазоном 50–5000 мс */
function readTimeoutMs(): number {
    const input = getEl('scanTimeoutInput') as HTMLInputElement | null;
    if (!input) return 300;
    const v = parseInt(input.value, 10);
    if (Number.isNaN(v)) return 300;
    return Math.min(5000, Math.max(50, v));
}

function setScanningButtons(active: boolean): void {
    const startBtn = getEl('scanStartBtn') as HTMLButtonElement | null;
    const stopBtn = getEl('scanStopBtn') as HTMLButtonElement | null;
    if (startBtn) startBtn.disabled = active;
    if (stopBtn) stopBtn.disabled = !active;
}

function resetView(): void {
    const results = getEl('scanResults');
    if (results) results.innerHTML = '';
    setProgress('Готов к поиску. Диапазон адресов: 1–247.');
    
    const progressEl = getEl('scanProgress');
    if (progressEl) {
        // Удаляем существующую подсказку, если она есть
        const existingHint = progressEl.nextElementSibling;
        if (existingHint?.classList?.contains('scan-hint')) {
            existingHint.remove();
        }
        
        // Добавляем новую подсказку
        const hint = document.createElement('div');
        hint.className = 'scan-hint';
        hint.textContent = 'Поиск выполняется на текущей скорости из таблицы. Для смены скорости измените значение на нужное и переподключитесь кликнув на кнопку Off-ID.';
        progressEl.insertAdjacentElement('afterend', hint);
    }
    
    setScanningButtons(false);
}

function stopScan(): void {
    if (scanAbort) scanAbort.abort();
}

async function startScan(): Promise<void> {
    if (!deps || scanning) return;
    if (!deps.isPortOpen()) {
        setProgress('COM-порт не открыт. Сначала подключитесь к порту.');
        return;
    }

    scanning = true;
    scanAbort = new AbortController();
    const results = getEl('scanResults');
    if (results) results.innerHTML = '';
    setScanningButtons(true);
    deps.pausePolling();

    try {
        await scanModbusNetwork(
            {
                signal: scanAbort.signal,
                getTimeoutMs: readTimeoutMs,
            },
            (p) => {
                setProgress(`Опрашивается адрес ${p.currentAddr} из ${p.total}. Найдено: ${p.foundCount}`);
            },
            (dev) => {
                addFoundRow(dev, true);
            },
        );
        setProgress(scanAbort.signal.aborted
            ? 'Поиск остановлен. Можно подключиться к найденному устройству.'
            : 'Опрос 1–247 завершён. Можно подключиться к найденному устройству.');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setProgress(`Ошибка поиска: ${msg}`);
    } finally {
        scanning = false;
        scanAbort = null;
        setScanningButtons(false);
        enableConnectButtons();
        deps.resumePolling();
    }
}

/** Строка найденного устройства; canConnect=false во время поиска */
function addFoundRow(dev: FoundDevice, canConnect: boolean): void {
    const results = getEl('scanResults');
    if (!results) return;

    const row = document.createElement('div');
    row.className = 'scan-row';

    const addrEl = document.createElement('span');
    addrEl.className = 'scan-addr';
    addrEl.textContent = String(dev.addr);

    const idEl = document.createElement('span');
    idEl.className = 'scan-id';
    idEl.textContent = dev.idText || '(без ID)';
    idEl.title = dev.idText;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Подключить';
    btn.disabled = !canConnect;
    btn.addEventListener('click', () => {
        if (deps) deps.connectToDevice(dev.addr, dev.idText);
        getOverlay()?.classList.add('hidden');
    });

    row.appendChild(addrEl);
    row.appendChild(idEl);
    row.appendChild(btn);
    results.appendChild(row);
    results.scrollTop = results.scrollHeight;
}

/** После остановки поиска разрешаем подключение ко всем найденным */
function enableConnectButtons(): void {
    const results = getEl('scanResults');
    if (!results) return;
    results.querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = false;
    });
}