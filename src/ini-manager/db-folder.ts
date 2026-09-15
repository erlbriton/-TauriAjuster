// src/ini-manager/db-folder.ts
/**
 * Папка базы INI-файлов (File System Access API, Chrome/Edge):
 *  - ручка папки хранится в IndexedDB и переживает перезагрузки;
 *  - после перезагрузки браузер один раз покажет плашку подтверждения;
 *  - при любом сбое — fallback: скачивание в "Загрузки".
 *
 * Родительская папка (рядом с папкой базы лежат Devices и BackUp) тоже
 * хранится в IndexedDB: при обновлении программы устройства старый INI
 * переносится в существующую папку BackUp (если её нет — запись отменяется).
 */

export interface DbDirectoryHandleLike {
    queryPermission(desc: { mode: string }): Promise<string>;
    requestPermission(desc: { mode: string }): Promise<string>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<DbDirectoryHandleLike>;
    removeEntry?(name: string): Promise<void>;
}

interface WindowWithPicker {
    showDirectoryPicker?(opts: { mode: string }): Promise<DbDirectoryHandleLike>;
}

const DB_NAME = 'adjuster-db';
const STORE = 'kv';
const HANDLE_KEY = 'dbFolderHandle';
const PARENT_HANDLE_KEY = 'parentFolderHandle';

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const rq = tx.objectStore(STORE).get(key);
            rq.onsuccess = () => resolve(rq.result as T | undefined);
            rq.onerror = () => reject(rq.error);
        });
    } catch {
        return undefined;
    }
}

async function idbSet(key: string, value: unknown): Promise<void> {
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch {
        // не критично: в следующий раз папку выберут заново
    }
}

/**
 * Возвращает ручку папки базы:
 *  - если сохранена — запрашивает разрешение (один клик в сеанс);
 *  - если нет — предлагает выбрать папку (один раз);
 *  - отмена/запрет/ошибка — null (вызывающий уходит в fallback-скачивание).
 * ВАЖНО: вызывать внутри пользовательского клика — иначе браузер
 * не разрешит показать диалог/плашку.
 */
export async function ensureDbFolder(): Promise<DbDirectoryHandleLike | null> {
    try {
        let handle = await idbGet<DbDirectoryHandleLike>(HANDLE_KEY);
        if (handle) {
            let perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                perm = await handle.requestPermission({ mode: 'readwrite' });
            }
            if (perm === 'granted') {
                // Проверку через entries() убрали из-за проблем с типами.
                // Валидность проверится при сохранении.
                return handle;
            }
            // Битый handle — удаляем
            try { await idbSet(HANDLE_KEY, undefined); } catch {}
        }
        const picker = (window as WindowWithPicker).showDirectoryPicker;
        if (typeof picker !== 'function') return null;
        handle = await picker.call(window, { mode: 'readwrite' });
        if (!handle) return null;
        await idbSet(HANDLE_KEY, handle);
        return handle;
    } catch {
        return null;
    }
}

/** Ручка сохранённой родительской папки, если доступ уже разрешён (иначе null). */
export async function getParentFolder(): Promise<DbDirectoryHandleLike | null> {
    try {
        const handle = await idbGet<DbDirectoryHandleLike>(PARENT_HANDLE_KEY);
        if (!handle) return null;
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        return perm === 'granted' ? handle : null;
    } catch {
        return null;
    }
}

/**
 * Получает ручку родительской папки ВНУТРИ пользовательского жеста:
 *  - если сохранена — запрашивает разрешение;
 *  - если нет — предлагает выбрать и запоминает.
 */
export async function acquireParentFolder(): Promise<DbDirectoryHandleLike | null> {
    try {
        let handle = await idbGet<DbDirectoryHandleLike>(PARENT_HANDLE_KEY);
        if (handle) {
            let perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                perm = await handle.requestPermission({ mode: 'readwrite' });
            }
            if (perm === 'granted') return handle;
            // Битый handle — удаляем и покажем picker заново
            try { await idbSet(PARENT_HANDLE_KEY, undefined); } catch {}
        }
        const picker = (window as WindowWithPicker).showDirectoryPicker;
        if (typeof picker !== 'function') return null;
        handle = await picker.call(window, { mode: 'readwrite' });
        if (!handle) return null;
        await idbSet(PARENT_HANDLE_KEY, handle);
        return handle;
    } catch {
        return null;
    }
}

/**
 * Принудительно открывает picker родительской папки (игнорирует сохранённый handle).
 * Вызывать только внутри пользовательского жеста.
 */
export async function forcePickParentFolder(): Promise<DbDirectoryHandleLike | null> {
    try {
        const picker = (window as WindowWithPicker).showDirectoryPicker;
        if (typeof picker !== 'function') return null;
        const handle = await picker.call(window, { mode: 'readwrite' });
        if (!handle) return null;
        await idbSet(PARENT_HANDLE_KEY, handle);
        return handle;
    } catch {
        return null;
    }
}

/** Ищет папку BackUp в родительской папке. НЕ создаёт её. */
export async function getBackupDir(parent: DbDirectoryHandleLike): Promise<DbDirectoryHandleLike | null> {
    try {
        if (typeof parent.getDirectoryHandle !== 'function') return null;
        return await parent.getDirectoryHandle('BackUp', { create: false });
    } catch {
        return null;
    }
}

/** Переносит файл: папка базы -> BackUp (в BackUp перезаписывает, из папки базы удаляет). */
export async function moveFileToBackupDir(
    dbHandle: DbDirectoryHandleLike,
    backupDir: DbDirectoryHandleLike,
    fileName: string,
): Promise<boolean> {
    try {
        const oldFileHandle = await dbHandle.getFileHandle(fileName, { create: false });
        const oldFile = await oldFileHandle.getFile();
        const oldContent = new Uint8Array(await oldFile.arrayBuffer());

        const backupFileHandle = await backupDir.getFileHandle(fileName, { create: true });
        const writable = await backupFileHandle.createWritable();
        await writable.write(oldContent);
        await writable.close();

        if (typeof dbHandle.removeEntry === 'function') {
            await dbHandle.removeEntry(fileName);
        }
        console.log(`[db-folder] Файл ${fileName} перенесён в BackUp`);
        return true;
    } catch (err) {
        console.error('[db-folder] Ошибка переноса файла в BackUp:', err);
        return false;
    }
}

/**
 * Создаёт файл в папке базы.
 * backupDir != null и файл существует → старый переносится в backupDir,
 * новый пишется под тем же именем (статус 'moved-and-saved').
 * backupDir == null и файл существует → статус 'exists' (ничего не пишется).
 */
export async function saveFileToDbFolder(
    handle: DbDirectoryHandleLike,
    name: string,
    content: Uint8Array<ArrayBuffer>,
    backupDir: DbDirectoryHandleLike | null = null,
): Promise<{ status: 'saved' | 'exists' | 'error' | 'moved-and-saved'; fileHandle: FileSystemFileHandle | null; errorMessage?: string }> {
    try {
        let existed = false;
        try {
            await handle.getFileHandle(name, { create: false });
            existed = true;
        } catch {
            // файла нет
        }

        if (existed && !backupDir) {
            const fh = await handle.getFileHandle(name, { create: false });
            return { status: 'exists', fileHandle: fh };
        }
        if (existed && backupDir) {
            const moved = await moveFileToBackupDir(handle, backupDir, name);
            if (!moved) return { status: 'error', fileHandle: null };
        }

        const fileHandle = await handle.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return { status: existed ? 'moved-and-saved' : 'saved', fileHandle };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[db-folder] Ошибка сохранения в папку базы:', err);
        return { status: 'error', fileHandle: null, errorMessage: errMsg };
    }
}

/** Fallback: скачать файл в "Загрузки". */
export async function downloadFallback(name: string, content: Uint8Array<ArrayBuffer>): Promise<FileSystemFileHandle | null> {
    const w = window as unknown as {
        showSaveFilePicker?: (opts: { suggestedName?: string; types?: Array<{ description?: string; accept?: Record<string, string[]> }> }) => Promise<FileSystemFileHandle | undefined>;
    };
    if (typeof w.showSaveFilePicker !== 'function') {
        // Браузер не поддерживает File System Access API — скачиваем старым способом (без handle)
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return null;
    }
    try {
        const handle = await w.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'INI Files', accept: { 'text/plain': ['.ini'] } }],
        });
        if (!handle) return null; // пользователь отменил
        // Записываем содержимое через handle
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return handle;
    } catch (err) {
        console.warn('[downloadFallback] Сохранение через showSaveFilePicker не удалось:', err);
        return null;
    }
}

/**
 * Принудительно спрашивает новую папку базы и запоминает её.
 * Вызывать только внутри пользовательского клика (диалог открытия).
 */
export async function changeDbFolder(): Promise<DbDirectoryHandleLike | null> {
    const picker = (window as WindowWithPicker).showDirectoryPicker;
    if (typeof picker !== 'function') return null;
    try {
        const handle = await picker.call(window, { mode: 'readwrite' });
        if (!handle) return null;
        await idbSet(HANDLE_KEY, handle);
        return handle;
    } catch {
        // пользователь отменил выбор
        return null;
    }
}

/**
 * Сохраняет ручку папки как общую папку базы.
 * Вызывается из openIniFolder после успешного выбора (на Linux).
 */
export async function saveDbFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    await idbSet(HANDLE_KEY, handle);
}