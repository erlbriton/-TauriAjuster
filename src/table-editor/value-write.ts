// src/table-editor/value-write.ts
// Диспетчер записи значения: распределяет запрос между Контроллером и Базой.

import { float32ToHex } from '../ini-manager/tree-core.js';
import { processControllerWrite, updateMismatchClass, updateCellDisplay } from './controller-write.js';
import { processBasePrmListWrite, processBaseIpAddrWrite } from './base-write.js';
import { markDirty } from '../ini-manager/dirty-tracker.js';
import type { TableEditorState } from '../ini-manager/table-editor.js';

/** Форматирует физическое значение без артефактов плавающей точки
 * (5600.000000000001 → "5600", 1.25 → "1.25"). */
function formatPhysValue(v: number): string {
    return parseFloat(v.toFixed(6)).toString();
}

export async function processValueWrite(
    tr: HTMLTableRowElement,
    editType: string,
    newValueStr: string,
    stateObj: TableEditorState,
    colIndex: number // 4, 5 - База (только UI); 6, 7 - Контроллер
): Promise<boolean> {
    // Контроллер обрабатывается отдельной функцией
    if (colIndex === 6 || colIndex === 7) {
        return await processControllerWrite(tr, editType, newValueStr, stateObj, colIndex);
    }

    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();
    const sub = tr.getAttribute('data-sub') || '';

    // Специальные типы Базы
    if (dataType === 'TPRMLIST') {
        return processBasePrmListWrite(tr, newValueStr, colIndex);
    }
    if (dataType === 'TIPADDR') {
        return processBaseIpAddrWrite(tr, editType, newValueStr, colIndex);
    }

    // --- Общая логика Базы для остальных типов ---
    let parts: string[] = [];
    try {
        parts = JSON.parse(tr.dataset.parts || '[]');
    } catch (e) {
        console.error("[TableEditor] Ошибка разбора data-parts:", e);
        return false;
    }

    // Hex хранится в слоте, указанном data-hex-index (как при рендере таблицы).
    // Слоты 4 (modbusReg) и 5 (единицы) НЕ трогаем — иначе повредим INI при сохранении.
    const hexIdxAttr = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
    const hexIndexInParts = hexIdxAttr >= 0 ? hexIdxAttr : 4;

    let scale = 1.0;
    if (parts.length > 6 && parts[6]) {
        const parsedScale = parseFloat(parts[6].replace(',', '.'));
        if (!isNaN(parsedScale) && parsedScale !== 0) scale = parsedScale;
    }

    const is32Bit = dataType.includes('FLOAT') || dataType.includes('DWORD') ||
        dataType.includes('LONG') || dataType.includes('INT32');

    let newHexValue: string | null = null;
    let newPhysValue: string | null = null;

    if (editType === 'hex') {
        const cleanHex = newValueStr.replace(/^(x|0x)/i, '');
        if (!/^[0-9A-Fa-f]+$/.test(cleanHex)) {
            alert("Некорректный HEX формат");
            return false;
        }
        let parsedVal = parseInt(cleanHex, 16);
        if (isNaN(parsedVal)) return false;

        newHexValue = 'x' + parsedVal.toString(16).toUpperCase().padStart(is32Bit ? 8 : 4, '0');
        parts[hexIndexInParts] = newHexValue;

        if (dataType.includes('FLOAT')) {
            const buf = new ArrayBuffer(4);
            const dv = new DataView(buf);
            if (is32Bit) {
                dv.setUint32(0, parsedVal, false);
                const floatVal = dv.getFloat32(0, false);
                newPhysValue = (floatVal * scale).toFixed(4);
            } else {
                let signedVal = parsedVal;
                if (signedVal > 32767) signedVal -= 65536;
                newPhysValue = (signedVal * scale).toString();
            }
        } else if (dataType === 'TBIT') {
            const bitIndex = parseInt(sub, 16);
            const bitVal = (parsedVal >> (isNaN(bitIndex) ? 0 : bitIndex)) & 1;
            newPhysValue = bitVal.toString();
        } else {
            let signedVal = parsedVal;
            if (!is32Bit && signedVal > 32767) signedVal -= 65536;
            if (is32Bit && parsedVal > 2147483647) signedVal = parsedVal - 4294967296;
            newPhysValue = (signedVal * scale).toString();
        }
    } else {
        const valNum = parseFloat(newValueStr.replace(',', '.'));
        if (isNaN(valNum)) {
            alert("Некорректное число");
            return false;
        }
        newPhysValue = newValueStr;

        if (dataType.includes('FLOAT')) {
            const unscaledVal = valNum / scale;
            const hexStr = float32ToHex(unscaledVal);
            newHexValue = 'x' + hexStr.toUpperCase();
            parts[hexIndexInParts] = newHexValue;
        } else if (dataType === 'TBIT') {
            const bitVal = valNum > 0 ? 1 : 0;
            const currentHexStr = parts[hexIndexInParts] && parts[hexIndexInParts].startsWith('x')
                ? parts[hexIndexInParts]
                : 'x0';
            let currentWord = parseInt(currentHexStr.slice(1), 16) || 0;
            const bitIndex = parseInt(sub, 16);
            if (!isNaN(bitIndex)) {
                if (bitVal === 1) currentWord |= (1 << bitIndex);
                else currentWord &= ~(1 << bitIndex);
            }
            newHexValue = 'x' + currentWord.toString(16).toUpperCase().padStart(4, '0');
            parts[hexIndexInParts] = newHexValue;
        } else {
            const rawVal = Math.round(valNum / scale);
            if (is32Bit) {
                newHexValue = 'x' + rawVal.toString(16).toUpperCase().padStart(8, '0');
            } else {
                const word = rawVal & 0xFFFF;
                newHexValue = 'x' + word.toString(16).toUpperCase().padStart(4, '0');
            }
            parts[hexIndexInParts] = newHexValue;
        }
    }

    tr.dataset.parts = JSON.stringify(parts);

    const tds = tr.querySelectorAll('td');
    updateCellDisplay(tds[4], newHexValue || '');
    updateCellDisplay(tds[5], newPhysValue || '');

    updateMismatchClass(tr, dataType);

    const activeCell = tds[colIndex];
    if (activeCell) {
        activeCell.classList.add('write-success');
        setTimeout(() => activeCell.classList.remove('write-success'), 1000);
    }

    console.log(`[UI ONLY] Значения обновлены в памяти. Hex: ${parts[4]}, Phys: ${parts[5]}`);

    // --- ЛОГИКА ЗАВИСИМОСТЕЙ ПАРАМЕТРОВ ---
    const currentParamName = (parts[0] ?? '').trim();
    const dependsOn = (parts[8] ?? '').trim();

    // 1. Если текущий параметр зависимый — пересчитываем множитель
    if (dependsOn && colIndex >= 4 && colIndex <= 5) {
        const baseRow = document.querySelector<HTMLTableRowElement>(
            `#grid-data-rows tr[data-name="${CSS.escape(dependsOn)}"]`
        );
        if (baseRow) {
            const basePhysText = (baseRow.querySelectorAll('td')[5]?.textContent || '').trim();
            const baseValue = parseFloat(basePhysText.replace(',', '.'));
            const currentPhysText = (tds[5]?.textContent || '').trim();
            const currentValue = parseFloat(currentPhysText.replace(',', '.'));
            
            if (!isNaN(baseValue) && baseValue !== 0 && !isNaN(currentValue)) {
                const newMultiplier = parseFloat((currentValue / baseValue).toFixed(6));
                parts[9] = newMultiplier.toString().replace('.', ',');
                tr.dataset.parts = JSON.stringify(parts);
                console.log(`[DEPENDENCY] ${tr.getAttribute('data-key')} зависит от ${dependsOn}, множитель обновлён: ${parts[9]}`);
            }
        }
    }

    // 2. Обновляем все параметры, зависящие от текущего
    const allRows = document.querySelectorAll<HTMLTableRowElement>('#grid-data-rows tr');
    allRows.forEach(depRow => {
        if (depRow === tr) return;
        
        let depParts: string[] = [];
        try { depParts = JSON.parse(depRow.dataset.parts || '[]'); } catch { return; }
        
        const depDependsOn = (depParts[8] ?? '').trim();
        if (depDependsOn !== currentParamName) return;
        
        const multiplierStr = (depParts[9] ?? '1').replace(',', '.');
        const multiplier = parseFloat(multiplierStr);
        if (isNaN(multiplier)) return;
        
        const currentPhysText = (tds[5]?.textContent || '').trim();
        const currentValue = parseFloat(currentPhysText.replace(',', '.'));
        if (isNaN(currentValue)) return;
        
        const newDepValue = currentValue * multiplier;
        const newDepValueStr = formatPhysValue(newDepValue);
        
        const depDataType = (depRow.getAttribute('data-type') || '').toUpperCase();
        const depHexIndex = parseInt(depRow.getAttribute('data-hex-index') || '-1', 10);
        const depIs32Bit = depDataType.includes('FLOAT') || depDataType.includes('DWORD') ||
            depDataType.includes('LONG') || depDataType.includes('INT32');
        
        let depScale = 1.0;
        if (depParts.length > 6 && depParts[6]) {
            const parsedScale = parseFloat(depParts[6].replace(',', '.'));
            if (!isNaN(parsedScale) && parsedScale !== 0) depScale = parsedScale;
        }
        
        let newDepHex: string;
        if (depDataType.includes('FLOAT')) {
            const unscaledVal = newDepValue / depScale;
            const hexStr = float32ToHex(unscaledVal);
            newDepHex = 'x' + hexStr.toUpperCase();
        } else {
            const rawVal = Math.round(newDepValue / depScale);
            if (depIs32Bit) {
                newDepHex = 'x' + rawVal.toString(16).toUpperCase().padStart(8, '0');
            } else {
                const word = rawVal & 0xFFFF;
                newDepHex = 'x' + word.toString(16).toUpperCase().padStart(4, '0');
            }
        }
        
        if (depHexIndex >= 0 && depHexIndex < depParts.length) {
            depParts[depHexIndex] = newDepHex;
        }
        
        depRow.dataset.parts = JSON.stringify(depParts);
        
        const depTds = depRow.querySelectorAll('td');
        updateCellDisplay(depTds[4], newDepHex);
        updateCellDisplay(depTds[5], newDepValueStr);
        updateMismatchClass(depRow, depDataType);
        
        const depParamId = depRow.getAttribute('data-key') || '';
        if (depParamId) markDirty(depParamId);
        
        const depActiveCell = depTds[colIndex];
        if (depActiveCell) {
            depActiveCell.classList.add('write-success');
            setTimeout(() => depActiveCell.classList.remove('write-success'), 1000);
        }
        
        console.log(`[DEPENDENCY] ${depParamId} обновлён: ${newDepValueStr} (базовый: ${currentParamName}, множитель: ${multiplier})`);
    });

    return true;
}