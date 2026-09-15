// src/oscilloscope/ui/Toolbar.ts

import { Settings } from "../config/Settings";
import { Recorder } from "../core/Recorder";
import { Serial } from "../comm/Serial";
import { ToolbarComponents } from "./ToolbarComponents";

export class Toolbar {
  private container: HTMLElement;
  private settings: Settings;
  private recorder: Recorder | null;
  private serial: Serial | null;

  private autoscaleBtn!: HTMLButtonElement;
  private amplitudeBtn!: HTMLButtonElement;
  private intervalBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  public recFullBtn!: HTMLButtonElement;
  private sweepBtn!: HTMLButtonElement;
  private pollingBtn!: HTMLButtonElement;
  private propertiesBtn!: HTMLButtonElement;
  private searchBtn!: HTMLButtonElement;
  private exportBtn!: HTMLButtonElement;
  private windowSizeBtn!: HTMLButtonElement;
  private statusBadge!: HTMLSpanElement;
  
  private onOpenPropertiesCallback?: () => void;
  private onToggleWindowSizeCallback?: (isHalf: boolean) => void;
  private onToggleTimeZoomCallback?: (enabled: boolean) => void;
  private onTogglePollingCallback?: (isPolling: boolean) => void;
  private onAutoScaleCallback?: () => void;
  private onToggleAmplitudeModeCallback?: () => void;
  private onToggleIntervalModeCallback?: () => void;
  private onToggleRecCallback?: () => void;
  private onRecordFullBufferCallback?: () => void;
  

    constructor(
    container: HTMLElement,
    settings: Settings,
    recorder: Recorder | null,
    serial: Serial | null,
  ) {
    this.container = container;
    this.settings = settings;
    this.recorder = recorder;
    this.serial = serial;
  }

  public onOpenProperties(cb: () => void): void {
    this.onOpenPropertiesCallback = cb;
  }
  public onToggleWindowSize(cb: (isHalf: boolean) => void): void {
    this.onToggleWindowSizeCallback = cb;
  }
  public onToggleTimeZoom(cb: (enabled: boolean) => void): void {
    this.onToggleTimeZoomCallback = cb;
  }
  public onTogglePolling(cb: (isPolling: boolean) => void): void {
    this.onTogglePollingCallback = cb;
  }
  public onAutoScale(cb: () => void): void {
    this.onAutoScaleCallback = cb;
  }
  public onToggleAmplitudeMode(cb: () => void): void {
    this.onToggleAmplitudeModeCallback = cb;
  }
    public onToggleRec(cb: () => void): void {
    this.onToggleRecCallback = cb;
  }
  public onRecordFullBuffer(cb: () => void): void {
    this.onRecordFullBufferCallback = cb;
  }
  public onToggleIntervalMode(cb: () => void): void {
    this.onToggleIntervalModeCallback = cb;
  }

  /** Скрывает кнопки, не нужные в режиме просмотра .rec */
  public applyViewerMode(): void {
    this.recBtn.style.display = 'none';
    this.recFullBtn.style.display = 'none';
    this.exportBtn.style.display = 'none';
    this.pollingBtn.style.display = 'none';
    this.intervalBtn.style.display = 'none';
    this.statusBadge.style.display = 'none';
    this.windowSizeBtn.style.display = 'none';

    // Скрываем баннер с ID контроллера — в просмотрщике он не нужен
    const oscIdBanner = this.container.querySelector('.osc-id-banner') as HTMLElement | null;
    if (oscIdBanner) {
      oscIdBanner.style.display = 'none';
    }
  }

  /** Финальная настройка тулбара для просмотрщика (вызывать ПОСЛЕ добавления всех кнопок) */
  public finalizeViewerLayout(): void {
    // Все кнопки — слева друг за другом
    this.container.style.display = 'flex';
    this.container.style.justifyContent = 'flex-start';
    Array.from(this.container.children).forEach((child) => {
      (child as HTMLElement).style.marginLeft = '0';
    });
    this.container
      .querySelectorAll('button')
      .forEach((b) => this.styleViewerButton(b as HTMLElement));

    // Перемещаем в конец по частичному совпадению текста или title
    this.moveButtonToEnd('Экспорт');
    this.moveButtonToEnd('Закрыть');
  }

  /** Перемещает кнопку, если её текст или title содержит указанную строку */
  private moveButtonToEnd(match: string): void {
    const buttons = this.container.querySelectorAll('button');
    buttons.forEach((btn) => {
      const text = btn.textContent?.trim() || '';
      const title = btn.getAttribute('title') || '';
      if (text.includes(match) || title.includes(match)) {
        this.container.appendChild(btn); // appendChild перемещает существующий элемент в конец
      }
    });
  }

  /** Кнопка: ширина = 2 * высоты, без прижима вправо */
  private styleViewerButton(btn: HTMLElement): void {
    const H = 28;
    btn.style.height = `${H}px`;
    btn.style.width = `${H * 2}px`;
    btn.style.marginLeft = '0';
    btn.style.flex = '0 0 auto';
  }

  /** Добавляет свою кнопку в тулбар (для файловых операций в просмотрщике) */
  public appendCustomButton(label: string, title: string, onClick: () => void): HTMLElement {
    const btn = ToolbarComponents.createButton(label, 'tool-btn', onClick, title);
    this.container.appendChild(btn);
    this.styleViewerButton(btn);
    return btn;
  }

    public setAutoScaleButtonState(on: boolean): void {
    this.settings.autoScale = on;
    this.autoscaleBtn.classList.toggle("autoscale-on", on);
    this.autoscaleBtn.classList.toggle("autoscale-off", !on);
    this.autoscaleBtn.classList.toggle("active", on);
  }

  public setAmplitudeModeButtonState(isActive: boolean): void {
    this.amplitudeBtn.classList.toggle("active", isActive);
  }

  public setIntervalModeButtonState(isActive: boolean): void {
    this.intervalBtn.classList.toggle("active", isActive);
  }

  public setRecButtonState(isRecording: boolean): void {
    this.recBtn.classList.toggle("active", isRecording);
    this.recBtn.style.color = isRecording ? "#ef4444" : "";
  }

  public updatePollingButtonState(): void {
    const playIcon = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>`;
    const pauseIcon = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
      </svg>`;
    
    this.pollingBtn.innerHTML = this.settings.isPolling ? pauseIcon : playIcon;
    this.pollingBtn.classList.toggle("active", this.settings.isPolling);
  }

  public initialize(): void {
    this.container.innerHTML = "";

    this.propertiesBtn = ToolbarComponents.createButton(
      `⚙`,
      "icon-btn osc-btn-properties",
      () => {
        if (this.onOpenPropertiesCallback) this.onOpenPropertiesCallback();
      },
      "Свойства",
    );
    this.propertiesBtn.style.width = "64px";
    this.propertiesBtn.style.height = "32px";

    this.statusBadge = document.createElement("span");
    this.statusBadge.style.minWidth = "95px";
    this.statusBadge.style.height = "32px";
    this.statusBadge.style.display = "inline-flex";
    this.statusBadge.style.alignItems = "center";
    this.statusBadge.style.justifyContent = "center";
    this.statusBadge.style.padding = "0 8px";
    this.statusBadge.style.fontSize = "13px";
    this.statusBadge.style.fontWeight = "bold";
    this.statusBadge.style.color = "#0f110b";
    this.statusBadge.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.5)";
    this.statusBadge.style.userSelect = "none";
    this.statusBadge.style.borderRadius = "4px";

    this.windowSizeBtn = ToolbarComponents.createButton(
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <path d="M9 3v18"/>
        <path d="M15 3v18"/>
      </svg>`,
      "tool-btn-dark window-toggle-btn",
      () => {
        this.settings.isHalfWindow = !this.settings.isHalfWindow;
        this.windowSizeBtn.innerHTML = this.settings.isHalfWindow
          ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <path d="M9 3v18"/>
            </svg>`
          : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <path d="M9 3v18"/>
              <path d="M15 3v18"/>
            </svg>`;
        if (this.onToggleWindowSizeCallback) {
          this.onToggleWindowSizeCallback(this.settings.isHalfWindow);
        }
      },
      "Переключить ширину окна",
    );
    this.windowSizeBtn.style.width = "32px";
    this.windowSizeBtn.style.height = "32px";
    this.windowSizeBtn.style.padding = "0";
    this.windowSizeBtn.style.marginLeft = "4px";
    this.windowSizeBtn.style.backgroundColor = "#ffdc18";



    const playIcon = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
      </svg>`;
    const pauseIcon = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
      </svg>`;

    this.pollingBtn = ToolbarComponents.createButton(
      pauseIcon,
      "tool-btn-dark active",
      () => {
        this.settings.isPolling = !this.settings.isPolling;
        this.pollingBtn.innerHTML = this.settings.isPolling ? pauseIcon : playIcon;
        this.pollingBtn.classList.toggle("active", this.settings.isPolling);
        if (this.onTogglePollingCallback) {
          this.onTogglePollingCallback(this.settings.isPolling);
        }
      },
      "Пуск/Стоп опроса контроллера",
    );
    this.pollingBtn.style.width = "32px";
    this.pollingBtn.style.height = "32px";
    this.pollingBtn.style.padding = "0";
    this.pollingBtn.style.marginLeft = "0"; 

    this.autoscaleBtn = ToolbarComponents.createButton(
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M12 8v8"/><path d="M9.5 10.5 12 8l2.5 2.5"/><path d="M9.5 13.5 12 16l2.5-2.5"/></svg>',
      "tool-btn-dark",
      () => {
        if (this.onAutoScaleCallback) {
          this.onAutoScaleCallback();
        }
      },
      "Автомасштабирование",
    );
    this.autoscaleBtn.style.width = "32px";
    this.autoscaleBtn.style.height = "32px";
    this.autoscaleBtn.style.padding = "0";
    this.autoscaleBtn.style.marginLeft = "0";

    this.amplitudeBtn = ToolbarComponents.createButton(
      "📏",
      "tool-btn-dark",
      () => {
        if (this.onToggleAmplitudeModeCallback) {
          this.onToggleAmplitudeModeCallback();
        }
      },
      "Измерение величины сигнала",
    );
    this.amplitudeBtn.style.width = "32px";
    this.amplitudeBtn.style.height = "32px";
    this.amplitudeBtn.style.padding = "0";
    this.amplitudeBtn.style.marginLeft = "0";
    this.amplitudeBtn.style.backgroundColor = "#12aaaf";
    
    this.intervalBtn = ToolbarComponents.createButton(
      "T",
      "tool-btn-dark",
      () => {
        if (this.onToggleIntervalModeCallback) {
          this.onToggleIntervalModeCallback();
        }
      },
      "Измерение временных интервалов",
    );
    this.intervalBtn.style.width = "32px";
    this.intervalBtn.style.height = "32px";
    this.intervalBtn.style.padding = "0";
    this.intervalBtn.style.marginLeft = "0";
    this.intervalBtn.style.backgroundColor = "#3244e7";

        // === REC: две отдельные кнопки ===
    this.recBtn = ToolbarComponents.createButton(
      "⏺",
      "tool-btn-dark",
      () => {
        if (this.onToggleRecCallback) {
          this.onToggleRecCallback();
        }
      },
      "Записать выделенный буфер",
    );
    this.recBtn.style.width = "32px";
    this.recBtn.style.height = "32px";
    this.recBtn.style.padding = "0";
    this.recBtn.style.marginLeft = "0";
    this.recBtn.style.backgroundColor = "#e7e432";
    this.recBtn.style.color = "#b91c1c";

    this.recFullBtn = ToolbarComponents.createButton(
      "📼",
      "tool-btn-dark",
      () => {
        if (this.onRecordFullBufferCallback) {
          this.onRecordFullBufferCallback();
        }
      },
      "Записать весь буфер",
    );
    this.recFullBtn.style.width = "32px";
    this.recFullBtn.style.height = "32px";
    this.recFullBtn.style.padding = "0";
    this.recFullBtn.style.marginLeft = "0";
    //this.recFullBtn.style.backgroundColor = "#e7e432";
    this.recFullBtn.style.display = "inline-flex";

    // === Кнопка "Развертка" (добавляем прямо в groupLeft) ===
    const sweepIcon = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 5h18"/>
        <path d="m6 2-3 3 3 3"/>
        <path d="m18 2 3 3-3 3"/>
        <path d="M3 17h2l2-5 3 10 3-8 2 3h6"/>
      </svg>`;
    
    this.sweepBtn = ToolbarComponents.createButton(
      sweepIcon,
      "",
      () => {
        const enabled = !this.sweepBtn.classList.contains("active");
        this.sweepBtn.classList.toggle("active", enabled);
        if (this.onToggleTimeZoomCallback) {
          this.onToggleTimeZoomCallback(enabled);
        }
      },
      "Развертка",
    );
    this.sweepBtn.style.width = "64px";

    // === Кнопка "Экспорт CSV" (тоже добавляем в groupLeft) ===
    this.exportBtn = ToolbarComponents.createButton(
      "💾",
      "",
      () => {
        window.dispatchEvent(new CustomEvent("oscilloscope-export-csv"));
      },
      "Экспорт CSV",
    );

    // === Кнопка "Поиск" ===
    this.searchBtn = ToolbarComponents.createButton(
      "🔍",
      "",
      () => {
        window.dispatchEvent(new CustomEvent("oscilloscope-search"));
      },
      "Поиск параметра",
    );

    const groupLeft = document.createElement("div");
    groupLeft.className = "toolbar-group";

    const title = document.createElement("div");
    title.className = "toolbar-title";

    // Создаем баннер для короткого ID контроллера в шапке осциллографа
    const oscIdBanner = document.createElement("div");
    oscIdBanner.className = "osc-id-banner";
    oscIdBanner.textContent = "Ожидание подключения...";

    // Добавляем ВСЕ кнопки в одну группу: groupLeft
    groupLeft.append(
      this.propertiesBtn,
      this.statusBadge,
      this.windowSizeBtn,
      this.pollingBtn,
      this.autoscaleBtn,
      this.amplitudeBtn,
      this.intervalBtn,
      this.recBtn,
      this.recFullBtn,
      this.sweepBtn,
      this.exportBtn,
      this.searchBtn,
      title,
    );

    this.updateStatus(false);

    // Добавляем группу и баннер в контейнер (баннер будет справа)
    this.container.append(groupLeft);
    this.container.append(oscIdBanner);

    this.serial?.onStateChange((state: unknown) => {
      const isConnected = state === "connected" || state === true;
      this.updateStatus(isConnected);
    });
  }

  public updateStatus(isConnected: boolean): void {
    this.statusBadge.removeAttribute("title");
    if (isConnected) {
      this.statusBadge.className = "status-badge connected";
      this.statusBadge.textContent = "Подключено";
    } else {
      this.statusBadge.className = "status-badge disconnected";
      this.statusBadge.textContent = "Нет связи";
    }
  }

  public updateRecordTimer(): void {
    // Оставлен для сохранения интерфейса
  }
}