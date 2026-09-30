// src/ui/cmdline-ui.ts
/**
 * Командная строка Modbus (инструмент продвинутого пользователя).
 *
 * - пользователь вводит кадр БЕЗ CRC — CRC16 дописывается автоматически;
 * - в чёрное поле эхо поданной команды выводится с префиксом [You],
 *   ответ контроллера — с [Ok] (зелёный), ошибка/таймаут — с [Err] (красный);
 * - в поле ввода доступна история уникальных команд (datalist),
 *   сохраняется в localStorage между запусками приложения, лимит — 50;
 * - BPS в окне автономный: при открытии запоминается скорость основного
 *   соединения, при закрытии окна — восстанавливается;
 * - ничего больше (осциллограф, таблица) не останавливается.
 */
import { serialManager, calculateCRC } from '../serial/serial-actions.js';
import { showConfirmDialog } from './confirm-dialog.js';

type ModeType = 'HEX' | 'ASCII' | 'ASCII_FILTER';

/** Ключ localStorage для истории команд. */
const HISTORY_KEY = 'tauri-ajuster:cmdline-history';

/** Максимум команд в истории. */
const HISTORY_LIMIT = 50;

/** Скорость основного соединения до открытия окна (для восстановления) */
let savedBaudRate: number | null = null;

// ─── Состояние перетаскивания окна ──────────────────────────
// Смещение окна относительно центра экрана (в пикселях).
// Применяется через CSS transform: translate(...) — не ломает flex-центрирование
// родителя и легко сбрасывается при каждом открытии окна.
let dragOffsetX = 0;
let dragOffsetY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

// ────────────────────────────────────────────────────────────
// История команд (нативный datalist)
// ────────────────────────────────────────────────────────────

/** Читает историю из localStorage. Возвращает [] при любой ошибке. */
function loadHistory(): string[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
        return [];
    }
}

/** Сохраняет историю в localStorage. */
function saveHistory(items: string[]): void {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    } catch (err) {
        console.warn('[cmdline] Не удалось сохранить историю:', err);
    }
}

/** Перерисовывает <datalist id="cmdlineHistory"> по текущей истории. */
function renderHistoryDatalist(): void {
    const datalist = document.getElementById('cmdlineHistory') as HTMLDataListElement | null;
    if (!datalist) return;
    datalist.innerHTML = '';
    for (const item of loadHistory()) {
        const opt = document.createElement('option');
        opt.value = item;
        datalist.appendChild(opt);
    }
}

/**
 * Добавляет команду в историю.
 * Уникальность: если команда уже была — она поднимается в начало (как в bash).
 * Лимит: не больше HISTORY_LIMIT последних команд.
 */
function addToHistory(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    const items = loadHistory();
    const filtered = items.filter((x) => x !== trimmed);
    filtered.unshift(trimmed);
    saveHistory(filtered.slice(0, HISTORY_LIMIT));
    renderHistoryDatalist();
}

/** Полностью очищает историю команд. */
function clearHistory(): void {
    saveHistory([]);
    renderHistoryDatalist();
}

// ────────────────────────────────────────────────────────────
// Инициализация UI
// ────────────────────────────────────────────────────────────

export function initCmdlineUI(): void {
    renderHistoryDatalist();
    setupCmdlineDragging();

    document.getElementById('cmdlineBtn')?.addEventListener('click', () => {
        openCmdline();
    });

    document.getElementById('cmdlineCloseBtn')?.addEventListener('click', () => {
        closeCmdline();
    });

    document.getElementById('cmdlineClearBtn')?.addEventListener('click', () => {
        const output = document.getElementById('cmdlineOutput');
        if (output) output.textContent = '';
    });

    document.getElementById('cmdlineClearHistoryBtn')?.addEventListener('click', async () => {
        const ok = await showConfirmDialog('Удалить всю историю команд?');
        if (ok) clearHistory();
    });

    const bpsSelect = document.getElementById('cmdlineBpsSelect') as HTMLSelectElement | null;
    bpsSelect?.addEventListener('change', () => {
        const baudRate = parseInt(bpsSelect.value, 10);
        if (!isNaN(baudRate)) {
            void changeBaudRate(baudRate);
        }
    });

    const input = document.getElementById('cmdlineInput') as HTMLInputElement | null;
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const bus = (document.getElementById('cmdlineBusSelect') as HTMLSelectElement | null)?.value ?? 'RTU';
        const modeRaw = (document.getElementById('cmdlineModeSelect') as HTMLSelectElement | null)?.value ?? 'HEX';
        const mode = (modeRaw === 'ASCII' || modeRaw === 'ASCII_FILTER' ? modeRaw : 'HEX') as ModeType;
        const frameText = (input.value ?? '').trim();
        input.value = '';
        void sendCommand(frameText, bus, mode);
    });
}

// ────────────────────────────────────────────────────────────
// Перетаскивание окна за заголовок
// ────────────────────────────────────────────────────────────

/**
 * Применяет текущее смещение к окну через transform.
 * Не трогает position/left/top — работает поверх flex-центрирования.
 */
function applyDragTransform(): void {
    const win = document.querySelector<HTMLElement>('.cmdline-window');
    if (!win) return;
    if (dragOffsetX === 0 && dragOffsetY === 0) {
        win.style.transform = '';
    } else {
        win.style.transform = `translate(${dragOffsetX}px, ${dragOffsetY}px)`;
    }
}

/**
 * Вешает обработчики перетаскивания на заголовок окна.
 * Вызывается один раз при инициализации UI.
 */
function setupCmdlineDragging(): void {
    const header = document.querySelector<HTMLElement>('#cmdlineOverlay .cmdline-header');
    const win = document.querySelector<HTMLElement>('.cmdline-window');
    if (!header || !win) return;

    header.addEventListener('mousedown', (e: MouseEvent) => {
        const target = e.target as HTMLElement;

        // Любая интерактивная цель внутри header (кнопки, поля) —
        // не начинаем drag и НЕ вызываем preventDefault, чтобы не
        // подавить click на кнопке закрытия. В WebView2 preventDefault
        // на mousedown иногда блокирует последующий click у соседних
        // элементов — из-за этого окно переставало закрываться.
        if (target.closest('button, input, select, a, textarea')) return;

        isDragging = true;
        dragStartX = e.clientX - dragOffsetX;
        dragStartY = e.clientY - dragOffsetY;
        // Запрет выделения на время drag — через CSS-свойство, без preventDefault.
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
        if (!isDragging) return;
        dragOffsetX = e.clientX - dragStartX;
        dragOffsetY = e.clientY - dragStartY;
        applyDragTransform();
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = '';
    });
}

// ────────────────────────────────────────────────────────────
// Открытие / закрытие окна
// ────────────────────────────────────────────────────────────

function openCmdline(): void {
    const overlay = document.getElementById('cmdlineOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    // Сбрасываем позицию окна — при каждом открытии оно по центру.
    dragOffsetX = 0;
    dragOffsetY = 0;
    applyDragTransform();

    const mainBps = document.getElementById('baudSelect') as HTMLSelectElement | null;
    savedBaudRate = mainBps ? parseInt(mainBps.value, 10) || 115200 : 115200;

    // Селект BPS в окне ставим равным текущей скорости порта.
    const bpsSelect = document.getElementById('cmdlineBpsSelect') as HTMLSelectElement | null;
    if (bpsSelect) bpsSelect.value = String(savedBaudRate);

    // Дефолтные три строки при каждом открытии.
    const output = document.getElementById('cmdlineOutput');
    if (output) {
        output.textContent = '';
        appendLine(output, 'Command Line (tool for advanced user)');
        appendLine(output, 'WEB Ajuster v0.1');
        appendLine(output, 'www.intmash.ru');
    }

    const input = document.getElementById('cmdlineInput') as HTMLInputElement | null;
    setTimeout(() => input?.focus(), 100);
}

function closeCmdline(): void {
    const overlay = document.getElementById('cmdlineOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');

    // Возвращаем скорость порта к той, что была до открытия окна.
    if (savedBaudRate !== null) {
        void changeBaudRate(savedBaudRate);
        savedBaudRate = null;
    }
}

// ────────────────────────────────────────────────────────────
// Смена скорости порта
// ────────────────────────────────────────────────────────────

async function changeBaudRate(baudRate: number): Promise<void> {
    const serial = (serialManager as unknown as {
        serial?: { updateBaudRate?: (b: number) => Promise<void> };
    }).serial;
    if (serial && typeof serial.updateBaudRate === 'function') {
        await serial.updateBaudRate(baudRate);
    }
}

// ────────────────────────────────────────────────────────────
// Отправка кадра и вывод ответа
// ────────────────────────────────────────────────────────────

async function sendCommand(frameText: string, bus: string, mode: ModeType): Promise<void> {
    const output = document.getElementById('cmdlineOutput');
    if (!output || !frameText) return;

    // Эхо поданной команды — как ввёл пользователь, без нормализации.
    appendLine(output, frameText, '[You]', 'cmdline-prefix-you');

    if (bus === 'TCP') {
        appendLine(output, 'MODBUS TCP не реализован в WEB-версии.', '[Err]', 'cmdline-prefix-err');
        return;
    }

    const bytes = parseHexFrame(frameText);
    if (!bytes) {
        appendLine(output, 'Неправильный формат запроса', '[Err]', 'cmdline-prefix-err');
        return;
    }

    // В историю попадают только корректно разобранные кадры.
    // Опечатки (типа "83475gfg") историю не засоряют.
    addToHistory(frameText);

    // CRC16, младший байт первым — как во всём приложении.
    const crc = calculateCRC(bytes);
    const packet = new Uint8Array(bytes.length + 2);
    packet.set(bytes, 0);
    packet[bytes.length] = crc & 0xff;
    packet[bytes.length + 1] = (crc >> 8) & 0xff;

    try {
        const result = await serialManager.executeTransactionVerbose(packet, 1000);

        if (result.kind === 'ok') {
            appendLine(output, formatReply(result.bytes, mode), '[Ok]', 'cmdline-prefix-ok');
        } else if (result.kind === 'bad_crc') {
            // Устройство ответило, но CRC не сходится. Показываем сырые байты,
            // чтобы пользователь видел, что именно пришло.
            const hexAll = formatReply(result.bytes, 'HEX');
            appendLine(
                output,
                `Ответ с неверным CRC: ${hexAll}`,
                '[Err]',
                'cmdline-prefix-err',
            );
        } else if (result.kind === 'too_short') {
            // Пришли единичные байты — это не ответ, а обрывок (помехи, эхо).
            const hexAll = formatReply(result.bytes, 'HEX');
            appendLine(output, `Ответ короче 4 байт: ${hexAll}`, '[Err]', 'cmdline-prefix-err');
        } else if (result.kind === 'timeout') {
            // Устройство молчало всё время таймаута.
            appendLine(output, 'Нет ответа от устройства (таймаут 1000 мс)', '[Err]', 'cmdline-prefix-err');
        } else if (result.kind === 'error') {
            appendLine(output, 'Ошибка транзакции: ' + result.message, '[Err]', 'cmdline-prefix-err');
        }
    } catch (err) {
        // Сюда попасть не должны: executeTransactionVerbose не бросает.
        // Оставлено на случай неожиданных исключений в самом обработчике.
        const message = err instanceof Error ? err.message : String(err);
        appendLine(output, 'Неожиданная ошибка: ' + message, '[Err]', 'cmdline-prefix-err');
    }
}

/**
 * Готовность ответа Modbus RTU: стандартные функции завершаем по длине,
 * всё нестандартное добираем таймаутом и показываем как есть.
 */
function checkReplyComplete(buf: Uint8Array): boolean {
    if (buf.length < 4) return false;
    const fc = buf[1];
    if ((fc & 0x80) !== 0) return buf.length >= 5;          // исключение Modbus
    const f = fc & 0x7f;
    if (f === 0x01 || f === 0x02 || f === 0x03 || f === 0x04) {
        return buf.length >= 3 + buf[2] + 2;
    }
    if (f === 0x05 || f === 0x06 || f === 0x0f || f === 0x10) {
        return buf.length >= 8;
    }
    return false;
}

function parseHexFrame(text: string): Uint8Array | null {
    const cleaned = text.replace(/[\s,;]+/g, '').trim();
    if (!cleaned) return null;
    if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) return null;
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
        bytes.push(parseInt(cleaned.substring(i, i + 2), 16));
    }
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

function formatReply(reply: Uint8Array, mode: ModeType): string {
    if (mode === 'HEX') {
        return Array.from(reply)
            .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
            .join(' ');
    }
    if (mode === 'ASCII') {
        return Array.from(reply).map((b) => String.fromCharCode(b)).join('');
    }
    // ASCII Filter: только печатные символы
    return Array.from(reply)
        .filter((b) => b >= 0x20 && b < 0x7f)
        .map((b) => String.fromCharCode(b))
        .join('');
}

/**
 * Добавляет строку в чёрное поле.
 *
 * Если prefix не задан — выводит обычную строку без префикса
 * (используется для шапки окна: Command Line / WEB Ajuster / www.intmash.ru).
 * Если prefix задан — добавляет слева цветной маркер ([You]/[Ok]/[Err]),
 * а сам текст переносится с выравниванием под первым словом.
 */
function appendLine(
    output: HTMLElement,
    text: string,
    prefix?: string,
    prefixClass?: string,
): void {
    const line = document.createElement('div');
    line.className = 'cmdline-line';

    if (prefix) {
        const prefixEl = document.createElement('span');
        prefixEl.className = 'cmdline-prefix' + (prefixClass ? ' ' + prefixClass : '');
        prefixEl.textContent = prefix;
        line.appendChild(prefixEl);
    }

    const textEl = document.createElement('span');
    textEl.className = 'cmdline-text';
    textEl.textContent = text;
    line.appendChild(textEl);

    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
}