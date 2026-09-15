import path from 'path';
import { defineConfig } from 'vite';

// Передаем объект конфигурации напрямую для корректного вывода типов
export default defineConfig({
  base: '/', // Корневой путь для корректной работы Tauri
  
  build: {
    chunkSizeWarningLimit: 1000, // Увеличиваем лимит предупреждений до 1 МБ
    
    rollupOptions: {
      // Указываем две точки входа: главное приложение и просмотрщик осциллограмм
      input: {
        main: 'index.html',
        viewer: 'rec-viewer.html',
      },
      output: {
        // Используем функцию для ручного разбиения на чанки.
        // Это решает проблему несовместимости типов в TypeScript (ManualChunksFunction),
        // при этом логика оптимизации остается точно такой же.
        manualChunks(id) {
          // Выносим PixiJS в отдельный чанк (самая тяжелая библиотека)
          if (id.includes('pixi.js')) {
            return 'pixi-vendor';
          }
          // Выносим ExcelJS в отдельный чанк (тяжелая библиотека для экспорта)
          if (id.includes('exceljs')) {
            return 'excel-vendor';
          }
        }
      }
    }
  },
  
  plugins: [],
  
  resolve: {
    alias: {
      // Используем import.meta.dirname вместо __dirname для ES-модулей
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
  
  server: {
    port: 1420, // Порт, который ожидает Tauri
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
});