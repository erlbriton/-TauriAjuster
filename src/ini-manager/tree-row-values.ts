// src/ini-manager/tree-row-values.ts
// Обновление ячеек строки таблицы Modbus: преобразование hex-значений
// в отображаемый текст в зависимости от типа параметра
// (TWORD, TFLOAT, TIPADDR, TPRMLIST, TBIT и т. д.).
//
// Вынесено из tree-ui.ts, потому что это отдельная тема:
// не связано с рендерингом дерева и контекстным меню.

import { hexToFloat32 } from './tree-core.js';

/**
 * Синхронное обновление текста и элементов внутри HTML-ячеек строки таблицы.
 * Все параметры типизированы для строгой проверки.
 */
export function updateRowValues(
    rowElement: HTMLTableRowElement,
    rowParts: string[],
    rowDataType: string,
    rowScale: number,
    rowHexIndex: number,
    rowOriginalHexLen: number,
    rowPrmListOptions: Record<string, string>,
    argHexToFloat32: (hexStr: string) => number,
    argFloat32ToHex: (floatVal: number, padLen?: number) => string,
    colIndex: number = 4,
): void {
    // Безопасный фолбек на прямые импорты, если аргументы не были переданы
    const finalHexToFloat32 = typeof argHexToFloat32 === 'function' ? argHexToFloat32 : hexToFloat32;

    const rowTds = rowElement.querySelectorAll('td');
    const rCellHex = rowTds[colIndex];
    const rCellPhysical = rowTds[colIndex + 1];
    let bHex = '—';
    let bPhysical = '—';
        const dataTypeUpper = (rowDataType || '').toUpperCase();

    if (dataTypeUpper === 'TBIT') {
        const bitValueRaw = rowParts[rowParts.length - 1] ? rowParts[rowParts.length - 1].trim() : 'x0';
        let bitStr = '0';

        if (bitValueRaw.startsWith('x') || bitValueRaw.startsWith('X')) {
            const hexPart = bitValueRaw.slice(1);
            if (hexPart.length > 0) {
                const lastChar = hexPart[hexPart.length - 1];
                const bitNum = parseInt(lastChar, 16);
                if (!isNaN(bitNum)) {
                    bitStr = (bitNum & 1).toString();
                }
            }
        } else if (bitValueRaw === '1' || bitValueRaw === '0') {
            bitStr = bitValueRaw;
        }

        bPhysical = bitStr;
        bHex = bitStr;
    } else {
        let rHex = '';
        if (rowHexIndex !== -1) {
            rHex = rowParts[rowHexIndex];
        }
        if (rHex && rHex.startsWith('x')) {
            bHex = 'x' + rHex.slice(1).toUpperCase();

            if (dataTypeUpper === 'TIPADDR') {
                const hexVal = parseInt(rHex.slice(1), 16);
                if (!isNaN(hexVal)) {
                    const ipStr = `${(hexVal >>> 24) & 0xFF}.${(hexVal >>> 16) & 0xFF}.${(hexVal >>> 8) & 0xFF}.${hexVal & 0xFF}`;
                    bPhysical = `<div class="prm-val-display">${ipStr}</div>`;
                } else {
                    bPhysical = `<div class="prm-val-display">—</div>`;
                }
            } else if (dataTypeUpper === 'TPRMLIST') {
                const decValue = parseInt(rHex.slice(1), 16);

                const options: Record<string, string> = {};
                for (const key in rowPrmListOptions) options[key] = rowPrmListOptions[key];
                if (Object.keys(options).length === 0) {
                    for (const p of rowParts) {
                        const part = (p || '').trim();
                        if (part.includes('#')) {
                            const [h, t] = part.split('#');
                            if (h && t) options[h.toLowerCase()] = t;
                        }
                    }
                }

                let displayText = decValue.toString();
                if (Object.keys(options).length > 0) {
                    for (const hexKey in options) {
                        if (parseInt(hexKey.slice(1), 16) === decValue) {
                            displayText = options[hexKey];
                            break;
                        }
                    }
                }

                bHex = displayText;
                bPhysical = displayText;
            } else if (dataTypeUpper === 'TFLOAT' || dataTypeUpper === 'FLOAT' || dataTypeUpper === 'TFLOAT32') {
                const floatValue = finalHexToFloat32(rHex.slice(1));
                if (!isNaN(floatValue)) {
                    const scaledValue = !isNaN(rowScale) ? floatValue * rowScale : floatValue;
                    bPhysical = `<div class="prm-val-display">${Number(scaledValue.toFixed(4)).toString()}</div>`;
                } else {
                    bPhysical = `<div class="prm-val-display">—</div>`;
                }
            } else {
                let decValue = parseInt(rHex.slice(1), 16);
                if (!isNaN(decValue)) {
                    if (dataTypeUpper === 'TSHORT' || dataTypeUpper === 'TINT16' || dataTypeUpper === 'TINTEGER') {
                        if (decValue > 32767) decValue -= 65536;
                    } else if (dataTypeUpper === 'TLONG' || dataTypeUpper === 'TINT32') {
                        if (decValue > 2147483647) decValue -= 4294967296;
                    }
                }
                if (!isNaN(decValue) && !isNaN(rowScale)) {
                    bPhysical = `<div class="prm-val-display">${Number((decValue * rowScale).toFixed(4)).toString()}</div>`;
                } else if (!isNaN(decValue)) {
                    bPhysical = `<div class="prm-val-display">${decValue.toString()}</div>`;
                }
            }
        }
    }

    rCellHex.textContent = bHex;
    if (bPhysical.startsWith('<div') || bPhysical.startsWith('<select')) {
        rCellPhysical.innerHTML = bPhysical;
    } else {
        rCellPhysical.innerHTML = `<div class="prm-val-display">${bPhysical}</div>`;
    }

    const newSelectEl = rCellPhysical.querySelector('.table-prm-select');
    if (newSelectEl) {
        newSelectEl.addEventListener('change', (e: Event) => {
            const selectTarget = e.target as HTMLSelectElement;
            const selectedHex = selectTarget.value;
            const selectedText = selectTarget.options[selectTarget.selectedIndex].text;
            const displayEl = rCellPhysical.querySelector('.prm-val-display');
            if (displayEl) {
                displayEl.textContent = selectedText;
            }
            rCellHex.textContent = 'x' + selectedHex.slice(1).toUpperCase();
            if (rowHexIndex !== -1) {
                rowParts[rowHexIndex] = selectedHex;
            }
        });
    }
}