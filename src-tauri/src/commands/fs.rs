// src-tauri/src/commands/fs.rs
// Файловые команды, работающие напрямую с ОС:
// - open_in_default_editor: открыть файл в редакторе по умолчанию;
// - ensure_records_dir: путь к папке Records рядом с exe/AppImage (опц. создать);
// - delete_file_from_disk: безвозвратно удалить файл;
// - open_file_location: открыть папку с файлом в системном файловом менеджере.

/// Команда: открыть файл в редакторе по умолчанию операционной системы.
/// Кроссплатформенная: использует xdg-open (Linux), open (macOS), cmd /C start (Windows).
/// Возвращается сразу после запуска процесса редактора (не дожидается его закрытия).
#[tauri::command]
pub fn open_in_default_editor(path: String) -> Result<(), String> {
    eprintln!(
        "[RUST] open_in_default_editor: переданный путь = '{}'",
        path
    );

    // Преобразуем относительный путь в абсолютный.
    // Если путь уже абсолютный, canonicalize его не изменит.
    // canonicalize также разрешает символические ссылки и убирает ".." и ".".
    let absolute_path = std::fs::canonicalize(&path).map_err(|e| {
        format!(
            "Не удалось преобразовать путь '{}' в абсолютный: {}",
            path, e
        )
    })?;

    eprintln!(
        "[RUST] open_in_default_editor: абсолютный путь = '{}'",
        absolute_path.display()
    );

    // Проверяем, что файл существует перед открытием
    if !absolute_path.exists() {
        return Err(format!("Файл не найден: {}", absolute_path.display()));
    }

    // Преобразуем PathBuf в обычную String (избегаем проблем с Cow)
    let path_str = absolute_path.to_string_lossy().into_owned();

    // Выбираем команду в зависимости от ОС на этапе компиляции
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &path_str])
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path_str).spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(&path_str)
        .spawn();

    // Проверяем, что процесс редактора успешно запущен
    result
        .map(|_| ())
        .map_err(|e| format!("Не удалось открыть файл в редакторе: {}", e))
}

/// Команда: вернуть абсолютный путь к папке Records рядом с исполняемым файлом.
/// Проверяет существование папки "Records" рядом с исполняемым файлом.
/// Если папки нет и create == true — создаёт её.
/// Возвращает абсолютный путь к папке Records или ошибку.
///
/// Рабочая папка определяется так:
/// - Если установлена переменная окружения APPIMAGE (AppImage в Linux) —
///   берём родительскую директорию файла .AppImage (это папка, куда пользователь положил приложение).
/// - Иначе — берём родительскую директорию текущего исполняемого файла (exe/bin).
#[tauri::command]
pub fn ensure_records_dir(create: bool) -> Result<String, String> {
    // Определяем рабочую папку: учитываем AppImage и обычный exe/bin
    let exe_dir = if let Ok(appimage_path) = std::env::var("APPIMAGE") {
        std::path::PathBuf::from(appimage_path)
            .parent()
            .ok_or_else(|| "Не удалось определить родительскую директорию AppImage".to_string())?
            .to_path_buf()
    } else {
        std::env::current_exe()
            .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?
            .parent()
            .ok_or_else(|| "Не удалось определить родительскую директорию исполняемого файла".to_string())?
            .to_path_buf()
    };

    // Корректно присоединяем подпапку "Records" через Path::join
    let records_path = exe_dir.join("Records");

    // Проверяем существование
    if !records_path.exists() {
        if create {
            std::fs::create_dir_all(&records_path).map_err(|e| {
                format!(
                    "Не удалось создать папку '{}': {}",
                    records_path.display(),
                    e
                )
            })?;
        } else {
            return Err("RECORDS_DIR_NOT_FOUND".to_string());
        }
    }

    Ok(records_path.to_string_lossy().into_owned())
}

/// Команда: физически удалить файл с диска (безвозвратно).
/// Используется пунктом контекстного меню "Удалить с диска".
/// Защиты: путь не пустой, объект существует и является обычным файлом.
///
/// После удаления файла, если его родительская папка:
///   - находится внутри Devices/,
///   - и не равна самой Devices/,
///   - и после удаления оказалась пустой,
/// — папка тоже удаляется. Это убирает накопление пустых подпапок
/// после удаления последнего файла локации (или версии прошивки).
#[tauri::command]
pub fn delete_file_from_disk(path: String) -> Result<(), String> {
    eprintln!("[RUST] delete_file_from_disk: путь = '{}'", path);

    if path.trim().is_empty() {
        return Err("Не указан путь к файлу".to_string());
    }

    let file_path = std::path::Path::new(&path);

    if !file_path.exists() {
        return Err(format!("Файл не найден: {}", path));
    }
    if !file_path.is_file() {
        return Err(format!("Путь не является файлом: {}", path));
    }

    // Запоминаем родительскую папку до удаления: после remove_file
    // у file_path уже нельзя будет получить parent (путь валиден,
    // но проще сохранить заранее).
    let parent_opt = file_path.parent().map(|p| p.to_path_buf());

    std::fs::remove_file(file_path)
        .map_err(|e| format!("Не удалось удалить файл '{}': {}", path, e))?;

    eprintln!("[RUST] delete_file_from_disk: файл удалён");

    // Удаляем пустую родительскую папку, но только если она внутри Devices/.
    // Логика повторяет аналогичную в backup_and_replace_ini (ini.rs),
    // чтобы поведение было единообразным.
    if let Some(parent) = parent_opt {
        // Определяем exe_dir — та же логика, что в ensure_records_dir:
        // учитываем APPIMAGE на Linux и обычный exe/bin на Windows.
        let exe_dir_opt = if let Ok(appimage_path) = std::env::var("APPIMAGE") {
            std::path::PathBuf::from(appimage_path).parent().map(|p| p.to_path_buf())
        } else {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
        };

        if let Some(exe_dir) = exe_dir_opt {
            let devices_dir = exe_dir.join("Devices");

            // Удаляем папку только если она внутри Devices/ и не сама Devices/.
            // starts_with отсекает случай, когда файл лежит вне базы —
            // в этом случае родительскую папку не трогаем.
            if parent != devices_dir && parent.starts_with(&devices_dir) && parent.is_dir() {
                match std::fs::read_dir(&parent) {
                    Ok(mut entries) => {
                        if entries.next().is_none() {
                            // Папка пуста — удаляем.
                            if let Err(e) = std::fs::remove_dir(&parent) {
                                // Не критично: файл уже удалён, просто папка осталась.
                                eprintln!(
                                    "[RUST] delete_file_from_disk: не удалось удалить пустую папку '{}': {}",
                                    parent.display(),
                                    e
                                );
                            } else {
                                eprintln!(
                                    "[RUST] delete_file_from_disk: пустая папка '{}' удалена",
                                    parent.display()
                                );
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[RUST] delete_file_from_disk: не удалось прочитать папку '{}': {}",
                            parent.display(),
                            e
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

/// Команда: открыть папку, содержащую файл, в системном файловом менеджере.
/// На Windows выделяет файл в Проводнике (explorer /select).
/// На macOS выделяет файл в Finder (open -R).
/// На Linux открывает папку через xdg-open / gdbus (без выделения файла).
#[tauri::command]
pub fn open_file_location(path: String) -> Result<(), String> {
    eprintln!("[RUST] open_file_location: путь = '{}'", path);

    let absolute_path = std::fs::canonicalize(&path).map_err(|e| {
        format!(
            "Не удалось преобразовать путь '{}' в абсолютный: {}",
            path, e
        )
    })?;

    if !absolute_path.exists() {
        return Err(format!("Файл не найден: {}", absolute_path.display()));
    }

    // Выбираем команду в зависимости от ОС:
    // - Windows: explorer /select,"C:\path\to\file" — открывает папку и выделяет файл
    // - macOS: open -R /path/to/file — открывает Finder и выделяет файл
    // - Linux: gdbus ShowItems через FileManager1, fallback — xdg-open
    #[cfg(target_os = "windows")]
    let result = {
        let path_str = absolute_path.to_string_lossy().into_owned();
        std::process::Command::new("explorer")
            .args(["/select,", &path_str])
            .spawn()
    };

    #[cfg(target_os = "macos")]
    let result = {
        let path_str = absolute_path.to_string_lossy().into_owned();
        std::process::Command::new("open")
            .args(["-R", &path_str])
            .spawn()
    };

    #[cfg(target_os = "linux")]
    let result = {
        // Пытаемся выделить файл через стандартный D-Bus интерфейс FileManager1,
        // который поддерживается большинством файловых менеджеров (Nautilus, Nemo, Thunar).
        let file_uri = format!("file://{}", absolute_path.to_string_lossy());
        let uri_array = format!("[\"{}\"]", file_uri);

        match std::process::Command::new("gdbus")
            .args([
                "call", "--session",
                "--dest", "org.freedesktop.FileManager1",
                "--object-path", "/org/freedesktop/FileManager1",
                "--method", "org.freedesktop.FileManager1.ShowItems",
                &uri_array,
                ""
            ])
            .spawn()
        {
            Ok(child) => Ok(child),
            Err(e) => {
                // Если gdbus не сработал (не установлен или не поддерживается),
                // открываем папку через xdg-open как запасной вариант
                eprintln!("[RUST] open_file_location: gdbus не сработал ({}), пробую xdg-open", e);
                let parent = absolute_path.parent()
                    .ok_or_else(|| format!("Не удалось получить родительскую папку для {}", absolute_path.display()))?;
                let parent_str = parent.to_string_lossy().into_owned();
                std::process::Command::new("xdg-open")
                    .arg(&parent_str)
                    .spawn()
            }
        }
    };

    result
        .map(|_| ())
        .map_err(|e| format!("Не удалось открыть папку: {}", e))
}