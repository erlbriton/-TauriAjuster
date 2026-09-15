// core/ini/types.ts
// Чистые типы без зависимостей. Готовы к Tauri.

/** Нормализованные типы данных INI-параметров */
export enum IniDataType {
  TWORD     = 'TWORD',
  TBIT      = 'TBIT',
  TFLOAT    = 'TFLOAT',
  TFLOAT32  = 'TFLOAT32',
  TDWORD    = 'TDWORD',
  TLONG     = 'TLONG',
  TINT32    = 'TINT32',
  TSHORT    = 'TSHORT',
  TINT16    = 'TINT16',
  TINTEGER  = 'TINTEGER',
  TBYTE     = 'TBYTE',
  TPRMLIST  = 'TPRMLIST',
  TIPADDR   = 'TIPADDR',
  UNKNOWN   = 'UNKNOWN',
}

/** Полностью распарсенный параметр INI-файла */
export interface IniParameter {
  readonly section: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dataType: IniDataType;
  readonly hexAddress: string;
  readonly modbusReg: string;
  readonly unit: string;
  readonly scale: number;
  readonly byteCount: number;
  readonly sign: string;
  readonly value: string;
  readonly isBit: boolean;
  readonly is32Bit: boolean;
  readonly registerAddress: number | null;
  readonly bitIndex: number | null;
  readonly rawParts: string[];
}

/** Информация об устройстве из секции [DEVICE] */
export interface IniDeviceInfo {
  readonly id: string;
  readonly version: string;
  readonly date: string;
  readonly location: string;
  readonly description: string;
  readonly raw: Record<string, string>;
}

/** Результат парсинга INI-файла */
export interface IniParseResult {
  readonly device: IniDeviceInfo | null;
  readonly vars: Readonly<Record<string, number>>;
  readonly sections: ReadonlyMap<string, IniParameter[]>;
  readonly rawSections: Readonly<Record<string, Record<string, string | string[]>>>;
}

/** Ошибка парсинга с контекстом */
export class IniParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
    public readonly section?: string,
  ) {
    super(message);
    this.name = 'IniParseError';
  }
}