// src/core/global.d.ts
// Глобальные расширения Window.
// Убирает все (window as any).osc из проекта.
import type { IOscilloscopeApi } from './osc-api.js';

declare global {
  interface Window {
    /** Единственная точка доступа к осциллографу из внешних модулей */
    osc?: IOscilloscopeApi;
    /** Инициализация ресайзеров таблицы (вызывается из tree.ts) */
    initTableResizers?: () => void;
  }
}

export {};