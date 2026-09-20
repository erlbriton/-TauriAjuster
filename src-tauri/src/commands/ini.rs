// src-tauri/src/commands/ini.rs
// Команды для работы с INI-файлами:
// - scan_devices_folder: рекурсивный обход папки Devices рядом с exe;
// - get_devices_folder_path: путь к папке Devices (или None);
// - read_ini_file: чтение сырых байтов INI-файла по абсолютному пути.

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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
/// Папки с именем "BackUp" (в любом регистре) пропускаются.
fn scan_dir_recursive(dir: &Path, root: &Path, out: &mut Vec<IniFileInfo>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Не удалось прочитать папку {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_lowercase();
            if dir_name == "backup" {
                continue;
            }
            scan_dir_recursive(&path, root, out)?;
        } else {
            let lower = path.to_string_lossy().to_lowercase();
            if lower.ends_with(".ini") {
                let bytes = fs::read(&path)
                    .map_err(|e| format!("Не удалось прочитать файл {}: {}", path.display(), e))?;

                let modified = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let ms = modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

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

/// Команда: ищет папку Devices рядом с exe/bin и возвращает все .ini
/// рекурсивно, кроме папок BackUp. Если папки нет — пустой список.
#[tauri::command]
pub fn scan_devices_folder() -> Result<Vec<IniFileInfo>, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let devices_dir = exe_dir.join("Devices");

    if !devices_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    scan_dir_recursive(&devices_dir, &devices_dir, &mut out)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

/// Команда: путь к папке Devices рядом с exe/bin. None, если папки нет.
#[tauri::command]
pub fn get_devices_folder_path() -> Option<String> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let devices_path = exe_dir.join("Devices");

    if devices_path.exists() && devices_path.is_dir() {
        Some(devices_path.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Команда: прочитать INI-файл по абсолютному пути и вернуть сырые байты.
/// Декодирование windows-1251 делает фронтенд через decodeTextBuffer.
#[tauri::command]
pub fn read_ini_file(path: String) -> Result<Vec<u8>, String> {
    eprintln!("[RUST] read_ini_file: путь = '{}'", path);

    let bytes = fs::read(&path)
        .map_err(|e| format!("Не удалось прочитать файл '{}': {}", path, e))?;

    eprintln!("[RUST] read_ini_file: прочитано {} байт", bytes.len());
    Ok(bytes)
}