// src-tauri/src/commands/reports.rs
// Команды для работы с папкой XLT — готовыми отчётами (.xlsx, .csv).
//
// Пока в этом модуле одна команда:
//   - ensure_xlt_dir: путь к папке XLT рядом с exe (создать при необходимости).
//
// Файл выделен из commands/ini.rs (там ensure_xlt_dir жила «за компанию»
// с INI-командами, хотя логически не связана с INI-файлами).
// Публичный API сохранён через реэкспорт из commands/ini.rs —
// lib.rs (generate_handler!) не меняется.

use std::fs;
use crate::app_config::AppConfigState;

/// Команда: вернуть путь к папке XLT рядом с exe и создать её, если нет.
///
/// XLT — папка для готовых отчётов (.xlsx, .csv). Лежит рядом с Devices,
/// BackUp и TemplateDevice. Создаётся молча, без диалогов: это папка
/// результатов работы приложения, её отсутствие — нормальная ситуация.
#[tauri::command]
pub fn ensure_xlt_dir(state: tauri::State<'_, AppConfigState>) -> Result<String, String> {
    eprintln!("[RUST] ensure_xlt_dir: вызов команды");

    // Путь к базовой папке берём из общего состояния (AppConfigState).
    // По умолчанию это папка exe, но после смены базы через
    // «Обновить список устройств» → «Сменить папку базы» — другая.
    let xlt_dir = state.base_dir.join("XLT");

    if !xlt_dir.is_dir() {
        fs::create_dir_all(&xlt_dir).map_err(|e| {
            format!(
                "Не удалось создать папку '{}': {}",
                xlt_dir.display(),
                e
            )
        })?;
        eprintln!(
            "[RUST] ensure_xlt_dir: создана папка '{}'",
            xlt_dir.display()
        );
    }

    Ok(xlt_dir.to_string_lossy().into_owned())
}