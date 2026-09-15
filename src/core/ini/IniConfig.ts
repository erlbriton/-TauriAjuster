// core/ini/IniConfig.ts
// Типизированная обёртка над результатом парсинга.
// Предоставляет удобные методы для всех потребителей.
// Не зависит от DOM, Serial, осциллографа. Готов к Tauri.

import {
  IniParameter,
  IniDeviceInfo,
  IniParseResult,
} from './types.js';

export class IniConfig {
  private readonly paramsBySection: Map<string, Map<string, IniParameter>>;
  private readonly sectionOrder: string[];

  constructor(public readonly parseResult: IniParseResult) {
    this.paramsBySection = new Map();
    this.sectionOrder = [];

    for (const [section, params] of parseResult.sections) {
      this.sectionOrder.push(section);
      const map = new Map<string, IniParameter>();
      for (const p of params) {
        map.set(p.id, p);
      }
      this.paramsBySection.set(section, map);
    }
  }

  get device(): IniDeviceInfo | null {
    return this.parseResult.device;
  }

  get vars(): Readonly<Record<string, number>> {
    return this.parseResult.vars;
  }

  get sectionNames(): readonly string[] {
    return this.sectionOrder;
  }

  /** Все параметры секции (RAM, CD, FLASH) */
  public getSection(section: string): IniParameter[] {
    const map = this.paramsBySection.get(section.toUpperCase());
    return map ? Array.from(map.values()) : [];
  }

  /** Параметр по секции и id */
  public getParameter(section: string, id: string): IniParameter | null {
    return this.paramsBySection.get(section.toUpperCase())?.get(id) ?? null;
  }

  /**
   * Диапазон Modbus-регистров для секции.
   * Учитывает 32-битные типы (2 регистра).
   */
  public getRegisterRange(section: string): { start: number; count: number } {
    const params = this.getSection(section);
    let minReg = Infinity;
    let maxReg = -Infinity;

    for (const p of params) {
      if (p.registerAddress === null) continue;
      minReg = Math.min(minReg, p.registerAddress);
      maxReg = Math.max(maxReg, p.registerAddress + (p.is32Bit ? 1 : 0));
    }

    if (minReg === Infinity) return { start: 0, count: 0 };
    return { start: minReg, count: maxReg - minReg + 1 };
  }

  /**
   * Уникальные адреса регистров, отсортированные по возрастанию.
   * Используется для батчевых запросов Modbus.
   */
  public getUniqueRegisterAddresses(section: string): number[] {
    const params = this.getSection(section);
    const addrs = new Set<number>();
    for (const p of params) {
      if (p.registerAddress !== null) {
        addrs.add(p.registerAddress);
        if (p.is32Bit) addrs.add(p.registerAddress + 1);
      }
    }
    return Array.from(addrs).sort((a, b) => a - b);
  }

  /** Есть хотя бы одна стандартная секция */
  public get isValid(): boolean {
    return this.sectionOrder.length > 0;
  }

  /**
   * Обновляет значение по умолчанию параметра в rawSections (для последующей сериализации).
   * Для TBit обновляет parts[8], для остальных типов — parts[9].
   * Возвращает true, если параметр найден и обновлён.
   */
  public setParamValue(section: string, key: string, value: string): boolean {
    const sectionUpper = section.toUpperCase();
    const raw = this.parseResult.rawSections;
    const entry = raw[sectionUpper]?.[key];
    if (!entry || !Array.isArray(entry)) return false;

    // Для TBit значение в parts[8], для остальных — в parts[9]
    const param = this.getParameter(section, key);
    if (!param) return false;

    const valueIndex = param.isBit ? 8 : 9;
    if (valueIndex >= entry.length) {
      // Дополняем массив, если он короче
      while (entry.length <= valueIndex) entry.push('');
    }
    entry[valueIndex] = value;
    return true;
  }

  /**
   * Сериализация обратно в INI-текст.
   * Только для сохранения файлов, НЕ для передачи между модулями.
   */
   public serialize(): string {
    const out: string[] = [];
    const raw = this.parseResult.rawSections;

    for (const section of this.sectionOrder) {
      out.push(`[${section}]`);
      const entries = raw[section];
      if (entries) {
        for (const [key, val] of Object.entries(entries)) {
          out.push(`${key}=${Array.isArray(val) ? val.join('/') : val}`);
        }
      }
      out.push('');
    }

    if (raw['DEVICE']) {
      out.push('[DEVICE]');
      for (const [k, v] of Object.entries(raw['DEVICE'])) {
        out.push(`${k}=${Array.isArray(v) ? v.join('/') : v}`);
      }
      out.push('');
    }
    if (raw['VARS']) {
      out.push('[VARS]');
      for (const [k, v] of Object.entries(raw['VARS'])) {
        out.push(`${k}=${Array.isArray(v) ? v.join('/') : v}`);
      }
      out.push('');
    }

    return out.join('\n');
  }
}