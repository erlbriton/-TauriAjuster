/**
 * Модуль настроек связи и глобальных событий.
 * Отвечает за:
 * - Выбор скорости (Baud Rate)
 * - Переключение режима шины (RTU / TCP)
 * - Изменение адреса Modbus
 * - Подключение/отключение TCP-соединения (Modbus RTU over TCP/IP)
 * - Обработчики событий: контроллер не отвечает, перезапуск опроса,
 *   защита от закрытия вкладки
 */

import type { ISerialPort } from '../../serial/ISerialPort.js';
import type { AppState } from '../../core/app-state.js';
import type { IOscilloscopeApi } from '../../core/osc-api.js';
import type { ChannelBuffer } from '../uiManager.js';
import { showIdModal, showCompactError } from '../ui.js';
import { showAddressDialog } from '../confirm-dialog.js';
import { hasAnyDirty } from '../../ini-manager/dirty-tracker.js';
import { TauriSerialPort } from '../../serial/tauri-serial.js';
import { TauriTcpPort } from '../../serial/tauri-tcp.js';
import { serialManager } from '../../serial/serial-manager.js';

/** Ключи localStorage для сохранения IP и порта TCP-контроллера. */
const TCP_HOST_KEY = 'tauri-ajuster:tcp-host';
const TCP_PORT_KEY = 'tauri-ajuster:tcp-port';

interface CommunicationSettingsUIDeps {
  serial: ISerialPort;
  appState: AppState;
  baudSelect: HTMLSelectElement | null;
  busSelect: HTMLSelectElement | null;
  rtuControls: HTMLElement | null;
  tcpControls: HTMLElement | null;
  addrBtn: HTMLButtonElement | null;
  
  // Зависимости для перезапуска опроса (readLoop)
  readLoop: (
    serial: ISerialPort,
    parser: unknown,
    view: IOscilloscopeApi | null,
    buffers: ChannelBuffer[],
    state: AppState
  ) => void;
  parser: unknown;
  view: IOscilloscopeApi | null;
  buffers: ChannelBuffer[];
}

export function initCommunicationSettingsUI(deps: CommunicationSettingsUIDeps): void {
  const {
    serial,
    appState,
    baudSelect,
    busSelect,
    rtuControls,
    tcpControls,
    addrBtn,
    readLoop,
    parser,
    view,
    buffers
  } = deps;

  // ─── Текущий транспорт ─────────────────────────────────────────────────
  // Изначально — COM-порт, созданный в main.ts. При переключении BUS
  // заменяется на TauriTcpPort (или обратно на TauriSerialPort).
  // serialManager.serial тоже подменяется через init() — так все транзакции
  // (readLoop, запись в контроллер, командная строка) идут через новый порт.
  let currentPort: ISerialPort = serial;

  // Флаг первого вызова applyBusMode: при старте НЕ пересоздаём порт.
  // Иначе получится рассинхронизация: serialManager будет смотреть на
  // новый (закрытый) объект, а main.ts/device-management продолжат
  // работать с исходным. Ровно это и приводило к тому, что currentPort
  // в обработчике app:request-polling-restart показывал isConnected=false,
  // хотя реальные транзакции шли успешно через другой объект.
  let isFirstApplyBusMode = true;

  // ─── Авто-реконнект ────────────────────────────────────────────────────
  // ID таймера следующей попытки переподключения (null — цикл не запущен).
  // Отменяется при ручном клике по кнопке или при смене BUS.
  let autoReconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  // Номер текущей попытки (для экспоненциальной задержки).
  let autoReconnectAttempt = 0;

  // ─── Ссылки на элементы UI ─────────────────────────────────────────────
  const tcpIpInput = document.getElementById('tcpIpInput') as HTMLInputElement | null;
  const tcpPortInput = document.getElementById('tcpPortInput') as HTMLInputElement | null;
  const tcpConnectBtn = document.getElementById('tcpConnectBtn') as HTMLButtonElement | null;

  // ─── Сохранение и восстановление IP/Port в localStorage ────────────────
  const savedHost = localStorage.getItem(TCP_HOST_KEY);
  const savedPort = localStorage.getItem(TCP_PORT_KEY);
  if (savedHost && tcpIpInput) tcpIpInput.value = savedHost;
  if (savedPort && tcpPortInput) tcpPortInput.value = savedPort;

  tcpIpInput?.addEventListener('change', () => {
    localStorage.setItem(TCP_HOST_KEY, tcpIpInput.value.trim());
  });
  tcpPortInput?.addEventListener('change', () => {
    localStorage.setItem(TCP_PORT_KEY, tcpPortInput.value.trim());
  });

  // ─── Вспомогательные функции ───────────────────────────────────────────

  /** Читает endpoint из полей IP/Port. Fallback — 192.168.1.234:502. */
  const getTcpEndpoint = (): { host: string; port: number } => {
    const host = (tcpIpInput?.value ?? '').trim() || '192.168.1.234';
    const portRaw = parseInt((tcpPortInput?.value ?? '').trim(), 10);
    const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : 502;
    return { host, port };
  };

  /** Обновляет надпись на кнопке TCP: '0' / '1' / 'E'. */
  const updateTcpButtonState = (text: '0' | '1' | 'E'): void => {
    if (!tcpConnectBtn) return;
    tcpConnectBtn.textContent = text;
  };

  /**
   * Подписывает порт на событие обрыва соединения.
   *
   * Вызывается SerialManager.notifyDisconnect() при фатальной ошибке
   * транспорта (обрыв сети, выдернутый кабель, ERROR_BAD_COMMAND и т.п.).
   * Внутри порт уже выставил isConnected = false — нам остаётся
   * привести UI в соответствие:
   *   - TCP: кнопка → 'E' (ошибка), чтобы пользователь видел обрыв
   *     и мог переподключиться кликом;
   *   - RTU: визуального индикатора нет, но readLoop сам остановится,
   *     потому что проверяет serial.isConnected на каждой итерации.
   */
  /**
   * Отменяет запланированный авто-реконнект (если есть).
   * Вызывается при ручном клике по кнопке и при смене BUS.
   */
  const cancelAutoReconnect = (): void => {
    if (autoReconnectTimerId !== null) {
      clearTimeout(autoReconnectTimerId);
      autoReconnectTimerId = null;
      console.log('[UI] Авто-реконнект отменён');
    }
    autoReconnectAttempt = 0;
  };

  /**
   * Планирует следующую попытку переподключения к TCP-контроллеру.
   * Задержки: 3, 6, 12, 24, 30, 30, ... сек.
   * Цикл останавливается при успехе, ручном клике или смене BUS.
   */
  const scheduleAutoReconnect = (): void => {
    // Только если сейчас TCP-режим и приложение не закрывается.
    if (busSelect?.value !== 'TCP') return;

    autoReconnectAttempt++;
    const delayMs = Math.min(
      3000 * Math.pow(2, autoReconnectAttempt - 1),
      30000,
    );
    console.log(
      `[UI] Авто-реконнект: попытка №${autoReconnectAttempt} через ${delayMs} мс`,
    );

    autoReconnectTimerId = setTimeout(async () => {
      autoReconnectTimerId = null;

      // Проверяем условия ещё раз: за время ожидания пользователь мог
      // сменить BUS, закрыть приложение или вручную подключиться.
      if (busSelect?.value !== 'TCP') return;
      const port = serialManager.serial;
      if (!port || port.isConnected) return;

      // Пробуем подключиться.
      if (port instanceof TauriTcpPort) {
        const { host, port: tcpPortNum } = getTcpEndpoint();
        port.setEndpoint(host, tcpPortNum);
      }

      try {
        await port.connect();
        updateTcpButtonState('1');
        console.log(`[UI] Авто-реконнект: успех с попытки №${autoReconnectAttempt}`);
        autoReconnectAttempt = 0;

        // Запускаем readLoop, если осциллограф виден.
        const osc = window.osc;
        if (osc) {
          if (typeof osc.setConnectionStatus === 'function') {
            osc.setConnectionStatus(true);
          }
          // Обязательно размораживаем осциллограф: при обрыве связи
          // сработало app:controller-not-responding → showFrozenState('').
          // Без resumeFromFrozen() графики останутся стоять, хотя данные идут.
          const oscAny = osc as unknown as { resumeFromFrozen?: () => void };
          if (typeof oscAny.resumeFromFrozen === 'function') {
            oscAny.resumeFromFrozen();
          }
        }
        const oscContainerEl = document.getElementById('osc-container');
        const isOscVisible = oscContainerEl &&
          !oscContainerEl.classList.contains('hidden') &&
          oscContainerEl.style.display !== 'none';
        if (isOscVisible) {
          appState.isLoopRunning = false;
          appState.isPolling = true;
          void readLoop(port, parser, view, buffers, appState);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[UI] Авто-реконнект: попытка №${autoReconnectAttempt} провалилась: ${msg}`);
        updateTcpButtonState('E');
        // Планируем следующую попытку.
        scheduleAutoReconnect();
      }
    }, delayMs);
  };

  const attachDisconnectHandler = (port: ISerialPort, isTcpMode: boolean): void => {
    port.onDisconnect(() => {
      console.log(`[UI] Обрыв соединения (${isTcpMode ? 'TCP' : 'RTU'})`);

      // Останавливаем опрос — readLoop проверяет serial.isConnected
      // на каждой итерации, а порт уже выставил isConnected = false.
      appState.isPolling = false;

      if (isTcpMode) {
        updateTcpButtonState('E');
        // Запускаем авто-восстановление — без кликов пользователя.
        scheduleAutoReconnect();
      }
    });
  };

  // ─── Обработчик смены скорости (Baud Rate) ─────────────────────────────
  if (baudSelect) {
    baudSelect.addEventListener('change', () => {
      const newBaudRate = parseInt(baudSelect.value, 10) || 115200;
      if (serial.isConnected) {
        console.log(`[UI] Скорость изменена на ${newBaudRate}. Для применения необходимо переподключиться.`);
      } else {
        console.log(`[UI] Скорость установлена на ${newBaudRate} (будет использована при подключении).`);
      }
    });
  }

  // ─── Переключение BUS: MODBUS RTU <-> MODBUS TCP/IP ────────────────────
  const applyBusMode = async (): Promise<void> => {
    const isTcp = busSelect?.value === 'TCP';
    if (rtuControls) rtuControls.style.display = isTcp ? 'none' : '';
    if (tcpControls) tcpControls.style.display = isTcp ? '' : 'none';

    // При старте приложения не трогаем порт: serialManager.serial уже
    // указывает на порт из main.ts, который подключён через
    // executeDeviceConnection. Пересоздание здесь привело бы к тому, что
    // serialManager смотрел бы на новый (закрытый) объект.
    if (isFirstApplyBusMode) {
      isFirstApplyBusMode = false;
      console.log('[UI] Начальный режим связи применён (порт не пересоздаётся)');
      return;
    }

    // Отменяем запланированный авто-реконнект — пользователь сам меняет режим.
    cancelAutoReconnect();

    // Останавливаем опрос перед сменой транспорта.
    const wasPolling = appState.isPolling;
    if (wasPolling) {
      appState.isPolling = false;
    }

    // Закрываем старое соединение (какое было — COM или TCP).
    // При смене BUS особенно важно закрыть TCP через release() —
    // это отправит FIN контроллеру, и он освободит свой сокет.
    if (currentPort.isConnected) {
      try {
        currentPort.release();
      } catch (err) {
        console.warn('[UI] Ошибка закрытия порта при смене BUS:', err);
      }
      // Пауза после close: даём контроллеру время освободить сокет,
      // прежде чем открывать новое соединение.
      await new Promise((r) => setTimeout(r, 800));
    }

    if (isTcp) {
      // ─── Переключение на TCP ────────────────────────────────────────────
      const { host, port } = getTcpEndpoint();
      const tcpPort = new TauriTcpPort(host, port);
      attachDisconnectHandler(tcpPort, true);
      serialManager.init(tcpPort);
      currentPort = tcpPort;
      (window as unknown as { serialPort?: ISerialPort }).serialPort = tcpPort;
      // Соединение пока не открыто — ждём нажатия кнопки tcpConnectBtn.
      updateTcpButtonState('0');
      console.log(`[UI] Режим связи: MODBUS TCP/IP (${host}:${port}) — нажмите кнопку для подключения`);
    } else {
      // ─── Переключение на RTU ────────────────────────────────────────────
      // Создаём свежий TauriSerialPort: старый мог быть закрыт при
      // переключении на TCP. Путь к COM-порту берём из comSelect.
      const comSelect = document.getElementById('comSelect') as HTMLSelectElement | null;
      const path = comSelect?.value && comSelect.value !== '—' ? comSelect.value : '';
      const baudRate = baudSelect ? parseInt(baudSelect.value, 10) || 115200 : 115200;
      const serialPort = new TauriSerialPort(path, baudRate);
      attachDisconnectHandler(serialPort, false);
      serialManager.init(serialPort);
      currentPort = serialPort;
      (window as unknown as { serialPort?: ISerialPort }).serialPort = serialPort;
      updateTcpButtonState('0');
      console.log('[UI] Режим связи: MODBUS RTU');
    }

    // Если до переключения шёл опрос — перезапускаем его на новом транспорте.
    // Небольшая задержка, чтобы текущий readLoop успел выйти из while
    // (isPolling = false) и в своём finally сбросил isLoopRunning.
    if (wasPolling) {
      setTimeout(() => {
        appState.isPolling = true;
        void readLoop(currentPort, parser, view, buffers, appState);
      }, 150);
    }
  };

  if (busSelect) {
    busSelect.addEventListener('change', () => {
      void applyBusMode();
    });
    void applyBusMode(); // Применяем текущий режим при старте
  }

  // ─── Кнопка подключения/отключения TCP ─────────────────────────────────
  tcpConnectBtn?.addEventListener('click', async () => {
    // Работаем только если сейчас TCP-режим.
    if (busSelect?.value !== 'TCP') return;

    // Ручной клик — отменяем запланированный авто-реконнект.
    // Пользователь сам решает, что делать.
    cancelAutoReconnect();

    // Актуальный порт — из serialManager (см. комментарий в applyBusMode).
    const port = serialManager.serial;
    if (!port) return;

    if (port.isConnected) {
      // Уже подключены — отключаемся.
      try {
        // Останавливаем опрос перед закрытием соединения.
        appState.isPolling = false;
        port.release();
      } catch (err) {
        console.error('[UI] Ошибка отключения TCP:', err);
      }
      updateTcpButtonState('0');
      console.log('[UI] TCP-соединение закрыто');

      // Останавливаем рендер осциллографа: маркеры (курсоры) и графики
      // должны замереть вместе с потерей связи. Тот же метод, что
      // вызывается при обрыве кабеля (см. обработчик
      // app:controller-not-responding).
      const osc = window.osc;
      if (osc) {
        if (typeof (osc as any).showFrozenState === 'function') {
          (osc as any).showFrozenState('');
        }
        if (typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false);
        }
      }
      return;
    }

    // Пробуем подключиться.
    if (port instanceof TauriTcpPort) {
      const { host, port: tcpPortNum } = getTcpEndpoint();
      port.setEndpoint(host, tcpPortNum);
    }
    // Блокируем кнопку на время попытки, чтобы не было параллельных connect.
    const btn = tcpConnectBtn;
    if (btn) btn.disabled = true;

    try {
      // Пауза 1 сек перед коннектом: если предыдущее соединение только что
      // закрыто, контроллер может ещё не освободить свой сокет (TIME_WAIT).
      // Без паузы SYN уходит в пустоту, и мы получаем connection timed out.
      // 1 сек — минимальная безопасная задержка. Контроллеры обычно
      // освобождают сокет за 500–700 мс.
      await new Promise((r) => setTimeout(r, 1000));

      await port.connect();
      updateTcpButtonState('1');
      console.log('[UI] TCP-соединение установлено');

      // ─── Запуск опроса после успешного подключения ─────────────────────
      // Логика зеркалит restoreConnection из uiManager.ts: показываем
      // статус в осциллографе и запускаем readLoop, если он виден.
      // Отличие — используем currentPort (актуальный TCP-порт), а не
      // serial из deps, который относится к исходному COM-порту.
      const osc = window.osc;
      if (osc) {
        if (typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(true);
        }
        // Размораживаем осциллограф при ручном переподключении —
        // тот же случай, что и в авто-реконнекте.
        const oscAny = osc as unknown as { resumeFromFrozen?: () => void };
        if (typeof oscAny.resumeFromFrozen === 'function') {
          oscAny.resumeFromFrozen();
        }
      }
      const oscContainerEl = document.getElementById('osc-container');
      const isOscVisible = oscContainerEl &&
        !oscContainerEl.classList.contains('hidden') &&
        oscContainerEl.style.display !== 'none';
      if (isOscVisible) {
        console.log('[UI] Запуск readLoop после подключения по TCP');
        appState.isLoopRunning = false;
        appState.isPolling = true;
        void readLoop(port, parser, view, buffers, appState);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[UI] Ошибка подключения TCP:', msg);
      updateTcpButtonState('E');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ─── Кнопка адреса Modbus ──────────────────────────────────────────────
  if (addrBtn) {
    const updateAddrLabel = (): void => {
      addrBtn.textContent = 'Адрес: x' + appState.slaveAddress.toString(16).toUpperCase().padStart(2, '0');
    };
    
    updateAddrLabel();

    addrBtn.addEventListener('click', async () => {
      const newAddr = await showAddressDialog(appState.slaveAddress);
      if (newAddr !== null && newAddr !== appState.slaveAddress) {
        appState.slaveAddress = newAddr;
        updateAddrLabel();
        console.log(`[UI] Адрес Modbus изменён на ${newAddr} (0x${newAddr.toString(16).toUpperCase().padStart(2, '0')})`);
        
        const osc = window.osc;
        if (osc && typeof osc.setSlaveAddress === 'function') {
          osc.setSlaveAddress(newAddr);
          console.log(`[UI] Осциллограф уведомлён о новом адресе: ${newAddr}`);
        }
      }
    });
  }

  // ─── Глобальные обработчики событий бизнес-логики ──────────────────────

  // Событие: Контроллер перестал отвечать (серия таймаутов)
  window.addEventListener('app:controller-not-responding', (e: Event) => {
    const detail = (e as CustomEvent).detail as { consecutiveTimeouts?: number } | undefined;
    const count = detail?.consecutiveTimeouts ?? 0;
    console.log(`[UI] Получено событие "контроллер не отвечает" (подряд ошибок: ${count})`);

    showCompactError('Контроллер не отвечает. Проверьте адрес и подключение.', 3000);

    const osc = window.osc;
    if (osc) {
      osc.showFrozenState('');
    }
  });

  // Событие: Контроллер снова начал отвечать
  window.addEventListener('app:controller-responding', () => {
    console.log('[UI] Получено событие "контроллер отвечает"');
    const osc = window.osc;
    if (osc) {
      osc.resumeFromFrozen();
    }
  });

  // Событие: Запрос на перезапуск опроса после записи в контроллер.
  // ВАЖНО: используем currentPort, а не deps.serial — иначе после
  // переключения BUS перезапуск шёл бы на старом транспорте.
  window.addEventListener('app:request-polling-restart', () => {
    // Берём порт из serialManager, а не из currentPort.
    // serialManager.serial — это всегда тот объект, через который шли
    // последние успешные транзакции. currentPort может устареть, если
    // пользователь подключался по COM через executeDeviceConnection,
    // которая внутри вызывает serialManager.init(serial) со СВОИМ serial.
    const port = serialManager.serial;
    console.log(
      '[UI] Получено app:request-polling-restart',
      {
        hasPort: !!port,
        isConnected: port?.isConnected,
        isPolling: appState.isPolling,
        isLoopRunning: appState.isLoopRunning,
      },
    );
    if (port && port.isConnected && appState.isPolling && !appState.isLoopRunning) {
      console.log('[UI] Перезапуск readLoop по запросу после записи...');
      appState.isLoopRunning = false;
      void readLoop(port, parser, view, buffers, appState);
    } else {
      console.warn('[UI] Условие перезапуска не выполнено');
    }
  });

  // Защита от закрытия вкладки при несохранённых изменениях
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (hasAnyDirty()) {
      e.preventDefault();
    }

    // Закрываем текущее соединение при выходе из приложения.
    // Берём window.serialPort — там всегда актуальный порт (COM или TCP),
    // потому что applyBusMode обновляет эту ссылку при смене BUS.
    const serialPort = (window as unknown as { serialPort?: ISerialPort }).serialPort;
    if (serialPort) {
      try {
        serialPort.release();
      } catch (err) {
        console.error('[beforeunload] Ошибка закрытия порта:', err);
      }
    }
  });

  console.log('[CommunicationSettingsUI] Инициализирован.');
}