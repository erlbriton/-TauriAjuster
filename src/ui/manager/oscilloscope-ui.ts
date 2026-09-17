/**
 * Модуль управления интерфейсом осциллографа.
 * Отвечает за:
 * - Переключение видимости осциллографа (кнопка 📈 и меню)
 * - Ресайзер (изменение ширины панели)
 * - Синхронизацию состояния UI и осциллографа
 */

import type { ISerialPort } from '../../serial/ISerialPort.js';
import type { AppState } from '../../core/app-state.js';
import type { IOscilloscopeApi } from '../../core/osc-api.js';

export interface OscilloscopeUIDeps {
  serial: ISerialPort;
  appState: AppState;
  parser: unknown; // ModbusParser
  view: IOscilloscopeApi | null;
  buffers: any[]; // ChannelBuffer[]
  
  // Функция запуска цикла чтения данных (необходима при открытии осциллографа)
  readLoop: (
    serial: ISerialPort,
    parser: unknown,
    view: IOscilloscopeApi | null,
    buffers: any[] | null,
    state: AppState
  ) => void;

  // Элементы UI
  toggleOscMainBtn: HTMLButtonElement | null;
  toggleOscArrowBtn: HTMLButtonElement | null;
  toggleOscDropdown: HTMLElement | null;
  menuToggleOsc: HTMLElement | null;
  menuViewRec: HTMLElement | null;
  oscResizer: HTMLElement | null;
  oscContainer: HTMLElement | null;
}

export function initOscilloscopeUI(deps: OscilloscopeUIDeps): void {
  const {
    serial,
    appState,
    parser,
    view,
    buffers,
    readLoop,
    toggleOscMainBtn,
    toggleOscArrowBtn,
    toggleOscDropdown,
    menuToggleOsc,
    menuViewRec,
    oscResizer,
    oscContainer
  } = deps;

    // --- Вспомогательная функция: обновление видимости ресайзера ---
  // Объявляем её здесь, чтобы она была доступна и в toggleOscilloscope, и внутри блока ресайзера.
  const updateResizerVisibility = () => {
    if (!oscContainer || !oscResizer) return;
    if (oscContainer.classList.contains('hidden') || oscContainer.style.display === 'none') {
      oscResizer.classList.add('hidden');
    } else {
      oscResizer.classList.remove('hidden');
    }
  };

  // --- Функция переключения видимости осциллографа ---
  const toggleOscilloscope = async () => {
    if (!oscContainer) return;
    
    const isHidden = oscContainer.classList.contains('hidden') || oscContainer.style.display === 'none';

    if (isHidden) {
      // Показываем осциллограф
      oscContainer.classList.remove('hidden');
      oscContainer.style.display = 'block';
      appState.isPolling = true;
      
      const osc = window.osc;
      if (osc) {
        try {
          await osc.initialize(oscContainer);
          
          if (appState.currentIniContent) {
            await osc.loadIniContent(appState.currentIniContent);
          }
          
          if (typeof osc.setConnectionStatus === 'function') {
            osc.setConnectionStatus(
              serial.isConnected,
              serial.isConnected ? undefined : 'Нет связи с устройством.'
            );
          }
          
          // Запускаем цикл чтения данных для осциллографа
          readLoop(serial, parser, osc, buffers, appState);
          
        } catch (err) {
          console.error('[OscilloscopeUI] Ошибка инициализации осциллографа:', err);
        }
      }
    } else {
      // Скрываем осциллограф
      oscContainer.classList.add('hidden');
      oscContainer.style.display = 'none';
      appState.isPolling = false;
    }
    
    // Обновляем видимость ресайзера (функция уже объявлена выше)
    updateResizerVisibility();
  };

  // --- Обработчики кнопок и меню ---

  // 1. Клик по основной части кнопки (📈)
  if (toggleOscMainBtn) {
    toggleOscMainBtn.addEventListener('click', async () => {
      await toggleOscilloscope();
    });
  }

  // 2. Клик по стрелочке (открыть меню)
  if (toggleOscArrowBtn) {
    toggleOscArrowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOscDropdown?.classList.toggle('show');
    });
  }

  // 3. Пункт меню "Осциллограф"
  if (menuToggleOsc) {
    menuToggleOsc.addEventListener('click', async () => {
      await toggleOscilloscope();
      toggleOscDropdown?.classList.remove('show');
    });
  }

  // 4. Пункт меню "Просмотр осциллограммы" (открывает viewer в новой вкладке)
  if (menuViewRec) {
    menuViewRec.addEventListener('click', () => {
      toggleOscDropdown?.classList.remove('show');
      const baseUrl = import.meta.env.BASE_URL || '/';
      window.open(baseUrl + 'rec-viewer.html', '_blank');
    });
  }

  // Закрытие выпадающего меню при клике вне его
  document.addEventListener('click', (e) => {
    if (toggleOscDropdown && !toggleOscDropdown.contains(e.target as Node) && e.target !== toggleOscArrowBtn) {
      toggleOscDropdown.classList.remove('show');
    }
  });

  // --- Логика ресайзера (изменение ширины) ---
  if (oscResizer && oscContainer) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    oscResizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = oscContainer.offsetWidth;
      oscResizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault(); // Предотвращаем выделение текста
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      // Визуальная обратная связь может быть добавлена здесь, если нужно
    });

    document.addEventListener('mouseup', (e) => {
      if (!isResizing) return;
      isResizing = false;
      oscResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Применяем новую ширину
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(200, startWidth + deltaX); // Минимум 200px
      oscContainer.style.width = `${newWidth}px`;

      // Перерисовываем графики под новый размер
      const oscInstance = window.osc;
      if (oscInstance && typeof oscInstance.syncCanvasLayout === 'function') {
        requestAnimationFrame(() => {
          oscInstance.syncCanvasLayout();
        });
      }
    });

    // Начальная установка видимости (функция уже известна)
    updateResizerVisibility();

    // Отслеживание изменений класса/style контейнера через MutationObserver
    const observer = new MutationObserver(updateResizerVisibility);
    observer.observe(oscContainer, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  console.log("[OscilloscopeUI] Инициализирован.");
}