// src/ini-manager/drop-loader.ts
// ============================================================================
// DRAG-AND-DROP загрузка INI-файлов. Вешает обработчики на весь документ,
// чтобы работало при любом состоянии осциллографа. Срабатывает если
// файл брошен на любую видимую область (кроме самого осциллографа).
// Использует штатную функцию processSingleFileContent для обработки файлов.
// ============================================================================

import type { AppState } from "../core/app-state";
import { processSingleFileContent } from "./file-loader";

/** CSS-класс для визуальной подсветки зоны при перетаскивании. */
const DROP_ACTIVE_CLASS = "drop-zone-active";

/**
 * Инициализирует drag-and-drop для INI-файлов.
 * Вызывается один раз при запуске приложения.
 */
export function initDropZone(appState: AppState): void {
  console.log("[drop-loader] Initializing drop zone...");
  let dragCounter = 0;
  
  // Зона: весь интерфейс, кроме осциллографа
  const oscContainer = document.getElementById("osc-container");

  // Глобальный обработчик: предотвращаем открытие файла браузером
  document.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
  });

  // Подсветка при входе в приложение
  document.addEventListener("dragenter", (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      document.body.classList.add(DROP_ACTIVE_CLASS);
      console.log("[drop-loader] Added active class to body");
    }
  });

  // Убираем подсветку при выходе
  document.addEventListener("dragleave", (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      document.body.classList.remove(DROP_ACTIVE_CLASS);
      console.log("[drop-loader] Removed active class from body");
    }
  });

  // Обработка drop: игнорируем если брошен на осциллограф
  document.addEventListener("drop", async (e: DragEvent) => {
    e.preventDefault();
    console.log("[drop-loader] drop event fired");
    dragCounter = 0;
    document.body.classList.remove(DROP_ACTIVE_CLASS);

    // Проверяем, что файл НЕ брошен на осциллограф
    const target = e.target as HTMLElement;
    console.log("[drop-loader] Drop target:", target);
    
    if (oscContainer && oscContainer.contains(target)) {
      console.log("[drop-loader] Drop on oscilloscope, ignoring");
      return; // Бросок на осциллограф — игнорируем
    }

    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) {
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    const iniFiles = files.filter((f) => f.name.toLowerCase().endsWith(".ini"));

    if (iniFiles.length === 0) {
      console.warn("[drop-loader] No .ini files in drop");
      return;
    }

    console.log(`[drop-loader] Processing ${iniFiles.length} file(s)`);

    // Обрабатываем каждый файл через штатную функцию
    for (const file of iniFiles) {
      try {
        const content = await decodeFile(file);
        await processSingleFileContent(content, file.name, appState, file);
        console.log(`[drop-loader] Loaded: ${file.name}`);
      } catch (err) {
        console.error(`[drop-loader] Failed to process ${file.name}:`, err);
      }
    }
  });
}
/**
 * Читает файл с автоопределением кодировки (UTF-8 → Windows-1251),
 * так же как штатные загрузчики. Иначе кириллица превращается в кракозябры.
 */
async function decodeFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("windows-1251", { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder("utf-8").decode(buffer);
    }
  }
}