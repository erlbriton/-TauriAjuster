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

/// Команда: вернуть путь к подпапке внутри Devices и создать её при необходимости.
///
/// Структура базы: рядом с exe лежит папка Devices/, а внутри неё — подпапки
/// по локациям (имя = Location из INI) или, если Location нет, по версии
/// прошивки (например, "DExS.AVS v1.10.6.3"). INI-файлы лежат в этих
/// подпапках, не в корне Devices.
///
/// Имя подпапки приходит уже санитизированным с TS-стороны
/// (недопустимые для ОС символы заменены), поэтому здесь только проверка
/// на пустоту и защита от попыток выхода из папки Devices (..).
#[tauri::command]
pub fn ensure_device_subdir(name: String) -> Result<String, String> {
    eprintln!("[RUST] ensure_device_subdir: имя подпапки = '{}'", name);

    // Защита от пустого имени и попыток выйти за пределы Devices (..)
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Пустое имя подпапки для Devices".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!(
            "Недопустимое имя подпапки для Devices: '{}'",
            name
        ));
    }

    // Определяем папку Devices рядом с exe (та же логика, что в scan_devices_folder
    // и get_devices_folder_path, чтобы не было расхождений).
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let devices_dir = exe_dir.join("Devices");

    // Папки Devices нет — это ошибка, создавать её здесь не должны:
    // Devices — корень базы, он появляется либо при первом запуске,
    // либо создаётся пользователем. Молча плодить корень базы нежелательно.
    if !devices_dir.is_dir() {
        return Err(format!(
            "Папка Devices не найдена рядом с приложением: {}",
            devices_dir.display()
        ));
    }

    let subdir = devices_dir.join(trimmed);
    if !subdir.is_dir() {
        fs::create_dir_all(&subdir).map_err(|e| {
            format!(
                "Не удалось создать подпапку '{}': {}",
                subdir.display(),
                e
            )
        })?;
        eprintln!(
            "[RUST] ensure_device_subdir: создана подпапка '{}'",
            subdir.display()
        );
    }

    Ok(subdir.to_string_lossy().into_owned())
}

/// Команда: вернуть путь к папке BackUp рядом с exe (сосед Devices).
///
/// Логика работы:
///   - если папка BackUp уже существует — вернуть её путь;
///   - если папки нет и create = false — вернуть специальную ошибку
///     "BACKUP_DIR_NOT_FOUND" (TS-сторона её распознаёт и спрашивает
///     у пользователя, создавать ли папку);
///   - если папки нет и create = true — создать и вернуть путь.
///
/// Структура базы:
///   <рядом с exe>/
///     Devices/          ← INI-файлы по подпапкам (Location / версия прошивки)
///     BackUp/           ← старые INI, перемещённые при обновлении прошивки
#[tauri::command]
pub fn ensure_backup_dir(create: bool) -> Result<String, String> {
    eprintln!("[RUST] ensure_backup_dir: create = {}", create);

    // Путь к BackUp — рядом с exe, сосед Devices. Та же логика, что в
    // scan_devices_folder и get_devices_folder_path, чтобы папки гарантированно
    // лежали на одном уровне.
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let backup_dir = exe_dir.join("BackUp");

    if !backup_dir.is_dir() {
        if create {
            fs::create_dir_all(&backup_dir).map_err(|e| {
                format!(
                    "Не удалось создать папку '{}': {}",
                    backup_dir.display(),
                    e
                )
            })?;
            eprintln!(
                "[RUST] ensure_backup_dir: создана папка '{}'",
                backup_dir.display()
            );
        } else {
            // Специальная ошибка: TS-сторона её распознаёт и предлагает
            // пользователю создать папку. Обычное сообщение об ошибке
            // не подходит — оно показывается как сбой, а тут штатная ситуация.
            return Err("BACKUP_DIR_NOT_FOUND".to_string());
        }
    }

    Ok(backup_dir.to_string_lossy().into_owned())
}

/// Команда: «ритуал» обновления прошивки — одним вызовом.
///
/// Что делает по шагам:
///   1. Проверяет, что старый файл old_path существует и является обычным файлом.
///   2. Проверяет, что папка BackUp рядом с exe существует
///      (её создание — отдельная команда ensure_backup_dir).
///   3. Читает старое содержимое old_path.
///   4. Вычисляет имя файла-бэкапа (только имя, BackUp — плоский).
///   5. Если файл с таким именем уже лежит в BackUp:
///        - overwrite = false → возвращает ошибку "BACKUP_ALREADY_EXISTS"
///          (TS-сторона спрашивает пользователя и повторяет с overwrite = true);
///        - overwrite = true  → перезаписывает.
///   6. Копирует старое содержимое в BackUp/<имя>.
///   7. Перезаписывает old_path новым содержимым new_content.
///   8. Если после перезаписи папка-источник осталась пустой и это не сам
///      корень Devices — удаляет её (по требованию: пустые папки не хранить).
///
/// Возвращает путь к созданному бэкапу — чтобы TS мог показать его пользователю.
#[tauri::command]
pub fn backup_and_replace_ini(
    old_path: String,
    new_content: Vec<u8>,
    overwrite: bool,
) -> Result<String, String> {
    eprintln!(
        "[RUST] backup_and_replace_ini: old_path = '{}', {} байт нового содержимого, overwrite = {}",
        old_path,
        new_content.len(),
        overwrite
    );

    let old_file_path = Path::new(&old_path);

    // 1. Старый файл должен существовать и быть обычным файлом.
    if !old_file_path.exists() {
        return Err(format!("Старый файл не найден: {}", old_path));
    }
    if !old_file_path.is_file() {
        return Err(format!("Путь не является файлом: {}", old_path));
    }

    // Имя старого файла (например, "00000056.ini") — оно же имя бэкапа.
    // BackUp плоский, поэтому путь не сохраняем, только имя.
    let file_name = old_file_path
        .file_name()
        .ok_or_else(|| format!("Не удалось выделить имя файла из '{}'", old_path))?
        .to_string_lossy()
        .into_owned();

    // 2. Папка BackUp рядом с exe. Если её нет — это ошибка: TS-сторона
    //    должна была сначала вызвать ensure_backup_dir (создать при согласии
    //    пользователя) и получить "BACKUP_DIR_NOT_FOUND" при отказе.
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let backup_dir = exe_dir.join("BackUp");

    if !backup_dir.is_dir() {
        return Err("BACKUP_DIR_NOT_FOUND".to_string());
    }

    let backup_path = backup_dir.join(&file_name);

    // 5. Файл в BackUp уже есть — возвращаем специальную ошибку,
    //    чтобы TS-сторона спросила «Перезаписать?» и повторила с overwrite = true.
    if backup_path.exists() && !overwrite {
        return Err("BACKUP_ALREADY_EXISTS".to_string());
    }

    // 3. Читаем старый файл в память до любых изменений на диске.
    //    Если чтение упадёт — ничего не испортим.
    let old_bytes = fs::read(old_file_path)
        .map_err(|e| format!("Не удалось прочитать старый файл '{}': {}", old_path, e))?;

    // 6. Пишем копию в BackUp. Если тут упадёт — оригинал ещё не тронут.
    fs::write(&backup_path, &old_bytes).map_err(|e| {
        format!(
            "Не удалось записать бэкап '{}': {}",
            backup_path.display(),
            e
        )
    })?;
    eprintln!(
        "[RUST] backup_and_replace_ini: бэкап записан в '{}'",
        backup_path.display()
    );

    // 7. Перезаписываем оригинал новым содержимым.
    fs::write(old_file_path, &new_content).map_err(|e| {
        format!(
            "Не удалось перезаписать файл '{}': {}",
            old_path, e
        )
    })?;
    eprintln!("[RUST] backup_and_replace_ini: оригинал перезаписан");

    // 8. Если папка-источник осталась пустой и это не корень Devices —
    //    удаляем её. remove_dir сработает только для пустой папки,
    //    поэтому проверка на «не корень» — единственное, что нужно.
    if let Some(parent) = old_file_path.parent() {
        let devices_dir = exe_dir.join("Devices");
        if parent != devices_dir && parent.is_dir() {
            // Проверяем, пуста ли папка: если в ней не осталось записей — удаляем.
            match fs::read_dir(parent) {
                Ok(mut entries) => {
                    if entries.next().is_none() {
                        if let Err(e) = fs::remove_dir(parent) {
                            // Не критично: файл уже обновлён, просто папка осталась.
                            eprintln!(
                                "[RUST] backup_and_replace_ini: не удалось удалить пустую папку '{}': {}",
                                parent.display(),
                                e
                            );
                        } else {
                            eprintln!(
                                "[RUST] backup_and_replace_ini: пустая папка '{}' удалена",
                                parent.display()
                            );
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[RUST] backup_and_replace_ini: не удалось прочитать папку '{}': {}",
                        parent.display(),
                        e
                    );
                }
            }
        }
    }

    Ok(backup_path.to_string_lossy().into_owned())
}

/// Команда: вернуть путь к папке TemplateDevice рядом с exe.
///
/// TemplateDevice — это папка с шаблонами INI-файлов (файлы без расширения
/// .ini), которые пользователь выбирает в окнах "Новое устройство" и
/// "Обновление программы устройства". Лежит рядом с Devices и BackUp.
///
/// Логика работы — та же, что у ensure_backup_dir:
///   - если папка уже существует — вернуть её путь;
///   - если папки нет и create = false — вернуть специальную ошибку
///     "TEMPLATE_DIR_NOT_FOUND" (TS-сторона её распознаёт и спрашивает
///     пользователя, создавать ли папку);
///   - если папки нет и create = true — создать и вернуть путь.
///
/// Структура базы:
///   <рядом с exe>/
///     Devices/          ← рабочая база INI, разложенная по подпапкам
///     BackUp/           ← старые INI, перемещённые при обновлении прошивки
///     TemplateDevice/   ← файлы-шаблоны для создания новых устройств
#[tauri::command]
pub fn ensure_template_dir(create: bool) -> Result<String, String> {
    eprintln!("[RUST] ensure_template_dir: create = {}", create);

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let template_dir = exe_dir.join("TemplateDevice");

    if !template_dir.is_dir() {
        if create {
            fs::create_dir_all(&template_dir).map_err(|e| {
                format!(
                    "Не удалось создать папку '{}': {}",
                    template_dir.display(),
                    e
                )
            })?;
            eprintln!(
                "[RUST] ensure_template_dir: создана папка '{}'",
                template_dir.display()
            );
        } else {
            // Специальная ошибка: TS-сторона её распознаёт и предлагает
            // пользователю создать папку — как у ensure_backup_dir.
            return Err("TEMPLATE_DIR_NOT_FOUND".to_string());
        }
    }

    Ok(template_dir.to_string_lossy().into_owned())
}

/// Команда: вернуть список имён файлов из папки TemplateDevice.
///
/// Возвращает только ИМЕНА файлов (не полные пути, не содержимое).
/// Содержимое читается отдельной командой только в момент, когда
/// пользователь уже выбрал шаблон и нажал "Добавить устройство в базу".
///
/// Если папки TemplateDevice нет — возвращает пустой массив, без ошибки.
/// Это штатная ситуация: папка может быть ещё не создана.
///
/// Подпапки пропускаются: шаблоны — это файлы. Алфавитная сортировка
/// даёт стабильный порядок между запусками.
#[tauri::command]
pub fn scan_template_dir() -> Result<Vec<String>, String> {
    eprintln!("[RUST] scan_template_dir: вызов команды");

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let template_dir = exe_dir.join("TemplateDevice");

    // Папки нет — возвращаем пустой список, это не ошибка.
    if !template_dir.is_dir() {
        eprintln!("[RUST] scan_template_dir: папки TemplateDevice нет, возвращаем пустой список");
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&template_dir)
        .map_err(|e| format!("Не удалось прочитать папку {}: {}", template_dir.display(), e))?;

    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        // Только обычные файлы — подпапки пропускаем.
        if path.is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }

        // Стабильный порядок — алфавитный.
    names.sort();

    eprintln!(
        "[RUST] scan_template_dir: найдено {} шаблон(ов)",
        names.len()
    );
    Ok(names)
}

/// Команда: скопировать выбранный пользователем файл в папку TemplateDevice.
///
/// Сценарии использования (по требованиям алгоритма):
///   - пользователь выбрал файл ВНЕ TemplateDevice → копируем его в папку;
///   - пользователь выбрал файл ВНУТРИ TemplateDevice → ничего не делаем,
///     просто возвращаем имя (файл уже в списке);
///   - файл с таким именем уже есть в TemplateDevice, а overwrite = false →
///     возвращаем "TEMPLATE_FILE_EXISTS", TS-сторона спросит «Перезаписать?»
///     и при согласии повторит вызов с overwrite = true.
///
/// Возвращает имя файла — чтобы TS-сторона сразу могла добавить его в список.
#[tauri::command]
pub fn copy_template_file(src_path: String, overwrite: bool) -> Result<String, String> {
    eprintln!(
        "[RUST] copy_template_file: src = '{}', overwrite = {}",
        src_path,
        overwrite
    );

    let src = Path::new(&src_path);

    // Источник должен существовать и быть обычным файлом.
    if !src.exists() {
        return Err(format!("Исходный файл не найден: {}", src_path));
    }
    if !src.is_file() {
        return Err(format!("Источник не является файлом: {}", src_path));
    }

    // Имя файла — оно же будет именем в TemplateDevice.
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("Не удалось выделить имя файла из '{}'", src_path))?
        .to_string_lossy()
        .into_owned();

    // Папка TemplateDevice рядом с exe. К моменту вызова команды она
    // уже должна существовать — TS-сторона вызывает ensure_template_dir
    // с create = true, если папки не было и пользователь согласился.
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Не удалось определить путь к исполняемому файлу: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "У пути к исполняемому файлу нет родительской папки".to_string())?;
    let template_dir = exe_dir.join("TemplateDevice");

    if !template_dir.is_dir() {
        return Err("TEMPLATE_DIR_NOT_FOUND".to_string());
    }

    let target_path = template_dir.join(&file_name);

    // Если источник уже внутри TemplateDevice — копирование не нужно.
    // Сравниваем канонические пути: они разрешают симлинки и приводят
    // абсолютные пути к единому виду. Если canonicalize не сработал
    // (например, файла нет), просто идём дальше и попробуем копировать —
    // случай редкий, а логика останется корректной.
    if let (Ok(src_canon), Ok(tgt_canon)) = (
        fs::canonicalize(src),
        fs::canonicalize(&target_path),
    ) {
        if src_canon == tgt_canon {
            eprintln!(
                "[RUST] copy_template_file: файл уже лежит в TemplateDevice, копирование не нужно"
            );
            return Ok(file_name);
        }
    }

    // Целевой файл уже есть и перезапись не разрешена — отдаём спец. ошибку.
    if target_path.exists() && !overwrite {
        return Err("TEMPLATE_FILE_EXISTS".to_string());
    }

    // Копирование. fs::copy перезаписывает целевой файл, если он есть, —
    // это и нужно при overwrite = true.
    fs::copy(src, &target_path).map_err(|e| {
        format!(
            "Не удалось скопировать файл '{}' в '{}': {}",
            src_path,
            target_path.display(),
            e
        )
    })?;

    eprintln!(
        "[RUST] copy_template_file: файл скопирован в '{}'",
        target_path.display()
    );

    Ok(file_name)
}