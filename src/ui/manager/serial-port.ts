/**
 * Модуль управления последовательными портами (COM).
 * Отвечает за:
 * - Обновление списка портов (polling при открытом дропдауне)
 * - Автоподключение при выборе порта
 * - Обработку отключения (onDisconnect)
 * - Кнопку ID (запрос идентификации)
 * - Пункт "Off" в списке портов для ручного отключения
 */

import type { ISerialPort } from '../../serial/ISerialPort.js';
import type { AppState } from '../../core/app-state.js';
import { PortCancelledError } from '../../serial/serial.js';
import { updateIdBanner, showCompactError, showIdModal } from '../ui.js'; // Импорт утилит UI

// Типизация зависимостей для этого модуля
interface SerialPortUIDeps {
  serial: ISerialPort;
  appState: AppState;
  comSelect: HTMLSelectElement | null;
  baudSelect: HTMLSelectElement | null;
  idBtn: HTMLButtonElement | null;
  executeDeviceConnection: (
    serial: ISerialPort,
    select: HTMLSelectElement | null,
    baudSelect?: HTMLSelectElement | null
  ) => Promise<void>;
  executeDeviceIdentification: (
    serial: ISerialPort,
    select: HTMLSelectElement | null,
    state: AppState,
    baudSelect?: HTMLSelectElement | null
  ) => Promise<void>;
  restoreConnection: () => void;
}

/**
 * Инициализирует обработчики событий для управления COM-портами.
 */
export function initSerialPortUI(deps: SerialPortUIDeps): void {
  const {
    serial,
    appState,
    comSelect,
    baudSelect,
    idBtn,
    executeDeviceConnection,
    executeDeviceIdentification,
    restoreConnection
  } = deps;

  // Специальное значение для пункта "Off" в списке портов.
  // Не может совпасть с реальным именем порта (COM3, /dev/ttyUSB0 и т.п.),
  // поэтому безопасно использовать его как маркер «отключиться».
  const OFF_VALUE = '__off__';

  // Переменная для хранения ID интервала опроса портов.
  let comPortsPollInterval: number | null = null;

  // Флаг ручного отключения (подавляет предупреждение "Связь потеряна"
  // в обработчике onDisconnect при release()).
  let isManualDisconnect = false;

  // --- Логика динамического обновления списка COM-портов ---
  if (comSelect) {
    // Функция обновления списка портов: опрашивает Rust и перерисовывает дропдаун.
    const updatePortsList = async (): Promise<void> => {
      try {
        console.log('[UI] Запрос списка портов у Rust...');
        const ports = await window.__TAURI__.core.invoke<string[]>('list_serial_ports');
        console.log('[UI] Получен список портов:', ports);

        const currentSelection = comSelect.value;
        comSelect.innerHTML = '';

        // Off — первый пункт, всегда доступен. Выбор Off отключает порт.
        const offOption = document.createElement('option');
        offOption.value = OFF_VALUE;
        offOption.text = 'Off';
        comSelect.add(offOption);

        if (ports.length === 0) {
          const noPortsOption = document.createElement('option');
          noPortsOption.text = 'Порты не найдены';
          noPortsOption.disabled = true;
          comSelect.add(noPortsOption);
        } else {
          for (const port of ports) {
            const option = document.createElement('option');
            option.value = port;
            option.text = port;
            comSelect.add(option);
          }
        }

        // Восстановление выбора:
        // - если до обновления был выбран реальный порт и он всё ещё в списке — оставляем;
        // - иначе (был выбран Off, порт исчез, ничего не выбрано) — переключаемся на Off.
        if (
          currentSelection &&
          currentSelection !== OFF_VALUE &&
          ports.includes(currentSelection)
        ) {
          comSelect.value = currentSelection;
        } else {
          comSelect.value = OFF_VALUE;
        }
      } catch (error) {
        console.error('Ошибка получения списка портов:', error);
        comSelect.innerHTML = `<option value="${OFF_VALUE}">Off</option><option>Ошибка сканирования</option>`;
      }
    };

    // --- ПРЕДВАРИТЕЛЬНОЕ СКАНИРОВАНИЕ ПОРТОВ ПРИ СТАРТЕ ---
    // Вызываем updatePortsList() сразу при инициализации, чтобы выпадающий список
    // COM-портов был заполнен до первого клика пользователя. Это даёт возможность
    // подключиться по одному клику, если устройство было подключено до запуска приложения.
    // Polling при focus остаётся для поддержки hotplug (подключение устройства
    // во время работы приложения).
    console.log('[SerialPortUI] Предварительное сканирование портов при старте...');
    void updatePortsList().then(() => {
      console.log('[SerialPortUI] Предварительное сканирование завершено');
    });

    // Обработчик фокуса (открытие дропдауна): запускает polling.
    comSelect.addEventListener('focus', async () => {
      console.log('[UI] Дропдаун COM открыт (focus)');
      await updatePortsList();
      if (comPortsPollInterval === null) {
        comPortsPollInterval = window.setInterval(updatePortsList, 500);
        console.log('[UI] Запущен опрос портов (интервал 500 мс)');
      }
    });

    // Обработчик blur (закрытие дропдауна): останавливает polling.
    comSelect.addEventListener('blur', () => {
      console.log('[UI] Дропдаун COM закрыт (blur)');
      if (comPortsPollInterval !== null) {
        window.clearInterval(comPortsPollInterval);
        comPortsPollInterval = null;
        console.log('[UI] Опрос портов остановлен');
      }
    });

    // --- АВТОПОДКЛЮЧЕНИЕ ПРИ ВЫБОРЕ ПОРТА (ИЛИ ОТКЛЮЧЕНИЕ ПО "OFF") ---
    comSelect.addEventListener('change', async () => {
      const portName = comSelect.value;

      // Пункт "Off" — отключение от порта.
      // isManualDisconnect=true подавляет предупреждение "Связь потеряна"
      // в обработчике onDisconnect.
      if (portName === OFF_VALUE) {
        if (serial.isConnected) {
          isManualDisconnect = true;
          try {
            serial.release();
            console.log('[UI] Порт отключён через выбор "Off".');
          } catch (err) {
            console.error('[UI] Ошибка отключения порта:', err);
            showIdModal(`Ошибка отключения: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            isManualDisconnect = false;
          }
        }
        appState.isPolling = false;
        updateIdBanner('');

        const osc = window.osc;
        if (osc && typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false, '');
        }
        updateIdButtonState(false);
        return;
      }

      if (!portName) return;
      if (appState.isIdentifying) return;

      try {
        if (serial.isConnected) {
          serial.release();
        }

        if (typeof serial.setPortPath === 'function') {
          serial.setPortPath(portName);
        }

        await executeDeviceConnection(serial, comSelect, baudSelect);

        const osc = window.osc;
        if (osc && typeof osc.setSerialPort === 'function') {
          osc.setSerialPort(serial);
        }

        restoreConnection();
        updateIdButtonState(true);
      } catch (err: unknown) {
        if (err instanceof PortCancelledError) return;
        const msg = err instanceof Error ? err.message : String(err);
        showIdModal('Ошибка: ' + msg);
      }
    });
  }

  // --- ОБРАБОТЧИК ОТКЛЮЧЕНИЯ (onDisconnect) ---
  if (serial && typeof serial.onDisconnect === 'function') {
    serial.onDisconnect(async () => {
      const osc = window.osc;

      if (isManualDisconnect) {
        console.log('[UI] Порт отключён вручную пользователем.');
        if (osc && typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false, '');
        }
      } else {
        console.log('[UI] Обрыв связи обнаружен (физический обрыв USB).');
        if (osc && typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false, 'Связь с устройством потеряна.');
        }
      }

      appState.isPolling = false;
      updateIdBanner('');

      if (comSelect) {
        try {
          const ports = await window.__TAURI__.core.invoke<string[]>('list_serial_ports');
          comSelect.innerHTML = '';

          // Off — первый пункт (как и в updatePortsList).
          const offOption = document.createElement('option');
          offOption.value = OFF_VALUE;
          offOption.text = 'Off';
          comSelect.add(offOption);

          if (ports.length === 0) {
            const noPortsOption = document.createElement('option');
            noPortsOption.text = 'Порты не найдены';
            noPortsOption.disabled = true;
            comSelect.add(noPortsOption);
          } else {
            for (const port of ports) {
              const option = document.createElement('option');
              option.value = port;
              option.text = port;
              comSelect.add(option);
            }
          }

          // После обрыва связи всегда показываем Off.
          comSelect.value = OFF_VALUE;
        } catch (error) {
          console.error('[UI] Ошибка обновления списка портов при обрыве связи:', error);
        }
      }
      updateIdButtonState(false);
    });
  }

  // --- КНОПКА ID ---
  // Синхронизирует состояние кнопки (текст всегда "ID")
  const updateIdButtonState = (_connected: boolean): void => {
    if (!idBtn) return;
    // Текст всегда "ID", как требовалось
    // idBtn.textContent = 'ID';
    // idBtn.title = 'Запросить ID устройства';
  };

  // Функция для внешнего вызова отключения (нужна для кнопки ID или других мест)
  const disconnectPort = async (): Promise<void> => {
    try {
      isManualDisconnect = true;
      serial.release();
      console.log('[UI] Порт отключён вручную через serial.release().');
    } catch (err) {
      console.error('[UI] Ошибка при отключении порта:', err);
      showIdModal(`Ошибка отключения: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isManualDisconnect = false;
    }
  };

  if (idBtn) {
    idBtn.addEventListener("click", async () => {
      // Если порт подключён — отключаем (старая логика кнопки ID была такой, но мы изменили на "только запрос ID")
      // Согласно новым требованиям: кнопка ID только шлёт запрос. Отключение — через кнопку "Подключить" или автоматически при ошибке.
      /*
      if (serial.isConnected) {
        await disconnectPort();
        updateIdButtonState(serial.isConnected);
        return;
      }
      */

      // Новая логика: если не подключён — подключаем, потом шлём ID
      if (!serial.isConnected) {
        try {
          await executeDeviceConnection(serial, comSelect, baudSelect);
          const osc = window.osc;
          if (osc && typeof osc.setSerialPort === 'function') {
            osc.setSerialPort(serial);
          }
          restoreConnection();
        } catch (err: unknown) {
          if (err instanceof PortCancelledError) return;
          const msg = err instanceof Error ? err.message : String(err);
          showIdModal('Ошибка подключения: ' + msg);
          return;
        }
      }
      // Теперь порт подключён — шлём запрос ID
      await executeDeviceIdentification(serial, comSelect, appState, baudSelect);
    });
  }

  console.log("[SerialPortUI] Инициализирован.");
}