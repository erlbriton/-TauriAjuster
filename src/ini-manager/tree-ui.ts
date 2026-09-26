// src/ini-manager/tree-ui.ts
// Фасад для обратной совместимости импортов.
//
// Раньше этот модуль содержал всё: контекстное меню, рендер дерева
// и обновление ячеек таблицы Modbus. Сейчас код разнесён по трём файлам:
//   - tree-context-menu.ts — контекстное меню (side-effect);
//   - tree-render.ts       — renderDeviceTree;
//   - tree-row-values.ts   — updateRowValues.
//
// Этот файл реэкспортирует публичные функции, чтобы внешние модули
// (file-loader, file-sync, uiManager, device-management, search-navigation,
// new-device-add, device_updater, serial-actions, tree, ChannelRow,
// table-editor) продолжали импортировать их из './tree-ui.js' без правок.

export { renderDeviceTree } from './tree-render.js';
export { updateRowValues } from './tree-row-values.js';