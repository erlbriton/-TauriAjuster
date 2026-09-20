// src-tauri/src/commands/viewer.rs
// Команда для открытия отдельного окна просмотра осциллограмм (.rec-файлов).
//
// Почему это команда Rust, а не чистый TypeScript:
// фронтенд в браузерном WebView не имеет доступа к WebviewWindowBuilder —
// это часть нативного API Tauri. Чтобы породить НОВОЕ окно (не вкладку,
// не iframe), нужно вызвать Rust-сторону через invoke().

/// Команда: открыть новое окно для просмотра осциллограмм (.rec файлов).
/// Создаёт отдельное окно Tauri с загрузкой rec-viewer.html.
#[tauri::command]
pub fn open_rec_viewer(app_handle: tauri::AppHandle) -> Result<(), String> {
    eprintln!("[RUST] open_rec_viewer: создание нового окна");

    // Создаём новое окно с уникальной меткой "rec_viewer".
    // Метка нужна Tauri, чтобы отличать окна друг от друга:
    // если окно с такой меткой уже открыто, WebviewWindowBuilder
    // вернёт ошибку "window with label 'rec_viewer' already exists".
    // То есть эта команда не создаст два одинаковых окна подряд.
    let window_builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "rec_viewer", // Уникальная метка окна
        tauri::WebviewUrl::App("rec-viewer.html".into()), // HTML из ресурсов приложения (dist)
    )
    .title("Просмотр осциллограммы")
    .inner_size(1024.0, 768.0)
    .resizable(true)
    .build();

    // build() возвращает Result:
    // - Ok(window) — окно создано и уже показывает rec-viewer.html;
    // - Err(e)     — не удалось (например, WebView не инициализировался
    //                или окно с такой меткой уже существует).
    // Ошибку отдаём во фронтенд строкой — там она попадёт в catch у invoke().
    match window_builder {
        Ok(_window) => {
            eprintln!("[RUST] open_rec_viewer: окно успешно создано");
            Ok(())
        }
        Err(e) => {
            eprintln!("[RUST] open_rec_viewer: ошибка создания окна: {}", e);
            Err(format!("Не удалось открыть окно просмотрщика: {}", e))
        }
    }
}