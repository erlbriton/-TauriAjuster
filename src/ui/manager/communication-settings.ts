/**
 * Модуль настроек связи и глобальных событий.
 * Отвечает за:
 * - Выбор скорости (Baud Rate)
 * - Переключение режима шины (RTU / TCP)
 * - Изменение адреса Modbus
 * - Обработчики событий: контроллер не отвечает, перезапуск опроса, защита от закрытия вкладки
 */

import type { ISerialPort } from '../../serial/ISerialPort.js';
import type { AppState } from '../../core/app-state.js';
import { showIdModal, showCompactError } from '../ui.js';
import { showAddressDialog } from '../confirm-dialog.js';
import { hasAnyDirty } from '../../ini-manager/dirty-tracker.js';


export interface CommunicationSettingsUIDeps {
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
    view: any, // IOscilloscopeApi | null
    buffers: any[],
    state: AppState
  ) => void;
  parser: unknown;
  view: any; // IOscilloscopeApi | null
  buffers: any[];
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

  // --- Обработчик смены скорости (Baud Rate) ---
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

  // --- Переключение BUS: MODBUS RTU <-> MODBUS TCP/IP ---
  const applyBusMode = (): void => {
    const isTcp = busSelect?.value === 'TCP';
    if (rtuControls) rtuControls.style.display = isTcp ? 'none' : '';
    if (tcpControls) tcpControls.style.display = isTcp ? '' : 'none';
    console.log(`[UI] Режим связи: ${isTcp ? 'MODBUS TCP/IP' : 'MODBUS RTU'}`);
  };

  if (busSelect) {
    busSelect.addEventListener('change', applyBusMode);
    applyBusMode(); // Применяем текущий режим при старте
  }

  // --- Кнопка адреса Modbus ---
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
        
        // Уведомляем осциллограф о смене адреса
        const osc = window.osc;
        if (osc && typeof osc.setSlaveAddress === 'function') {
          osc.setSlaveAddress(newAddr);
          console.log(`[UI] Осциллограф уведомлён о новом адресе: ${newAddr}`);
        }
      }
    });
  }

  // --- Глобальные обработчики событий бизнес-логики ---

  // Событие: Контроллер перестал отвечать (серия таймаутов)
  window.addEventListener('app:controller-not-responding', (e: Event) => {
    const detail = (e as CustomEvent).detail as { consecutiveTimeouts?: number } | undefined;
    const count = detail?.consecutiveTimeouts ?? 0;
    console.log(`[UI] Получено событие "контроллер не отвечает" (подряд ошибок: ${count})`);

    // Показываем компактное окно
    showCompactError('Контроллер не отвечает. Проверьте адрес и подключение.');

    // Если осциллограф открыт — замораживаем его рендер
    const osc = window.osc;
    if (osc && typeof (osc as any).showFrozenState === 'function') {
      (osc as any).showFrozenState('');
    }
  });

  // Событие: Контроллер снова начал отвечать
  window.addEventListener('app:controller-responding', () => {
    console.log('[UI] Получено событие "контроллер отвечает"');
    const osc = window.osc;
    if (osc && typeof (osc as any).resumeFromFrozen === 'function') {
      (osc as any).resumeFromFrozen();
    }
  });

  // Событие: Запрос на перезапуск опроса после записи в контроллер
  window.addEventListener('app:request-polling-restart', () => {
    if (serial && serial.isConnected && appState.isPolling && !appState.isLoopRunning) {
      console.log('[UI] Перезапуск readLoop по запросу после записи...');
      appState.isLoopRunning = false;
      // Вызываем переданную функцию readLoop
      void readLoop(serial, parser, view, buffers, appState);
    }
  });

  // Защита от закрытия вкладки при несохранённых изменениях
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (hasAnyDirty()) {
      // По современному стандарту для запроса подтверждения выхода достаточно
      // отменить событие через preventDefault() — именно отмена события заставляет
      // браузер/веб-вью показать диалог «Покинуть страницу?».
      // Устаревшее свойство returnValue (легаси-алиас из старых браузеров)
      // больше НЕ используется: оно помечено @deprecated в lib.dom.d.ts и
      // давало предупреждение TS6385 в редакторе.
      e.preventDefault();
    }

    // Закрываем COM-порт при выходе из приложения (вызывает close_serial_port на Rust-стороне).
    // ВАЖНО: используем интерфейс ISerialPort (контракт порта), а не конкретный класс
    // TauriSerialPort, по двум причинам:
    //   1) метод release() объявлен именно в контракте ISerialPort (строка 50 ISerialPort.ts),
    //      то есть доступен любой реализации порта (браузерной и нативной);
    //   2) тип ISerialPort в этом файле УЖЕ импортирован (первая строка импортов),
    //      а TauriSerialPort — нет, из-за чего и возникала ошибка TS2552.
    const serialPort = (window as unknown as { serialPort?: ISerialPort }).serialPort;
    if (serialPort) {
      try {
        serialPort.release();
      } catch (err) {
        console.error('[beforeunload] Ошибка закрытия порта:', err);
      }
    }
  });

  console.log("[CommunicationSettingsUI] Инициализирован.");
}