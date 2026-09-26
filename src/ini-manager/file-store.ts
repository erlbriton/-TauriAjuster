// src/ini-manager/file-store.ts
// Хранилище состояния файлов INI-базы.
//
// Отвечает ТОЛЬКО за хранение:
//  - карта «ключ → запись» для всех загруженных INI-файлов (fileStore);
//  - путь к текущему открытому файлу — для сохранения изменений
//    в нативном режиме (см. save-ini.ts и getCurrentIniFilePath).
//
// Этот модуль ничего не знает про парсинг, реестр устройств, рендеринг,
// осциллограф. Его задача — держать данные и отдавать их по запросу.

/** Абсолютный путь к текущему INI-файлу (для нативного сохранения в Tauri). */
let currentIniPath: string | null = null;

/**
 * Запись о файле в хранилище.
 *
 * Ключ карты — `${location}::${id}`, совпадает с уникальностью в deviceRegistry.
 * Браузер не следит за файлами сам, но пока жива ссылка на File,
 * file.text() возвращает содержимое, зафиксированное при загрузке.
 */
export interface StoredFileEntry {
    file: File;
    handle?: FileSystemFileHandle;
    /** Родительская папка файла (если известна при загрузке — например, при открытии папки) */
    parentHandle?: FileSystemDirectoryHandle;
    location: string;
    id: string;
    content: string;
    lastModified: number;
    /**
     * Абсолютный путь к файлу на диске (для открытия во внешнем редакторе).
     * Необязательное поле: старые записи из браузерной версии не имеют пути,
     * новые записи из Tauri-автозагрузчика получают полный путь.
     */
    path?: string;
}

/**
 * Карта всех загруженных INI-файлов.
 *
 * Экспортируется напрямую, потому что используется в нескольких функциях
 * file-loader.ts (processSingleFileContent, reloadIniFilesFromDisk,
 * editDeviceIniFile), которые активно работают с ней: `.set`, `.get`,
 * `.delete`, итерация. Заворачивать каждое обращение в геттер было бы
 * шумно и не дало бы практической пользы.
 */
export const fileStore: Map<string, StoredFileEntry> = new Map();

/**
 * Геттер хранилища файлов.
 * Используется внешними модулями (генератор отчётов, UI-менеджеры,
 * модуль синхронизации) — чтобы они не зависели от имени переменной.
 */
export function getFileStore(): Map<string, StoredFileEntry> {
    return fileStore;
}

/**
 * Возвращает абсолютный путь к текущему INI-файлу на диске.
 * Используется в нативном режиме (Tauri) для сохранения изменений.
 */
export function getCurrentIniFilePath(): string | null {
    return currentIniPath;
}

/**
 * Устанавливает путь к текущему открытому INI-файлу.
 * Вызывается из processSingleFileContent при загрузке нового файла.
 */
export function setCurrentIniPath(path: string | null): void {
    currentIniPath = path;
}