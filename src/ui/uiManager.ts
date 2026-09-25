// src/ui/uiManager.ts

import { initTableEditor } from '../ini-manager/table-editor.js';
import { setupSaveButton } from '../ini-manager/save-ini.js';
//import { openIniFile, openIniFolder } from '../ini-manager/file-loader.js';
import { openIniFileTauri, openIniFolderTauri } from '../ini-manager/file-loader-tauri.js';
import type { ISerialPort } from '../serial/ISerialPort.js';
import type { AppState } from '../core/app-state.js';
import type { IOscilloscopeApi } from '../core/osc-api.js';
import type { ModbusParser } from '../serial/modbus.js';
import { IniParser as CoreIniParser, IniConfig } from '../core/ini/index.js';
import { updateIdBanner, showCompactError } from './ui.js';
import { reloadIniFilesFromDisk } from '../ini-manager/file-sync.js';
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
import { initSerialPortUI } from './manager/serial-port.js';
import { initDeviceManagementUI } from './manager/device-management.js';
import { initOscilloscopeUI } from './manager/oscilloscope-ui.js';
import { initSearchNavigationUI } from './manager/search-navigation.js';
import { initCommunicationSettingsUI } from './manager/communication-settings.js';

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
  //setupFileHandling: (picker: HTMLInputElement, state: AppState) => void;
  //setupFolderHandling?: (picker: HTMLInputElement) => void;
  updateComInterfaceName: (serial: ISerialPort, select: HTMLSelectElement | null) => string;
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
    // В Tauri-версии папка Devices автоматически подхватывается автозагрузчиком
    // (src/core/platform/tauri-autoloader.ts), поэтому диалог выбора при старте не нужен.
    // Код оставлен закомментированным для возможной браузерной совместимости.
    /*
    void (async () => {
        console.log('[startup] спрашиваю родительскую папку');
        const ok = await showConfirmDialog(
            'Выберите папку с *.ini файлами'
        );
        if (ok) await forcePickParentFolder();
    })();
    */
  const {
    serial, appState, parser, view, buffers,
    updateComInterfaceName,
    executeDeviceConnection, executeDeviceIdentification, readLoop, showIdModal, updateDeviceRegisters
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

    // --- Инициализация модуля управления COM-портами ---
  // Делегируем логику работы с портами, кнопкой ID и обработкой отключения
  // в отдельный модуль serial-port.ts для лучшей структуры кода.
  
  // Определяем restoreConnection здесь, чтобы передать её в модуль до использования.
  const restoreConnection = (): void => {
    if (!serial.isConnected) return;
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
  }; // <--- ДОБАВИТЬ ЭТУ ЗАКРЫВАЮЩУЮ СКОБКУ И ТОЧКУ С ЗАПЯТОЙ

  initSerialPortUI({
    serial,
    appState,
    comSelect,
    baudSelect,
    idBtn,
    executeDeviceConnection,
    executeDeviceIdentification,
    restoreConnection
  });

 // if (folderPicker && typeof setupFolderHandling === 'function') setupFolderHandling(folderPicker);

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
 
  const deviceListActionBtn = document.getElementById('deviceListActionBtn') as HTMLButtonElement | null;
  const deviceListArrowBtn = document.getElementById('deviceListArrowBtn') as HTMLButtonElement | null;
  const deviceListDropdown = document.getElementById('deviceListDropdown') as HTMLElement | null;
  
  initDeviceManagementUI({
    serial,
    appState,
    parser,
    view,
    buffers,
    connectBtn,
    refreshBtn,
    deviceListActionBtn,
    deviceListArrowBtn,
    deviceListDropdown,
    comSelect,
    baudSelect,
    executeDeviceIdentification,
    readLoop,
    updateDeviceRegisters
  });

    // --- Инициализация модуля поиска и навигации ---
  // Делегируем логику поиска, кнопки "Сегодня" и модальных окон в отдельный модуль.
  
  const treeSearchOverlayEl = document.getElementById('treeSearchOverlay') as HTMLElement | null;
  const treeSearchInputEl = document.getElementById('treeSearchInput') as HTMLInputElement | null;
  const treeSearchStatusEl = document.getElementById('treeSearchStatus') as HTMLElement | null;
  const treeSearchCloseBtnEl = document.getElementById('treeSearchCloseBtn') as HTMLElement | null;
  const treeSearchCancelBtnEl = document.getElementById('treeSearchCancelBtn') as HTMLElement | null;
  const treeSearchFindBtnEl = document.getElementById('treeSearchFindBtn') as HTMLElement | null;
  const treeSearchSplitEl = document.getElementById('treeSearchSplit') as HTMLElement | null;
  const treeSearchMainBtnEl = document.getElementById('treeSearchMainBtn') as HTMLElement | null;
  const treeSearchDropdownBtnEl = document.getElementById('treeSearchDropdownBtn') as HTMLElement | null;
  const treeSearchMenuEl = document.getElementById('treeSearchMenu') as HTMLElement | null;
  const todayBtnEl = document.getElementById('todayBtn') as HTMLElement | null;

  initSearchNavigationUI({
    appState,
    treeSearchOverlay: treeSearchOverlayEl,
    treeSearchInput: treeSearchInputEl,
    treeSearchStatus: treeSearchStatusEl,
    treeSearchCloseBtn: treeSearchCloseBtnEl,
    treeSearchCancelBtn: treeSearchCancelBtnEl,
    treeSearchFindBtn: treeSearchFindBtnEl,
    treeSearchSplit: treeSearchSplitEl,
    treeSearchMainBtn: treeSearchMainBtnEl,
    treeSearchDropdownBtn: treeSearchDropdownBtnEl,
    treeSearchMenu: treeSearchMenuEl,
    todayBtn: todayBtnEl
  });

  // Командная строка и справка остаются здесь, так как они простые
  initCmdlineUI();

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
        // Пропускаем резервные копии (красные записи): это архивные
        // копии файлов из папки BackUp, они не должны участвовать
        // в поиске — ни как родной INI, ни как кандидат на апдейт.
        if (device.isBackup) continue;

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

        // --- Инициализация модуля управления осциллографом ---
  // Делегируем логику переключения видимости и ресайзера в отдельный модуль.
  
  const oscContainerEl = document.getElementById('osc-container') as HTMLElement | null;
  const oscResizerEl = document.getElementById('oscResizer') as HTMLElement | null;

  initOscilloscopeUI({
    serial,
    appState,
    parser,
    view,
    buffers,
    readLoop, // Передаём функцию readLoop из замыкания initUI
    toggleOscMainBtn,
    toggleOscArrowBtn,
    toggleOscDropdown,
    menuToggleOsc,
    menuViewRec,
    oscResizer: oscResizerEl,
    oscContainer: oscContainerEl
  });

    if (folderActionBtn) {
    folderActionBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await openIniFileTauri(appState); // <--- Новая функция
    });
  }

  if (menuOpenFile) {
    menuOpenFile.addEventListener('click', async () => {
      await openIniFileTauri(appState); // <--- Новая функция
      folderDropdown?.classList.remove('show');
    });
  }

  if (menuOpenFolder) {
    menuOpenFolder.addEventListener('click', async () => {
      await openIniFolderTauri(appState); // <--- Новая функция
      folderDropdown?.classList.remove('show');
    });
  }

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

    // --- Инициализация модуля настроек связи ---
  // Делегируем логику выбора скорости, режима BUS, адреса и глобальных событий.
  
  const busSelectEl = document.getElementById('busSelect') as HTMLSelectElement | null;
  const rtuControlsEl = document.getElementById('rtuControls') as HTMLElement | null;
  const tcpControlsEl = document.getElementById('tcpControls') as HTMLElement | null;

  initCommunicationSettingsUI({
    serial,
    appState,
    baudSelect,
    busSelect: busSelectEl,
    rtuControls: rtuControlsEl,
    tcpControls: tcpControlsEl,
    addrBtn,
    readLoop,
    parser,
    view,
    buffers
  });

  initTableEditor('grid-data-rows', appState);
  setupSaveButton(appState);

  console.log("UI Manager: Интерфейс и обработчики инициализированы.");
}