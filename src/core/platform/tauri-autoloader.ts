// src/core/platform/tauri-autoloader.ts
// Автозагрузчик INI-файлов из папки Devices, лежащей рядом с исполняемым файлом.
//
// Как это работает:
//  1. Вызываем Rust-команду scan_devices_folder (см. src-tauri/src/commands/ini.rs),
//     которая находит папку Devices рядом с exe/bin и возвращает для каждого .ini
//     ТОЛЬКО первые 5 строк (секция [DEVICE] по стандарту прошивки).
//     Полное содержимое при сканировании НЕ читается — это ускоряет старт.
//  2. Декодируем байты каждого файла из windows-1251 через decodeTextBuffer.
//  3. Регистрируем устройство по «лёгкому» пути через registerDeviceFromHeader:
//     в deviceRegistry и fileStore попадает запись с флагом isHeaderOnly = true.
//     Таблица Modbus и осциллограф при этом НЕ трогаются.
//  4. После регистрации всех файлов — один раз перерисовываем дерево.
//
// Полное содержимое файла читается отдельной командой read_ini_file
// при первом клике по устройству в дереве (обработчик в tree-render.ts).
//
// 5. Автовыбор первого устройства отключён: при старте файлы ещё не прочитаны
//    целиком, и попытка отрисовать таблицу по 5 строкам дала бы пустой список.
//    Пользователь сам кликает по нужному устройству — это запускает полную
//    загрузку файла и заполнение таблицы.

import { invoke } from '@tauri-apps/api/core';
import { decodeTextBuffer } from '../../ini-manager/textFileReader.js';
import { registerDeviceFromHeader } from '../../ini-manager/header-loader.js';
import { renderDeviceTree } from '../../ini-manager/tree-ui.js';
import type { AppState } from '../app-state.js';

/**
 * Описание одного файла, возвращаемого Rust-командой scan_devices_folder.
 * Поля один-в-один соответствуют структуре IniFileInfo в ini.rs.
 * ВАЖНО: `bytes` содержит только первые 5 строк файла, а не весь файл.
 */
interface IniFileInfo {
    /** Имя файла (например, "00000056.ini") */
    name: string;
    /** Путь относительно папки Devices (например, "14.09/00000056.ini") */
    relative_path: string;
    /** Сырые байты первых 5 строк (windows-1251). Tauri передаёт их как Uint8Array */
    bytes: Uint8Array | number[];
    /** Время последнего изменения в миллисекундах unix-времени */
    last_modified_ms: number;
}

/**
 * Загружает все INI-файлы из папки Devices рядом с исполняемым файлом.
 * Возвращает количество успешно зарегистрированных файлов.
 * Ошибка одного файла не прерывает загрузку остальных.
 *
 * @param appState — глобальное состояние приложения (пока не используется,
 *                   оставлен в сигнатуре для совместимости с вызывающим кодом).
 */
export async function autoLoadDevicesFolder(appState: AppState): Promise<number> {
    // appState пока не нужен на этом шаге: полная загрузка файла
    // (включая запись в appState.currentIniContent/currentIniConfig)
    // будет делаться при клике по устройству в дереве.
    void appState;

    // Запрашиваем у Rust-стороны список файлов с их «шапками» ([DEVICE]).
    const files = await invoke<IniFileInfo[]>('scan_devices_folder');

    // Папки Devices рядом с exe нет или она пуста — загружать нечего.
    if (!files || files.length === 0) {
        console.log('[autoloader] Папка Devices не найдена или пуста');
        return 0;
    }

    // Путь к папке Devices получаем ОДИН раз, а не в цикле — это быстрее.
    let devicesPath: string | null = null;
    try {
        devicesPath = await invoke<string | null>('get_devices_folder_path');
    } catch (err) {
        console.error('[autoloader] Не удалось получить путь к папке Devices:', err);
    }

    let loaded = 0;

    for (const info of files) {
        try {
            // Нормализуем байты: Tauri обычно отдаёт Uint8Array,
            // но на всякий случай допускаем и вариант с массивом чисел.
            const raw = info.bytes instanceof Uint8Array
                ? info.bytes
                : Uint8Array.from(info.bytes);

            // Декодируем windows-1251 (с обработкой BOM) штатной функцией проекта.
            const content = decodeTextBuffer(raw.buffer as ArrayBuffer);

            // Формируем полный путь к файлу: папка Devices + относительный путь.
            const fullPath = devicesPath ? `${devicesPath}/${info.relative_path}` : '';

            // Лёгкая регистрация: только [DEVICE], без отрисовки таблицы.
            const ok = registerDeviceFromHeader(
                content,
                info.name,
                fullPath,
                info.last_modified_ms,
            );
            if (ok) loaded++;
        } catch (err) {
            // Ошибка одного файла не должна останавливать загрузку остальных.
            console.error(`[autoloader] Ошибка регистрации файла ${info.relative_path}:`, err);
        }
    }

    // Один раз перерисовываем дерево после регистрации всех устройств.
    renderDeviceTree();

    console.log(`[autoloader] Зарегистрировано устройств: ${loaded} из ${files.length}`);
    return loaded;
}