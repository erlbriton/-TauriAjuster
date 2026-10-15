// src/ui/backup-apply.ts
/**
 * Логика кнопки «Применить» в окне «Создать резерв для устройства…».
 *
 * Файл вынесен из backup-ui.ts, чтобы не смешивать UI-часть (окно, таблица,
 * выбор шаблона) с бизнес-логикой (создание и запись нового INI-файла).
 *
 * Связь с backup-ui.ts — через объект BackupApplyContext: он передаёт
 * значение selectedTemplateId, адреса полей окна-источника, функцию loadFn
 * и колбэки закрытия окна/выделения узла в дереве.
 */
import { parseDeviceIdString } from '../core/report-data.js';
import {
    getAllDevices,
    deviceRegistry,
    removeDeviceFromRegistry,
} from '../ini-manager/tree-core.js';
import { getFileStore } from '../ini-manager/file-loader.js';
import { encodeToWindows1251 } from '../core/encoding.js';
import { decodeTextBuffer } from '../ini-manager/textFileReader.js';
import { showIdModal } from './ui.js';
import { writeFile } from '@tauri-apps/plugin-fs';

/** Функция загрузки, которую backup-ui передаёт из uiManager. */
export type BackupLoadFn = (
    content: string,
    fileName: string,
    file: File,
    handle?: FileSystemFileHandle,
    path?: string,
) => Promise<void>;

/** Всё, что handleBackupApply нужно из внешнего мира (из backup-ui.ts). */
interface BackupApplyContext {
    selectedTemplateId: string | null;
    currentSource: {
        mechInputId: string;
        locInputId: string;
        callerOverlayId: string;
    };
    loadFn: BackupLoadFn | null;
    hideWindow: () => void;
    selectDeviceInTree: (id: string) => void;
}

// ─── Состояние перетаскивания окна резервной копии ──────────
let backupDragOffsetX = 0;
let backupDragOffsetY = 0;
let backupIsDragging = false;
let backupDragStartX = 0;
let backupDragStartY = 0;

/** Применяет текущее смещение к окну через transform. */
function applyBackupDragTransform(): void {
    const win = document.querySelector<HTMLElement>('.backup-window');
    if (!win) return;
    if (backupDragOffsetX === 0 && backupDragOffsetY === 0) {
        win.style.transform = '';
    } else {
        win.style.transform = `translate(${backupDragOffsetX}px, ${backupDragOffsetY}px)`;
    }
}

/** Инициализирует перетаскивание окна за заголовок. */
function setupBackupDragging(): void {
    const header = document.querySelector<HTMLElement>('#backupOverlay .backup-header');
    const win = document.querySelector<HTMLElement>('.backup-window');
    if (!header || !win) return;

    header.addEventListener('mousedown', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('button, input, select, a, textarea')) return;

        backupIsDragging = true;
        backupDragStartX = e.clientX - backupDragOffsetX;
        backupDragStartY = e.clientY - backupDragOffsetY;
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
        if (!backupIsDragging) return;
        backupDragOffsetX = e.clientX - backupDragStartX;
        backupDragOffsetY = e.clientY - backupDragStartY;
        applyBackupDragTransform();
    });

    document.addEventListener('mouseup', () => {
        if (!backupIsDragging) return;
        backupIsDragging = false;
        document.body.style.userSelect = '';
    });
}

/** Инициализация UI перетаскивания (вызывается при старте). */
export function initBackupApplyUI(): void {
    setupBackupDragging();
}

/**
 * Очищает имя файла от недопустимых символов для File System Access API (Windows).
 * Заменяет всё, кроме букв, цифр, точек, дефисов и подчеркиваний, на '_'.
 */
function sanitizeFileNameStrict(name: string): string {
    return name.replace(/[^a-zA-Z0-9\u0400-\u04FF._-]/g, '_');
}

/**
 * «Применить»: создаёт новый INI-файл для подключённого контроллера
 * на основе выбранного шаблона.
 */
export async function handleBackupApply(ctx: BackupApplyContext): Promise<void> {
    // Убедимся, что перетаскивание инициализировано
    setupBackupDragging();

    console.log('[backup] Apply: selectedTemplateId =', ctx.selectedTemplateId);
    if (!ctx.selectedTemplateId) {
        showIdModal('Выберите строку-шаблон в таблице.');
        return;
    }
    const templateDev = getAllDevices().find((d) => d.id === ctx.selectedTemplateId);
    if (!templateDev) {
        showIdModal('Шаблон не найден в реестре устройств.');
        return;
    }
    const dev = templateDev.iniConfig.device;
    const devId = dev ? dev.id : '';

    const store = getFileStore();
    let entry = store.get(`${dev?.location ?? ''}::${devId}`);
    if (!entry?.content) entry = findStoreEntryByDeviceId(devId);
    if (!entry || !entry.content) {
        showIdModal('Файл шаблона не найден в хранилище.');
        return;
    }

    let templateContent = entry.content;
    if (entry.path) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const raw = await invoke<Uint8Array | number[]>('read_ini_file', { path: entry.path });
            const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
            templateContent = decodeTextBuffer(bytes.buffer as ArrayBuffer);
            console.log(
                `[backup] Шаблон прочитан с диска: ${templateContent.length} символов, ` +
                `${templateContent.split(/\r?\n/).length} строк`,
            );
        } catch (err) {
            console.warn(
                '[backup] Не удалось прочитать полный шаблон с диска — используем кэш из fileStore:',
                err,
            );
        }
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

    const callerMech = (document.getElementById(ctx.currentSource.mechInputId) as HTMLInputElement | null)?.value.trim() ?? '';
    const callerLoc = (document.getElementById(ctx.currentSource.locInputId) as HTMLInputElement | null)?.value.trim() ?? '';

    const content = buildBackupContent(templateContent, bannerId, useLocation, useMech, callerLoc, callerMech);
    const newIdValue = bannerId;

    let oldPath: string | undefined;
    for (const e of Array.from(store.values())) {
        if (!e.path) continue;
        const eParsed = parseDeviceIdString(e.id);
        if (eParsed.serial !== newSerial) continue;
        if (eParsed.deviceType !== connectedType) continue;
        oldPath = e.path;
        break;
    }

    let fileName = `${newSerial}.ini`;
    if (oldPath) {
        const oldName = oldPath.split('/').pop()?.split('\\').pop();
        if (oldName) fileName = oldName;
    }
    fileName = fileName.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    fileName = sanitizeFileNameStrict(fileName);

    const bytes = encodeToWindows1251(content);
    const file = new File([bytes], fileName, { type: 'text/plain' });
    console.log(`[backup] Имя файла: "${fileName}", oldPath=${oldPath ?? '—'}`);

    const { invoke } = await import('@tauri-apps/api/core');
    const { ask } = await import('@tauri-apps/plugin-dialog');

    if (oldPath) {
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

        if (ctx.loadFn) {
            await ctx.loadFn(content, fileName, file, undefined, oldPath);
            ctx.selectDeviceInTree(newIdValue);
        } else {
            console.warn('[backup] Связка с конвейером загрузки не установлена.');
        }

        ctx.hideWindow();
        document.getElementById(ctx.currentSource.callerOverlayId)?.classList.add('hidden');
        return;
    }

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

    if (ctx.loadFn) {
        await ctx.loadFn(content, fileName, file, undefined, fullPath);
        ctx.selectDeviceInTree(newIdValue);
    } else {
        console.warn('[backup] Связка с конвейером загрузки не установлена.');
    }

    ctx.hideWindow();
    document.getElementById(ctx.currentSource.callerOverlayId)?.classList.add('hidden');
}

/** Достаёт Location= из готового текста INI (в секции [DEVICE]). */
function extractLocation(content: string): string {
    const m = content.match(/^\s*Location\s*=\s*(.+)$/m);
    return m ? (m[1] ?? '').trim() : '';
}

/**
 * Определяет имя подпапки внутри Devices для нового файла.
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
 * Сборка контента резерва.
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

    const locationFromTemplate = useLocation;
    const descFromTemplate = useMech;

    const flushMissing = (): void => {
        if (!idDone) out.push(`ID=${newIdText}`);
        if (!locDone) {
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
                    out.push(line);
                } else {
                    out.push(`Location=${callerLocation}`);
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