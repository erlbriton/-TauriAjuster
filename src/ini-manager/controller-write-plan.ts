// src/ini-manager/controller-write-plan.ts
// План записи значения в контроллер: проверка введённого значения
// и подготовка слов Modbus для записи.
//
// Чистая логика без DOM. Использует parseIpToRegisters/registersToIp
// из serial/ip-utils.ts и float32ToHex из ./hex-utils.ts.
//
// Файл выделен из tree-core.ts. Публичный API сохранён через реэкспорт
// из tree-core.ts, чтобы 3 внешних модуля (base-write, controller-write,
// copy-ops) продолжали импортировать planControllerWrite по старому пути.

import { parseIpToRegisters, registersToIp } from '../serial/ip-utils.js';
import { float32ToHex } from './hex-utils.js';

/**
 * План записи значения Контроллера.
 * Чистая логика без DOM — переносима в нативные проекты.
 */
export type ControllerWritePlan =
    | { ok: true; kind: 'words'; words: number[]; newHex: string; newPhys: string }
    | { ok: true; kind: 'bit'; bitIndex: number; bitValue: number; newPhys: string }
    | { ok: true; kind: 'byte'; byteValue: number; bytePos: 'L' | 'H'; newPhys: string }
    | { ok: false };

/** Белый список типов, разрешённых к редактированию в Контроллере */
const CONTROLLER_EDITABLE_TYPES: ReadonlySet<string> = new Set([
    'TWORD', 'TINT', 'TBIT',
    'TFLOAT', 'TFLOAT32', 'FLOAT',
    'TDWORD', 'TLONG', 'TINT32',
    'TINTEGER', // Знаковый 16-битный
    'TBYTE',    // 8-битный, байт внутри 16-битного слова
    'TPRMLIST', // 8-битный, байт из выпадающего списка
    'TIPADDR',  // 32-битный, IP-адрес (точечный формат или hex)
]);

/** 16-битные знаковые типы — используют диапазон -32768...32767 вместо 0...65535 */
const SIGNED_16BIT_TYPES: ReadonlySet<string> = new Set([
    'TINTEGER',
]);

/**
 * Проверяет введённое значение и строит план записи.
 * Не выполняет никаких операций с DOM или портом.
 * bytePosRaw — модификатор байта ('L'/'H') для TBYTE, извлекается вызывающим кодом.
 */
export function planControllerWrite(
    dataTypeRaw: string,
    editType: string,
    valueStr: string,
    scale: number,
    subRaw: string,
    bytePosRaw: string = '',
): ControllerWritePlan {
    const dataType = dataTypeRaw.toUpperCase();
    if (!CONTROLLER_EDITABLE_TYPES.has(dataType)) return { ok: false };

    const is32Bit = dataType.includes('FLOAT') || dataType.includes('DWORD') ||
        dataType.includes('LONG') || dataType.includes('INT32');
    const isFloat = dataType.includes('FLOAT');
    const isBit = dataType === 'TBIT';
    const isSigned16 = SIGNED_16BIT_TYPES.has(dataType);

    const safeScale = (!isNaN(scale) && scale !== 0) ? scale : 1.0;

    // --- TIPADDR: 32 бит, IP-адрес ---
    if (dataType === 'TIPADDR') {
        const registers = parseIpToRegisters(valueStr);
        if (!registers) return { ok: false };

        const [lowWord, highWord] = registers;
        const rawInt = ((highWord << 16) | lowWord) >>> 0;

        return {
            ok: true,
            kind: 'words',
            words: [lowWord, highWord], // Младшее слово первым (LE порядок регистров)
            newHex: 'x' + rawInt.toString(16).toUpperCase().padStart(8, '0'),
            newPhys: registersToIp(lowWord, highWord),
        };
    }

    // --- TBYTE / TPRMLIST: 8 бит, байт внутри 16-битного слова ---
    if (dataType === 'TBYTE' || dataType === 'TPRMLIST') {
        const bytePos = bytePosRaw.toUpperCase();
        if (bytePos !== 'L' && bytePos !== 'H') return { ok: false };

        if (editType === 'hex') {
            const cleanHex = valueStr.replace(/^(x|0x)/i, '');
            if (!/^[0-9A-Fa-f]+$/.test(cleanHex)) return { ok: false };
            if (cleanHex.length > 2) return { ok: false };
            const parsed = parseInt(cleanHex, 16);
            if (isNaN(parsed) || parsed > 255) return { ok: false };
            return {
                ok: true,
                kind: 'byte',
                byteValue: parsed,
                bytePos: bytePos as 'L' | 'H',
                newPhys: String(parsed * safeScale),
            };
        }

        const valNum = parseFloat(valueStr.replace(',', '.'));
        if (isNaN(valNum) || !isFinite(valNum)) return { ok: false };
        const raw = Math.round(valNum / safeScale);
        if (raw < 0 || raw > 255) return { ok: false };
        return {
            ok: true,
            kind: 'byte',
            byteValue: raw,
            bytePos: bytePos as 'L' | 'H',
            newPhys: String(valNum),
        };
    }

    // --- Ввод HEX ---
    if (editType === 'hex') {
        const cleanHex = valueStr.replace(/^(x|0x)/i, '');
        if (!/^[0-9A-Fa-f]+$/.test(cleanHex)) return { ok: false };
        // 16 бит — максимум 4 hex-цифры, 32 бита — максимум 8
        if (is32Bit ? cleanHex.length > 8 : cleanHex.length > 4) return { ok: false };

        const parsed = parseInt(cleanHex, 16);
        if (isNaN(parsed)) return { ok: false };

        if (isBit) {
            const bitIndex = parseInt(subRaw, 16);
            return {
                ok: true,
                kind: 'bit',
                bitIndex: isNaN(bitIndex) ? 0 : bitIndex,
                bitValue: parsed & 1,
                newPhys: String(parsed & 1),
            };
        }

        const newHex = 'x' + parsed.toString(16).toUpperCase().padStart(is32Bit ? 8 : 4, '0');
        let newPhys: string;
        if (isFloat) {
            const dv = new DataView(new ArrayBuffer(4));
            dv.setUint32(0, parsed >>> 0, false);
            newPhys = String(dv.getFloat32(0, false) * safeScale);
        } else if (is32Bit) {
            const signed = parsed > 0x7FFFFFFF ? parsed - 0x100000000 : parsed;
            newPhys = String(signed * safeScale);
        } else {
            const signed = parsed > 0x7FFF ? parsed - 0x10000 : parsed;
            newPhys = String(signed * safeScale);
        }

        const words = is32Bit
            ? [parsed & 0xFFFF, (parsed >>> 16) & 0xFFFF]
            : [parsed & 0xFFFF];

        return { ok: true, kind: 'words', words, newHex, newPhys };
    }

    // --- Ввод Physical ---
    const valNum = parseFloat(valueStr.replace(',', '.'));
    if (isNaN(valNum) || !isFinite(valNum)) return { ok: false };

    if (isBit) {
        const bitIndex = parseInt(subRaw, 16);
        const bitValue = valNum > 0 ? 1 : 0;
        return {
            ok: true,
            kind: 'bit',
            bitIndex: isNaN(bitIndex) ? 0 : bitIndex,
            bitValue,
            newPhys: String(bitValue),
        };
    }

    if (isFloat) {
        // float32ToHex возвращает строку с префиксом 'x' (например, "x47359000"),
        // поэтому перед parseInt префикс нужно снять, иначе получим NaN и [0x0, 0x0]
        const hexStrRaw = float32ToHex(valNum / safeScale);
        const hexStr = hexStrRaw.replace(/^x/i, '').toUpperCase();
        const rawInt = parseInt(hexStr, 16);
        if (isNaN(rawInt)) return { ok: false };

        return {
            ok: true,
            kind: 'words',
            words: [rawInt & 0xFFFF, (rawInt >>> 16) & 0xFFFF],
            newHex: 'x' + hexStr,
            newPhys: String(valNum),
        };
    }

    const raw = Math.round(valNum / safeScale);
    if (is32Bit) {
        if (raw < -2147483648 || raw > 4294967295) return { ok: false };
        const unsigned = raw < 0 ? raw + 0x100000000 : raw;
        return {
            ok: true,
            kind: 'words',
            words: [unsigned & 0xFFFF, (unsigned >>> 16) & 0xFFFF],
            newHex: 'x' + unsigned.toString(16).toUpperCase().padStart(8, '0'),
            newPhys: String(valNum),
        };
    }

    // 16 бит
    if (isSigned16) {
        // Знаковый диапазон: -32768...32767
        if (raw < -32768 || raw > 32767) return { ok: false };
        const word = (raw < 0 ? raw + 0x10000 : raw) & 0xFFFF;
        return {
            ok: true,
            kind: 'words',
            words: [word],
            newHex: 'x' + word.toString(16).toUpperCase().padStart(4, '0'),
            newPhys: String(valNum),
        };
    }
    // Unsigned 16-бит
    if (raw < 0 || raw > 65535) return { ok: false };
    const word = raw & 0xFFFF;
    return {
        ok: true,
        kind: 'words',
        words: [word],
        newHex: 'x' + word.toString(16).toUpperCase().padStart(4, '0'),
        newPhys: String(valNum),
    };
}