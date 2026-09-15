/// src/core/modbus-scanner.ts

import { serialManager, calculateCRC, type CheckCompleteFn } from '../serial/serial-actions.js';
/** Одна найденная запись в сети Modbus */
export interface FoundDevice {
    /** Адрес slave (1..247) */
    addr: number;
    /** Текст ID устройства, распарсенный из ответа 0x11 */
    idText: string;
    /** "Сырой" ответ устройства (для возможной передачи дальше) */
    rawReply: Uint8Array;
}

/** Параметры запуска сканирования */
export interface ScanOptions {
    /** Начальный адрес (по умолчанию 1) */
    startAddr?: number;
    /** Конечный адрес (по умолчанию 247) */
    endAddr?: number;
    /** Таймаут ожидания ответа на один адрес, мс (по умолчанию 300) */
    timeoutMs?: number;
    /** Текущий таймаут перед каждым адресом — позволяет менять его во время поиска */
    getTimeoutMs?: () => number;
    /** Сигнал прерывания. При abort() сканирование останавливается на следующем адресе */
    signal?: AbortSignal;
    /** Пауза между адресами, мс (по умолчанию 20) — дать шине остыть */
    pauseMs?: number;
}

/** Прогресс сканирования */
export interface ScanProgress {
    /** Текущий опрашиваемый адрес */
    currentAddr: number;
    /** Количество найденных устройств */
    foundCount: number;
    /** Общий диапазон (endAddr - startAddr + 1) */
    total: number;
}

/**
 * Сканирует сеть Modbus-RTU функцией 0x11 (Report Slave ID).
 * Вызывает onFound по мере обнаружения устройств, onProgress — на каждом адресе.
 * Возвращает массив всех найденных устройств.
 *
 * Платформо-независимый модуль: использует только абстрактный serialManager.
 */
export async function scanModbusNetwork(
    options: ScanOptions,
    onProgress?: (progress: ScanProgress) => void,
    onFound?: (device: FoundDevice) => void,
): Promise<FoundDevice[]> {
    const startAddr = options.startAddr ?? 1;
    const endAddr = options.endAddr ?? 247;
    const timeoutMs = options.timeoutMs ?? 300;
    const pauseMs = options.pauseMs ?? 20;

    const found: FoundDevice[] = [];
    const total = Math.max(0, endAddr - startAddr + 1);

    for (let addr = startAddr; addr <= endAddr; addr++) {
        // Прерывание по сигналу
        if (options.signal?.aborted) break;

        onProgress?.({ currentAddr: addr, foundCount: found.length, total });

        try {
            const device = await probeAddress(addr, options.getTimeoutMs?.() ?? timeoutMs);
            if (device) {
                found.push(device);
                onFound?.(device);
            }
        } catch (err) {
            console.warn(`[modbus-scanner] адрес ${addr}: ошибка —`, err);
        }

        // Пауза между адресами (прерываема сигналом)
        if (pauseMs > 0 && addr < endAddr && !options.signal?.aborted) {
            await abortableSleep(pauseMs, options.signal);
        }
    }

    return found;
}

/**
 * Опрашивает один адрес командой 0x11.
 * Возвращает FoundDevice при валидном ответе, null — если таймаут/исключение/битый CRC.
 */
async function probeAddress(addr: number, timeoutMs: number): Promise<FoundDevice | null> {
    if (addr < 0 || addr > 247) return null;

    // Кадр: [адрес, функция 0x11, crcLo, crcHi] — CRC считаем штатной функцией проекта
    const body = new Uint8Array([addr & 0xFF, 0x11]);
    const crc = calculateCRC(body);
    const packet = new Uint8Array([body[0], body[1], crc & 0xFF, (crc >> 8) & 0xFF]);

    // Условие завершения: пришёл ответ с валидным dataLength
    const checkComplete: CheckCompleteFn = (buf: Uint8Array) => {
        if (buf.length < 3) return false;
        // Исключение (0x91) — не считаем устройством
        if (buf[1] === 0x91) return true;
        const dataLength = buf[2];
        return buf.length >= 3 + dataLength + 2;
    };

    let reply: Uint8Array | null;
    try {
        reply = await serialManager.executeTransaction(packet, checkComplete, timeoutMs);
    } catch {
        return null;
    }

    if (!reply || reply.length < 3) return null;

    // Исключение (0x91) — устройство не считаем найденным
    if (reply[1] === 0x91) return null;

    // Проверка CRC ответа штатной функцией проекта
    const expectedCrc = calculateCRC(reply.subarray(0, reply.length - 2));
    const gotCrc = reply[reply.length - 2] | (reply[reply.length - 1] << 8);
    if (expectedCrc !== gotCrc) return null;

    // Адрес в ответе должен совпадать
    if (reply[0] !== (addr & 0xFF)) return null;

    // Функция должна быть 0x11 (не 0x11 + 0x80 = 0x91 — уже отсеяли выше)
    if (reply[1] !== 0x11) return null;

    const dataLength = reply[2];
    let idText = '';
    for (let i = 3; i < Math.min(3 + dataLength, reply.length - 2); i++) {
        if (reply[i] >= 32 && reply[i] < 127) {
            idText += String.fromCharCode(reply[i]);
        }
    }

    return { addr, idText: idText.trim(), rawReply: reply };
}

/** Пауза, прерываемая AbortSignal */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(t);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}