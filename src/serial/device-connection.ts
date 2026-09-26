// src/serial/device-connection.ts
// Команды подключения к устройству и идентификации (запрос ID).
// Работают через serialManager — единый читатель порта (см. serial-manager.ts).

import { identifyUsbChip } from './usb.js';
import { showIdModal, updateIdBanner, closeIdModal } from '../ui/ui.js';
import { serialManager } from './serial-manager.js';
import type { CheckCompleteFn } from './serial-manager.js';
import type { ISerialPort } from './ISerialPort.js';
import type { AppState } from '../core/app-state.js';

export function updateComInterfaceName(serial: ISerialPort, comSelect: HTMLSelectElement | null): string {
    if (!comSelect) return "";
    // Через интерфейс: работает и для WebSerial, и для Tauri-адаптера.
    const portInfo = serial.getPortInfo();
    const chipName = identifyUsbChip(portInfo);
    
    // ВАЖНО: НЕ уничтожаем список портов (не трогаем comSelect.innerHTML).
    // В нативной версии Tauri список портов должен оставаться доступным
    // для повторного выбора другого устройства без перезагрузки приложения.
    // Имя порта уже отображается в самом <select> как выбранное значение
    // (например, "/dev/ttyUSB0" или "COM3"), поэтому дополнительная подпись не нужна.
    
    // Меняем только визуальный стиль, чтобы показать, что порт подключён
    comSelect.className = 'select-blue';
    
    return chipName;
}

/**
 * Открывает последовательный порт без запроса ID устройства.
 * Используется при выборе порта из выпадающего списка:
 * порт открывается, инициализируется обмен, но запрос ID не посылается.
 * Для запроса ID пользователь нажимает кнопку "ID" отдельно.
 */
export async function executeDeviceConnection(
    serial: ISerialPort,
    comSelect: HTMLSelectElement | null,
    baudSelect: HTMLSelectElement | null = null
): Promise<void> {
    try {
        const baudRate = baudSelect ? parseInt(baudSelect.value, 10) || 115200 : 115200;
        
        // Если порт уже открыт — не открываем повторно
        if (!serial.isConnected) {
            await serial.connect(baudRate);
            serialManager.init(serial);
            updateComInterfaceName(serial, comSelect);
            await new Promise((r) => setTimeout(r, 500));
        }
    } catch (error: unknown) {
        // Пользователь закрыл окно выбора порта, не выбрав порт —
        // штатная ситуация: молча выходим, без окна ошибки.
        if (error instanceof Error && error.name === 'PortCancelledError') {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        showIdModal("Ошибка: " + message);
    }
}

export async function executeDeviceIdentification(serial: ISerialPort, comSelect: HTMLSelectElement | null, stateObj: AppState, baudSelect: HTMLSelectElement | null = null): Promise<void> {
    try {
        stateObj.isIdentifying = true;
        const baudRate = baudSelect ? parseInt(baudSelect.value, 10) || 115200 : 115200;
        // Если порт уже открыт (кнопкой "Подключить" или предыдущим
        // нажатием ID) — не открываем повторно: Web Serial бросает ошибку
        // повторного open() и снова показывает выбор порта. В этом случае
        // просто повторно читаем ID устройства.
        if (!serial.isConnected) {
            await serial.connect(baudRate);
            serialManager.init(serial);
            updateComInterfaceName(serial, comSelect);
            await new Promise((r) => setTimeout(r, 500));
        }
        showIdModal("Запрос ID устройства...");
        const packet = new Uint8Array([stateObj.slaveAddress & 0xFF, 0x11, 0xC0, 0x2C]);
        const checkComplete: CheckCompleteFn = (buf: Uint8Array) => {
            if (buf.length >= 3) {
                const dataLength = buf[2];
                return buf.length >= 3 + dataLength + 2 || buf.length >= 52;
            }
            return false;
        };
        const reply = await serialManager.executeTransaction(packet, checkComplete, 1500);
        if (reply && reply.length >= 3) {
            const dataLength = reply[2];
            let idText = "";
            for (let i = 3; i < Math.min(3 + dataLength, reply.length - 2); i++) {
                if (reply[i] >= 32) idText += String.fromCharCode(reply[i]);
            }
            updateIdBanner(idText.trim());
            closeIdModal();
        } else {
            showIdModal("Ошибка: Нет ответа от устройства");
        }
    } catch (error: unknown) {
        // Пользователь закрыл окно выбора порта, не выбрав порт —
        // штатная ситуация: молча выходим, без окна ошибки.
        if (error instanceof Error && error.name === 'PortCancelledError') {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        showIdModal("Ошибка: " + message);
    } finally {
        stateObj.isIdentifying = false;
    }
}