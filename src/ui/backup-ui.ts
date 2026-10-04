// src/ui/backup-ui.ts
/**
 * Окно "Создать резерв для устройства...": создание записи в базе с
 * параметрами, идентичными существующему устройству (шаблону).
 *
 * Сейчас: показ окна, заполнение данных, выбор строки-шаблона.
 * Алгоритм "Применить" — вынесен в backup-apply.ts.
 */
import { parseDeviceIdString } from '../core/report-data.js';
import { getAllDevices } from '../ini-manager/tree-core.js';
import { getFileStore } from '../ini-manager/file-loader.js';
import { handleBackupApply, type BackupLoadFn } from './backup-apply.js';

/** Идентификатор устройства, выбранного шаблоном. */
let selectedTemplateId: string | null = null;

export function getBackupTemplateId(): string | null {
    return selectedTemplateId;
}

/**
 * Связка с конвейером загрузки (вставляет uiManager, у него есть appState).
 * Тип BackupLoadFn объявлен в backup-apply.ts — там он и используется.
 */
let loadFn: BackupLoadFn | null = null;

export function setBackupLoadFn(fn: BackupLoadFn): void {
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
        void handleBackupApply({
            selectedTemplateId,
            currentSource,
            loadFn,
            hideWindow: hideBackupWindow,
            selectDeviceInTree: selectBackupDeviceInTree,
        });
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

/** Выделяет в дереве узел созданного резерва. */
function selectBackupDeviceInTree(newIdValue: string): void {
    const found = getAllDevices().find((d) => (d.iniConfig.device ? d.iniConfig.device.id : '') === newIdValue);
    if (!found) return;
    document.querySelectorAll('.tree-id-item.is-selected').forEach((el) => el.classList.remove('is-selected'));
    const leaf = document.querySelector(`.tree-id-item.is-leaf[data-device-id="${CSS.escape(found.id)}"]`);
    if (leaf) leaf.classList.add('is-selected');
}