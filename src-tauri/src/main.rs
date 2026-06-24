// =====================================================
// main.rs — punto de entrada de la app de escritorio.
//
// Idea general (patrón "servidor local embebido"):
//   1. Levantamos un servidor HTTP (Axum) escuchando SOLO en
//      127.0.0.1 (localhost), en un puerto fijo. Ese servidor
//      reemplaza a PHP+Apache: responde las mismas rutas /api/*
//      y sirve el frontend (HTML/CSS/JS).
//   2. Tauri abre una ventana nativa que carga http://127.0.0.1:PUERTO,
//      así el front (que hace fetch a esas rutas) funciona igual que
//      cuando hablaba con PHP, pero ahora todo es Rust + SQLite local.
//
// El frontend (carpeta ../dist) se INCRUSTA dentro del binario con
// rust-embed: el .exe final no depende de archivos sueltos, todo viaja
// adentro. Corre OFFLINE. Si hay internet, las imágenes de productos por
// URL (https://...) cargan; si no, se ve el placeholder. Ese es el "plus".
// =====================================================

// Oculta la consola de Windows en modo release (solo la ventana de la app).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod auth;
mod db;

use axum::{
    body::Body,
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use rusqlite::Connection;
use rust_embed::RustEmbed;
use std::sync::{Arc, Mutex};

/// Puerto local fijo. Solo accesible desde la propia máquina.
const PUERTO: u16 = 4775;

/// Incrusta TODO el frontend (../dist) dentro del binario en tiempo de
/// compilación. En el .exe final estos archivos viajan adentro.
#[derive(RustEmbed)]
#[folder = "../dist"]
struct Frontend;

/// Sirve un archivo incrustado por su ruta. Si la ruta viene vacía,
/// entrega index.html (la raíz). Adivina el Content-Type por extensión.
fn servir_estatico(ruta: &str) -> Response {
    // Normalizo: "" o "/" -> index.html
    let ruta = ruta.trim_start_matches('/');
    let ruta = if ruta.is_empty() { "index.html" } else { ruta };

    match Frontend::get(ruta) {
        Some(archivo) => {
            let mime = mime_guess::from_path(ruta).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(archivo.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "404 — no encontrado").into_response(),
    }
}

/// Handler de la raíz "/" -> index.html
async fn raiz() -> Response {
    servir_estatico("index.html")
}

/// Handler para cualquier otra ruta estática (styles/, scripts/, assets/…)
async fn estatico(Path(ruta): Path<String>) -> Response {
    servir_estatico(&ruta)
}

fn construir_router(estado: api::AppState) -> Router {
    Router::new()
        // --- Autenticación ---
        .route("/api/login", post(api::login))
        .route("/api/logout", post(api::logout))
        // --- Productos ---
        .route("/api/productos", get(api::productos_get).post(api::productos_post))
        // --- Ventas (POS) ---
        .route("/api/ventas", get(api::ventas_get).post(api::ventas_post))
        // --- Promociones ---
        .route("/api/promociones", get(api::promociones_get).post(api::promociones_post))
        // --- Frontend incrustado ---
        .route("/", get(raiz))
        .route("/{*ruta}", get(estatico))
        .with_state(estado)
}

fn main() {
    // Carpeta de datos de la app (donde vive ogcontrol.db). Usamos el
    // directorio de datos del sistema operativo para que, una vez
    // instalado el .exe, la BD persista en un lugar estable del usuario
    // y no se pierda al mover el ejecutable.
    let dir_datos = directorio_datos();
    std::fs::create_dir_all(&dir_datos).ok();

    // Abrimos la BD (crea esquema + semilla si es la primera vez).
    let conn: Connection = db::abrir(&dir_datos);

    let estado = api::AppState {
        conn: Arc::new(Mutex::new(conn)),
        sesion: Arc::new(auth::Sesion::new()),
        dir_datos: dir_datos.clone(),
    };

    // Arrancamos el servidor Axum en un hilo de Tokio aparte, para que
    // no bloquee el hilo principal (que lo necesita Tauri para la GUI).
    let estado_servidor = estado.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("No se pudo crear el runtime Tokio");
        rt.block_on(async move {
            let app = construir_router(estado_servidor);
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], PUERTO));
            let listener = tokio::net::TcpListener::bind(addr)
                .await
                .expect("No se pudo abrir el puerto local");
            axum::serve(listener, app).await.expect("El servidor local falló");
        });
    });

    // Le damos un instante al servidor para que abra el puerto antes de
    // que la ventana intente cargar la URL.
    std::thread::sleep(std::time::Duration::from_millis(400));

    // Lanzamos Tauri. La ventana carga http://127.0.0.1:PUERTO, que es
    // nuestro servidor local sirviendo el frontend incrustado.
    tauri::Builder::default()
        .setup(move |app| {
            use tauri::Manager;
            let win = app.get_webview_window("main").unwrap();
            let url = format!("http://127.0.0.1:{}/", PUERTO);
            win.eval(&format!("window.location.replace('{}')", url)).ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error al ejecutar la aplicación Tauri");
}

/// Devuelve la carpeta donde guardar la BD. Intenta el dir de datos del
/// sistema (%APPDATA%\OGControl en Windows); si no, cae a ./datos.
fn directorio_datos() -> std::path::PathBuf {
    // En Windows, APPDATA apunta a C:\Users\<user>\AppData\Roaming
    if let Ok(appdata) = std::env::var("APPDATA") {
        return std::path::PathBuf::from(appdata).join("OGControl");
    }
    // Linux/macOS de respaldo (para dev): ~/.local/share/OGControl
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("OGControl");
    }
    // Último recurso: junto al ejecutable.
    std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("datos")
}
