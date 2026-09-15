// src/ini-manager/table-editor.ts — ФАСАД
// Ре-экспортирует всё, что раньше было в этом файле, чтобы остальные модули
// (tree-ui.ts, device_updater.ts и т.д.) продолжали импортировать отсюда.

import { serialManager, calculateCRC } from '../serial/serial-actions.js';
import type { IniConfig } from '../core/ini/index.js';
import { startInlineEdit } from '../table-editor/inline-edit.js';

/** Ячейка с активным инлайн-редактором */
export interface EditableCell extends HTMLElement {
    blurEditor?: () => void;
}

/** Тип функции updateRowValues из tree-ui.ts */
export type UpdateRowValuesFn = (
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

/** Прямая Modbus-запись (FC06 / FC16). Используется в других частях проекта. */
export async function sendModbusWriteCommand(
    slaveAddr: number,
    startReg: number,
    words: number[]
): Promise<boolean> {
    if (!words || words.length === 0) return false;

    if (words.length === 1) {
        const word = words[0] & 0xFFFF;
        const body = new Uint8Array([
            slaveAddr & 0xFF,
            0x06,
            (startReg >> 8) & 0xFF,
            startReg & 0xFF,
            (word >> 8) & 0xFF,
            word & 0xFF
        ]);
        const crc = calculateCRC(body);
        const packet = new Uint8Array(8);
        packet.set(body, 0);
        packet[6] = crc & 0xFF;
        packet[7] = (crc >> 8) & 0xFF;

        const checkComplete = (buf: Uint8Array) => buf.length >= 8;
        try {
            const response = await serialManager.executeTransaction(packet, checkComplete, 1000);
            return response.length >= 8 && response[1] === 0x06;
        } catch (err) {
            console.error("[TableEditor] Ошибка записи FC 06:", err);
            return false;
        }
    } else {
        const regCount = words.length;
        const byteCount = regCount * 2;
        const body = new Uint8Array(7 + byteCount);
        body[0] = slaveAddr & 0xFF;
        body[1] = 0x10;
        body[2] = (startReg >> 8) & 0xFF;
        body[3] = startReg & 0xFF;
        body[4] = (regCount >> 8) & 0xFF;
        body[5] = regCount & 0xFF;
        body[6] = byteCount & 0xFF;
        for (let i = 0; i < regCount; i++) {
            const word = words[i] & 0xFFFF;
            body[7 + i * 2] = (word >> 8) & 0xFF;
            body[8 + i * 2] = word & 0xFF;
        }
        const crc = calculateCRC(body);
        const packet = new Uint8Array(body.length + 2);
        packet.set(body, 0);
        packet[body.length] = crc & 0xFF;
        packet[body.length + 1] = (crc >> 8) & 0xFF;

        const checkComplete = (buf: Uint8Array) => buf.length >= 8;
        try {
            const response = await serialManager.executeTransaction(packet, checkComplete, 1000);
            return response.length >= 8 && response[1] === 0x10;
        } catch (err) {
            console.error("[TableEditor] Ошибка записи FC 16:", err);
            return false;
        }
    }
}

// Ре-экспорт processValueWrite, чтобы другие модули могли его импортировать отсюда
export { processValueWrite } from '../table-editor/value-write.js';