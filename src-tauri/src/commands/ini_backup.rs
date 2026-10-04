// src-tauri/src/commands/ini_backup.rs
// Команды резервного копирования INI-файлов:
//   - ensure_backup_dir: путь к папке BackUp (создать при необходимости);
//   - backup_and_replace_ini: «ритуал» обновления прошивки — бэкап + перезапись;
//   - scan_backup_dir: список имён файлов в BackUp.
//
// Файл выделен из commands/ini.rs. Публичный API сохранён через
// реэкспорт из commands/ini.rs — lib.rs (generate_handler!) не меняется.

use std::fs;
use std::path::Path;
use crate::app_config::AppConfigState;

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
pub fn ensure_backup_dir(
    state: tauri::State<'_, AppConfigState>,
    create: bool,
) -> Result<String, String> {
    eprintln!("[RUST] ensure_backup_dir: create = {}", create);

    // Путь к BackUp — внутри текущей базовой папки, сосед Devices.
    // Базовая папка берётся из общего состояния (AppConfigState):
    // по умолчанию это папка exe, но после смены базы — другая.
    let backup_dir = state.base_dir.join("BackUp");

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
    state: tauri::State<'_, AppConfigState>,
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

    // 2. Папка BackUp — внутри текущей базовой папки (AppConfigState).
    //    Если её нет — это ошибка: TS-сторона должна была сначала вызвать
    //    ensure_backup_dir (создать при согласии пользователя) и получить
    //    "BACKUP_DIR_NOT_FOUND" при отказе.
    let backup_dir = state.base_dir.join("BackUp");

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
        let devices_dir = state.base_dir.join("Devices");
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

/// Команда: вернуть список имён файлов из папки BackUp рядом с exe.
///
/// Возвращает только ИМЕНА файлов (не полные пути, не содержимое).
/// Используется при синхронизации дерева с диском: если для «красной»
/// записи (isBackup = true) файла в BackUp больше нет — запись удаляется.
///
/// Если папки BackUp нет — возвращает пустой массив, без ошибки.
/// Это нормально: пользователь мог её ещё не создавать или удалить вручную.
#[tauri::command]
pub fn scan_backup_dir(state: tauri::State<'_, AppConfigState>) -> Result<Vec<String>, String> {
    eprintln!("[RUST] scan_backup_dir: вызов команды");

    // Папка BackUp — внутри текущей базовой папки (AppConfigState).
    // По умолчанию это папка exe, но после смены базы — другая.
    let backup_dir = state.base_dir.join("BackUp");

    // Папки нет — возвращаем пустой список, это не ошибка.
    if !backup_dir.is_dir() {
        eprintln!("[RUST] scan_backup_dir: папки BackUp нет, возвращаем пустой список");
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&backup_dir)
        .map_err(|e| format!("Не удалось прочитать папку {}: {}", backup_dir.display(), e))?;

    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        // Только обычные файлы — подпапки пропускаем.
        if path.is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }

    names.sort();

    eprintln!(
        "[RUST] scan_backup_dir: найдено {} файл(ов)",
        names.len()
    );
    Ok(names)
}