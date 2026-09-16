// src-tauri/src/lib.rs

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Импорты для сканера папки Devices:
// Serialize — сериализация структуры найденного файла в JSON для передачи во фронтенд;
// fs, Path — обход файловой системы;
// SystemTime, UNIX_EPOCH — получение времени последнего изменения файла.
use serde::Serialize;
use std::fs;
// Read и Write — трейты для чтения/записи байтов в порт (как read()/write() в C)
use std::io::{Read, Write};
use std::path::Path;
// AtomicBool и Ordering — потокобезопасный флаг «читать/не читать»
use std::sync::atomic::{AtomicBool, Ordering};
// Arc — счётчик ссылок для передачи флага в поток; Mutex — защита общего порта
use std::sync::{Arc, Mutex};
// Duration — таймаут чтения порта
use std::time::{Duration, SystemTime, UNIX_EPOCH};
// Emitter — трейт, дающий метод app.emit() для отправки событий во фронтенд
use tauri::Emitter;
// Используем прямую библиотеку serialport для получения списка портов и их открытия
use serialport::available_ports;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Описание одного найденного INI-файла для передачи во фронтенд.
#[derive(Serialize, Clone)]
pub struct IniFileInfo {
    /// Имя файла (например, "00000056.ini")
    pub name: String,
    /// Путь относительно папки Devices (например, "14.09/00000056.ini")
    pub relative_path: String,
    /// Сырые байты файла (кодировка windows-1251, декодирует фронтенд)
    pub bytes: Vec<u8>,
    /// Время последнего изменения файла в миллисекундах unix-времени
    pub last_modified_ms: u64,
}

/// Рекурсивно обходит папку и собирает все .ini файлы.
/// Папки с именем "BackUp" (в любом регистре) пропускаются: там лежат
/// старые версии INI, перенесённые при обновлении ПО устройств.
fn scan_dir_recursive(dir: &Path, root: &Path, out: &mut Vec<IniFileInfo>) -> Result<(), String> {
    // Читаем список элементов текущей папки
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Не удалось прочитать папку {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            // Служебную папку BackUp со старыми файлами не сканируем
            let dir_name = entry.file_name().to_string_lossy().to_lowercase();
            if dir_name == "backup" {
                continue;
            }
            // Рекурсивно спускаемся во вложенную папку с произвольным именем
            scan_dir_recursive(&path, root, out)?;
        } else {
            // Берём только файлы с расширением .ini
            let lower = path.to_string_lossy().to_lowercase();
            if lower.ends_with(".ini") {
                let bytes = fs::read(&path)
                    .map_err(|e| format!("Не удалось прочитать файл {}: {}", path.display(), e))?;

                // Время последнего изменения; при ошибке берём 0
                let modified = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let ms = modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                // Относительный путь с единым разделителем "/" для всех ОС
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");

                out.push(IniFileInfo {
                    name: entry.file_name().to_string_lossy().to_string(),
                    relative_path: rel,
                    bytes,
                    last_modified_ms: ms,
                });
            }
        }
    }
    Ok(())
}

/// Команда для фронтенда: ищет папку Devices рядом с исполняемым файлом
/// (exe на Windows, bin на Linux/macOS) и возвращает все .ini файлы из неё
/// рекурсивно, кроме папок BackUp. Если папки Devices нет — пустой список.
#[tauri::command]
fn scan_devices_folder() -> Result<Vec<IniFileInfo>, String> {
    // Путь к текущему исполняемому файлу приложения
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let devices_dir = exe_dir.join("Devices");

    // Папки Devices рядом с exe нет — возвращаем пустой список,
    // фронтенд просто запустится с пустым деревом устройств
    if !devices_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    scan_dir_recursive(&devices_dir, &devices_dir, &mut out)?;

    // Сортируем по относительному пути, чтобы порядок загрузки был стабильным
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

/// Команда для фронтенда: возвращает список доступных последовательных портов (COM-портов).
/// Использует библиотеку serialport для нативного сканирования системы.
#[tauri::command]
fn list_serial_ports() -> Result<Vec<String>, String> {
    // Получаем список портов через библиотеку serialport
    let ports = available_ports()
        .map_err(|e| format!("Ошибка сканирования портов: {}", e))?;

    // Преобразуем структуру PortInfo в вектор строк (имена портов)
    let port_names: Vec<String> = ports
        .into_iter()
        .map(|p| p.port_name)
        .collect();

    Ok(port_names)
}

//// Состояние приложения, общее для всех команд.
/// Аналог глобальной структуры в C: зарегистрировано через .manage(),
/// доступно в командах через параметр tauri::State.
pub struct SerialState {
    /// Текущий открытый порт.
    /// Mutex — потому что команды выполняются в разных потоках Tauri;
    /// Option — потому что порт может быть закрыт (None) или открыт (Some).
    pub port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    /// Личный флаг остановки ТЕКУЩЕГО читающего потока (true — должен завершиться).
    /// Каждое открытие порта создаёт НОВЫЙ флаг, поэтому старый поток
    /// никогда не реагирует на флаги нового потока и не "воскресает".
    pub reader_stop: Mutex<Option<Arc<AtomicBool>>>,
}

/// Команда: открыть последовательный порт и запустить фоновый поток чтения.
/// Поток чтения сам толкает принятые байты во фронтенд событием "serial-data"
/// (push-модель): фронтенд ничего не опрашивает, данные приходят сами.
#[tauri::command]
fn open_serial_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, SerialState>,
    path: String,
    baud_rate: u32,
) -> Result<(), String> {
    // 1. Останавливаем ПРЕДЫДУЩИЙ читающий поток (если был): забираем его
    //    личный флаг остановки и поднимаем его. Поток завершится сам
    //    максимум через 100 мс (таймаут чтения). Личный флаг гарантирует,
    //    что старый поток не будет "воскрешён" новым открытием.
    {
        let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
        if let Some(old_stop) = stop_guard.take() {
            old_stop.store(true, Ordering::Relaxed);
        }
    }

    // 2. Закрываем старый порт, если был открыт: drop дескриптора
    //    физически освобождает устройство
    {
        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    // 3. Открываем порт с таймаутом чтения 100 мс.
    //    Таймаут обязателен: без него read() блокирует поток навсегда,
    //    и поток не сможет заметить флаг остановки.
    let port = serialport::new(&path, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Не удалось открыть порт {}: {}", path, e))?;

    // 4. Клонируем дескриптор порта (анлог dup() в C):
    //    оригинал останется в состоянии для записи,
    //    клон уйдёт в читающий поток.
    let mut reader = port.try_clone().map_err(|e| e.to_string())?;

    // 5. Кладём оригинал порта в общее состояние приложения
    {
        let mut guard = state.port.lock().map_err(|e| e.to_string())?;
        *guard = Some(port);
    }

    // 6. Создаём ЛИЧНЫЙ флаг остановки для нового читающего потока
    //    и кладём его в состояние, чтобы close_serial_port мог его поднять
    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
        *stop_guard = Some(Arc::clone(&stop_flag));
    }

    // 7. Порождаем читающий поток. Он живёт, пока открыт порт.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096]; // приёмный буфер, как в драйвере UART
        loop {
            // Каждую итерацию проверяем СВОЙ личный флаг остановки
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                // Принято n > 0 байт: отправляем их во фронтенд событием.
                // Vec<u8> сериализуется в JSON-массив чисел, фронтенд
                // соберёт из него Uint8Array.
                Ok(n) if n > 0 => {
                    let _ = app.emit("serial-data", buf[..n].to_vec());
                }
                // 0 байт — данных нет, просто пробуем снова
                Ok(_) => continue,
                // Таймаут чтения — штатная ситуация, не ошибка
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                // Настоящая ошибка (кабель выдернули): сообщаем и выходим
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
/// Вызывается фронтендом для отправки запроса устройству (например, пакета 0x11).
#[tauri::command]
fn write_serial_port(
    state: tauri::State<'_, SerialState>,
    data: Vec<u8>,
) -> Result<(), String> {
    // guard делаем изменяемым (mut), так как ниже мы попросим у него изменяемую ссылку на порт
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    
    // as_mut() возвращает Option<&mut Box<dyn SerialPort>>, то есть не-const указатель,
    // через который можно вызывать методы, меняющие состояние порта (например, write_all)
    match guard.as_mut() {
        Some(port) => {
            // write_all гарантирует отправку ВСЕХ байтов, а не части
            port.write_all(&data).map_err(|e| e.to_string())
        }
        None => Err("Порт не открыт".to_string()),
    }
}

/// Команда: закрыть порт и остановить читающий поток.
#[tauri::command]
fn close_serial_port(state: tauri::State<'_, SerialState>) -> Result<(), String> {
    // Поднимаем личный флаг текущего читающего потока: он заметит его
    // максимум через 100 мс (таймаут чтения) и корректно завершится
    let mut stop_guard = state.reader_stop.lock().map_err(|e| e.to_string())?;
    if let Some(stop) = stop_guard.take() {
        stop.store(true, Ordering::Relaxed);
    }
    drop(stop_guard); // отпускаем мьютекс флагов перед взятием мьютекса порта
    // Убираем порт из состояния: drop дескриптора физически закрывает порт
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Регистрируем плагин для нативных диалоговых окон (выбор файлов и папок).
        // Работает кроссплатформенно: Windows API, macOS Cocoa, Linux GTK3, Android Intent.
        .plugin(tauri_plugin_dialog::init())
        // Регистрируем плагин для работы с файловой системой (чтение/запись файлов).
        // Позволяет обойти ограничения браузера и работать с файлами напрямую.
        .plugin(tauri_plugin_fs::init())
        // Регистрируем общее состояние serial-порта:
        // теперь все команды видят один и тот же открытый порт
        .manage(SerialState {
            port: Mutex::new(None),
            reader_stop: Mutex::new(None),
        })
        // Регистрируем команды для фронтенда:
        // greet — тестовая команда,
        // scan_devices_folder — сканирование папки Devices,
        // list_serial_ports — получение списка COM-портов,
        // open_serial_port / write_serial_port / close_serial_port —
        // нативный обмен с устройством через последовательный порт.
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_devices_folder,
            list_serial_ports,
            open_serial_port,
            write_serial_port,
            close_serial_port
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}