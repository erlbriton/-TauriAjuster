// src/ui/fw-update-modal.ts
// Модальное окно "Обновление программы устройства": показывается, когда
// ID устройства совпал (ID=...), но остальная часть ID-строки отличается
// от записанной в INI (другая версия/модель ПО).
// Действия кнопок подключаются следующим шагом — сейчас заглушки.

import { showBackupWindow } from './backup-ui.js';
import { refreshTemplateSelects, handleAddTemplate } from './new-device-ui.js';
import { handleAddToBaseGeneric } from './new-device-add.js';

/** Текущая информация об устройстве с другой версией ПО */
let currentInfo: FwUpdateInfo | null = null;

export interface FwUpdateInfo {
    /** Полная ID-строка, прочитанная из контроллера */
    idLine: string;
    /** Тип устройства (например DExS.PWR) */
    deviceType: string;
    /** Версия устройства */
    deviceVersion: string;
    /** Версия прошивки */
    firmwareVersion: string;
    /** Дата прошивки */
    firmwareDate: string;
    /** Имя файла старого устройства (с другой версией ПО), которое нужно заменить */
    oldFileName?: string;
}

export function initFwUpdateModal(): void {
    const overlay = document.getElementById('fwUpdateOverlay');
    if (!overlay) return;

    const hide = (): void => overlay.classList.add('hidden');

    document.getElementById('fwUpdateCloseBtn')?.addEventListener('click', hide);
    document.getElementById('fwUpdateCancelBtn')?.addEventListener('click', hide);
    overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) hide();
    });
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!overlay.classList.contains('hidden') && e.key === 'Escape') hide();
    });

       // "Создать резервную копию устройства" — открываем окно резерва,
    // берём Механизм/Расположение из полей этого окна, и при применении
    // закрываем именно это окно (а не "Новое устройство").
    document.getElementById('fwUpdateCreateCopyBtn')?.addEventListener('click', () => {
        showBackupWindow({
            mechInputId: 'fwUpdateMech',
            locInputId: 'fwUpdateLocation',
            callerOverlayId: 'fwUpdateOverlay',
        });
    });

    // "Добавить шаблон" — та же логика, что в окне "Новое устройство":
    // проверяем/создаём папку TemplateDevice, открываем системный диалог
    // выбора файла, копируем выбранный шаблон в папку, обновляем списки.
    document.getElementById('fwUpdateAddTemplateBtn')?.addEventListener('click', () => {
        void handleAddTemplate();
    });

    // "Добавить устройство в базу" — тот же конвейер, что у "Нового устройства",
    // но с переносом старого файла в BackUp и записью нового под тем же именем
    document.getElementById('fwUpdateAddDeviceBtn')?.addEventListener('click', () => {
        const idInput = document.getElementById('fwUpdateId') as HTMLInputElement | null;
        console.log(`[FW-UPDATE] Клик "Добавить устройство в базу": currentInfo=`, currentInfo);
        console.log(`[FW-UPDATE] oldFileName в момент клика: ${currentInfo?.oldFileName ?? '—'}`);
        void handleAddToBaseGeneric({
            templateSelectId: 'fwUpdateTemplateSelect',
            mechInputId: 'fwUpdateMech',
            locInputId: 'fwUpdateLocation',
            idText: (idInput?.value ?? '').trim(),
            setStatus: setFwUpdateStatus,
            onDone: hideFwUpdateModal,
            moveExistingToBackup: true,
            oldFileName: currentInfo?.oldFileName,
        });
    });

    console.log('[FW-UPDATE] Модальное окно "Обновление программы устройства" инициализировано.');
}

/** Заполняет поля и показывает окно */
export function showFwUpdateModal(info: FwUpdateInfo): void {
    const overlay = document.getElementById('fwUpdateOverlay');
    if (!overlay) return;

    currentInfo = info;
    console.log('[FW-UPDATE] Показываем окно с данными:', info);

    const set = (id: string, value: string): void => {
        const el = document.getElementById(id);
        if (el) (el as HTMLInputElement).value = value;
    };
    const setText = (id: string, value: string): void => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    // ID-строка: используем полную строку или собираем из частей
    const idLine = info.idLine || `${info.deviceType} v${info.deviceVersion} ${info.firmwareVersion} ${info.firmwareDate}`;
    set('fwUpdateId', idLine);
    set('fwUpdateType', info.deviceType);
    setText('fwUpdateDevVersion', info.deviceVersion);
    setText('fwUpdateFwVersion', info.firmwareVersion);
    setText('fwUpdateFwDate', info.firmwareDate);

    // Заполняем <select> шаблонов из папки TemplateDevice.
    // Функция асинхронная (сканирует папку через Rust), но окно можно
    // показывать сразу — список дозаполнится за миллисекунды.
    // void — явно показываем, что результат намеренно не ждём.
    void refreshTemplateSelects();

    overlay.classList.remove('hidden');
}

export function hideFwUpdateModal(): void {
    document.getElementById('fwUpdateOverlay')?.classList.add('hidden');
}

/** Строка-статус внизу окна (для сообщений без модальных окон). */
function setFwUpdateStatus(text: string): void {
    const note = document.querySelector('.fw-note');
    if (note) note.textContent = text;
}