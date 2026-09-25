// src/ui/new-device-ui.ts
/**
 * Окно "Новое устройство": появляется, когда для подключённого
 * контроллера не найден родной INI-файл среди загруженных.
 *
 * Сейчас: показ окна + заполнение верхней части из строки ID.
 * Поведение кнопок (резерв, добавление в базу, шаблоны) — следующие шаги.
 */
import { parseDeviceIdString } from '../core/report-data.js';
import { showBackupWindow } from './backup-ui.js';
// Логика «Добавить в базу» вынесена в отдельный модуль (см. src/ui/new-device-add.ts).
// Здесь от неё нужна только точка входа — обработчик кнопки в окне.
import { handleAddToBase } from './new-device-add.js';

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

/**
 * Читает файл шаблона из папки TemplateDevice (рядом с exe) и возвращает File.
 *
 * Заменяет прежний getTemplateFile, который брал File из Map<string, File>
 * в памяти. Теперь источник правды — сама папка TemplateDevice:
 * содержимое читается с диска в момент вызова.
 *
 * Возвращает null, если папка TemplateDevice не существует, файла в ней нет
 * или при чтении произошла ошибка. Вызывающий код должен обработать null
 * как «шаблон не найден».
 */
export async function readTemplateFile(name: string): Promise<File | null> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Путь к папке TemplateDevice — если её нет, getTemplateFile вернёт null.
        const templateDir = await invoke<string>('ensure_template_dir', { create: false });
        const fullPath = `${templateDir}/${name}`;

        // read_ini_file возвращает Vec<u8> — Tauri отдаёт его как Uint8Array
        // либо как массив чисел. Обрабатываем оба варианта.
        const raw = await invoke<Uint8Array | number[]>('read_ini_file', { path: fullPath });
        const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);

        // Явная копия в новый Uint8Array<ArrayBuffer>: TS 5.7+ требует,
        // чтобы BlobPart был ArrayBuffer, а не ArrayBufferLike (в котором
        // потенциально может быть SharedArrayBuffer). Такая же копия
        // уже делается в tauri-autoloader.ts.
        const safe = new Uint8Array(bytes);

        return new File([safe], name, { type: 'text/plain' });
    } catch (err) {
        console.warn(`[templates] Не удалось прочитать шаблон "${name}":`, err);
        return null;
    }
}

/**
 * Обработчик кнопки "Добавить шаблон".
 *
 * Алгоритм:
 *  1. Проверяет, существует ли папка TemplateDevice.
 *     Если нет — предлагает создать через диалог ask(). При согласии
 *     создаёт пустую папку и просит пользователя положить в неё файлы.
 *  2. Открывает системный диалог выбора файла(ов).
 *  3. Для каждого выбранного файла вызывает Rust-команду copy_template_file.
 *     - Если файл уже внутри TemplateDevice — Rust ничего не копирует.
 *     - Если файл с таким именем уже есть в TemplateDevice — Rust возвращает
 *       ошибку TEMPLATE_FILE_EXISTS, и мы спрашиваем "Перезаписать?".
 *  4. Обновляет оба <select> (в окне "Новое устройство" и в окне
 *     "Обновление программы устройства") через refreshTemplateSelects.
 */
export async function handleAddTemplate(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const { open, ask } = await import('@tauri-apps/plugin-dialog');

    // 1. Проверяем наличие папки TemplateDevice.
    try {
        await invoke<string>('ensure_template_dir', { create: false });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('TEMPLATE_DIR_NOT_FOUND')) {
            const shouldCreate = await ask(
                'Папка TemplateDevice не найдена рядом с приложением.\n\nСоздать её?',
                { title: 'Папка TemplateDevice', kind: 'info' },
            );
            if (!shouldCreate) {
                console.log('[templates] Пользователь отказался создавать TemplateDevice');
                return;
            }
            try {
                await invoke<string>('ensure_template_dir', { create: true });
                setNewDeviceStatus(
                    'Папка TemplateDevice создана. Положите в неё файлы шаблонов и нажмите "Добавить шаблон" ещё раз.',
                );
            } catch (err2) {
                const msg2 = err2 instanceof Error ? err2.message : String(err2);
                setNewDeviceStatus(`Не удалось создать TemplateDevice: ${msg2}`);
            }
            return;
        }
        setNewDeviceStatus(`Ошибка при проверке TemplateDevice: ${msg}`);
        return;
    }

    // 2. Открываем системный диалог выбора файла(ов).
    const selected = await open({
        multiple: true,
        title: 'Выберите файл(ы) шаблонов',
    });
    if (!selected) {
        console.log('[templates] Пользователь отменил выбор файла');
        return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];

    // 3. Копируем каждый выбранный файл в TemplateDevice.
    const copied: string[] = [];
    for (const path of paths) {
        if (typeof path !== 'string') continue;
        try {
            const name = await invoke<string>('copy_template_file', {
                srcPath: path,
                overwrite: false,
            });
            copied.push(name);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('TEMPLATE_FILE_EXISTS')) {
                const baseName = path.split('/').pop()?.split('\\').pop() ?? 'файл';
                const shouldOverwrite = await ask(
                    `Файл "${baseName}" уже есть в TemplateDevice.\n\nПерезаписать?`,
                    { title: 'TemplateDevice', kind: 'warning' },
                );
                if (!shouldOverwrite) continue;
                try {
                    const name = await invoke<string>('copy_template_file', {
                        srcPath: path,
                        overwrite: true,
                    });
                    copied.push(name);
                } catch (err2) {
                    const msg2 = err2 instanceof Error ? err2.message : String(err2);
                    console.error(`[templates] Ошибка перезаписи шаблона ${path}:`, msg2);
                }
            } else {
                console.error(`[templates] Ошибка копирования шаблона ${path}:`, msg);
            }
        }
    }

    // 4. Обновляем списки во всех окнах.
    await refreshTemplateSelects();

    // 5. Выделяем первый добавленный шаблон в <select> — чтобы пользователь
    //    сразу видел, что файл успешно добавлен.
    if (copied.length > 0) {
        const select = document.getElementById('newDeviceTemplateSelect') as HTMLSelectElement | null;
        if (select && copied[0]) select.value = copied[0];
        console.log(`[templates] Добавлено шаблонов: ${copied.length}`);
    }
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

    document.getElementById('newDeviceAddBtn')?.addEventListener('click', () => {
        void handleAddToBase();
    });

    // "Добавить шаблон": теперь это не клик по скрытому <input type="file">,
    // а работа через Tauri-диалог и папку TemplateDevice (см. handleAddTemplate).
    document.getElementById('newDeviceAddTemplateBtn')?.addEventListener('click', () => {
        void handleAddTemplate();
    });
}

/**
 * Синхронизирует списки шаблонов во всех окнах (новое устройство + обновление ПО).
 *
 * Стала асинхронной: список больше не берётся из Map<string, File>,
 * а читается с диска через Rust-команду scan_template_dir.
 * Сканируется только содержимое папки (имена файлов) — без чтения
 * самих шаблонов, поэтому даже большие списки обрабатываются мгновенно.
 */
export async function refreshTemplateSelects(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');

    let names: string[];
    try {
        names = await invoke<string[]>('scan_template_dir');
    } catch (err) {
        console.error('[templates] Ошибка сканирования папки TemplateDevice:', err);
        names = [];
    }

    const selectIds = ['newDeviceTemplateSelect', 'fwUpdateTemplateSelect'];
    for (const id of selectIds) {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (!select) continue;
        const current = select.value;
        select.innerHTML = '';
        for (const name of names) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        // Восстанавливаем выбор, если выбранный ранее шаблон всё ещё существует.
        if (current && names.includes(current)) select.value = current;
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

    // Заполняем <select> шаблонов из папки TemplateDevice.
    // Функция асинхронная (сканирует папку через Rust), но нам не нужно
    // ждать её завершения, чтобы показать окно: список дозаполнится
    // за миллисекунды, пока пользователь смотрит на форму.
    // void — явно показываем, что результат намеренно не ждём.
    void refreshTemplateSelects();

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