// core/ini/ini-to-channels.ts
// Маппер IniParameter[] → ChannelConfig[] для осциллографа.
// Осциллограф принимает Channel[], не зная про INI.
// Готов к Tauri: чистая логика, 0 зависимостей от DOM/Serial.

import { IniParameter, IniDataType } from './types.js';

/** Конфигурация канала, совместимая с oscilloscope/core/Channel.ts */
export interface ChannelConfigFromIni {
  id: string;
  name: string;
  description: string;
  dataType: string;
  unit: string;
  scale: number;
  isBit: boolean;
  modbusReg: string;
  rawDecValue: number;
  hexValue: string;
  min: number;
  max: number;
  color?: string;
  recRawParts: string[];
}

/** Палитра для аналоговых каналов */
const PALETTE = [
  '#38bdf8', '#34d399', '#f43f5e', '#fbbf24', '#a855f7',
  '#06b6d4', '#4ade80', '#f472b6', '#eab308', '#c084fc',
  '#60a5fa', '#a3e635', '#fb7185', '#f97316', '#818cf8',
];

/**
 * Конвертирует типизированные INI-параметры в конфигурации каналов.
 * Вызывается ОДИН раз при загрузке INI, результат передаётся в осциллограф.
 */
export function iniParamsToChannelConfigs(params: IniParameter[]): ChannelConfigFromIni[] {
  let bitIndex = 0;
  let paletteIdx = 0;

  return params
    .filter(p => p.id && p.id.length > 0)
    .map(p => {
      let color: string | undefined;
      if (p.isBit) {
        color = (bitIndex % 2 === 0) ? '#00d2ff' : '#d2a679';
        bitIndex++;
      } else {
        color = PALETTE[paletteIdx % PALETTE.length];
        paletteIdx++;
      }

      return {
        id: p.id,
        name: p.name,
        description: p.description,
        dataType: p.dataType,
        unit: p.unit,
        scale: p.scale,
        isBit: p.isBit,
        modbusReg: p.modbusReg,
        rawDecValue: 0,
        hexValue: 'x0000',
        min: p.isBit ? 0 : -50,
        max: p.isBit ? 1 : 500,
        color,
        // Сохраняем оригинальные части строки для точного
        // воспроизведения в [paralist] при записи .rec
        recRawParts: [p.id, ...p.rawParts],
      };
    });
}