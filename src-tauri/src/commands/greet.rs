// src-tauri/src/commands/greet.rs
// Тестовая команда для проверки связи фронтенд ↔ Rust.

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}