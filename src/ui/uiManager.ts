// src/ui/uiManager.ts

import { initTableEditor } from '../ini-manager/table-editor.js';
import { setupSaveButton } from '../ini-manager/save-ini.js';
import { openIniFile, openIniFolder } from '../ini-manager/file-loader.js';
import type { ISerialPort } from '../serial/ISerialPort.js';
import type { AppState } from '../core/app-state.js';
import type { IOscilloscopeApi } from '../core/osc-api.js';
import type { ModbusParser } from '../serial/modbus.js';
import { IniParser as CoreIniParser, IniConfig } from '../core/ini/index.js';
import { updateIdBanner, showCompactError } from './ui.js';
import { reloadIniFilesFromDisk } from '../ini-manager/file-loader.js';
import { isLinux } from '../core/platform.js'; 
import { initModbusScanUI } from './modbus-scan-ui.js';
import { initReportUI } from './report-ui.js';
import { initCmdlineUI } from './cmdline-ui.js';
import { getFileStore, processSingleFileContent } from '../ini-manager/file-loader.js';
import { parseDeviceIdString, parseDeviceIdFull } from '../core/report-data.js';
import { showFwUpdateModal, FwUpdateInfo } from './fw-update-modal.js';
import { getAllDevices, getDeviceGroupKey, currentIniConfig } from '../ini-manager/tree-core.js';
import { setTreeGroupMode } from '../ini-manager/tree-core.js';
import { renderDeviceTree } from '../ini-manager/tree-ui.js';
import type { TreeGroupMode } from '../ini-manager/tree-core.js';
import { showAddressDialog } from './confirm-dialog.js';
import { PortCancelledError } from '../serial/serial.js';
import { initNewDeviceUI, showNewDeviceModal, setNewDeviceAddToLoaded } from './new-device-ui.js';
import { initBackupUI, setBackupLoadFn } from './backup-ui.js';
import { initParamPropertiesUI } from './param-properties-ui.js';
import { SearchPanel } from '../oscilloscope/ui/SearchPanel.js';
import { initHelpUI , showHelpWindow } from './help-ui.js';
import { hasAnyDirty } from '../ini-manager/dirty-tracker.js';
import { forcePickParentFolder } from '../ini-manager/db-folder.js';
import { showConfirmDialog } from './confirm-dialog.js';

/** Буфер данных канала (типизирован явно, без any) */
export interface ChannelBuffer {
  push(v: number): void;
  get(idx: number): number;
  readonly length: number;
  readonly data: number[];
  clear(): void;
  toArray(): number[];
}

export interface UiManagerDeps {
  serial: ISerialPort;
  appState: AppState;                    // было any
  parser: ModbusParser;                  // было any
  view: IOscilloscopeApi;                // было any
  buffers: ChannelBuffer[];              // было any
  setupFileHandling: (picker: HTMLInputElement, state: AppState) => void;
  setupFolderHandling?: (picker: HTMLInputElement) => void;
  updateComInterfaceName: (serial: ISerialPort, select: HTMLSelectElement | null) => string;
  executeDeviceIdentification: (
    serial: ISerialPort,
    select: HTMLSelectElement | null,
    state: AppState,
    baudSelect?: HTMLSelectElement | null
  ) => Promise<void>;
  readLoop: (
    serial: ISerialPort,
    parser: unknown,
    view: IOscilloscopeApi | null,
    buffers: ChannelBuffer[] | null,
    state: AppState
  ) => void;
  showIdModal: (text: string) => void;
  updateDeviceRegisters: (
    serial: ISerialPort,
    slaveAddr: number,
    state: AppState
  ) => Promise<boolean>;
}

export function initUI(deps: UiManagerDeps): void {
    // При каждом старте: доступ к родительской папке (Devices и BackUp) для резервных копий
    void (async () => {
        console.log('[startup] спрашиваю родительскую папку');
        const ok = await showConfirmDialog(
            'Выберите папку с *.ini файлами'
        );
        if (ok) await forcePickParentFolder();
    })();
  const {
    serial, appState, parser, view, buffers,
    setupFileHandling, setupFolderHandling, updateComInterfaceName,
    executeDeviceIdentification, readLoop, showIdModal, updateDeviceRegisters
  } = deps;
  let isManualDisconnect = false;
  const filePicker = document.getElementById('filePicker') as HTMLInputElement | null;
  const folderPicker = document.getElementById('folderPicker') as HTMLInputElement | null;
  const idBtn = document.getElementById("idBtn") as HTMLButtonElement | null;
  const connectBtn = document.getElementById("connectBtn") as HTMLButtonElement | null;
  const comSelect = document.getElementById("comSelect") as HTMLSelectElement | null;
  const baudSelect = document.getElementById("baudSelect") as HTMLSelectElement | null;
  const addrBtn = document.getElementById("addrBtn") as HTMLButtonElement | null;
  const toggleOscMainBtn = document.getElementById('toggleOscMainBtn') as HTMLButtonElement | null;
  const toggleOscArrowBtn = document.getElementById('toggleOscArrowBtn') as HTMLButtonElement | null;
  const toggleOscDropdown = document.getElementById('toggleOscDropdown') as HTMLElement | null;
  const menuToggleOsc = document.getElementById('menuToggleOsc') as HTMLElement | null;
  const menuViewRec = document.getElementById('menuViewRec') as HTMLElement | null;
  const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement | null;
  const folderActionBtn = document.getElementById('folderActionBtn') as HTMLButtonElement | null;
  const folderArrowBtn = document.getElementById('folderArrowBtn') as HTMLButtonElement | null;
  const folderDropdown = document.getElementById('folderDropdown') as HTMLElement | null;
  const menuOpenFile = document.getElementById('menuOpenFile') as HTMLElement | null;
  const menuOpenFolder = document.getElementById('menuOpenFolder') as HTMLElement | null;

  const restoreConnection = (): void => {
    if (!serial.isConnected) return;
    // БЫЛО: const osc = (window as any).osc;
    // СТАЛО:
    const osc = window.osc;
    if (osc && typeof osc.setConnectionStatus === 'function') {
      osc.setConnectionStatus(true);
    }
    const oscContainerEl = document.getElementById('osc-container');
    const isOscVisible = oscContainerEl &&
      !oscContainerEl.classList.contains('hidden') &&
      oscContainerEl.style.display !== 'none';
    if (isOscVisible) {
      console.log('[UI] Перезапускаем readLoop после восстановления связи');
      appState.isLoopRunning = false;
      appState.isPolling = true;
      readLoop(serial, parser, view, buffers, appState);
    }
  };

  if (folderPicker && typeof setupFolderHandling === 'function') setupFolderHandling(folderPicker);

  // Обёртка loadIniContent — типизирована через IOscilloscopeApi
  if (view && typeof view.loadIniContent === 'function' && !(view as unknown as Record<string, unknown>).__loadIniContentWrapped) {
    const originalLoadIniContent = view.loadIniContent.bind(view);
    (view as unknown as Record<string, unknown>).__loadIniContentWrapped = true;
    view.loadIniContent = async (iniContent: string) => {
      try {
                        if (typeof iniContent === 'string' && iniContent.trim().length > 0) {
                    appState.currentIniContent = iniContent;
          const coreParser = new CoreIniParser();
          const parseResult = coreParser.parse(iniContent);
          appState.currentIniConfig = new IniConfig(parseResult);
          console.log('[INI SYNC] currentIniConfig updated.');
        }
      } catch (err) {
        console.warn('[INI SYNC] Failed to sync appState:', err);
      }
      return originalLoadIniContent(iniContent);
    };
  }

    if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      // Кнопка "Подключить":
      //  - если порт уже открыт (кнопкой ID или предыдущим "Подключить") —
      //    просто читаем ID из баннера, не посылая 0x11 повторно;
      //  - если порт закрыт — открываем его и читаем ID через
      //    executeDeviceIdentification (она сама откроет, отправит 0x11,
      //    запишет в баннер и корректно обработает отмену выбора порта).
      // Этап поиска "родного" INI — следующий шаг.

      let idText: string;

      if (serial.isConnected) {
        const banner = document.querySelector('.id-banner span');
        idText = (banner?.textContent ?? '').trim();
      } else {
        try {
          await executeDeviceIdentification(serial, comSelect, appState, baudSelect);
        } catch (err: unknown) {
          // Отмена выбора порта уже обработана внутри executeDeviceIdentification
          // (через PortCancelledError), но для надёжности перехватываем и здесь.
          if (err instanceof PortCancelledError) {
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          showIdModal("Ошибка: " + msg);
          return;
        }

        const banner = document.querySelector('.id-banner span');
        idText = (banner?.textContent ?? '').trim();
      }

      // Поиск "родного" INI среди загруженных файлов.
      // Критерий совпадения: серийный номер + тип устройства (без версии).
      if (!idText) {
        console.log('[Connect] Строка ID пустая — поиск пропущен.');
        return;
      }

      const target = parseDeviceIdString(idText);
      let matchedId: string | null = null;

      let fwUpdateCandidate: string | null = null;
      for (const device of getAllDevices()) {
        const candidate = device.iniConfig?.device?.id;
        if (!candidate) continue;
        const parsed = parseDeviceIdString(candidate);
        if (parsed.serial === target.serial && parsed.deviceType === target.deviceType && parsed.version === target.version) {
          matchedId = device.id;
          break;
        }
        // Запоминаем кандидата с совпадающим serial+deviceType, но разной version
        if (
          parsed.serial === target.serial &&
          parsed.deviceType === target.deviceType &&
          parsed.version !== target.version
        ) {
          fwUpdateCandidate = device.id;
        }
      }

      if (!matchedId && fwUpdateCandidate) {
        // Третий случай: номер и модель совпадают, но версия ПО отличается
        const fullInfo: FwUpdateInfo = parseDeviceIdFull(idText);
        
        // Получаем имя файла старого устройства
        const oldDevice = getAllDevices().find((d) => d.id === fwUpdateCandidate);
        if (oldDevice) {
          const oldDev = oldDevice.iniConfig.device;
          const oldDevId = oldDev ? oldDev.id : '';
          const oldLoc = oldDev?.location ?? '';
          const store = getFileStore();
          const entry = store.get(`${oldLoc}::${oldDevId}`);
          if (entry?.file) {
            fullInfo.oldFileName = entry.file.name;
          }
        }
        
        console.log(`[Connect] Найдено устройство с другой версией ПО: ${fwUpdateCandidate}, oldFileName=${fullInfo.oldFileName}`);
        showFwUpdateModal(fullInfo);
        return;
      }

      if (matchedId !== null) {
        // Программный клик по узлу дерева:
        // - подсветка .is-selected переедет на него;
        // - setCurrentIniConfig / populateDeviceForm / renderModbusTable
        //   будут вызваны в обработчике клика самого <li>;
        // - osциллограф получит новое активное устройство через app:ini-file-loaded.
        const leaf = document.querySelector<HTMLLIElement>(
          `.tree-id-item.is-leaf[data-device-id="${CSS.escape(matchedId)}"]`,
        );
        if (leaf) {
          // Раскрываем родительскую группу <details>, если она свёрнута
          const details = leaf.closest('details.tree-location');
          if (details) {
            (details as HTMLDetailsElement).open = true;
          }
          leaf.click();
          console.log(`[Connect] Родной INI найден и выбран: ${matchedId}`);
        } else {
          console.warn(`[Connect] Родной INI найден (${matchedId}), но узел дерева не отрендерен.`);
        }
      } else {
        // Родной INI не найден — открываем окно "Новое устройство".
        console.log('[Connect] Родной INI не найден среди загруженных файлов.');
        showNewDeviceModal(idText);
      }
    });
  }

  if (serial && typeof serial.onDisconnect === 'function') {
    serial.onDisconnect(() => {
      const osc = window.osc;
      if (isManualDisconnect) {
        console.log('[UI] Порт отключён вручную пользователем (без предупреждения осциллографа).');
        // Останавливаем маркеры, но НЕ показываем модальное окно (пустая строка = suppress modal)
        if (osc && typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false, '');
        }
      } else {
        console.log('[UI] Обрыв связи обнаружен (физический обрыв USB).');
        // Останавливаем маркеры И показываем предупреждение
        if (osc && typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(false, 'Связь с устройством потеряна.');
        }
      }
      // В обоих случаях: обновляем UI (баннер, кнопка, состояние опроса)
      appState.isPolling = false;
      updateIdBanner('');
      updateIdButtonState(false);
    });
  }

  // Синхронизирует надпись и тултип кнопки ID с текущим состоянием порта.
  // connected=true  → "Off" / "Отключить com порт"
  // connected=false → "ID"  / "Подключить com порт"
  const updateIdButtonState = (connected: boolean): void => {
    if (!idBtn) return;
    if (connected) {
      idBtn.textContent = 'Off';
      idBtn.title = 'Отключить com порт';
    } else {
      idBtn.textContent = 'ID';
      idBtn.title = 'Подключить com порт';
    }
  };

  // Начальное состояние (до первого взаимодействия).
  updateIdButtonState(false);

  // Отключение порта через release().
  // release() автоматически вызовет onDisconnect callback, который сбросит
  // кнопку ID в состояние "ID" / "Подключить com порт" через updateIdButtonState(false).
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
      if (serial.isConnected) {
        // Порт подключён — отключаем
        await disconnectPort();
        // После отключения (когда оно будет реализовано) обновим вид кнопки.
        updateIdButtonState(serial.isConnected);
        return;
      }
      // Порт не подключён — подключаем через идентификацию
      await executeDeviceIdentification(serial, comSelect, appState, baudSelect);

      const osc = window.osc;
      if (osc && typeof osc.setSerialPort === 'function') {
        osc.setSerialPort(serial);
      }

      restoreConnection();

      // После подключения обновляем вид кнопки на "Off" / "Отключить com порт"
      updateIdButtonState(serial.isConnected);
    });
  }

  // Обновление таблицы (FC03). Используется и кнопкой "Обновить",
  // и автообновлением после загрузки INI-файла.
  const performRefresh = async (notifyIfDisconnected: boolean): Promise<void> => {
    if (!serial?.isConnected) {
      if (notifyIfDisconnected) showIdModal("Устройство не подключено!");
      return;
    }
    if (appState.isRefreshing) return;
    appState.isRefreshing = true;
    if (refreshBtn) refreshBtn.disabled = true;

    const wasPolling = appState.isPolling;

    try {
      // Выполняем обновление таблицы и проверяем результат
      const success = await updateDeviceRegisters(serial, appState.slaveAddress, appState);

      if (success) {
        // Успешно: восстанавливаем опрос, если он был активен до обновления
        if (wasPolling) {
          console.log('[UI] Восстанавливаем опрос после обновления');
          appState.isLoopRunning = false;
          appState.isPolling = true;
          readLoop(serial, parser, view, buffers, appState);
        }
      } else {
        // Неудача (контроллер не отвечает или ошибки связи):
        // показываем компактное окно ошибки независимо от осциллографа
        console.warn('[UI] updateDeviceRegisters вернул false — связь не удалась');
        showCompactError('Контроллер не отвечает. Проверьте адрес и подключение.');
      }
    } catch (err) {
      console.error("Ошибка при обновлении:", err);
      // На случай исключительной ситуации тоже показываем окно
      showCompactError('Ошибка при обновлении таблицы. Проверьте связь.');
    } finally {
      appState.isRefreshing = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      await performRefresh(true);
    });
  }

  // ==========================================================================
  // Первая кнопка шапки: список устройств (основная кнопка + выпадающий список)
  // ==========================================================================
  const deviceListActionBtn = document.getElementById('deviceListActionBtn') as HTMLButtonElement | null;
  const deviceListArrowBtn = document.getElementById('deviceListArrowBtn') as HTMLButtonElement | null;
  const deviceListDropdown = document.getElementById('deviceListDropdown') as HTMLElement | null;

  // Текущий режим кнопки (по умолчанию — "Обновить")
  let deviceListMode = 'refresh';

  // Соответствие режимов кнопки — режимам группировки дерева
  const treeModeByButtonMode: Record<string, TreeGroupMode> = {
    refresh: 'location',
    serials: 'serial',
    place: 'location',
    mechType: 'mechType',
    serviceDate: 'serviceDate',
    deviceType: 'deviceType',
  };

  const deviceListMenu: Array<{ id: string; mode: string }> = [
    { id: 'menuDeviceRefresh', mode: 'refresh' },
    { id: 'menuDeviceSerials', mode: 'serials' },
    { id: 'menuDevicePlace', mode: 'place' },
    { id: 'menuDeviceMechType', mode: 'mechType' },
    { id: 'menuDeviceServiceDate', mode: 'serviceDate' },
    { id: 'menuDeviceType', mode: 'deviceType' },
  ];

  // Пометка выбранного пункта маркером "•" (как на скриншоте), без правки CSS
  const markSelectedDeviceItem = (): void => {
    for (const item of deviceListMenu) {
      const el = document.getElementById(item.id);
      if (!el) continue;
      const label = el.dataset.label ?? (el.textContent || '').replace(/^•\s*/, '');
      el.dataset.label = label;
      el.textContent = item.mode === deviceListMode ? '• ' + label : label;
    }
  };

  if (deviceListArrowBtn && deviceListDropdown) {
    // Раскрытие/закрытие списка по клику на треугольничек
    deviceListArrowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = deviceListDropdown.style.display === 'block';
      deviceListDropdown.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) markSelectedDeviceItem();
    });

    // Закрытие по клику вне списка
    document.addEventListener('click', (e) => {
      if (!deviceListDropdown.contains(e.target as Node) && e.target !== deviceListArrowBtn) {
        deviceListDropdown.style.display = 'none';
      }
    });

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') deviceListDropdown.style.display = 'none';
    });

    // Выбор пункта меню: запоминаем режим и сразу перестраиваем дерево
    for (const item of deviceListMenu) {
      const el = document.getElementById(item.id);
      if (el) {
        el.addEventListener('click', () => {
          deviceListMode = item.mode;
          deviceListDropdown.style.display = 'none';
          markSelectedDeviceItem();
          setTreeGroupMode(treeModeByButtonMode[item.mode] ?? 'location');
          renderDeviceTree();
          console.log(`[UI] Выбрана функция кнопки списка устройств: ${item.mode}`);
        });
      }
    }
  }

  // Основная кнопка: выполняет текущую выбранную функцию
  if (deviceListActionBtn) {
    deviceListActionBtn.addEventListener('click', async () => {
      // Следующим этапом здесь появятся функции всех пунктов меню.
      // Пока реализована только функция по умолчанию — "Обновить список устройств".
      if (deviceListMode === 'refresh') {
        const results = await reloadIniFilesFromDisk();
        if (results.updated === 0 && results.removed === 0 && results.errors.length === 0) {
          showCompactError('Изменений в INI-файлах не обнаружено.');
        } else {
          const parts: string[] = [];
          if (results.updated > 0) parts.push(`Изменений в файлах: ${results.updated}`);
          if (results.removed > 0) parts.push(`удалено из списка: ${results.removed}`);
          showCompactError(`Содержимое  ini файлов обновлено. ${parts.join(', ')}.`);
        }
        if (results.errors.length > 0) {
          console.warn('[UI] reloadIniFilesFromDisk — ошибки:', results.errors);
        }
      } else {
        // Режимы группировки: основная кнопка перестраивает дерево
        setTreeGroupMode(treeModeByButtonMode[deviceListMode] ?? 'location');
        renderDeviceTree();
      }
    });
  }

  // Автообновление после загрузки/смены INI-файла: тихо, только если порт открыт
  window.addEventListener('app:ini-file-loaded', () => {
    void performRefresh(false);
  });

  // ---------------------------------------------------------------------------
  // Командная строка (кнопка терминала)
  // ---------------------------------------------------------------------------
  initCmdlineUI();
  initHelpUI();

  // Клавиша F1: открываем справку приложения вместо справки браузера.
  // preventDefault() подавляет действие браузера по умолчанию.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'F1') {
      e.preventDefault();
      showHelpWindow();
    }
  });

  // ---------------------------------------------------------------------------
  // Окно "Новое устройство" (если родной INI не найден)
  // ---------------------------------------------------------------------------
  initNewDeviceUI();
  initBackupUI();
  initParamPropertiesUI();
  setBackupLoadFn((content, fileName, file, handle) => processSingleFileContent(content, fileName, appState, file, handle));

  // ---------------------------------------------------------------------------
  // Кнопка "Сегодня": текущая дата в поле даты (формат ДД.ММ.ГГГГ)
  // ---------------------------------------------------------------------------
  document.getElementById('todayBtn')?.addEventListener('click', () => {
      const dateInput = document.querySelector('.date-input') as HTMLInputElement | null;
      if (!dateInput) return;
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      dateInput.value = `${dd}.${mm}.${now.getFullYear()}`;
  });

  // ---------------------------------------------------------------------------
  // Кнопка "?" — поиск имени в списке устройств (по "Место установки")
  // ---------------------------------------------------------------------------
  // === Панель поиска параметра в таблице Modbus ===
  const searchPanel = new SearchPanel();
  searchPanel.onSelect = (item) => {
    console.log('[uiManager] searchPanel.onSelect: item.id =', item.id);
    
    // Убираем выделение со ВСЕХ строк в таблице Modbus
    const allSelected = document.querySelectorAll('#grid-data-rows tr[data-key].selected');
    console.log('[uiManager] Найдено строк с .selected:', allSelected.length);
    allSelected.forEach((el) => {
      el.classList.remove('selected');
    });
    
    // Ищем строку по data-key и выделяем
    const row = document.querySelector<HTMLTableRowElement>(`#grid-data-rows tr[data-key="${CSS.escape(item.id)}"]`);
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      console.log('[uiManager] Строка выделена:', item.id);
    } else {
      console.warn('[uiManager] Строка не найдена:', item.id);
    }
  };

  const treeSearchOverlay = document.getElementById('treeSearchOverlay');
  const treeSearchInput = document.getElementById('treeSearchInput') as HTMLInputElement | null;
  const treeSearchStatus = document.getElementById('treeSearchStatus');

  const hideTreeSearch = (): void => {
      treeSearchOverlay?.classList.add('hidden');
  };

  const doTreeSearch = (): void => {
      const query = (treeSearchInput?.value ?? '').trim();
      if (!query) {
          if (treeSearchStatus) treeSearchStatus.textContent = 'Введите название места.';
          return;
      }
      const queryLower = query.toLowerCase();

      // Уникальные имена групп ("Место установки") в порядке загрузки.
      const all = getAllDevices();
      const keys: string[] = [];
      for (const d of all) {
          const k = getDeviceGroupKey(d, 'location');
          if (!keys.includes(k)) keys.push(k);
      }

      // Точный поиск: сначала полное совпадение, затем начало строки, затем вхождение.
      const matchedKey =
          keys.find((k) => k.toLowerCase() === queryLower) ??
          keys.find((k) => k.toLowerCase().startsWith(queryLower)) ??
          keys.find((k) => k.toLowerCase().includes(queryLower));

      if (!matchedKey) {
          if (treeSearchStatus) treeSearchStatus.textContent = `Не найдено: ${query}`;
          return;
      }

      setTreeGroupMode('location');
      renderDeviceTree();

      // Раскрываем найденную группу и выделяем первый файл в ней.
      const detailsList = document.querySelectorAll('details.tree-location');
      for (const details of detailsList) {
          const summary = details.querySelector('summary');
          if ((summary?.textContent ?? '').trim() !== matchedKey) continue;
          (details as HTMLDetailsElement).open = true;
          const firstLeaf = details.querySelector<HTMLLIElement>('.tree-id-item.is-leaf');
          if (firstLeaf) firstLeaf.click();
          break;
      }
      hideTreeSearch();
  };

  const treeSearchSplit = document.getElementById('treeSearchSplit');
  const treeSearchMainBtn = document.getElementById('treeSearchMainBtn');
  const treeSearchDropdownBtn = document.getElementById('treeSearchDropdownBtn');
  const treeSearchMenu = document.getElementById('treeSearchMenu');

  const openTreeSearchOverlay = (): void => {
      if (!treeSearchOverlay) return;
      if (treeSearchInput) treeSearchInput.value = '';
      if (treeSearchStatus) treeSearchStatus.textContent = '';
      treeSearchOverlay.classList.remove('hidden');
      treeSearchInput?.focus();
  };

  // Клик по основной части (знак вопроса) — сразу "Поиск места установки"
  treeSearchMainBtn?.addEventListener('click', openTreeSearchOverlay);

  // Клик по треугольнику — показать/скрыть меню
  treeSearchDropdownBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      treeSearchMenu?.classList.toggle('show');
  });

  // Клик по пункту меню
  treeSearchMenu?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.getAttribute('data-action');
      if (!action) return;

      treeSearchMenu.classList.remove('show');

      if (action === 'location') {
          openTreeSearchOverlay();
      } else if (action === 'param') {
          // Собираем список параметров из текущей секции таблицы
          const modeSelect = document.querySelector<HTMLSelectElement>('.toolbar-device-mode-select');
          const selectedMode = modeSelect && modeSelect.value ? modeSelect.value : 'FLASH';
          
          if (currentIniConfig) {
              const params = currentIniConfig.getSection(selectedMode);
              const items = params.map((p) => ({ id: p.id, name: p.name }));
              searchPanel.open(items);
          } else {
              console.warn('[uiManager] Нет загруженного INI для поиска параметра');
          }
      }
  });

  // Закрыть меню при клике вне его
  document.addEventListener('click', (e) => {
      if (treeSearchMenu && treeSearchMenu.classList.contains('show')) {
          if (treeSearchSplit && !treeSearchSplit.contains(e.target as Node)) {
              treeSearchMenu.classList.remove('show');
          }
      }
  });
  document.getElementById('treeSearchCloseBtn')?.addEventListener('click', hideTreeSearch);
  document.getElementById('treeSearchCancelBtn')?.addEventListener('click', hideTreeSearch);
  document.getElementById('treeSearchFindBtn')?.addEventListener('click', doTreeSearch);
  treeSearchOverlay?.addEventListener('click', (e: MouseEvent) => {
      if (e.target === treeSearchOverlay) hideTreeSearch();
  });
  treeSearchInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); doTreeSearch(); }
      if (e.key === 'Escape') { e.preventDefault(); hideTreeSearch(); }
  });
  setNewDeviceAddToLoaded((content, fileName, file, handle) =>
    processSingleFileContent(content, fileName, appState, file, handle));

  // ---------------------------------------------------------------------------
  // Отчёты (кнопка 📋)
  // ---------------------------------------------------------------------------
  initReportUI({
    getAppState: () => appState,
    getFileStore: () => getFileStore(),
    getOscilloscope: () => (window as { osc?: unknown }).osc as {
        settings: { amplitudeMarkerTime: number | null };
        archive: { getRawAtTime: (id: string, t: number) => number | null; getValueAtTime: (id: string, t: number) => number | null };
        allChannels: Array<{ id: string; modbusReg?: string }>;
    } | null,
  });

  // ---------------------------------------------------------------------------
  // Поиск устройств в сети Modbus (кнопка 🔍)
  // ---------------------------------------------------------------------------
  let scanWasPolling = false;

  initModbusScanUI({
    isPortOpen: () => serial.isConnected,
    pausePolling: () => {
      // Запоминаем, шёл ли опрос, и останавливаем его на время поиска
      scanWasPolling = appState.isPolling;
      appState.isPolling = false;
    },
    resumePolling: () => {
      // Возобновляем опрос только если он шёл до поиска
      if (scanWasPolling) {
        appState.isPolling = true;
        void readLoop(serial, parser, window.osc ?? null, buffers, appState);
      }
    },
        connectToDevice: (addr: number, idText: string) => {
      // 1. Переключаем адрес опроса — readLoop подхватит его на следующем запросе
      appState.slaveAddress = addr;
      console.log(`[UI][Scan] Опрос переключён на адрес ${addr}`);

      // 2. Если ID пустой — сразу открываем окно "Новое устройство"
      if (!idText) {
        console.log('[UI][Scan] ID не получен — открываем "Новое устройство".');
        showNewDeviceModal('');
        return;
      }

      // 3. Ищем "родной" INI среди загруженных файлов
      //    (критерий: серийный номер + тип устройства + версия)
      const target = parseDeviceIdString(idText);
      let matchedId: string | null = null;

      let fwUpdateCandidate: string | null = null;
      for (const device of getAllDevices()) {
        const candidate = device.iniConfig?.device?.id;
        if (!candidate) continue;
        const parsed = parseDeviceIdString(candidate);
        if (
          parsed.serial === target.serial &&
          parsed.deviceType === target.deviceType &&
          parsed.version === target.version
        ) {
          matchedId = device.id;
          break;
        }
        // Запоминаем кандидата с совпадающим serial+deviceType, но разной version
        if (
          parsed.serial === target.serial &&
          parsed.deviceType === target.deviceType &&
          parsed.version !== target.version
        ) {
          fwUpdateCandidate = device.id;
        }
      }

      if (!matchedId && fwUpdateCandidate) {
        // Третий случай: номер и модель совпадают, но версия ПО отличается
        const fullInfo: FwUpdateInfo = parseDeviceIdFull(idText);
        
        // Получаем имя файла старого устройства
        const oldDevice = getAllDevices().find((d) => d.id === fwUpdateCandidate);
        if (oldDevice) {
          const oldDev = oldDevice.iniConfig.device;
          const oldDevId = oldDev ? oldDev.id : '';
          const oldLoc = oldDev?.location ?? '';
          const store = getFileStore();
          const entry = store.get(`${oldLoc}::${oldDevId}`);
          if (entry?.file) {
            fullInfo.oldFileName = entry.file.name;
          }
        }
        
        console.log(`[UI][Scan] Найдено устройство с другой версией ПО: ${fwUpdateCandidate}, oldFileName=${fullInfo.oldFileName}`);
        showFwUpdateModal(fullInfo);
        return;
      }

      if (matchedId !== null) {
        // 4a. Родной INI найден — программный клик по узлу дерева:
        //     подсветка, setCurrentIniConfig, populateDeviceForm, renderModbusTable
        //     сработают в обработчике клика самого <li>.
        const leaf = document.querySelector<HTMLLIElement>(
          `.tree-id-item.is-leaf[data-device-id="${CSS.escape(matchedId)}"]`,
        );
        if (leaf) {
          const details = leaf.closest('details.tree-location');
          if (details) {
            (details as HTMLDetailsElement).open = true;
          }
          leaf.click();
          console.log(`[UI][Scan] Родной INI найден и выбран: ${matchedId}`);
        } else {
          console.warn(`[UI][Scan] Родной INI найден (${matchedId}), но узел дерева не отрендерен.`);
        }
      } else {
        // 4b. Родной INI не найден — тот же алгоритм, что у кнопки "Подключиться"
        console.log('[UI][Scan] Родной INI не найден — открываем "Новое устройство".');
        showNewDeviceModal(idText);
      }
    },
  });

      // Функция переключения видимости осциллографа
  const toggleOscilloscope = async () => {
    const oscContainerEl = document.getElementById('osc-container');
    if (!oscContainerEl) return;
    const isHidden = oscContainerEl.classList.contains('hidden') || oscContainerEl.style.display === 'none';

    if (isHidden) {
      oscContainerEl.classList.remove('hidden');
      oscContainerEl.style.display = 'block';
      appState.isPolling = true;
      const osc = window.osc;
      if (osc) {
        await osc.initialize(oscContainerEl ?? undefined);
        if (appState.currentIniContent) {
          await osc.loadIniContent(appState.currentIniContent);
        }
        if (typeof osc.setConnectionStatus === 'function') {
          osc.setConnectionStatus(
            serial.isConnected,
            serial.isConnected ? undefined : 'Нет связи с устройством.'
          );
        }
        readLoop(serial, parser, osc, buffers, appState);
      }
    } else {
      oscContainerEl.classList.add('hidden');
      oscContainerEl.style.display = 'none';
      appState.isPolling = false;
    }
  };

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

      // 4. Пункт меню "Просмотр осциллограммы" — открывает новую вкладку
  if (menuViewRec) {
    menuViewRec.addEventListener('click', () => {
      toggleOscDropdown?.classList.remove('show');
      window.open(import.meta.env.BASE_URL + 'rec-viewer.html', '_blank');
    });
  }

  // --- Ресайзер осциллографа ---
  const oscResizer = document.getElementById('oscResizer') as HTMLElement | null;
  const oscContainerForResize = document.getElementById('osc-container') as HTMLElement | null;

  if (oscResizer && oscContainerForResize) {
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      oscResizer.addEventListener('mousedown', (e) => {
          isResizing = true;
          startX = e.clientX;
          startWidth = oscContainerForResize.offsetWidth;
          oscResizer.classList.add('resizing');
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
          if (!isResizing) return;
          // Не меняем ширину в реальном времени — только запоминаем позицию
      });

      document.addEventListener('mouseup', (e) => {
          if (!isResizing) return;
          isResizing = false;
          oscResizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';

          // Применяем новую ширину "скачком"
          const deltaX = e.clientX - startX;
          const newWidth = Math.max(200, startWidth + deltaX); // Минимум 200px
          oscContainerForResize.style.width = `${newWidth}px`;

          // Перерисовываем графики осциллографа под новую ширину
          // (requestAnimationFrame — чтобы браузер успел пересчитать layout)
          const oscInstance = window.osc;
          if (oscInstance && typeof oscInstance.syncCanvasLayout === 'function') {
              requestAnimationFrame(() => {
                  oscInstance.syncCanvasLayout();
              });
          }
      });

      // Скрывать ресайзер, когда осциллограф скрыт
      const updateResizerVisibility = () => {
          if (oscContainerForResize.classList.contains('hidden')) {
              oscResizer.classList.add('hidden');
          } else {
              oscResizer.classList.remove('hidden');
          }
      };

      updateResizerVisibility();
      
      // Отслеживать изменение видимости осциллографа
      const observer = new MutationObserver(updateResizerVisibility);
      observer.observe(oscContainerForResize, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  if (folderActionBtn) folderActionBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await openIniFile(appState);
  });
  if (menuOpenFile) menuOpenFile.addEventListener('click', async () => {
    await openIniFile(appState);
    folderDropdown?.classList.remove('show');
  });
  if (menuOpenFolder) menuOpenFolder.addEventListener('click', async () => {
    await openIniFolder(appState);
    folderDropdown?.classList.remove('show');
  });

  // Windows: открытие папки недоступно — физически скрываем стрелочку,
  // разделитель и пункт "Открыть папку". Кнопка становится обычной
  // одиночной "Открыть файл". В Linux всё остаётся как есть.
  if (!isLinux()) {
    if (menuOpenFolder) menuOpenFolder.style.display = 'none';
    if (folderArrowBtn) {
      folderArrowBtn.style.display = 'none';
      const divider = folderArrowBtn.previousElementSibling as HTMLElement | null;
      if (divider && divider.classList.contains('split-btn-divider')) {
        divider.style.display = 'none';
      }
    }
  }
  if (folderArrowBtn) folderArrowBtn.addEventListener('click', (e) => { e.stopPropagation(); folderDropdown?.classList.toggle('show'); });
    document.addEventListener('click', () => {
    folderDropdown?.classList.remove('show');
    toggleOscDropdown?.classList.remove('show');
  });

  // Обработчик смены скорости: ЖЕСТКИЙ сброс и переподключение
    // Обработчик смены скорости: просто запоминаем выбор для следующего подключения.
  // Переподключение "на лету" удалено из-за нестабильности Web Serial API.
  if (baudSelect) {
    baudSelect.addEventListener('change', () => {
      const newBaudRate = parseInt(baudSelect.value, 10) || 115200;
      
      if (serial.isConnected) {
        console.log(`[UI] Скорость изменена на ${newBaudRate}. Для применения необходимо переподключиться (кнопка "Подключить").`);
        // Опционально: можно показать подсказку пользователю, но пока оставим лог.
        // showIdModal(`Скорость изменена на ${newBaudRate}. Нажмите "Подключить", чтобы применить.`);
      } else {
        console.log(`[UI] Скорость установлена на ${newBaudRate} (будет использована при подключении).`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Переключение BUS: MODBUS RTU <-> MODBUS TCP/IP
  // RTU: видны COM, BPS, FE. TCP/IP: видны IP и Port.
  // ---------------------------------------------------------------------------
  const busSelect = document.getElementById('busSelect') as HTMLSelectElement | null;
  const rtuControls = document.getElementById('rtuControls') as HTMLElement | null;
  const tcpControls = document.getElementById('tcpControls') as HTMLElement | null;

  const applyBusMode = (): void => {
    const isTcp = busSelect?.value === 'TCP';
    if (rtuControls) rtuControls.style.display = isTcp ? 'none' : '';
    if (tcpControls) tcpControls.style.display = isTcp ? '' : 'none';
    console.log(`[UI] Режим связи: ${isTcp ? 'MODBUS TCP/IP' : 'MODBUS RTU'}`);
  };

  if (busSelect) {
    busSelect.addEventListener('change', applyBusMode);
    applyBusMode(); // применяем текущий режим при старте
  }

  // Кнопка адреса Modbus: окно ввода, новый адрес применяется ко всему обмену
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

  initTableEditor('grid-data-rows', appState);
  setupSaveButton(appState);

      // ============================================================================
  // Обработчики событий бизнес-логики (готово к Tauri)
  // В нативном приложении тело этих функций будет заменено на вызовы Tauri API.
  // ============================================================================

    // Событие: Контроллер перестал отвечать (серия таймаутов)
  window.addEventListener('app:controller-not-responding', (e: Event) => {
    const detail = (e as CustomEvent).detail as { consecutiveTimeouts?: number } | undefined;
    const count = detail?.consecutiveTimeouts ?? 0;
    console.log(`[UI] Получено событие "контроллер не отвечает" (подряд ошибок: ${count})`);

    // 1. Показываем компактное окно ВСЕГДА (независимо от осциллографа)
    showCompactError('Контроллер не отвечает. Проверьте адрес и подключение.');

    // 2. Если осциллограф открыт — замораживаем его рендер (без своего окна)
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
      void readLoop(serial, parser, view, buffers, appState);
    }
  });

  // Конец обработчиков событий
  // ============================================================================

  // Защита от закрытия вкладки при несохранённых изменениях:
  // браузер покажет стандартное предупреждение.
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (hasAnyDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  console.log("UI Manager: Интерфейс и обработчики инициализированы.");
}