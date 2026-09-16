// src/vite-env.d.ts

/// <reference types="vite/client" />

// Объявляем типы для импорта CSS-файлов как модулей
declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

// Объявляем глобальный объект Tauri API (используется при withGlobalTauri = true)
interface Window {
  __TAURI__: {
    core: {
      invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
    event: {
      // listen подписывается на событие от Rust.
      // Возвращает Promise с функцией отписки (unlisten).
      // Payload события передаётся в колбэк как event.payload.
      listen<T>(
        eventName: string,
        handler: (event: { payload: T }) => void
      ): Promise<() => void>;
      
      // once — как listen, но срабатывает один раз
      once<T>(
        eventName: string,
        handler: (event: { payload: T }) => void
      ): Promise<() => void>;
    };
  };
}