// src/ini-manager/tree-render.ts
// Рендеринг дерева устройств в боковой панели.
//
// Отделён от контекстного меню (tree-context-menu.ts), чтобы файл
// не разрастался. Связь между ними односторонняя:
//   - рендер импортирует 5 функций меню и вызывает их при правом клике
//     на листе или группе;
//   - меню не импортирует рендер — только через setRenderCallback,
//     который регистрируется в конце этого файла.

import { invoke } from '@tauri-apps/api/core';
import { populateDeviceForm } from '../ui/ui.js';
import { renderModbusTable } from '../ui/tree.js';
import {
    setCurrentIniConfig,
    getTreeGroupMode,
    getDeviceGroupKey,
    getDeviceLeafText,
    getAllDevices,
    updateDeviceInRegistry,
    deviceRegistry,
} from './tree-core.js';
import type { TreeGroupMode, DeviceRegistryItem, RawIniConfig } from './tree-core.js';
import { hasAnyDirty, clearAllDirty } from './dirty-tracker.js';
import { showConfirmDialog } from '../ui/confirm-dialog.js';
import { saveIniChanges } from './save-ini.js';
import { processSingleFileContent } from './file-loader.js';
import { decodeTextBuffer } from './textFileReader.js';
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

            // ─── «ЛЁГКАЯ» ЗАПИСЬ: полная загрузка файла при первом клике ──
            // При старте registerDeviceFromHeader прочитал только первые
            // 5 строк файла. Полное содержимое читаем сейчас, при первом
            // клике по устройству. После этого запись перестаёт быть
            // isHeaderOnly, и последующие клики идут по обычному пути.
            if (device.isHeaderOnly && device.path) {
                const appState = (window as unknown as { appState?: AppState }).appState;
                if (!appState) {
                    console.error('[tree-render] appState не найден — невозможно загрузить файл');
                    liElement.classList.remove('is-selected');
                    return;
                }

                try {
                    // Читаем полное содержимое файла с диска.
                    const raw = await invoke<Uint8Array | number[]>('read_ini_file', {
                        path: device.path,
                    });
                    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
                    const content = decodeTextBuffer(bytes.buffer as ArrayBuffer);

                    const fileName = device.path.split(/[\\/]/).pop() || 'unknown.ini';

                    // processSingleFileContent сам:
                    //  - распарсит весь файл;
                    //  - запишет в appState.currentIniContent/currentIniConfig;
                    //  - обновит запись в fileStore (с полным content);
                    //  - заполнит форму устройства (populateDeviceForm);
                    //  - отрисует таблицу Modbus (renderModbusTable);
                    //  - применит конфиги к осциллографу (applyChannelConfigs);
                    //  - синхронизирует список INI с осциллографом;
                    //  - вызовет событие 'app:ini-file-loaded' (автоопрос Modbus).
                    await processSingleFileContent(
                        content,
                        fileName,
                        appState,
                        undefined,
                        undefined,
                        undefined,
                        device.path,
                    );

                    // После полной загрузки обновляем запись в deviceRegistry:
                    // сбрасываем isHeaderOnly и подменяем iniConfig/fullConfig
                    // на полные. Саму структуру дерева не перерисовываем —
                    // displayText не меняется (id/version/date уже были в шапке).
                    const fullConfig = appState.currentIniConfig;
                    if (fullConfig) {
                        for (const loc in deviceRegistry) {
                            const group = deviceRegistry[loc];
                            if (!Array.isArray(group)) continue;
                            const found = group.find((it) => it === device);
                            if (found) {
                                updateDeviceInRegistry(
                                    loc,
                                    found.id,
                                    fullConfig,
                                    fullConfig.parseResult.rawSections as RawIniConfig,
                                );
                                found.isHeaderOnly = false;
                                break;
                            }
                        }
                    }
                } catch (err) {
                    console.error('[tree-render] Ошибка полной загрузки файла:', err);
                    // Снимаем выделение, чтобы пользователь мог кликнуть снова.
                    liElement.classList.remove('is-selected');
                    return;
                }
                return;
            }

            // ─── ОБЫЧНЫЙ ПУТЬ: запись уже загружена целиком ──────────────
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