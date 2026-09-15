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
  };
}