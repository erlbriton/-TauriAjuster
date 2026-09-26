// src/ini-manager/tree-context-menu.ts
// Контекстное меню дерева устройств: правый клик по устройству и по группе.
//
// Меню и рендер дерева разделены, чтобы избежать циклического импорта:
//   - рендер (tree-render.ts) импортирует из этого модуля 5 функций:
//     setContextTarget / setContextGroupTarget — сообщить, на каком
//     элементе открыто меню; openContextMenu / openGroupContextMenu —
//     показать меню в нужной позиции; setRenderCallback — зарегистрировать
//     функцию перерисовки дерева, которую меню вызовет после изменений.
//   - меню НЕ импортирует рендер напрямую — только через callback.

import { populateDeviceForm } from '../ui/ui.js';
import { renderModbusTable } from '../ui/tree.js';
import {
    setCurrentIniConfig,
    getAllDevices,
    removeDeviceItemFromRegistry,
} from './tree-core.js';
import type { DeviceRegistryItem } from './tree-core.js';
import { isNativeApp } from '../core/platform.js';
import { hasAnyDirty, clearAllDirty } from './dirty-tracker.js';
import { showConfirmDialog } from '../ui/confirm-dialog.js';
import { saveIniChanges } from './save-ini.js';
import type { AppState } from '../core/app-state.js';
import { getFileStore } from './file-loader.js';

// ============================================================================
// Состояние меню
// ============================================================================

/** Устройство, на строке которого открыто контекстное меню */
let contextTarget: DeviceRegistryItem | null = null;

/** Устройства группы, на заголовке которой открыто контекстное меню */
let contextGroupTarget: DeviceRegistryItem[] | null = null;

/**
 * Callback перерисовки дерева, регистрируется из tree-render.ts
 * через setRenderCallback. Нужен, чтобы меню могло попросить рендер
 * обновиться, не импортируя его напрямую (иначе — циклический импорт).
 */
let renderCallback: (() => void) | null = null;

/** Регистрация функции перерисовки дерева (вызывается из tree-render.ts). */
export function setRenderCallback(fn: () => void): void {
    renderCallback = fn;
}

/** Попросить рендер перерисовать дерево, если callback зарегистрирован. */
function triggerRender(): void {
    if (renderCallback) renderCallback();
}

// ============================================================================
// Публичный API для рендера
// ============================================================================

/** Сообщить меню, на какой строке устройства открыть его. */
export function setContextTarget(device: DeviceRegistryItem | null): void {
    contextTarget = device;
}

/** Сообщить меню, на какой группе устройств открыть его. */
export function setContextGroupTarget(items: DeviceRegistryItem[] | null): void {
    contextGroupTarget = items;
}

/** Показать контекстное меню устройства в позиции курсора. */
export function openContextMenu(x: number, y: number): void {
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

/** Показать контекстное меню группы в позиции курсора. */
export function openGroupContextMenu(x: number, y: number): void {
    const menu = document.getElementById('treeGroupContextMenu');
    if (!menu) return;
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.min(x, Math.max(0, maxX))}px`;
    menu.style.top = `${Math.min(y, Math.max(0, maxY))}px`;
}

// ============================================================================
// Внутреннее: скрытие меню
// ============================================================================

/** Скрыть контекстное меню устройства */
function hideTreeContextMenu(): void {
    const menu = document.getElementById('treeContextMenu');
    if (menu) menu.classList.add('hidden');
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

// ============================================================================
// Обработчик: "Удалить" для группы
// ============================================================================

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
            triggerRender();
            
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

// ============================================================================
// Общая логика удаления устройства из списка
// ============================================================================

/**
 * Общая часть удаления устройства из списка (реестра) приложения.
 * Убирает запись из реестра, рассылает событие app:device-removed
 * (по нему file-loader уберёт файл из хранилища и синхронизирует список
 * с осциллографом), перерисовывает дерево и, если удалённый файл был
 * активным (подсвеченным), выбирает первый оставшийся файл либо очищает
 * таблицу и форму устройства.
 * Вынесена в отдельную функцию, чтобы её использовали ОБА пункта меню:
 * "Удалить" (только из списка) и "Удалить с диска" (файл + список).
 */
async function removeDeviceFromRegistryAndRefresh(target: DeviceRegistryItem): Promise<void> {
    // Проверяем, был ли удаляемый файл текущим (подсвеченным)
    const wasSelected = document.querySelector(`.tree-id-item.is-selected[data-device-id="${CSS.escape(target.id)}"]`);

    const removed = removeDeviceItemFromRegistry(target);
    if (removed) {
        // file-loader по этому событию уберёт файл из хранилища
        // и синхронизирует список с осциллографом
        window.dispatchEvent(new CustomEvent('app:device-removed', {
            detail: { id: String(target.id) },
        }));
        triggerRender();

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
}

// ============================================================================
// Обработчик: "Удалить" (из списка, файл на диске НЕ трогает)
// ============================================================================

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

        // Общая логика удаления из списка (вынесена в функцию выше)
        await removeDeviceFromRegistryAndRefresh(contextTarget);
        contextTarget = null;
        hideTreeContextMenu();
    });
}

// ============================================================================
// Обработчик: "Удалить с диска" (файл + список)
// ============================================================================

const ctxDeleteFromDiskEl = document.getElementById('ctxDeleteFromDisk');
if (ctxDeleteFromDiskEl) {
    ctxDeleteFromDiskEl.addEventListener('click', async () => {
        if (!contextTarget) return;

        // 1. Если есть несохранённые изменения — спросить, записать ли их на диск.
        //    Тот же вопрос, что задаёт пункт "Удалить": иначе несохранённые правки
        //    ДРУГИХ открытых файлов исчезнут без предупреждения.
        if (hasAnyDirty()) {
            const save = await showConfirmDialog('Записать изменения на диск перед удалением?');
            if (save === null) {
                contextTarget = null;
                hideTreeContextMenu();
                return; // Отмена
            }
            if (save) {
                const appState = (window as unknown as { appState?: AppState }).appState;
                if (appState) await saveIniChanges(appState);
            }
            clearAllDirty();
        }

        // 2. Ищем путь к файлу в fileStore (точно так же, как это делает
        //    пункт "Открыть папку с файлом"): записи хранилища сопоставляются
        //    с устройствами по id.
        const fileStore = getFileStore();
        let filePath: string | undefined;
        for (const entry of fileStore.values()) {
            if (entry.id === String(contextTarget.id)) {
                filePath = entry.path;
                break;
            }
        }

        if (!filePath) {
            // Без пути удалять нечего — сообщаем и выходим
            console.warn('[tree-context-menu] Путь к файлу не найден в fileStore для устройства:', contextTarget.id);
            alert('Не удалось определить путь к файлу на диске.');
            contextTarget = null;
            hideTreeContextMenu();
            return;
        }

        // 3. Подтверждение БЕЗВОЗВРАТНОГО удаления с диска (с показом пути,
        //    чтобы пользователь точно понимал, какой файл уходит).
        const confirmed = await showConfirmDialog(
            `Удалить файл с диска безвозвратно?\n\n${filePath}`
        );
        if (confirmed !== true) {
            // Отмена или закрытие диалога — ничего не делаем
            contextTarget = null;
            hideTreeContextMenu();
            return;
        }

        // 4. Физическое удаление файла через Rust-команду.
        //    Именно Rust, а не плагин fs: рабочая папка приложения может лежать
        //    где угодно, а скоупы плагина fs запретили бы произвольный путь.
        try {
            await window.__TAURI__.core.invoke('delete_file_from_disk', { path: filePath });
        } catch (err) {
            console.error('[tree-context-menu] Ошибка удаления файла с диска:', err);
            alert(`Не удалось удалить файл с диска:\n${err instanceof Error ? err.message : String(err)}`);
            contextTarget = null;
            hideTreeContextMenu();
            return;
        }

        // 5. Файл удалён с диска — убираем устройство из списка загруженных
        //    (та же логика, что у пункта "Удалить")
        await removeDeviceFromRegistryAndRefresh(contextTarget);

        contextTarget = null;
        hideTreeContextMenu();
    });
}

// ============================================================================
// Обработчики: "Открыть файл" и "Открыть папку"
// ============================================================================

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
                    console.error('[tree-context-menu] Ошибка открытия папки:', err);
                }
            } else {
                console.warn('[tree-context-menu] Путь к файлу не найден в fileStore для устройства:', contextTarget.id);
            }
        }
        contextTarget = null;
        hideTreeContextMenu();
    });
}