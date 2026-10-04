// src/oscilloscope/scope/OscilloscopeRenderer.ts
// Рендеринг графиков каналов и позиционирование контейнеров.
//
// Обработка событий canvas (клики, маркеры, зум, контекстное меню)
// вынесена в OscilloscopeInteraction.ts — здесь только рендеринг
// и раскладка. Публичный API сохранён через реэкспорты в конце файла,
// чтобы внешние модули продолжали импортировать всё из этого файла.

import type { Application } from "pixi.js";
import type { Channel } from "../core/Channel";
import type { Archive } from "../core/Archive";
import type { Renderer } from "../graphics/Renderer";
import { PixiView } from "../graphics/PixiView";
import type { Table } from "../ui/Table";
import type { Toolbar } from "../ui/Toolbar";
import type { BottomPanels } from "../ui/BottomPanels";
import type { Settings } from "../config/Settings";

// Реэкспорт публичного API из OscilloscopeInteraction.ts — обратная
// совместимость импортов для Oscilloscope.ts, OscilloscopeChannels.ts,
// OscilloscopeLifecycle.ts.
export {
  measureChannelAtTime,
  formatIntervalDuration,
  updateIntervalDisplay,
  bindSharedCanvasEvents,
} from "./OscilloscopeInteraction";

export interface RenderingContext {
  visibleChannels: Channel[];
  allChannels: Channel[];
  pixiViews: Map<string, PixiView>;
  pixiApp: Application | null;
  graphColumnOffset: number;
  table: Table;
  renderer: Renderer;
  archive: Archive;
  settings: Settings;
  rowsContainer: HTMLElement;
  bottomPanels: BottomPanels;
  toolbar: Toolbar;
  isDestroyed: boolean;
  selectedChannel: Channel | null;
  setSelectedChannel: (ch: Channel | null) => void;
  onChannelDeleted: (ch: Channel) => void;
  onToggleBit: (ch: Channel) => void;

  // Callback для создания совмещённой строки из нескольких каналов.
  // Устанавливается главным классом Oscilloscope в методе getRenderingContext().
  // Вызывается из обработчика row.onCreateComposite при клике «Совместить» в меню.
  // Принимает массив выбранных каналов и делегирует создание совмещённой строки
  // (CompositeChannelRow) главному классу осциллографа.
  onCreateComposite: (channels: Channel[]) => void;

  // Метод для выбора канала или совмещённой строки по координате Y клика.
  // Инкапсулирует логику определения: попал ли клик в обычный канал
  // или в область совмещённой строки. Вызывается из обработчика клика по canvas.
  selectAtClientY: (clientY: number) => void;

  // Ссылка на текущую совмещённую строку (если создана).
  // Используется обработчиком правого клика на канвасе для открытия меню.
  compositeRow: any;
}

export async function renderVisibleChannels(
  ctx: RenderingContext,
): Promise<void> {
  if (ctx.isDestroyed || !ctx.table) return;

  ctx.pixiViews.forEach((view) => {
    try {
      view.destroy();
    } catch (err) {
      console.warn("[Oscilloscope] Failed to destroy old PixiView:", err);
    }
  });

  ctx.pixiViews.clear();
  const tempPixiViews: Map<string, PixiView> = new Map();

  const savedScrollTop = ctx.rowsContainer.scrollTop;

  ctx.table.clear();
  for (const channel of ctx.visibleChannels) {
    if (ctx.isDestroyed) break;
    const row = ctx.table.addChannel(channel);

    row.onChannelUpdated = () => {
      const allAutoScale = ctx.allChannels.every((ch) => ch.autoScale);
      ctx.toolbar.setAutoScaleButtonState(allAutoScale);
      // Могла измениться высота строки или её видимость —
      // пересинхронизируем позиции и размеры контейнеров графиков
      syncViewPositions(ctx);
    };

    row.onDelete = (deletedChannel) => {
      ctx.onChannelDeleted(deletedChannel);
    };

    row.onSelect = (selectedChannel: Channel) => {
      ctx.setSelectedChannel(selectedChannel);
      ctx.bottomPanels.setCommandText(`${selectedChannel.name} = `);
    };

    row.onToggleBit = (toggledChannel: Channel) => {
      ctx.onToggleBit(toggledChannel);
    };

    // Обработчик создания совмещённой строки из нескольких каналов.
    // Вызывается при клике на пункт меню «Совместить» в контекстном меню строки канала.
    // Получает массив выбранных каналов и должен создать CompositeChannelRow,
    // добавить её в DOM и скрыть исходные строки выбранных каналов.
    row.onCreateComposite = (channels: Channel[]) => {
      // Делегируем создание совмещённой строки главному классу Oscilloscope.
      // Он сам управляет всем жизненным циклом: создаёт CompositeChannelRow,
      // добавляет его в DOM, создаёт общий PixiView, скрывает исходные строки
      // выбранных каналов и сбрасывает состояние выбора анализа.
      ctx.onCreateComposite(channels);
    };

    if (ctx.pixiApp) {
      const pixiView = new PixiView(ctx.pixiApp, 0, 0, 300, channel.rowHeight);
      tempPixiViews.set(channel.id, pixiView);
    }
  }

  if (!ctx.isDestroyed) {
    ctx.pixiViews.clear();
    tempPixiViews.forEach((view, id) => {
      ctx.pixiViews.set(id, view);
    });

    syncViewPositions(ctx);

    requestAnimationFrame(() => {
      ctx.rowsContainer.scrollTop = savedScrollTop;
      syncViewPositions(ctx);
    });
  }
}

/** Позиционирует контейнеры каналов по вертикали с учётом скролла и ширины колонки графиков. */
export function syncViewPositions(ctx: RenderingContext): void {
  const firstRow = ctx.rowsContainer.querySelector(".channel-row");
  const host = ctx.rowsContainer.parentElement as HTMLElement;
  const baseEl = firstRow ?? host.querySelector("#header");
  const graphEl = baseEl ? (baseEl.querySelector(".col-graph") as HTMLElement | null) : null;
  const width = graphEl
    ? Math.max(50, Math.round(graphEl.getBoundingClientRect().width))
    : 300;

  let yOffset = 0;
  const scrollTop = ctx.rowsContainer.scrollTop;

  // ========================================================================
  // ПОЗИЦИОНИРОВАНИЕ ОДИНОЧНЫХ КАНАЛОВ (только видимых)
  // ========================================================================
  // Позиционируем графики только тех каналов, чьи строки сейчас видимы.
  // Если строка скрыта (например, входит в совмещённую группу), её график
  // НЕ должен занимать место в общей сетке координат.
  //
  // Проверка видимости: используем метод getRow().getIsVisible(), который
  // возвращает false для строк, скрытых при создании совмещённой группы.
  // ========================================================================
  for (const channel of ctx.visibleChannels) {
    const row = ctx.table.getRow(channel.id);
    const view = ctx.pixiViews.get(channel.id);

    // Пропускаем скрытые строки — их графики не должны позиционироваться.
    if (!row || !row.getIsVisible()) {
      continue;
    }

    if (view) {
      view.updateLayout(0, yOffset - scrollTop, width, channel.rowHeight);
    }
    yOffset += channel.rowHeight;
  }

  // ========================================================================
  // ПОЗИЦИОНИРОВАНИЕ СОВМЕЩЁННОЙ СТРОКИ
  // ========================================================================
  // Если существует совмещённая строка (определяем по наличию специального
  // ключа в карте pixiViews), позиционируем её PixiView после всех одиночных
  // каналов. Координата Y вычисляется как сумма высот всех видимых каналов.
  //
  // КЛЮЧ СОХРАНЕНИЯ:
  // Совмещённая строка сохраняется в карте ctx.pixiViews с ключом '__composite_row__'.
  // Это позволяет этой функции работать без дополнительных параметров.
  // ========================================================================
  const compositeView = ctx.pixiViews.get('__composite_row__');
  if (compositeView) {
    // Находим высоту совмещённой строки через DOM-элемент.
    const compositeRowElement = ctx.rowsContainer.querySelector('.composite-row');
    if (compositeRowElement) {
      const compositeHeight = compositeRowElement.getBoundingClientRect().height;
      compositeView.updateLayout(0, yOffset - scrollTop, width, compositeHeight);
    }
  }
}