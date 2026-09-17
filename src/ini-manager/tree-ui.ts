// src/ini-manager/tree-ui.ts

import { populateDeviceForm } from '../ui/ui.js';
import { renderModbusTable } from '../ui/tree.js';
import {
    deviceRegistry,
    setCurrentIniConfig,
    hexToFloat32,
    float32ToHex,
    getTreeGroupMode,
    getDeviceGroupKey,
    getDeviceLeafText,
    getAllDevices,
    removeDeviceItemFromRegistry,
} from './tree-core.js';
import type { TreeGroupMode, DeviceRegistryItem } from './tree-core.js';
import { isNativeApp } from '../core/platform.js';
import { hasAnyDirty, clearAllDirty } from './dirty-tracker.js';
import { showConfirmDialog } from '../ui/confirm-dialog.js';
import { saveIniChanges } from './save-ini.js';
import type { AppState } from '../core/app-state.js';
import { currentIniConfig } from './tree-core.js';
import { getFileStore } from './file-loader.js';

// ============================================================================
// Контекстное меню дерева устройств
// ============================================================================

/** Устройство, на строке которого открыто контекстное меню */
let contextTarget: DeviceRegistryItem | null = null;

/** Устройства группы, на заголовке которой открыто контекстное меню */
let contextGroupTarget: DeviceRegistryItem[] | null = null;

/** Показать контекстное меню в позиции курсора */
function showTreeContextMenu(x: number, y: number): void {
    const menu = document.getElementById('treeContextMenu');
    if (!menu) return;
    menu.classList.remove('hidden');
    // Не выпускаем меню за пределы экрана
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
    menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;
}

/** Скрыть контекстное меню */
function hideTreeContextMenu(): void {
    const menu = document.getElementById('treeContextMenu');
    if (menu) menu.classList.add('hidden');
}

/** Показать контекстное меню группы в позиции курсора */
function showTreeGroupContextMenu(x: number, y: number): void {
    const menu = document.getElementById('treeGroupContextMenu');
    if (!menu) return;
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
    menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;
}

/** Скрыть контекстное меню группы */
function hideTreeGroupContextMenu(): void {
    const menu = document.getElementById('treeGroupContextMenu');
    if (menu) menu.classList.add('hidden');
}

// Скрытие обоих меню по левому клику в любом месте и по Escape
document.addEventListener('click', () => {
    hideTreeContextMenu();
    hideTreeGroupContextMenu();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideTreeContextMenu();
        hideTreeGroupContextMenu();
    }
});

// Пункт меню "Удалить" для группы: убирает все устройства группы
const ctxGroupDeleteEl = document.getElementById('ctxGroupDelete');
if (ctxGroupDeleteEl) {
    ctxGroupDeleteEl.addEventListener('click', async () => {
        if (contextGroupTarget && contextGroupTarget.length > 0) {
            // Если есть несохранённые изменения — спросить перед удалением
            if (hasAnyDirty()) {
                const save = await showConfirmDialog('Записать изменения на диск перед удалением группы?');
                if (save === null) {
                    contextGroupTarget = null;
                    hideTreeGroupContextMenu();
                    return; // Отмена
                }
                if (save) {
                    const appState = (window as unknown as { appState?: AppState }).appState;
                    if (appState) await saveIniChanges(appState);
                }
                clearAllDirty();
            }
            
            // Проверяем, был ли один из удаляемых файлов текущим
            const selectedElement = document.querySelector('.tree-id-item.is-selected');
            const selectedId = selectedElement?.getAttribute('data-device-id');
            const wasSelectedInGroup = contextGroupTarget.some(item => String(item.id) === selectedId);
            
            const ids: string[] = [];
            for (const item of [...contextGroupTarget]) {
                if (removeDeviceItemFromRegistry(item)) {
                    ids.push(String(item.id));
                }
            }
            for (const id of ids) {
                window.dispatchEvent(new CustomEvent('app:device-removed', { detail: { id } }));
            }
            renderDeviceTree();
            
            // Если удалили текущий файл — выбираем другой или очищаем таблицу
            if (wasSelectedInGroup) {
                const remaining = getAllDevices();
                if (remaining.length > 0) {
                    const firstLi = document.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
                    if (firstLi) {
                        // Раскрываем родительскую группу <details>, если она свёрнута
                        const details = firstLi.closest('details');
                        if (details && !(details as HTMLDetailsElement).open) {
                            (details as HTMLDetailsElement).open = true;
                        }
                        firstLi.click();
                        // Прокручиваем, чтобы подсвеченный файл был виден
                        firstLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                } else {
                    setCurrentIniConfig(null);
                    renderModbusTable();
                    populateDeviceForm({});
                }
            }
        }
        contextGroupTarget = null;
        hideTreeGroupContextMenu();
    });
}

// Пункт меню "Удалить": убирает устройство из списка загруженных
const ctxDeleteEl = document.getElementById('ctxDelete');
if (ctxDeleteEl) {
    ctxDeleteEl.addEventListener('click', async () => {
        if (!contextTarget) return;
        // Если есть несохранённые изменения — спросить перед удалением
        if (hasAnyDirty()) {
            const save = await showConfirmDialog('Записать изменения на диск перед удалением?');
            if (save === null) return; // Отмена
            if (save) {
                const appState = (window as unknown as { appState?: AppState }).appState;
                if (appState) await saveIniChanges(appState);
            }
            clearAllDirty();
        }
        
        // Проверяем, был ли удаляемый файл текущим (подсвеченным)
        const wasSelected = document.querySelector(`.tree-id-item.is-selected[data-device-id="${CSS.escape(contextTarget.id)}"]`);
        
        const removed = removeDeviceItemFromRegistry(contextTarget);
        if (removed) {
            // file-loader по этому событию уберёт файл из хранилища
            // и синхронизирует список с осциллографом
            window.dispatchEvent(new CustomEvent('app:device-removed', {
                detail: { id: String(contextTarget.id) },
            }));
            renderDeviceTree();
            
            // Если удалили текущий файл — выбираем другой или очищаем таблицу
            if (wasSelected) {
                const remaining = getAllDevices();
                if (remaining.length > 0) {
                    // Выбираем первый оставшийся файл в дереве
                    const firstLi = document.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
                    if (firstLi) {
                        // Раскрываем родительскую группу <details>, если она свёрнута
                        const details = firstLi.closest('details');
                        if (details && !(details as HTMLDetailsElement).open) {
                            (details as HTMLDetailsElement).open = true;
                        }
                        firstLi.click();
                        // Прокручиваем, чтобы подсвеченный файл был виден
                        firstLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                } else {
                    // Файлов не осталось — очищаем таблицу и форму
                    setCurrentIniConfig(null);
                    renderModbusTable();
                    populateDeviceForm({});
                }
            }
        }
        contextTarget = null;
        hideTreeContextMenu();
    });
}

// "Открыть папку с файлом" недоступно в браузере — скрываем пункт.
// В нативной версии (Tauri) пункт появится автоматически.
if (!isNativeApp()) {
    const ctxOpenFolderEl = document.getElementById('ctxOpenFolder');
    if (ctxOpenFolderEl) ctxOpenFolderEl.classList.add('ctx-hidden');
}

// Пункт "Открыть файл для редактирования": запрашиваем редактор событием
const ctxOpenFileEl = document.getElementById('ctxOpenFile');
if (ctxOpenFileEl) {
    ctxOpenFileEl.addEventListener('click', () => {
        if (contextTarget) {
            window.dispatchEvent(new CustomEvent('app:edit-device-requested', {
                detail: { id: String(contextTarget.id) },
            }));
        }
        contextTarget = null;
        hideTreeContextMenu();
    });
}

// Пункт "Открыть папку с файлом": находим путь в fileStore и вызываем Rust-команду,
// которая откроет папку в файловом менеджере (с выделением файла на Windows/macOS).
const ctxOpenFolderEl = document.getElementById('ctxOpenFolder');
if (ctxOpenFolderEl) {
    ctxOpenFolderEl.addEventListener('click', async () => {
        if (contextTarget) {
            // Ищем запись в fileStore по id устройства
            const fileStore = getFileStore();
            let filePath: string | undefined;
            for (const entry of fileStore.values()) {
                if (entry.id === String(contextTarget.id)) {
                    filePath = entry.path;
                    break;
                }
            }
            
            if (filePath) {
                try {
                    await window.__TAURI__.core.invoke<void>('open_file_location', {
                        path: filePath
                    });
                } catch (err) {
                    console.error('[tree-ui] Ошибка открытия папки:', err);
                    // showIdModal или другой способ уведомления об ошибке
                }
            } else {
                console.warn('[tree-ui] Путь к файлу не найден в fileStore для устройства:', contextTarget.id);
            }
        }
        contextTarget = null;
        hideTreeContextMenu();
    });
}

export function renderDeviceTree(): void {
    const container = document.querySelector('.sidebar-tree-container');
    if (!container) return;

    container.innerHTML = '';

    const mode: TreeGroupMode = getTreeGroupMode();
    const all = getAllDevices();
    console.log('[tree-ui] renderDeviceTree: mode =', mode, 'devices =', all.length);

    // Стиль строки-листа: одна строка, не влезла — обрезается,
    // полная версия показывается в подсказке при наведении
    const makeLeaf = (device: DeviceRegistryItem): HTMLLIElement => {
        const liElement = document.createElement('li');
        liElement.className = 'tree-id-item is-leaf' + (device.isBackup ? ' is-backup' : '');
        liElement.dataset.deviceId = device.id;
        const text = getDeviceLeafText(device, mode);
        liElement.textContent = text;
        liElement.title = text;
        liElement.style.whiteSpace = 'nowrap';
        liElement.style.overflow = 'hidden';
        liElement.style.textOverflow = 'ellipsis';

        liElement.addEventListener('click', async () => {
            // Если есть несохранённые изменения — спросить перед переключением
            if (hasAnyDirty()) {
                const save = await showConfirmDialog('Записать изменения на диск?');
                if (save === null) return; // Отмена
                if (save) {
                    const appState = (window as unknown as { appState?: AppState }).appState;
                    if (appState) await saveIniChanges(appState);
                }
                clearAllDirty();
            }
            document.querySelectorAll('.tree-id-item.is-selected').forEach(el => el.classList.remove('is-selected'));
            liElement.classList.add('is-selected');
            setCurrentIniConfig(device.iniConfig);
            populateDeviceForm(device.fullConfig['DEVICE']);
            renderModbusTable(device.iniConfig);

            // SYNC WITH OSCILLOSCOPE
            if (window.osc) {
                window.osc.setActiveIni(device.id);
            }

            // Автоопрос контроллера при смене устройства (как после первой загрузки файла)
            window.dispatchEvent(new CustomEvent('app:ini-file-loaded'));
        });

        // Правый клик — контекстное меню (пока только показ, действия — следующим шагом)
        liElement.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            contextTarget = device;
            showTreeContextMenu(e.clientX, e.clientY);
        });

        return liElement;
    };

    // Плоские режимы: "Серийные номера" и "Дата последнего обслуживания" — без заголовков
    if (mode === 'serial' || mode === 'serviceDate') {
        const ulElement = document.createElement('ul');
        ulElement.className = 'tree-id-list';

        let list = all;
        if (mode === 'serial') {
            // По возрастанию номера (число-осознающее сравнение)
            list = [...all].sort((a, b) =>
                getDeviceGroupKey(a, mode).localeCompare(getDeviceGroupKey(b, mode), undefined, { numeric: true }),
            );
        }
        // serviceDate — порядок загрузки, как в старом аджастере

        list.forEach(device => {
            ulElement.appendChild(makeLeaf(device));
        });
        container.appendChild(ulElement);
        return;
    }

    // Режимы с группировкой: заголовки всегда, группы в порядке загрузки
    const groups: Array<{ key: string; items: DeviceRegistryItem[] }> = [];
    for (const device of all) {
        const key = getDeviceGroupKey(device, mode);
        let group = groups.find(g => g.key === key);
        if (!group) {
            group = { key, items: [] };
            groups.push(group);
        }
        group.items.push(device);
    }

    for (const group of groups) {
        const detailsElement = document.createElement('details');
        detailsElement.className = 'tree-location';
        detailsElement.open = false;

        const summaryElement = document.createElement('summary');
        summaryElement.className = 'tree-location-title';
        summaryElement.textContent = group.key;
        summaryElement.title = group.key;

        // Правый клик на заголовке группы — меню удаления всей группы
        summaryElement.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            contextGroupTarget = group.items;
            showTreeGroupContextMenu(e.clientX, e.clientY);
        });

        const ulElement = document.createElement('ul');
        ulElement.className = 'tree-id-list';

        group.items.forEach(device => {
            ulElement.appendChild(makeLeaf(device));
        });

        detailsElement.appendChild(summaryElement);
        detailsElement.appendChild(ulElement);
        container.appendChild(detailsElement);
    }
}

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
        // device_updater пишет в последний элемент parts hexValue вида "x0", "x1" или "x0000", "x0001" (с паддингом).
        // Извлекаем значение бита (0 или 1) правильно.
        const bitValueRaw = rowParts[rowParts.length - 1] ? rowParts[rowParts.length - 1].trim() : 'x0';
        let bitStr = '0';

        if (bitValueRaw.startsWith('x') || bitValueRaw.startsWith('X')) {
            const hexPart = bitValueRaw.slice(1);
            if (hexPart.length > 0) {
                // Берём последний hex-символ (младшая цифра числа)
                const lastChar = hexPart[hexPart.length - 1];
                const bitNum = parseInt(lastChar, 16);
                if (!isNaN(bitNum)) {
                    bitStr = (bitNum & 1).toString();
                }
            }
        } else if (bitValueRaw === '1' || bitValueRaw === '0') {
            // Fallback, если где-то всё же записано просто "0" или "1"
            bitStr = bitValueRaw;
        }

        bPhysical = bitStr;
        bHex = bitStr;
    } else {
        let rHex = '';
                console.log(`[updateRowValues] data-type=${rowDataType}, upper=${dataTypeUpper}, hex=${rHex || '—'}`);
        if (rowHexIndex !== -1) {
            rHex = rowParts[rowHexIndex];
        }
        if (rHex && rHex.startsWith('x')) {
            bHex = 'x' + rHex.slice(1).toUpperCase();

            if (dataTypeUpper === 'TIPADDR') {
                // Для TIPAddr: rHex содержит 8 hex-символов (32 бита).
                // Разбиваем на lowWord и highWord (LE порядок регистров), как в осциллографе.
                const hexVal = parseInt(rHex.slice(1), 16);
                if (!isNaN(hexVal)) {
                    const ipStr = `${(hexVal >>> 24) & 0xFF}.${(hexVal >>> 16) & 0xFF}.${(hexVal >>> 8) & 0xFF}.${hexVal & 0xFF}`;
                    bPhysical = `<div class="prm-val-display">${ipStr}</div>`;
                } else {
                    bPhysical = `<div class="prm-val-display">—</div>`;
                }
            } else if (dataTypeUpper === 'TPRMLIST') {
                const decValue = parseInt(rHex.slice(1), 16);

                // Собираем опции: сначала из переданного rowPrmListOptions,
                // а если он пуст — парсим напрямую из rowParts (формат "hex#текст")
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

                // Числовой поиск опции (игнорирует ведущие нули: x0005 == x05)
                let displayText = decValue.toString();
                if (Object.keys(options).length > 0) {
                    for (const hexKey in options) {
                        if (parseInt(hexKey.slice(1), 16) === decValue) {
                            displayText = options[hexKey];
                            break;
                        }
                    }
                }

                // В обеих ячейках Базы показываем только текст опции (или число), без <select> и без hex.
                // Редактирование Базы происходит через startInlineEdit (по двойному клику), а не через встроенный список.
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
                                   // Знаковое преобразование для целых типов
                    if (!isNaN(decValue)) {
                        if (dataTypeUpper === 'TSHORT' || dataTypeUpper === 'TINT16' || dataTypeUpper === 'TINTEGER') {
                            // 16-битное знаковое: если > 32767, вычесть 65536
                            if (decValue > 32767) decValue -= 65536;
                        } else if (dataTypeUpper === 'TLONG' || dataTypeUpper === 'TINT32') {
                            // 32-битное знаковое: если > 2147483647, вычесть 4294967296
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

    // Перепривязываем обработчик события для выпадающего списка TPrmList
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