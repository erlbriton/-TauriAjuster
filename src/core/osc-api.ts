// src/core/osc-api.ts
// Абстракция API осциллографа для внешних модулей.
// НЕ зависит от конкретной реализации Oscilloscope.
// Готов к Tauri: нативный осциллограф реализует этот интерфейс.

import type { Archive } from '../oscilloscope/core/Archive.js';

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

  // Поля и методы, нужные внешним UI-компонентам (ChannelRow, меню и др.).
  // Раньше вызывались через `(window as any).osc` — теперь типизированы здесь.

  /** true, если осциллограф работает в режиме просмотрщика (без живого цикла). */
  viewerMode: boolean;

  /** Доступ к внутреннему архиву сигналов (для окна «Посчитать коэффициент»). */
  getArchive(): Archive;

  /** true, если канал с указанным id входит в текущую совмещённую строку. */
  isChannelInCompositeGroup(channelId: string): boolean;

  /** Пересчитывает высоту совмещённой строки после изменения свойств канала. */
  checkAndUpdateCompositeHeight(channelId: string): void;

  /** Отрисовка видимых графиков (нужна для принудительной перерисовки в viewer-mode). */
  renderVisibleGraphs(): void;
}