// src/ui/backup-ui.ts
/**
 * Окно "Создать резерв для устройства...": создание записи в базе с
 * параметрами, идентичными существующему устройству (шаблону).
 *
 * Сейчас: показ окна, заполнение данных, выбор строки-шаблона.
 * Алгоритм "Применить" — следующий шаг.
 */
import { parseDeviceIdString } from '../core/report-data.js';
import { getAllDevices, deviceRegistry, removeDeviceFromRegistry } from '../ini-manager/tree-core.js';
import { getFileStore } from '../ini-manager/file-loader.js';
import { encodeToWindows1251 } from '../core/encoding.js';
import { showIdModal } from './ui.js';

/**
 * Очищает имя файла от недопустимых символов для File System Access API (Windows).
 * Заменяет всё, кроме букв, цифр, точек, дефисов и подчеркиваний, на '_'.
 */
function sanitizeFileName(name: string): string {
    // Разрешаем: латиницу, кириллицу, цифры, точку, дефис, подчеркивание, пробел (иногда нужен)
    // Но для надежности на Windows лучше убрать пробелы тоже, заменив на '_'
    // Регулярка оставляет только безопасные символы
    return name.replace(/[^a-zA-Z0-9\u0400-\u04FF._-]/g, '_');
}

/** Идентификатор устройства, выбранного шаблоном. */
let selectedTemplateId: string | null = null;

export function getBackupTemplateId(): string | null {
    return selectedTemplateId;
}

/**
 * Связка с конвейером загрузки (вставляет uiManager, у него есть appState).
 * Пятый параметр `path` нужен в нативном режиме (Tauri): там нет
 * FileSystemFileHandle, но есть абсолютный путь к файлу на диске,
 * по которому потом сохраняются изменения (см. save-ini.ts и currentIniPath).
 */
type LoadFn = (
    content: string,
    fileName: string,
    file: File,
    handle?: FileSystemFileHandle,
    path?: string,
) => Promise<void>;
let loadFn: LoadFn | null = null;

export function setBackupLoadFn(fn: LoadFn): void {
    loadFn = fn;
}

export function initBackupUI(): void {
    document.getElementById('backupCloseBtn')?.addEventListener('click', () => {
        hideBackupWindow();
    });
    document.getElementById('backupCancelBtn')?.addEventListener('click', () => {
        hideBackupWindow();
    });

    document.getElementById('backupTypeSelect')?.addEventListener('change', () => {
        renderBackupTable();
    });

    document.getElementById('backupApplyBtn')?.addEventListener('click', () => {
        void handleBackupApply();
    });
}

export interface BackupWindowSource {
    mechInputId?: string;
    locInputId?: string;
    callerOverlayId?: string;
}

/** Окно-источник: откуда брать Механизм/Расположение и что закрывать после применения. */
let currentSource = {
    mechInputId: 'newDeviceMechInput',
    locInputId: 'newDeviceLocInput',
    callerOverlayId: 'newDeviceOverlay',
};

/** Открывает окно и заполняет данные создаваемого устройства. */
export function showBackupWindow(source?: BackupWindowSource): void {
    const overlay = document.getElementById('backupOverlay');
    if (!overlay) return;

    const mechInputId = source?.mechInputId ?? 'newDeviceMechInput';
    const locInputId = source?.locInputId ?? 'newDeviceLocInput';
    currentSource = {
        mechInputId,
        locInputId,
        callerOverlayId: source?.callerOverlayId ?? 'newDeviceOverlay',
    };

    const idText = (document.querySelector('.id-banner span')?.textContent ?? '').trim();
    const parsed = parseDeviceIdString(idText);

    // Блок "Устройство" — данные создаваемого устройства.
    const info = document.getElementById('backupDeviceInfo');
    if (info) {
        const mech = (document.getElementById(mechInputId) as HTMLInputElement | null)?.value.trim() ?? '';
        const loc = (document.getElementById(locInputId) as HTMLInputElement | null)?.value.trim() ?? '';
        info.textContent =
            `Серийный номер : ${parsed.serial}\n` +
            `Механизм       : ${mech}\n` +
            `Место установки: ${loc}`;
    }

    // "Устройство типа" — все типы, имеющиеся в базе.
    const select = document.getElementById('backupTypeSelect') as HTMLSelectElement | null;
    if (select) {
        select.innerHTML = '';
        const types: string[] = [];
        for (const d of getAllDevices()) {
            // Резервные копии (файлы xxx_old.ini, помеченные красным) — не шаблоны
            if (d.isBackup) continue;
            const devId = d.iniConfig.device ? d.iniConfig.device.id : '';
            const t = parseDeviceIdString(devId).deviceType;
            if (t && !types.includes(t)) types.push(t);
        }
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            select.appendChild(opt);
        }
        // Если устройства того же типа есть — поле заполняется сразу.
        if (types.includes(parsed.deviceType)) {
            select.value = parsed.deviceType;
        } else if (types.length > 0) {
            select.value = types[0];
        }
    }

    selectedTemplateId = null;
    renderBackupTable();
    overlay.classList.remove('hidden');
}

function hideBackupWindow(): void {
    document.getElementById('backupOverlay')?.classList.add('hidden');
}

/** Таблица устройств выбранного типа; клик по строке — выбор шаблона. */
function renderBackupTable(): void {
    const tbody = document.getElementById('backupTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    selectedTemplateId = null;

    const select = document.getElementById('backupTypeSelect') as HTMLSelectElement | null;
    const type = select?.value ?? '';
    if (!type) return;

    const store = getFileStore();

    for (const d of getAllDevices()) {
        // Резервные копии (файлы xxx_old.ini, помеченные красным) — не шаблоны
        if (d.isBackup) continue;
        const dev = d.iniConfig.device;
        const devId = dev ? dev.id : '';
        if (parseDeviceIdString(devId).deviceType !== type) continue;

        const serial = parseDeviceIdString(devId).serial;
        const location = dev?.location ?? '';
        const mech = dev?.description ?? '';

        // Имя файла — из хранилища по ключу "location::id".
        let fileName = '—';
        const entry = store.get(`${location}::${devId}`);
        if (entry?.file) fileName = entry.file.name;

        const tr = document.createElement('tr');
        for (const text of [location, mech, serial, fileName]) {
            const td = document.createElement('td');
            td.textContent = text;
            td.title = text;
            tr.appendChild(td);
        }
        tr.addEventListener('click', () => {
            tbody.querySelectorAll('tr.is-selected').forEach((r) => r.classList.remove('is-selected'));
            tr.classList.add('is-selected');
            selectedTemplateId = d.id;
        });
        tbody.appendChild(tr);
    }
}
/**
 * "Применить": создаёт новый INI-файл для подключённого контроллера
 * на основе выбранного шаблона. Логика полностью симметрична кнопке
 * "Добавить устройство в базу" в окне «Обновление программы устройства»:
 *
 *  1. Собираем содержимое нового файла из шаблона (ID/Location/Description
 *     подставляются по галочкам — см. buildBackupContent).
 *  2. Ищем «старый» файл — тот же serial + deviceType, что у подключённого
 *     контроллера, среди живых (не backup) записей fileStore.
 *     - Если нашли: старый файл уезжает в BackUp, новый пишется на его место
 *       через Rust-команду backup_and_replace_ini.
 *     - Если не нашли: пишем как новое устройство — в Devices/<location>/.
 *  3. Помечаем старую запись в дереве как backup (красная),
 *     чистим устаревшие красные записи с тем же backupFileName.
 *  4. Передаём path в конвейер загрузки (loadFn), чтобы последующее
 *     сохранение изменений работало (см. save-ini.ts и currentIniPath).
 */
async function handleBackupApply(): Promise<void> {
    console.log('[backup] Apply: selectedTemplateId =', selectedTemplateId);
    if (!selectedTemplateId) {
        showIdModal('Выберите строку-шаблон в таблице.');
        return;
    }
    const templateDev = getAllDevices().find((d) => d.id === selectedTemplateId);
    if (!templateDev) {
        showIdModal('Шаблон не найден в реестре устройств.');
        return;
    }
    const dev = templateDev.iniConfig.device;
    const devId = dev ? dev.id : '';

    // Ищем контент шаблона в хранилище: сначала по ключу, затем перебором по ID в [DEVICE]
    const store = getFileStore();
    let entry = store.get(`${dev?.location ?? ''}::${devId}`);
    if (!entry?.content) entry = findStoreEntryByDeviceId(devId);
    if (!entry || !entry.content) {
        showIdModal('Файл шаблона не найден в хранилище.');
        return;
    }

    const bannerId = (document.querySelector('.id-banner span')?.textContent ?? '').trim();
    const bannerParsed = parseDeviceIdString(bannerId);
    const newSerial = bannerParsed.serial;
    const connectedType = bannerParsed.deviceType;
    if (!newSerial) {
        showIdModal('ID подключённого устройства пуст.');
        return;
    }

    const useLocation = (document.getElementById('backupUseLocation') as HTMLInputElement | null)?.checked ?? false;
    const useMech = (document.getElementById('backupUseMech') as HTMLInputElement | null)?.checked ?? false;

    // Значения из окна-источника (Новое устройство или Обновление ПО)
    const callerMech = (document.getElementById(currentSource.mechInputId) as HTMLInputElement | null)?.value.trim() ?? '';
    const callerLoc = (document.getElementById(currentSource.locInputId) as HTMLInputElement | null)?.value.trim() ?? '';

    // ID= в новом файле — полная строка подключённого контроллера
    const content = buildBackupContent(entry.content, bannerId, useLocation, useMech, callerLoc, callerMech);
    const newIdValue = bannerId;

    // ─── Ищем «старый» файл: тот же serial + deviceType, что у подключённого. ─
    // Версию и локацию игнорируем — это то, что меняется при апдейте.
    // Backup-записи в fileStore не хранятся (мы удаляем их при пометке),
    // так что здесь только живые файлы.
    let oldPath: string | undefined;
    for (const e of Array.from(store.values())) {
        if (!e.path) continue;
        const eParsed = parseDeviceIdString(e.id);
        if (eParsed.serial !== newSerial) continue;
        if (eParsed.deviceType !== connectedType) continue;
        oldPath = e.path;
        break;
    }

    // ─── Имя нового файла ───────────────────────────────────────────────────
    // Если есть старый — сохраняем его имя (как при апдейте). Если нет —
    // пишем как <serial>.ini.
    let fileName = `${newSerial}.ini`;
    if (oldPath) {
        const oldName = oldPath.split('/').pop()?.split('\\').pop();
        if (oldName) fileName = oldName;
    }
    fileName = fileName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    fileName = sanitizeFileName(fileName);

    const bytes = encodeToWindows1251(content);
    const file = new File([bytes], fileName, { type: 'text/plain' });
    console.log(`[backup] Имя файла: "${fileName}", oldPath=${oldPath ?? '—'}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const { ask } = await import('@tauri-apps/plugin-dialog');

    // ─── Ветка 1: старый файл найден — бэкап + перезапись ───────────────────
    if (oldPath) {
        // Проверяем/создаём BackUp
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
                    console.log('[backup] Пользователь отказался создавать BackUp — операция отменена.');
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

        // backup_and_replace_ini: копия в BackUp + перезапись оригинала.
        // Если файл с таким именем уже в BackUp — Rust вернёт
        // "BACKUP_ALREADY_EXISTS", спросим пользователя и повторим с overwrite=true.
        try {
            await invoke<string>('backup_and_replace_ini', {
                oldPath,
                newContent: bytes,
                overwrite: false,
            });
            console.log(`[backup] Tauri: бэкап создан, оригинал перезаписан: ${oldPath}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('BACKUP_ALREADY_EXISTS')) {
                const shouldOverwrite = await ask(
                    `Файл ${fileName} уже есть в папке BackUp.\n\nПерезаписать его?`,
                    { title: 'BackUp', kind: 'warning' },
                );
                if (!shouldOverwrite) {
                    console.log('[backup] Пользователь отказался перезаписывать бэкап — операция отменена.');
                    return;
                }
                try {
                    await invoke<string>('backup_and_replace_ini', {
                        oldPath,
                        newContent: bytes,
                        overwrite: true,
                    });
                    console.log(`[backup] Tauri: бэкап перезаписан, оригинал перезаписан: ${oldPath}`);
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

        // Помечаем старую запись как backup + чистим устаревшие красные записи
        // с тем же backupFileName (чтобы не накапливались при повторных апдейтах).
        for (const loc of Object.keys(deviceRegistry)) {
            const group = deviceRegistry[loc];
            if (!Array.isArray(group)) continue;
            for (const item of [...group]) {
                if (item.isBackup && item.backupFileName === fileName) {
                    console.log(`[backup] Удаляем устаревшую красную запись ${item.id} (файл ${fileName})`);
                    removeDeviceFromRegistry(loc, item.id);
                }
            }
        }
        const storeRef = getFileStore();
        for (const [key, e] of Array.from(storeRef.entries())) {
            if (e.path === oldPath) {
                const item = getAllDevices().find((d) => d.iniConfig?.device?.id === e.id);
                if (item) {
                    item.isBackup = true;
                    item.backupFileName = fileName;
                    console.log(`[backup] Старое устройство ${e.id} помечено как backup (файл ${fileName})`);
                }
                storeRef.delete(key);
                break;
            }
        }

        // Передаём в конвейер с путём = oldPath (там теперь новое содержимое)
        if (loadFn) {
            await loadFn(content, fileName, file, undefined, oldPath);
            selectBackupDeviceInTree(newIdValue);
        } else {
            console.warn('[backup] Связка с конвейером загрузки не установлена.');
        }

        hideBackupWindow();
        document.getElementById(currentSource.callerOverlayId)?.classList.add('hidden');
        return;
    }

    // ─── Ветка 2: старого файла нет — пишем как новое устройство ────────────
    const subdirName = resolveSubdirNameFromContent(content, bannerId);
    if (!subdirName) {
        showIdModal('Не удалось определить имя папки: нет Location и не удалось извлечь тип из ID.');
        return;
    }

    let subdirPath: string;
    try {
        subdirPath = await invoke<string>('ensure_device_subdir', { name: subdirName });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal(`Не удалось создать папку "${subdirName}": ${msg}`);
        return;
    }

    const fullPath = `${subdirPath}/${fileName}`;
    try {
        await writeFile(fullPath, bytes);
        console.log(`[backup] Tauri: файл записан в ${fullPath}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal(`Не удалось сохранить файл ${fileName}: ${msg}`);
        return;
    }

    if (loadFn) {
        await loadFn(content, fileName, file, undefined, fullPath);
        selectBackupDeviceInTree(newIdValue);
    } else {
        console.warn('[backup] Связка с конвейером загрузки не установлена.');
    }

    hideBackupWindow();
    document.getElementById(currentSource.callerOverlayId)?.classList.add('hidden');
}

/** Достаёт Location= из готового текста INI (в секции [DEVICE]). */
function extractLocation(content: string): string {
    const m = content.match(/^\s*Location\s*=\s*(.+)$/m);
    return m ? (m[1] ?? '').trim() : '';
}

/**
 * Определяет имя подпапки внутри Devices для нового файла:
 *  1. Location из готового content, если он там есть;
 *  2. иначе — токены ID-строки между серийником и датой
 *     (например, "DExS.SMFCB v1.10.6.1").
 * Возвращает null, если ни Location, ни токены не дали результата.
 *
 * Логика зеркалит resolveDeviceSubdirName из new-device-add.ts,
 * чтобы имена папок совпадали при обоих путях создания файла.
 */
function resolveSubdirNameFromContent(content: string, idText: string): string | null {
    const loc = extractLocation(content);
    if (loc) return loc.replace(/[\\/:*?"<>|!]/g, '_');

    const tokens = idText.trim().split(/\s+/);
    if (tokens.length < 2) return null;

    const middle: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) break;
        if (t.includes('www.') || /^[\w.-]+\.(ru|com|net|org)$/i.test(t)) break;
        middle.push(t);
    }
    if (middle.length === 0) return null;
    return middle.join(' ').replace(/[\\/:*?"<>|!]/g, '_');
}

/** Ищет запись хранилища по ID устройства из секции [DEVICE]. */
function findStoreEntryByDeviceId(devId: string) {
    const store = getFileStore();
    for (const [, e] of store) {
        if (!e.content) continue;
        const m = e.content.match(/^\s*ID\s*=\s*(.+)$/m);
        if (m && (m[1] ?? '').trim() === devId) return e;
    }
    return undefined;
}

/**
 * Сборка контента резерва:
 *  - ID= : заменяется на полную ID-строку подключённого контроллера;
 *  - Location= : если галочка useLocation стоит — берётся строка из шаблона
 *                как есть (если её там нет — подставляется пустая);
 *                если галочка не стоит — берётся значение из окна-источника
 *                (может быть пустым, но строка в файле будет всегда);
 *  - Description= : аналогично, по галочке useMech;
 *  - строки Location= и Description= присутствуют в [DEVICE] ВСЕГДА,
 *    даже если значения пустые — это соглашение структуры INI-файлов
 *    проекта (см. также buildDeviceIniContent в new-device-add.ts).
 */
function buildBackupContent(
    templateText: string,
    newIdText: string,
    useLocation: boolean,
    useMech: boolean,
    callerLocation: string,
    callerMech: string,
): string {
    const lines = templateText.split(/\r?\n/);
    const out: string[] = [];
    let inDevice = false;
    let deviceSeen = false;
    let idDone = false;
    let locDone = false;
    let descDone = false;

    // Если галочка стоит — значение берём из шаблона (null означает
    // «взять, что есть в шаблоне»). Если не стоит — из окна-источника.
    const locationFromTemplate = useLocation;
    const descFromTemplate = useMech;

    const flushMissing = (): void => {
        if (!idDone) out.push(`ID=${newIdText}`);
        if (!locDone) {
            // Строки Location= в шаблоне не было — добавляем с нужным значением
            const v = locationFromTemplate ? '' : callerLocation;
            out.push(`Location=${v}`);
        }
        if (!descDone) {
            const v = descFromTemplate ? '' : callerMech;
            out.push(`Description=${v}`);
        }
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
                out.push(`ID=${newIdText}`);
                idDone = true;
                continue;
            }
            if (key === 'location') {
                locDone = true;
                if (locationFromTemplate) {
                    out.push(line);              // строка из шаблона как есть
                } else {
                    out.push(`Location=${callerLocation}`);  // из окна (может быть пусто)
                }
                continue;
            }
            if (key === 'description') {
                descDone = true;
                if (descFromTemplate) {
                    out.push(line);
                } else {
                    out.push(`Description=${callerMech}`);
                }
                continue;
            }
        }
        out.push(line);
    }
    if (inDevice) flushMissing();
    if (!deviceSeen) {
        // В шаблоне вообще не было секции [DEVICE] — создаём её с нуля.
        // Location= и Description= всё равно пишем, даже если пустые.
        const locVal = locationFromTemplate ? '' : callerLocation;
        const descVal = descFromTemplate ? '' : callerMech;
        out.unshift(
            '[DEVICE]',
            `ID=${newIdText}`,
            `Location=${locVal}`,
            `Description=${descVal}`,
            '',
        );
    }
    return out.join('\n');
}

/** Выделяет в дереве узел созданного резерва. */
function selectBackupDeviceInTree(newIdValue: string): void {
    const found = getAllDevices().find((d) => (d.iniConfig.device ? d.iniConfig.device.id : '') === newIdValue);
    if (!found) return;
    document.querySelectorAll('.tree-id-item.is-selected').forEach((el) => el.classList.remove('is-selected'));
    const leaf = document.querySelector(`.tree-id-item.is-leaf[data-device-id="${CSS.escape(found.id)}"]`);
    if (leaf) leaf.classList.add('is-selected');
}