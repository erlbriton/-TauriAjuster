// src/ini-manager/table-editor.ts — ФАСАД
// Ре-экспортирует всё, что раньше было в этом файле, чтобы остальные модули
// (tree-ui.ts, device_updater.ts и т.д.) продолжали импортировать отсюда.

import type { IniConfig } from '../core/ini/index.js';
import { startInlineEdit } from '../table-editor/inline-edit.js';

/** Ячейка с активным инлайн-редактором */
interface EditableCell extends HTMLElement {
    blurEditor?: () => void;
}

/** Тип функции updateRowValues из tree-ui.ts */
type UpdateRowValuesFn = (
    rowElement: HTMLTableRowElement,
    rowParts: string[],
    rowDataType: string,
    rowScale: number,
    rowHexIndex: number,
    rowOriginalHexLen: number,
    rowPrmListOptions: Record<string, string>,
    argHexToFloat32: (hexStr: string) => number,
    argFloat32ToHex: (floatVal: number, padLen?: number) => string,
    colIndex?: number,
) => void;

export interface TableEditorState {
    slaveAddress?: number;
    isPolling?: boolean;
    currentIniConfig?: IniConfig | null;
}

/** Очистка активных ячеек редактора. */
export function clearAnyActiveCellEditors(): void {
    document.querySelectorAll<EditableCell>('.is-editing-cell').forEach(el => {
        if (el.blurEditor) el.blurEditor();
    });
}

/** Инициализация редактора hex-ячейки. */
export function initHexCellEditor(
    cell: HTMLElement,
    row: HTMLTableRowElement,
    parts: string[],
    hexIndex: number,
    updateFn: UpdateRowValuesFn,
    dataType: string,
    scale: number,
    originalHexLen: number,
    prmListOptions: Record<string, string>,
    stateObj: TableEditorState,
    colIndex: number
): void {
    cell.setAttribute('data-edit-type', 'hex');
    cell.setAttribute('data-col-index', colIndex.toString());
    cell.addEventListener('dblclick', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        startInlineEdit(cell, stateObj);
    });
}

/** Инициализация редактора физической ячейки. */
export function initPhysicalCellEditor(
    cell: HTMLElement,
    row: HTMLTableRowElement,
    parts: string[],
    dataType: string,
    scale: number,
    hexIndex: number,
    originalHexLen: number,
    prmListOptions: Record<string, string>,
    updateFn: UpdateRowValuesFn,
    hexToFloat32Fn: (hexStr: string) => number,
    float32ToHexFn: (floatVal: number, padLen?: number) => string,
    stateObj: TableEditorState,
    colIndex: number
): void {
    cell.setAttribute('data-edit-type', 'phys');
    cell.setAttribute('data-col-index', colIndex.toString());
    cell.addEventListener('dblclick', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        startInlineEdit(cell, stateObj);
    });
}

let editorState: TableEditorState | null = null;

/** Возвращает состояние приложения, сохранённое при инициализации редактора. */
export function getTableEditorState(): TableEditorState | null {
    return editorState;
}

/** Инициализация слушателей инлайн-редактирования. */
export function initTableEditor(containerOrTableId: string | HTMLElement, stateObj: TableEditorState): void {
    editorState = stateObj;
    try {
        const container = typeof containerOrTableId === 'string'
            ? document.getElementById(containerOrTableId)
            : containerOrTableId;
        if (!container) return;
        container.addEventListener('dblclick', (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (!target) return;
            const editableCell = target.closest<HTMLElement>('td.editable-cell');
            if (editableCell) startInlineEdit(editableCell, stateObj);
        });
        console.log("[TableEditor] Инлайн-редактор таблицы подключен.");
    } catch (err) {
        console.error("[TableEditor] Ошибка инициализации:", err);
    }
}
// Ре-экспорт processValueWrite, чтобы другие модули могли его импортировать отсюда
export { processValueWrite } from '../table-editor/value-write.js';