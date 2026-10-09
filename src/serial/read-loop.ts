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

    // Watchdog для TCP: если 15 секунд подряд ни один батч не был получен
    // (а минимум 3 таймаута уже накопилось) — считаем соединение мёртвым.
    // Это ловит ситуацию физического обрыва Ethernet-кабеля, когда Windows
    // не сразу уведомляет сокет об ошибке, а read() продолжает возвращать
    // пустой ответ без ошибки.
    let lastSuccessAt = Date.now();
    const TCP_DEAD_MS = 15000;

    // Экспоненциальный backoff при таймаутах: если контроллер не отвечает,
    // увеличиваем паузу между итерациями. Без этого мы «флудим» 50 запросами
    // в секунду, что на многих промышленных устройствах включает временную
    // блокировку Modbus (TCP принимается, а запросы игнорируются).
    // Сбрасывается в 0 при первом же успешном ответе.
    let backoffMs = 0;
    const BACKOFF_STEP = 500;
    const BACKOFF_MAX = 5000;

    try {
        while (serial && serial.isConnected && stateObj.isPolling) {
            // Явная проверка на случай, если флаг изменился во время await
            if (!stateObj.isPolling) {
                console.log("[readLoop] Остановка цикла: isPolling стал false");
                break;
            }

            // Текущий режим отображения (RAM/XRAM) читаем из осциллографа
            // на каждой итерации: пользователь может переключить его
            // через «Свойства просмотра параметров» без перезапуска цикла.
            // Опрос должен идти по регистрам той секции, из которой
            // построены текущие каналы, иначе графики XRAM будут пустыми.
            const sectionMode: 'RAM' | 'XRAM' =
                (window as unknown as { osc?: { currentSectionMode?: 'RAM' | 'XRAM' } })
                    .osc?.currentSectionMode ?? 'RAM';

            const iniConfig: IniConfig | null = stateObj.currentIniConfig;
            if (!iniConfig || !iniConfig.isValid) {
                console.log('[readLoop] итерация: iniConfig пуст или невалиден — ждём 500 мс');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            // 1. Формируем оптимальные батчи запросов Modbus
            //    по регистрам текущей секции (RAM или XRAM).
            const batches = getOptimizedBatches(iniConfig, sectionMode, 10, 125);
            console.log(
                `[readLoop] итерация: section=${sectionMode}, ` +
                `sections=[${iniConfig.sectionNames.join(',')}], ` +
                `batches=${batches.length}`,
            );
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
                        consecutiveTimeouts = 0;
                        errorEventSent = false;
                        lastSuccessAt = Date.now();
                    } else {
                        // Таймаут или неполный ответ (executeTransaction вернул null без исключения)
                        consecutiveTimeouts++;
                    }
                } catch (err) {
                    console.error(`Read error for batch start ${startAddr}:`, err);

                    // RST от контроллера (os error 10054, "принудительно разорвал")
                    // — это не таймаут, а активный разрыв. Немедленно выходим из
                    // цикла батчей, чтобы не «долбить» мёртвый сокет.
                    const msg = err instanceof Error ? err.message : String(err);
                    const isReset = msg.includes('10054') || msg.includes('разорвано') || msg.includes('разорвал');
                    if (isReset) {
                        consecutiveTimeouts = TIMEOUT_THRESHOLD;
                        errorEventSent = true;
                        window.dispatchEvent(new CustomEvent('app:controller-not-responding', {
                            detail: { consecutiveTimeouts, reason: 'reset' },
                        }));
                        break;
                    }

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

            // ─── Watchdog для TCP ────────────────────────────────────────────────
            // Ситуация: физический обрыв Ethernet-кабеля. Windows не сразу
            // уведомляет сокет об ошибке, read() возвращает WouldBlock/пустоту
            // без ошибки. Значит consecutiveTimeouts растёт, но notifyDisconnect
            // никогда не вызывается — кнопка остаётся «1», авто-реконнект не
            // стартует, графики стоят.
            //
            // Условие: TCP-транспорт + уже накопились таймауты + прошло
            // TCP_DEAD_MS с последнего успешного батча. Тогда принудительно
            // помечаем соединение мёртвым — это вызовет onDisconnect в порту,
            // кнопка перейдёт в «E», запустится авто-реконнект.
            if (
                serial.transportKind === 'tcp' &&
                consecutiveTimeouts >= TIMEOUT_THRESHOLD &&
                Date.now() - lastSuccessAt > TCP_DEAD_MS
            ) {
                const maybe = serial as unknown as { notifyDisconnect?: () => void };
                if (typeof maybe.notifyDisconnect === 'function') {
                    console.warn(
                        `[readLoop] TCP: ${TCP_DEAD_MS} мс без успешных ответов — ` +
                        'считаем соединение мёртвым, сбрасываем isConnected',
                    );
                    maybe.notifyDisconnect();
                    break; // выходим из while — onDisconnect уже остановил опрос
                }
            }

            if (mergedDataMap.size > 0) {
                // --- 3. СИНХРОНИЗАЦИЯ С ОСЦИЛЛОГРАФОМ (через типизированные IniParameter) ---
                const ramParams: IniParameter[] = iniConfig.getSection(sectionMode);
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
            // Пересчитываем backoff по итогам итерации.
            // mergedDataMap.size > 0 — значит был хотя бы один успешный батч.
            if (mergedDataMap.size > 0) {
                backoffMs = 0;
            } else {
                backoffMs = Math.min(backoffMs + BACKOFF_STEP, BACKOFF_MAX);
            }

            const delay = (stateObj.pollDelayMs ?? 20) + backoffMs;
            await new Promise((res) => setTimeout(res, delay));
        }
    } finally {
        stateObj.isLoopRunning = false;
        console.log("DEBUG: Единый батчевый readLoop остановлен");
    }
}