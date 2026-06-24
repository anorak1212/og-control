// =====================================================
// api.rs — porta los tres endpoints de sites/:
//   api_productos.php, api_ventas.php, api_promociones.php
//
// Cada handler de Axum equivale a un `case` del switch de PHP.
// Las respuestas conservan la MISMA forma JSON que el front ya
// espera ({ ok: true, productos: [...] }, etc.), así que el
// JavaScript no necesita cambios.
// =====================================================

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::IntoResponse,
    Json,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::auth::Sesion;
use crate::db;

/// Estado compartido: la conexión SQLite (protegida por Mutex porque
/// rusqlite no es Sync) y la sesión. Axum lo inyecta en cada handler.
#[derive(Clone)]
pub struct AppState {
    pub conn: Arc<Mutex<Connection>>,
    pub sesion: Arc<Sesion>,
    // Carpeta de datos de la app. Hoy la BD ya guarda las imágenes como
    // base64, así que esto no se usa directamente, pero queda reservado
    // para funciones futuras (ej. exportar backups del .db).
    #[allow(dead_code)]
    pub dir_datos: std::path::PathBuf,
}

// ---------- helpers de respuesta y de auth ----------

/// Respuesta de error JSON con código HTTP, equivalente a
/// og_json(['ok'=>false,...], status).
fn err(status: u16, msg: &str) -> axum::response::Response {
    let code = axum::http::StatusCode::from_u16(status).unwrap();
    (code, Json(json!({ "ok": false, "error": msg }))).into_response()
}

/// Equivale a og_exigir_api(): si el token del header no es válido,
/// responde 401 y corta. Devuelve Err con la respuesta lista.
fn exigir_api(state: &AppState, headers: &HeaderMap) -> Result<(), axum::response::Response> {
    let token = headers
        .get("x-og-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if state.sesion.token_valido(token) {
        Ok(())
    } else {
        Err(err(401, "No autorizado. Inicia sesión."))
    }
}

// =====================================================
// AUTENTICACIÓN  (login / logout)
// =====================================================

#[derive(Deserialize)]
pub struct LoginBody {
    pub usuario: String,
    pub password: String,
}

/// POST /api/login  -> { ok, token }
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> impl IntoResponse {
    match state.sesion.intentar_login(&body.usuario, &body.password) {
        Some(token) => Json(json!({ "ok": true, "token": token })).into_response(),
        None => err(401, "Usuario o contraseña incorrectos."),
    }
}

/// POST /api/logout
pub async fn logout(State(state): State<AppState>) -> impl IntoResponse {
    state.sesion.logout();
    Json(json!({ "ok": true })).into_response()
}

// =====================================================
// PRODUCTOS  (api_productos.php)
// =====================================================

#[derive(Serialize)]
struct Producto {
    id: i64,
    nombre: String,
    categoria: String,
    sku: String,
    precio: f64,
    stock: i64,
    imagen: Option<String>,
    activo: bool,
    creado_en: String,
    actualizado_en: String,
}

fn fila_a_producto(row: &rusqlite::Row) -> rusqlite::Result<Producto> {
    Ok(Producto {
        id: row.get("id")?,
        nombre: row.get("nombre")?,
        categoria: row.get("categoria")?,
        sku: row.get("sku")?,
        precio: row.get("precio")?,
        stock: row.get("stock")?,
        imagen: row.get("imagen")?,
        activo: row.get::<_, i64>("activo")? != 0,
        creado_en: row.get("creado_en")?,
        actualizado_en: row.get("actualizado_en")?,
    })
}

#[derive(Deserialize)]
pub struct ProductosQuery {
    accion: Option<String>,
    q: Option<String>,
    nombre: Option<String>,
    categoria: Option<String>,
    id: Option<i64>,
}

/// GET /api/productos?accion=...
pub async fn productos_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ProductosQuery>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let conn = state.conn.lock().unwrap();
    let accion = q.accion.as_deref().unwrap_or("listar");

    match accion {
        // case 'listar'
        "listar" => {
            let mut stmt = conn
                .prepare("SELECT * FROM productos WHERE activo = 1 ORDER BY creado_en DESC, id DESC")
                .unwrap();
            let lista: Vec<Producto> = stmt
                .query_map([], fila_a_producto)
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();
            Json(json!({ "ok": true, "productos": lista })).into_response()
        }

        // case 'sugerencias'
        "sugerencias" => {
            let texto = q.q.unwrap_or_default();
            let texto = texto.trim();
            if texto.is_empty() {
                return Json(json!({ "ok": true, "sugerencias": [] })).into_response();
            }
            let patron = format!("%{}%", texto);
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT nombre, categoria FROM historial_nombres
                     WHERE nombre LIKE ?1 COLLATE NOCASE
                     ORDER BY nombre ASC LIMIT 8",
                )
                .unwrap();
            let sug: Vec<Value> = stmt
                .query_map(rusqlite::params![patron], |r| {
                    Ok(json!({
                        "nombre": r.get::<_, String>(0)?,
                        "categoria": r.get::<_, String>(1)?
                    }))
                })
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();
            Json(json!({ "ok": true, "sugerencias": sug })).into_response()
        }

        // case 'sku'  (previsualización)
        "sku" => {
            let nombre = q.nombre.unwrap_or_default();
            let categoria = q.categoria.unwrap_or_default();
            if nombre.trim().is_empty() || categoria.trim().is_empty() {
                return Json(json!({ "ok": true, "sku": "" })).into_response();
            }
            let sku = db::generar_sku(&conn, nombre.trim(), categoria.trim(), q.id);
            Json(json!({ "ok": true, "sku": sku })).into_response()
        }

        _ => err(400, "Acción no reconocida."),
    }
}

/// Cuerpo para crear/actualizar/eliminar producto. El front antes
/// mandaba FormData (porque subía archivos); aquí lo recibimos como
/// JSON. La imagen se maneja por URL o por una ruta ya copiada por el
/// front. (La subida de archivos binarios se resuelve en el front con
/// un input file -> dataURL/URL; ver nota en el JS.)
#[derive(Deserialize)]
pub struct ProductoBody {
    accion: String,
    id: Option<i64>,
    nombre: Option<String>,
    categoria: Option<String>,
    precio: Option<f64>,
    stock: Option<i64>,
    imagen_actual: Option<String>,
    imagen_url: Option<String>,
}

/// POST /api/productos
pub async fn productos_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProductoBody>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let conn = state.conn.lock().unwrap();

    match body.accion.as_str() {
        // case 'eliminar'  (borrado lógico)
        "eliminar" => {
            let id = body.id.unwrap_or(0);
            if id == 0 {
                return err(422, "Falta el id.");
            }
            conn.execute(
                "UPDATE productos SET activo = 0, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?1",
                rusqlite::params![id],
            )
            .ok();
            Json(json!({ "ok": true })).into_response()
        }

        // case 'crear' / 'actualizar'
        accion @ ("crear" | "actualizar") => {
            let nombre = body.nombre.unwrap_or_default().trim().to_string();
            let categoria = body.categoria.unwrap_or_default().trim().to_string();
            let precio = body.precio.unwrap_or(0.0);
            let stock = body.stock.unwrap_or(0);
            let id = body.id;

            if nombre.is_empty() || categoria.is_empty() {
                return err(422, "Nombre y categoría son obligatorios.");
            }

            // SKU: si al actualizar no cambió nombre ni categoría, se
            // conserva el actual; si no, se regenera. Igual que en PHP.
            let mut sku: Option<String> = None;
            if accion == "actualizar" {
                if let Some(id_val) = id {
                    let actual: Option<(String, String, String)> = conn
                        .query_row(
                            "SELECT nombre, categoria, sku FROM productos WHERE id = ?1",
                            rusqlite::params![id_val],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )
                        .ok();
                    if let Some((n, c, s)) = actual {
                        if n == nombre && c == categoria {
                            sku = Some(s);
                        }
                    }
                }
            }
            let sku = sku.unwrap_or_else(|| db::generar_sku(&conn, &nombre, &categoria, id));

            // Imagen: prioridad (1) URL pegada o archivo subido como
            // data URL base64, (2) la actual. El front convierte el
            // archivo a 'data:...' y las URLs externas siguen siendo
            // http/https. Las tres formas son texto y se guardan igual.
            let mut imagen: Option<String> = body.imagen_actual.clone();
            if let Some(url) = &body.imagen_url {
                let url = url.trim();
                if url.starts_with("http://")
                    || url.starts_with("https://")
                    || url.starts_with("data:image/")
                {
                    imagen = Some(url.to_string());
                }
            }

            if accion == "crear" {
                conn.execute(
                    "INSERT INTO productos (nombre, categoria, sku, precio, stock, imagen)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![nombre, categoria, sku, precio, stock, imagen],
                )
                .ok();
                conn.execute(
                    "INSERT INTO historial_nombres (nombre, categoria) VALUES (?1, ?2)",
                    rusqlite::params![nombre, categoria],
                )
                .ok();
                let nuevo_id = conn.last_insert_rowid();
                let prod = conn
                    .query_row(
                        "SELECT * FROM productos WHERE id = ?1",
                        rusqlite::params![nuevo_id],
                        fila_a_producto,
                    )
                    .ok();
                Json(json!({ "ok": true, "producto": prod })).into_response()
            } else {
                let id_val = match id {
                    Some(v) => v,
                    None => return err(422, "Falta el id del producto a actualizar."),
                };
                conn.execute(
                    "UPDATE productos SET nombre=?1, categoria=?2, sku=?3,
                       precio=?4, stock=?5, imagen=?6, actualizado_en=CURRENT_TIMESTAMP
                     WHERE id=?7",
                    rusqlite::params![nombre, categoria, sku, precio, stock, imagen, id_val],
                )
                .ok();
                let prod = conn
                    .query_row(
                        "SELECT * FROM productos WHERE id = ?1",
                        rusqlite::params![id_val],
                        fila_a_producto,
                    )
                    .ok();
                Json(json!({ "ok": true, "producto": prod })).into_response()
            }
        }

        _ => err(400, "Acción no reconocida."),
    }
}

// =====================================================
// VENTAS  (api_ventas.php) — el POS con transacción y stock
// =====================================================

#[derive(Deserialize)]
pub struct VentasQuery {
    accion: Option<String>,
}

/// GET /api/ventas?accion=listar|csv
pub async fn ventas_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<VentasQuery>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let conn = state.conn.lock().unwrap();
    let accion = q.accion.as_deref().unwrap_or("listar");

    match accion {
        "listar" => {
            // Ventas + sus items, agrupados (como hacía PHP con $porVenta).
            let mut stmt_v = conn
                .prepare("SELECT id, folio, total, creado_en FROM ventas ORDER BY creado_en DESC, id DESC")
                .unwrap();
            let ventas: Vec<(i64, String, f64, String)> = stmt_v
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();

            let mut stmt_i = conn
                .prepare("SELECT id, venta_id, producto_id, nombre, cantidad, precio FROM venta_items ORDER BY id ASC")
                .unwrap();
            let mut por_venta: HashMap<i64, Vec<Value>> = HashMap::new();
            let items = stmt_i
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,           // id
                        r.get::<_, i64>(1)?,           // venta_id
                        r.get::<_, Option<i64>>(2)?,   // producto_id
                        r.get::<_, String>(3)?,        // nombre
                        r.get::<_, i64>(4)?,           // cantidad
                        r.get::<_, f64>(5)?,           // precio
                    ))
                })
                .unwrap();
            for it in items.filter_map(|x| x.ok()) {
                por_venta.entry(it.1).or_default().push(json!({
                    "id": it.0, "venta_id": it.1, "producto_id": it.2,
                    "nombre": it.3, "cantidad": it.4, "precio": it.5
                }));
            }

            let salida: Vec<Value> = ventas
                .into_iter()
                .map(|(id, folio, total, creado)| {
                    json!({
                        "id": id, "folio": folio, "total": total, "creado_en": creado,
                        "items": por_venta.remove(&id).unwrap_or_default()
                    })
                })
                .collect();

            Json(json!({ "ok": true, "ventas": salida })).into_response()
        }

        // Exportar CSV — devuelve el archivo, no JSON (como en PHP).
        "csv" => {
            let mut stmt = conn
                .prepare("SELECT folio, creado_en, total FROM ventas ORDER BY creado_en DESC, id DESC")
                .unwrap();
            let filas: Vec<(String, String, f64)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect();

            // BOM para que Excel reconozca acentos, igual que en PHP.
            let mut csv = String::from("\u{FEFF}");
            csv.push_str("Folio,Fecha,Total (MXN)\n");
            for (folio, fecha, total) in filas {
                csv.push_str(&format!("{},{},{:.2}\n", folio, fecha, total));
            }

            (
                [
                    (axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        "attachment; filename=\"ventas_og_control.csv\"",
                    ),
                ],
                csv,
            )
                .into_response()
        }

        _ => err(400, "Acción no reconocida."),
    }
}

#[derive(Deserialize)]
pub struct VentaItem {
    id: i64,
    cantidad: Option<i64>,
}

#[derive(Deserialize)]
pub struct VentaBody {
    accion: String,
    #[serde(default)]
    items: Vec<VentaItem>,
}

/// Representa una promoción cargada de la BD para aplicarla al cobrar.
struct Promo {
    nombre: String,
    tipo: String,
    producto_id: Option<i64>,
    valor: Option<f64>,
    lleva: Option<i64>,
    paga: Option<i64>,
}

/// POST /api/ventas  (crear venta / limpiar historial)
pub async fn ventas_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<VentaBody>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let mut conn = state.conn.lock().unwrap();

    match body.accion.as_str() {
        // case 'limpiar'
        "limpiar" => {
            conn.execute_batch(
                "DELETE FROM venta_items; DELETE FROM ventas;
                 DELETE FROM sqlite_sequence WHERE name IN ('ventas','venta_items');",
            )
            .ok();
            return Json(json!({ "ok": true })).into_response();
        }

        // case 'crear' — el cobro real, dentro de una transacción.
        "crear" => {}
        _ => return err(400, "Acción no reconocida."),
    }

    if body.items.is_empty() {
        return err(422, "El ticket está vacío.");
    }

    // === transacción: o se guarda todo, o nada (como beginTransaction
    // / commit / rollBack en PHP). SQLite serializa el acceso, lo que
    // nos da el mismo efecto que el FOR UPDATE de Postgres: dos cobros
    // no tocan el stock al mismo tiempo. ===
    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(_) => return err(422, "No se pudo iniciar la transacción."),
    };

    let resultado = (|| -> Result<Value, String> {
        // Cargo promociones activas una sola vez, indexadas por producto.
        let mut promos_producto: HashMap<i64, Promo> = HashMap::new();
        let mut promo_venta: Option<Promo> = None;
        {
            let mut stmt = tx
                .prepare("SELECT nombre, tipo, producto_id, valor, lleva, paga FROM promociones WHERE activa = 1 ORDER BY creada_en ASC, id ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(Promo {
                        nombre: r.get(0)?,
                        tipo: r.get(1)?,
                        producto_id: r.get(2)?,
                        valor: r.get(3)?,
                        lleva: r.get(4)?,
                        paga: r.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for p in rows.filter_map(|x| x.ok()) {
                if p.tipo == "pct_venta" {
                    if promo_venta.is_none() {
                        promo_venta = Some(p);
                    }
                } else if let Some(pid) = p.producto_id {
                    promos_producto.entry(pid).or_insert(p);
                }
            }
        }

        let mut total: f64 = 0.0;
        let mut detalle: Vec<Value> = Vec::new();

        for it in &body.items {
            let cant = it.cantidad.unwrap_or(1).max(1);
            let id_prod = it.id;

            // Leo el producto (en Postgres era SELECT ... FOR UPDATE).
            let prod: Option<(i64, String, f64, i64, i64)> = tx
                .query_row(
                    "SELECT id, nombre, precio, stock, activo FROM productos WHERE id = ?1",
                    rusqlite::params![id_prod],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .ok();

            let (pid, pnombre, precio_unit, pstock, pactivo) = match prod {
                Some(v) => v,
                None => return Err("Un producto del ticket ya no existe.".into()),
            };
            if pactivo == 0 {
                return Err(format!("\"{}\" ya no está disponible.", pnombre));
            }
            if pstock < cant {
                return Err(format!("Stock insuficiente para \"{}\".", pnombre));
            }

            let mut subtotal = precio_unit * cant as f64;
            let mut promo_aplicada: Option<String> = None;

            // ¿Promo activa para este producto? Ajusto su subtotal.
            if let Some(pr) = promos_producto.get(&pid) {
                promo_aplicada = Some(pr.nombre.clone());
                match pr.tipo.as_str() {
                    "pct_producto" => {
                        let v = pr.valor.unwrap_or(0.0);
                        subtotal *= 1.0 - (v / 100.0);
                    }
                    "precio_fijo" => {
                        subtotal = pr.valor.unwrap_or(0.0) * cant as f64;
                    }
                    "nx" => {
                        // Lleva N paga M.
                        let lleva = pr.lleva.unwrap_or(1).max(1);
                        let paga = pr.paga.unwrap_or(1);
                        let grupos = cant / lleva;
                        let resto = cant % lleva;
                        let unidades_cobradas = grupos * paga + resto;
                        subtotal = precio_unit * unidades_cobradas as f64;
                    }
                    _ => {}
                }
            }

            total += subtotal;

            detalle.push(json!({
                "producto_id": pid,
                "nombre": pnombre,
                "cantidad": cant,
                "precio": precio_unit,
                "promo": promo_aplicada
            }));

            // Descuento stock.
            tx.execute(
                "UPDATE productos SET stock = stock - ?1 WHERE id = ?2",
                rusqlite::params![cant, pid],
            )
            .map_err(|e| e.to_string())?;
        }

        // Promo sobre toda la venta (si hay), al final.
        let mut descuento_venta: Option<String> = None;
        if let Some(pv) = &promo_venta {
            let v = pv.valor.unwrap_or(0.0);
            total *= 1.0 - (v / 100.0);
            descuento_venta = Some(pv.nombre.clone());
        }
        // Redondeo a 2 decimales, como round($total,2) en PHP.
        let total = (total * 100.0).round() / 100.0;

        // Folio desde la "secuencia" (tabla folio_seq): incrementar y
        // devolver. Nunca repite aunque se limpie el historial.
        tx.execute("UPDATE folio_seq SET valor = valor + 1 WHERE id = 1", [])
            .map_err(|e| e.to_string())?;
        let folio_num: i64 = tx
            .query_row("SELECT valor FROM folio_seq WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let folio = format!("V-{:04}", folio_num);

        // Inserto la venta y sus items.
        tx.execute(
            "INSERT INTO ventas (folio, total) VALUES (?1, ?2)",
            rusqlite::params![folio, total],
        )
        .map_err(|e| e.to_string())?;
        let venta_id = tx.last_insert_rowid();

        for d in &detalle {
            tx.execute(
                "INSERT INTO venta_items (venta_id, producto_id, nombre, cantidad, precio)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    venta_id,
                    d["producto_id"].as_i64(),
                    d["nombre"].as_str().unwrap_or(""),
                    d["cantidad"].as_i64().unwrap_or(1),
                    d["precio"].as_f64().unwrap_or(0.0)
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(json!({
            "id": venta_id,
            "folio": folio,
            "total": total,
            "items": detalle,
            "descuento_venta": descuento_venta
        }))
    })();

    match resultado {
        Ok(venta) => {
            tx.commit().ok();
            Json(json!({ "ok": true, "venta": venta })).into_response()
        }
        Err(msg) => {
            // El rollback es implícito al soltar `tx` sin commit, pero
            // lo hacemos explícito para que quede claro.
            tx.rollback().ok();
            err(422, &msg)
        }
    }
}

// =====================================================
// PROMOCIONES  (api_promociones.php)
// =====================================================

const TIPOS_VALIDOS: [&str; 4] = ["pct_producto", "pct_venta", "precio_fijo", "nx"];

#[derive(Deserialize)]
pub struct PromoQuery {
    accion: Option<String>,
}

/// GET /api/promociones?accion=listar
pub async fn promociones_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PromoQuery>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let conn = state.conn.lock().unwrap();
    let accion = q.accion.as_deref().unwrap_or("listar");

    if accion != "listar" {
        return err(400, "Acción no reconocida.");
    }

    let mut stmt = conn
        .prepare(
            "SELECT pr.id, pr.nombre, pr.tipo, pr.producto_id, pr.valor, pr.lleva,
                    pr.paga, pr.activa, pr.creada_en, p.nombre AS producto_nombre
             FROM promociones pr
             LEFT JOIN productos p ON p.id = pr.producto_id
             ORDER BY pr.creada_en DESC, pr.id DESC",
        )
        .unwrap();
    let lista: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "nombre": r.get::<_, String>(1)?,
                "tipo": r.get::<_, String>(2)?,
                "producto_id": r.get::<_, Option<i64>>(3)?,
                "valor": r.get::<_, Option<f64>>(4)?,
                "lleva": r.get::<_, Option<i64>>(5)?,
                "paga": r.get::<_, Option<i64>>(6)?,
                "activa": r.get::<_, i64>(7)? != 0,
                "creada_en": r.get::<_, String>(8)?,
                "producto_nombre": r.get::<_, Option<String>>(9)?
            }))
        })
        .unwrap()
        .filter_map(|x| x.ok())
        .collect();

    Json(json!({ "ok": true, "promociones": lista })).into_response()
}

#[derive(Deserialize)]
pub struct PromoBody {
    accion: String,
    id: Option<i64>,
    nombre: Option<String>,
    tipo: Option<String>,
    producto_id: Option<i64>,
    valor: Option<f64>,
    lleva: Option<i64>,
    paga: Option<i64>,
}

/// POST /api/promociones  (crear/actualizar/toggle/eliminar)
pub async fn promociones_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PromoBody>,
) -> axum::response::Response {
    if let Err(r) = exigir_api(&state, &headers) {
        return r;
    }
    let conn = state.conn.lock().unwrap();

    match body.accion.as_str() {
        // case 'toggle'
        "toggle" => {
            let id = body.id.unwrap_or(0);
            if id == 0 {
                return err(422, "Falta el id.");
            }
            conn.execute(
                "UPDATE promociones SET activa = CASE activa WHEN 1 THEN 0 ELSE 1 END WHERE id = ?1",
                rusqlite::params![id],
            )
            .ok();
            Json(json!({ "ok": true })).into_response()
        }

        // case 'eliminar'
        "eliminar" => {
            let id = body.id.unwrap_or(0);
            if id == 0 {
                return err(422, "Falta el id.");
            }
            conn.execute("DELETE FROM promociones WHERE id = ?1", rusqlite::params![id])
                .ok();
            Json(json!({ "ok": true })).into_response()
        }

        // case 'crear' / 'actualizar'
        accion @ ("crear" | "actualizar") => {
            let nombre = body.nombre.unwrap_or_default().trim().to_string();
            let tipo = body.tipo.unwrap_or_default().trim().to_string();

            if nombre.is_empty() {
                return err(422, "La promoción necesita un nombre.");
            }
            if !TIPOS_VALIDOS.contains(&tipo.as_str()) {
                return err(422, "Tipo de promoción no válido.");
            }

            // Normalizo campos según el tipo: lo que no aplica queda NULL.
            let mut producto_id: Option<i64> = None;
            let mut valor: Option<f64> = None;
            let mut lleva: Option<i64> = None;
            let mut paga: Option<i64> = None;

            if tipo == "pct_venta" {
                let v = body.valor.unwrap_or(0.0);
                if v <= 0.0 || v > 100.0 {
                    return err(422, "El porcentaje debe estar entre 1 y 100.");
                }
                valor = Some(v);
            } else {
                let pid = body.producto_id.unwrap_or(0);
                if pid == 0 {
                    return err(422, "Elige el producto al que aplica la oferta.");
                }
                producto_id = Some(pid);

                match tipo.as_str() {
                    "pct_producto" => {
                        let v = body.valor.unwrap_or(0.0);
                        if v <= 0.0 || v > 100.0 {
                            return err(422, "El porcentaje debe estar entre 1 y 100.");
                        }
                        valor = Some(v);
                    }
                    "precio_fijo" => {
                        let v = body.valor.unwrap_or(0.0);
                        if v <= 0.0 {
                            return err(422, "El precio especial debe ser mayor a 0.");
                        }
                        valor = Some(v);
                    }
                    "nx" => {
                        let l = body.lleva.unwrap_or(0);
                        let p = body.paga.unwrap_or(0);
                        if l <= 0 || p <= 0 || p >= l {
                            return err(
                                422,
                                "En \"lleva N paga M\", N debe ser mayor que M (ej. lleva 2 paga 1).",
                            );
                        }
                        lleva = Some(l);
                        paga = Some(p);
                    }
                    _ => {}
                }
            }

            if accion == "crear" {
                conn.execute(
                    "INSERT INTO promociones (nombre, tipo, producto_id, valor, lleva, paga)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![nombre, tipo, producto_id, valor, lleva, paga],
                )
                .ok();
            } else {
                let id_val = match body.id {
                    Some(v) => v,
                    None => return err(422, "Falta el id de la promoción."),
                };
                conn.execute(
                    "UPDATE promociones SET nombre=?1, tipo=?2, producto_id=?3,
                       valor=?4, lleva=?5, paga=?6 WHERE id=?7",
                    rusqlite::params![nombre, tipo, producto_id, valor, lleva, paga, id_val],
                )
                .ok();
            }

            Json(json!({ "ok": true })).into_response()
        }

        _ => err(400, "Acción no reconocida."),
    }
}
