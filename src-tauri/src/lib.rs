// src-tauri/src/lib.rs

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Подмодули: команды Tauri и общее состояние приложения.
pub mod commands;
pub mod state;
// Конфигурация приложения: путь к текущей базовой папке (Devices/,
// BackUp/, TemplateDevice/ и т.д.). Читается из controllers.txt.
pub mod app_config;

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
        // Регистрируем плагин для перезапуска приложения.
        // Используется после смены базовой папки (relaunch).
        .plugin(tauri_plugin_process::init())
        // Регистрируем общее состояние serial-порта:
        // теперь все команды видят один и тот же открытый порт
        .manage(state::SerialState::default())
        // Регистрируем состояние конфигурации: путь к текущей базовой
        // папке и к папке exe. Читается из controllers.txt при старте.
        .manage(app_config::AppConfigState::from_startup())
        // Регистрируем команды, доступные фронтенду через invoke().
        // Каждая команда реализована в своём подмодуле src/commands/:
        //   greet  — тестовая;
        //   ini    — работа с INI-файлами;
        //   serial — COM-порт;
        //   fs     — файловые операции ОС;
        //   viewer — окно просмотра .rec.
        // Точный список — ниже, в generate_handler![].
        .invoke_handler(tauri::generate_handler![
            commands::greet::greet,
            commands::controllers::controllers_file_exists,
            commands::controllers::ensure_controllers_file,
            commands::controllers::list_saved_bases,
            commands::controllers::set_base_dir,
            commands::controllers::reset_base_dir,
            commands::ini::scan_devices_folder,
            commands::serial::list_serial_ports,
            commands::serial::open_serial_port,
            commands::serial::serial_transaction,
            commands::serial::write_serial_port,
            commands::serial::close_serial_port,
            commands::fs::open_in_default_editor,
            commands::ini::get_devices_folder_path,
            commands::ini::ensure_device_subdir,
            commands::ini::ensure_backup_dir,
            commands::ini::backup_and_replace_ini,
            commands::ini::ensure_template_dir,
            commands::ini::scan_template_dir,
            commands::ini::copy_template_file,
            commands::ini::scan_backup_dir,
            commands::ini::ensure_xlt_dir,
            commands::fs::ensure_records_dir,
            commands::fs::delete_file_from_disk,
            commands::ini::read_ini_file,
            commands::fs::open_file_location,
            commands::viewer::open_rec_viewer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
