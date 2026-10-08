// src/table-editor/copy-ops.ts

// Операции массового копирования значений между Базой и Контроллером.

import { updateMismatchClass, baseControllerMismatch } from './controller-write.js';
import { planControllerWrite } from '../ini-manager/tree-core.js';
import { writeRegistersFC16, readHoldingRegistersFC03 } from '../serial/serial-actions.js';
import { getTableEditorState } from '../ini-manager/table-editor.js';

/**
 * Копирует значения Контроллера (колонки 6,7) в Базу (колонки 4,5)
 * для всех строк таблицы — только в памяти браузера.
 * Возвращает количество обработанных строк.
 */
export function copyControllerToBase(): number {
    const rows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
    );
    let copied = 0;

    for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 8) continue;

        const baseHex = tds[4];
        const basePhys = tds[5];
        const ctrlHex = tds[6];
        const ctrlPhys = tds[7];
        if (!baseHex || !basePhys || !ctrlHex || !ctrlPhys) continue;

        // Не копируем пустые и прочерки — там нет живого значения
        const ctrlHexText = (ctrlHex.textContent || '').trim();
        if (!ctrlHexText || ctrlHexText === '—') continue;

        // Переписываем содержимое ячеек Контроллера в Базу
        baseHex.innerHTML = ctrlHex.innerHTML;
        basePhys.innerHTML = ctrlPhys.innerHTML;

        // Пересчитываем подсветку расхождения (после копирования — совпадает, станет чёрной)
        const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
        updateMismatchClass(tr, dataType);

        copied++;
    }

    return copied;
}

// ─────────────────────────────────────────────
// База → Контроллер (двухфазная запись по Modbus)
// ─────────────────────────────────────────────
//
// СХЕМА (важно, не удалять):
//   Фаза 1. Для каждого параметра — только ЗАПИСЬ (FC16). Без чтения после
//           каждой записи, без паузы 500 мс, без повторов. Результат записи
//           (успех/таймаут) игнорируется: устройство могло выполнить кадр
//           молча (окно сохранения в энергонезависимую память ~1–1,5 с).
//   Фаза 2. После всех записей — ОДНО групповое чтение всех затронутых
//           регистров батчами (до 125 регистров на пакет FC03). Ячейки
//           Контроллера обновляются только у тех параметров, где прочитанное
//           значение совпало с записанным.
//   Окна и модалки не показываются ни при успехе, ни при ошибке.
//           Если что-то не записалось — строка подсветится автоматически
//           классом row-mismatch (механизм уже есть в updateMismatchClass).
//
// Скорость: на 180 параметров раньше было 5–6 минут (read+паузы после каждой
// записи), теперь — один проход записи + 1–3 пакета чтения в конце.

interface WrittenTarget {
    tr: HTMLTableRowElement;
    startReg: number;
    /** Слова, которые должны оказаться в регистрах после успешной записи. */
    expectedWords: number[];
    dataType: string;
    /** Hex-строка Базы — попадает в parts[hexIndex] при успехе. */
    baseText: string;
    hexIndex: number;
    kind: 'words' | 'byte' | 'bit';
    byteValue: number;
    bytePos: 'L' | 'H';
    bitValue: number;
}

/** Считает батчи адресов (как getOptimizedBatches, но для массива адресов). */
function buildBatches(
    addresses: number[],
    maxGap = 10,
    maxRegisters = 125,
): { start: number; count: number }[] {
    const sorted = [...new Set(addresses)].sort((a, b) => a - b);
    if (sorted.length === 0) return [];

    const batches: { start: number; count: number }[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        const addr = sorted[i];
        const gap = addr - end - 1;
        const newCount = addr - start + 1;
        if (gap > maxGap || newCount > maxRegisters) {
            batches.push({ start, count: end - start + 1 });
            start = addr;
            end = addr;
        } else {
            end = addr;
        }
    }
    batches.push({ start, count: end - start + 1 });
    return batches;
}

/**
 * Фаза 1 для одной строки: записать значение в контроллер БЕЗ обратного чтения.
 * Для byte/bit предварительное чтение всё равно нужно — чтобы подставить байт/бит
 * в текущее слово, не затерев соседние биты. Для words — только запись.
 *
 * Возвращает описание записи (для фазы 2) или null, если строку нельзя записать.
 */
async function writeOneTarget(
    tr: HTMLTableRowElement,
    slaveAddr: number,
): Promise<WrittenTarget | null> {
    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
    const sub = tr.getAttribute('data-sub') || '';
    const tds = tr.querySelectorAll('td');

    let parts: string[] = [];
    try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { parts = []; }

    let scale = 1.0;
    if (parts.length > 6 && parts[6]) {
        const parsedScale = parseFloat(parts[6].replace(',', '.'));
        if (!isNaN(parsedScale) && parsedScale !== 0) scale = parsedScale;
    }

    let bytePos: '' | 'L' | 'H' = '';
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        bytePos = (sub || '').toUpperCase() as 'L' | 'H';
    }

    const baseText = (tds[4]?.textContent || '').trim();
    let valueStr = '';
    let editType: 'hex' | 'phys' = 'hex';

    if (dataType === 'TPRMLIST') {
        let found = '';
        for (const p of parts) {
            const part = (p || '').trim();
            if (part.includes('#')) {
                const [h, t] = part.split('#');
                if (h && t && t.trim() === baseText) { found = h.trim(); break; }
            }
        }
        if (!found) return null;
        valueStr = found;
    } else if (dataType === 'TBIT') {
        valueStr = baseText;
        editType = 'phys';
    } else {
        valueStr = baseText;
    }

    const plan = planControllerWrite(dataType, editType, valueStr, scale, sub, bytePos);
    if (!plan.ok) return null;

    const reg = parseInt(tr.getAttribute('data-reg') || '', 16);
    if (isNaN(reg)) return null;

    const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);

    // ── WORDS: пишем без чтения ─────────────────────────────────────────────
    if (plan.kind === 'words') {
        await writeRegistersFC16(slaveAddr, reg, plan.words);
        return {
            tr, startReg: reg, expectedWords: plan.words, dataType,
            baseText, hexIndex, kind: 'words',
            byteValue: 0, bytePos: 'L', bitValue: 0,
        };
    }

    // ── BYTE: read-modify-write (соседний байт нельзя затирать) ─────────────
    if (plan.kind === 'byte') {
        const words = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!words) return null;
        const currentWord = words[0];
        const highByte = (currentWord >> 8) & 0xFF;
        const lowByte = currentWord & 0xFF;
        const newWord = plan.bytePos === 'H'
            ? ((plan.byteValue << 8) | lowByte) & 0xFFFF
            : ((highByte << 8) | plan.byteValue) & 0xFFFF;
        await writeRegistersFC16(slaveAddr, reg, [newWord]);
        return {
            tr, startReg: reg, expectedWords: [newWord], dataType,
            baseText, hexIndex, kind: 'byte',
            byteValue: plan.byteValue, bytePos: plan.bytePos, bitValue: 0,
        };
    }

    // ── BIT: read-modify-write (соседние биты нельзя затирать) ──────────────
    if (plan.kind === 'bit') {
        const words = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!words) return null;
        const currentWord = words[0];
        const bitMask = 1 << plan.bitIndex;
        const newWord = plan.bitValue === 1
            ? (currentWord | bitMask) & 0xFFFF
            : (currentWord & ~bitMask) & 0xFFFF;
        await writeRegistersFC16(slaveAddr, reg, [newWord]);
        return {
            tr, startReg: reg, expectedWords: [newWord], dataType,
            baseText, hexIndex, kind: 'bit',
            byteValue: 0, bytePos: 'L', bitValue: plan.bitValue,
        };
    }

    return null;
}

/**
 * Фаза 2: сгруппированное чтение всех затронутых регистров и обновление ячеек.
 * Обновляем ячейки только там, где прочитанное совпало с записанным.
 * Для несовпавших строк — ничего не трогаем, они подсветятся row-mismatch.
 */
async function readBackAndUpdateUI(
    written: WrittenTarget[],
    slaveAddr: number,
): Promise<void> {
    if (written.length === 0) return;

    // Собираем все адреса, которые нужно прочитать (с учётом 32-битных слов).
    const allAddrs = new Set<number>();
    for (const w of written) {
        for (let i = 0; i < w.expectedWords.length; i++) {
            allAddrs.add(w.startReg + i);
        }
    }

    const batches = buildBatches([...allAddrs], 10, 125);
    console.log(
        `[BASE→CONTROLLER] Обратное чтение: ${allAddrs.size} регистров в ${batches.length} батч(ах)`,
    );

    const readMap = new Map<number, number>();
    for (const b of batches) {
        const words = await readHoldingRegistersFC03(slaveAddr, b.start, b.count);
        if (!words) {
            console.warn(`[BASE→CONTROLLER] Батч r${b.start.toString(16)}..r${(b.start + b.count - 1).toString(16)} не прочитан`);
            continue;
        }
        for (let i = 0; i < words.length; i++) {
            readMap.set(b.start + i, words[i]);
        }
    }

    let updated = 0;
    for (const w of written) {
        // Проверяем, что все записанные слова прочитались обратно без изменений.
        let allMatch = true;
        for (let i = 0; i < w.expectedWords.length; i++) {
            if (readMap.get(w.startReg + i) !== w.expectedWords[i]) {
                allMatch = false;
                break;
            }
        }
        if (!allMatch) continue;

        const tds = w.tr.querySelectorAll('td');
        if (tds[6] && tds[4]) tds[6].innerHTML = tds[4].innerHTML;
        if (tds[7] && tds[5]) tds[7].innerHTML = tds[5].innerHTML;

        let parts: string[] = [];
        try { parts = JSON.parse(w.tr.dataset.parts || '[]'); } catch { parts = []; }

        if (w.hexIndex >= 0 && w.hexIndex < parts.length) {
            if (w.kind === 'words') {
                parts[w.hexIndex] = w.baseText;
            } else if (w.kind === 'byte') {
                const byteHex = 'x' + w.byteValue.toString(16).toUpperCase().padStart(2, '0');
                parts[w.hexIndex] = byteHex;
            } else if (w.kind === 'bit') {
                const bitHex = 'x' + String(w.bitValue).padStart(4, '0');
                parts[w.hexIndex] = bitHex;
                if (parts.length > 0) parts[parts.length - 1] = bitHex;
            }
        }
        w.tr.dataset.parts = JSON.stringify(parts);

        updateMismatchClass(w.tr, w.dataType);
        updated++;
    }

    console.log(
        `[BASE→CONTROLLER] Подтверждено чтением: ${updated} из ${written.length}`,
    );
}

/**
 * Копирует в Контроллер только параметры, где База ≠ Контроллер.
 * Двухфазная схема: сначала все записи, потом одно групповое чтение.
 * Никаких модальных окон — успех/ошибка видны по подсветке строк.
 */
export async function copyBaseToController(): Promise<void> {
    const stateObj = getTableEditorState();
    const slaveAddr = stateObj?.slaveAddress ?? 0x01;

    const rows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
    );

    // Отбираем строки: есть регистр И База ≠ Контроллер
    const targets: HTMLTableRowElement[] = [];
    for (const tr of rows) {
        const addrStr = tr.getAttribute('data-reg');
        if (!addrStr || isNaN(parseInt(addrStr, 16))) continue;
        const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
        if (!baseControllerMismatch(tr, dataType)) continue;
        targets.push(tr);
    }

    if (targets.length === 0) {
        console.log('[BASE→CONTROLLER] Расхождений База/Контроллер нет — запись не требуется.');
        return;
    }

    console.log(`[BASE→CONTROLLER] Параметров к записи: ${targets.length}`);

    const wasPolling = stateObj?.isPolling === true;
    if (wasPolling && stateObj) {
        stateObj.isPolling = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const written: WrittenTarget[] = [];

    try {
        // ─── ФАЗА 1: запись всех параметров (без чтения после каждой) ────────
        const t0 = Date.now();
        for (const tr of targets) {
            const result = await writeOneTarget(tr, slaveAddr);
            if (result) written.push(result);
        }
        console.log(
            `[BASE→CONTROLLER] Фаза 1 (запись): ${written.length} из ${targets.length} за ${Date.now() - t0} мс`,
        );

        // ─── ФАЗА 2: групповое чтение всех записанных регистров ──────────────
        const t1 = Date.now();
        await readBackAndUpdateUI(written, slaveAddr);
        console.log(`[BASE→CONTROLLER] Фаза 2 (чтение + UI): ${Date.now() - t1} мс`);
    } finally {
        if (wasPolling && stateObj) {
            stateObj.isPolling = true;
        }
    }

    // КРИТИЧНО: перед диспатчем события request-polling-restart нужно
    // дождаться, когда старый readLoop полностью завершится и сбросит
    // isLoopRunning = false. См. комментарий в предыдущей версии — логика
    // не изменилась.
    if (wasPolling) {
        const appStateRef = (window as unknown as {
            appState?: { isLoopRunning?: boolean };
        }).appState;

        const waitForLoopStop = async (): Promise<void> => {
            const MAX_WAIT_MS = 2000;
            const STEP_MS = 50;
            let waited = 0;
            while (appStateRef?.isLoopRunning && waited < MAX_WAIT_MS) {
                await new Promise((r) => setTimeout(r, STEP_MS));
                waited += STEP_MS;
            }
            if (appStateRef?.isLoopRunning) {
                console.warn(
                    '[BASE→CONTROLLER] readLoop не завершился за 2 сек — ' +
                    'перезапуск может не сработать',
                );
            }
        };
        void waitForLoopStop().then(() => {
            window.dispatchEvent(new CustomEvent('app:request-polling-restart'));
        });
    }
}





// // src/table-editor/copy-ops.ts

// // Операции массового копирования значений между Базой и Контроллером.

// import { updateMismatchClass, baseControllerMismatch } from './controller-write.js';
// import { planControllerWrite } from '../ini-manager/tree-core.js';
// import { writeRegistersFC16, readHoldingRegistersFC03 } from '../serial/serial-actions.js';
// import { getTableEditorState } from '../ini-manager/table-editor.js';
// import { showFailedParamsList } from '../ui/confirm-dialog.js';
// import { serialManager } from '../serial/serial-actions.js';

// /**
//  * Копирует значения Контроллера (колонки 6,7) в Базу (колонки 4,5)
//  * для всех строк таблицы — только в памяти браузера.
//  * Возвращает количество обработанных строк.
//  */
// export function copyControllerToBase(): number {
//     const rows = Array.from(
//         document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
//     );
//     let copied = 0;

//     for (const tr of rows) {
//         const tds = tr.querySelectorAll('td');
//         if (tds.length < 8) continue;

//         const baseHex = tds[4];
//         const basePhys = tds[5];
//         const ctrlHex = tds[6];
//         const ctrlPhys = tds[7];
//         if (!baseHex || !basePhys || !ctrlHex || !ctrlPhys) continue;

//         // Не копируем пустые и прочерки — там нет живого значения
//         const ctrlHexText = (ctrlHex.textContent || '').trim();
//         if (!ctrlHexText || ctrlHexText === '—') continue;

//         // Переписываем содержимое ячеек Контроллера в Базу
//         baseHex.innerHTML = ctrlHex.innerHTML;
//         basePhys.innerHTML = ctrlPhys.innerHTML;

//         // Пересчитываем подсветку расхождения (после копирования — совпадает, станет чёрной)
//         const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
//         updateMismatchClass(tr, dataType);

//         copied++;
//     }

//     return copied;
// }

// // ─────────────────────────────────────────────
// // База → Контроллер (реальная запись по Modbus)
// // ─────────────────────────────────────────────

// /** Запись одной строки Базы в Контроллер с проверкой. true — успех. */
// /**
//  * Записывает одну строку таблицы в контроллер и проверяет запись.
//  *
//  * Философия надёжности (важно, не удалять):
//  *  - Modbus RTU — ненадёжная среда; контроллер может не ответить на кадр,
//  *    хотя выполнил его (окно молчания ~1–1,5 с после первого изменения
//  *    значений — сохранение в энергонезависимую память);
//  *  - поэтому таймаут не считается отказом, а критерий истины — обратное чтение;
//  *  - ветка 'words' реализует проверку с повтором чтения внутри;
//  *    ветки 'byte' и 'bit' полагаются на внешний идемпотентный повтор
//  *    в copyBaseToController.
//  *
//  * Возвращает true ТОЛЬКО если обратное чтение совпало с записанным.
//  */
// async function writeBaseRowToController(
//     tr: HTMLTableRowElement,
//     slaveAddr: number,
// ): Promise<boolean> {
//     const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
//     const sub = tr.getAttribute('data-sub') || '';
//     const tds = tr.querySelectorAll('td');

//     let parts: string[] = [];
//     try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { parts = []; }

//     let scale = 1.0;
//     if (parts.length > 6 && parts[6]) {
//         const parsedScale = parseFloat(parts[6].replace(',', '.'));
//         if (!isNaN(parsedScale) && parsedScale !== 0) scale = parsedScale;
//     }

//     let bytePos = '';
//     if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
//         bytePos = (sub || '').toUpperCase();
//     }

//        // Значение Базы в формате входа planControllerWrite
//     const baseText = (tds[4]?.textContent || '').trim();
//     console.log(`[BATCH-DIAG] row=${tr.getAttribute('data-key')}, dataType=${dataType}, baseText="${baseText}", tds[4].innerHTML=${tds[4]?.innerHTML}`);
//     let valueStr = '';
//     let editType: 'hex' | 'phys' = 'hex';

//     if (dataType === 'TPRMLIST') {
//         // Текст опции → hex через список опций из data-parts
//         let found = '';
//         for (const p of parts) {
//             const part = (p || '').trim();
//             if (part.includes('#')) {
//                 const [h, t] = part.split('#');
//                 if (h && t && t.trim() === baseText) { found = h.trim(); break; }
//             }
//         }
//         if (!found) return false;
//         valueStr = found;
//     } else if (dataType === 'TBIT') {
//         valueStr = baseText; // '0'/'1'
//         editType = 'phys';
//     } else {
//         valueStr = baseText; // 'x0014' / 'xC0A80064'
//     }

//     const plan = planControllerWrite(dataType, editType, valueStr, scale, sub, bytePos);
//     console.log(`[BATCH-DIAG] plan:`, JSON.stringify(plan));
//     if (!plan.ok) {
//         console.warn(`[BATCH-DIAG] plan.ok=false, пропускаю строку ${tr.getAttribute('data-key')}`);
//         return false;
//     }

//     const reg = parseInt(tr.getAttribute('data-reg') || '', 16);
//     if (isNaN(reg)) return false;

//     // ── Запись + обратное чтение + сравнение ──
//         const rowId = tr.getAttribute('data-key') || '';
//     if (plan.kind === 'words') {
//         // Шаг 1: сама запись (FC16).
//         // ВАЖНО: отсутствие ответа — НЕ отказ: устройство могло выполнить кадр
//         // молча (окно сохранения, см. комментарий-стратегию в copyBaseToController).
//         // В этом случае даём паузу и переходим к проверке: истину скажет только чтение.
//         const writeOk = await writeRegistersFC16(slaveAddr, reg, plan.words);
//         if (!writeOk) {
//             console.warn(`[BASE→CONTROLLER] ${rowId}: нет ответа на FC16 (reg=${reg.toString(16)}), проверяю чтением`);
//             await new Promise((r) => setTimeout(r, 500));
//         }
//         // Шаг 2: проверка обратным чтением (FC03).
//         // Чтение тоже может попасть в окно молчания устройства, поэтому при первом
//         // отказе — одна повторная попытка с паузой. Лишь повторный отказ — настоящий.
//         let readWords = await readHoldingRegistersFC03(slaveAddr, reg, plan.words.length);
//         if (!readWords) {
//             await new Promise((r) => setTimeout(r, 500));
//             readWords = await readHoldingRegistersFC03(slaveAddr, reg, plan.words.length);
//         }
//         if (!readWords) {
//             console.warn(`[BASE→CONTROLLER] ${rowId}: отказ обратного чтения FC03 (reg=${reg.toString(16)})`);
//             return false;
//         }
//         // Шаг 3: сверка записанного с прочитанным.
//         // Несовпадение = устройство реально не применило значение: сообщаем об отказе,
//         // внешний повтор в copyBaseToController попробует ещё раз.
//         if (!(readWords.length === plan.words.length && plan.words.every((w, i) => readWords[i] === w))) {
//             console.warn(`[BASE→CONTROLLER] ${rowId}: НЕСОВПАДЕНИЕ при проверке: записано ${plan.words.map((w) => w.toString(16)).join(',')}, прочитано ${readWords.map((w) => w.toString(16)).join(',')}`);
//             return false;
//         }
//     } else if (plan.kind === 'byte') {
//         const currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
//         if (!currentWords) return false;
//         const currentWord = currentWords[0];
//         const highByte = (currentWord >> 8) & 0xFF;
//         const lowByte = currentWord & 0xFF;
//         const newWord = plan.bytePos === 'H'
//             ? ((plan.byteValue << 8) | lowByte) & 0xFFFF
//             : ((highByte << 8) | plan.byteValue) & 0xFFFF;
//         const writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
//         if (!writeOk) return false;
//         const readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
//         if (!readWords) return false;
//         const readByte = plan.bytePos === 'H' ? (readWords[0] >> 8) & 0xFF : readWords[0] & 0xFF;
//         if (readByte !== plan.byteValue) return false;
//     } else if (plan.kind === 'bit') {
//         const currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
//         if (!currentWords) return false;
//         const currentWord = currentWords[0];
//         const bitMask = 1 << plan.bitIndex;
//         const newWord = plan.bitValue === 1
//             ? (currentWord | bitMask) & 0xFFFF
//             : (currentWord & ~bitMask) & 0xFFFF;
//         const writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
//         if (!writeOk) return false;
//         const readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
//         if (!readWords) return false;
//         const readBit = (readWords[0] >> plan.bitIndex) & 1;
//         if (readBit !== plan.bitValue) return false;
//     } else {
//         return false;
//     }

//     // ── Синхронизация UI: Контроллер = База ──
//     if (tds[6] && tds[4]) tds[6].innerHTML = tds[4].innerHTML;
//     if (tds[7] && tds[5]) tds[7].innerHTML = tds[5].innerHTML;

//     const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
//     if (plan.kind === 'words') {
//         if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = baseText;
//     } else if (plan.kind === 'byte') {
//         const byteHex = 'x' + plan.byteValue.toString(16).toUpperCase().padStart(2, '0');
//         if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = byteHex;
//     } else {
//         const bitHex = 'x' + (plan.newPhys || '0').padStart(4, '0');
//         if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = bitHex;
//         if (parts.length > 0) parts[parts.length - 1] = bitHex;
//     }
//     tr.dataset.parts = JSON.stringify(parts);

//     updateMismatchClass(tr, dataType);
//     return true;
// }

// /**
//  * Копирует в Контроллер только параметры, где База ≠ Контроллер.
//  * Реальная запись по Modbus + обратное чтение + сравнение.
//  * При полном успехе — тихо (лог). При ошибках — одно окно со списком и скроллингом.
//  */
// export async function copyBaseToController(): Promise<void> {
//     const stateObj = getTableEditorState();
//     const slaveAddr = stateObj?.slaveAddress ?? 0x01;

//     const rows = Array.from(
//         document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr'),
//     );

//     // Отбираем строки: есть регистр И База ≠ Контроллер
//     const targets: HTMLTableRowElement[] = [];
    
//     for (const tr of rows) {
//         const addrStr = tr.getAttribute('data-reg');
//         if (!addrStr || isNaN(parseInt(addrStr, 16))) continue;
//         const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
//         if (!baseControllerMismatch(tr, dataType)) continue;
//         targets.push(tr);
//     }

//     if (targets.length === 0) {
//         console.log('[BASE→CONTROLLER] Расхождений База/Контроллер нет — запись не требуется.');
//         return;
//     }

//     console.log(`[BASE→CONTROLLER] Параметров к записи: ${targets.length}`);

//     const wasPolling = stateObj?.isPolling === true;
//     if (wasPolling && stateObj) {
//         stateObj.isPolling = false;
//         await new Promise((resolve) => setTimeout(resolve, 50));
//     }

//     const failed: { id: string; name: string }[] = [];

//     try {
//         // ─── СТРАТЕГИЯ ЗАПИСИ (важно, не удалять) ─────────────────────────────
//         // Modbus RTU — ненадёжная среда: устройство может не ответить на кадр,
//         // хотя ВЫПОЛНИЛО его. Наблюдение на первом прогоне после (пере)подключения
//         // порта: после первого изменения значений контроллер молчит ~1–1,5 с
//         // (сохранение в энергонезависимую память) — кадры выполняются, ответы не шлются.
//         // Поэтому: таймаут — НЕ отказ. Критерий истины — обратное чтение
//         // (внутри writeBaseRowToController), а для незавёршенных параметров —
//         // ограниченный идемпотентный повтор полного цикла: перезапись того же
//         // значения безопасна.
//         // Корректность не зависит от конкретного контроллера: параметр засчитан
//         // только при совпадении чтения; реальный отказ всё равно попадёт в список.
//         // Пауза 500 мс — настраиваемая величина под окно сохранения; если на парке
//         // устройств встретится более длинное окно — увеличить её или число повторов.
//         for (const tr of targets) {
//             let ok = await writeBaseRowToController(tr, slaveAddr);
//             if (!ok) {
//                 // Первый цикл не подтвердил запись: даём устройству досохранить
//                 // и повторяем цикл ещё раз.
//                 await new Promise((resolve) => setTimeout(resolve, 500));
//                 ok = await writeBaseRowToController(tr, slaveAddr);
//             }
//             if (!ok) {
//                 const tds = tr.querySelectorAll('td');
//                 failed.push({
//                     id: tr.getAttribute('data-key') || (tds[0]?.textContent || '').trim(),
//                     name: (tds[1]?.textContent || '').trim(),
//                 });
//             }
//         }
//     } finally {
//         if (wasPolling && stateObj) {
//             stateObj.isPolling = true;
//         }
//     }

//     // КРИТИЧНО: перед диспатчем события request-polling-restart нужно
//     // дождаться, когда старый readLoop полностью завершится и сбросит
//     // isLoopRunning = false.
//     //
//     // Почему: мы поставили isPolling = false и подождали всего 50 мс
//     // (см. блок выше). Если в этот момент readLoop находился внутри
//     // транзакции (await executeTransaction, до 500 мс на строку), он
//     // выйдет из while только после её завершения. К моменту диспатча
//     // события флаг isLoopRunning ещё true — и обработчик в
//     // communication-settings.ts (проверяющий !isLoopRunning) откажется
//     // перезапускать цикл. Графики замрут до следующего ручного клика
//     // по «Обновить».
//     //
//     // Тот же механизм используется в controller-write.ts для одиночной
//     // записи — там он работает, потому что запись быстрая (одна строка),
//     // и readLoop успевает завершиться за отведённые 50 мс. При массовом
//     // копировании пачка транзакций длится секунды — нужен явный wait.
//     if (wasPolling) {
//         // isLoopRunning живёт в AppState, а не в TableEditorState.
//         // stateObj здесь имеет тип TableEditorState (получен через
//         // getTableEditorState()), в нём этого поля нет. Берём AppState
//         // из window — он публикуется в main.ts и содержит isLoopRunning.
//         const appStateRef = (window as unknown as {
//             appState?: { isLoopRunning?: boolean };
//         }).appState;

//         const waitForLoopStop = async (): Promise<void> => {
//             const MAX_WAIT_MS = 2000;
//             const STEP_MS = 50;
//             let waited = 0;
//             while (appStateRef?.isLoopRunning && waited < MAX_WAIT_MS) {
//                 await new Promise((r) => setTimeout(r, STEP_MS));
//                 waited += STEP_MS;
//             }
//             if (appStateRef?.isLoopRunning) {
//                 console.warn(
//                     '[BASE→CONTROLLER] readLoop не завершился за 2 сек — ' +
//                     'перезапуск может не сработать',
//                 );
//             }
//         };
//         void waitForLoopStop().then(() => {
//             console.log(
//                 '[BASE→CONTROLLER] Диспатчу app:request-polling-restart, ' +
//                 'isLoopRunning =',
//                 appStateRef?.isLoopRunning,
//             );
//             window.dispatchEvent(new CustomEvent('app:request-polling-restart'));
//         });
//     }

//     if (failed.length === 0) {
//         console.log('[BASE→CONTROLLER] Все параметры записаны и проверены.');
//     } else {
//         console.error(`[BASE→CONTROLLER] Не записалось параметров: ${failed.length}`);
//         showFailedParamsList(failed);
//     }
// }