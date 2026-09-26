// src/serial/modbus-functions.ts
// Modbus-функции и декодеры значений регистров.
// Чистые примитивы без DOM — работают через serialManager.
//   - decode32BitValue / decode16BitValue — разбор значений по типу данных;
//   - writeRegistersFC16 — запись регистров (FC 0x10);
//   - readHoldingRegistersFC03 — чтение регистров (FC 0x03).

import { serialManager } from './serial-manager.js';
import { calculateCRC } from './modbus-crc.js';
import { IniDataType, type IniParameter } from '../core/ini/index.js';

/**
 * Декодирует 32-битное значение из двух 16-битных слов Modbus.
 * Учитывает тип данных (Float, Long, Int32, DWord).
 */
export function decode32BitValue(high: number, low: number, dataType: IniDataType): number {
    switch (dataType) {
        case IniDataType.TFLOAT:
        case IniDataType.TFLOAT32: {
            const buf = new ArrayBuffer(4);
            const dv = new DataView(buf);
            dv.setUint16(0, high, false);
            dv.setUint16(2, low, false);
            return dv.getFloat32(0, false);
        }
        case IniDataType.TLONG:
        case IniDataType.TINT32:
            return ((high << 16) | low) | 0;
        case IniDataType.TDWORD:
            return ((high << 16) | low) >>> 0;
        default:
            return ((high << 16) | low) >>> 0;
    }
}

/**
 * Декодирует 16-битное значение с учётом типа (знак, бит).
 */
export function decode16BitValue(word: number, param: IniParameter): number {
    if (param.isBit && param.bitIndex !== null) {
        return (word >> param.bitIndex) & 0x01;
    }
    // Знаковое преобразование для целых типов
    if (param.dataType === IniDataType.TSHORT || param.dataType === IniDataType.TINT16 ||
        param.dataType === IniDataType.TINTEGER) {
        return word & 0x8000 ? word - 0x10000 : word;
    }
    return word;
}

/**
 * Запись регистров по Modbus FC 0x10 (Write Multiple Registers).
 * Чистый serial-примитив, без DOM — переносим в нативные проекты.
 * Используется всегда, даже для одного регистра (по требованию протокола устройства).
 */
export async function writeRegistersFC16(
    slaveAddr: number,
    startReg: number,
    words: number[],
): Promise<boolean> {
    const qty = words.length;
    if (qty < 1) return false;

    const byteCount = qty * 2;
    const body = new Uint8Array(7 + byteCount);
    body[0] = slaveAddr & 0xff;
    body[1] = 0x10;
    body[2] = (startReg >> 8) & 0xff;
    body[3] = startReg & 0xff;
    body[4] = (qty >> 8) & 0xff;
    body[5] = qty & 0xff;
    body[6] = byteCount;
    for (let i = 0; i < qty; i++) {
        body[7 + i * 2] = (words[i] >> 8) & 0xff;
        body[7 + i * 2 + 1] = words[i] & 0xff;
    }

    const crc = calculateCRC(body);
    const packet = new Uint8Array(body.length + 2);
    packet.set(body, 0);
    packet[body.length] = crc & 0xff;
    packet[body.length + 1] = (crc >> 8) & 0xff;

    const checkComplete = (buf: Uint8Array): boolean => {
        // Нормальный ответ FC16: 8 байт (адрес, fcode, адрес регистра, количество)
        if (buf.length >= 3 && buf[1] === 0x10) return buf.length >= 8;
        // Исключение: 5 байт
        if (buf.length >= 5 && (buf[1] & 0x80)) return true;
        return false;
    };

    try {
        const reply = await serialManager.executeTransaction(packet, checkComplete, 300);
        if (!reply) return false;

        if (reply.length >= 8 && reply[1] === 0x10) {
            const echoStart = (reply[2] << 8) | reply[3];
            const echoQty = (reply[4] << 8) | reply[5];
            return echoStart === startReg && echoQty === qty;
        }

        if (reply.length >= 5 && (reply[1] & 0x80)) {
            console.error(`[MODBUS FC16] Исключение от устройства, код: 0x${reply[2].toString(16)}`);
            return false;
        }
        console.warn(`[MODBUS FC16] Нераспознанный ответ: len=${reply.length}, байты=${Array.from(reply).map((b) => b.toString(16).padStart(2, '0')).join(' ')} (ожидается: адрес + 0x10 + эхо)`);
        return false;
    } catch (err) {
        console.error('[MODBUS FC16] Ошибка транзакции:', err);
        return false;
    }
}

/**
 * Чтение регистров по Modbus FC 0x03 (Read Holding Registers).
 * Чистый serial-примитив, без DOM — переносим в нативные проекты.
 * Возвращает массив прочитанных слов или null при ошибке/таймауте.
 */
export async function readHoldingRegistersFC03(
    slaveAddr: number,
    startReg: number,
    count: number,
): Promise<number[] | null> {
    if (count < 1 || count > 125) return null;

    const body = new Uint8Array([
        slaveAddr & 0xff,
        0x03,
        (startReg >> 8) & 0xff,
        startReg & 0xff,
        (count >> 8) & 0xff,
        count & 0xff,
    ]);

    const crc = calculateCRC(body);
    const packet = new Uint8Array(8);
    packet.set(body, 0);
    packet[6] = crc & 0xff;
    packet[7] = (crc >> 8) & 0xff;

    const checkComplete = (buf: Uint8Array): boolean => {
        if (buf.length >= 3 && buf[1] === 0x03) {
            const byteCount = buf[2];
            return buf.length >= 3 + byteCount + 2;
        }
        if (buf.length >= 5 && (buf[1] & 0x80)) return true;
        return false;
    };

    try {
        const reply = await serialManager.executeTransaction(packet, checkComplete, 300);
        if (!reply) return null;

        if (reply.length >= 3 && reply[1] === 0x03) {
            const byteCount = reply[2];
            if (byteCount !== count * 2) return null;
            if (reply.length < 3 + byteCount + 2) return null;

            const words: number[] = [];
            for (let i = 0; i < count; i++) {
                const hi = reply[3 + i * 2];
                const lo = reply[4 + i * 2];
                words.push(((hi & 0xff) << 8) | (lo & 0xff));
            }
            return words;
        }

        if (reply.length >= 5 && (reply[1] & 0x80)) {
            console.error(`[MODBUS FC03] Исключение от устройства, код: 0x${reply[2].toString(16)}`);
            return null;
        }
        return null;
    } catch (err) {
        console.error('[MODBUS FC03] Ошибка транзакции:', err);
        return null;
    }
}