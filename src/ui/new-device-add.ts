// src/ui/new-device-add.ts
/**
 * Логика кнопки "Добавить устройство в базу" — общая для двух окон:
 *  - окно "Новое устройство" (src/ui/new-device-ui.ts);
 *  - окно обновления ПО (src/ui/fw-update-modal.ts).
 *
 * Что делает:
 *  1) читает выбранный шаблон, собирает из него INI
 *     (в [DEVICE] подставляет ID, Location, Description);
 *  2) сохраняет файл в папку базы;
 *  3) регистрирует устройство в дереве и выделяет его.
 *
 * Файл вынесен из new-device-ui.ts, потому что логика содержит
 * много побочных эффектов (файловая система, реестр устройств, дерево)
 * и разрастается — а UI-часть окна остаётся компактной.
 */

import { parseDeviceIdString } from '../core/report-data.js';
import { getAllDevices, deviceRegistry, removeDeviceFromRegistry } from '../ini-manager/tree-core.js';
import { showIdModal } from './ui.js';
import {
    ensureDbFolder,
    saveFileToDbFolder,
    downloadFallback,
    acquireParentFolder,
    DbDirectoryHandleLike,
} from '../ini-manager/db-folder.js';
import { readFileWithEncoding, encodeToWindows1251 } from '../core/encoding.js';
import { getFileStore } from '../ini-manager/file-loader.js';
import { renderDeviceTree } from '../ini-manager/tree-ui.js';

// Всё, что «живёт» в UI-части окна — берём оттуда,
// чтобы не дублировать состояние (шаблоны, колбэк загрузки, статус).
import {
    readTemplateFile,
    getAddToLoadedFn,
    hideNewDeviceModal,
    setNewDeviceStatus,
} from './new-device-ui.js';

/**
 * Определяет, запущено ли приложение в нативном режиме (Tauri v2).
 * В Tauri рантайм создаёт глобальный объект `window.__TAURI__` автоматически;
 * в обычном браузере его нет. Та же проверка используется в save-ini.ts.
 *
 * Зачем это здесь: браузерный File System Access API (showDirectoryPicker,
 * getFileHandle, createWritable, showSaveFilePicker) в WebView Tauri недоступен,
 * поэтому цепочка ensureDbFolder → saveFileToDbFolder → downloadFallback
 * в нативном режиме молча ничего не делает. Для Tauri нужна отдельная ветка
 * записи через @tauri-apps/plugin-fs.
 */
function isTauriMode(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Кнопка "Добавить устройство в базу":
 *  1) собирает INI из шаблона (ID/Location/Description в [DEVICE]);
 *  2) добавляет устройство к загруженным и выделяет его в дереве;
 *  3) сохраняет файл в запомненную папку базы; при любом сбое —
 *     скачивает в "Загрузки", чтобы данные не потерялись.
 */
export interface AddToBaseSource {
    templateSelectId: string;
    mechInputId: string;
    locInputId: string;
    idText: string;
    setStatus: (text: string) => void;
    onDone: () => void;
    moveExistingToBackup?: boolean;
    /** Имя файла старого устройства, которое нужно заменить (для режима обновления ПО) */
    oldFileName?: string;
}

/** Убирает недопустимые символы из имени файла для File System Access API (Windows не разрешает !:*?"<>| и т.п.). */
function sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|!]/g, '_');
}

/**
 * Вычисляет имя подпапки внутри Devices для нового или обновляемого INI.
 *
 * Правила (по согласованию с заказчиком):
 *  1. Если Location задан — имя папки = Location (с санитизацией).
 *     Пример: Location=Огонь → папка "Огонь".
 *  2. Если Location пустой — берём токены ID-строки между серийным номером
 *     и датой прошивки. Это тип устройства и (если есть) версия.
 *     Пример: "00004000 DExS.AVS v1.10.6.3 18.07.2022 www.intmash.ru"
 *       → "DExS.AVS v1.10.6.3"
 *     Пример: "00001011 DExS.AVK 18.07.2022 www.intmash.ru"
 *       → "DExS.AVK"
 *  3. Если ни Location, ни токенов из ID не получилось — возвращаем null.
 *     Вызывающий код должен показать ошибку и НЕ сохранять файл.
 *
 * Функция чистая (только вычисление). Создание самой папки — отдельная
 * Rust-команда ensure_device_subdir.
 */
function resolveDeviceSubdirName(location: string, idText: string): string | null {
    // 1. Location задан — используем его.
    const loc = location.trim();
    if (loc) {
        return sanitizeFileName(loc);
    }

    // 2. Location пустой — извлекаем токены из ID-строки.
    //    Формат: "<серийник> <тип> [<версия>] <дата> [<URL>]".
    //    Идём от второго токена к концу, пока не встретим дату или URL.
    const tokens = idText.trim().split(/\s+/);
    if (tokens.length < 2) return null;

    const middle: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        // Дата вида dd.mm.yyyy — дальше начинается «хвост», останавливаемся.
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) break;
        // URL (www.* или что-то похожее на домен .ru/.com/.net/.org) — тоже стоп.
        if (t.includes('www.') || /^[\w.-]+\.(ru|com|net|org)$/i.test(t)) break;
        middle.push(t);
    }
    if (middle.length === 0) return null;

    return sanitizeFileName(middle.join(' '));
}

/** Общая логика кнопки "Добавить устройство в базу" для обоих окон. */
export async function handleAddToBaseGeneric(src: AddToBaseSource): Promise<void> {
    const select = document.getElementById(src.templateSelectId) as HTMLSelectElement | null;
    const templateName = (select?.value ?? '').trim();
    if (!templateName) {
        src.setStatus('Выберите шаблон из списка.');
        return;
    }
    const templateFile = await readTemplateFile(templateName);
    if (!templateFile) {
        src.setStatus('Файл шаблона не найден — добавьте шаблоны ещё раз.');
        return;
    }

    const idText = src.idText;
    if (!idText) {
        src.setStatus('ID устройства пуст — сначала подключите устройство.');
        return;
    }

    // ВАЖНО: запрашиваем папку в самом начале клика — браузер разрешает
    // диалоги/плашки только внутри пользовательского жеста.
    // В режиме обновления: если нет handle папки базы, но у старого файла есть
    // handle — используем его для записи (перезапись под тем же именем).
    let folderPromise: Promise<DbDirectoryHandleLike | null>;
    if (src.moveExistingToBackup && src.oldFileName) {
        const store = getFileStore();
        let oldHandle: FileSystemFileHandle | null = null;
        for (const e of Array.from(store.values())) {
            if (e.file && e.file.name === src.oldFileName && e.handle) {
                oldHandle = e.handle;
                break;
            }
        }
        if (oldHandle) {
            // Есть handle старого файла — пишем прямо в него, папку не выбираем
            folderPromise = Promise.resolve(null as unknown as DbDirectoryHandleLike);
        } else {
            folderPromise = ensureDbFolder();
        }
    } else {
        folderPromise = ensureDbFolder();
    }
    const parentPromise = src.moveExistingToBackup ? acquireParentFolder() : Promise.resolve(null);

    const locInput = document.getElementById(src.locInputId) as HTMLInputElement | null;
    const mechInput = document.getElementById(src.mechInputId) as HTMLInputElement | null;
    const location = (locInput?.value ?? '').trim();
    const description = (mechInput?.value ?? '').trim();

    let templateText = '';
    try {
        templateText = await readFileWithEncoding(templateFile);
    } catch (err) {
        console.error('[new-device] Не удалось прочитать шаблон:', err);
        src.setStatus('Не удалось прочитать файл шаблона.');
        return;
    }

    const content = buildDeviceIniContent(templateText, idText, location, description);
    // Имя файла:
    //  - режим обновления (передан oldFileName): имя старого файла — новый файл
    //    заменяет его в Devices, а старый уезжает в BackUp;
    //  - иначе: имя шаблона + серийный номер подключённого устройства.
    const serial = parseDeviceIdString(idText).serial;
    const fileName = src.moveExistingToBackup && src.oldFileName
        ? src.oldFileName
        : `${serial}.ini`;
    // Пишем в Windows-1251 — как вся база и как старый аджастер:
    // новый файл неотличим от старых.
    const bytes = encodeToWindows1251(content);
    const file = new File([bytes], fileName, { type: 'text/plain' });

    // ─── Нативный режим (Tauri): запись напрямую в папку Devices ───────────
    // В WebView Tauri браузерный File System Access API (showDirectoryPicker,
    // getFileHandle, createWritable, showSaveFilePicker) недоступен. Все
    // вызовы ниже — ensureDbFolder / saveFileToDbFolder / downloadFallback —
    // в Tauri возвращают null, и файл никуда не пишется.
    // Поэтому здесь пишем файл напрямую через @tauri-apps/plugin-fs в папку
    // Devices рядом с exe (путь возвращает Rust-команда get_devices_folder_path),
    // а наверх передаём абсолютный путь — он попадёт в currentIniPath
    // (см. file-loader.ts) и будет использован при сохранении изменений
    // (см. save-ini.ts).
    if (isTauriMode()) {
        // Импорты Tauri-плагинов объявляем сразу в начале нативной ветки,
        // потому что они нужны и в блоке обновления прошивки, и в обычном
        // блоке ниже. В исходном варианте объявление стояло только в обычном
        // блоке, и в блоке обновления invoke/writeFile были ещё не определены.
        const { invoke } = await import('@tauri-apps/api/core');
        const { writeFile } = await import('@tauri-apps/plugin-fs');

        // ─── Режим обновления прошивки ──────────────────────────────────────
        // Задача: заменить старый INI новым, предварительно сохранив копию
        // старого в папке BackUp (плоско, имя файла не меняем).
        if (src.moveExistingToBackup && src.oldFileName) {
            // 1. Ищем путь к старому файлу в fileStore.
            //    Записи в fileStore появляются при автозагрузке Devices
            //    (см. tauri-autoloader.ts) — там хранится поле path.
            const store = getFileStore();
            let oldPath: string | undefined;
            for (const e of Array.from(store.values())) {
                if (e.file && e.file.name === src.oldFileName && e.path) {
                    oldPath = e.path;
                    break;
                }
            }

            // 2. Путь неизвестен — по договорённости бэкап пропускаем,
            //    но новый файл всё равно пишем. Логика записи — та же,
            //    что в обычном режиме (см. ниже): определяем имя подпапки
            //    по Location, пишем файл, отдаём путь в конвейер.
            if (!oldPath) {
                console.warn(`[new-device] Tauri: путь к старому файлу "${src.oldFileName}" не найден — бэкап пропускаем, пишем новый файл.`);

                const subdirNameFallback = resolveDeviceSubdirName(location, idText);
                if (!subdirNameFallback) {
                    showIdModal('Не удалось определить имя папки для устройства: не задан Location и не удалось извлечь тип из строки ID. Файл не сохранён.');
                    return;
                }
                let subdirPathFallback: string;
                try {
                    subdirPathFallback = await invoke<string>('ensure_device_subdir', { name: subdirNameFallback });
                } catch (err) {
                    console.error('[new-device] Tauri: ошибка создания подпапки Devices:', err);
                    const msg = err instanceof Error ? err.message : String(err);
                    showIdModal(`Не удалось создать папку "${subdirNameFallback}": ${msg}`);
                    return;
                }
                const fullPathFallback = `${subdirPathFallback}/${fileName}`;
                try {
                    await writeFile(fullPathFallback, bytes);
                    console.log(`[new-device] Tauri: файл записан в ${fullPathFallback} (без бэкапа)`);
                } catch (err) {
                    console.error('[new-device] Tauri: ошибка записи файла:', err);
                    const msg = err instanceof Error ? err.message : String(err);
                    showIdModal(`Не удалось сохранить файл ${fileName}: ${msg}`);
                    return;
                }

                const addToLoadedFnNoBackup = getAddToLoadedFn();
                if (addToLoadedFnNoBackup) {
                    await addToLoadedFnNoBackup(content, fileName, file, undefined, fullPathFallback);
                    selectNewDeviceInTree(idText);
                } else {
                    console.warn('[new-device] Связка с конвейером загрузки не установлена.');
                }
                src.onDone();
                return;
            }

            // 3. Путь известен — проверяем/создаём папку BackUp.
            const { ask } = await import('@tauri-apps/plugin-dialog');
            try {
                await invoke<string>('ensure_backup_dir', { create: false });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('BACKUP_DIR_NOT_FOUND')) {
                    const shouldCreate = await ask(
                        `Папка BackUp не найдена рядом с приложением.\n\nСоздать папку BackUp?`,
                        { title: 'Папка BackUp', kind: 'info' },
                    );
                    if (!shouldCreate) {
                        console.log('[new-device] Tauri: пользователь отказался создавать BackUp — обновление отменено.');
                        return;
                    }
                    try {
                        await invoke<string>('ensure_backup_dir', { create: true });
                    } catch (err2) {
                        const msg2 = err2 instanceof Error ? err2.message : String(err2);
                        showIdModal(`Не удалось создать папку BackUp: ${msg2}`);
                        return;
                    }
                } else {
                    showIdModal(`Ошибка при проверке папки BackUp: ${msg}`);
                    return;
                }
            }

            // 4. Бэкап + перезапись одним вызовом Rust-команды.
            //    Если файл с таким именем уже лежит в BackUp — Rust вернёт
            //    "BACKUP_ALREADY_EXISTS", и мы спросим пользователя.
            let backupPath: string | null = null;
            try {
                backupPath = await invoke<string>('backup_and_replace_ini', {
                    oldPath,
                    newContent: bytes,
                    overwrite: false,
                });
                console.log(`[new-device] Tauri: бэкап сохранён в ${backupPath}, оригинал перезаписан.`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('BACKUP_ALREADY_EXISTS')) {
                    const shouldOverwrite = await ask(
                        `Файл ${src.oldFileName} уже есть в папке BackUp.\n\nПерезаписать его?`,
                        { title: 'BackUp', kind: 'warning' },
                    );
                    if (!shouldOverwrite) {
                        console.log('[new-device] Tauri: пользователь отказался перезаписывать бэкап — обновление отменено.');
                        return;
                    }
                    try {
                        backupPath = await invoke<string>('backup_and_replace_ini', {
                            oldPath,
                            newContent: bytes,
                            overwrite: true,
                        });
                        console.log(`[new-device] Tauri: бэкап перезаписан в ${backupPath}, оригинал перезаписан.`);
                    } catch (err2) {
                        const msg2 = err2 instanceof Error ? err2.message : String(err2);
                        showIdModal(`Не удалось сохранить бэкап: ${msg2}`);
                        return;
                    }
                } else {
                    showIdModal(`Не удалось обновить файл: ${msg}`);
                    return;
                }
            }

            // 5. Помечаем старую запись в реестре как резервную копию
            //    (isBackup = true). Это то самое «старое устройство», которое
            //    уехало в BackUp: файл на диске уже перезаписан новой версией,
            //    но в дереве мы хотим видеть его отдельной красной строкой.
            //
            //    Заодно удаляем запись из fileStore: путь, который в ней хранится,
            //    ведёт на уже перезаписанный файл — работать с ним как с «живым»
            //    устройством нельзя. Актуальный путь для новой версии появится
            //    ниже, при регистрации через addToLoadedFnUpdate.
            if (src.oldFileName) {
                // 5a. Сначала убираем из дерева все устаревшие красные записи
                //     для этого же файла BackUp. Такие записи остаются от
                //     предыдущих апдейтов того же устройства: файл в BackUp
                //     уже перезаписан новым, показывать старый снимок больше
                //     нечего. Без этой чистки красные записи копятся в дереве,
                //     хотя в папке BackUp всегда лежит один файл.
                for (const loc of Object.keys(deviceRegistry)) {
                    const group = deviceRegistry[loc];
                    if (!Array.isArray(group)) continue;
                    for (const item of [...group]) {
                        if (item.isBackup && item.backupFileName === src.oldFileName) {
                            console.log(`[new-device] Tauri: удаляем устаревшую красную запись ${item.id} (файл ${src.oldFileName})`);
                            removeDeviceFromRegistry(loc, item.id);
                        }
                    }
                }

                // 5b. Теперь помечаем текущую запись как backup.
                const store = getFileStore();
                for (const [key, e] of Array.from(store.entries())) {
                    if (e.file && e.file.name === src.oldFileName) {
                        // Находим соответствующий узел дерева по id из fileStore
                        // и помечаем его как backup — он отрисуется красным.
                        // Запоминаем имя файла в BackUp (backupFileName) —
                        // это связь между записью в дереве и реальным файлом
                        // в папке BackUp. Понадобится при синхронизации
                        // с диском (кнопка «Обновить список»), чтобы удалять
                        // красные записи, чьих файлов там уже нет.
                        const item = getAllDevices().find((d) => d.iniConfig?.device?.id === e.id);
                        if (item) {
                            item.isBackup = true;
                            item.backupFileName = src.oldFileName;
                            console.log(`[new-device] Tauri: старуе устройство ${e.id} помечено как backup (файл ${src.oldFileName})`);
                        }
                        store.delete(key);
                    }
                }
            }

            // 6. Отдаём файл в общий конвейер. Путь — старый (файл лежит там же,
            //    где и был, просто с новым содержимым). Так работает и в браузере.
            const addToLoadedFnUpdate = getAddToLoadedFn();
            if (addToLoadedFnUpdate) {
                await addToLoadedFnUpdate(content, fileName, file, undefined, oldPath);
                selectNewDeviceInTree(idText);
            } else {
                console.warn('[new-device] Связка с конвейером загрузки не установлена.');
            }
            src.onDone();
            return;
        }

        // Имя подпапки внутри Devices: Location, либо токены ID-строки
        // между серийником и датой (см. resolveDeviceSubdirName выше).
        // Если ни то, ни другое не дало результата — файл не сохраняем.
        const subdirName = resolveDeviceSubdirName(location, idText);
        if (!subdirName) {
            showIdModal('Не удалось определить имя папки для устройства: не задан Location и не удалось извлечь тип из строки ID. Файл не сохранён.');
            return;
        }

        // Создаём (или находим) подпапку внутри Devices.
        // Rust-команда сама определяет путь к Devices рядом с exe
        // и создаёт подпапку, если её ещё нет.
        let subdirPath: string;
        try {
            subdirPath = await invoke<string>('ensure_device_subdir', { name: subdirName });
        } catch (err) {
            console.error('[new-device] Tauri: ошибка создания подпапки Devices:', err);
            const msg = err instanceof Error ? err.message : String(err);
            showIdModal(`Не удалось создать папку "${subdirName}": ${msg}`);
            return;
        }

        const fullPath = `${subdirPath}/${fileName}`;
        try {
            await writeFile(fullPath, bytes);
            console.log(`[new-device] Tauri: файл записан в ${fullPath}`);
        } catch (err) {
            console.error('[new-device] Tauri: ошибка записи файла:', err);
            const msg = err instanceof Error ? err.message : String(err);
            showIdModal(`Не удалось сохранить файл ${fileName}: ${msg}`);
            return;
        }

        // Отдаём файл в общий конвейер: он попадёт в fileStore с полем path,
        // и с этого момента устройство можно редактировать и сохранять.
        const addToLoadedFnTauri = getAddToLoadedFn();
        if (addToLoadedFnTauri) {
            await addToLoadedFnTauri(content, fileName, file, undefined, fullPath);
            selectNewDeviceInTree(idText);
        } else {
            console.warn('[new-device] Связка с конвейером загрузки не установлена.');
        }

        src.onDone();
        return;
    }

    const handle = await folderPromise;
    const parent = await parentPromise;
    console.log(`[new-device] update-mode: oldFileName=${src.oldFileName ?? '—'}, dbHandle=${handle ? 'yes' : 'no'}, parent=${parent ? 'yes' : 'no'}`);
    let fileHandle: FileSystemFileHandle | undefined;
    let existed = false;
    let savedToDb = false;

    // Ищем handle старого файла (для режима обновления)
    let directOldHandle: FileSystemFileHandle | null = null;
    if (src.moveExistingToBackup && src.oldFileName) {
        const store = getFileStore();
        for (const e of Array.from(store.values())) {
            if (e.file && e.file.name === src.oldFileName && e.handle) {
                directOldHandle = e.handle;
                break;
            }
        }
    }

    if (directOldHandle && src.moveExistingToBackup && src.oldFileName) {
        // Режим обновления:
        //  1) читаем старое содержимое;
        //  2) создаём копию "имя_old.ini" через папку базы;
        //  3) перезаписываем старый файл "имя.ini" новым содержимым (handle прямого доступа).

        const backupFileName = src.oldFileName.replace(/\.ini$/i, '_old.ini');
        console.log(`[new-device] Режим обновления: oldFileName=${src.oldFileName}, backupFileName=${backupFileName}, fileName=${fileName}`);

                // Шаг 1: читаем старое содержимое
        let oldContent: Uint8Array<ArrayBuffer> | null = null;
        try {
            const oldFile = await directOldHandle.getFile();
            oldContent = new Uint8Array(await oldFile.arrayBuffer()) as Uint8Array<ArrayBuffer>;
            console.log(`[new-device] Старый файл прочитан, байт: ${oldContent.length}`);
        } catch (err) {
            console.error('[new-device] Не удалось прочитать старый файл:', err);
            showIdModal('Не удалось прочитать старый файл. Ничего не записано.');
            return;
        }

        // Шаг 2: показываем диалог сохранения для бэкапа "_old.ini"
        // Если пользователь отменяет — НИЧЕГО не делаем, старый файл остаётся как есть.
        let backupCreated = false;
        try {
            console.log(`[new-device] Показываем диалог сохранения для бэкапа ${backupFileName}...`);
            const w = window as unknown as {
                showSaveFilePicker?: (opts: { suggestedName?: string; types?: Array<{ description?: string; accept?: Record<string, string[]> }> }) => Promise<FileSystemFileHandle | undefined>;
            };
            if (typeof w.showSaveFilePicker !== 'function') {
                showIdModal('Браузер не поддерживает диалог сохранения. Бэкап не создан, старый файл не изменён.');
                return;
            }
            const backupHandle = await w.showSaveFilePicker({
                suggestedName: backupFileName,
                types: [{ description: 'INI Files', accept: { 'text/plain': ['.ini'] } }],
            });
            if (!backupHandle) {
                console.log('[new-device] Пользователь отменил сохранение бэкапа. Старый файл не изменён.');
                showIdModal('Сохранение бэкапа отменено. Старый файл не изменён.');
                return;
            }
            const backupWritable = await backupHandle.createWritable();
            await backupWritable.write(oldContent);
            await backupWritable.close();
            backupCreated = true;
            console.log(`[new-device] Бэкап сохранён как ${backupHandle.name}`);
        } catch (err) {
            console.error('[new-device] Ошибка создания бэкапа:', err);
            showIdModal('Ошибка создания бэкапа. Старый файл не изменён.');
            return;
        }

        // Шаг 3: перезаписываем старый файл новым содержимым
        // (только если бэкап успешно создан)
        if (!backupCreated) {
            console.warn('[new-device] Бэкап не создан — перезапись отменена.');
            return;
        }
        try {
            const writable = await directOldHandle.createWritable();
            await writable.write(bytes);
            await writable.close();
            savedToDb = true;
            fileHandle = directOldHandle;
            console.log(`[new-device] Файл ${fileName} перезаписан новым содержимым.`);
        } catch (err) {
            console.error('[new-device] Ошибка перезаписи файла:', err);
            showIdModal('Ошибка перезаписи файла. Ничего не записано.');
            return;
        }
    } else if (handle) {
        // Обычный режим (без обновления): сохраняем новый файл в папку базы
        // и обязательно получаем FileSystemFileHandle для дальнейшего редактирования.
        const res = await saveFileToDbFolder(handle, fileName, bytes, null);

        if (res.status === 'saved' || res.status === 'exists') {
            savedToDb = true;
            existed = res.status === 'exists';

            let savedHandle = res.fileHandle ?? undefined;

            // Страховка: если saveFileToDbFolder сохранил файл, но не вернул handle,
            // получаем handle напрямую из папки базы.
            if (!savedHandle) {
                try {
                    savedHandle = await handle.getFileHandle(fileName, { create: false });
                    console.log(`[new-device] Handle для ${fileName} получен напрямую из папки базы.`);
                } catch (err) {
                    console.error(`[new-device] Файл ${fileName} сохранён, но handle получить не удалось:`, err);
                }
            }

            fileHandle = savedHandle;

            if (res.status === 'saved') {
                console.log(`[new-device] Файл ${fileName} сохранён в папку базы.`);
            } else {
                console.warn(`[new-device] Файл ${fileName} уже есть в папке базы и НЕ перезаписан.`);
            }
        } else {
            console.warn('[new-device] Сохранить в папку базы не удалось — скачиваю в "Загрузки".');
        }
    }

    if (!savedToDb) {
        const fallbackHandle = await downloadFallback(fileName, bytes);
        if (fallbackHandle) {
            fileHandle = fallbackHandle;
            savedToDb = true;
            console.log(`[new-device] Файл ${fileName} сохранён через showSaveFilePicker (handle получен).`);
        } else {
            console.log(`[new-device] Файл ${fileName} скачан в "Загрузки" без handle — редактирование будет недоступно.`);
        }
    }

    // Режим обновления: старое устройство (его файл уехал в BackUp) помечаем
    // как резервную копию — оно остаётся в дереве, но рисуется красным
    if (savedToDb && src.moveExistingToBackup && src.oldFileName) {
        const store = getFileStore();
        for (const [key, e] of Array.from(store.entries())) {
            if (e.file && e.file.name === src.oldFileName) {
                const item = getAllDevices().find((d) => d.iniConfig?.device?.id === e.id);
                if (item) {
                    item.isBackup = true;
                    console.log(`[new-device] Старое устройство ${e.id} помечено как backup (файл уехал в BackUp)`);
                }
                store.delete(key);
            }
        }
        renderDeviceTree();
    }

    const addToLoadedFn = getAddToLoadedFn();
    if (addToLoadedFn) {
        await addToLoadedFn(content, fileName, file, fileHandle);
        selectNewDeviceInTree(idText);
    } else {
        console.warn('[new-device] Связка с конвейером загрузки не установлена.');
    }

    src.onDone();
    if (existed) {
        showIdModal(`Файл ${fileName} уже есть в папке базы и НЕ перезаписан.`);
    }
}

/**
 * Обёртка для кнопки "Добавить устройство в базу" в окне "Новое устройство".
 * Экспортируется, потому что вызывается из initNewDeviceUI (new-device-ui.ts).
 */
export async function handleAddToBase(): Promise<void> {
    await handleAddToBaseGeneric({
        templateSelectId: 'newDeviceTemplateSelect',
        mechInputId: 'newDeviceMechInput',
        locInputId: 'newDeviceLocInput',
        idText: (document.querySelector('.id-banner span')?.textContent ?? '').trim(),
        setStatus: setNewDeviceStatus,
        onDone: hideNewDeviceModal,
    });
}

/**
 * Вставляет/заменяет в секции [DEVICE] шаблона строки ID=, Location=, Description=.
 *
 * Особенности:
 *  - ID= всегда заменяется на полную строку подключённого контроллера;
 *  - Location= и Description= присутствуют в [DEVICE] ВСЕГДА, даже если
 *    значения из полей пустые (тогда строки будут вида "Location=" без
 *    значения). Это соглашение структуры INI-файлов проекта — см. также
 *    buildBackupContent в backup-ui.ts, где применена та же логика;
 *  - если в шаблоне строки не было — она добавляется в конец [DEVICE];
 *  - если в шаблоне вообще нет секции [DEVICE] — создаём её целиком.
 */
function buildDeviceIniContent(
    templateText: string,
    idText: string,
    location: string,
    description: string,
): string {
    const lines = templateText.split(/\r?\n/);
    const out: string[] = [];
    let inDevice = false;
    let deviceSeen = false;
    let idDone = false;
    let locDone = false;
    let descDone = false;

    const flushMissing = (): void => {
        if (!idDone) out.push(`ID=${idText}`);
        if (!locDone) out.push(`Location=${location}`);
        if (!descDone) out.push(`Description=${description}`);
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const sec = trimmed.match(/^\[(.*)\]$/);
        if (sec) {
            if (inDevice) flushMissing();
            inDevice = ((sec[1] ?? '').trim().toUpperCase() === 'DEVICE');
            if (inDevice) deviceSeen = true;
            out.push(line);
            continue;
        }
        if (inDevice && trimmed.includes('=')) {
            const key = trimmed.split('=')[0].trim().toLowerCase();
            if (key === 'id') {
                out.push(`ID=${idText}`);
                idDone = true;
                continue;
            }
            if (key === 'location') {
                out.push(`Location=${location}`);
                locDone = true;
                continue;
            }
            if (key === 'description') {
                out.push(`Description=${description}`);
                descDone = true;
                continue;
            }
        }
        out.push(line);
    }
    if (inDevice) flushMissing();
    if (!deviceSeen) {
        // В шаблоне не было секции [DEVICE] — создаём с нуля.
        // Location= и Description= пишем всегда, даже если пустые.
        out.unshift(
            '[DEVICE]',
            `ID=${idText}`,
            `Location=${location}`,
            `Description=${description}`,
            '',
        );
    }
    return out.join('\n');
}

/** Выделяет в дереве узел только что добавленного устройства. */
function selectNewDeviceInTree(idText: string): void {
    const found = getAllDevices().find((d) => (d.iniConfig.device ? d.iniConfig.device.id : '') === idText);
    if (!found) return;
    document.querySelectorAll('.tree-id-item.is-selected').forEach((el) => el.classList.remove('is-selected'));
    const leaf = document.querySelector(`.tree-id-item.is-leaf[data-device-id="${CSS.escape(found.id)}"]`);
    if (leaf) leaf.classList.add('is-selected');
}