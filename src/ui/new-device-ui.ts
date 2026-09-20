// src/ui/new-device-ui.ts
/**
 * Окно "Новое устройство": появляется, когда для подключённого
 * контроллера не найден родной INI-файл среди загруженных.
 *
 * Сейчас: показ окна + заполнение верхней части из строки ID.
 * Поведение кнопок (резерв, добавление в базу, шаблоны) — следующие шаги.
 */
import { parseDeviceIdString } from '../core/report-data.js';
import { changeDbFolder } from '../ini-manager/db-folder.js';
import { showBackupWindow } from './backup-ui.js';
// Логика «Добавить в базу» вынесена в отдельный модуль (см. src/ui/new-device-add.ts).
// Здесь от неё нужна только точка входа — обработчик кнопки в окне.
import { handleAddToBase } from './new-device-add.js';

/** Выбранные шаблоны: имя → File */
const templateFiles = new Map<string, File>();

/**
 * Функция-связка с конвейером загрузки (вставляет uiManager — у него есть appState).
 * Пятый параметр `path` нужен в нативном режиме (Tauri):
 * там нет FileSystemFileHandle, но есть абсолютный путь к файлу на диске,
 * по которому потом сохраняются изменения (см. save-ini.ts и currentIniPath).
 */
type AddToLoadedFn = (
    content: string,
    fileName: string,
    file: File,
    handle?: FileSystemFileHandle,
    path?: string,
) => Promise<void>;
let addToLoadedFn: AddToLoadedFn | null = null;

export function setNewDeviceAddToLoaded(fn: AddToLoadedFn): void {
    addToLoadedFn = fn;
}

/**
 * Возвращает установленную связку с конвейером загрузки.
 * Нужна модулю new-device-add.ts — там живёт логика «Добавить в базу»,
 * которая тоже пушит результат в общий конвейер через addToLoadedFn.
 */
export function getAddToLoadedFn(): AddToLoadedFn | null {
    return addToLoadedFn;
}

export function getTemplateFile(name: string): File | null {
    return templateFiles.get(name) ?? null;
}

export function initNewDeviceUI(): void {
    document.getElementById('newDeviceCloseBtn')?.addEventListener('click', () => {
        hideNewDeviceModal();
    });

    document.getElementById('newDeviceCancelBtn')?.addEventListener('click', () => {
        hideNewDeviceModal();
    });

           // "Создать резерв для блока": открывает окно выбора устройства-шаблона.
    document.getElementById('newDeviceBackupBtn')?.addEventListener('click', () => {
        showBackupWindow();
    });

    // "Сменить папку базы…": принудительно выбрать и запомнить новую папку.
    // Ближайшее нажатие "Добавить устройство в базу" запишет уже в неё.
    document.getElementById('newDeviceChangeFolderBtn')?.addEventListener('click', () => {
        void (async () => {
            const handle = await changeDbFolder();
            setNewDeviceStatus(handle ? 'Папка базы изменена.' : 'Папка не изменена (выбор отменён).');
        })();
    });
    // "Сменить папку базы…": принудительно выбрать и запомнить новую папку.
    // Ближайшее нажатие "Добавить устройство в базу" запишет уже в неё.
    document.getElementById('newDeviceChangeFolderBtn')?.addEventListener('click', () => {
        void (async () => {
            const handle = await changeDbFolder();
            setNewDeviceStatus(handle ? 'Папка базы изменена.' : 'Папка не изменена (выбор отменён).');
        })();
    });
    document.getElementById('newDeviceAddBtn')?.addEventListener('click', () => {
        void handleAddToBase();
    });

    // "Добавить шаблон": стандартный диалог множественного выбора файлов.
    // Шаблоны — ини-файлы без расширения, поэтому у templatePicker нет accept:
    // пользователь сам заходит в папку Template и выбирает нужное.
    document.getElementById('newDeviceAddTemplateBtn')?.addEventListener('click', () => {
        document.getElementById('templatePicker')?.click();
    });

    const templatePicker = document.getElementById('templatePicker') as HTMLInputElement | null;
    templatePicker?.addEventListener('change', () => {
        const files = Array.from(templatePicker.files ?? []);
        if (files.length === 0) return;
        const select = document.getElementById('newDeviceTemplateSelect') as HTMLSelectElement | null;
        if (!select) return;

        for (const file of files) {
            templateFiles.set(file.name, file);
            // Дубликаты в список не добавляем (повторный выбор обновляет File)
            const exists = Array.from(select.options).some((opt) => opt.value === file.name);
            if (!exists) {
                const option = document.createElement('option');
                option.value = file.name;
                option.textContent = file.name;
                select.appendChild(option);
            }
        }

        console.log(`[new-device] Добавлены шаблоны: ${files.map((f) => f.name).join(', ')}`);
        refreshTemplateSelects();
        // Сбрасываем, чтобы повторный выбор того же набора тоже сработал
        templatePicker.value = '';
    });
}

/** Синхронизирует списки шаблонов во всех окнах (новое устройство + обновление ПО). */
export function refreshTemplateSelects(): void {
    const selectIds = ['newDeviceTemplateSelect', 'fwUpdateTemplateSelect'];
    for (const id of selectIds) {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (!select) continue;
        const current = select.value;
        select.innerHTML = '';
        for (const name of templateFiles.keys()) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        if (current && templateFiles.has(current)) select.value = current;
    }
}

/**
 * Показывает окно и заполняет верхнюю часть из строки ID,
 * например: "00048484 DExS.SMFCB v1.10.6.1 18.07.2022 www.intmash.ru".
 */
export function showNewDeviceModal(idText: string): void {
    const overlay = document.getElementById('newDeviceOverlay');
    if (!overlay) return;

    const idInput = document.getElementById('newDeviceIdInput') as HTMLInputElement | null;
    const typeInput = document.getElementById('newDeviceTypeInput') as HTMLInputElement | null;
    const verDevice = document.getElementById('newDeviceVerDevice');
    const verFw = document.getElementById('newDeviceVerFw');
    const fwDate = document.getElementById('newDeviceFwDate');

    const parsed = parseDeviceIdString(idText);
    if (idInput) idInput.value = idText;
    if (typeInput) typeInput.value = parsed.deviceType;

    // Версия вида "1.10.6.1": версия устройства — первые три компоненты,
    // версия прошивки — последняя (как в старом аджастере).
    const verParts = parsed.version.split('.');
    if (verDevice) verDevice.textContent = verParts.length >= 4 ? verParts.slice(0, 3).join('.') : parsed.version;
    if (verFw) verFw.textContent = verParts.length >= 4 ? verParts[verParts.length - 1] : '—';

    // Дата прошивки — четвёртый токен строки ID.
    const tokens = idText.trim().split(/\s+/);
    if (fwDate) fwDate.textContent = tokens[3] ?? '—';

    overlay.classList.remove('hidden');
}

/** Скрывает окно "Новое устройство". Экспортирована для new-device-add.ts. */
export function hideNewDeviceModal(): void {
    document.getElementById('newDeviceOverlay')?.classList.add('hidden');
}



/**
 * Строка-статус внизу окна (для сообщений без модальных окон).
 * Экспортирована для new-device-add.ts.
 */
export function setNewDeviceStatus(text: string): void {
    const note = document.querySelector('.new-device-note');
    if (note) note.textContent = text;
}