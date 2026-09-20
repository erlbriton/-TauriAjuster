// src-tauri/src/commands/serial.rs
// Команды работы с последовательным портом:
// - list_serial_ports: список доступных COM/ttyUSB/ttyACM;
// - open_serial_port: открыть порт и запустить фоновый поток чтения;
// - write_serial_port: записать байты в открытый порт;
// - close_serial_port: остановить поток и закрыть порт.

use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serialport::available_ports;
use tauri::Emitter;

use crate::state::SerialState;

/// Команда: возвращает список доступных последовательных портов (COM-портов).
/// Использует библиотеку serialport для нативного сканирования системы.
/// Фильтрует виртуальные порты (ttyS*) и оставляет только реальные USB/COM порты.
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    eprintln!("[RUST] list_serial_ports: вызов команды");

    let ports = available_ports().map_err(|e| format!("Ошибка сканирования портов: {}", e))?;

    let port_names: Vec<String> = ports
        .into_iter()
        .map(|p| p.port_name)
        .filter(|name| {
            name.contains("ttyUSB") || name.contains("ttyACM") || name.starts_with("COM")
        })
        .collect();

    eprintln!(
        "[RUST] list_serial_ports: найдено {} порт(ов) после фильтрации: {:?}",
        port_names.len(),
        port_names
    );

    Ok(port_names)
}

/// Команда: открыть последовательный порт и запустить фоновый поток чтения.
/// Поток чтения сам толкает принятые байты во фронтенд событием "serial-data"
/// (push-модель): фронтенд ничего не опрашивает, данные приходят сами.
#[tauri::command]
pub fn open_serial_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, SerialState>,
    path: String,
    baud_rate: u32,
) -> Result<(), String> {
    // 1. Останавливаем ПРЕДЫДУЩИЙ читающий поток (если был).
    {
        let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
        if let Some(old_stop) = stop_guard.take() {
            old_stop.store(true, Ordering::Relaxed);
        }
    }

    // 2. Закрываем старый порт, если был открыт.
    {
        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    // 3. Открываем порт с таймаутом чтения 100 мс.
    let port = serialport::new(&path, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Не удалось открыть порт {}: {}", path, e))?;

    // 4. Клонируем дескриптор порта.
    let mut reader = port.try_clone().map_err(|e| e.to_string())?;

    // 5. Кладём оригинал порта в общее состояние.
    {
        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
    }

    // 6. Создаём ЛИЧНЫЙ флаг остановки для нового читающего потока.
    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
        *stop_guard = Some(Arc::clone(&stop_flag));
    }

    // 7. Порождаем читающий поток.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let _ = app.emit("serial-data", buf[..n].to_vec());
                }
                Ok(_) => continue,
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(e) => {
                    let _ = app.emit("serial-error", e.to_string());
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Команда: записать байты в открытый порт.
#[tauri::command]
pub fn write_serial_port(
    state: tauri::State<'_, SerialState>,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;

    match guard.as_mut() {
        Some(port) => port.write_all(&data).map_err(|e| e.to_string()),
        None => Err("Порт не открыт".to_string()),
    }
}

/// Команда: закрыть порт и остановить читающий поток.
#[tauri::command]
pub fn close_serial_port(state: tauri::State<'_, SerialState>) -> Result<(), String> {
    let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
    if let Some(stop) = stop_guard.take() {
        stop.store(true, Ordering::Relaxed);
    }
    drop(stop_guard);

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}