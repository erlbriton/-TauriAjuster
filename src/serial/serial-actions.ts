// src/serial/serial-actions.ts

import { identifyUsbChip } from './usb.js';
import { showIdModal, updateIdBanner, closeIdModal } from '../ui/ui.js';
import { parseRegisterAddress, hexToFloat32, float32ToHex } from '../ini-manager/tree-core.js';
import { updateRowValues } from '../ini-manager/tree-ui.js';
import type { ISerialPort } from './ISerialPort.js';
import type { Oscilloscope } from '../oscilloscope/Oscilloscope.js';
import type { IOscilloscopeApi } from '../core/osc-api.js';
/** Буфер данных канала для передачи в осциллограф */
interface ChannelBuffer {
    push(v: number): void;
    get(idx: number): number;
    readonly length: number;
    readonly data: number[];
    clear(): void;
    toArray(): number[];
}
import type { AppState } from '../core/app-state.js';
import { IniConfig } from '../core/ini/index.js';
import { IniDataType, type IniParameter } from '../core/ini/index.js';
let currentLoopId = 0;
type ChunkHandler = (chunk: Uint8Array) => void;
export type CheckCompleteFn = (buffer: Uint8Array) => boolean;
export interface RegisterBatch {
    start: number;
    count: number;
}
// === ЦЕНТРАЛЬНЫЙ МЕНЕДЖЕР ПОРТА (АРХИТЕКТУРА «ЕДИНЫЙ ЧИТАТЕЛЬ») ===
class SerialManager {
    public serial: ISerialPort | null;
    public readerPromise: Promise<void> | null;
    public currentHandler: ChunkHandler | null;
    private lock: Promise<void>;
    constructor() {
        this.serial = null;
        this.readerPromise = null;
        this.currentHandler = null;
        this.lock = Promise.resolve();
    }
    public init(serial: ISerialPort): void {
        this.serial = serial;
        this.startReader();
    }
    public startReader(): void {
        if (this.readerPromise || !this.serial || !this.serial.isConnected) return;
        this.readerPromise = (async () => {
            console.log("[SerialManager] Центральный единый ридер успешно запущен.");
            while (this.serial && this.serial.isConnected) {
                try {
                    const chunk: Uint8Array | null = await this.serial.readChunk();
                    if (chunk && chunk.length > 0) {
                        if (this.currentHandler) {
                            this.currentHandler(chunk);
                        }
                    } else {
                        await new Promise((r) => setTimeout(r, 5));
                    }
                } catch (e) {
                    console.error("[SerialManager] Критическая ошибка в едином ридере:", e);
                    break;
                }
            }
            this.readerPromise = null;
            console.log("[SerialManager] Центральный единый ридер остановлен.");
        })();
    }
     public async executeTransaction(
        packet: Uint8Array,
        checkCompleteFn: CheckCompleteFn,
        timeoutMs: number = 1000
    ): Promise<Uint8Array> {
        const oldLock = this.lock;
        let release: () => void = () => { };
        this.lock = new Promise((r) => { release = r; });
        await oldLock;
        try {
            this.startReader();
            const port = this.serial;
            if (!port) {
                throw new Error("[SerialManager] Порт не инициализирован для транзакции.");
            }
            await port.write(packet);
            return await new Promise<Uint8Array>((resolve) => {
                let buffer = new Uint8Array(0);
                let timeoutId: ReturnType<typeof setTimeout> | null = null;
                const cleanUp = () => {
                    if (timeoutId) clearTimeout(timeoutId);
                    if (this.currentHandler === handleChunk) {
                        this.currentHandler = null;
                    }
                };
                const handleChunk: ChunkHandler = (chunk: Uint8Array) => {
                    let newBuffer = new Uint8Array(buffer.length + chunk.length);
                    newBuffer.set(buffer);
                    newBuffer.set(chunk, buffer.length);
                    buffer = newBuffer;
                    if (checkCompleteFn(buffer)) {
                        cleanUp();
                        resolve(buffer);
                    }
                };
                this.currentHandler = handleChunk;
                timeoutId = setTimeout(() => {
                    cleanUp();
                    resolve(buffer);
                }, timeoutMs);
            });
        } catch (err) {
            console.error("[SerialManager] Ошибка транзакции:", err);
            throw err;
        } finally {
            release();
        }
    }
}
export const serialManager = new SerialManager();
/**
 * Вычисление Modbus RTU CRC16.
 */
export function calculateCRC(buffer: Uint8Array): number {
    let crc = 0xFFFF;
    for (let pos = 0; pos < buffer.length; pos++) {
        crc ^= buffer[pos];
        for (let i = 8; i !== 0; i--) {
            if ((crc & 0x0001) !== 0) {
                crc >>= 1;
                crc ^= 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}
/**
 * Оптимизация Modbus запросов: группировка адресов регистров в батчи.
 * Разбивает запросы при дырах между адресами > maxGap или при превышении maxRegisters (125 регистров Modbus).
 */
export function getOptimizedBatches(
    config: IniConfig,
    sectionName: string = 'RAM',
    maxGap: number = 10,
    maxRegistersPerBatch: number = 125
): RegisterBatch[] {
    // Единый INI-слой уже содержит уникальные адреса с учётом 32-битных типов
    const sorted = config.getUniqueRegisterAddresses(sectionName);
    if (sorted.length === 0) return [];
    const batches: RegisterBatch[] = [];
    let currentStart = sorted[0];
    let currentEnd = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const addr = sorted[i];
        const gap = addr - currentEnd - 1;
        const newCount = (addr - currentStart + 1);
        if (gap > maxGap || newCount > maxRegistersPerBatch) {
            batches.push({
                start: currentStart,
                count: currentEnd - currentStart + 1
            });
            currentStart = addr;
            currentEnd = addr;
        } else {
            currentEnd = addr;
        }
    }
    batches.push({
        start: currentStart,
        count: currentEnd - currentStart + 1
    });
    return batches;
}
export function updateComInterfaceName(serial: ISerialPort, comSelect: HTMLSelectElement | null): string {
    if (!comSelect) return "";
    // Через интерфейс: работает и для WebSerial, и для Tauri-адаптера.
    const portInfo = serial.getPortInfo();
    const chipName = identifyUsbChip(portInfo);
    
    // ВАЖНО: НЕ уничтожаем список портов (не трогаем comSelect.innerHTML).
    // В нативной версии Tauri список портов должен оставаться доступным
    // для повторного выбора другого устройства без перезагрузки приложения.
    // Имя порта уже отображается в самом <select> как выбранное значение
    // (например, "/dev/ttyUSB0" или "COM3"), поэтому дополнительная подпись не нужна.
    
    // Меняем только визуальный стиль, чтобы показать, что порт подключён
    comSelect.className = 'select-blue';
    
    return chipName;
}
/**
 * Открывает последовательный порт без запроса ID устройства.
 * Используется при выборе порта из выпадающего списка:
 * порт открывается, инициализируется обмен, но запрос ID не посылается.
 * Для запроса ID пользователь нажимает кнопку "ID" отдельно.
 */
export async function executeDeviceConnection(
    serial: ISerialPort,
    comSelect: HTMLSelectElement | null,
    baudSelect: HTMLSelectElement | null = null
): Promise<void> {
    try {
        const baudRate = baudSelect ? parseInt(baudSelect.value, 10) || 115200 : 115200;
        
        // Если порт уже открыт — не открываем повторно
        if (!serial.isConnected) {
            await serial.connect(baudRate);
            serialManager.init(serial);
            updateComInterfaceName(serial, comSelect);
            await new Promise((r) => setTimeout(r, 500));
        }
    } catch (error: unknown) {
        // Пользователь закрыл окно выбора порта, не выбрав порт —
        // штатная ситуация: молча выходим, без окна ошибки.
        if (error instanceof Error && error.name === 'PortCancelledError') {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        showIdModal("Ошибка: " + message);
    }
}

export async function executeDeviceIdentification(serial: ISerialPort, comSelect: HTMLSelectElement | null, stateObj: AppState, baudSelect: HTMLSelectElement | null = null): Promise<void> {
    try {
        stateObj.isIdentifying = true;
        const baudRate = baudSelect ? parseInt(baudSelect.value, 10) || 115200 : 115200;
        // Если порт уже открыт (кнопкой "Подключить" или предыдущим
        // нажатием ID) — не открываем повторно: Web Serial бросает ошибку
        // повторного open() и снова показывает выбор порта. В этом случае
        // просто повторно читаем ID устройства.
        if (!serial.isConnected) {
            await serial.connect(baudRate);
            serialManager.init(serial);
            updateComInterfaceName(serial, comSelect);
            await new Promise((r) => setTimeout(r, 500));
        }
        showIdModal("Запрос ID устройства...");
        const packet = new Uint8Array([stateObj.slaveAddress & 0xFF, 0x11, 0xC0, 0x2C]);
        const checkComplete: CheckCompleteFn = (buf: Uint8Array) => {
            if (buf.length >= 3) {
                const dataLength = buf[2];
                return buf.length >= 3 + dataLength + 2 || buf.length >= 52;
            }
            return false;
        };
        const reply = await serialManager.executeTransaction(packet, checkComplete, 1500);
        if (reply && reply.length >= 3) {
            const dataLength = reply[2];
            let idText = "";
            for (let i = 3; i < Math.min(3 + dataLength, reply.length - 2); i++) {
                if (reply[i] >= 32) idText += String.fromCharCode(reply[i]);
            }
            updateIdBanner(idText.trim());
            closeIdModal();
        } else {
            showIdModal("Ошибка: Нет ответа от устройства");
        }
    } catch (error: unknown) {
        // Пользователь закрыл окно выбора порта, не выбрав порт —
        // штатная ситуация: молча выходим, без окна ошибки.
        if (error instanceof Error && error.name === 'PortCancelledError') {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        showIdModal("Ошибка: " + message);
    } finally {
        stateObj.isIdentifying = false;
    }
}

export async function readLoop(serial: ISerialPort, _parser: unknown, view: IOscilloscopeApi | null, buffers: ChannelBuffer[] | Record<string, ChannelBuffer> | Map<string, ChannelBuffer> | null, stateObj: AppState): Promise<void> {
    if (stateObj.isLoopRunning) return;
    stateObj.isLoopRunning = true;
    console.log("DEBUG: Единый батчевый readLoop запущен");

    // Счётчик подряд идущих таймаутов для уведомления "Контроллер не отвечает".
    // Бизнес-логика НЕ вызывает showIdModal — только диспетчерит событие,
    // чтобы модуль был готов к Tauri (UI-реакция настраивается в uiManager).
    let consecutiveTimeouts = 0;
    let errorEventSent = false;
    const TIMEOUT_THRESHOLD = 3;

    try {
        while (serial && serial.isConnected && stateObj.isPolling) {
            // Явная проверка на случай, если флаг изменился во время await
            if (!stateObj.isPolling) {
                console.log("[readLoop] Остановка цикла: isPolling стал false");
                break;
            }
            
            const iniConfig: IniConfig | null = stateObj.currentIniConfig;
            if (!iniConfig || !iniConfig.isValid) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            // 1. Формируем оптимальные батчи запросов Modbus
            const batches = getOptimizedBatches(iniConfig, 'RAM', 10, 125);
            if (batches.length === 0) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            serialManager.init(serial);
            const mergedDataMap = new Map<number, number>();
            // 2. Последовательный опрос батчей
            for (const batch of batches) {
                if (!serial.isConnected || !stateObj.isPolling) {
                    console.log("[readLoop] Прерывание батча: isPolling стал false");
                    break;
                }
                const { start: startAddr, count: regCount } = batch;
                const body = new Uint8Array([
                    stateObj.slaveAddress || 0x01,
                    0x03,
                    (startAddr >> 8) & 0xFF,
                    startAddr & 0xFF,
                    (regCount >> 8) & 0xFF,
                    regCount & 0xFF
                ]);
                const crc = calculateCRC(body);
                const finalPacket = new Uint8Array(8);
                finalPacket.set(body, 0);
                finalPacket[6] = crc & 0xFF;
                finalPacket[7] = (crc >> 8) & 0xFF;
                const checkComplete: CheckCompleteFn = (buf: Uint8Array) => buf.length >= 3 + (regCount * 2) + 2;
                                try {
                    const reply = await serialManager.executeTransaction(finalPacket, checkComplete, 500);
                    if (reply && reply.length >= 3 + (regCount * 2)) {
                        for (let i = 0; i < regCount; i++) {
                            const val = (reply[3 + i * 2] << 8) | reply[4 + i * 2];
                            mergedDataMap.set(startAddr + i, val);
                        }
                        // Если ранее была серия ошибок — сообщаем UI о восстановлении связи
                        if (errorEventSent) {
                            window.dispatchEvent(new CustomEvent('app:controller-responding'));
                        }
                        // Успешный ответ — сбрасываем счётчик, разрешаем повторное событие
                        consecutiveTimeouts = 0;
                        errorEventSent = false;
                    } else {
                        // Таймаут или неполный ответ (executeTransaction вернул null без исключения)
                        consecutiveTimeouts++;
                    }
                } catch (err) {
                    console.error(`Read error for batch start ${startAddr}:`, err);
                    consecutiveTimeouts++;
                }
            }

            // При серии подряд идущих ошибок диспетчерим событие для UI.
            // Бизнес-логика не знает про DOM — готова к Tauri.
            if (consecutiveTimeouts >= TIMEOUT_THRESHOLD && !errorEventSent) {
                console.warn(`[readLoop] Контроллер не отвечает ${consecutiveTimeouts} раз подряд`);
                window.dispatchEvent(new CustomEvent('app:controller-not-responding', {
                    detail: { consecutiveTimeouts },
                }));
                errorEventSent = true;
            }

            if (mergedDataMap.size > 0) {
                // --- 3. СИНХРОНИЗАЦИЯ С ОСЦИЛЛОГРАФОМ (через типизированные IniParameter) ---
                const ramParams: IniParameter[] = iniConfig.getSection('RAM');
                const oscData: Record<string, number> = {};
                                for (const param of ramParams) {
                    if (param.registerAddress === null) continue;
                    if (!mergedDataMap.has(param.registerAddress)) continue;
                    const reg = param.registerAddress;
                    const low = mergedDataMap.get(reg)!;
                    let val = 0;
                    if (param.is32Bit && mergedDataMap.has(reg + 1)) {
                        const high = mergedDataMap.get(reg + 1)!;
                        val = decode32BitValue(high, low, param.dataType);
                    } else {
                        val = decode16BitValue(low, param);
                    }
                    // raw-значение без умножения на шкалу (умножение произойдёт в Channel.updateRawValue)
                    oscData[param.id] = val;
               if (buffers && !Array.isArray(buffers)) {
                                if (buffers instanceof Map && buffers.has(param.id)) {
                                    buffers.get(param.id)?.push(val);
                                } else if (!(buffers instanceof Map) && buffers[param.id] && typeof buffers[param.id].push === 'function') {
                                    buffers[param.id].push(val);
                                }
                            }
            }//////////////////////////////////////////////////////////////////////////////////////////////////
                const activeOsc = window.osc ?? view;
                if (activeOsc) {
                    activeOsc.draw(oscData);
                }
                // --- 4. СИНХРОНИЗАЦИЯ С ТАБЛИЦЕЙ MODBUS ---
                const tableRows = document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr');
                if (tableRows.length > 0) {
                    tableRows.forEach(tr => {
                        const addrStr = tr.getAttribute('data-reg');
                        if (!addrStr) return;
                        const { reg } = parseRegisterAddress(addrStr);
                        if (reg === null || !mergedDataMap.has(reg)) return;
                        const word = mergedDataMap.get(reg)!;
                        const dataType = tr.getAttribute('data-type') || '';
                        const sub = tr.getAttribute('data-sub') || '';
                        const hIdx = parseInt(tr.getAttribute('data-hex-index') || '0', 10);
                        let parts: string[] = [];
                        try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch (e) { return; }
                        let originalHexLen = 4;
                        if (parts[hIdx] && parts[hIdx].startsWith('x')) {
                            originalHexLen = parts[hIdx].slice(1).length;
                        }
                        let scale = 1.0;
                        if (parts[6]) {
                            const parsedScale = parseFloat(parts[6].replace(',', '.'));
                            if (!isNaN(parsedScale)) scale = parsedScale;
                        }
                        const prmListOptions: Record<string, string> = {};
                        for (let j = parts.length - 1; j >= 3; j--) {
                            const part = parts[j] ? parts[j].trim() : '';
                            if (part.includes('#')) {
                                const [h, t] = part.split('#');
                                if (h && t) prmListOptions[h.toLowerCase()] = t;
                            }
                        }
                        let hexValue = '';
                        if (dataType === 'TByte' || dataType === 'TPrmList') {
                            const byteVal = (sub === 'H') ? ((word >> 8) & 0xFF) : (word & 0xFF);
                            hexValue = 'x' + byteVal.toString(16).toUpperCase().padStart(originalHexLen, '0');
                        } else if (dataType === 'TBit') {
                            const bitIndex = parseInt(sub, 16);
                            const bitVal = (word >> (isNaN(bitIndex) ? 0 : bitIndex)) & 1;
                            hexValue = 'x' + bitVal.toString(16).toUpperCase().padStart(originalHexLen, '0');
                        } else if (dataType.includes('FLOAT') || dataType.includes('DWORD') || dataType.includes('LONG') || dataType.includes('INT32')) {
                            if (mergedDataMap.has(reg + 1)) {
                                const nextWord = mergedDataMap.get(reg + 1)!;
                                hexValue = 'x' + nextWord.toString(16).toUpperCase().padStart(4, '0') + word.toString(16).toUpperCase().padStart(4, '0');
                            }
                        } else {
                            hexValue = 'x' + word.toString(16).toUpperCase().padStart(originalHexLen, '0');
                        }
                        if (hexValue && hIdx !== -1 && hIdx < parts.length) {
                            parts[hIdx] = hexValue;
                            tr.dataset.parts = JSON.stringify(parts);
                            updateRowValues(tr, parts, dataType, scale, hIdx, originalHexLen, prmListOptions, hexToFloat32, float32ToHex, 4);

                            // Подсветка расхождения База/Контроллер:
                            // сравниваем hex-ячейки (td[4] и td[6]), красим диапазон td[4..7]
                            const tds = tr.querySelectorAll('td');
                            const normHex = (t: string): string =>
                                t.trim().toUpperCase().replace(/^X/, '').replace(/^0+(?=.)/, '');
                            const hexLive = tds[4] ? (tds[4].textContent || '').trim() : '';
                            const hexBase = tds[6] ? (tds[6].textContent || '').trim() : '';
                            const mismatch =
                                hexLive.startsWith('X') &&
                                hexBase.startsWith('X') &&
                                normHex(hexLive) !== normHex(hexBase);
                            tr.classList.toggle('row-mismatch', mismatch);
                        }
                    });
                }
            }
            await new Promise((res) => setTimeout(res, stateObj.pollDelayMs ?? 20));
        }
    } finally {
        stateObj.isLoopRunning = false;
        console.log("DEBUG: Единый батчевый readLoop остановлен");
    }
}//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////\
// ── Вспомогательные функции декодирования Modbus-значений ──
/**
 * Декодирует 32-битное значение из двух 16-битных слов Modbus.
 * Учитывает тип данных (Float, Long, Int32, DWord).
 */
function decode32BitValue(high: number, low: number, dataType: IniDataType): number {
    switch (dataType) {
        case IniDataType.TFLOAT:
        case IniDataType.TFLOAT32: {
            const buf = new ArrayBuffer(4);
            const dv = new DataView(buf);
            dv.setUint16(0, high, false);
            dv.setUint16(2, low, false);
            return dv.getFloat32(0, false);
        }
        case IniDataType.TLONG:
        case IniDataType.TINT32:
            return ((high << 16) | low) | 0;
        case IniDataType.TDWORD:
            return ((high << 16) | low) >>> 0;
        default:
            return ((high << 16) | low) >>> 0;
    }
}
/**
 * Декодирует 16-битное значение с учётом типа (знак, бит).
 */
function decode16BitValue(word: number, param: IniParameter): number {
    if (param.isBit && param.bitIndex !== null) {
        return (word >> param.bitIndex) & 0x01;
    }
    // Знаковое преобразование для целых типов
    if (param.dataType === IniDataType.TSHORT || param.dataType === IniDataType.TINT16 ||
        param.dataType === IniDataType.TINTEGER) {
        return word & 0x8000 ? word - 0x10000 : word;
    }
    return word;
}

/**
 * Запись регистров по Modbus FC 0x10 (Write Multiple Registers).
 * Чистый serial-примитив, без DOM — переносим в нативные проекты.
 * Используется всегда, даже для одного регистра (по требованию протокола устройства).
 */
export async function writeRegistersFC16(
    slaveAddr: number,
    startReg: number,
    words: number[],
): Promise<boolean> {
    const qty = words.length;
    if (qty < 1) return false;

    const byteCount = qty * 2;
    const body = new Uint8Array(7 + byteCount);
    body[0] = slaveAddr & 0xff;
    body[1] = 0x10;
    body[2] = (startReg >> 8) & 0xff;
    body[3] = startReg & 0xff;
    body[4] = (qty >> 8) & 0xff;
    body[5] = qty & 0xff;
    body[6] = byteCount;
    for (let i = 0; i < qty; i++) {
        body[7 + i * 2] = (words[i] >> 8) & 0xff;
        body[7 + i * 2 + 1] = words[i] & 0xff;
    }

    const crc = calculateCRC(body);
    const packet = new Uint8Array(body.length + 2);
    packet.set(body, 0);
    packet[body.length] = crc & 0xff;
    packet[body.length + 1] = (crc >> 8) & 0xff;

    const checkComplete = (buf: Uint8Array): boolean => {
        // Нормальный ответ FC16: 8 байт (адрес, fcode, адрес регистра, количество)
        if (buf.length >= 3 && buf[1] === 0x10) return buf.length >= 8;
        // Исключение: 5 байт
        if (buf.length >= 5 && (buf[1] & 0x80)) return true;
        return false;
    };

    try {
        const reply = await serialManager.executeTransaction(packet, checkComplete, 300);
        if (!reply) return false;

        if (reply.length >= 8 && reply[1] === 0x10) {
            const echoStart = (reply[2] << 8) | reply[3];
            const echoQty = (reply[4] << 8) | reply[5];
            return echoStart === startReg && echoQty === qty;
        }

        if (reply.length >= 5 && (reply[1] & 0x80)) {
            console.error(`[MODBUS FC16] Исключение от устройства, код: 0x${reply[2].toString(16)}`);
            return false;
        }
        console.warn(`[MODBUS FC16] Нераспознанный ответ: len=${reply.length}, байты=${Array.from(reply).map((b) => b.toString(16).padStart(2, '0')).join(' ')} (ожидается: адрес + 0x10 + эхо)`);
        return false;
    } catch (err) {
        console.error('[MODBUS FC16] Ошибка транзакции:', err);
        return false;
    }
}

/**
 * Чтение регистров по Modbus FC 0x03 (Read Holding Registers).
 * Чистый serial-примитив, без DOM — переносим в нативные проекты.
 * Возвращает массив прочитанных слов или null при ошибке/таймауте.
 */
export async function readHoldingRegistersFC03(
    slaveAddr: number,
    startReg: number,
    count: number,
): Promise<number[] | null> {
    if (count < 1 || count > 125) return null;

    const body = new Uint8Array([
        slaveAddr & 0xff,
        0x03,
        (startReg >> 8) & 0xff,
        startReg & 0xff,
        (count >> 8) & 0xff,
        count & 0xff,
    ]);

    const crc = calculateCRC(body);
    const packet = new Uint8Array(8);
    packet.set(body, 0);
    packet[6] = crc & 0xff;
    packet[7] = (crc >> 8) & 0xff;

    const checkComplete = (buf: Uint8Array): boolean => {
        if (buf.length >= 3 && buf[1] === 0x03) {
            const byteCount = buf[2];
            return buf.length >= 3 + byteCount + 2;
        }
        if (buf.length >= 5 && (buf[1] & 0x80)) return true;
        return false;
    };

    try {
        const reply = await serialManager.executeTransaction(packet, checkComplete, 300);
        if (!reply) return null;

        if (reply.length >= 3 && reply[1] === 0x03) {
            const byteCount = reply[2];
            if (byteCount !== count * 2) return null;
            if (reply.length < 3 + byteCount + 2) return null;

            const words: number[] = [];
            for (let i = 0; i < count; i++) {
                const hi = reply[3 + i * 2];
                const lo = reply[4 + i * 2];
                words.push(((hi & 0xff) << 8) | (lo & 0xff));
            }
            return words;
        }

        if (reply.length >= 5 && (reply[1] & 0x80)) {
            console.error(`[MODBUS FC03] Исключение от устройства, код: 0x${reply[2].toString(16)}`);
            return null;
        }
        return null;
    } catch (err) {
        console.error('[MODBUS FC03] Ошибка транзакции:', err);
        return null;
    }
}