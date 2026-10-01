// src-tauri/src/commands/tcp.rs
// Команды работы с TCP-соединением (Modbus RTU over TCP/IP).
//
// Протокол: Modbus RTU over TCP/IP. Это НЕ стандартный Modbus TCP с MBAP-заголовком.
// Кадр остаётся RTU-формата (с CRC16), но передаётся через TCP-сокет как есть.
//
// Команды:
//   - open_tcp_connection: открыть TCP-соединение с заданным host:port;
//   - tcp_transaction:     атомарный write+read на открытом сокете;
//   - close_tcp_connection: закрыть соединение.
//
// Логика транзакции зеркалит serial_transaction из src/commands/serial.rs:
// write → read loop до timeout_ms или до 3 мс тишины после первого байта.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::state::TcpState;

/// Команда: открыть TCP-соединение с указанным host:port.
///
/// Применяется для Modbus RTU over TCP/IP. Устанавливает read timeout 1 мс,
/// чтобы read() не блокировался навсегда и возвращал управление в
/// tcp_transaction для проверки общего таймаута.
///
/// Если предыдущее соединение было открыто — оно закрывается.
#[tauri::command]
pub fn open_tcp_connection(
    state: tauri::State<'_, TcpState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    eprintln!("[RUST] open_tcp_connection: host = '{}', port = {}", host, port);

    // Закрываем предыдущий сокет, если был.
    {
        let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    let address = format!("{}:{}", host, port);

    // Разрешаем имя хоста в один или несколько SocketAddr.
    // to_socket_addrs может блокироваться на DNS, но обычно быстро.
    let addr_iter = address
        .to_socket_addrs()
        .map_err(|e| format!("Не удалось разрешить адрес {}: {}", address, e))?;

    // connect_timeout — 3 секунды. Без него Linux ждёт OS-дефолт (~2 мин),
    // из-за чего UI зависал на длительное время при недоступном адресе.
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

    let mut stream_opt: Option<TcpStream> = None;
    let mut last_err: Option<String> = None;
    for addr in addr_iter {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                stream_opt = Some(s);
                break;
            }
            Err(e) => {
                last_err = Some(format!("{} ({})", e, addr));
            }
        }
    }

    let stream = stream_opt.ok_or_else(|| {
        format!(
            "Не удалось подключиться к {}: {}",
            address,
            last_err.unwrap_or_else(|| "неизвестная ошибка".to_string())
        )
    })?;

    // Read timeout 1 мс — чтобы read() возвращался регулярно, а tcp_transaction
    // мог проверять общий timeout и silence timeout.
    stream
        .set_read_timeout(Some(Duration::from_millis(1)))
        .map_err(|e| format!("Не удалось задать read timeout: {}", e))?;

    // NODELAY отключает алгоритм Нейгла: маленькие RTU-кадры уходят сразу,
    // не дожидаясь накопления буфера. Для Modbus это критично.
    stream
        .set_nodelay(true)
        .map_err(|e| format!("Не удалось задать TCP_NODELAY: {}", e))?;

    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    *guard = Some(stream);

    eprintln!("[RUST] open_tcp_connection: соединение установлено");
    Ok(())
}

/// Команда: атомарная транзакция — записать пакет и прочитать ответ.
///
/// Возвращает все байты, которые успели прийти за timeout_ms миллисекунд.
/// Прекращает чтение раньше, если после первого принятого байта наступает
/// пауза 3 мс (типичный конец Modbus-ответа).
///
/// При фатальной ошибке — сбрасывает сокет в state и возвращает Err.
#[tauri::command]
pub fn tcp_transaction(
    state: tauri::State<'_, TcpState>,
    data: Vec<u8>,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    let stream = guard.as_mut().ok_or_else(|| "TCP-соединение не открыто".to_string())?;

    // 1. Пишем пакет.
    if let Err(e) = stream.write_all(&data) {
        eprintln!("[RUST] tcp_transaction: фатальная ошибка write: {}", e);
        *guard = None;
        return Err(format!("Ошибка записи в сокет: {}", e));
    }
    // flush для TcpStream не обязателен (NODELAY уже выставили), но оставим
    // для явности — write_all может буферизовать.
    if let Err(e) = stream.flush() {
        eprintln!("[RUST] tcp_transaction: ошибка flush: {}", e);
        // не считаем фатальной — данные уже отправлены
    }

    // 2. Читаем ответ до timeout_ms или до 3 мс тишины после первого байта.
    let mut result: Vec<u8> = Vec::new();
    let start = Instant::now();
    let overall_timeout = Duration::from_millis(timeout_ms);
    let silence_timeout = Duration::from_millis(3);
    let mut last_byte_at: Option<Instant> = None;
    let mut buf = [0u8; 4096];

    while start.elapsed() < overall_timeout {
        match stream.read(&mut buf) {
            Ok(n) if n > 0 => {
                result.extend_from_slice(&buf[..n]);
                last_byte_at = Some(Instant::now());
            }
            Ok(_) => {
                // 0 байт — соединение закрыто удалённой стороной.
                // Для Modbus это означает обрыв; прекращаем чтение.
                break;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut
                || e.kind() == std::io::ErrorKind::WouldBlock => {
                // Таймаут 1 мс истёк — проверяем silence timeout.
                if let Some(t) = last_byte_at {
                    if t.elapsed() >= silence_timeout {
                        break;
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::ConnectionReset
                || e.kind() == std::io::ErrorKind::ConnectionAborted
                || e.kind() == std::io::ErrorKind::BrokenPipe => {
                eprintln!("[RUST] tcp_transaction: соединение разорвано: {}", e);
                *guard = None;
                return Err(format!("Соединение разорвано: {}", e));
            }
            Err(e) => {
                eprintln!("[RUST] tcp_transaction: фатальная ошибка read: {}", e);
                *guard = None;
                return Err(format!("Ошибка чтения из сокета: {}", e));
            }
        }
    }

    Ok(result)
}

/// Команда: закрыть TCP-соединение.
#[tauri::command]
pub fn close_tcp_connection(state: tauri::State<'_, TcpState>) -> Result<(), String> {
    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    *guard = None;
    eprintln!("[RUST] close_tcp_connection: соединение закрыто");
    Ok(())
}