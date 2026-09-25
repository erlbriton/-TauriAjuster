/**
 * Модуль управления устройствами и INI-файлами.
 * Отвечает за:
 * - Кнопку "Подключить" (поиск родного INI, fwUpdateModal)
 * - Обновление таблицы Modbus (performRefresh)
 * - Кнопку списка устройств (группировка дерева)
 * - Автообновление после загрузки INI
 */

import type { ISerialPort } from '../../serial/ISerialPort.js';
import type { AppState } from '../../core/app-state.js';
import type { IOscilloscopeApi } from '../../core/osc-api.js';
import type { ModbusParser } from '../../serial/modbus.js';
import { showIdModal, showCompactError, updateIdBanner } from '../ui.js';
import { parseDeviceIdString, parseDeviceIdFull } from '../../core/report-data.js';
import type { FwUpdateInfo } from '../fw-update-modal.js';
import { getAllDevices, getDeviceGroupKey, currentIniConfig } from '../../ini-manager/tree-core.js';
import { setTreeGroupMode, TreeGroupMode } from '../../ini-manager/tree-core.js';
import { renderDeviceTree } from '../../ini-manager/tree-ui.js';
import { getFileStore } from '../../ini-manager/file-loader.js';
import { resyncDevicesFromDisk } from '../../ini-manager/file-sync.js';
import { showFwUpdateModal } from '../fw-update-modal.js';
import { showNewDeviceModal, setNewDeviceAddToLoaded } from '../new-device-ui.js';
import { processSingleFileContent } from '../../ini-manager/file-loader.js';
import { PortCancelledError } from '../../serial/serial.js';

export interface DeviceManagementUIDeps {
  serial: ISerialPort;
  appState: AppState;
  parser: unknown; // ModbusParser
  view: IOscilloscopeApi | null;
  buffers: any[]; // ChannelBuffer[]
  connectBtn: HTMLButtonElement | null;
  refreshBtn: HTMLButtonElement | null;
  deviceListActionBtn: HTMLButtonElement | null;
  deviceListArrowBtn: HTMLButtonElement | null;
  deviceListDropdown: HTMLElement | null;
  comSelect: HTMLSelectElement | null;
  baudSelect: HTMLSelectElement | null;
  
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
    buffers: any[] | null,
    state: AppState
  ) => void;
  
  updateDeviceRegisters: (
    serial: ISerialPort,
    slaveAddr: number,
    state: AppState
  ) => Promise<boolean>;
}

export function initDeviceManagementUI(deps: DeviceManagementUIDeps): void {
  const {
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
  } = deps;

  // --- КНОПКА "ПОДКЛЮЧИТЬ" ---
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      let idText: string;

      if (serial.isConnected) {
        const banner = document.querySelector('.id-banner span');
        idText = (banner?.textContent ?? '').trim();
      } else {
        try {
          await executeDeviceIdentification(serial, comSelect, appState, baudSelect);
        } catch (err: unknown) {
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

      if (!idText) {
        console.log('[Connect] Строка ID пустая — поиск пропущен.');
        return;
      }

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
        
        if (parsed.serial === target.serial && parsed.deviceType === target.deviceType && parsed.version === target.version) {
          matchedId = device.id;
          break;
        }
        
        if (parsed.serial === target.serial && parsed.deviceType === target.deviceType && parsed.version !== target.version) {
          fwUpdateCandidate = device.id;
        }
      }

      if (!matchedId && fwUpdateCandidate) {
        const fullInfo: FwUpdateInfo = parseDeviceIdFull(idText);
        const oldDevice = getAllDevices().find((d) => d.id === fwUpdateCandidate);

        // ДИАГНОСТИКА: смотрим, какие значения дают промежуточные шаги.
        console.log('[DEBUG] idText из баннера:', JSON.stringify(idText));
        console.log('[DEBUG] fullInfo.idLine:', JSON.stringify(fullInfo.idLine));
        console.log('[DEBUG] fwUpdateCandidate:', JSON.stringify(fwUpdateCandidate));
        console.log('[DEBUG] oldDevice найден:', !!oldDevice);
        if (oldDevice) {
          const oldDev = oldDevice.iniConfig.device;
          console.log('[DEBUG] oldDevice.iniConfig.device:', JSON.stringify(oldDev));
        }

        if (oldDevice) {
          const oldDev = oldDevice.iniConfig.device;
          const oldDevId = oldDev ? oldDev.id : '';
          const oldLoc = oldDev?.location ?? '';
          const store = getFileStore();
          const lookupKey = `${oldLoc}::${oldDevId}`;
          const entry = store.get(lookupKey);
          console.log('[DEBUG] lookup key:', JSON.stringify(lookupKey));
          console.log('[DEBUG] все ключи fileStore:', JSON.stringify([...store.keys()]));
          console.log('[DEBUG] entry найден:', !!entry, 'есть .file:', !!entry?.file);
          if (entry?.file) {
            fullInfo.oldFileName = entry.file.name;
          }
        }
        console.log(`[Connect] Найдено устройство с другой версией ПО: ${fwUpdateCandidate}`);
        showFwUpdateModal(fullInfo);
        return;
      }

      if (matchedId !== null) {
        const leaf = document.querySelector<HTMLLIElement>(
          `.tree-id-item.is-leaf[data-device-id="${CSS.escape(matchedId)}"]`,
        );
        if (leaf) {
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
        console.log('[Connect] Родной INI не найден среди загруженных файлов.');
        showNewDeviceModal(idText);
      }
    });
  }

  // --- ОБНОВЛЕНИЕ ТАБЛИЦЫ (FC03) ---
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
      const success = await updateDeviceRegisters(serial, appState.slaveAddress, appState);

      if (success) {
        if (wasPolling) {
          console.log('[UI] Восстанавливаем опрос после обновления');
          appState.isLoopRunning = false;
          appState.isPolling = true;
          readLoop(serial, parser, view, buffers, appState);
        }
      } else {
        console.warn('[UI] updateDeviceRegisters вернул false — связь не удалась');
        showCompactError('Контроллер не отвечает. Проверьте адрес и подключение.');
      }
    } catch (err) {
      console.error("Ошибка при обновлении:", err);
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

  // Автообновление после загрузки/смены INI-файла
  window.addEventListener('app:ini-file-loaded', () => {
    void performRefresh(false);
  });

  // --- КНОПКА СПИСКА УСТРОЙСТВ (ГРУППИРОВКА) ---
  let deviceListMode = 'refresh';

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
    deviceListArrowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = deviceListDropdown.style.display === 'block';
      deviceListDropdown.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) markSelectedDeviceItem();
    });

    document.addEventListener('click', (e) => {
      if (!deviceListDropdown.contains(e.target as Node) && e.target !== deviceListArrowBtn) {
        deviceListDropdown.style.display = 'none';
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') deviceListDropdown.style.display = 'none';
    });

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

  if (deviceListActionBtn) {
    deviceListActionBtn.addEventListener('click', async () => {
      if (deviceListMode === 'refresh') {
        // Полная синхронизация состояния приложения с папкой Devices.
        // resyncDevicesFromDisk сканирует диск целиком и приводит память
        // в соответствие: добавляет новые файлы, обновляет изменённые,
        // удаляет исчезнувшие, корректно переносит записи при смене
        // локации или ID внутри файла (например, после апдейта прошивки).
        const results = await resyncDevicesFromDisk(appState);

        const parts: string[] = [];
        if (results.added > 0) parts.push(`добавлено: ${results.added}`);
        if (results.updated > 0) parts.push(`изменено: ${results.updated}`);
        if (results.removed > 0) parts.push(`удалено: ${results.removed}`);

        if (parts.length === 0) {
          showCompactError('Изменений в INI-файлах не обнаружено.');
        } else {
          showCompactError(`Синхронизация с диском завершена. ${parts.join(', ')}.`);
        }

        if (results.errors.length > 0) {
          console.warn('[UI] resyncDevicesFromDisk — ошибки:', results.errors);
        }
      } else {
        setTreeGroupMode(treeModeByButtonMode[deviceListMode] ?? 'location');
        renderDeviceTree();
      }
    });
  }

  console.log("[DeviceManagementUI] Инициализирован.");
}