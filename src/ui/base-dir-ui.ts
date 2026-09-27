// src/ui/base-dir-ui.ts
// UI окна «Сменить папку базы»: список сохранённых путей из controllers.txt,
// добавление новых папок через системный диалог, применение с перезапуском.
//
// Модуль не тянет зависимости напрямую — они передаются через initBaseDirUI.
// Это позволяет:
//   - избежать циклических импортов (ui/ui.ts, save-ini.ts, dirty-tracker.ts);
//   - тестировать модуль в отрыве от остального приложения;
//   - переносить в браузерную версию с минимальными правками.

/// <reference types="vite/client" />

import { invoke } from '@tauri-apps/api/core';
import { open, ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

import { showIdModal } from './ui.js';
import type { AppState } from '../core/app-state.js';

/** Специальное значение для пункта «По умолчанию (папка приложения)». */
const DEFAULT_OPTION_VALUE = '__default__';

/** Ответ Rust-команды list_saved_bases. */
interface SavedBasesInfo {
    current: string | null;
    exe_dir: string;
    saved: string[];
}

/**
 * Зависимости, передаваемые из main.ts при инициализации.
 */
export interface BaseDirUIDeps {
    /** Общее состояние приложения (нужно для saveIniChanges). */
    appState: AppState;
    /** Есть ли несохранённые изменения в открытых INI. */
    hasDirty: () => boolean;
    /** Сохранить изменения. Возвращает true при успехе. */
    saveIni: (state: AppState) => Promise<boolean>;
    /** Диалог подтверждения (showConfirmDialog). null = отмена. */
    confirm: (text: string) => Promise<boolean | null>;
}

/**
 * Навешивает обработчики на пункт меню «Сменить папку базы…» и кнопки
 * модального окна. Вызывается один раз при инициализации UI.
 */
export function initBaseDirUI(deps: BaseDirUIDeps): void {
    // Пункт в выпадающем меню «Обновить список устройств».
    document.getElementById('menuChangeBase')?.addEventListener('click', () => {
        void openDialog(deps);
    });

    // Закрытие окна: крестик, «Отмена», клик по подложке.
    document.getElementById('baseDirCloseBtn')?.addEventListener('click', hideDialog);
    document.getElementById('baseDirCancelBtn')?.addEventListener('click', hideDialog);
    document.getElementById('baseDirOverlay')?.addEventListener('click', (e: MouseEvent) => {
        if (e.target === e.currentTarget) hideDialog();
    });

    // «Добавить…» — открыть системный диалог выбора папки.
    document.getElementById('baseDirAddBtn')?.addEventListener('click', () => {
        void handleAdd();
    });

    // «Применить» — сохранить выбор и перезапустить приложение.
    document.getElementById('baseDirApplyBtn')?.addEventListener('click', () => {
        void handleApply(deps);
    });
}

/**
 * Открывает окно: проверяет наличие controllers.txt, при отсутствии —
 * предлагает создать. Заполняет выпадающий список сохранённых путей.
 */
async function openDialog(deps: BaseDirUIDeps): Promise<void> {
    // Закрываем выпадающее меню, из которого пришёл клик.
    const dropdown = document.getElementById('deviceListDropdown');
    if (dropdown) dropdown.style.display = 'none';

    // Файл controllers.txt существует?
    try {
        const exists = await invoke<boolean>('controllers_file_exists');
        if (!exists) {
            const create = await ask(
                'Файл controllers.txt не найден рядом с приложением.\n\nСоздать его?',
                { title: 'Сменить папку базы', kind: 'info' },
            );
            if (!create) {
                // Пользователь отказался создавать файл — выходим,
                // приложение продолжит работать с папкой exe.
                return;
            }
            await invoke('ensure_controllers_file');
        }
    } catch (err) {
        console.error('[base-dir-ui] Ошибка проверки controllers.txt:', err);
        return;
    }

    // Читаем список сохранённых баз.
    let info: SavedBasesInfo;
    try {
        info = await invoke<SavedBasesInfo>('list_saved_bases');
    } catch (err) {
        console.error('[base-dir-ui] Ошибка list_saved_bases:', err);
        return;
    }

    // Заполняем выпадающий список.
    const select = document.getElementById('baseDirSelect') as HTMLSelectElement | null;
    if (!select) return;
    select.innerHTML = '';

    // 1. Пункт «По умолчанию (папка приложения)» — всегда первый.
    const defaultOpt = document.createElement('option');
    defaultOpt.value = DEFAULT_OPTION_VALUE;
    defaultOpt.textContent = 'По умолчанию (папка приложения)';
    select.appendChild(defaultOpt);

    // 2. Сохранённые пути.
    for (const p of info.saved) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        select.appendChild(opt);
    }

    // 3. Если текущая база — сохранённый путь, но его нет в списке
    //    (например, файл правили вручную) — добавляем, чтобы select
    //    корректно показал текущее значение.
    if (info.current && !info.saved.includes(info.current)) {
        const opt = document.createElement('option');
        opt.value = info.current;
        opt.textContent = info.current;
        select.appendChild(opt);
    }

    // 4. Выбираем текущее значение.
    select.value = info.current ?? DEFAULT_OPTION_VALUE;

    // Показываем окно.
    document.getElementById('baseDirOverlay')?.classList.remove('hidden');
}

/** Скрывает окно без каких-либо действий. */
function hideDialog(): void {
    document.getElementById('baseDirOverlay')?.classList.add('hidden');
}

/**
 * Обработчик «Добавить…»: открывает системный диалог выбора папки
 * и добавляет выбранный путь в выпадающий список (если его там ещё нет).
 *
 * Путь пока не сохраняется в controllers.txt — это произойдёт только
 * при нажатии «Применить». Если пользователь нажмёт «Отмена», путь
 * не будет записан.
 */
async function handleAdd(): Promise<void> {
    let selected: string | null = null;
    try {
        const result = await open({ directory: true, title: 'Выберите базовую папку' });
        if (typeof result === 'string') selected = result;
    } catch (err) {
        console.error('[base-dir-ui] Ошибка выбора папки:', err);
        return;
    }
    if (!selected) return; // пользователь отменил

    const select = document.getElementById('baseDirSelect') as HTMLSelectElement | null;
    if (!select) return;

    // Если такой путь уже есть — просто выбираем его.
    const existing = Array.from(select.options).find((o) => o.value === selected);
    if (existing) {
        select.value = selected;
        return;
    }

    // Добавляем новую опцию и выбираем её.
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    select.appendChild(opt);
    select.value = selected;
}

/**
 * Обработчик «Применить»:
 *   1. Проверяет, не выбран ли уже текущий режим (чтобы не перезапускаться зря).
 *   2. Спрашивает про несохранённые изменения.
 *   3. Вызывает set_base_dir или reset_base_dir.
 *   4. Закрывает COM-порт (чтобы при перезапуске драйвер не держал устройство).
 *   5. Перезапускает приложение через relaunch() (в проде) — либо показывает
 *      сообщение с просьбой перезапустить вручную (в dev-режиме).
 *
 * relaunch() вызывается без await: процесс умрёт раньше, чем промис разрешится.
 * Если relaunch бросит исключение — приложение останется открытым, пользователь
 * сможет закрыть его вручную и запустить заново — controllers.txt уже сохранён,
 * новая база применится при старте.
 */
async function handleApply(deps: BaseDirUIDeps): Promise<void> {
    const select = document.getElementById('baseDirSelect') as HTMLSelectElement | null;
    if (!select) return;
    const value = select.value;
    console.log('[base-dir-ui] handleApply: выбранное значение =', value);

    // Проверяем текущее состояние, чтобы не перезапускаться зря.
    let info: SavedBasesInfo;
    try {
        info = await invoke<SavedBasesInfo>('list_saved_bases');
        console.log('[base-dir-ui] list_saved_bases:', info);
    } catch (err) {
        console.error('[base-dir-ui] Ошибка list_saved_bases:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal('Не удалось прочитать список баз: ' + msg);
        return;
    }

    const isDefault = value === DEFAULT_OPTION_VALUE;
    const currentIsDefault = !info.current;

    // Если выбор совпадает с текущим состоянием — сообщаем пользователю
    // и НЕ закрываем окно, чтобы он видел: изменений не будет.
    if (isDefault && currentIsDefault) {
        showIdModal('Уже используется папка по умолчанию (рядом с приложением).');
        return;
    }
    if (!isDefault && info.current === value) {
        showIdModal('Эта папка уже используется как базовая.');
        return;
    }

    // Проверяем несохранённые изменения.
    if (deps.hasDirty()) {
        const save = await deps.confirm('Есть несохранённые изменения. Сохранить перед сменой базы?');
        if (save === null) {
            // Отмена диалога — прерываем смену базы, окно не закрываем.
            return;
        }
        if (save) {
            await deps.saveIni(deps.appState);
        }
    }

    // Записываем новое состояние в controllers.txt.
    try {
        if (isDefault) {
            await invoke('reset_base_dir');
        } else {
            await invoke('set_base_dir', { path: value });
        }
        console.log('[base-dir-ui] База сохранена в controllers.txt');
    } catch (err) {
        console.error('[base-dir-ui] Ошибка сохранения базы:', err);
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal('Не удалось применить базу:\n' + msg);
        return;
    }

    // Закрываем COM-порт — при перезапуске он должен быть свободен.
    // Ошибку игнорируем: если порт не был открыт, команда вернёт ошибку,
    // но это нормальная ситуация.
    try {
        await invoke('close_serial_port');
    } catch {
        // ничего не делаем
    }

    // Перезапуск приложения.
    // В dev-режиме (npm run tauri dev) Vite-сервер не перезапускается,
    // поэтому relaunch() привёл бы к ошибке "Connection refused".
    // В продакшене (npm run tauri build) фронтенд встроен в приложение,
    // и relaunch() работает корректно. Vite на этапе сборки заменит
    // import.meta.env.DEV на false, и весь блок ниже будет вырезан
    // из финального бандла.
    if (import.meta.env.DEV) {
        console.log('[base-dir-ui] Dev-режим: relaunch() не вызывается.');
        showIdModal(
            'База сохранена.\n\n' +
            'В режиме разработки автоматический перезапуск не работает — ' +
            'закройте приложение (Ctrl+C в терминале) и запустите заново.'
        );
        return;
    }

    console.log('[base-dir-ui] Перезапуск приложения через relaunch()...');
    relaunch().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[base-dir-ui] Ошибка relaunch:', err);
        showIdModal(
            'Не удалось автоматически перезапустить приложение.\n' +
            'Новая база сохранена — закройте и запустите приложение вручную.\n\n' +
            'Причина: ' + msg
        );
    });
}