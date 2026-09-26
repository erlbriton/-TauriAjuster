// src/core/app-state.ts
// Типизированное состояние приложения.
// Не зависит от DOM, Serial, осциллографа. Готов к Tauri.
import type { IniConfig } from './ini/index.js';

/**
 * Полное состояние приложения.
 * Все модули (uiManager, serial-actions, file-loader, device_updater)
 * будут типизированы через этот интерфейс.
 */
export interface AppState {
  /** Идёт ли идентификация устройства (запрос ID) */
  isIdentifying: boolean;
  /** Активен ли опрос контроллера (readLoop) */
  isPolling: boolean;
  /** Идёт ли обновление регистров (кнопка «Обновить») */
  isRefreshing: boolean;
  /** Запущен ли цикл readLoop (защита от повторного запуска) */
  isLoopRunning: boolean;
  /** Modbus-адрес устройства */
  slaveAddress: number;
  /** Текст текущего INI-файла */
  currentIniContent: string | null;
  /** Типизированный конфиг из единого INI-слоя */
  currentIniConfig: IniConfig | null;
  /** Пауза между циклами опроса в миллисекундах (по умолчанию 20) */
  pollDelayMs: number;
}