// src/oscilloscope/scope/OscilloscopeComposite.ts
// ============================================================================
// СОВМЕЩЁННАЯ СТРОКА (Composite Channel Row) — вынесено из класса Oscilloscope.
// Создание, удаление и пересчёт высоты совмещённой строки, объединяющей
// от 2 до 5 каналов в одну систему координат для детального анализа.
//
// Паттерн — как у соседних модулей: функции работают с явным контекстом.
// Состояние (compositeRow / compositePixiView / compositeChannels) живёт
// на классе и читается через live-геттеры, чтобы замыкания (onDisconnect
// и т.п.), срабатывающие позже, всегда видели актуальные значения.
// ============================================================================

import type { Application } from "pixi.js";
import type { Channel } from "../core/Channel.js";
import { PixiView } from "../graphics/PixiView";
import type { Table } from "../ui/Table";
import { CompositeChannelRow } from "../ui/CompositeChannelRow";
import { syncViewPositions, type RenderingContext } from "./OscilloscopeRenderer";

/** Ключ, под которым PixiView совмещённой строки хранится в общей карте pixiViews. */
const COMPOSITE_VIEW_KEY = "__composite_row__";

/**
 * Контекст для функций совмещённой строки.
 * Строится классом в getCompositeContext().
 */
export interface CompositeContext {
  table: Table;
  rowsContainer: HTMLElement;
  pixiApp: Application | null;
  pixiViews: Map<string, PixiView>;
  viewerMode: boolean;
  /** Live-чтения состояния совмещённой строки. */
  getCompositeRow: () => CompositeChannelRow | null;
  getCompositeView: () => PixiView | null;
  getCompositeChannels: () => Channel[];
  /** Записать состояние совмещённой строки обратно в класс. */
  setComposite: (
    row: CompositeChannelRow | null,
    view: PixiView | null,
    channels: Channel[],
  ) => void;
  getRenderingContext: () => RenderingContext;
  renderVisibleGraphs: () => void;
}

/**
 * Проверяет, входит ли канал в совмещённую строку, и если да — пересчитывает её высоту.
 * Вызывается из ChannelRow после сохранения свойств канала.
 */
export function checkAndUpdateCompositeHeight(ctx: CompositeContext, channelId: string): void {
  const row = ctx.getCompositeRow();
  const channels = ctx.getCompositeChannels();
  if (!row || !channels) return;

  const isInGroup = channels.some((ch) => ch.id === channelId);
  if (!isInGroup) return;

  const newTotalHeight = channels.reduce((sum, ch) => sum + ch.rowHeight, 0);

  // Обновляем высоту DOM-элемента совмещённой строки.
  row.getElement().style.height = `${newTotalHeight}px`;

  if (ctx.viewerMode) {
    // В просмотрщике обновляем высоту PixiView НАПРЯМУЮ из данных.
    // У .channel-row есть CSS-transition высоты, поэтому getBoundingClientRect()
    // сразу после изменения возвращает СТАРОЕ значение, и syncViewPositions()
    // перезаписал бы bounds старой высотой.
    const view = ctx.getCompositeView();
    if (view) {
      view.updateLayout(
        view.container.x,
        view.container.y,
        view.bounds.width,
        newTotalHeight,
      );
    }
    // Принудительная перерисовка: живой цикл отключён.
    ctx.renderVisibleGraphs();
  } else {
    // В основном осциллографе используем syncViewPositions — живой цикл
    // постоянно вызывает renderVisibleGraphs, и позиция PixiView должна
    // быть синхронизирована через DOM.
    syncViewPositions(ctx.getRenderingContext());
  }
}

/**
 * Создаёт совмещённую строку из массива выбранных каналов (от 2 до 5).
 * Вызывается из обработчика onCreateComposite в OscilloscopeRenderer.
 *
 * ПОСЛЕДОВАТЕЛЬНОСТЬ ДЕЙСТВИЙ:
 * 1) Удаляем предыдущую совмещённую строку, если она была (группа может быть только одна).
 * 2) Создаём CompositeChannelRow и настраиваем колбэки контекстного меню.
 * 3) Добавляем HTML-элемент строки в конец контейнера строк.
 * 4) Создаём общий PixiView для всех каналов группы (ключ '__composite_row__').
 * 5) Скрываем исходные строки выбранных каналов.
 * 6) Сбрасываем состояние выбора анализа (красная подсветка и счётчик).
 * 7) Сохраняем ссылки через setComposite — для renderVisibleGraphs().
 * 8) В просмотрщике — принудительная синхронизация и перерисовка.
 */
export function createCompositeRow(ctx: CompositeContext, channels: Channel[]): void {
  console.log(
    `[Oscilloscope] Создание совмещённой строки из ${channels.length} каналов:`,
    channels.map((ch) => ch.name),
  );

  // ШАГ 1: Удаляем предыдущую совмещённую строку, если она была.
  if (ctx.getCompositeRow()) {
    destroyCompositeRow(ctx);
  }

  // ШАГ 2: Создаём новый объект совмещённой строки.
  // Конструктор создаёт HTML-структуру: колонку имён, легенду и контейнер графика.
  const compositeRow = new CompositeChannelRow(channels);

  // ШАГ 2.1: Настраиваем колбэки для контекстного меню совмещённой строки.
  // Без этого пункты меню будут появляться, но ничего не делать при клике.

  // 1. Разъединить: удаляет совмещённую строку и показывает исходные каналы.
  // ВАЖНО: ctx читается через live-геттеры, поэтому замыкание увидит
  // актуальную строку даже после создания новых групп.
  compositeRow.onDisconnect = () => {
    destroyCompositeRow(ctx);
    syncViewPositions(ctx.getRenderingContext());
  };

  // 2. Свойства: открывает окно свойств для первого канала в группе.
  // Для битовых каналов в совмещённой строке разрешаем кнопку «Сохранить»,
  // чтобы можно было изменить высоту строки.
  compositeRow.onShowProperties = () => {
    if (channels.length > 0) {
      const firstChannel = channels[0];
      const row = ctx.table.getRow(firstChannel.id);
      if (row && typeof row.openProperties === "function") {
        row.openProperties(true); // allowBitSave = true
      }
    }
  };

  // 3. Посчитать коэффициент: эмулируем двойной клик по строке канала.
  compositeRow.onCalculateCoefficient = () => {
    if (channels.length > 0) {
      const firstChannel = channels[0];
      const row = ctx.table.getRow(firstChannel.id);
      if (row) {
        const dblClickEvent = new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        row.getElement().dispatchEvent(dblClickEvent);
      }
    }
  };

  // ШАГ 3: Добавляем элемент строки в конец контейнера строк осциллографа.
  // Строка появится внизу таблицы, ниже всех одиночных каналов.
  ctx.rowsContainer.appendChild(compositeRow.getElement());

  // ШАГ 4: Создаём PixiView для графика совмещённой строки.
  // Вычисляем общую высоту как сумму высот всех каналов (битовые = 25px,
  // аналоговые = их текущая высота).
  const totalHeight = channels.reduce((sum, ch) => sum + ch.rowHeight, 0);

  let compositePixiView: PixiView | null = null;
  if (ctx.pixiApp) {
    compositePixiView = new PixiView(ctx.pixiApp, 0, 0, 300, totalHeight);

    // Добавляем PixiView в общую карту с фиксированным ключом,
    // чтобы syncViewPositions() позиционировал его после одиночных каналов.
    ctx.pixiViews.set(COMPOSITE_VIEW_KEY, compositePixiView);
  }

  // ШАГ 5: Скрываем исходные строки выбранных каналов.
  // Это убирает их из отрисовки в renderVisibleGraphs(), но не удаляет из памяти.
  for (const channel of channels) {
    const row = ctx.table.getRow(channel.id);
    if (row) {
      row.setVisible(false);
    }
  }

  // ШАГ 6: Сбрасываем состояние выбора анализа через статический метод ChannelRow.
  // Это убирает красную подсветку со строк и обнуляет счётчик выбранных.
  (ctx.table.getRow(channels[0].id)?.constructor as any).clearAllAnalysisSelection();

  // ШАГ 7: Сохраняем ссылки для использования в renderVisibleGraphs().
  ctx.setComposite(compositeRow, compositePixiView, channels);

  // ШАГ 8: Принудительная синхронизация позиций и перерисовка для просмотрщика.
  if (ctx.viewerMode) {
    syncViewPositions(ctx.getRenderingContext());
    ctx.renderVisibleGraphs();
  }

  console.log(`[Oscilloscope] Совмещённая строка создана, высота: ${totalHeight}px`);
}

/**
 * Удаляет текущую совмещённую строку и восстанавливает видимость
 * исходных строк каналов, которые были в неё включены.
 * Вызывается из createCompositeRow() перед созданием новой группы
 * и при клике «Разъединить» в меню совмещённой строки.
 */
export function destroyCompositeRow(ctx: CompositeContext): void {
  const row = ctx.getCompositeRow();
  if (!row) return;

  console.log("[Oscilloscope] Удаление совмещённой строки");

  // Восстанавливаем видимость исходных строк всех каналов группы.
  for (const channel of ctx.getCompositeChannels()) {
    const chRow = ctx.table.getRow(channel.id);
    if (chRow) {
      // Сбрасываем высоту всех каналов к дефолтной 25px.
      if (channel.rowHeight !== 25) {
        channel.rowHeight = 25;
        if (typeof (chRow as any).updateHeight === "function") {
          (chRow as any).updateHeight();
        } else {
          chRow.getElement().style.height = "25px";
        }
      }
      chRow.setVisible(true);
    }
  }

  // Удаляем HTML-элемент совмещённой строки из DOM.
  row.remove();

  // Уничтожаем PixiView, чтобы освободить ресурсы WebGL.
  const view = ctx.getCompositeView();
  if (view) {
    view.destroy();
    // Удаляем PixiView из общей карты, чтобы syncViewPositions() больше
    // не пытался его позиционировать.
    ctx.pixiViews.delete(COMPOSITE_VIEW_KEY);
  }

  // Очищаем ссылки.
  ctx.setComposite(null, null, []);

  // Принудительная синхронизация позиций и перерисовка для просмотрщика.
  if (ctx.viewerMode) {
    syncViewPositions(ctx.getRenderingContext());
    ctx.renderVisibleGraphs();
  }
}