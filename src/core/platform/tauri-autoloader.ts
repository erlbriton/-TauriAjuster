// src/core/platform/tauri-autoloader.ts
// Автозагрузчик INI-файлов из папки Devices, лежащей рядом с исполняемым файлом.
//
// Как это работает:
//  1. Вызываем Rust-команду scan_devices_folder (см. src-tauri/src/lib.rs),
//     которая находит папку Devices рядом с exe/bin и возвращает все .ini
//     файлы из неё рекурсивно (кроме папок BackUp).
//  2. Декодируем байты каждого файла из windows-1251 через decodeTextBuffer.
//  3. Пропускаем каждый файл через существующий конвейер
//     processSingleFileContent, чтобы устройства попали в реестр, дерево
//     и осциллограф точно так же, как при ручном открытии файлов.

import { invoke } from '@tauri-apps/api/core';
import { decodeTextBuffer } from '../../ini-manager/textFileReader.js';
import { processSingleFileContent } from '../../ini-manager/file-loader.js';
import type { AppState } from '../app-state.js';

/**
 * Описание одного файла, возвращаемого Rust-командой scan_devices_folder.
 * Поля один-в- один соответствуют структуре IniFileInfo в src-tauri/src/lib.rs.
 */
interface IniFileInfo {
    /** Имя файла (например, "00000056.ini") */
    name: string;
    /** Путь относительно папки Devices (например, "14.09/00000056.ini") */
    relative_path: string;
    /** Сырые байты файла (windows-1251). Tauri передаёт их как Uint8Array */
    bytes: Uint8Array | number[];
    /** Время последнего изменения в миллисекундах unix-времени */
    last_modified_ms: number;
}

/**
 * Загружает все INI-файлы из папки Devices рядом с исполняемым файлом.
 * Возвращает количество успешно загруженных файлов.
 * Ошибка одного файла не прерывает загрузку остальных.
 */
export async function autoLoadDevicesFolder(appState: AppState): Promise<number> {
    // Запрашиваем у Rust-стороны список файлов вместе с их содержимым
    const files = await invoke<IniFileInfo[]>('scan_devices_folder');

    // Папки Devices рядом с exe нет или она пуста — загружать нечего
    if (!files || files.length === 0) {
        console.log('[autoloader] Папка Devices не найдена или пуста');
        return 0;
    }

    let loaded = 0;

    for (const info of files) {
        try {
            // Нормализуем байты: Tauri обычно отдаёт Uint8Array,
            // но на всякий случай допускаем и вариант с массивом чисел
            const raw = info.bytes instanceof Uint8Array
                ? info.bytes
                : Uint8Array.from(info.bytes);

            // Копируем в новый буфер (требование типов File/Blob в TS 5.7+)
            const safe = new Uint8Array(raw);

            // Декодируем windows-1251 (с обработкой BOM) штатной функцией проекта
            const content = decodeTextBuffer(safe.buffer as ArrayBuffer);

            // Создаём File-объект, совместимый с существующим конвейером:
            // processSingleFileContent и fileStore используют только name и lastModified
            const file = new File([safe], info.name, {
                lastModified: info.last_modified_ms,
            });

            // Прогоняем файл через тот же конвейер, что и ручное открытие
            await processSingleFileContent(content, info.name, appState, file);
            loaded++;
        } catch (err) {
            // Ошибка одного файла не должна останавливать загрузку остальных
            console.error(`[autoloader] Ошибка загрузки файла ${info.relative_path}:`, err);
        }
    }

    // Если в дереве ничего не выбрано — выбираем первое устройство,
    // ровно как это делается при ручном открытии папки
    setTimeout(() => {
        const selected = document.querySelector('.tree-id-item.is-selected');
        if (!selected) {
            const firstLi = document.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
            if (firstLi) {
                const details = firstLi.closest('details');
                if (details && !(details as HTMLDetailsElement).open) {
                    (details as HTMLDetailsElement).open = true;
                }
                firstLi.click();
                firstLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }, 100);

    return loaded;
}