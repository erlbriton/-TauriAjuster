// src/oscilloscope/core/Channel.ts

export interface ChannelConfig {
    id: string;          // p00600
    name: string;        // Ustat
    description: string; // Напряжение статора
    dataType?: string;   // TFloat, TBit, TWORD, TDWORD, etc.
    value?: number | string;
    unit: string;        // B, A, Hz
    scale?: number;      // Множитель
    color?: string;
    min?: number;
    max?: number;
    customMax?: number;  // Ручной максимум
    rowHeight?: number;  // Высота строки в px
    autoScale?: boolean; // Флаг авто масштаба
    type?: 'analog' | 'digital';
    hexValue?: string;
    rawDecValue?: number;
    isBit?: boolean;
    modbusReg?: string;
    /** Оригинальные части строки [paralist] из INI (для записи .rec) */
    recRawParts?: string[];
}

const PALETTE = [
    '#38bdf8', '#34d399', '#f43f5e', '#fbbf24', '#a855f7',
    '#06b6d4', '#4ade80', '#f472b6', '#eab308', '#c084fc',
    '#60a5fa', '#a3e635', '#fb7185', '#f97316', '#818cf8'
];

let paletteIndex = 0;

export class Channel {
    public readonly id: string;
    public name: string;
    public description: string;
    public value: number | string;
    public hexValue: string;
    public rawDecValue: number;
    public scaledValue: number;
    public unit: string;
    public color: string;
    public min: number;
    public max: number;
    public type: 'analog' | 'digital';
    public dataType: string;
    public scale: number;
    public customMax: number;
    public rowHeight: number;
    public autoScale: boolean;
    public isBit: boolean;
    public modbusReg: string;
    public currentDisplayMin?: number;
    public currentDisplayMax?: number;
    /** Оригинальные части строки [paralist] из INI (для записи .rec) */
    public recRawParts: string[];

    constructor(config: ChannelConfig) {
        this.id = config.id;
        this.name = config.name;
        this.description = config.description || '';
        this.unit = config.unit || '';
        this.scale = config.scale !== undefined ? config.scale : 1.0;
        this.isBit = config.isBit || false;
        this.type = this.isBit ? 'digital' : 'analog';
        this.dataType = config.dataType || (this.isBit ? 'TBit' : 'TWORD');
        this.modbusReg = config.modbusReg || '';
        this.recRawParts = config.recRawParts || [];
        this.rowHeight = Math.max(25, config.rowHeight || 25);
        this.autoScale = config.autoScale !== undefined ? config.autoScale : true;

        this.rawDecValue = config.rawDecValue !== undefined ? config.rawDecValue : 0;
        // Для TIPAddr (4 байта) используем 32-битную маску, для остальных — 16-битную
        const isIpAddr = this.dataType.toUpperCase() === 'TIPADDR';
        const mask = isIpAddr ? 0xFFFFFFFF : 0xFFFF;
        const padLen = isIpAddr ? 8 : 4;
        this.hexValue = config.hexValue || ('x' + (this.rawDecValue & mask).toString(16).toUpperCase().padStart(padLen, '0'));
        this.scaledValue = this.isBit ? this.rawDecValue : (this.rawDecValue * this.scale);
        this.value = this.scaledValue;

        this.color = config.color || PALETTE[(paletteIndex++) % PALETTE.length];
        this.min = config.min !== undefined ? config.min : (this.isBit ? 0 : -50);
        this.max = config.max !== undefined ? config.max : (this.isBit ? 1 : 500);
        this.customMax = config.customMax !== undefined ? config.customMax : this.max;
    }

    public updateRawValue(val: number): void {
        this.rawDecValue = val;
        // Для TIPAddr (4 байта) используем 32-битную маску, для остальных — 16-битную
                const isIpAddr = this.dataType.toUpperCase() === 'TIPADDR';
        const mask = isIpAddr ? 0xFFFFFFFF : 0xFFFF;
        const padLen = isIpAddr ? 8 : 4;
        this.hexValue = 'x' + (val & mask).toString(16).toUpperCase().padStart(padLen, '0');
        this.scaledValue = this.applyScale(val);
        this.value = this.scaledValue;
    }

    private applyScale(val: number): number {
        if (this.isBit) return val > 0 ? 1 : 0;
        return val * this.scale;
    }

    public getNumericValue(): number {
        return this.scaledValue;
    }
}

export interface ParsedModbusReg {
    address: number;
    bit: number | null;
}

/**
 * Парсит строку modbusReg (например, "r0001.6" или "100")
 */
export function parseModbusReg(regStr: string): ParsedModbusReg | null {
    if (!regStr) return null;

    const cleanStr = regStr.replace(/^[rR]/, '');
    const parts = cleanStr.split('.');

    const address = parseInt(parts[0], 16);
    if (isNaN(address)) return null;

    let bit: number | null = null;
    if (parts.length > 1) {
        bit = parseInt(parts[1], 16);
        if (isNaN(bit) || bit < 0 || bit > 15) return null;
    }

    return { address, bit };
}