// src/ui/cmdline-ui.ts
/**
 * Командная строка Modbus (инструмент продвинутого пользователя).
 *
 * - пользователь вводит кадр БЕЗ CRC — CRC16 дописывается автоматически;
 * - в чёрное поле выводится ТОЛЬКО ответ контроллера,
 *   в формате выбранного MODE (HEX / ASCII / ASCII Filter);
 * - BPS в окне автономный: при открытии запоминается скорость основного
 *   соединения, при закрытии окна — восстанавливается;
 * - ничего больше (осциллограф, таблица) не останавливается.
 */
import { serialManager, calculateCRC } from '../serial/serial-actions.js';

type ModeType = 'HEX' | 'ASCII' | 'ASCII_FILTER';

/** Скорость основного соединения до открытия окна (для восстановления) */
let savedBaudRate: number | null = null;

export function initCmdlineUI(): void {
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
// Открытие / закрытие окна
// ────────────────────────────────────────────────────────────

function openCmdline(): void {
    const overlay = document.getElementById('cmdlineOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    // Запоминаем скорость основного соединения — вернём при закрытии.
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

    if (bus === 'TCP') {
        appendLine(output, 'MODBUS TCP не реализован в WEB-версии.');
        return;
    }

    const bytes = parseHexFrame(frameText);
    if (!bytes) {
        appendLine(output, 'Ошибка: неверный формат кадра (ожидается hex без CRC, напр.: 01 03 00 00 00 02)');
        return;
    }

    // CRC16, младший байт первым — как во всём приложении.
    const crc = calculateCRC(bytes);
    const packet = new Uint8Array(bytes.length + 2);
    packet.set(bytes, 0);
    packet[bytes.length] = crc & 0xff;
    packet[bytes.length + 1] = (crc >> 8) & 0xff;

    try {
        const reply = await serialManager.executeTransaction(packet, checkReplyComplete, 1000);
        if (reply && reply.length > 0) {
            appendLine(output, formatReply(reply, mode));
        } else {
            // Контроллер промолчал: в чёрное поле ничего не пишем,
            // диагностика — в консоль.
            console.log('[cmdline] нет ответа от устройства');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLine(output, 'Ошибка транзакции: ' + message);
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

function appendLine(output: HTMLElement, text: string): void {
    output.textContent += text + '\n';
    output.scrollTop = output.scrollHeight;
}