// src/main.ts

// Нативная реализация последовательного порта через Tauri (Rust).
// Заменяет браузерный SerialConnection: Web Serial API недоступен
// в webview Tauri, поэтому вся работа с портом идёт через Rust-команды.
import { TauriSerialPort } from './serial/tauri-serial.js';
import { initUI } from './ui/uiManager.js';
import { ModbusParser } from './serial/modbus.js';
import { Oscilloscope } from './oscilloscope';
import './ui/layout.js';

import { showIdModal } from './ui/ui.js';
import { initFwUpdateModal } from './ui/fw-update-modal.js';
import { updateDeviceRegisters } from './serial/device_updater.js';
import { setupFileHandling, openIniFile } from './ini-manager/file-loader.js';
// Tauri-автозагрузчик: читает INI-файлы из папки Devices рядом с exe/bin
import { autoLoadDevicesFolder } from './core/platform/tauri-autoloader.js';
import { initDropZone } from './ini-manager/drop-loader.js';
import {
    updateComInterfaceName,
    executeDeviceIdentification,
    readLoop
} from './serial/serial-actions.js';
import type { AppState } from './core/app-state.js';

declare global {
    interface Window {
        osc?: Oscilloscope;
    }
}

const appState: AppState = {
  isIdentifying: false,
  isPolling: false,
  isRefreshing: false,
  isLoopRunning: false,
  slaveAddress: 0x01,
  currentIniContent: null,
  currentIniConfig: null,
  currentIniFileHandle: null,
  pollDelayMs: 20,
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const oscContainer = document.getElementById('osc-container');

                        const osc = new Oscilloscope();
        osc.setAppState(appState);
        window.osc = osc;
        await osc.initialize(oscContainer ?? undefined);

        // Создаём нативный порт: внутри он вызывает Rust-команды
        // (open_serial_port / write_serial_port / close_serial_port)
        // и принимает байты через событие "serial-data".
        // Для остального кода (осциллограф, serialManager) он выглядит
        // точно так же, как старый браузерный порт.
        const serial = new TauriSerialPort();
        const parser = new ModbusParser();

        // Связываем кнопку Стоп/Пуск осциллографа с глобальным состоянием опроса
        osc.setOnPollingStateChange((isPolling: boolean) => {
            appState.isPolling = isPolling;
            console.log("[Main] appState.isPolling изменён на:", isPolling);
            
            if (isPolling) {
                // Перезапускаем цикл опроса, так как при остановке он полностью завершился
                readLoop(serial, parser, osc, buffers, appState).catch(err => 
                    console.error("Ошибка перезапуска readLoop:", err)
                );
            }
        });

        const buffers: import('./ui/uiManager.js').ChannelBuffer[] = Array.from({ length: 70 }, () => {
         const data: number[] = [];
         return {
                push: (v: number) => {
                    data.push(v);
                    if (data.length > 200) data.shift();
                },
                get: (idx: number) => data[idx],
                get length() { return data.length; },
                get data() { return data; },
                clear: () => { data.length = 0; },
                toArray: () => [...data]
            };
        });

        initUI({
            serial, appState, parser, view: osc, buffers,
            setupFileHandling,
            updateComInterfaceName,
            executeDeviceIdentification,
            readLoop,
            showIdModal,
            updateDeviceRegisters
        });

        // Инициализация drag-and-drop для INI-файлов
        initDropZone(appState);

        initFwUpdateModal();

        // Tauri: автозагрузка INI-файлов из папки Devices, которая лежит
        // рядом с исполняемым файлом (exe/bin). Запускается после
        // инициализации UI; ошибка автозагрузки не ломает запуск приложения.
        autoLoadDevicesFolder(appState)
            .then((count: number) => {
                console.log(`[Main] Автозагрузка из папки Devices: ${count} файл(ов)`);
            })
            .catch((err: unknown) => {
                console.error('[Main] Ошибка автозагрузки папки Devices:', err);
            });

        console.log("Приложение запущено. Модуль осциллографа интегрирован.");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Критическая ошибка:", message);
    }
});