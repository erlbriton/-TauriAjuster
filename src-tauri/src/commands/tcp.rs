// src-tauri/src/commands/tcp.rs
// Команды работы с TCP-соединением (Modbus RTU over TCP/IP).
//
// Протокол: Modbus RTU over TCP/IP. Кадр остаётся RTU-формата (с CRC16),
// передаётся через TCP-сокет как есть (без MBAP-заголовка).
//
// Команды:
//   - open_tcp_connection: открыть TCP-соединение с заданным host:port;
//   - tcp_transaction:     атомарный write+read на открытом сокете;
//   - close_tcp_connection: закрыть соединение.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use socket2::{Socket, TcpKeepalive};

use crate::state::TcpState;

/// Отправить RST на сокете (abortive close). Забирает ownership.
/// Используется везде, где нужно грубо закрыть соединение, чтобы
/// контроллер немедленно освободил Modbus-сессию.
fn abortive_close(stream: TcpStream) {
    let sock = Socket::from(stream);
    let _ = sock.set_linger(Some(Duration::from_secs(0)));
    // drop(sock) → ядро посылает RST.
}

/// Команда: открыть TCP-соединение с указанным host:port.
///
/// При наличии старого сокета (даже сломанного) сначала закрывает его
/// через RST — чтобы контроллер освободил Modbus-сессию, привязанную к
/// старому source port. Без этого новые SYN могут игнорироваться
/// контроллером (наблюдается на промышленных устройствах).
#[tauri::command]
pub fn open_tcp_connection(
    state: tauri::State<'_, TcpState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    eprintln!("[RUST] open_tcp_connection: host = '{}', port = {}", host, port);

    // Шаг 1: RST на старый сокет (если он остался от предыдущей сессии).
    // Это ключевой момент: даже если сокет сломан (обрыв кабеля), при
    // восстановлении связи RST уйдёт и контроллер освободит ресурс.
    {
        let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
        if let Some(old) = guard.take() {
            eprintln!("[RUST] open_tcp_connection: закрываю старый сокет с RST");
            abortive_close(old);
        }
    }

    // Небольшая пауза, чтобы RST гарантированно ушёл до нового SYN.
    std::thread::sleep(Duration::from_millis(500));

    let address = format!("{}:{}", host, port);

    let addr_iter = address
        .to_socket_addrs()
        .map_err(|e| format!("Не удалось разрешить адрес {}: {}", address, e))?;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

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

    // Неблокирующий режим (иначе read может зависнуть на Windows).
    stream
        .set_nonblocking(true)
        .map_err(|e| format!("Не удалось задать nonblocking: {}", e))?;

    stream
        .set_nodelay(true)
        .map_err(|e| format!("Не удалось задать TCP_NODELAY: {}", e))?;

    // TCP keepalive — детекция обрыва кабеля за ~12-13 секунд.
    let socket = Socket::from(stream);
    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(3))
        .with_interval(Duration::from_secs(1));
    socket
        .set_tcp_keepalive(&keepalive)
        .map_err(|e| format!("Не удалось задать TCP keepalive: {}", e))?;
    let stream: TcpStream = socket.into();

    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    *guard = Some(stream);

    eprintln!("[RUST] open_tcp_connection: соединение установлено");
    Ok(())
}

/// Команда: атомарная транзакция — записать пакет и прочитать ответ.
///
/// ВАЖНО: при любой ошибке сокет НЕ дропается — остаётся в state.
/// Это позволяет при следующем open_tcp_connection послать RST на
/// старый сокет (см. комментарий в open_tcp_connection).
#[tauri::command]
pub fn tcp_transaction(
    state: tauri::State<'_, TcpState>,
    data: Vec<u8>,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    let stream = guard.as_mut().ok_or_else(|| "TCP-соединение не открыто".to_string())?;

    eprintln!(
        "[RUST] tcp_transaction: {} байт, timeout={}ms",
        data.len(),
        timeout_ms
    );

    // 1. Пишем пакет.
    if let Err(e) = stream.write_all(&data) {
        eprintln!("[RUST] tcp_transaction: ошибка write: {}", e);
        // НЕ дропаем сокет. Оставим его в state — при следующем
        // open_tcp_connection сначала закроем RST.
        return Err(format!("Ошибка записи в сокет: {}", e));
    }
    let _ = stream.flush();

    // 2. Читаем ответ.
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
                eprintln!("[RUST] tcp_transaction: соединение закрыто удалённой стороной");
                // НЕ дропаем сокет — оставляем для RST при реконнекте.
                return Err("Соединение закрыто удалённой стороной".to_string());
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                if let Some(t) = last_byte_at {
                    if t.elapsed() >= silence_timeout {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(ref e) if e.kind() == ErrorKind::ConnectionReset
                || e.kind() == ErrorKind::ConnectionAborted
                || e.kind() == ErrorKind::BrokenPipe => {
                eprintln!("[RUST] tcp_transaction: соединение разорвано: {}", e);
                // НЕ дропаем сокет — оставляем для RST при реконнекте.
                return Err(format!("Соединение разорвано: {}", e));
            }
            Err(e) => {
                eprintln!("[RUST] tcp_transaction: ошибка read: {}", e);
                // НЕ дропаем сокет — оставляем для RST при реконнекте.
                return Err(format!("Ошибка чтения из сокета: {}", e));
            }
        }
    }

    Ok(result)
}

/// Команда: закрыть TCP-соединение (abortive close с RST).
#[tauri::command]
pub fn close_tcp_connection(state: tauri::State<'_, TcpState>) -> Result<(), String> {
    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    if let Some(stream) = guard.take() {
        abortive_close(stream);
    }
    eprintln!("[RUST] close_tcp_connection: соединение закрыто (RST)");
    Ok(())
}