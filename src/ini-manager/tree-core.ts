// src/ini-manager/tree-core.ts

import type { IniConfig } from '../core/ini/index.js';

/** Тип сырого INI-конфига (совместим с AppState.currentDeviceConfig) */
export type RawIniConfig = Record<string, Record<string, string | string[]>>;

/** Элемент реестра устройств */
export interface DeviceRegistryItem {
  id: string;
  displayText: string;
  iniConfig: IniConfig;
  /** Сырой конфиг для обратной совместимости со старым кодом */
  fullConfig: RawIniConfig;
  /** Флаг: это резервная копия (файл перенесён в BackUp) */
  isBackup?: boolean;
  /**
   * Имя файла в папке BackUp, к которому относится эта резервная копия.
   * Заполняется только у записей с isBackup === true. Нужно, чтобы при
   * синхронизации с диском (кнопка «Обновить список») удалять из дерева
   * те красные записи, чьих файлов в BackUp больше нет.
   *
   * У старых записей (созданных до появления этого поля) значение undefined —
   * при синхронизации они будут удалены, если в BackUp нет совпадения
   * по имени или если их не удастся сопоставить.
   */
  backupFileName?: string;
}

/** Реестр: локации → массив устройств */
export const deviceRegistry: Record<string, DeviceRegistryItem[]> = {};

// export let currentDeviceConfig: RawIniConfig | null = null;

// export function setCurrentDeviceConfig(config: RawIniConfig | null): void {
//   currentDeviceConfig = config;
// }

export let currentIniConfig: IniConfig | null = null;

export function setCurrentIniConfig(config: IniConfig | null): void {
  currentIniConfig = config;
}

// Вспомогательная функция для парсинга адресов
export function parseRegisterAddress(addrString: string): { reg: number | null; sub: string | null } {
  if (!addrString || addrString === '*') return { reg: null, sub: null };
  const cleanStr = addrString.toLowerCase().replace('r', '');
  const parts = cleanStr.split('.');
  let valStr = parts[0];
  let base = 16; // Default to hex
  if (valStr.startsWith('x')) {
    valStr = valStr.substring(1);
  } else if (valStr.startsWith('0x')) {
    valStr = valStr.substring(2);
  }
  return {
    reg: parseInt(valStr, base),
    sub: parts[1] ? parts[1].toUpperCase() : null
  };
}

// Вспомогательная функция для HEX -> Float32
export function hexToFloat32(hexStr: string): number {
  if (!hexStr) return NaN;
  const intVal = parseInt(hexStr, 16);
  if (isNaN(intVal)) return NaN;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, intVal, false);
  return view.getFloat32(0, false);
}

// Вспомогательная функция для Float32 -> HEX
export function float32ToHex(floatVal: number, padLen: number = 8): string {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, floatVal, false);
  const intVal = view.getUint32(0, false);
  return 'x' + intVal.toString(16).toUpperCase().padStart(padLen, '0');
}

export function getSectionRange(
  config: RawIniConfig | null,
  sectionName: string
): { start: number; count: number } {
  if (!config || !config[sectionName]) return { start: 0, count: 0 };
  const section = config[sectionName];
  let minReg = Infinity;
  let maxReg = -Infinity;
  Object.values(section).forEach((parts: string | string[]) => {
    if (Array.isArray(parts)) {
      const dataType = String(parts[2] || '').toUpperCase();
      const regAddrString = String(dataType === 'TBIT' ? (parts[5] ?? '') : (parts[4] ?? ''));
      const parsed = parseRegisterAddress(regAddrString);
      if (parsed.reg !== null && !isNaN(parsed.reg)) {
        minReg = Math.min(minReg, parsed.reg);
        const is32Bit = dataType.toUpperCase().includes('FLOAT') ||
          dataType.toUpperCase().includes('DWORD') ||
          dataType.toUpperCase().includes('LONG') ||
          dataType.toUpperCase().includes('INT32') ||
          dataType.toUpperCase() === 'TIPADDR';
        maxReg = Math.max(maxReg, parsed.reg + (is32Bit ? 1 : 0));
      }
    }
  });
  if (minReg === Infinity) return { start: 0, count: 0 };
  return { start: minReg, count: maxReg - minReg + 1 };
}

// Регистрация устройства
export function addDeviceToRegistry(iniConfig: IniConfig): boolean {
  if (!iniConfig || !iniConfig.device) return false;
  const dev = iniConfig.device;
  const location = dev.location || 'Неизвестное место';
  const id = dev.id || 'Без ID';
  const displayComponents = [id, dev.version, dev.date].filter(Boolean);
  const deviceDisplayText = displayComponents.join(' ');
  if (!deviceRegistry[location]) deviceRegistry[location] = [];
  const isDuplicate = deviceRegistry[location].some(item => item.id === id);
  if (!isDuplicate) {
    deviceRegistry[location].push({
      id,
      displayText: deviceDisplayText,
      iniConfig,
      fullConfig: iniConfig.parseResult.rawSections as RawIniConfig,
    });
    return true;
  }
  return false;
}
/**
 * Обновляет существующее устройство в реестре (на месте, без перестройки списка).
 * Используется при перечитывании изменённых INI-файлов с диска.
 */
export function updateDeviceInRegistry(
    location: string,
    id: string,
    iniConfig: IniConfig,
    fullConfig: RawIniConfig,
): boolean {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) return false;
    const idx = group.findIndex(item => item.id === id);
    if (idx === -1) return false;

    const dev = iniConfig.device;
    const displayComponents = [id, dev?.version, dev?.date].filter(Boolean);
    group[idx].iniConfig = iniConfig;
    group[idx].fullConfig = fullConfig;
    group[idx].displayText = displayComponents.join(' ');
    return true;
}
/**
 * Удаляет устройство из реестра по location и id.
 * Используется, когда INI-файл был удалён или перемещён на диске.
 */
export function removeDeviceFromRegistry(location: string, id: string): boolean {
    const group = deviceRegistry[location];
    if (!Array.isArray(group)) return false;
    const idx = group.findIndex(item => item.id === id);
    if (idx === -1) return false;
    group.splice(idx, 1);
    if (group.length === 0) {
        delete deviceRegistry[location];
    }
    return true;
}

/** Удаляет устройство из реестра по ссылке на его запись (для контекстного меню) */
export function removeDeviceItemFromRegistry(item: DeviceRegistryItem): boolean {
    for (const location in deviceRegistry) {
        const group = deviceRegistry[location];
        if (!Array.isArray(group)) continue;
        const idx = group.indexOf(item);
        if (idx !== -1) {
            group.splice(idx, 1);
            if (group.length === 0) {
                delete deviceRegistry[location];
            }
            return true;
        }
    }
    return false;
}

// ============================================================================
// Группировка левого дерева устройств
// ============================================================================

/** Режим группировки устройств в левом дереве */
export type TreeGroupMode = 'location' | 'serial' | 'mechType' | 'serviceDate' | 'deviceType';

let treeGroupMode: TreeGroupMode = 'location';

export function setTreeGroupMode(mode: TreeGroupMode): void {
    treeGroupMode = mode;
}

export function getTreeGroupMode(): TreeGroupMode {
    return treeGroupMode;
}

/** Сырое значение из секции [DEVICE] без учёта регистра ключа */
function getDeviceRawValue(fullConfig: RawIniConfig, key: string): string {
    const section = fullConfig['DEVICE'];
    if (!section) return '';
    for (const k in section) {
        if (k.toLowerCase() === key.toLowerCase()) {
            const v = section[k];
            if (typeof v === 'string') return v.trim();
            if (Array.isArray(v)) return v.join(' ').trim();
            return String(v ?? '');
        }
    }
    return '';
}

/** Ключ группы для устройства в заданном режиме */
export function getDeviceGroupKey(item: DeviceRegistryItem, mode: TreeGroupMode): string {
    const idLine = getDeviceRawValue(item.fullConfig, 'ID') || String(item.id);
    switch (mode) {
        case 'serial':
            return idLine.split(/\s+/)[0] || idLine;
        case 'mechType':
            return getDeviceRawValue(item.fullConfig, 'Description') || 'Без типа';
        case 'serviceDate':
            return getDeviceRawValue(item.fullConfig, 'LastDateTime') || 'Без даты';
        case 'deviceType': {
            const tokens = idLine.split(/\s+/);
            return tokens.slice(1, 3).join(' ') || idLine;
        }
        case 'location':
        default:
            return getDeviceRawValue(item.fullConfig, 'Location') || 'Неизвестное место';
    }
}

/** Текст строки-листа в дереве (одна строка, полная версия — в title) */
export function getDeviceLeafText(item: DeviceRegistryItem, mode: TreeGroupMode): string {
    const idLine = getDeviceRawValue(item.fullConfig, 'ID') || String(item.id);
    const desc = getDeviceRawValue(item.fullConfig, 'Description');
    const loc = getDeviceRawValue(item.fullConfig, 'Location');
    const dt = getDeviceRawValue(item.fullConfig, 'LastDateTime');
    if (mode === 'serviceDate') {
        return [dt, idLine, desc, loc].filter(Boolean).join(' ');
    }
    const tail = [desc, loc, dt].filter(Boolean).join(' ');
    return tail ? `${idLine} ${tail}` : idLine;
}

/** Все устройства реестра в порядке загрузки */
export function getAllDevices(): DeviceRegistryItem[] {
    const all: DeviceRegistryItem[] = [];
    for (const location in deviceRegistry) {
        const group = deviceRegistry[location];
        if (Array.isArray(group)) all.push(...group);
    }
    return all;
}
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
export function planControllerWrite(//////////////////////////\
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
}//////////////////////////////////\

/**
 * Преобразует строку IP-адреса в массив из двух 16-битных регистров.
 * Возвращает регистры в порядке для контроллера (младшее слово первым).
 * 
 * Поддерживает форматы:
 * - "192.168.1.10" (десятичный)
 * - "xC0A8010A" или "0xC0A8010A" (шестнадцатеричный)
 * 
 * @returns [lowWord, highWord] или null при неверном формате
 */
function parseIpToRegisters(ipString: string): [number, number] | null {
  const trimmed = ipString.trim();
  let value: number | null = null;

  // 1. HEX формат (8 hex-символов с префиксом x или 0x)
  if (/^0?x[0-9a-fA-F]{8}$/i.test(trimmed)) {
    const hexPart = trimmed.replace(/^0?x/i, '');
    value = parseInt(hexPart, 16);
  } 
  // 2. Decimal формат (4 октета через точки)
  else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
      value = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
      value = value >>> 0; // Беззнаковое 32-битное
    }
  }

  if (value === null || value < 0 || value > 0xFFFFFFFF) {
    return null;
  }

  // Разбиваем на два 16-битных слова (Big-Endian порядок байтов)
  const highWord = (value >> 16) & 0xFFFF;
  const lowWord = value & 0xFFFF;

  // Возвращаем в порядке Little-Endian регистров (младшее слово первым)
  return [lowWord, highWord];
}

/**
 * Преобразует два 16-битных регистра (в порядке LE: [lowWord, highWord]) в точечный IP-адрес.
 */
function registersToIp(lowWord: number, highWord: number): string {
  const value = ((highWord << 16) | lowWord) >>> 0;
  return `${(value >>> 24) & 0xFF}.${(value >>> 16) & 0xFF}.${(value >>> 8) & 0xFF}.${value & 0xFF}`;
}