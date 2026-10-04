// src-tauri/src/commands/ini.rs
// Фасад для обратной совместимости: реэкспорт публичного API команд,
// которые раньше жили в этом файле.
//
// Файл был разделён на 4 модуля по функциональным группам:
//   - ini_scan.rs      — сканирование и чтение INI-файлов;
//   - ini_backup.rs    — резервное копирование и обновление прошивки;
//   - ini_template.rs  — работа с шаблонами устройств;
//   - reports.rs       — папка XLT для готовых отчётов.
//
// Реэкспорт `pub use ...::*` сохраняет старые пути команд
// (commands::ini::scan_devices_folder и т.д.), поэтому lib.rs —
// где регистрируются команды через tauri::generate_handler![] —
// остаётся без изменений.

pub use super::ini_scan::*;
pub use super::ini_backup::*;
pub use super::ini_template::*;
pub use super::reports::*;