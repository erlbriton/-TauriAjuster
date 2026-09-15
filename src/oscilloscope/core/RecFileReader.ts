// src/oscilloscope/core/RecFileReader.ts
//
// Парсер файлов формата .rec (старый аджастер ESM).
// Обратная операция к RecFileWriter.
//
// Формат файла:
//   1. Текстовая часть (CP1251, CRLF, 7 секций)
//   2. Маркер "[binarydata]\r\n"
//   3. Бинарная часть:
//      a) Блок А — N записей по 9 байт (флаг uint8 + время float64 LE TDateTime)
//      b) Блок Б — для каждого параметра N значений его типа (LE)

import { mapToRecDataType, type RecDataType, type RecParam } from './RecFileWriter';

/** Результат парсинга .rec файла */
export interface RecFileData {
  params: RecParam[];
  timestamps: number[];
  values: number[][];
  device: {
    location: string;
    description: string;
    id: string;
    mcu: string;
    lastDateTime: string;
  };
}

// ════════════════════════════════════════════════════════════════
// 1. Декодирование CP1251 → UTF-8
// ═══════════════════════════════════════════════════════════════

const CP1251_TO_UTF8: Record<number, string> = {
    0xC0: 'А', 0xC1: 'Б', 0xC2: 'В', 0xC3: 'Г', 0xC4: 'Д', 0xC5: 'Е',
    0xC6: 'Ж', 0xC7: 'З', 0xC8: 'И', 0xC9: 'Й', 0xCA: 'К', 0xCB: 'Л',
    0xCC: 'М', 0xCD: 'Н', 0xCE: 'О', 0xCF: 'П', 0xD0: 'Р', 0xD1: 'С',
    0xD2: 'Т', 0xD3: 'У', 0xD4: 'Ф', 0xD5: 'Х', 0xD6: 'Ц', 0xD7: 'Ч',
    0xD8: 'Ш', 0xD9: 'Щ', 0xDA: 'Ъ', 0xDB: 'Ы', 0xDC: 'Ь', 0xDD: 'Э',
    0xDE: 'Ю', 0xDF: 'Я', 0xA8: 'Ё',
    0xE0: 'а', 0xE1: 'б', 0xE2: 'в', 0xE3: 'г', 0xE4: 'д', 0xE5: 'е',
    0xE6: 'ж', 0xE7: 'з', 0xE8: 'и', 0xE9: 'й', 0xEA: 'к', 0xEB: 'л',
    0xEC: 'м', 0xED: 'н', 0xEE: 'о', 0xEF: 'п', 0xF0: 'р', 0xF1: 'с',
    0xF2: 'т', 0xF3: 'у', 0xF4: 'ф', 0xF5: 'х', 0xF6: 'ц', 0xF7: 'ч',
    0xF8: 'ш', 0xF9: 'щ', 0xFA: 'ъ', 0xFB: 'ы', 0xFC: 'ь', 0xFD: 'э',
    0xFE: 'ю', 0xFF: 'я', 0xB8: 'ё',
    0x96: '\u2013', 0x97: '\u2014', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D',
    0x95: '\u2022', 0x85: '\u2026', 0xA0: '\u00A0', 0xA9: '\u00A9', 0xAE: '\u00AE', 0xB0: '\u00B0',
    0xB1: '\u00B1', 0xB2: '\u00B2', 0xB3: '\u00B3', 0xB5: '\u00B5', 0xB7: '\u00B7', 0xB9: '\u2116',
};

function decodeCP1251(bytes: Uint8Array, start: number, end: number): string {
  let result = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      result += String.fromCharCode(b);
    } else if (b >= 0xC0 && b <= 0xDF) {
      result += String.fromCharCode(b - 0xC0 + 0x0410); // А-Я
    } else if (b >= 0xE0 && b <= 0xFF) {
      result += String.fromCharCode(b - 0xE0 + 0x0430); // а-я
    } else if (b === 0xA8) result += '\u0401'; // Ё
    else if (b === 0xB8) result += '\u0451'; // ё
    else if (b === 0x96) result += '\u2013'; // –
    else if (b === 0x97) result += '\u2014'; // —
    else if (b === 0x91) result += '\u2018'; // ‘
    else if (b === 0x92) result += '\u2019'; // ’
    else if (b === 0x93) result += '\u201C'; // “
    else if (b === 0x94) result += '\u201D'; // ”
    else if (b === 0x95) result += '\u2022'; // •
    else if (b === 0x85) result += '\u2026'; // …
    else if (b === 0xA0) result += '\u00A0'; // неразрывный пробел
    else if (b === 0xA9) result += '\u00A9'; // ©
    else if (b === 0xAE) result += '\u00AE'; // ®
    else if (b === 0xB0) result += '\u00B0'; // °
    else if (b === 0xB1) result += '\u00B1'; // ±
    else if (b === 0xB2) result += '\u00B2'; // ²
    else if (b === 0xB3) result += '\u00B3'; // ³
    else if (b === 0xB5) result += '\u00B5'; // µ
    else if (b === 0xB7) result += '\u00B7'; // ·
    else if (b === 0xB9) result += '\u2116'; // №
    else result += '?';
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
// 2. Вспомогательные функции
// ════════════════════════════════════════════════════════════════

function decodeFloat64LE(bytes: Uint8Array, offset: number): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  for (let i = 0; i < 8; i++) {
    view.setUint8(i, bytes[offset + i]);
  }
  return view.getFloat64(0, true);
}

function decodeFloat32LE(bytes: Uint8Array, offset: number): number {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) {
    view.setUint8(i, bytes[offset + i]);
  }
  return view.getFloat32(0, true);
}

function decodeUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function decodeInt16LE(bytes: Uint8Array, offset: number): number {
  const val = bytes[offset] | (bytes[offset + 1] << 8);
  return val >= 0x8000 ? val - 0x10000 : val;
}

function delphiDateTimeToUnixMs(t: number): number {
  return (t - 25569) * 86400000;
}

// ════════════════════════════════════════════════════════════════
// 3. Парсинг текстовой части
// ════════════════════════════════════════════════════════════════

interface ParsedTextSection {
  counter: number;
  device: {
    location: string;
    description: string;
    id: string;
    mcu: string;
    lastDateTime: string;
  };
  params: RecParam[];
  viewOptions: Map<string, { scale: number; viewScale: number }>;
}

function parseTextSection(bytes: Uint8Array): { data: ParsedTextSection; binaryStart: number } {
  // Находим маркер [binarydata]\r\n
  const marker = new TextEncoder().encode('[binarydata]\r\n');
  let binaryStart = -1;
  for (let i = 0; i <= bytes.length - marker.length; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) { match = false; break; }
    }
    if (match) { binaryStart = i + marker.length; break; }
  }
  if (binaryStart === -1) {
    throw new Error('[RecFileReader] Маркер [binarydata] не найден');
  }

  // Декодируем текстовую часть
  const text = decodeCP1251(bytes, 0, binaryStart - marker.length);
  const lines = text.split('\r\n');

  let counter = 0;
  const device = { location: '', description: '', id: '', mcu: '', lastDateTime: '' };
  const params: RecParam[] = [];
  const viewOptions = new Map<string, { scale: number; viewScale: number }>();

  let currentSection = '';

      console.log('[RecFileReader] Всего строк в текстовой части:', lines.length);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    console.log(`[RecFileReader] Строка ${lineIdx}: "${trimmed}"`);
    if (!trimmed) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      console.log('[RecFileReader] Секция:', currentSection);
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (currentSection === 'paralist') {
      console.log('[RecFileReader] paralist key:', key, 'value:', value);
    }

    switch (currentSection) {
      case 'records':
        if (key === 'counter') {
          const hexStr = value.startsWith('x') ? value.slice(1) : value;
          counter = parseInt(hexStr, 16);
        }
        break;

      case 'DEVICE':
        if (key === 'LastDateTime') device.lastDateTime = value;
        else if (key === 'Location') device.location = value;
        else if (key === 'Description') device.description = value;
        else if (key === 'ID') device.id = value;
        else if (key === 'MCU') device.mcu = value;
        break;

      case 'viewoption':
        // Формат: p04500=0,045455/50/
        const voParts = value.split('/').filter(p => p.length > 0);
        if (voParts.length >= 2) {
          const scale = parseFloat(voParts[0].replace(',', '.'));
          const viewScale = parseFloat(voParts[1].replace(',', '.'));
          viewOptions.set(key, { scale, viewScale });
        }
        break;

            case 'paralist':
        // Формат строго: p04500=DEX_STATE(TEST)/Состояние возбудителя/TWORD/x005A/r002D/--/1/2//0/0/
        const parts = value.split('/').filter(p => p.length > 0 || value.endsWith('/'));
        if (parts.length < 8) break;

        const id = key;
        const name = parts[0];
        const description = parts[1];
        const dataTypeStr = parts[2];
        const hexAddress = parts[3];
        const modbusReg = parts[4];
        const unit = parts[5] || '--';
        const scaleStr = parts[6];
        const byteCountStr = parts[7];

        let recType = mapToRecDataType(dataTypeStr);
        if (!recType) {
          // Неизвестный тип из старого файла (например, TIPAddr).
          // НЕ пропускаем параметр, а подбираем тип того же размера,
          // иначе бинарная часть съедет и графики сместятся.
          const bc = parseInt(byteCountStr, 10);
          recType = bc <= 1 ? 'TBit' : bc === 2 ? 'TWORD' : 'TFloat';
        }

        const scale = parseFloat(scaleStr.replace(',', '.'));
        const byteCount = parseInt(byteCountStr, 10);

        params.push({
          id,
          name,
          description,
          recType,
          hexAddress,
          modbusReg,
          unit,
          scale,
          byteCount,
          rawParts: [id, name, description, dataTypeStr, hexAddress, modbusReg, unit, scaleStr, byteCountStr, '', '0', '0'],
        });
        break;
    }
  }

  return {
    data: { counter, device, params, viewOptions },
    binaryStart,
  };
}

// ════════════════════════════════════════════════════════════════
// 4. Декодирование бинарной части
// ════════════════════════════════════════════════════════════════

function decodeBinarySection(
  bytes: Uint8Array,
  binaryStart: number,
  params: RecParam[],
  counter: number,
): { timestamps: number[]; values: number[][] } {
  const N = counter;
  const timestamps: number[] = [];
  const values: number[][] = params.map(() => []);
  const flags: number[] = [];

  let offset = binaryStart;

  // Блок А: временные метки (N × 9 байт)
  for (let i = 0; i < N; i++) {
    const flag = bytes[offset];
    flags.push(flag);
    offset++;
    const tDateTime = decodeFloat64LE(bytes, offset);
    offset += 8;
    
    // Пропускаем недостоверные записи (флаг != 0)
    if (flag === 0) {
      timestamps.push(delphiDateTimeToUnixMs(tDateTime));
    }
  }

  // Блок Б: значения параметров
  for (let pIdx = 0; pIdx < params.length; pIdx++) {
    const param = params[pIdx];
    const paramValues: number[] = [];
    
    for (let i = 0; i < N; i++) {
      let value = 0;
      switch (param.recType) {
        case 'TBit':
          value = bytes[offset];
          offset += 1;
          break;
        case 'TWORD':
          value = decodeUint16LE(bytes, offset);
          offset += 2;
          break;
        case 'TInteger':
          value = decodeInt16LE(bytes, offset);
          offset += 2;
          break;
        case 'TFloat':
          value = decodeFloat32LE(bytes, offset);
          offset += 4;
          break;
        case 'TIPAddr': {
          const b0 = bytes[offset + 3];
          const b1 = bytes[offset + 2];
          const b2 = bytes[offset + 1];
          const b3 = bytes[offset];
          value = (b0 * 0x1000000) + (b1 * 0x10000) + (b2 * 0x100) + b3;
          offset += 4;
          break;
        }
        default:
          // Для неизвестных типов - пропускаем байты
          offset += param.byteCount || 0;
          break;
      }
      
      // Добавляем значение только если запись достоверна (флаг === 0)
      if (flags[i] === 0) {
        paramValues.push(value);
      }
    }
    
    values[pIdx] = paramValues;
  }

  return { timestamps, values };
}

// ════════════════════════════════════════════════════════════════
// 5. Публичный интерфейс
// ════════════════════════════════════════════════════════════════

export class RecFileReader {
  public parse(bytes: Uint8Array): RecFileData {
    const { data, binaryStart } = parseTextSection(bytes);
    const { timestamps, values } = decodeBinarySection(bytes, binaryStart, data.params, data.counter);

    return {
      params: data.params,
      timestamps,
      values,
      device: data.device,
    };
  }
}