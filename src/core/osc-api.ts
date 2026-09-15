// src/core/osc-api.ts
// Абстракция API осциллографа для внешних модулей.
// НЕ зависит от конкретной реализации Oscilloscope.
// Готов к Tauri: нативный осциллограф реализует этот интерфейс.

/** Конфигурация канала (подмножество ChannelConfig, достаточное для внешних вызовов) */
export interface OscChannelConfig {
  id: string;
  name: string;
  description: string;
  dataType?: string;
  unit: string;
  scale?: number;
  color?: string;
  isBit?: boolean;
  modbusReg?: string;
  rawDecValue?: number;
  hexValue?: string;
  min?: number;
  max?: number;
}

/** Элемент списка INI-файлов в панели осциллографа */
export interface OscIniFileItem {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  content: string;
}

/**
 * Минимальный контракт осциллографа, видимый извне.
 * Все модули (uiManager, file-loader, tree-ui, serial-actions)
 * должны зависеть ТОЛЬКО от этого интерфейса.
 */
export interface IOscilloscopeApi {
  initialize(container?: HTMLElement | string): Promise<void>;
  draw(data: Record<string, number>): void;
  loadIniContent(content: string): Promise<void>;
  applyChannelConfigs(configs: OscChannelConfig[]): Promise<void>;
  setIniFiles(files: OscIniFileItem[]): void;
  setActiveIni(id: string, loadContent?: boolean): void;
  setConnectionStatus(connected: boolean, message?: string): void;
  setSerialPort(port: unknown): void;
  setSlaveAddress(addr: number): void;
  destroy(): void;
   showFrozenState(message: string): void;
  resumeFromFrozen(): void;
}