// src-tauri/src/commands/ini_template.rs
// Команды работы с шаблонами устройств:
//   - ensure_device_subdir: путь к подпапке внутри Devices (создать при необходимости);
//   - ensure_template_dir: путь к папке TemplateDevice (создать при необходимости);
//   - scan_template_dir: список имён файлов-шаблонов;
//   - copy_template_file: копирование выбранного файла в TemplateDevice.
//
// Файл выделен из commands/ini.rs. Публичный API сохранён через
// реэкспорт из commands/ini.rs — lib.rs (generate_handler!) не меняется.

use std::fs;
use std::path::Path;
use crate::app_config::AppConfigState;

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
pub fn ensure_device_subdir(
    state: tauri::State<'_, AppConfigState>,
    name: String,
) -> Result<String, String> {
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

    // Папка Devices — внутри текущей базовой папки (AppConfigState).
    // По умолчанию это папка exe, но после смены базы — другая.
    let devices_dir = state.base_dir.join("Devices");

    // Папки Devices нет — это ошибка, создавать её здесь не должны:
    // Devices — корень базы, он появляется либо при первом запуске,
    // либо создаётся пользователем. Молча плодить корень базы нежелательно.
    if !devices_dir.is_dir() {
        return Err(format!(
            "Папка Devices не найдена: {}",
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
pub fn ensure_template_dir(
    state: tauri::State<'_, AppConfigState>,
    create: bool,
) -> Result<String, String> {
    eprintln!("[RUST] ensure_template_dir: create = {}", create);

    // Папка TemplateDevice — внутри текущей базовой папки (AppConfigState).
    // По умолчанию это папка exe, но после смены базы — другая.
    let template_dir = state.base_dir.join("TemplateDevice");

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
pub fn scan_template_dir(state: tauri::State<'_, AppConfigState>) -> Result<Vec<String>, String> {
    eprintln!("[RUST] scan_template_dir: вызов команды");

    // Папка TemplateDevice — внутри текущей базовой папки (AppConfigState).
    // По умолчанию это папка exe, но после смены базы — другая.
    let template_dir = state.base_dir.join("TemplateDevice");

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
pub fn copy_template_file(
    state: tauri::State<'_, AppConfigState>,
    src_path: String,
    overwrite: bool,
) -> Result<String, String> {
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

    // Папка TemplateDevice — внутри текущей базовой папки (AppConfigState).
    // К моменту вызова команды она уже должна существовать — TS-сторона
    // вызывает ensure_template_dir с create = true, если папки не было
    // и пользователь согласился.
    let template_dir = state.base_dir.join("TemplateDevice");

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