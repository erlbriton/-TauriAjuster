// src/oscilloscope/scope/OscilloscopeLoop.ts
// ============================================================================
// КАДРОВЫЙ ЦИКЛ ОСЦИЛЛОГРАФА — вынесено из класса Oscilloscope.
//   draw()               — приём новых значений параметров в архив;
//   loop()               — requestAnimationFrame-цикл с dirty-flag и троттлингом;
//   renderVisibleGraphs()— отрисовка каналов, видимых в области прокрутки,
//                          плюс совмещённой строки.
// Паттерн — как у соседних модулей: функции работают с явным контекстом,
// состояние (тайминги, флаги) живёт на классе через геттеры/сеттеры.
// ============================================================================

import type { Channel } from "../core/Channel.js";
import type { Archive } from "../core/Archive";
import type { Settings } from "../config/Settings";
import type { Table } from "../ui/Table";
import type { Toolbar } from "../ui/Toolbar";
import type { TimelineScrollbar } from "../ui/TimelineScrollbar";
import type { Renderer } from "../graphics/Renderer";
import type { PixiView } from "../graphics/PixiView";
import type { CompositeChannelRow } from "../ui/CompositeChannelRow";

/** Минимальный интервал между перерисовками (мс). Бывш. Oscilloscope.RENDER_INTERVAL_MS. */
const RENDER_INTERVAL_MS = 20;

/**
 * Контекст кадрового цикла. Строится классом в getLoopContext().
 */
export interface LoopContext {
  isDestroyed: boolean;
  isRunning: boolean;
  table: Table | null;
  archive: Archive;
  settings: Settings;
  timelineScrollbar: TimelineScrollbar | null;
  toolbar: Toolbar | null;
  viewerMode: boolean;
  renderer: Renderer;
  rowsContainer: HTMLElement | null;
  pixiViews: Map<string, PixiView>;
  getVisibleChannels: () => Channel[];
  getAllChannels: () => Channel[];
  getCompositeRow: () => CompositeChannelRow | null;
  getCompositeView: () => PixiView | null;
  getCompositeChannels: () => Channel[];
  // Тайминг-состояние цикла (живёт на классе, т.к. делится с lifecycle).
  getDrawCallCount: () => number;
  setDrawCallCount: (v: number) => void;
  getLastRenderSignature: () => string;
  setLastRenderSignature: (v: string) => void;
  getLastRenderTime: () => number;
  setLastRenderTime: (v: number) => void;
  setLastFrameTime: (v: number) => void;
  setAnimFrameId: (v: number | null) => void;
}

/**
 * Принимает новые значения параметров и кладёт их в архив.
 * Вызывается из внешнего опроса (uiManager) по мере поступления данных.
 */
export function draw(ctx: LoopContext, data: Record<string, number>): void {
  if (ctx.isDestroyed || !data) return;
  ctx.setDrawCallCount(ctx.getDrawCallCount() + 1);
  const now = Date.now();
  ctx.getAllChannels().forEach((ch) => {
    if (data[ch.id] !== undefined) {
      const val = data[ch.id];
      if (typeof val === "number" && Number.isFinite(val)) {
        ch.updateRawValue(val);
        // ВАЖНО: передаём И scaledValue, И rawValue
        ctx.archive.addSample(ch.id, now, ch.scaledValue, ch.rawDecValue);
      }
    }
  });
}

/**
 * Кадровый цикл: планирование следующего кадра, обновление скроллбара,
 * dirty-flag проверка и троттлинг перерисовки.
 */
export function loop(ctx: LoopContext, now: number): void {
  ctx.setAnimFrameId(null);
  if (ctx.isDestroyed || !ctx.isRunning || !ctx.table) return;
  ctx.setLastFrameTime(now);

  const range = ctx.archive.getTimeRange();
  if (ctx.timelineScrollbar) {
    ctx.timelineScrollbar.setRange(range.min, range.max);
    if (ctx.settings.isPolling && ctx.settings.isLive()) {
      ctx.timelineScrollbar.setPosition(range.max);
    }
  }

  try {
    ctx.toolbar?.updateRecordTimer();

    // Dirty-flag: есть ли смысл перерисовывать в этом тике.
    // ВАЖНАЯ ПРАВКА (борьба с «изломом» графиков после остановки опроса):
    // пока опрос ОСТАНОВЛЕН (!isPolling), считаем кадр грязным ВСЕГДА.
    // Причина излома: каждая строка хранит собственную отрисовку волны и
    // вертикальной сетки времени, фаза сетки зависит от «текущего времени»
    // на момент отрисовки строки. Если в момент стопа какая-то строка
    // осталась с более ранней отрисовкой (другая фаза сетки), она видна
    // «сдвинутой» относительно соседей, а перерисовка после стопа больше
    // не запускается (сигнатура не меняется) — излом застывает на экране.
    // Принудительная перерисовка всех видимых строк ОДНИМ замороженным
    // временем (freezeTime уже зафиксировал его) гарантирует согласованность:
    // картинка визуально стоит на месте, но любые «устаревшие» строки
    //自愈 восстанавливаются за один интервал RENDER_INTERVAL_MS.
    // Исключение: режим просмотрщика .rec (viewerMode) — там опроса нет
    // постоянно, и принудительная перерисовка не нужна.
    const signature =
      `${range.max}|${ctx.settings.getCurrentViewTime()}|` +
      `${ctx.settings.timeScale}|${ctx.settings.amplitudeMarkerTime}|` +
      `${ctx.settings.intervalMarker1Time}|${ctx.settings.intervalMarker2Time}`;
    const dirty =
      signature !== ctx.getLastRenderSignature() ||
      (!ctx.settings.isPolling && !ctx.viewerMode);
    const throttled = now - ctx.getLastRenderTime() >= RENDER_INTERVAL_MS;

    if (dirty && throttled) {
      ctx.setLastRenderSignature(signature);
      ctx.setLastRenderTime(now);
      ctx.table.updateValues();

      // Обновляем значения в легенде совмещённой строки, если она существует.
      // Это синхронизирует обновление данных с обычными строками таблицы.
      const compositeRow = ctx.getCompositeRow();
      if (compositeRow && compositeRow.getIsVisible()) {
        compositeRow.updateValues();
      }

      renderVisibleGraphs(ctx);
    }
  } catch (err) {
    console.error("Oscilloscope loop error:", err);
  }
  ctx.setAnimFrameId(requestAnimationFrame((t) => loop(ctx, t)));
}

/** Рендерит только те каналы, чьи строки сейчас видимы в области прокрутки. */
export function renderVisibleGraphs(ctx: LoopContext): void {
  const rowsContainer = ctx.rowsContainer;
  if (!rowsContainer) return;
  const rowsRect = rowsContainer.getBoundingClientRect();
  const viewportTop = rowsRect.top - 60;
  const viewportBottom = rowsRect.bottom + 60;

  for (const channel of ctx.getVisibleChannels()) {
    const row = ctx.table ? ctx.table.getRow(channel.id) : null;
    const view = ctx.pixiViews.get(channel.id);

    if (!row || !view) continue;

    // ОБРАБОТКА СКРЫТЫХ СТРОК: если строка скрыта (входит в совмещённую
    // группу), очищаем её графику и прячем контейнер — иначе PixiJS
    // оставит последний нарисованный график "висеть" на экране.
    if (!row.getIsVisible()) {
      view.waveGraphics.clear();
      view.gridGraphics.clear();
      view.markerGraphics.clear();
      view.container.visible = false;
      continue;
    }

    // Делаем контейнер видимым (на случай, если канал был ранее скрыт).
    view.container.visible = true;

    // В режиме просмотра .rec рисуем ВСЕ каналы, а не только видимые:
    // опроса нет, и "доскролленные" строки иначе остались бы пустыми.
    if (!ctx.viewerMode) {
      const rowRect = row.getElement().getBoundingClientRect();
      if (rowRect.bottom < viewportTop || rowRect.top > viewportBottom) continue;
    }

    try {
      ctx.renderer.renderChannelGraph(channel, view);
    } catch (renderErr) {
      console.error(`Error rendering channel ${channel.id}:`, renderErr);
    }
  }

  // ОТРИСОВКА СОВМЕЩЁННОЙ СТРОКИ: все каналы группы в одном PixiView.
  // Позиция — после всех одиночных каналов (учитывает syncViewPositions).
  const compositeRow = ctx.getCompositeRow();
  const compositeView = ctx.getCompositeView();
  const compositeChannels = ctx.getCompositeChannels();
  if (compositeRow && compositeView && compositeChannels.length > 0) {
    if (!ctx.viewerMode) {
      const compositeRect = compositeRow.getElement().getBoundingClientRect();
      if (compositeRect.bottom < viewportTop || compositeRect.top > viewportBottom) {
        return; // совмещённая строка вне экрана — пропускаем для производительности
      }
    }
    try {
      ctx.renderer.renderCompositeGraph(compositeChannels, compositeView);
    } catch (renderErr) {
      console.error("[Oscilloscope] Error rendering composite graph:", renderErr);
    }
  }
}