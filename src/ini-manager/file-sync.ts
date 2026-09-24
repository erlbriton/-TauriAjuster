// src/ini-manager/file-sync.ts
// Синхронизация состояния приложения с папкой Devices на диске.
//
// Модуль содержит две функции:
//  - reloadIniFilesFromDisk — «лёгкая» синхронизация: проходит по уже
//    известным файлам (fileStore) и перечитывает их содержимое с диска.
//    Не обнаруживает новые или удалённые файлы;
//  - resyncDevicesFromDisk — «полная» синхронизация: сканирует папку
//    Devices целиком и приводит состояние в памяти (fileStore,
//    deviceRegistry) в соответствие с тем, что реально на диске.
//
// Принцип: единственный источник истины — файлы на диске.

import { IniParser as CoreIniParser, IniConfig } from '../core/ini/index.js';
import type { AppState } from '../core/app-state.js';

import { fileStore, getFileStore } from './file-store.js';
import {
    processSingleFileContent,
    readFileAsText,
    syncFilesToOscilloscope,
} from './file-loader.js';
import { decodeTextBuffer } from './textFileReader.js';
import {
    addDeviceToRegistry,
    updateDeviceInRegistry,
    removeDeviceFromRegistry,
} from './tree-core.js';
import type { RawIniConfig } from './tree-core.js';
import { renderDeviceTree } from './tree-ui.js';

/**
 * Описание одного файла, которое возвращает Rust-команда scan_devices_folder.
 * Структура совпадает с IniFileInfo в tauri-autoloader.ts и в Rust-коде (ini.rs).
 * Объявлена локально, чтобы file-sync.ts не зависел от tauri-autoloader.ts.
 */
interface DiskIniFileInfo {
    name: string;
    relative_path: string;
    bytes: Uint8Array | number[];
    last_modified_ms: number;
}

/**
 * Перечитывает все загруженные INI-файлы с диска.
 * - Файл изменён: обновляет запись в реестре и памяти.
 * - Файл удалён/перемещён: удаляет устройство из реестра.
 * - Файл не менялся: пропускает.
 */
export async function reloadIniFilesFromDisk(): Promise<{
    updated: number;
    removed: number;
    unchanged: number;
    errors: string[];
}> {
    const results = { updated: 0, removed: 0, unchanged: 0, errors: [] as string[] };
    const keys = Array.from(fileStore.keys());

    if (keys.length === 0) {
        console.log('[file-sync] reloadIniFilesFromDisk: нет файлов для перечитывания');
        return results;
    }

    for (const key of keys) {
        const entry = fileStore.get(key);
        if (!entry) continue;

        try {
            let newContent: string;

            // Приоритет чтения содержимого файла:
            // 1. Если есть путь на диске (Tauri-автозагрузчик) — читаем через Rust
            // 2. Если есть хэндл (браузерный File System Access API) — берём свежий File
            // 3. Иначе — используем старый снимок (изменения не обнаружим)
            if (entry.path) {
                const rawBytes = await window.__TAURI__.core.invoke<number[]>('read_ini_file', {
                    path: entry.path,
                });
                const buffer = new Uint8Array(rawBytes).buffer as ArrayBuffer;
                newContent = decodeTextBuffer(buffer);
            } else if (entry.handle) {
                const freshFile = await entry.handle.getFile();
                newContent = await readFileAsText(freshFile);
            } else {
                newContent = await readFileAsText(entry.file);
            }

            if (newContent === entry.content) {
                results.unchanged++;
                continue;
            }

            // Файл изменился — парсим и обновляем реестр на месте
            try {
                const coreParser = new CoreIniParser();
                const parseResult = coreParser.parse(newContent);
                const newIniConfig = new IniConfig(parseResult);
                const newConfig = parseResult.rawSections as RawIniConfig;

                if (updateDeviceInRegistry(entry.location, entry.id, newIniConfig, newConfig)) {
                    entry.content = newContent;
                    entry.lastModified = Date.now();
                    results.updated++;
                    console.log(`[file-sync] Файл обновлён: ${entry.file.name}`);
                } else {
                    fileStore.delete(key);
                    results.errors.push(`${entry.file.name}: устройство не найдено в реестре`);
                }
            } catch (parseErr) {
                const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                results.errors.push(`${entry.file.name}: ошибка парсинга — ${msg}`);
                console.error(`[file-sync] Parse error for ${entry.file.name}:`, parseErr);
            }
        } catch (readErr) {
            // Файл удалён или перемещён
            removeDeviceFromRegistry(entry.location, entry.id);
            fileStore.delete(key);
            results.removed++;
            console.log(`[file-sync] Файл удалён/недоступен: ${entry.file.name}`);
        }
    }

    if (results.updated > 0 || results.removed > 0) {
        renderDeviceTree();
        syncFilesToOscilloscope();
        console.log(
            `[file-sync] reload: updated=${results.updated}, removed=${results.removed}, unchanged=${results.unchanged}`,
        );
    }

    return results;
}

/**
 * Полная синхронизация состояния приложения с папкой Devices на диске.
 *
 * Принцип: ЕДИНСТВЕННЫЙ источник истины — файлы на диске. Все структуры
 * в памяти (fileStore, deviceRegistry) приводятся в соответствие с тем,
 * что реально лежит в Devices/. Это устраняет рассогласования, которые
 * возникают при апдейтах прошивки, ручных правках во внешнем редакторе,
 * копировании и удалении файлов вне приложения.
 *
 * Что делает функция по шагам:
 *  1. Сканирует папку Devices (Rust-команда scan_devices_folder) и получает
 *     список всех INI-файлов с их путями и содержимым.
 *  2. Для каждого файла в fileStore проверяет, есть ли он на диске (по entry.path).
 *     - Нет на диске → удаляет запись из fileStore и deviceRegistry.
 *     - Есть на диске → парсит содержимое, сравнивает location/id с записью:
 *         - location/id изменились → переезд: удаляем старую запись,
 *           добавляем новую с новым ключом location::id, обновляем file, content.
 *         - location/id те же → обновляем на месте: content, file,
 *           lastModified, iniConfig в реестре (через updateDeviceInRegistry).
 *  3. Для каждого файла на диске, которого ещё нет в fileStore, —
 *     добавляет его через processSingleFileContent (как при старте приложения).
 *  4. Перерисовывает дерево, если были изменения.
 *
 * Не делает:
 *  - НЕ переименовывает папки под Location (это отдельная задача-миграция);
 *  - НЕ трогает флаг isBackup в deviceRegistry (это состояние UI, а не
 *    свойство файла);
 *  - НЕ трогает currentIniContent/currentIniConfig приложения.
 *
 * Возвращает статистику: added/updated/removed/unchanged/errors.
 */
export async function resyncDevicesFromDisk(appState: AppState): Promise<{
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    errors: string[];
}> {
    const result = {
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        errors: [] as string[],
    };

    // ─── Шаг 1: сканируем папку Devices ─────────────────────────────────────
    let files: DiskIniFileInfo[];
    let devicesPath: string | null;
    try {
        files = await window.__TAURI__.core.invoke<DiskIniFileInfo[]>('scan_devices_folder');
        devicesPath = await window.__TAURI__.core.invoke<string | null>('get_devices_folder_path');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Сканирование Devices не удалось: ${msg}`);
        return result;
    }

    if (!devicesPath) {
        // Папки Devices нет — ничего синхронизировать не с чем.
        // Все известные записи в fileStore будут удалены ниже (файлов нет).
        devicesPath = '';
    }

    // ─── Шаг 2: строим карту «полный путь на диске → данные файла» ──────────
    interface DiskEntry {
        info: DiskIniFileInfo;
        content: string;
        // Явно Uint8Array<ArrayBuffer>: TS 5.7+ требует именно такой тип
        // для BlobPart в конструкторе File, иначе ругается на SharedArrayBuffer.
        safeBytes: Uint8Array<ArrayBuffer>;
    }
    const diskMap = new Map<string, DiskEntry>();
    for (const info of files) {
        const fullPath = devicesPath ? `${devicesPath}/${info.relative_path}` : info.relative_path;
        try {
            const raw = info.bytes instanceof Uint8Array
                ? info.bytes
                : Uint8Array.from(info.bytes);
            const safeBytes: Uint8Array<ArrayBuffer> = new Uint8Array(raw);
            const content = decodeTextBuffer(safeBytes.buffer);
            diskMap.set(fullPath, { info, content, safeBytes });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${fullPath}: ошибка декодирования — ${msg}`);
        }
    }

    // ─── Шаг 3: проходим по fileStore и приводим в соответствие с диском ────
    const store = getFileStore();
    const handledPaths = new Set<string>();

    for (const [oldKey, entry] of Array.from(store.entries())) {
        // Записи без path — не из Tauri-автозагрузки (например, ручное
        // открытие файла). Их не трогаем: они вне модели «истина на диске».
        if (!entry.path) continue;

        const diskEntry = diskMap.get(entry.path);
        if (!diskEntry) {
            // Файла на диске нет — удаляем из памяти и реестра.
            removeDeviceFromRegistry(entry.location, entry.id);
            store.delete(oldKey);
            result.removed++;
            continue;
        }

        handledPaths.add(entry.path);

        // Парсим содержимое с диска.
        let newIniConfig: IniConfig;
        let newRawConfig: RawIniConfig;
        try {
            const parser = new CoreIniParser();
            const parseResult = parser.parse(diskEntry.content);
            newIniConfig = new IniConfig(parseResult);
            newRawConfig = parseResult.rawSections as RawIniConfig;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${entry.path}: ошибка парсинга — ${msg}`);
            continue;
        }

        const newDev = newIniConfig.device;
        const newLoc = newDev?.location || 'Неизвестное место';
        const newId = newDev?.id || 'Без ID';

        const locChanged = newLoc !== entry.location;
        const idChanged = newId !== entry.id;
        const contentChanged = diskEntry.content !== entry.content;

        if (!locChanged && !idChanged && !contentChanged) {
            result.unchanged++;
            continue;
        }

        // Готовим свежий File-объект — чтобы entry.file больше не был
        // устаревшим снимком (это лечит баг «редактор показывает старое»).
        const freshFile = new File(
            [diskEntry.safeBytes],
            diskEntry.info.name,
            { lastModified: diskEntry.info.last_modified_ms },
        );

        if (locChanged || idChanged) {
            // Переезд: location или id изменились — старая запись
            // не подходит ни по ключу, ни по группе в реестре.
            removeDeviceFromRegistry(entry.location, entry.id);
            store.delete(oldKey);

            const newKey = `${newLoc}::${newId}`;
            store.set(newKey, {
                file: freshFile,
                handle: entry.handle,
                parentHandle: entry.parentHandle,
                location: newLoc,
                id: newId,
                content: diskEntry.content,
                lastModified: diskEntry.info.last_modified_ms,
                path: entry.path,
            });
            addDeviceToRegistry(newIniConfig);
        } else {
            // Только содержимое изменилось — обновляем на месте.
            updateDeviceInRegistry(entry.location, entry.id, newIniConfig, newRawConfig);
            entry.content = diskEntry.content;
            entry.file = freshFile;
            entry.lastModified = diskEntry.info.last_modified_ms;
        }
        result.updated++;
    }

    // ─── Шаг 4: добавляем файлы, которых ещё нет в fileStore ────────────────
    for (const [fullPath, diskEntry] of diskMap.entries()) {
        if (handledPaths.has(fullPath)) continue;

        try {
            const file = new File(
                [diskEntry.safeBytes],
                diskEntry.info.name,
                { lastModified: diskEntry.info.last_modified_ms },
            );
            await processSingleFileContent(
                diskEntry.content,
                diskEntry.info.name,
                appState,
                file,
                undefined,
                undefined,
                fullPath,
            );
            result.added++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${fullPath}: ошибка добавления — ${msg}`);
        }
    }

    // ─── Шаг 5: перерисовка дерева ──────────────────────────────────────────
    if (result.added > 0 || result.updated > 0 || result.removed > 0) {
        renderDeviceTree();
        syncFilesToOscilloscope();
    }

    console.log(
        `[file-sync] resync: added=${result.added}, updated=${result.updated}, ` +
        `removed=${result.removed}, unchanged=${result.unchanged}, errors=${result.errors.length}`,
    );

    return result;
}