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
import { processSingleFileContent, getFileStore } from '../../ini-manager/file-loader.js';
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
 * Пути файлов, которые уже были добавлены этой функцией в текущей сессии.
 *
 * Нужен как страховка от повторного сообщения «новый файл» при повторном
 * клике по «Обновить список устройств». Причина, по которой это может
 * произойти: fileStore использует ключ `location::id`, и если в одной
 * локации лежат два файла с одинаковым ID, вторая запись перезаписывает
 * первую — её путь теряется. Множество addedPathsThisSession запоминает
 * все пути, реально обработанные этой функцией, и не даёт признать их
 * «новыми» повторно в том же сеансе приложения.
 *
 * Сбрасывается только при перезапуске приложения. На старте fileStore
 * заполняется autoLoadDevicesFolder, и работа идёт по его путям.
 */
const addedPathsThisSession = new Set<string>();

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

            // Получаем абсолютный путь к папке Devices от Rust-стороны
            const devicesPath = await invoke<string | null>('get_devices_folder_path');
            
            // Формируем полный путь к файлу: папка Devices + относительный путь
            const fullPath = devicesPath ? `${devicesPath}/${info.relative_path}` : undefined;
            
            // Прогоняем файл через тот же конвейер, что и ручное открытие,
            // передавая полный путь для последующего открытия во внешнем редакторе
            await processSingleFileContent(content, info.name, appState, file, undefined, undefined, fullPath);
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

/**
 * Сканирует папку Devices и добавляет в приложение только те INI-файлы,
 * которых ещё нет в fileStore.
 *
 * Зачем это нужно:
 * Кнопка "Обновить список устройств" вызывает reloadIniFilesFromDisk,
 * которая перечитывает содержимое уже ИЗВЕСТНЫХ файлов (для отслеживания
 * изменений из внешнего редактора). Но если пользователь добавил в Devices
 * новый файл или целую подпапку через файловый менеджер, reload её не видит:
 * в fileStore нет записи про этот файл, значит и перечитывать нечего.
 *
 * Эта функция закрывает пробел: сканирует папку Devices (как при старте
 * приложения), сравнивает с известными путями в fileStore и подгружает
 * только новые файлы. Существующие НЕ трогает — их обрабатывает
 * reloadIniFilesFromDisk отдельным вызовом.
 *
 * Возвращает количество добавленных файлов.
 */
export async function addNewDevicesFromDisk(appState: AppState): Promise<number> {
    // Запрашиваем у Rust полный список файлов в папке Devices вместе
    // с содержимым (та же команда, что при старте приложения).
    const files = await invoke<IniFileInfo[]>('scan_devices_folder');
    if (!files || files.length === 0) {
        // На диске файлов нет — сессионный набор тоже можно очистить:
        // если пользователь потом добавит файл с тем же путём, он снова
        // будет распознан как новый.
        addedPathsThisSession.clear();
        return 0;
    }

    // Полный путь к корню Devices — чтобы сформировать полный путь
    // каждого файла для сравнения (в fileStore хранятся абсолютные пути).
    const devicesPath = await invoke<string | null>('get_devices_folder_path');
    if (!devicesPath) {
        console.warn('[autoloader] addNewDevicesFromDisk: папка Devices не найдена');
        return 0;
    }

    // Собираем множество путей, которые СЕЙЧАС реально есть на диске.
    // Оно используется, чтобы «подчистить» addedPathsThisSession: если
    // файл был удалён из папки Devices, его путь должен исчезнуть и из
    // сессионного набора. Иначе при повторном добавлении того же файла
    // (тот же путь) функция считала бы его «уже известным» и не сообщала
    // пользователю об изменении.
    const diskPaths = new Set<string>();
    for (const info of files) {
        diskPaths.add(`${devicesPath}/${info.relative_path}`);
    }
    for (const p of Array.from(addedPathsThisSession)) {
        if (!diskPaths.has(p)) addedPathsThisSession.delete(p);
    }

    // Собираем множество уже известных путей из двух источников:
    //  1. addedPathsThisSession — пути, добавленные этой функцией
    //     в текущей сессии (после синхронизации с диском выше).
    //     Страхует от повторного подсчёта, если запись в fileStore
    //     была потеряна из-за совпадения ключа `location::id`
    //     у нескольких файлов.
    //  2. fileStore — записи, добавленные ранее (например, при
    //     старте приложения через autoLoadDevicesFolder).
    // Сравнение идёт именно по пути, а не по имени: имена могут
    // повторяться в разных подпапках (например, "00000056.ini" в
    // локациях "Огонь" и "Вода" одновременно).
    const knownPaths = new Set<string>(addedPathsThisSession);
    const store = getFileStore();
    for (const entry of store.values()) {
        if (entry.path) knownPaths.add(entry.path);
    }

    let added = 0;

    for (const info of files) {
        const fullPath = `${devicesPath}/${info.relative_path}`;

        // Файл уже загружен — не трогаем, его перечитает reloadIniFilesFromDisk.
        if (knownPaths.has(fullPath)) continue;

        try {
            // Нормализуем байты (как в autoLoadDevicesFolder).
            const raw = info.bytes instanceof Uint8Array
                ? info.bytes
                : Uint8Array.from(info.bytes);
            const safe = new Uint8Array(raw);

            // Декодируем windows-1251 штатной функцией проекта.
            const content = decodeTextBuffer(safe.buffer as ArrayBuffer);

            // Создаём File-объект, совместимый с конвейером.
            const file = new File([safe], info.name, {
                lastModified: info.last_modified_ms,
            });

            // Прогоняем через тот же конвейер, что и при старте, —
            // запись попадёт в реестр, дерево, таблицу и осциллограф.
            await processSingleFileContent(
                content,
                info.name,
                appState,
                file,
                undefined,
                undefined,
                fullPath,
            );
            added++;
            // Запоминаем путь — повторный клик по «Обновить список»
            // не должен посчитать этот файл «новым» снова, даже если
            // запись в fileStore была перезаписана другой с таким же
            // ключом location::id.
            addedPathsThisSession.add(fullPath);
            console.log(`[autoloader] addNewDevicesFromDisk: добавлен ${fullPath}`);
        } catch (err) {
            // Ошибка одного файла не должна останавливать остальные.
            console.error(
                `[autoloader] Ошибка загрузки нового файла ${info.relative_path}:`,
                err,
            );
        }
    }

    return added;
}