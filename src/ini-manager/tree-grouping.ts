// src/ini-manager/tree-grouping.ts
// Группировка устройств в левом дереве: режим группировки и вычисление
// ключа/текста для каждого устройства в зависимости от режима.
//
// Файл выделен из tree-core.ts. Импортирует только типы (DeviceRegistryItem,
// RawIniConfig) — во время выполнения зависимостей от tree-core.ts нет,
// цикла не возникает.
//
// Публичный API сохранён через реэкспорт из tree-core.ts, чтобы внешние
// модули (tree-render, search-navigation, device-management, uiManager)
// продолжали импортировать эти символы по старому пути.

import type { DeviceRegistryItem, RawIniConfig } from './tree-core.js';

/** Режим группировки устройств в левом дереве */
export type TreeGroupMode = 'location' | 'serial' | 'mechType' | 'serviceDate' | 'deviceType';

let treeGroupMode: TreeGroupMode = 'location';

export function setTreeGroupMode(mode: TreeGroupMode): void {
    treeGroupMode = mode;
}

export function getTreeGroupMode(): TreeGroupMode {
    return treeGroupMode;
}

/** Сырое значение из секции [DEVICE] без учёта регистра ключа */
function getDeviceRawValue(fullConfig: RawIniConfig, key: string): string {
    const section = fullConfig['DEVICE'];
    if (!section) return '';
    for (const k in section) {
        if (k.toLowerCase() === key.toLowerCase()) {
            const v = section[k];
            if (typeof v === 'string') return v.trim();
            if (Array.isArray(v)) return v.join(' ').trim();
            return String(v ?? '');
        }
    }
    return '';
}

/** Ключ группы для устройства в заданном режиме */
export function getDeviceGroupKey(item: DeviceRegistryItem, mode: TreeGroupMode): string {
    const idLine = getDeviceRawValue(item.fullConfig, 'ID') || String(item.id);
    switch (mode) {
        case 'serial':
            return idLine.split(/\s+/)[0] || idLine;
        case 'mechType':
            return getDeviceRawValue(item.fullConfig, 'Description') || 'Без типа';
        case 'serviceDate':
            return getDeviceRawValue(item.fullConfig, 'LastDateTime') || 'Без даты';
        case 'deviceType': {
            const tokens = idLine.split(/\s+/);
            return tokens.slice(1, 3).join(' ') || idLine;
        }
        case 'location':
        default:
            return getDeviceRawValue(item.fullConfig, 'Location') || 'Неизвестное место';
    }
}

/** Текст строки-листа в дереве (одна строка, полная версия — в title) */
export function getDeviceLeafText(item: DeviceRegistryItem, mode: TreeGroupMode): string {
    const idLine = getDeviceRawValue(item.fullConfig, 'ID') || String(item.id);
    const desc = getDeviceRawValue(item.fullConfig, 'Description');
    const loc = getDeviceRawValue(item.fullConfig, 'Location');
    const dt = getDeviceRawValue(item.fullConfig, 'LastDateTime');
    if (mode === 'serviceDate') {
        return [dt, idLine, desc, loc].filter(Boolean).join(' ');
    }
    const tail = [desc, loc, dt].filter(Boolean).join(' ');
    return tail ? `${idLine} ${tail}` : idLine;
}