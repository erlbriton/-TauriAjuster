// src-tauri/src/lib.rs

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Импорты для сканера папки Devices:
// Serialize — сериализация структуры найденного файла в JSON для передачи во фронтенд;
// fs, Path — обход файловой системы;
// SystemTime, UNIX_EPOCH — получение времени последнего изменения файла.
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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
        // Регистрируем команду сканирования папки Devices для фронтенда
        .invoke_handler(tauri::generate_handler![greet, scan_devices_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}