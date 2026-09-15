// src/oscilloscope/core/RecFileWriter.ts
//
// Формирование файла формата .rec (старый аджастер ESM).
// КЛАСС ПОЛНОСТЬЮ АВТОНОМЕН: не зависит от DOM, Archive, Serial, Channel.
//
// Формат файла:
//   1. Текстовая часть (CP1251, CRLF, 7 секций)
//   2. Маркер "[binarydata]\r\n"
//   3. Бинарная часть:
//      a) Блок А — N записей по 9 байт (флаг uint8 + время float64 LE TDateTime)
//      b) Блок Б — для каждого параметра N значений его типа (LE)
//
// Все многобайтовые числа — little-endian.

/** Типы данных, поддерживаемые форматом .rec */
export type RecDataType = 'TWORD' | 'TFloat' | 'TBit' | 'TInteger' | 'TIPAddr';

/** Размер типа в байтах */
export function recTypeByteCount(t: RecDataType): number {
  switch (t) {
    case 'TBit': return 1;
    case 'TFloat': return 4;
    case 'TIPAddr': return 4;
    default: return 2;
  }
}

/**
 * Маппинг типа данных INI (в верхнем регистре) в тип .rec.
 * Возвращает null, если тип не поддерживается форматом .rec.
 */
export function mapToRecDataType(dataType: string): RecDataType | null {
  switch ((dataType || '').toUpperCase()) {
    case 'TWORD': return 'TWORD';
    case 'TFLOAT':
    case 'TFLOAT32': return 'TFloat';
    case 'TBIT': return 'TBit';
    case 'TINTEGER':
    case 'TSHORT':
    case 'TINT16': return 'TInteger';
    case 'TIPADDR': return 'TIPAddr';
    default: return null;
  }
}

/** Описание параметра для записи в [paralist] и бинарную часть */
export interface RecParam {
  id: string;
  name: string;
  description: string;
  recType: RecDataType;
  hexAddress: string;
  modbusReg: string;
  unit: string;
  scale: number; // Сюда запишем ВЫЧИСЛЕННОЕ значение (Height / Max * Scale)
  byteCount: number;
  rowHeight?: number; // Сюда запишем ТЕКУЩУЮ высоту строки
  rawParts?: string[];
}

/** Метаданные устройства для секции [DEVICE] */
export interface RecDeviceInfo {
  location: string;
  description: string;
  /** Полная строка ID из INI (например, "xxxxx771 DExS.SMFCB v1.10.5.0 21.05.2022 www.intmash.ru") */
  id: string;
  mcu: string;
}

/** Полные данные для генерации файла .rec */
export interface RecExportData {
  params: RecParam[];
  timestamps: number[];
  values: number[][];
  device?: Partial<RecDeviceInfo>;
}

const DEFAULT_DEVICE: RecDeviceInfo = {
  location: 'Home_05',
  description: 'Насос',
  id: 'xxxxxxxx DExS.SMFCB v1.10.9.0 27.07.2024',
  mcu: '1',
};

// ════════════════════════════════════════════════════════════════
// 1. Кодирование текста в CP1251
// ════════════════════════════════════════════════════════════════

const CP1251_MAP: Record<number, number> = {
  0x0410: 0xC0, 0x0411: 0xC1, 0x0412: 0xC2, 0x0413: 0xC3, 0x0414: 0xC4,
  0x0415: 0xC5, 0x0416: 0xC6, 0x0417: 0xC7, 0x0418: 0xC8, 0x0419: 0xC9,
  0x041A: 0xCA, 0x041B: 0xCB, 0x041C: 0xCC, 0x041D: 0xCD, 0x041E: 0xCE,
  0x041F: 0xCF, 0x0420: 0xD0, 0x0421: 0xD1, 0x0422: 0xD2, 0x0423: 0xD3,
  0x0424: 0xD4, 0x0425: 0xD5, 0x0426: 0xD6, 0x0427: 0xD7, 0x0428: 0xD8,
  0x0429: 0xD9, 0x042A: 0xDA, 0x042B: 0xDB, 0x042C: 0xDC, 0x042D: 0xDD,
  0x042E: 0xDE, 0x042F: 0xDF, 0x0401: 0xA8,
  0x0430: 0xE0, 0x0431: 0xE1, 0x0432: 0xE2, 0x0433: 0xE3, 0x0434: 0xE4,
  0x0435: 0xE5, 0x0436: 0xE6, 0x0437: 0xE7, 0x0438: 0xE8, 0x0439: 0xE9,
  0x043A: 0xEA, 0x043B: 0xEB, 0x043C: 0xEC, 0x043D: 0xED, 0x043E: 0xEE,
  0x043F: 0xEF, 0x0440: 0xF0, 0x0441: 0xF1, 0x0442: 0xF2, 0x0443: 0xF3,
  0x0444: 0xF4, 0x0445: 0xF5, 0x0446: 0xF6, 0x0447: 0xF7, 0x0448: 0xF8,
  0x0449: 0xF9, 0x044A: 0xFA, 0x044B: 0xFB, 0x044C: 0xFC, 0x044D: 0xFD,
  0x044E: 0xFE, 0x044F: 0xFF, 0x0451: 0xB8,
  0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x00A0: 0xA0, 0x00A9: 0xA9,
  0x00AE: 0xAE, 0x00B0: 0xB0, 0x00B1: 0xB1, 0x00B2: 0xB2, 0x00B3: 0xB3,
  0x00B5: 0xB5, 0x00B7: 0xB7, 0x2116: 0xB9,
};

function encodeCP1251(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp < 0x80) {
      out[i] = cp;
    } else {
      // Полная таблица CP1251 для кириллицы и основных символов
      let mapped = 0x3F; // По умолчанию '?'
      if (cp >= 0x0410 && cp <= 0x044F) {
        // А-Я (0x0410-0x042F) -> 0xC0-0xDF
        if (cp <= 0x042F) mapped = cp - 0x0410 + 0xC0;
        // а-я (0x0430-0x044F) -> 0xE0-0xFF
        else mapped = cp - 0x0430 + 0xE0;
      } else if (cp === 0x0401) mapped = 0xA8; // Ё
      else if (cp === 0x0451) mapped = 0xB8; // ё
      else if (cp === 0x2013) mapped = 0x96; // –
      else if (cp === 0x2014) mapped = 0x97; // —
      else if (cp === 0x2018) mapped = 0x91; // ‘
      else if (cp === 0x2019) mapped = 0x92; // ’
      else if (cp === 0x201C) mapped = 0x93; // “
      else if (cp === 0x201D) mapped = 0x94; // ”
      else if (cp === 0x2022) mapped = 0x95; // •
      else if (cp === 0x2026) mapped = 0x85; // …
      else if (cp === 0x00A0) mapped = 0xA0; // неразрывный пробел
      else if (cp === 0x00A9) mapped = 0xA9; // ©
      else if (cp === 0x00AE) mapped = 0xAE; // ®
      else if (cp === 0x00B0) mapped = 0xB0; // °
      else if (cp === 0x00B1) mapped = 0xB1; // ±
      else if (cp === 0x00B2) mapped = 0xB2; // ²
      else if (cp === 0x00B3) mapped = 0xB3; // ³
      else if (cp === 0x00B5) mapped = 0xB5; // µ
      else if (cp === 0x00B7) mapped = 0xB7; // ·
      else if (cp === 0x2116) mapped = 0xB9; // №
      
      out[i] = mapped;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 2. Вспомогательные функции кодирования
// ════════════════════════════════════════════════════════════════

const CRLF = new Uint8Array([0x0D, 0x0A]);

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function lineCP1251(str: string): Uint8Array {
  return concatBytes(encodeCP1251(str), CRLF);
}

function emptyLine(): Uint8Array {
  return CRLF;
}

function formatDecimal(n: number): string {
  return n.toString().replace('.', ',');
}

function formatLastDateTime(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}

/**
 * Формирует строку ID для секции [DEVICE] в формате, который принимает
 * старый аджастер: "СЕРИЙНИК МОДЕЛЬ ВЕРСИЯ ДАТА" (ровно 4 токена).
 * Берёт первые 3 токена из ID ини-файла и подставляет ТЕКУЩУЮ дату.
 */
function buildRecIdString(iniId: string | undefined, now: Date): string {
  const dateStr = formatLastDateTime(now).slice(0, 10); // DD.MM.YYYY
  const fallback = `xxxxxxxx DExS.SMFCB v1.10.9.0 ${dateStr}`;
  if (!iniId || !iniId.trim()) return fallback;
  const tokens = iniId.trim().split(/\s+/);
  if (tokens.length >= 3) {
    return `${tokens[0]} ${tokens[1]} ${tokens[2]} ${dateStr}`;
  }
  return fallback;
}

function unixMsToDelphiDateTime(unixMs: number): number {
  return unixMs / 86400000 + 25569;
}

function encodeFloat64LE(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return new Uint8Array(buf);
}

function encodeFloat32LE(value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new Uint8Array(buf);
}

function encodeUint16LE(value: number): Uint8Array {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setUint16(0, value & 0xFFFF, true);
  return new Uint8Array(buf);
}

function encodeInt16LE(value: number): Uint8Array {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, value, true);
  return new Uint8Array(buf);
}

function encodeUint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xFF]);
}

// ════════════════════════════════════════════════════════════════
// 3. Текстовая часть
// ════════════════════════════════════════════════════════════════

function formatParalistLine(p: RecParam): string {
  let fields: string[];

  if (p.rawParts && p.rawParts.length > 1) {
    fields = [...p.rawParts];
    // Убираем ид, если он присутствует в начале (ид пишется ДО '=')
    while (fields.length > 0 && fields[0] === p.id) fields.shift();
    // Убираем пустые элементы в конце (артефакт конечного '/')
    while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  } else {
    fields = [p.name, p.description, p.recType, p.hexAddress];
    if (p.recType === 'TBit') {
      const dotIdx = p.modbusReg.indexOf('.');
      fields.push(dotIdx >= 0 ? p.modbusReg.slice(dotIdx + 1) : '0');
    }
    fields.push(
      p.modbusReg,
      p.unit || '--',
      formatDecimal(p.scale),
      String(p.byteCount),
      '',
      '0',
      '0',
    );
  }

  // КРИТИЧНО: ид отделяется '=', поля — '/'
  return `${p.id}=${fields.join('/')}/`;
}

function formatViewOptionLine(p: RecParam): string {
  const height = p.rowHeight ?? 25; // Если высоты нет, берем дефолт 25
  // p.scale уже содержит вычисленное значение
  return `${p.id}=${formatDecimal(p.scale)}/${height}/`;
}

function buildTextSection(data: RecExportData, now: Date): Uint8Array {
  const N = data.timestamps.length;
  const device: RecDeviceInfo = { ...DEFAULT_DEVICE, ...data.device };

  const counterHex = 'x' + N.toString(16).toUpperCase().padStart(8, '0');

  const sections: Uint8Array[] = [];

  sections.push(
    lineCP1251('[records]'),
    lineCP1251(`counter=${counterHex}`),
    emptyLine(),
  );

  sections.push(
    lineCP1251('[DEVICE]'),
    lineCP1251(`LastDateTime=${formatLastDateTime(now)}`),
    lineCP1251(`Location=${device.location}`),
    lineCP1251(`Description=${device.description}`),
    lineCP1251(`ID=${buildRecIdString(device.id, now)}`),
    lineCP1251(`MCU=${device.mcu}`),
    emptyLine(),
  );

  sections.push(
    lineCP1251('[window]'),
    lineCP1251('positionsize=163/50/703/594/'),
    lineCP1251('option=47/45/55/21/1/0/'),
    emptyLine(),
  );

  sections.push(lineCP1251('[viewoption]'));
  for (const p of data.params) {
    sections.push(lineCP1251(formatViewOptionLine(p)));
  }
  sections.push(emptyLine());

  sections.push(lineCP1251('[paralist]'));
  for (const p of data.params) {
    sections.push(lineCP1251(formatParalistLine(p)));
  }
  sections.push(emptyLine());

  sections.push(
    lineCP1251('[vars]'),
    lineCP1251('sT=1'),
    lineCP1251('CINScale=0,1'),
    lineCP1251('AINK=0,00388'),
    emptyLine(),
  );

  sections.push(lineCP1251('[binarydata]'));

  return concatBytes(...sections);
}

// ════════════════════════════════════════════════════════════════
// 4. Бинарная часть
// ════════════════════════════════════════════════════════════════

function buildBinarySection(data: RecExportData, expectedSize: number): Uint8Array {
  const N = data.timestamps.length;
  const buf = new Uint8Array(expectedSize);
  let offset = 0;

  const writeChunk = (chunk: Uint8Array): void => {
    buf.set(chunk, offset);
    offset += chunk.length;
  };

  // Блок А: временные метки. Флаг 0x80 у ПЕРВОЙ и ПОСЛЕДНЕЙ записи (2 маркера).
  for (let i = 0; i < N; i++) {
    const flag: number = (i === 0 || i === N - 1) ? 0x80 : 0x00;
    const tDateTime = unixMsToDelphiDateTime(data.timestamps[i]);
    writeChunk(encodeUint8(flag));
    writeChunk(encodeFloat64LE(tDateTime));
  }

  // Блок Б: значения параметров
  for (let pIdx = 0; pIdx < data.params.length; pIdx++) {
    const param = data.params[pIdx];
    const values = data.values[pIdx];

    if (!values || values.length !== N) {
      throw new Error(
        `[RecFileWriter] values[${pIdx}] длина ${values?.length ?? 'undefined'}, ожидалось ${N}`
      );
    }

    for (let i = 0; i < N; i++) {
      const v = values[i];
      switch (param.recType) {
        case 'TBit':
          writeChunk(encodeUint8(v !== 0 ? 1 : 0));
          break;
        case 'TWORD':
          writeChunk(encodeUint16LE(Math.round(v) & 0xFFFF));
          break;
        case 'TInteger':
          writeChunk(encodeInt16LE(Math.round(v)));
          break;
        case 'TFloat':
          writeChunk(encodeFloat32LE(v));
          break;
        case 'TIPAddr': {
          // 4 байта little-endian — совместимо с чтением в RecFileReader
          const u = Math.round(v) >>> 0;
          writeChunk(encodeUint16LE(u & 0xFFFF));
          writeChunk(encodeUint16LE((u >>> 16) & 0xFFFF));
          break;
        }
      }
    }
  }

  if (offset !== expectedSize) {
    throw new Error(`[RecFileWriter] записано ${offset} байт, ожидалось ${expectedSize}`);
  }
  return buf;
}

// ════════════════════════════════════════════════════════════════
// 5. Публичный интерфейс
// ════════════════════════════════════════════════════════════════

export class RecFileWriter {
  public write(data: RecExportData): Uint8Array {
    if (!data.params || data.params.length === 0) {
      throw new Error('[RecFileWriter] data.params пуст');
    }
    if (!data.timestamps || data.timestamps.length === 0) {
      throw new Error('[RecFileWriter] data.timestamps пуст');
    }
    if (data.values.length !== data.params.length) {
      throw new Error('[RecFileWriter] длина values не совпадает с params');
    }

    const N = data.timestamps.length;
    const now = new Date();

    const timeBlockSize = N * 9;
    let valuesBlockSize = 0;
    for (const p of data.params) {
      valuesBlockSize += N * recTypeByteCount(p.recType);
    }
    const expectedBinarySize = timeBlockSize + valuesBlockSize;

    console.log(
      `[RecFileWriter] N=${N}, params=${data.params.length}, binarySize=${expectedBinarySize}`
    );

    const textSection = buildTextSection(data, now);
    const binarySection = buildBinarySection(data, expectedBinarySize);

    if (binarySection.length !== expectedBinarySize) {
      throw new Error(
        `[RecFileWriter] размер бинаря ${binarySection.length} != ${expectedBinarySize}`
      );
    }

    return concatBytes(textSection, binarySection);
  }
}