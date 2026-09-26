// src/ini-manager/tree-render.ts
// Рендеринг дерева устройств в боковой панели.
//
// Отделён от контекстного меню (tree-context-menu.ts), чтобы файл
// не разрастался. Связь между ними односторонняя:
//   - рендер импортирует 5 функций меню и вызывает их при правом клике
//     на листе или группе;
//   - меню не импортирует рендер — только через setRenderCallback,
//     который регистрируется в конце этого файла.

import { populateDeviceForm } from '../ui/ui.js';
import { renderModbusTable } from '../ui/tree.js';
import {
    setCurrentIniConfig,
    getTreeGroupMode,
    getDeviceGroupKey,
    getDeviceLeafText,
    getAllDevices,
} from './tree-core.js';
import type { TreeGroupMode, DeviceRegistryItem } from './tree-core.js';
import { hasAnyDirty, clearAllDirty } from './dirty-tracker.js';
import { showConfirmDialog } from '../ui/confirm-dialog.js';
import { saveIniChanges } from './save-ini.js';
import type { AppState } from '../core/app-state.js';

// Публичный API контекстного меню. Рендер его вызывает при правом клике
// на листе/группе и регистрирует callback для перерисовки.
import {
    setContextTarget,
    setContextGroupTarget,
    openContextMenu,
    openGroupContextMenu,
    setRenderCallback,
} from './tree-context-menu.js';

export function renderDeviceTree(): void {
    const container = document.querySelector('.sidebar-tree-container');
    if (!container) return;

    container.innerHTML = '';

    const mode: TreeGroupMode = getTreeGroupMode();
    const all = getAllDevices();
    console.log('[tree-render] renderDeviceTree: mode =', mode, 'devices =', all.length);

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
            // РАННИЙ ВЫХОД: Если файл уже активен (подсвечен), ничего не делаем.
            // Это предотвращает повторный запуск одноразового опроса Modbus
            // (который генерирует событие app:ini-file-loaded ниже) и исключает
            // ошибку "Контроллер не отвечает" при повторных кликах по активному файлу.
            if (liElement.classList.contains('is-selected')) {
                return;
            }

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

        // Правый клик — контекстное меню (через публичный API меню)
        liElement.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setContextTarget(device);
            openContextMenu(e.clientX, e.clientY);
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
            setContextGroupTarget(group.items);
            openGroupContextMenu(e.clientX, e.clientY);
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

// Регистрируем callback перерисовки в контекстном меню.
// Меню вызывает его после удаления устройства/группы, чтобы дерево
// обновилось без прямого импорта рендера.
setRenderCallback(renderDeviceTree);