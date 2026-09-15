// src/table-editor/controller-write.ts

// Запись значений в Контроллер (Modbus FC16 + обратное чтение FC03 + проверка).

import { planControllerWrite } from '../ini-manager/tree-core.js';
import { writeRegistersFC16, readHoldingRegistersFC03 } from '../serial/serial-actions.js';
import { showIdModal } from '../ui/ui.js';
import type { TableEditorState } from '../ini-manager/table-editor.js';

/**
 * Обновляет DOM-ячейку td строкой val.
 * Обрабатывает три случая: HTML-фрагмент (<div>/<select>), hex-строка (с 'x'), обычный текст.
 */
export function updateCellDisplay(td: Element | null, val: string): void {
    if (!td || !val) return;
    if (val.startsWith('<div') || val.startsWith('<select')) {
        td.innerHTML = val;
    } else if (val.startsWith('x')) {
        td.textContent = val;
    } else {
        if (!td.innerHTML.includes('prm-val-display')) {
            td.innerHTML = `<div class="prm-val-display">${val}</div>`;
        } else {
            const display = td.querySelector('.prm-val-display');
            if (display) display.textContent = val;
        }
    }
}

/**
 * Возвращает true, если значение Базы (колонка 4) отличается от Контроллера (колонка 6).
 * Для TPrmList сравнивает текст опции, для остальных типов — хекс как число.
 */
export function baseControllerMismatch(tr: HTMLTableRowElement, dataType: string): boolean {
    const tds = tr.querySelectorAll('td');

    if (dataType === 'TPRMLIST') {
        const getDisplayText = (td: Element | undefined): string => {
            if (!td) return '';
            const display = td.querySelector('.prm-val-display');
            if (display) return (display.textContent || '').trim();
            return (td.textContent || '').trim();
        };
        const baseText = getDisplayText(tds[4]);
        const liveText = getDisplayText(tds[6]);
        return baseText !== '—' && liveText !== '—' && baseText !== '' && liveText !== '' && baseText !== liveText;
    }

    const parseHexValue = (hexStr: string): number | null => {
        if (!hexStr) return null;
        const clean = hexStr.trim().toUpperCase().replace(/^X/, '');
        if (!clean || !/^[0-9A-F]+$/.test(clean)) return null;
        const n = parseInt(clean, 16);
        return isNaN(n) ? null : n;
    };
    const hexBaseRaw = tds[4] ? (tds[4].textContent || '').trim() : '';
    const hexLiveRaw = tds[6] ? (tds[6].textContent || '').trim() : '';
    const valBase = parseHexValue(hexBaseRaw);
    const valLive = parseHexValue(hexLiveRaw);
    return (
        hexBaseRaw !== '—' &&
        hexLiveRaw !== '—' &&
        valBase !== null &&
        valLive !== null &&
        valBase !== valLive
    );
}

/**
 * Пересчитывает класс row-mismatch (красная подсветка расхождения База/Контроллер).
 */
export function updateMismatchClass(tr: HTMLTableRowElement, dataType: string): void {
    tr.classList.toggle('row-mismatch', baseControllerMismatch(tr, dataType));
}

/** Главная функция записи в Контроллер с ветвлением по kind плана. */
export async function processControllerWrite(
    tr: HTMLTableRowElement,
    editType: string,
    newValueStr: string,
    stateObj: TableEditorState,
    colIndex: number
): Promise<boolean> {
    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
    const sub = tr.getAttribute('data-sub') || '';

    let parts: string[] = [];
    try {
        parts = JSON.parse(tr.dataset.parts || '[]');
    } catch (e) {
        console.error('[TableEditor] Ошибка разбора data-parts:', e);
        return false;
    }

    let scale = 1.0;
    if (parts.length > 6 && parts[6]) {
        const parsedScale = parseFloat(parts[6].replace(',', '.'));
        if (!isNaN(parsedScale) && parsedScale !== 0) scale = parsedScale;
    }

    let bytePos = '';
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        bytePos = (sub || '').toUpperCase();
    }

    const plan = planControllerWrite(dataType, editType, newValueStr, scale, sub, bytePos);

    // Диагностика для TBYTE и TPRMLIST
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        const prmOptions: Record<string, string> = {};
        for (const p of parts) {
            const part = (p || '').trim();
            if (part.includes('#')) {
                const [h, t] = part.split('#');
                if (h && t) prmOptions[h.toLowerCase()] = t;
            }
        }
        console.log(`[CONTROLLER] ${dataType} диагностика:`);
        console.log('  data-reg:', tr.getAttribute('data-reg'));
        console.log('  data-sub:', tr.getAttribute('data-sub'));
        console.log('  data-hex-index:', tr.getAttribute('data-hex-index'));
        console.log('  parts (полный массив):', JSON.stringify(parts));
        console.log('  prmListOptions:', JSON.stringify(prmOptions));
        console.log('  plan:', JSON.stringify(plan));
    }

    if (!plan.ok) {
        console.warn(`[CONTROLLER] Некорректное значение: тип=${dataType}, editType=${editType}, value="${newValueStr}"`);
        showIdModal('Некорректное значение');
        return false;
    }

    const addrStr = tr.getAttribute('data-reg');
    if (!addrStr) return false;
    const reg = parseInt(addrStr, 16);
    if (isNaN(reg)) return false;
    const slaveAddr = (stateObj && stateObj.slaveAddress) ? stateObj.slaveAddress : 0x01;

    // --- Ветка WORDS (16/32 бит, TWord, TInt, TInteger, TFLOAT, TDWORD, TIPAddr и т.д.) ---
    if (plan.kind === 'words') {
        console.log(
            `[CONTROLLER] Запись FC16: slave=0x${slaveAddr.toString(16)}, reg=0x${reg.toString(16)}, ` +
            `words=[${plan.words.map((w) => '0x' + w.toString(16)).join(', ')}]`
        );

        const wasPolling = stateObj.isPolling === true;
        if (wasPolling) {
            console.log('[CONTROLLER] Фоновый опрос активен — приостанавливаю на время транзакций...');
            stateObj.isPolling = false;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        let writeOk = false;
        let readWords: number[] | null = null;
        try {
            writeOk = await writeRegistersFC16(slaveAddr, reg, plan.words);
            if (writeOk) {
                console.log('[CONTROLLER] Запись FC16 подтверждена устройством.');
                readWords = await readHoldingRegistersFC03(slaveAddr, reg, plan.words.length);
            }
        } finally {
            if (wasPolling) {
                console.log('[CONTROLLER] Возобновляю фоновый опрос.');
                stateObj.isPolling = true;
            }
        }

        if (!writeOk) {
            console.error('[CONTROLLER] Запись FC16 не удалась.');
            return false;
        }
        if (readWords === null) {
            console.error('[CONTROLLER] Обратное чтение FC03 не удалось.');
            return false;
        }

        console.log(
            `[CONTROLLER] Обратное чтение FC03: reg=0x${reg.toString(16)}, ` +
            `read=[${readWords.map((w) => '0x' + w.toString(16)).join(', ')}]`
        );

        const wordsMatch = readWords.length === plan.words.length &&
            plan.words.every((w, i) => readWords[i] === w);
        if (!wordsMatch) {
            console.error(
                `[CONTROLLER] НЕСОВПАДЕНИЕ: sent=[${plan.words.map((w) => '0x' + w.toString(16)).join(', ')}], ` +
                `read=[${readWords.map((w) => '0x' + w.toString(16)).join(', ')}]`
            );
            showIdModal('Значение неписалось');
            return false;
        }

        const tds = tr.querySelectorAll('td');
        let parts: string[] = [];
        try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { parts = []; }

        if (plan.newHex) {
            if (parts.length > 6) parts[6] = plan.newHex;
            updateCellDisplay(tds[6], plan.newHex);
        }
        if (plan.newPhys) {
            if (parts.length > 7) parts[7] = plan.newPhys;
            updateCellDisplay(tds[7], plan.newPhys);
        }
        tr.dataset.parts = JSON.stringify(parts);

        updateMismatchClass(tr, dataType);
        const activeCell = tds[colIndex];
        if (activeCell) {
            activeCell.classList.add('write-success');
            setTimeout(() => activeCell.classList.remove('write-success'), 1000);
        }
        console.log('[CONTROLLER] Значение успешно записано, подтверждено и синхронизировано.');
                // Диспетчеризация события для перезапуска цикла опроса.
        window.dispatchEvent(new CustomEvent('app:request-polling-restart'));
        return true;
    }

    // --- Ветка BYTE (TByte, TPrmList) ---
    if (plan.kind === 'byte') {
        const wasPolling = stateObj.isPolling === true;
        if (wasPolling) {
            console.log('[CONTROLLER] TBYTE: Фоновый опрос активен — приостанавливаю...');
            stateObj.isPolling = false;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        let currentWords: number[] | null = null;
        let writeOk = false;
        let readWords: number[] | null = null;
        try {
            currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
            if (currentWords === null) {
                console.error('[CONTROLLER] TBYTE: не удалось прочитать текущее слово.');
                return false;
            }
            const currentWord = currentWords[0];
            console.log(
                `[CONTROLLER] TBYTE: reg=0x${reg.toString(16)}, bytePos=${plan.bytePos}, ` +
                `желаемый байт=0x${plan.byteValue.toString(16)}, текущее слово=0x${currentWord.toString(16)}`
            );

            const highByte = (currentWord >> 8) & 0xFF;
            const lowByte = currentWord & 0xFF;
            const newWord = plan.bytePos === 'H'
                ? ((plan.byteValue << 8) | lowByte) & 0xFFFF
                : ((highByte << 8) | plan.byteValue) & 0xFFFF;

            console.log(
                `[CONTROLLER] TBYTE: записываю слово=0x${newWord.toString(16)} ` +
                `(было 0x${currentWord.toString(16)})`
            );
            writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
            if (writeOk) {
                readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
            }
        } finally {
            if (wasPolling) {
                console.log('[CONTROLLER] TBYTE: Возобновляю фоновый опрос.');
                stateObj.isPolling = true;
            }
        }

        if (!writeOk) {
            console.error('[CONTROLLER] TBYTE: запись слова по FC16 не удалась.');
            showIdModal('Значение не записалось');
            return false;
        }
        if (readWords === null) {
            console.error('[CONTROLLER] TBYTE: обратное чтение не удалось.');
            showIdModal('Значение не записалось');
            return false;
        }

        const readWord = readWords[0];
        const readByte = plan.bytePos === 'H' ? (readWord >> 8) & 0xFF : readWord & 0xFF;
        if (readByte !== plan.byteValue) {
            console.error(
                `[CONTROLLER] TBYTE: НЕСОВПАДЕНИЕ: байт ${plan.bytePos} = 0x${readByte.toString(16)}, ` +
                `ожидалось 0x${plan.byteValue.toString(16)}`
            );
            showIdModal('Значение не записалось');
            return false;
        }

        console.log('[CONTROLLER] TBYTE: байт записан и проверен.');
        const tds = tr.querySelectorAll('td');
        const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
        const byteHex = 'x' + plan.byteValue.toString(16).toUpperCase().padStart(2, '0');
        if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = byteHex;
        tr.dataset.parts = JSON.stringify(parts);

        if (dataType === 'TPRMLIST') {
            let optionText = byteHex;
            for (const p of parts) {
                const part = (p || '').trim();
                if (part.includes('#')) {
                    const [h, t] = part.split('#');
                    if (h && t && h.toLowerCase() === byteHex.toLowerCase()) {
                        optionText = t;
                        break;
                    }
                }
            }
            updateCellDisplay(tds[6], optionText);
            updateCellDisplay(tds[7], optionText);
        } else {
            updateCellDisplay(tds[6], byteHex);
            updateCellDisplay(tds[7], plan.newPhys);
        }

        updateMismatchClass(tr, dataType);
        const activeCell = tds[colIndex];
        if (activeCell) {
            activeCell.classList.add('write-success');
            setTimeout(() => activeCell.classList.remove('write-success'), 1000);
        }
        console.log('[CONTROLLER] TBYTE: Значение успешно записано.');
        return true;
    }

    // --- Ветка BIT (TBit) ---
    const wasPolling = stateObj.isPolling === true;
    if (wasPolling) {
        console.log('[CONTROLLER] TBIT: Фоновый опрос активен — приостанавливаю...');
        stateObj.isPolling = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let currentWords: number[] | null = null;
    let writeOk = false;
    let readWords: number[] | null = null;
    try {
        currentWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        if (currentWords === null) {
            console.error('[CONTROLLER] TBIT: не удалось прочитать текущее слово.');
            return false;
        }
        const currentWord = currentWords[0];
        console.log(
            `[CONTROLLER] TBIT: reg=0x${reg.toString(16)}, bitIndex=${plan.bitIndex}, ` +
            `желаемый bitValue=${plan.bitValue}, текущее слово=0x${currentWord.toString(16)}`
        );

        const bitMask = 1 << plan.bitIndex;
        const newWord = plan.bitValue === 1
            ? (currentWord | bitMask) & 0xFFFF
            : (currentWord & ~bitMask) & 0xFFFF;

        console.log(
            `[CONTROLLER] TBIT: записываю слово=0x${newWord.toString(16)} ` +
            `(было 0x${currentWord.toString(16)})`
        );
        writeOk = await writeRegistersFC16(slaveAddr, reg, [newWord]);
        if (writeOk) {
            readWords = await readHoldingRegistersFC03(slaveAddr, reg, 1);
        }
    } finally {
        if (wasPolling) {
            console.log('[CONTROLLER] TBIT: Возобновляю фоновый опрос.');
            stateObj.isPolling = true;
        }
    }

    if (!writeOk) {
        console.error('[CONTROLLER] TBIT: запись не удалась.');
        showIdModal('Значение не записалось');
        return false;
    }
    if (readWords === null) {
        console.error('[CONTROLLER] TBIT: обратное чтение не удалось.');
        showIdModal('Значение не записалось');
        return false;
    }

    const readBit = (readWords[0] >> plan.bitIndex) & 1;
    if (readBit !== plan.bitValue) {
        console.error(
            `[CONTROLLER] TBIT: НЕСОВПАДЕНИЕ: бит ${plan.bitIndex} = ${readBit}, ожидалось ${plan.bitValue}`
        );
        showIdModal('Значение не записалось');
        return false;
    }

    console.log('[CONTROLLER] TBIT: бит записан и проверен.');
    const tds = tr.querySelectorAll('td');
    const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
    const bitStr = plan.newPhys;
    const bitHex = 'x' + bitStr.padStart(4, '0');
    if (hexIndex >= 0 && hexIndex < parts.length) parts[hexIndex] = bitHex;
    if (parts.length > 0) parts[parts.length - 1] = bitHex;
    if (tds[6]) tds[6].textContent = bitStr;
    updateCellDisplay(tds[7], bitStr);
    tr.dataset.parts = JSON.stringify(parts);

    updateMismatchClass(tr, dataType);
    const activeCell = tds[colIndex];
    if (activeCell) {
        activeCell.classList.add('write-success');
        setTimeout(() => activeCell.classList.remove('write-success'), 1000);
    }
    console.log('[CONTROLLER] TBIT: Значение успешно записано.');
    return true;
}