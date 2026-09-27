// src-tauri/src/app_config.rs
// Конфигурация приложения: путь к текущей базовой папке и папке exe.
//
// Базовая папка — это папка, внутри которой лежат Devices/, BackUp/,
// TemplateDevice/, XLT/, Records/. По умолчанию это папка рядом с exe.
// Пользователь может переключиться на другую базовую папку через
// «Обновить список устройств» → «Сменить папку базы».
//
// Активная база хранится в файле controllers.txt рядом с exe:
//   current=<путь к текущей базовой папке>
//   <путь 1>
//   <путь 2>
//   ...
// Строка current= опциональна. Если её нет или путь не существует,
// приложение работает с папкой рядом с exe.

use std::fs;
use std::path::{Path, PathBuf};

/// Имя файла со списком базовых папок (рядом с exe).
pub const CONTROLLERS_FILE: &str = "controllers.txt";

/// Состояние конфигурации приложения, доступное всем командам через
/// tauri::State. Регистрируется в lib.rs через .manage() при старте.
///
/// Поля иммутабельны в течение жизни приложения: после смены базы
/// приложение перезапускается (relaunch), и новый процесс читает
/// controllers.txt заново. Поэтому Mutex/RwLock не нужны.
pub struct AppConfigState {
    /// Текущая базовая папка (Devices/, BackUp/, … ищутся внутри неё).
    pub base_dir: PathBuf,
    /// Папка рядом с exe. Нужна, чтобы:
    ///   - найти controllers.txt;
    ///   - вернуться к «поведению по умолчанию», если current= нет.
    pub exe_dir: PathBuf,
}

impl AppConfigState {
    /// Создаёт состояние при старте приложения.
    /// Определяет рабочую папку приложения, читает controllers.txt
    /// и устанавливает base_dir.
    ///
    /// Рабочая папка приложения («exe_dir») определяется так:
    ///   - на Linux, если задана переменная APPIMAGE (приложение запущено
    ///     как .AppImage), берётся родительская папка файла .AppImage —
    ///     это папка, куда пользователь положил приложение. Иначе код
    ///     видел бы временную папку распаковки и не нашёл бы рядом
    ///     ни controllers.txt, ни Devices/;
    ///   - во всех остальных случаях — папка текущего исполняемого файла
    ///     (exe на Windows, бинарник на Linux без AppImage, .app-бандл на macOS).
    pub fn from_startup() -> Self {
        let exe_dir = resolve_app_dir();

        let base_dir = read_current_base_dir(&exe_dir).unwrap_or_else(|| {
            eprintln!(
                "[app-config] Базовая папка не задана — используется папка приложения: {}",
                exe_dir.display()
            );
            exe_dir.clone()
        });

        eprintln!(
            "[app-config] exe_dir = '{}', base_dir = '{}'",
            exe_dir.display(),
            base_dir.display()
        );

        Self { base_dir, exe_dir }
    }

    /// Возвращает путь к файлу controllers.txt (рядом с exe).
    pub fn controllers_file(&self) -> PathBuf {
        self.exe_dir.join(CONTROLLERS_FILE)
    }
}

/// Читает строку "current=..." из controllers.txt.
///
/// Возвращает Some(path), если:
///   - файл существует и читается;
///   - в нём есть строка, начинающаяся с "current=";
///   - путь после = не пустой и указывает на существующую папку.
///
/// Во всех остальных случаях — None (тогда используется exe_dir).
fn read_current_base_dir(exe_dir: &Path) -> Option<PathBuf> {
    let file_path = exe_dir.join(CONTROLLERS_FILE);
    let content = fs::read_to_string(&file_path).ok()?;

    for line in content.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("current=") else {
            continue;
        };
        let path_str = rest.trim();
        if path_str.is_empty() {
            eprintln!("[app-config] Строка current= пуста, fallback на exe_dir");
            return None;
        }

        let path = PathBuf::from(path_str);
        if path.is_dir() {
            return Some(path);
        }

        // Путь указан, но папки нет — по согласованию работаем с exe_dir
        // и выводим предупреждение в консоль.
        eprintln!(
            "[app-config] Путь из current= не существует: '{}' — fallback на exe_dir",
            path.display()
        );
        return None;
    }

    None
}

/// Возвращает рабочую папку приложения:
///   - папку рядом с .AppImage, если задана переменная APPIMAGE;
///   - папку текущего exe/бина во всех остальных случаях.
///
/// При ошибке (не удалось получить путь или у него нет родителя)
/// возвращает текущую рабочую директорию процесса — это безопасный fallback,
/// при котором приложение всё равно запустится.
fn resolve_app_dir() -> PathBuf {
    // Linux + AppImage: переменная APPIMAGE содержит путь к самому файлу
    // .AppImage. Берём его родительскую папку — туда пользователь положил
    // приложение и рядом с ней лежит база.
    if let Ok(appimage_path) = std::env::var("APPIMAGE") {
        if let Some(parent) = Path::new(&appimage_path).parent() {
            return parent.to_path_buf();
        }
    }

    // Обычный запуск: папка текущего exe/бина.
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|pp| pp.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

