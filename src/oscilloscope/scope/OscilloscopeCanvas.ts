// src/oscilloscope/scope/OscilloscopeCanvas.ts
// ============================================================================
// CANVAS-OVERLAY ОСЦИЛЛОГРАФА (вынесено из класса Oscilloscope).
// Метрики колонки графиков, позиционирование и ресайз обёртки канваса.
// Паттерн — как у соседних модулей: функции работают с явным контекстом,
// всё состояние живёт на классе.
// ============================================================================

import type { Application } from "pixi.js";

/**
 * Контекст, необходимый канвас-функциям.
 * Строится классом в getCanvasContext().
 */
export interface CanvasContext {
  /** Контейнер строк каналов (таблица). */
  rowsContainer: HTMLElement;
  /** PixiJS-приложение (может быть null до initialize). */
  pixiApp: Application | null;
  /** HTML-обёртка над канвасом (может быть null до initialize). */
  canvasOverlay: HTMLDivElement | null;
  /** Записать новое значение отступа колонки графиков обратно в класс. */
  setGraphColumnOffset: (value: number) => void;
}

/**
 * Вычисляет метрики колонки графиков: отступ слева и ширину.
 * Использует первый ряд каналов (или шапку таблицы) как образец.
 */
export function getGraphColumnMetrics(ctx: CanvasContext): { left: number; width: number } {
  const host = ctx.rowsContainer.parentElement as HTMLElement;
  const hostRect = host.getBoundingClientRect();
  const firstRow = ctx.rowsContainer.querySelector(".channel-row");
  const baseEl = firstRow ?? host.querySelector("#header");
  const graphEl = baseEl ? (baseEl.querySelector(".col-graph") as HTMLElement | null) : null;
  if (!graphEl) {
    return { left: 0, width: Math.max(50, ctx.rowsContainer.clientWidth) };
  }
  const rect = graphEl.getBoundingClientRect();
  return {
    left: Math.round(rect.left - hostRect.left),
    width: Math.max(50, Math.round(rect.width)),
  };
}

/** Пересчитывает и сохраняет отступ до колонки графиков. */
export function updateGraphColumnOffset(ctx: CanvasContext): void {
  ctx.setGraphColumnOffset(getGraphColumnMetrics(ctx).left);
}

/** Обновляет позицию и размер обёртки канваса (canvasOverlay). */
export function updateCanvasPosition(ctx: CanvasContext): void {
  if (!ctx.pixiApp || !ctx.canvasOverlay) return;
  const host = ctx.rowsContainer.parentElement as HTMLElement;
  const hostRect = host.getBoundingClientRect();
  const rowsRect = ctx.rowsContainer.getBoundingClientRect();
  const metrics = getGraphColumnMetrics(ctx);
  ctx.canvasOverlay.style.top = `${Math.round(rowsRect.top - hostRect.top)}px`;
  ctx.canvasOverlay.style.left = `${metrics.left}px`;
  ctx.canvasOverlay.style.width = `${metrics.width}px`;
  ctx.canvasOverlay.style.height = `${Math.round(rowsRect.height)}px`;
}

/** Синхронизирует размер и позицию canvas с rowsContainer. */
export function syncCanvasLayout(ctx: CanvasContext): void {
  if (!ctx.pixiApp) return;
  updateCanvasPosition(ctx);
  const metrics = getGraphColumnMetrics(ctx);
  ctx.pixiApp.renderer.resize(metrics.width, Math.max(50, ctx.rowsContainer.clientHeight));
}