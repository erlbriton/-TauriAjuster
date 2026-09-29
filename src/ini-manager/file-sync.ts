// src/ini-manager/file-sync.ts
// Синхронизация состояния приложения с папкой Devices на диске.
//
// Содержит одну функцию — resyncDevicesFromDisk: сканирует папку Devices
// целиком и приводит состояние в памяти (fileStore, deviceRegistry)
// в соответствие с тем, что реально на диске.
//
// Принцип: единственный источник истины — файлы на диске.

import { invoke } from '@tauri-apps/api/core';
import { IniParser as CoreIniParser, IniConfig } from '../core/ini/index.js';
import type { AppState } from '../core/app-state.js';

import { fileStore, getFileStore } from './file-store.js';
import { syncFilesToOscilloscope } from './file-loader.js';
import { decodeTextBuffer } from './textFileReader.js';
import { registerDeviceFromHeader } from './header-loader.js';
import {
    deviceRegistry,
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
    /** ВАЖНО: это только первые 5 строк файла (секция [DEVICE]). */
    bytes: Uint8Array | number[];
    last_modified_ms: number;
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
    // Rust читает ТОЛЬКО первые 5 строк каждого файла + mtime.
    // Это быстрый проход: на 700 файлов уходят миллисекунды, а не секунды.
    let files: DiskIniFileInfo[];
    let devicesPath: string | null;
    try {
        files = await invoke<DiskIniFileInfo[]>('scan_devices_folder');
        devicesPath = await invoke<string | null>('get_devices_folder_path');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Сканирование Devices не удалось: ${msg}`);
        return result;
    }

    if (!devicesPath) devicesPath = '';

    // ─── Шаг 1.5: синхронизация «красных» записей с папкой BackUp ───────────
    // Записи с isBackup === true в deviceRegistry — это отражение файлов
    // из папки BackUp. Если файла там больше нет — запись должна исчезнуть
    // из дерева. Без этой проверки красные записи накапливаются: пользователь
    // может удалить файл из BackUp через файловый менеджер, а запись останется.
    let backupNames: string[] = [];
    try {
        backupNames = await invoke<string[]>('scan_backup_dir');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Сканирование BackUp не удалось: ${msg}`);
    }
    const backupSet = new Set(backupNames);

    for (const loc of Object.keys(deviceRegistry)) {
        const group = deviceRegistry[loc];
        if (!Array.isArray(group)) continue;
        for (const item of [...group]) {
            if (!item.isBackup) continue;
            const fileName = item.backupFileName;
            // Удаляем запись, если:
            //  - backupFileName не задан (запись из старой версии без поля);
            //  - имя файла не найдено среди реальных файлов в BackUp.
            if (!fileName || !backupSet.has(fileName)) {
                console.log(`[file-sync] Удаляем устаревшую backup-запись ${item.id} (файл ${fileName ?? '—'})`);
                removeDeviceFromRegistry(loc, item.id);
                result.removed++;
            }
        }
    }

    // ─── Шаг 2: строим карту «полный путь → запись со сканирования» ─────────
    // Ключ — полный путь к файлу на диске. Значение — что вернул Rust
    // (имя, первые 5 строк, mtime).
    interface ScanEntry {
        info: DiskIniFileInfo;
        fullPath: string;
    }
    const diskMap = new Map<string, ScanEntry>();
    for (const info of files) {
        const fullPath = devicesPath
            ? `${devicesPath}/${info.relative_path}`
            : info.relative_path;
        diskMap.set(fullPath, { info, fullPath });
    }

    // ─── Шаг 3: строим обратный индекс fileStore: путь → ключ ───────────────
    // fileStore хранит записи под ключом location::id, но искать по нему
    // при синхронизации нельзя: location/id могли измениться. Ищем по пути.
    const store = getFileStore();
    const pathToKey = new Map<string, string>();
    for (const [key, entry] of store.entries()) {
        if (entry.path) pathToKey.set(entry.path, key);
    }

    // ─── Шаг 4: обрабатываем файлы, которые есть на диске ───────────────────
    const seenPaths = new Set<string>();

    for (const [fullPath, scan] of diskMap.entries()) {
        seenPaths.add(fullPath);

        // 4a. Декодируем шапку (5 строк) — нужно для получения location/id
        //     и для случая, когда устройство новое или переехало.
        let headerContent: string;
        try {
            const raw = scan.info.bytes instanceof Uint8Array
                ? scan.info.bytes
                : Uint8Array.from(scan.info.bytes);
            headerContent = decodeTextBuffer(raw.buffer as ArrayBuffer);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${fullPath}: ошибка декодирования шапки — ${msg}`);
            continue;
        }

        const existingKey = pathToKey.get(fullPath);

        // 4b. Файла нет в fileStore — новое устройство. Регистрируем легко.
        if (!existingKey) {
            const ok = registerDeviceFromHeader(
                headerContent,
                scan.info.name,
                fullPath,
                scan.info.last_modified_ms,
            );
            if (ok) result.added++;
            continue;
        }

        // 4c. Файл есть в fileStore. Сравниваем mtime.
        const entry = store.get(existingKey);
        if (!entry) {
            // Индекс устарел (крайне маловероятно) — считаем файл новым.
            const ok = registerDeviceFromHeader(
                headerContent,
                scan.info.name,
                fullPath,
                scan.info.last_modified_ms,
            );
            if (ok) result.added++;
            continue;
        }

        if (entry.lastModified === scan.info.last_modified_ms) {
            // Файл не менялся — ничего не делаем. Это самый частый путь.
            result.unchanged++;
            continue;
        }

        // 4d. mtime изменился — файл редактировали. Нужно прочитать целиком.
        //     Именно здесь мы платим полную стоимость чтения — но только
        //     для реально изменённых файлов, а не для всех 717.
        try {
            const rawFull = await invoke<Uint8Array | number[]>('read_ini_file', {
                path: fullPath,
            });
            const rawBytes = rawFull instanceof Uint8Array
                ? rawFull
                : Uint8Array.from(rawFull);
            // Явно Uint8Array<ArrayBuffer>: TS 5.7+ требует именно такой тип
            // для BlobPart в конструкторе File, иначе ругается на SharedArrayBuffer.
            const fullBytes: Uint8Array<ArrayBuffer> = new Uint8Array(rawBytes);
            const fullContent = decodeTextBuffer(fullBytes.buffer);

            const parser = new CoreIniParser();
            const parseResult = parser.parse(fullContent);
            const newIniConfig = new IniConfig(parseResult);
            const newRawConfig = parseResult.rawSections as RawIniConfig;

            const newDev = newIniConfig.device;
            if (!newDev) {
                result.errors.push(`${fullPath}: нет секции [DEVICE]`);
                continue;
            }

            const newLoc = newDev.location || 'Неизвестное место';
            const newId = newDev.id || 'Без ID';
            const newKey = `${newLoc}::${newId}`;

            // Свежий File-объект с полным содержимым
            const freshFile = new File([fullBytes], scan.info.name, {
                lastModified: scan.info.last_modified_ms,
            });

            if (newKey !== existingKey) {
                // location/id изменились — «переезд». Удаляем старую запись,
                // добавляем новую.
                removeDeviceFromRegistry(entry.location, entry.id);
                store.delete(existingKey);

                // Регистрируем через header-loader (получит isHeaderOnly=true),
                // затем перезаписываем fileStore полным содержимым и
                // сбрасываем флаг у записи в реестре.
                registerDeviceFromHeader(
                    fullContent,
                    scan.info.name,
                    fullPath,
                    scan.info.last_modified_ms,
                );
                store.set(newKey, {
                    file: freshFile,
                    location: newLoc,
                    id: newId,
                    content: fullContent,
                    lastModified: scan.info.last_modified_ms,
                    path: fullPath,
                });
                updateDeviceInRegistry(newLoc, newId, newIniConfig, newRawConfig);
                const group = deviceRegistry[newLoc];
                if (Array.isArray(group)) {
                    const item = group.find((it) => it.id === newId);
                    if (item) item.isHeaderOnly = false;
                }
            } else {
                // Тот же location/id, просто изменилось содержимое —
                // обновляем запись «на месте».
                updateDeviceInRegistry(
                    entry.location,
                    entry.id,
                    newIniConfig,
                    newRawConfig,
                );
                entry.content = fullContent;
                entry.file = freshFile;
                entry.lastModified = scan.info.last_modified_ms;
                // На случай, если запись была «лёгкой» — сбрасываем флаг.
                const group = deviceRegistry[entry.location];
                if (Array.isArray(group)) {
                    const item = group.find((it) => it.id === entry.id);
                    if (item) item.isHeaderOnly = false;
                }
            }

            result.updated++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${fullPath}: ошибка перечитывания — ${msg}`);
        }
    }

    // ─── Шаг 5: удаляем из памяти файлы, которых больше нет на диске ────────
    for (const [key, entry] of Array.from(store.entries())) {
        if (!entry.path) continue;                 // не из Tauri-автозагрузки
        if (seenPaths.has(entry.path)) continue;   // файл на диске есть
        removeDeviceFromRegistry(entry.location, entry.id);
        store.delete(key);
        result.removed++;
    }

    // ─── Шаг 6: обновляем UI, если были изменения ───────────────────────────
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