// src/table-editor/base-write.ts
// Запись значений в Базу (колонки 4 и 5) — только обновление в памяти браузера,
// без отправки по Modbus. Специальные ветки для TPrmList и TIPAddr.

import { planControllerWrite } from '../ini-manager/tree-core.js';
import { showIdModal } from '../ui/ui.js';
import { updateMismatchClass, updateCellDisplay } from './controller-write.js';

/** Обработка TPrmList в Базе — обновление опции в памяти. */
export async function processBasePrmListWrite(
    tr: HTMLTableRowElement,
    selectedHex: string,
    colIndex: number
): Promise<boolean> {
    const byteValue = parseInt(selectedHex.replace(/^(x|0x)/i, ''), 16);
    if (isNaN(byteValue)) return false;

    let parts: string[] = [];
    try { parts = JSON.parse(tr.dataset.parts || '[]'); } catch { parts = []; }

    let optionText = selectedHex;
    for (const p of parts) {
        const part = (p || '').trim();
        if (part.includes('#')) {
            const [h, t] = part.split('#');
            if (h && t && parseInt(h.slice(1), 16) === byteValue) {
                optionText = t;
                break;
            }
        }
    }

    // НЕ пишем в parts[hexIndex] — этот слот принадлежит живому значению Контроллера.
    const tds = tr.querySelectorAll('td');
    updateCellDisplay(tds[4], optionText);
    updateCellDisplay(tds[5], optionText);

    updateMismatchClass(tr, 'TPRMLIST');

    const activeCell = tds[colIndex];
    if (activeCell) {
        activeCell.classList.add('write-success');
        setTimeout(() => activeCell.classList.remove('write-success'), 1000);
    }
    console.log(`[BASE TPrmList] Значение обновлено в памяти: ${optionText} (без отправки по Modbus).`);
    return true;
}

/** Обработка TIPAddr в Базе — обновление IP в памяти, с валидацией через planControllerWrite. */
export async function processBaseIpAddrWrite(
    tr: HTMLTableRowElement,
    editType: string,
    newValueStr: string,
    colIndex: number
): Promise<boolean> {
    const plan = planControllerWrite('TIPADDR', editType, newValueStr, 1.0, '');
    if (!plan.ok) {
        showIdModal('Некорректное значение');
        return false;
    }
    if (plan.kind !== 'words') {
        return false;
    }

    const tds = tr.querySelectorAll('td');
    updateCellDisplay(tds[4], plan.newHex);
    updateCellDisplay(tds[5], plan.newPhys);

    updateMismatchClass(tr, 'TIPADDR');

    const activeCell = tds[colIndex];
    if (activeCell) {
        activeCell.classList.add('write-success');
        setTimeout(() => activeCell.classList.remove('write-success'), 1000);
    }
    console.log(`[BASE TIPADDR] Значение обновлено в памяти: ${plan.newPhys} (без отправки по Modbus).`);
    return true;
}