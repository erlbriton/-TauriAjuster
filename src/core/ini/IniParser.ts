// core/ini/IniParser.ts
// ЕДИНЫЙ парсер INI для всего проекта.
// Не зависит от DOM, Serial, осциллографа. Готов к Tauri.

import {
  IniDataType,
  IniParameter,
  IniDeviceInfo,
  IniParseResult,
  IniParseError,
} from './types.js';

/** Типы, занимающие 2 регистра (32 бит) */
const TYPES_32BIT: ReadonlySet<IniDataType> = new Set([
  IniDataType.TFLOAT,
  IniDataType.TFLOAT32,
  IniDataType.TDWORD,
  IniDataType.TLONG,
  IniDataType.TINT32,
  IniDataType.TIPADDR,
]);

/** Секции, содержащие параметры с parts[] */
const PARAM_SECTIONS: ReadonlySet<string> = new Set(['RAM', 'CD', 'FLASH']);

/** Маппинг сырых строк типа → нормализованный enum */
const DATA_TYPE_MAP: Record<string, IniDataType> = {
  'TWORD':    IniDataType.TWORD,
  'TBIT':     IniDataType.TBIT,
  'TFLOAT':   IniDataType.TFLOAT,
  'TFLOAT32': IniDataType.TFLOAT32,
  'FLOAT':    IniDataType.TFLOAT,
  'TDWORD':   IniDataType.TDWORD,
  'TLONG':    IniDataType.TLONG,
  'TINT32':   IniDataType.TINT32,
  'TSHORT':   IniDataType.TSHORT,
  'TINT16':   IniDataType.TINT16,
  'TINTEGER': IniDataType.TINTEGER,
  'INT':      IniDataType.TINTEGER,
  'TBYTE':    IniDataType.TBYTE,
  'TPRMLIST': IniDataType.TPRMLIST,
  'TIPADDR':  IniDataType.TIPADDR,
};

export class IniParser {
  /**
   * Парсит полный текст INI-файла.
   * Единственная точка входа. Вызывается ОДИН раз на файл.
   */
  public parse(text: string): IniParseResult {
    if (!text || text.trim().length === 0) {
      throw new IniParseError('Пустой INI-контент');
    }

    const lines = text.split(/\r?\n/);

    // Фаза 1: [vars]
    const vars = this.scanVars(lines);

    // Фаза 2: секции и сырые данные
    const rawSections: Record<string, Record<string, string | string[]>> = {};
    let currentSection: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith(';')) continue;

      const sectionMatch = trimmed.match(/^\[(.*?)\]$/);
      if (sectionMatch && sectionMatch[1]) {
        currentSection = sectionMatch[1].toUpperCase();
        if (!rawSections[currentSection]) {
          rawSections[currentSection] = {};
        }
        continue;
      }

      if (currentSection === null || !trimmed.includes('=')) continue;

      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIdx).trim();
      const rawValue = trimmed.substring(eqIdx + 1).trim();

      if (PARAM_SECTIONS.has(currentSection) && rawValue.includes('/')) {
        let parts = rawValue.split('/');
        if (parts.length > 0 && parts[parts.length - 1] === '') {
          parts.pop();
        }
        rawSections[currentSection][key] = parts;
      } else {
        rawSections[currentSection][key] = rawValue;
      }
    }

    // Фаза 3: типизированные параметры
    const sections = new Map<string, IniParameter[]>();

    for (const sectionName of PARAM_SECTIONS) {
      const entries = rawSections[sectionName];
      if (!entries) continue;

      const params: IniParameter[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (!Array.isArray(value)) continue;
        params.push(this.buildParameter(sectionName, key, value, vars));
      }
      if (params.length > 0) {
        sections.set(sectionName, params);
      }
    }

    // Фаза 4: DEVICE
    const device = this.parseDevice(rawSections['DEVICE']);

    return { device, vars, sections, rawSections };
  }

  // ──────────────────────────────────────────
  // Внутренние методы
  // ──────────────────────────────────────────

  private scanVars(lines: string[]): Record<string, number> {
    const vars: Record<string, number> = {};
    let inVars = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.toUpperCase() === '[VARS]') {
        inVars = true;
        continue;
      }
      if (trimmed.startsWith('[')) {
        inVars = false;
      }
      if (inVars && trimmed.includes('=')) {
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIdx).trim();
        const valStr = trimmed.substring(eqIdx + 1).trim().replace(',', '.');
        const num = parseFloat(valStr);
        if (!isNaN(num)) {
          vars[key] = num;
        }
      }
    }
    return vars;
  }

  private buildParameter(
    section: string,
    id: string,
    parts: string[],
    vars: Record<string, number>,
  ): IniParameter {
    const dataTypeRaw = (parts[2] ?? '').trim().toUpperCase();
    const dataType = DATA_TYPE_MAP[dataTypeRaw] ?? IniDataType.UNKNOWN;
    const isBit = dataType === IniDataType.TBIT;
    const is32Bit = TYPES_32BIT.has(dataType);

    // TBit: modbusReg в parts[5]; аналоговые: modbusReg в parts[4]
    const modbusReg = isBit
      ? (parts[5] ?? '').trim()
      : (parts[4] ?? '').trim();

    // Единицы: для TBit пусто, для аналоговых parts[5]
    const unit = isBit ? '' : (parts[5] ?? '').trim();

    // Множитель: parts[6], разрешённый через vars
    const scale = this.resolveScale(parts[6], vars, isBit);

    const { registerAddress, bitIndex } = this.parseModbusReg(modbusReg);

    return Object.freeze({
      section,
      id,
      name: (parts[0] ?? '').trim(),
      description: (parts[1] ?? '').trim(),
      dataType,
      hexAddress: (parts[3] ?? '').trim(),
      modbusReg,
      unit,
      scale,
      byteCount: parseInt(parts[7] ?? '2', 10) || 2,
      sign: (parts[8] ?? '').trim(),
      value: (parts[9] ?? parts[8] ?? '').trim(),
      isBit,
      is32Bit,
      registerAddress,
      bitIndex,
      rawParts: [...parts],
    });
  }

  private resolveScale(
    rawScale: string | undefined,
    vars: Record<string, number>,
    isBit: boolean,
  ): number {
    if (isBit) return 1.0;
    if (!rawScale || rawScale.trim() === '') return 1.0;

    const key = rawScale.trim();

    // Имя переменной из [vars]
    if (key in vars) return vars[key];

    // Числовое значение
    const num = parseFloat(key.replace(',', '.'));
    return isNaN(num) || num === 0 ? 1.0 : num;
  }

  private parseModbusReg(modbusReg: string): {
    registerAddress: number | null;
    bitIndex: number | null;
  } {
    if (!modbusReg || modbusReg === '*') {
      return { registerAddress: null, bitIndex: null };
    }

    // r0000.3 → регистр + бит
    const bitMatch = modbusReg.match(/r([0-9a-fA-F]+)\.([0-9a-fA-F]+)/i);
    if (bitMatch) {
      return {
        registerAddress: parseInt(bitMatch[1], 16),
        bitIndex: parseInt(bitMatch[2], 16),
      };
    }

    // r0006 → только регистр
    const regMatch = modbusReg.match(/r([0-9a-fA-F]+)/i);
    if (regMatch) {
      return {
        registerAddress: parseInt(regMatch[1], 16),
        bitIndex: null,
      };
    }

    return { registerAddress: null, bitIndex: null };
  }

  private parseDevice(
    raw: Record<string, string | string[]> | undefined,
  ): IniDeviceInfo | null {
    if (!raw) return null;

    const get = (key: string): string => {
      const v = raw[key];
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v[0] ?? '';
      return '';
    };

    return Object.freeze({
      id: get('ID') || get('Id') || get('id') || '',
      version: get('Version') || '',
      date: get('Date') || '',
      location: get('Location') || '',
      description: get('Description') || '',
      raw: raw as Record<string, string>,
    });
  }
}