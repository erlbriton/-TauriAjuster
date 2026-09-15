// src/table-editor/inline-edit.ts
// UI-логика инлайн-редактирования ячеек таблицы (текстовое поле или выпадающий список).

import { processValueWrite } from './value-write.js';
import type { TableEditorState } from '../ini-manager/table-editor.js';
import { markDirty } from '../ini-manager/dirty-tracker.js';

export function startInlineEdit(cell: HTMLElement, stateObj: TableEditorState): void {
    const tr = cell.closest<HTMLTableRowElement>('tr');
    if (!tr) return;
    if (cell.querySelector('input') || cell.querySelector('select')) return;

    const editType = cell.getAttribute('data-edit-type') || 'phys';
    const colIndex = parseInt(cell.getAttribute('data-col-index') || '4', 10);
    const originalValue = cell.innerText.trim();
    const dataType = (tr.getAttribute('data-type') || '').toUpperCase();

    // --- TPrmList: выпадающий список вместо текстового поля ---
    if (dataType === 'TPRMLIST') {
        let partsRaw: string[] = [];
        try { partsRaw = JSON.parse(tr.dataset.parts || '[]'); } catch { partsRaw = []; }

        const prmOptions: { hex: string; text: string }[] = [];
        for (const p of partsRaw) {
            const part = (p || '').trim();
            if (part.includes('#')) {
                const [h, t] = part.split('#');
                if (h && t) prmOptions.push({ hex: h.toLowerCase(), text: t });
            }
        }

        const hexIndex = parseInt(tr.getAttribute('data-hex-index') || '-1', 10);
        let currentHex = '';
        if (colIndex === 4 || colIndex === 5) {
            const match = prmOptions.find((o) => o.text === originalValue);
            currentHex = match ? match.hex : '';
        } else {
            currentHex = (hexIndex >= 0 && hexIndex < partsRaw.length)
                ? (partsRaw[hexIndex] || '').toLowerCase()
                : '';
        }

        const select = document.createElement('select');
        select.className = 'inline-cell-select';
        select.style.width = '100%';

        for (const opt of prmOptions) {
            const option = document.createElement('option');
            option.value = opt.hex;
            option.textContent = opt.text;
            if (opt.hex === currentHex) option.selected = true;
            select.appendChild(option);
        }

        cell.innerHTML = '';
        cell.appendChild(select);
        select.focus();

        let isFinished = false;
        const saveSelect = async () => {
            if (isFinished) return;
            isFinished = true;
            const selectedHex = select.value;
            if (!selectedHex || selectedHex === currentHex) {
                cell.innerText = originalValue;
                return;
            }
            const selectedText = select.options[select.selectedIndex]?.text || selectedHex;
            cell.innerText = selectedText;
            try {
                const success = await processValueWrite(tr, 'hex', selectedHex, stateObj, colIndex);
                if (!success) {
                    cell.innerText = originalValue;
                    cell.classList.add('write-error');
                    setTimeout(() => cell.classList.remove('write-error'), 1500);
                } else {
                    cell.classList.add('write-success');
                    setTimeout(() => cell.classList.remove('write-success'), 1000);
                    // Помечаем параметр как изменённый, если это колонка БАЗЫ (4 или 5)
                    if (colIndex === 4 || colIndex === 5) {
                        const paramId = tr.dataset.key;
                        if (paramId) markDirty(paramId);
                    }
                }
            } catch (err) {
                console.error('Error saving TPrmList value:', err);
                cell.innerText = originalValue;
            }
        };

        select.addEventListener('change', () => saveSelect());
        select.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); select.blur(); }
            else if (e.key === 'Escape') { isFinished = true; cell.innerText = originalValue; }
        });
        select.addEventListener('blur', () => saveSelect());
        return;
    }

    // --- Все остальные типы: текстовое поле ---
    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalValue;
    input.className = 'inline-cell-input';
    input.style.width = '100%';

    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let isFinished = false;
    const save = async () => {
        if (isFinished) return;
        isFinished = true;
        const newValue = input.value.trim();
        if (newValue === originalValue || newValue === '') {
            cell.innerText = originalValue;
            return;
        }
        cell.innerText = newValue;
        try {
            const success = await processValueWrite(tr, editType, newValue, stateObj, colIndex);
            if (!success) {
                cell.innerText = originalValue;
                cell.classList.add('write-error');
                setTimeout(() => cell.classList.remove('write-error'), 1500);
            } else {
                cell.classList.add('write-success');
                setTimeout(() => cell.classList.remove('write-success'), 1000);
                // Помечаем параметр как изменённый, если это колонка БАЗЫ (4 или 5)
                if (colIndex === 4 || colIndex === 5) {
                    const paramId = tr.dataset.key;
                    if (paramId) markDirty(paramId);
                }
            }
        } catch (err) {
            console.error("Error saving value:", err);
            cell.innerText = originalValue;
        }
    };

    input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') { isFinished = true; cell.innerText = originalValue; }
    });
    input.addEventListener('blur', () => save());
}