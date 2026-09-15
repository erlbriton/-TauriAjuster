// src/serial/usb.ts
import type { SerialPortInfo } from './ISerialPort.js';

/** Описание одного производителя USB-UART чипов */
interface UsbChipManufacturer {
    name: string;
    pids: Record<string, string>;
}

/** База данных USB чипов: VID → производитель */
type UsbChipsDatabase = Record<string, UsbChipManufacturer>;

const USB_CHIPS_DATABASE: UsbChipsDatabase = {
    '10c4': {
        name: 'Silicon Labs',
        pids: {
            'ea60': 'CP2103',
            'ea70': 'CP2105',
            'ea71': 'CP2108'
        }
    },
    '0403': {
        name: 'FTDI',
        pids: {
            '6001': 'FT232R',
            '6010': 'FT2232H',
            '6015': 'FT231X'
        }
    },
    '1a86': {
        name: 'Qinheng',
        pids: {
            '7523': 'CH340/CH341',
            '5523': 'CH341A'
        }
    },
    '067b': {
        name: 'Prolific',
        pids: {
            '2303': 'PL2303'
        }
    }
};

/**
 * Определяет название USB-UART чипа по VID/PID.
 * Принимает платформенно-независимый SerialPortInfo —
 * работает и с WebSerial, и с будущим Tauri-адаптером.
 */
export function identifyUsbChip(info: SerialPortInfo): string {
    if (!info || !info.usbVendorId) {
        return "Встроенный COM-порт";
    }

    const vidStr = info.usbVendorId.toString(16).padStart(4, '0').toLowerCase();
    const pidStr = info.usbProductId
        ? info.usbProductId.toString(16).padStart(4, '0').toLowerCase()
        : null;

    const manufacturer = USB_CHIPS_DATABASE[vidStr];
    if (manufacturer) {
        if (pidStr && manufacturer.pids[pidStr]) {
            return manufacturer.pids[pidStr];
        }
        return `${manufacturer.name} USB`;
    }

    return `USB [${vidStr.toUpperCase()}:${pidStr ? pidStr.toUpperCase() : '????'}]`;
}