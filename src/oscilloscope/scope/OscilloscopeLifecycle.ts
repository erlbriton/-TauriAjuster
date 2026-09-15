// src/oscilloscope/scope/OscilloscopeLifecycle.ts
// ============================================================================
// Жизненный цикл осциллографа: статус соединения, разрушение,
// заморозка/возобновление рендер-цикла. Вынесено из класса Oscilloscope.
// ============================================================================

import type { Oscilloscope } from "../Oscilloscope";
import { Layout } from "../ui/Layout";
import { TimelineScrollbar } from "../ui/TimelineScrollbar";
import { Table } from "../ui/Table";
import { Toolbar } from "../ui/Toolbar";
import { Resizer } from "../ui/Resizer";
import { IniPanel } from "../ui/IniPanel";
import { BottomPanels } from "../ui/BottomPanels";
import { CursorsFooter } from "../ui/CursorsFooter";
import { ConnectionModal } from "../ui/ConnectionModal";
import { PropertiesModal } from "../ui/PropertiesModal";
import { SearchPanel } from "../ui/SearchPanel";
import { Application } from "pixi.js";
import { bindEvents, bindTimeZoomWheel } from "./OscilloscopeBindings";
import { bindSharedCanvasEvents, syncViewPositions } from "./OscilloscopeRenderer";
import {
  updateGraphColumnOffset as canvasUpdateOffset,
  updateCanvasPosition as canvasUpdatePosition,
} from "./OscilloscopeCanvas";

export function setConnectionStatus(osc: Oscilloscope, connected: boolean, message?: string): void {
  if (osc.isDestroyed) return;

  if (osc.toolbar) {
    osc.toolbar.updateStatus(connected);
  }

  if (connected) {
    if (!osc.connectionLost) return;
    osc.connectionLost = false;
    osc.connectionModal.close();
    osc.isRunning = true;
    osc.lastFrameTime = performance.now();
    // Возобновляем рендер-цикл, если он не запущен
    if (osc.animFrameId === null) {
      osc.animFrameId = requestAnimationFrame((t) => osc.loop(t));
    }
    if (osc.settings.isPolling) {
      if (osc.serial) {
        osc.serial.resumePolling();
      }
    }
  } else {
    if (osc.connectionLost) return;
    osc.connectionLost = true;
    osc.isRunning = false;
    // ПРИНУДИТЕЛЬНО останавливаем рендер-цикл: отменяем запланированный кадр
    if (osc.animFrameId !== null) {
      cancelAnimationFrame(osc.animFrameId);
      osc.animFrameId = null;
    }
    // Показываем модальное окно ТОЛЬКО если message не пустая строка
    // (пустая строка = ручной разрыв без предупреждения)
    if (message !== '') {
      osc.connectionModal.show(message ?? "Связь с устройством потеряна.");
    }
  }
}

export function destroy(osc: Oscilloscope): void {
  osc.isDestroyed = true;
  osc.isRunning = false;
  osc.connectionModal?.close();
  if (osc.statsTimerId !== null) {
    clearInterval(osc.statsTimerId);
    osc.statsTimerId = null;
  }
  if (osc.animFrameId !== null) {
    cancelAnimationFrame(osc.animFrameId);
    osc.animFrameId = null;
  }
  osc.pixiViews.forEach((view) => {
    try {
      view.destroy();
    } catch (err) {
      console.warn("[Oscilloscope] Failed to destroy PixiView:", err);
    }
  });
  osc.pixiViews.clear();
  if (osc.targetRoot) {
    osc.targetRoot.innerHTML = "";
  }
}

export function showFrozenState(osc: Oscilloscope, message: string): void {
  if (osc.isDestroyed) return;
  // Только останавливаем рендер-цикл. Окно показывает UI-слой (uiManager).
  osc.isRunning = false;
  if (osc.animFrameId !== null) {
    cancelAnimationFrame(osc.animFrameId);
    osc.animFrameId = null;
  }
}

export function resumeFromFrozen(osc: Oscilloscope): void {
  if (osc.isDestroyed) return;

  // Закрываем окно, если оно было открыто именно этим методом
  if (osc.connectionModal.isOpen) {
    osc.connectionModal.close();
  }

  // Запускаем рендер-цикл
  osc.isRunning = true;
  osc.lastFrameTime = performance.now();
  if (osc.animFrameId === null) {
    osc.animFrameId = requestAnimationFrame((t) => osc.loop(t));
  }
}
export async function initialize(osc: Oscilloscope, targetContainer?: HTMLElement | string): Promise<void> {
  if (osc.targetRoot) return;
  let rootElement: HTMLElement | null = null;
  if (typeof targetContainer === "string") {
    rootElement = document.querySelector(targetContainer);
  } else if (targetContainer instanceof HTMLElement) {
    rootElement = targetContainer;
  }
  if (!rootElement) {
    rootElement = document.getElementById("root") || document.body;
  }
  osc.targetRoot = rootElement;
  osc.isDestroyed = false;
  osc.settings.applyCSSTemplateVariables();
  const layoutElements = Layout.createSkeleton(rootElement);
  osc.splitContainer = layoutElements.splitContainer;
  if (osc.viewerMode) {
    // В просмотрщике осциллограф всегда на всю ширину
    osc.splitContainer.classList.remove("half-window-left");
  }

  osc.timelineScrollbar = new TimelineScrollbar(layoutElements.timelineContainer);
  osc.timelineScrollbar.onChange((timestamp) => {
    if (osc.timelineScrollbar.isAtLivePosition() && osc.settings.isPolling) {
      osc.settings.followLive();
    } else {
      osc.settings.setViewTime(timestamp);
    }
  });
  osc.table = new Table(layoutElements.rowsContainer);
  osc.toolbar = new Toolbar(
    layoutElements.toolbarContainer,
    osc.settings,
    osc.recorder,
    osc.serial,
  );
  osc.toolbar.initialize();
  osc.toolbar.setAutoScaleButtonState(true);
  if (osc.viewerMode) {
    osc.toolbar.applyViewerMode();
    // Принудительно растягиваем осциллограф на всю ширину в просмотрщике
    osc.splitContainer.classList.remove("half-window-left");
    osc.splitContainer.style.width = "100%";
    const oscRoot = rootElement.firstElementChild as HTMLElement | null;
    if (oscRoot) oscRoot.style.width = "100%";
    // Просмотрщик: отключаем "живой" режим, иначе маркеры плывут
    osc.settings.isPolling = false;
  }
  osc.resizer = new Resizer(osc.settings, layoutElements.headerContainer);
  // При изменении ширины колонок пересинхронизируем позиции и ширину графиков.
  osc.resizer.onResize = () => {
    canvasUpdateOffset(osc.getCanvasContext());
    // Обновляем размер и позицию самого canvas-overlay И pixi-рендерера.
    // Без этого графики "застрянут" со старой шириной до прокрутки.
    osc.syncCanvasLayout();
    syncViewPositions(osc.getRenderingContext());
  };
  osc.resizer.initialize();
  osc.iniPanel = new IniPanel(layoutElements.iniPanelContainer);
  osc.bottomPanels = new BottomPanels(layoutElements.bottomPanelsContainer);
  osc.cursorsFooter = new CursorsFooter(layoutElements.footerContainer);
  osc.statsTimerId = window.setInterval(() => {
    const hz = osc.drawCallCount / 5;
    osc.lastReportedHz = hz;
    osc.drawCallCount = 0;
    osc.cursorsFooter?.setStats(osc.allChannels.length, hz);
  }, 5000);
  osc.rowsContainer = layoutElements.rowsContainer;
  osc.propertiesModal = new PropertiesModal();

  // Делаем экземпляр осциллографа доступным глобально для доступа из UI-компонентов (модалок).
  (window as any).osc = osc;
  osc.connectionModal = new ConnectionModal();
  bindEvents(osc.getBindingsContext());
  bindTimeZoomWheel(osc.getBindingsContext(), osc.rowsContainer);

  // Создаём единое PixiJS приложение для всего осциллографа
  osc.pixiApp = new Application();
  await osc.pixiApp.init({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  // Создаём персональную обёртку поверх колонки графиков.
  // Обёртка управляется только нашими инлайн-стилями,
  // а canvas растягивается внутри неё штатным CSS приложения.
  const canvasHost = osc.rowsContainer.parentElement as HTMLElement;
  canvasHost.style.position = 'relative';
  osc.canvasOverlay = document.createElement('div');
  osc.canvasOverlay.style.position = 'absolute';
  osc.canvasOverlay.style.overflow = 'hidden';
  osc.canvasOverlay.style.zIndex = '5';
  canvasHost.appendChild(osc.canvasOverlay);
  osc.canvasOverlay.appendChild(osc.pixiApp.canvas);
  osc.syncCanvasLayout();

  // Синхронизируем размер и позицию canvas с rowsContainer
  const resizeObserver = new ResizeObserver(() => {
    osc.syncCanvasLayout();
    syncViewPositions(osc.getRenderingContext());
  });
  resizeObserver.observe(osc.rowsContainer);

  // Синхронизируем canvas и контейнеры при скролле из ЛЮБОГО источника:
  // колесо мыши, перетаскивание скроллбара, клавиатура
  osc.rowsContainer.addEventListener('scroll', () => {
    canvasUpdatePosition(osc.getCanvasContext());
    syncViewPositions(osc.getRenderingContext());
  });

  // Вычисляем отступ до колонки графиков
  canvasUpdateOffset(osc.getCanvasContext());

  // Навешиваем обработчики мыши на rowsContainer для работы с маркерами
  bindSharedCanvasEvents(() => osc.getRenderingContext());

  osc.isRunning = true;
  osc.lastFrameTime = performance.now();
  osc.animFrameId = requestAnimationFrame((t) => osc.loop(t));

  osc.searchPanel = new SearchPanel();
  osc.searchPanel.onSelect = (item) => {
    document.querySelectorAll(".channel-row.selected").forEach((el) => {
      el.classList.remove("selected");
    });
    const row = osc.table.getRow(item.id);
    if (row) {
      const rowElement = row.getElement();
      rowElement.classList.add("selected");
      rowElement.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };
  window.addEventListener("oscilloscope-search", () => {
    osc.searchPanel.open(osc.allChannels);
  });
}