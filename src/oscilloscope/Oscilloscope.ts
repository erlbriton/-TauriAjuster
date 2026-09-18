// src/oscilloscope/Oscilloscope.ts

import { Channel, ChannelConfig, parseModbusReg } from "./core/Channel.js";
import { Archive } from "./core/Archive";
import { Recorder } from "./core/Recorder";
import { Settings } from "./config/Settings";
import { Serial } from "./comm/Serial";
import { Table } from "./ui/Table";
import { Toolbar } from "./ui/Toolbar";
import { Resizer } from "./ui/Resizer";
import { Layout } from "./ui/Layout";
import { IniPanel, IniFileItem } from "./ui/IniPanel";
import { Renderer } from "./graphics/Renderer";
import { PixiView } from "./graphics/PixiView";
// Импортируем класс совмещённой строки, который объединяет несколько каналов
// (от 2 до 5) в одну систему координат для детального анализа сигналов.
// Используется в обработчике onCreateComposite при клике «Совместить» в меню.
import { CompositeChannelRow } from "./ui/CompositeChannelRow";
import {
  IniParser as CoreIniParser,
  IniConfig,
  iniParamsToChannelConfigs,
} from "../core/ini/index.js";
import { PropertiesModal } from "./ui/PropertiesModal";
import { BottomPanels, ReadoutSlot } from "./ui/BottomPanels";
import { CursorsFooter } from "./ui/CursorsFooter";
import { ConnectionModal } from "./ui/ConnectionModal";
import { TimelineScrollbar } from "./ui/TimelineScrollbar";
import type { WebSerialPort } from "../serial/web-serial-types.js";
import { TauriFileSaver } from "../core/platform/tauri-fs.js"; // <-- ИЗМЕНЕНО: заменен импорт
import { buildWriteMultipleRegistersRequest } from "../serial/modbus.js";
import { handleCommandSubmit, handleMultiplyCommand, type CommandContext } from "./scope/OscilloscopeCommands";
import { 
  renderVisibleChannels, updateIntervalDisplay, 
  measureChannelAtTime, formatIntervalDuration, 
  syncViewPositions, bindSharedCanvasEvents,
  type RenderingContext } from "./scope/OscilloscopeRenderer";
import { bindEvents, bindTimeZoomWheel, updateTimeScaleReadout, type BindingsContext } from "./scope/OscilloscopeBindings";
import {
  getGraphColumnMetrics as canvasMetrics,
  updateGraphColumnOffset as canvasUpdateOffset,
  updateCanvasPosition as canvasUpdatePosition,
  syncCanvasLayout as canvasSyncLayout,
  type CanvasContext,
} from "./scope/OscilloscopeCanvas";
import {
  createCompositeRow as compositeCreateRow,
  checkAndUpdateCompositeHeight as compositeCheckHeight,
  type CompositeContext,
} from "./scope/OscilloscopeComposite";
import {
  draw as loopDraw,
  loop as loopTick,
  renderVisibleGraphs as loopRenderGraphs,
  type LoopContext,
} from "./scope/OscilloscopeLoop";
import {
  setChannels as channelsSetChannels,
  updateVisibleChannels as channelsUpdateVisible,
  setIniFiles as channelsSetIniFiles,
  applyChannelConfigs as channelsApplyConfigs,
  loadIniContent as channelsLoadIniContent,
  setActiveIni as channelsSetActiveIni,
} from "./scope/OscilloscopeChannels";
import {
  setConnectionStatus as lifecycleSetConnectionStatus,
  destroy as lifecycleDestroy,
  showFrozenState as lifecycleShowFrozenState,
  resumeFromFrozen as lifecycleResumeFromFrozen,
  initialize as lifecycleInitialize,
} from "./scope/OscilloscopeLifecycle";
import type { AppState } from "../core/app-state.js";
import { Application } from 'pixi.js';
import { SearchPanel } from './ui/SearchPanel';


export class Oscilloscope {
  public settings: Settings;
  public archive: Archive;
  public serial: Serial | null;
  public recorder: Recorder | null;
  public viewerMode: boolean = false;
  public table!: Table;
  public toolbar!: Toolbar;
  public resizer!: Resizer;
  private renderer!: Renderer;
  public iniPanel!: IniPanel;
  public bottomPanels!: BottomPanels;
  public cursorsFooter!: CursorsFooter;
  public searchPanel!: SearchPanel;
  public connectionModal!: ConnectionModal;
  public timelineScrollbar!: TimelineScrollbar;
  public connectionLost: boolean = false;
  public rowsContainer!: HTMLElement;
  public splitContainer!: HTMLElement;
  public allChannels: Channel[] = [];
  public visibleChannels: Channel[] = [];
  public pixiViews: Map<string, PixiView> = new Map();
  public isRunning: boolean = false;
  public lastFrameTime: number = 0;
  public propertiesModal!: PropertiesModal;
  public availableIniFiles: IniFileItem[] = [];
  public currentIniId: string | null = null;
  public animFrameId: number | null = null;
  private lastRenderTime: number = 0;
  private lastRenderSignature: string = "";
  public drawCallCount: number = 0;
  public lastReportedHz: number = 0;
  public statsTimerId: number | null = null;
  public targetRoot: HTMLElement | null = null;
  public isDestroyed: boolean = false;
  public lastLoadedIniContent: string | null = null;
  private selectedChannel: Channel | null = null;
  private slaveAddress: number = 1;
  private externalSerial: { write(data: Uint8Array): Promise<void> } | null = null;
  private onPollingStateChangeCallback?: (isPolling: boolean) => void;
  public currentIniConfig: IniConfig | null = null;
  private appState: AppState | null = null;
  public pixiApp: Application | null = null;
  private graphColumnOffset: number = 0;
  public canvasOverlay: HTMLDivElement | null = null;
  
  // ========================================================================
  // СОВМЕЩЁННАЯ СТРОКА (Composite Channel Row)
  // ========================================================================
  // Поля для хранения текущей совмещённой строки и её PixiView.
  // В текущей реализации поддерживается только одна совмещённая строка
  // одновременно (согласно требованиям заказчика).
  // Если пользователь создаст новую совмещённую группу, старая будет
  // автоматически удалена (или можно добавить проверку в будущем).
  
  // Экземпляр текущей совмещённой строки. null означает, что сейчас
  // совмещённой строки нет. Хранится здесь, чтобы метод renderVisibleGraphs
  // мог отрисовать её наравне с обычными каналами.
  private compositeRow: CompositeChannelRow | null = null;
  
  // PixiView для отрисовки графиков в совмещённой строке.
  // Хранится отдельно от основной карты pixiViews, чтобы не смешивать
  // обычные каналы и совмещённую группу. Это также упрощает удаление
  // совмещённой строки при её разгруппировке.
  private compositePixiView: PixiView | null = null;
  
  // Массив каналов, которые входят в текущую совмещённую группу.
  // Нужен для отрисовки всех этих каналов в один PixiView в методе
  // renderVisibleGraphs. Если compositeRow === null, массив пустой.
  private compositeChannels: Channel[] = [];

    constructor(options?: { skipSerial?: boolean; skipRecorder?: boolean; viewerMode?: boolean }) {
    this.settings = new Settings();
    this.archive = new Archive();
    this.viewerMode = options?.viewerMode ?? false;    
    if (options?.skipSerial) {
      this.serial = null;
    } else {
      this.serial = new Serial(this.archive);
    }
    
    if (options?.skipRecorder) {
      this.recorder = null;
    } else {
      this.recorder = new Recorder(this.archive, new TauriFileSaver()); // <-- ИЗМЕНЕНО: заменен класс
    }
    
    this.renderer = new Renderer(this.settings, this.archive);
  }

  public setSerialPort(port: unknown): void {
    if (port && typeof (port as { write: unknown }).write === "function") {
      this.externalSerial = port as { write(data: Uint8Array): Promise<void> };
      console.log("[Oscilloscope] External serial port attached.");
    } else {
      this.externalSerial = null;
      console.warn("[Oscilloscope] Invalid serial port object.");
    }
  }

  public setOnPollingStateChange(cb: (isPolling: boolean) => void): void {
    this.onPollingStateChangeCallback = cb;
  }
public setAppState(state: AppState): void {
    this.appState = state;
  }

  public getAppState(): AppState {
    if (!this.appState) {
      throw new Error("[Oscilloscope] AppState is not set. Call setAppState() first.");
    }
    return this.appState;
  }

  public async initialize(
    targetContainer?: HTMLElement | string,
  ): Promise<void> {
    return lifecycleInitialize(this, targetContainer);
  }
  
  /**
   * Строит контекст для канвас-функций (scope/OscilloscopeCanvas).
   * Состояние не копируется — передаются живые ссылки и сеттер.
   */
  public getCanvasContext(): CanvasContext {
    return {
      rowsContainer: this.rowsContainer,
      pixiApp: this.pixiApp,
      canvasOverlay: this.canvasOverlay,
      setGraphColumnOffset: (value) => { this.graphColumnOffset = value; },
    };
  }

  /** Публичная обёртка: синхронизация размера/позиции canvas (внешний API не менялся). */
  public syncCanvasLayout(): void {
    canvasSyncLayout(this.getCanvasContext());
  }

  public getPixiApp(): Application | null {
    return this.pixiApp;
  }

  public getGraphColumnOffset(): number {
    return this.graphColumnOffset;
  }

  /** Принимает новые значения параметров. Делегирует в scope/OscilloscopeLoop. */
  public draw(data: Record<string, number>): void {
    loopDraw(this.getLoopContext(), data);
  }

  /**
   * Строит контекст кадрового цикла (scope/OscilloscopeLoop).
   * Тайминг-состояние остаётся на классе — им делится lifecycle.
   */
  private getLoopContext(): LoopContext {
    return {
      isDestroyed: this.isDestroyed,
      isRunning: this.isRunning,
      table: this.table ?? null,
      archive: this.archive,
      settings: this.settings,
      timelineScrollbar: this.timelineScrollbar ?? null,
      toolbar: this.toolbar ?? null,
      viewerMode: this.viewerMode,
      renderer: this.renderer,
      rowsContainer: this.rowsContainer ?? null,
      pixiViews: this.pixiViews,
      getVisibleChannels: () => this.visibleChannels,
      getAllChannels: () => this.allChannels,
      getCompositeRow: () => this.compositeRow,
      getCompositeView: () => this.compositePixiView,
      getCompositeChannels: () => this.compositeChannels,
      getDrawCallCount: () => this.drawCallCount,
      setDrawCallCount: (v) => { this.drawCallCount = v; },
      getLastRenderSignature: () => this.lastRenderSignature,
      setLastRenderSignature: (v) => { this.lastRenderSignature = v; },
      getLastRenderTime: () => this.lastRenderTime,
      setLastRenderTime: (v) => { this.lastRenderTime = v; },
      setLastFrameTime: (v) => { this.lastFrameTime = v; },
      setAnimFrameId: (v) => { this.animFrameId = v; },
    };
  }

  public setIniFiles(files: IniFileItem[]): void {
    channelsSetIniFiles(this, files);
  }

  public setActiveIni(id: string, loadContent: boolean = true): void {
    channelsSetActiveIni(this, id, loadContent);
  }

  public setSlaveAddress(addr: number): void {
    this.slaveAddress = addr;
  }

  public setConnectionStatus(connected: boolean, message?: string): void {
    lifecycleSetConnectionStatus(this, connected, message);
  }

  public destroy(): void {
    lifecycleDestroy(this);
  }

  public async loadIniContent(iniContent: string): Promise<void> {
    return channelsLoadIniContent(this, iniContent);
  }

  public async applyChannelConfigs(configs: ChannelConfig[]): Promise<void> {
    return channelsApplyConfigs(this, configs);
  }

  public async setChannels(newChannels: Channel[]): Promise<void> {
    return channelsSetChannels(this, newChannels);
  }

  /** Публичный доступ к внутреннему архиву (для просмотрщика .rec) */
  public getArchive(): Archive {
    return this.archive;
  }
  /** Возвращает массив всех каналов (для просмотрщика и внешних модулей) */
  public getAllChannels(): Channel[] {
    return this.allChannels;
  }
  /** Добавляет свою кнопку в тулбар (режим просмотрщика) */
  public addViewerButton(label: string, title: string, onClick: () => void): void {
    this.toolbar.appendCustomButton(label, title, onClick);
  }

  /** Финальная настройка тулбара для просмотрщика */
  public finalizeViewerToolbar(): void {
    this.toolbar.finalizeViewerLayout();
  }

  /** Фиксирует время просмотра (выключает "живой" режим, маркеры застывают) */
  public setViewTime(t: number): void {
    this.settings.setViewTime(t);
  }

  public async updateVisibleChannels(
    newVisibleChannels: Channel[],
  ): Promise<void> {
    return channelsUpdateVisible(this, newVisibleChannels);
  }

  private getCommandContext(): CommandContext {
    return {
      selectedChannel: this.selectedChannel,
      externalSerial: this.externalSerial,
      slaveAddress: this.slaveAddress,
      bottomPanels: this.bottomPanels,
    };
  }

    public getBindingsContext(): BindingsContext {
    return {
      settings: this.settings,
      getChannels: () => this.allChannels,
      getVisibleChannels: () => this.visibleChannels,
      pixiViews: this.pixiViews,
      propertiesModal: this.propertiesModal,
      splitContainer: this.splitContainer,
      toolbar: this.toolbar,
      serial: this.serial,
      iniPanel: this.iniPanel,
      recorder: this.recorder,
      cursorsFooter: this.cursorsFooter,
      bottomPanels: this.bottomPanels,
      renderer: this.renderer,
      isDestroyed: this.isDestroyed,
      notifyPollingStateChange: (isPolling: boolean) => {
        if (this.onPollingStateChangeCallback) {
          this.onPollingStateChangeCallback(isPolling);
        }
      },
      updateVisibleChannels: (newVisible) => this.updateVisibleChannels(newVisible),
      loadIniContent: (content) => this.loadIniContent(content),
      setConnectionStatus: (connected, msg) => this.setConnectionStatus(connected, msg),
      getCommandContext: () => this.getCommandContext(),
      getCurrentIniConfig: () => this.currentIniConfig,
      getAppState: () => this.getAppState(),
    };
  }

  public getRenderingContext(): RenderingContext {
    return {
      visibleChannels: this.visibleChannels,
      allChannels: this.allChannels,
      pixiViews: this.pixiViews,
      pixiApp: this.pixiApp,
      graphColumnOffset: this.graphColumnOffset,
      table: this.table,
      renderer: this.renderer,
      archive: this.archive,
      settings: this.settings,
      rowsContainer: this.rowsContainer,
      bottomPanels: this.bottomPanels,
      toolbar: this.toolbar,
      isDestroyed: this.isDestroyed,
      selectedChannel: this.selectedChannel,
      setSelectedChannel: (ch) => { this.selectedChannel = ch; },
      onChannelDeleted: (ch) => {
        this.updateVisibleChannels(
          this.visibleChannels.filter((c) => c.id !== ch.id),
        );
      },
      onToggleBit: (ch) => {
        const newVal = ch.scaledValue === 0 ? 1 : 0;
        void handleCommandSubmit(this.getCommandContext(), `${ch.name} = ${newVal}`);
      },
      
      // Реализация callback'а создания совмещённой строки.
      // Делегирует вызов методу createCompositeRow() этого класса, который
      // управляет всем жизненным циклом совмещённой строки: создание,
      // добавление в DOM, создание PixiView, скрытие исходных строк
      // и сброс состояния выбора анализа.
      onCreateComposite: (channels) => {
        this.createCompositeRow(channels);
      },
      
      // Реализация выбора канала или совмещённой строки по координате Y.
      // Сначала пытаемся найти обычный канал. Если не нашли — проверяем,
      // не попал ли клик в область совмещённой строки.
      selectAtClientY: (clientY) => {
        // Сначала пытаемся найти обычный канал (видимый)
        const rowsRect = this.rowsContainer.getBoundingClientRect();
        const scrollTop = this.rowsContainer.scrollTop;
        const y = clientY - rowsRect.top + scrollTop;
        let acc = 0;
        
        for (const ch of this.visibleChannels) {
          const row = this.table.getRow(ch.id);
          if (!row || !row.getIsVisible()) continue;
          
          acc += ch.rowHeight;
          if (y < acc) {
            // Нашли обычный канал — кликаем по его строке
            row.getElement().click();
            return;
          }
        }
        
        // Если обычный канал не найден, проверяем совмещённую строку
        if (this.compositeRow && this.compositeRow.getIsVisible()) {
          const compositeRect = this.compositeRow.getElement().getBoundingClientRect();
          if (clientY >= compositeRect.top && clientY <= compositeRect.bottom) {
            // Клик попал в совмещённую строку — выбираем её
            this.compositeRow.getElement().click();
          }
        }
      },

      // Передаем ссылку на совмещённую строку в контекст рендеринга.
      // Это необходимо для обработки правого клика по области графиков.
      compositeRow: this.compositeRow || null,
    };
  }

  /** Кадровый цикл (запускается из lifecycle-функций и initialize). */
  public loop(now: number): void {
    loopTick(this.getLoopContext(), now);
  }

  /** Публичная обёртка: отрисовка видимых графиков (вызывает ChannelRow). */
  public renderVisibleGraphs(): void {
    loopRenderGraphs(this.getLoopContext());
  }

  // ========================================================================
  // СОЗДАНИЕ СОВМЕЩЁННОЙ СТРОКИ (Composite Channel Row)
  // ========================================================================
  // Метод создаёт совмещённую строку из массива выбранных каналов (от 2 до 5).
  // Вызывается из обработчика onCreateComposite в OscilloscopeRenderer.
  //
  // ПОСЛЕДОВАТЕЛЬНОСТЬ ДЕЙСТВИЙ:
  // 1) Удаляем предыдущую совмещённую строку, если она была.
  //    Это предотвращает накопление совмещённых групп (в требованиях указано,
  //    что несколько групп быть не может).
  // 2) Создаём новый объект CompositeChannelRow с переданными каналами.
  // 3) Добавляем HTML-элемент совмещённой строки в контейнер строк осциллографа.
  // 4) Создаём общий PixiView для всех каналов совмещённой строки.
  // 5) Скрываем исходные строки выбранных каналов (пользователь видит только
  //    совмещённую строку с легендой).
  // 6) Сбрасываем состояние выбора анализа (убираем красную подсветку и счётчик),
  //    чтобы пользователь мог выбрать новую группу после создания этой.
  // 7) Сохраняем ссылки на совмещённую строку, её PixiView и массив каналов,
  //    чтобы метод renderVisibleGraphs() мог отрисовать её.
  //
  // ПРИМЕЧАНИЕ: На этом шаге график в совмещённой строке пока пустой,
  // так как вызов renderCompositeGraph() будет добавлен в следующем шаге.
  // ========================================================================
  /**
   * Строит контекст для функций совмещённой строки (scope/OscilloscopeComposite).
   * Состояние читается через live-геттеры, чтобы замыкания (onDisconnect и т.п.),
   * срабатывающие позже, всегда видели актуальные значения.
   */
  private getCompositeContext(): CompositeContext {
    return {
      table: this.table,
      rowsContainer: this.rowsContainer,
      pixiApp: this.pixiApp,
      pixiViews: this.pixiViews,
      viewerMode: this.viewerMode,
      getCompositeRow: () => this.compositeRow,
      getCompositeView: () => this.compositePixiView,
      getCompositeChannels: () => this.compositeChannels,
      setComposite: (row, view, channels) => {
        this.compositeRow = row;
        this.compositePixiView = view;
        this.compositeChannels = channels;
      },
      getRenderingContext: () => this.getRenderingContext(),
      renderVisibleGraphs: () => this.renderVisibleGraphs(),
    };
  }

  /** Публичная обёртка: пересчёт высоты совмещённой строки (вызывает ChannelRow). */
  public checkAndUpdateCompositeHeight(channelId: string): void {
    compositeCheckHeight(this.getCompositeContext(), channelId);
  }

  /** Публичная обёртка: создание совмещённой строки из выбранных каналов. */
  public createCompositeRow(channels: Channel[]): void {
    compositeCreateRow(this.getCompositeContext(), channels);
  }

  public showFrozenState(message: string): void {
    lifecycleShowFrozenState(this, message);
  }

  /**
   * Возобновляет работу после "заморозки".
   * Запускает рендер-цикл и закрывает окно.
   */
  public resumeFromFrozen(): void {
    lifecycleResumeFromFrozen(this);
  }
}