// src-tauri/src/commands/ini_scan.rs
// Команды сканирования и чтения INI-файлов:
//   - scan_devices_folder: рекурсивный обход папки Devices рядом с exe;
//   - get_devices_folder_path: путь к папке Devices (или None);
//   - read_ini_file: чтение сырых байтов INI-файла по абсолютному пути.
//
// Файл выделен из commands/ini.rs. Публичный API сохранён через
// реэкспорт из commands/ini.rs — lib.rs (generate_handler!) не меняется.

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::app_config::AppConfigState;

/// Описание одного найденного INI-файла для передачи во фронтенд.
///
/// Поле `bytes` содержит ТОЛЬКО первые 5 строк файла (секция [DEVICE]
/// по стандарту прошивки). Файл целиком при сканировании НЕ читается —
/// это ускоряет старт приложения в десятки раз. Полное содержимое
/// читается отдельно, командой read_ini_file, при клике по устройству.
#[derive(Serialize, Clone)]
pub struct IniFileInfo {
    /// Имя файла (например, "00000056.ini")
    pub name: String,
    /// Путь относительно папки Devices (например, "14.09/00000056.ini")
    pub relative_path: String,
    /// Сырые байты первых 5 строк файла (windows-1251, декодирует фронтенд)
    pub bytes: Vec<u8>,
    /// Время последнего изменения файла в миллисекундах unix-времени
    pub last_modified_ms: u64,
}

/// Читает только первые 5 строк файла, не загружая его целиком.
///
/// Ожидаемый формат «правильного» INI:
///   1-я строка:  [DEVICE]
///   2–5 строки:  Ключ=Значение
///
/// Возвращает:
///   Ok(Some(bytes)) — файл корректен; `bytes` содержит сырые байты
///                     ровно этих 5 строк (с исходными переводами строк);
///   Ok(None)        — файл короче 5 строк, 1-я строка не `[DEVICE]`,
///                     либо в строках 2–5 нет корректного `Ключ=Значение`;
///   Err(e)          — ошибка ввода-вывода.
///
/// Размер буфера BufReader — 1 КБ вместо стандартных 8 КБ: с диска
/// читается один блок такого размера, чего с запасом хватает на 5 строк.
fn read_first_five_lines(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let file = fs::File::open(path)?;
    let mut reader = BufReader::with_capacity(1024, file);

    let mut out: Vec<u8> = Vec::with_capacity(256);
    let mut buf: Vec<u8> = Vec::with_capacity(128);

    // --- Строка 1: должна быть [DEVICE] ---
    buf.clear();
    if reader.read_until(b'\n', &mut buf)? == 0 {
        return Ok(None);
    }

    // Отбрасываем UTF-8 BOM, если он есть.
    let mut first: &[u8] = &buf;
    if first.starts_with(&[0xEF, 0xBB, 0xBF]) {
        first = &first[3..];
    }

    // Сравниваем без учёта пробельных байтов и без учёта регистра.
    let first_clean: Vec<u8> = first
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();

    if !first_clean.eq_ignore_ascii_case(b"[DEVICE]") {
        return Ok(None);
    }
    out.extend_from_slice(&buf);

    // --- Строки 2–5: Ключ=Значение ---
    for _ in 0..4 {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            return Ok(None);
        }

        let eq_pos = match buf.iter().position(|&b| b == b'=') {
            Some(p) => p,
            None => return Ok(None),
        };
        let key_part = &buf[..eq_pos];
        if key_part.iter().all(|b| b.is_ascii_whitespace()) {
            return Ok(None);
        }

        out.extend_from_slice(&buf);
    }

    Ok(Some(out))
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
                // Читаем ТОЛЬКО первые 5 строк — не весь файл.
                // Файлы не по формату [DEVICE] молча пропускаем.
                let bytes = match read_first_five_lines(&path) {
                    Ok(Some(b)) => b,
                    Ok(None) => continue,
                    Err(e) => {
                        eprintln!(
                            "[RUST] scan_dir_recursive: ошибка чтения {}: {}",
                            path.display(),
                            e
                        );
                        continue;
                    }
                };

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

/// Команда: ищет папку Devices внутри текущей базовой папки и возвращает
/// все .ini рекурсивно, кроме папок BackUp. Если папки нет — пустой список.
#[tauri::command]
pub fn scan_devices_folder(state: tauri::State<'_, AppConfigState>) -> Result<Vec<IniFileInfo>, String> {
    // Путь к Devices берётся из общего состояния (AppConfigState):
    // по умолчанию это папка exe, но после смены базы — другая.
    let devices_dir = state.base_dir.join("Devices");

    if !devices_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    scan_dir_recursive(&devices_dir, &devices_dir, &mut out)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

/// Команда: путь к папке Devices внутри текущей базовой папки.
/// None, если папки нет.
#[tauri::command]
pub fn get_devices_folder_path(state: tauri::State<'_, AppConfigState>) -> Option<String> {
    let devices_path = state.base_dir.join("Devices");

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