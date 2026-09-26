// src/serial/read-loop.ts
// Главный цикл опроса контроллера по Modbus RTU.
//
// Что делает:
//   1. Раз в pollDelayMs запрашивает у контроллера все регистры секции RAM,
//      сгруппированные в оптимальные батчи (см. modbus-crc.ts).
//   2. Декодирует полученные значения по типам параметров
//      (см. modbus-functions.ts).
//   3. Синхронизирует результаты:
//      - с осциллографом (через window.osc.draw),
//      - с буферами каналов,
//      - с таблицей Modbus в DOM (updateRowValues + подсветка расхождений).
//
// Бизнес-логика не работает с UI напрямую — только диспетчерит события
// (app:controller-responding, app:controller-not-responding). UI-реакция
// настраивается в uiManager.

import { serialManager } from './serial-manager.js';
import type { CheckCompleteFn } from './serial-manager.js';
import { calculateCRC, getOptimizedBatches } from './modbus-crc.js';
import { decode32BitValue, decode16BitValue } from './modbus-functions.js';
import {
    parseRegisterAddress,
    hexToFloat32,
    float32ToHex,
} from '../ini-manager/tree-core.js';
import { updateRowValues } from '../ini-manager/tree-ui.js';
import type { ISerialPort } from './ISerialPort.js';
import type { IOscilloscopeApi } from '../core/osc-api.js';
import type { AppState } from '../core/app-state.js';
import { IniConfig } from '../core/ini/index.js';
import type { IniParameter } from '../core/ini/index.js';

/** Буфер данных канала для передачи в осциллограф */
interface ChannelBuffer {
    push(v: number): void;
    get(idx: number): number;
    readonly length: number;
    readonly data: number[];
    clear(): void;
    toArray(): number[];
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
}