// src-tauri/src/commands/app_config.rs
// Команды управления базовой папкой приложения.
//
// Базовая папка — та, внутри которой лежат Devices/, BackUp/,
// TemplateDevice/, XLT/, Records/. По умолчанию это папка рядом с exe.
// Пользователь может переключиться на другую папку через диалог
// «Сменить папку базы» (в меню «Обновить список устройств»).
//
// Список сохранённых папок и активная папка хранятся в файле
// controllers.txt рядом с exe (см. src-tauri/src/app_config.rs).

use std::fs;

use crate::app_config::AppConfigState;

/// Команда: проверить наличие файла controllers.txt рядом с exe.
/// Если файла нет — создать пустой. Возвращает true, если файл был создан
/// этой командой, и false, если он уже существовал.
///
/// TS-сторона вызывает команду при первом клике на «Сменить папку базы»:
///   - если вернулось true  — файл только что создан, продолжаем диалог;
///   - если вернулось false — файл уже был, просто открываем окно.
/// В любом случае — после создания можно писать в файл.
#[tauri::command]
pub fn ensure_controllers_file(state: tauri::State<'_, AppConfigState>) -> Result<bool, String> {
    let file_path = state.controllers_file();
    eprintln!(
        "[RUST] ensure_controllers_file: путь = '{}'",
        file_path.display()
    );

    if file_path.exists() {
        return Ok(false);
    }

    // Создаём пустой файл. Запись current= и списка папок —
    // задача отдельных команд set_base_dir / reset_base_dir.
    fs::write(&file_path, "").map_err(|e| {
        format!(
            "Не удалось создать файл '{}': {}",
            file_path.display(),
            e
        )
    })?;
    eprintln!(
        "[RUST] ensure_controllers_file: файл создан '{}'",
        file_path.display()
    );

    Ok(true)
}

/// Информация о сохранённых базовых папках — то, что нужно фронтенду
/// для отрисовки выпадающего списка в диалоге «Сменить папку базы».
#[derive(serde::Serialize)]
pub struct SavedBasesInfo {
    /// Текущая активная база (путь из строки current=).
    /// None, если строка отсутствует или пуста — тогда используется папка exe.
    pub current: Option<String>,
    /// Папка exe. Фронтенд использует её как пункт «По умолчанию»
    /// в выпадающем списке.
    pub exe_dir: String,
    /// Все сохранённые пути из controllers.txt (без строки current=),
    /// в порядке появления. Дубликаты отфильтрованы.
    pub saved: Vec<String>,
}

/// Команда: прочитать controllers.txt и вернуть структуру для фронтенда.
///
/// Если файла нет — возвращает current=null, saved=[] (фронтенд покажет
/// только пункт «По умолчанию»). Ошибка чтения (кроме отсутствия файла)
/// возвращается как Err, чтобы TS-сторона показала пользователю.
///
/// Существование путей из saved НЕ проверяем: пользователь может видеть
/// свой список, даже если часть папок переехала. Проверка — при выборе
/// (в set_base_dir).
#[tauri::command]
pub fn list_saved_bases(state: tauri::State<'_, AppConfigState>) -> Result<SavedBasesInfo, String> {
    let file_path = state.controllers_file();
    let exe_dir = state.exe_dir.to_string_lossy().into_owned();

    eprintln!(
        "[RUST] list_saved_bases: путь = '{}'",
        file_path.display()
    );

    // Файла нет — пустая структура.
    if !file_path.exists() {
        return Ok(SavedBasesInfo {
            current: None,
            exe_dir,
            saved: Vec::new(),
        });
    }

    let content = fs::read_to_string(&file_path).map_err(|e| {
        format!(
            "Не удалось прочитать файл '{}': {}",
            file_path.display(),
            e
        )
    })?;

    let mut current: Option<String> = None;
    let mut saved: Vec<String> = Vec::new();
    // Множество для отсечения дубликатов путей из saved.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Строка current=… — это активная база.
        if let Some(rest) = trimmed.strip_prefix("current=") {
            let path_str = rest.trim();
            if !path_str.is_empty() {
                current = Some(path_str.to_string());
            }
            continue;
        }

        // Обычная строка — путь к сохранённой папке.
        if !seen.insert(trimmed.to_string()) {
            continue;
        }
        saved.push(trimmed.to_string());
    }

    eprintln!(
        "[RUST] list_saved_bases: current = {:?}, saved = {} путей",
        current,
        saved.len()
    );

    Ok(SavedBasesInfo {
        current,
        exe_dir,
        saved,
    })
}

/// Команда: сделать указанную папку активной базовой папкой.
///
/// Что делает:
///   1. Проверяет, что path существует и является папкой;
///   2. Читает текущий controllers.txt, сохраняя порядок уже записанных путей;
///   3. Если path ещё не среди сохранённых — добавляет его в конец списка;
///   4. Перезаписывает файл: "current=<path>" первой строкой + все сохранённые пути.
///
/// Существующие пути не удаляются: пользователь может накопить список
/// из нескольких баз и переключаться между ними.
///
/// Возвращает Ok(()) — фронтенд после этого вызывает relaunch(),
/// чтобы новый процесс стартовал с новой базой.
#[tauri::command]
pub fn set_base_dir(
    state: tauri::State<'_, AppConfigState>,
    path: String,
) -> Result<(), String> {
    let file_path = state.controllers_file();
    eprintln!(
        "[RUST] set_base_dir: path = '{}', файл = '{}'",
        path,
        file_path.display()
    );

    // 1. Проверка существования.
    let new_base = std::path::Path::new(&path);
    if !new_base.exists() {
        return Err(format!("Папка не найдена: {}", path));
    }
    if !new_base.is_dir() {
        return Err(format!("Путь не является папкой: {}", path));
    }

    // 2. Читаем существующий список сохранённых путей (без current=).
    //    Если файла нет — начинаем с пустого списка.
    let mut saved: Vec<String> = Vec::new();
    if file_path.exists() {
        let content = fs::read_to_string(&file_path).map_err(|e| {
            format!(
                "Не удалось прочитать файл '{}': {}",
                file_path.display(),
                e
            )
        })?;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("current=") {
                continue;
            }
            if seen.insert(trimmed.to_string()) {
                saved.push(trimmed.to_string());
            }
        }
    }

    // 3. Добавляем новый путь в конец, если его ещё нет.
    if !saved.iter().any(|p| p == &path) {
        saved.push(path.clone());
    }

    // 4. Собираем содержимое файла: current= первой строкой, потом saved.
    //    Используем \n как разделитель — файл человекочитаемый,
    //    кроссплатформенный.
    let mut content = format!("current={}\n", path);
    for p in &saved {
        content.push_str(p);
        content.push('\n');
    }

    fs::write(&file_path, content).map_err(|e| {
        format!(
            "Не удалось записать файл '{}': {}",
            file_path.display(),
            e
        )
    })?;

    eprintln!(
        "[RUST] set_base_dir: current = '{}', в списке сохранённых {} путей",
        path,
        saved.len()
    );

    Ok(())
}

/// Команда: сбросить активную базовую папку. Убирает строку current=
/// из controllers.txt. Список сохранённых путей не трогается: пользователь
/// может вернуться к любой из них через list_saved_bases + set_base_dir.
///
/// После вызова фронтенд делает relaunch(), и новый процесс работает
/// с папкой рядом с exe (поведение «по умолчанию»).
#[tauri::command]
pub fn reset_base_dir(state: tauri::State<'_, AppConfigState>) -> Result<(), String> {
    let file_path = state.controllers_file();
    eprintln!(
        "[RUST] reset_base_dir: файл = '{}'",
        file_path.display()
    );

    // Файла нет — уже сброшено, нечего делать.
    if !file_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&file_path).map_err(|e| {
        format!(
            "Не удалось прочитать файл '{}': {}",
            file_path.display(),
            e
        )
    })?;

    // Оставляем только строки, которые НЕ начинаются с current=.
    // Порядок сохранённых путей сохраняется.
    let mut saved: Vec<String> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("current=") {
            continue;
        }
        saved.push(trimmed.to_string());
    }

    // Если ничего не осталось — перезаписываем пустым файлом.
    // Иначе — теми же путями, но уже без строки current=.
    let mut new_content = String::new();
    for p in &saved {
        new_content.push_str(p);
        new_content.push('\n');
    }

    fs::write(&file_path, new_content).map_err(|e| {
        format!(
            "Не удалось записать файл '{}': {}",
            file_path.display(),
            e
        )
    })?;

    eprintln!(
        "[RUST] reset_base_dir: current= удалён, сохранённых путей: {}",
        saved.len()
    );

    Ok(())
}
/// Команда: проверить, существует ли файл controllers.txt рядом с exe.
///
/// Отличие от ensure_controllers_file: этот вариант НИЧЕГО не создаёт.
/// Используется окном «Сменить папку базы», чтобы сначала спросить
/// пользователя: «Файл не найден. Создать?» — и только по согласию
/// вызвать ensure_controllers_file.
#[tauri::command]
pub fn controllers_file_exists(state: tauri::State<'_, AppConfigState>) -> bool {
    let file_path = state.controllers_file();
    let exists = file_path.exists();
    eprintln!(
        "[RUST] controllers_file_exists: путь = '{}', существует = {}",
        file_path.display(),
        exists
    );
    exists
}