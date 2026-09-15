// src/table-editor/copy-ops.ts

// Операции массового копирования значений между Базой и Контроллером.

import { updateMismatchClass, baseControllerMismatch } from './controller-write.js';
import { planControllerWrite } from '../ini-manager/tree-core.js';
import { writeRegistersFC16, readHoldingRegistersFC03 } from '../serial/serial-actions.js';
import { getTableEditorState } from '../ini-manager/table-editor.js';
import { showFailedParamsList } from '../ui/confirm-dialog.js';
import { serialManager } from '../serial/serial-actions.js';

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
// База → Контроллер (реальная запись по Modbus)
// ─────────────────────────────────────────────

/** Запись одной строки Базы в Контроллер с проверкой. true — успех. */
/**
 * Записывает одну строку таблицы в контроллер и проверяет запись.
 *
 * Философия надёжности (важно, не удалять):
 *  - Modbus RTU — ненадёжная среда; контроллер может не ответить на кадр,
 *    хотя выполнил его (окно молчания ~1–1,5 с после первого изменения
 *    значений — сохранение в энергонезависимую память);
 *  - поэтому таймаут не считается отказом, а критерий истины — обратное чтение;
 *  - ветка 'words' реализует проверку с повтором чтения внутри;
 *    ветки 'byte' и 'bit' полагаются на внешний идемпотентный повтор
 *    в copyBaseToController.
 *
 * Возвращает true ТОЛЬКО если обратное чтение совпало с записанным.
 */
async function writeBaseRowToController(
    tr: HTMLTableRowElement,
    slaveAddr: number,
): Promise<boolean> {
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

    let bytePos = '';
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        bytePos = (sub || '').toUpperCase();
    }

       // Значение Базы в формате входа planControllerWrite
    const baseText = (tds[4]?.textContent || '').trim();
    console.log(`[BATCH-DIAG] row=${tr.getAttribute('data-key')}, dataType=${dataType}, baseText="${baseText}", tds[4].innerHTML=${tds[4]?.innerHTML}`);
    let valueStr = '';
    let editType: 'hex' | 'phys' = 'hex';

    if (dataType === 'TPRMLIST') {
        // Текст опции → hex через список опций из data-parts
        let found = '';
        for (const p of parts) {
            const part = (p || '').trim();
            if (part.includes('#')) {
                const [h, t] = part.split('#');
                if (h && t && t.trim() === baseText) { found = h.trim(); break; }
            }
        }
        if (!found) return false;
        valueStr = found;
    } else if (dataType === 'TBIT') {
        valueStr = baseText; // '0'/'1'
        editType = 'phys';
    } else {
        valueStr = baseText; // 'x0014' / 'xC0A80064'
    }

    const plan = planControllerWrite(dataType, editType, valueStr, scale, sub, bytePos);
    console.log(`[BATCH-DIAG] plan:`, JSON.stringify(plan));
    if (!plan.ok) {
        console.warn(`[BATCH-DIAG] plan.ok=false, пропускаю строку ${tr.getAttribute('data-key')}`);
        return false;
    }

    const reg = parseInt(tr.getAttribute('data-reg') || '', 16);
    if (isNaN(reg)) return false;

    // ── Запись + обратное чтение + сравнение ──
        const rowId = tr.getAttribute('data-key') || '';
    if (plan.kind === 'words') {
        // Шаг 1: сама запись (FC16).
        // ВАЖНО: отсутствие ответа — НЕ отказ: устройство могло выполнить кадр
        // молча (окно сохранения, см. комментарий-стратегию в copyBaseToController).
        // В этом случае даём паузу и переходим к проверке: истину скажет только чтение.
        const writeOk = await writeRegistersFC16(slaveAddr, reg, plan.words);
        if (!writeOk) {
            console.warn(`[BASE→CONTROLLER] ${rowId}: нет ответа на FC16 (reg=${reg.toString(16)}), проверяю чтением`);
            await new Promise((r) => setTimeout(r, 500));
        }
        // Шаг 2: проверка обратным чтением (FC03).
        // Чтение тоже может попасть в окно молчания устройства, поэтому при первом
        // отказе — одна повторная попытка с паузой. Лишь повторный отказ — настоящий.
        let readWords = await readHoldingRegistersFC03(slaveAddr, reg, plan.words.length);
        if (!readWords) {
            await new Promise((r) => setTimeout(r, 500));
            readWords = await readHoldingRegistersFC03(slaveAddr, reg, plan.words.length);
        }
        if (!readWords) {
            console.warn(`[BASE→CONTROLLER] ${rowId}: отказ обратного чтения FC03 (reg=${reg.toString(16)})`);
            return false;
        }
        // Шаг 3: сверка записанного с прочитанным.
        // Несовпадение = устройство реально не применило значение: сообщаем об отказе,
        // внешний повтор в copyBaseToController попробует ещё раз.
        if (!(readWords.length === plan.words.length && plan.words.every((w, i) => readWords[i] === w))) {
            console.warn(`[BASE→CONTROLLER] ${rowId}: НЕСОВПАДЕНИЕ при проверке: записано ${plan.words.map((w) => w.toString(16)).join(',')}, прочитано ${readWords.map((w) => w.toString(16)).join(',')}`);
            return false;
        }
    } else if (plan.kind === 'byte') {
        const currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!currentWords) return false;
        const currentWord = currentWords[0];
        const highByte = (currentWord >> 8) & 0xFF;
        const lowByte = currentWord & 0xFF;
        const newWord = plan.bytePos === 'H'
            ? ((plan.byteValue << 8) | lowByte) & 0xFFFF
            : ((highByte << 8) | plan.byteValue) & 0xFFFF;
        const writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
        if (!writeOk) return false;
        const readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!readWords) return false;
        const readByte = plan.bytePos === 'H' ? (readWords[0] >> 8) & 0xFF : readWords[0] & 0xFF;
        if (readByte !== plan.byteValue) return false;
    } else if (plan.kind === 'bit') {
        const currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!currentWords) return false;
        const currentWord = currentWords[0];
        const bitMask = 1 << plan.bitIndex;
        const newWord = plan.bitValue === 1
            ? (currentWord | bitMask) & 0xFFFF
            : (currentWord & ~bitMask) & 0xFFFF;
        const writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
        if (!writeOk) return false;
        const readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (!readWords) return false;
        const readBit = (readWords[0] >> plan.bitIndex) & 1;
        if (readBit !== plan.bitValue) return false;
    } else {
        return false;
    }

    // ── Синхронизация UI: Контроллер = База ──
    if (tds[6] && tds[4]) tds[6].innerHTML = tds[4].innerHTML;
    if (tds[7] && tds[5]) tds[7].innerHTML = tds[5].innerHTML;

    const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
    if (plan.kind === 'words') {
        if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = baseText;
    } else if (plan.kind === 'byte') {
        const byteHex = 'x' + plan.byteValue.toString(16).toUpperCase().padStart(2, '0');
        if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = byteHex;
    } else {
        const bitHex = 'x' + (plan.newPhys || '0').padStart(4, '0');
        if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = bitHex;
        if (parts.length > 0) parts[parts.length - 1] = bitHex;
    }
    tr.dataset.parts = JSON.stringify(parts);

    updateMismatchClass(tr, dataType);
    return true;
}

/**
 * Копирует в Контроллер только параметры, где База ≠ Контроллер.
 * Реальная запись по Modbus + обратное чтение + сравнение.
 * При полном успехе — тихо (лог). При ошибках — одно окно со списком и скроллингом.
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

    const failed: { id: string; name: string }[] = [];

    try {
        // ─── СТРАТЕГИЯ ЗАПИСИ (важно, не удалять) ─────────────────────────────
        // Modbus RTU — ненадёжная среда: устройство может не ответить на кадр,
        // хотя ВЫПОЛНИЛО его. Наблюдение на первом прогоне после (пере)подключения
        // порта: после первого изменения значений контроллер молчит ~1–1,5 с
        // (сохранение в энергонезависимую память) — кадры выполняются, ответы не шлются.
        // Поэтому: таймаут — НЕ отказ. Критерий истины — обратное чтение
        // (внутри writeBaseRowToController), а для незавёршенных параметров —
        // ограниченный идемпотентный повтор полного цикла: перезапись того же
        // значения безопасна.
        // Корректность не зависит от конкретного контроллера: параметр засчитан
        // только при совпадении чтения; реальный отказ всё равно попадёт в список.
        // Пауза 500 мс — настраиваемая величина под окно сохранения; если на парке
        // устройств встретится более длинное окно — увеличить её или число повторов.
        for (const tr of targets) {
            let ok = await writeBaseRowToController(tr, slaveAddr);
            if (!ok) {
                // Первый цикл не подтвердил запись: даём устройству досохранить
                // и повторяем цикл ещё раз.
                await new Promise((resolve) => setTimeout(resolve, 500));
                ok = await writeBaseRowToController(tr, slaveAddr);
            }
            if (!ok) {
                const tds = tr.querySelectorAll('td');
                failed.push({
                    id: tr.getAttribute('data-key') || (tds[0]?.textContent || '').trim(),
                    name: (tds[1]?.textContent || '').trim(),
                });
            }
        }
    } finally {
        if (wasPolling && stateObj) {
            stateObj.isPolling = true;
        }
    }

    if (failed.length === 0) {
        console.log('[BASE→CONTROLLER] Все параметры записаны и проверены.');
    } else {
        console.error(`[BASE→CONTROLLER] Не записалось параметров: ${failed.length}`);
        showFailedParamsList(failed);
    }
}