// src-tauri/src/commands/serial.rs
// Команды работы с последовательным портом:
// - list_serial_ports: список доступных COM/ttyUSB/ttyACM;
// - open_serial_port: открыть порт (без фонового чтения);
// - serial_transaction: атомарный write+read на одном handle;
// - write_serial_port: (старая команда, оставлена для совместимости);
// - close_serial_port: закрыть порт.

use std::io::{Read, Write};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serialport::available_ports;

use crate::state::SerialState;

/// Команда: возвращает список доступных последовательных портов (COM-портов).
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

/// Команда: открыть последовательный порт.
///
/// Фонового читающего потока больше НЕТ. Чтение выполняется по запросу
/// через serial_transaction — на том же handle, что и запись. Это устраняет
/// конфликт read/write на Windows, где драйвер COM-порта сериализует
/// обращения к одному устройству.
#[tauri::command]
pub fn open_serial_port(
    state: tauri::State<'_, SerialState>,
    path: String,
    baud_rate: u32,
) -> Result<(), String> {
    eprintln!("[RUST] open_serial_port: path = '{}', baud = {}", path, baud_rate);

    // Закрываем старый порт, если был открыт.
    {
        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    // Открываем порт с коротким таймаутом чтения 1 мс.
    // Таймаут нужен, чтобы read() не блокировался навсегда и возвращал
    // управление в serial_transaction для проверки общего таймаута.
    let port = serialport::new(&path, baud_rate)
        .timeout(Duration::from_millis(1))
        .open()
        .map_err(|e| format!("Не удалось открыть порт {}: {}", path, e))?;

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = Some(port);

    eprintln!("[RUST] open_serial_port: порт открыт");
    Ok(())
}

/// Команда: атомарная транзакция — записать пакет и прочитать ответ.
///
/// Возвращает все байты, которые успели прийти за timeout_ms миллисекунд.
/// Прекращает чтение раньше, если после первого принятого байта наступает
/// пауза 3 мс (типичный конец Modbus-ответа).
///
/// Никакого emit/listen — прямое возвращение результата во фронтенд.
#[tauri::command]
pub fn serial_transaction(
    state: tauri::State<'_, SerialState>,
    data: Vec<u8>,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    let port = guard.as_mut().ok_or_else(|| "Порт не открыт".to_string())?;

    // 1. Пишем пакет. При фатальной ошибке (обрыв USB, ERROR_BAD_COMMAND и т.п.)
    //    сбрасываем handle в state, чтобы следующее открытие создало свежий.
    if let Err(e) = port.write_all(&data) {
        eprintln!("[RUST] serial_transaction: фатальная ошибка write: {}", e);
        *guard = None;
        return Err(format!("Ошибка записи в порт: {}", e));
    }

    // 2. Читаем ответ до timeout_ms или до 3 мс тишины после первого байта.
    let mut result: Vec<u8> = Vec::new();
    let start = Instant::now();
    let overall_timeout = Duration::from_millis(timeout_ms);
    let silence_timeout = Duration::from_millis(3);
    let mut last_byte_at: Option<Instant> = None;
    let mut buf = [0u8; 4096];

    while start.elapsed() < overall_timeout {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                result.extend_from_slice(&buf[..n]);
                last_byte_at = Some(Instant::now());
            }
            Ok(_) => {
                // 0 байт — просто продолжаем
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                if let Some(t) = last_byte_at {
                    if t.elapsed() >= silence_timeout {
                        break;
                    }
                }
            }
            Err(e) => {
                eprintln!("[RUST] serial_transaction: фатальная ошибка read: {}", e);
                *guard = None;
                return Err(format!("Ошибка чтения из порта: {}", e));
            }
        }
    }

    Ok(result)
}

/// Команда: записать байты в открытый порт (без чтения).
/// Оставлена для совместимости — используется на случай, если где-то
/// нужна только запись без ожидания ответа.
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

/// Команда: закрыть порт.
#[tauri::command]
pub fn close_serial_port(state: tauri::State<'_, SerialState>) -> Result<(), String> {
    // Флаг reader_stop больше не используется (читающего потока нет),
    // но оставляем его для совместимости структуры SerialState.
    {
        let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
        if let Some(stop) = stop_guard.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}