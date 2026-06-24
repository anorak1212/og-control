// =====================================================
// db.rs  — equivalente a sites/db.php
// Conexión a SQLite + utilidades compartidas:
//   - creación del esquema (lo que antes hacía db/init.sql)
//   - normalización de texto y generación de SKU
// SQLite reemplaza a PostgreSQL: una sola BD en un archivo
// local, sin servidor, ideal para que la app corra offline.
// =====================================================

use rusqlite::Connection;
use std::path::PathBuf;

/// Devuelve la ruta del archivo de base de datos junto al ejecutable
/// (en producción) o en la carpeta de datos de la app. Aquí lo
/// resolvemos relativo a un directorio de datos que nos pasa main.rs.
pub fn ruta_db(dir_datos: &PathBuf) -> PathBuf {
    dir_datos.join("ogcontrol.db")
}

/// Abre (o crea) la conexión y asegura el esquema + datos semilla.
/// Esto sustituye por completo a docker-compose + init.sql.
pub fn abrir(dir_datos: &PathBuf) -> Connection {
    let ruta = ruta_db(dir_datos);
    let conn = Connection::open(&ruta).expect("No se pudo abrir la base de datos SQLite");

    // Claves foráneas ON (en SQLite vienen apagadas por defecto).
    conn.execute_batch("PRAGMA foreign_keys = ON;").ok();

    crear_esquema(&conn);
    sembrar_si_vacio(&conn);
    conn
}

/// Crea las tablas si no existen. Es la traducción de db/init.sql al
/// dialecto de SQLite (SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT,
/// NUMERIC -> REAL, BOOLEAN -> INTEGER 0/1, now() -> CURRENT_TIMESTAMP).
fn crear_esquema(conn: &Connection) {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS productos (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre          TEXT    NOT NULL,
            categoria       TEXT    NOT NULL,
            sku             TEXT    NOT NULL UNIQUE,
            precio          REAL    NOT NULL DEFAULT 0,
            stock           INTEGER NOT NULL DEFAULT 0,
            imagen          TEXT    DEFAULT NULL,
            activo          INTEGER NOT NULL DEFAULT 1,
            creado_en       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            actualizado_en  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS historial_nombres (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre      TEXT NOT NULL,
            categoria   TEXT NOT NULL,
            usado_en    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ventas (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            folio       TEXT NOT NULL UNIQUE,
            total       REAL NOT NULL DEFAULT 0,
            creado_en   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS venta_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            venta_id    INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
            producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
            nombre      TEXT NOT NULL,
            cantidad    INTEGER NOT NULL,
            precio      REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS promociones (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre       TEXT NOT NULL,
            tipo         TEXT NOT NULL,
            producto_id  INTEGER REFERENCES productos(id) ON DELETE CASCADE,
            valor        REAL DEFAULT NULL,
            lleva        INTEGER DEFAULT NULL,
            paga         INTEGER DEFAULT NULL,
            activa       INTEGER NOT NULL DEFAULT 1,
            creada_en    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Tabla auxiliar para emular la secuencia de folios de Postgres
        -- (folio_ventas_seq). Guardamos el último valor entregado; nextval
        -- = incrementar y devolver. Nunca retrocede aunque se limpie ventas.
        CREATE TABLE IF NOT EXISTS folio_seq (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            valor   INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO folio_seq (id, valor) VALUES (1, 0);

        CREATE INDEX IF NOT EXISTS idx_productos_nombre ON productos (nombre);
        CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos (activo);
        CREATE INDEX IF NOT EXISTS idx_historial_nombre ON historial_nombres (nombre);
        CREATE INDEX IF NOT EXISTS idx_promociones_activa ON promociones (activa);
        "#,
    )
    .expect("No se pudo crear el esquema");
}

/// Carga el catálogo de ejemplo solo si la tabla está vacía
/// (equivalente a los INSERT semilla de init.sql, que usaban
/// ON CONFLICT DO NOTHING).
fn sembrar_si_vacio(conn: &Connection) {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM productos", [], |r| r.get(0))
        .unwrap_or(0);
    if total > 0 {
        return;
    }

    let semilla = [
        ("Proteína Whey Vainilla 2lb", "Suplementos", "SUP-PROWHE-001", 549.00, 18, "https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400&q=80"),
        ("Creatina Monohidratada 300g", "Suplementos", "SUP-CRE-001", 389.00, 4, "https://images.unsplash.com/photo-1579722820308-d74e571900a9?w=400&q=80"),
        ("Guantes de Entrenamiento", "Accesorios", "ACC-GUA-001", 259.00, 23, "https://images.unsplash.com/photo-1583473848882-f9a5bc7fd2ee?w=400&q=80"),
        ("Cinturón de Levantamiento", "Accesorios", "ACC-CIN-001", 699.00, 7, "https://images.unsplash.com/photo-1517344884509-a0c97ec11bcc?w=400&q=80"),
        ("Shaker OG 700ml", "Botellas", "BOT-SHA-001", 149.00, 40, "https://images.unsplash.com/photo-1626197031507-c17099753214?w=400&q=80"),
        ("Playera OG Stencil", "Ropa", "ROP-PLA-001", 329.00, 2, "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80"),
        ("Bandas de Resistencia (set)", "Accesorios", "ACC-BAN-001", 219.00, 15, "https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=400&q=80"),
        ("Pre-Entreno Citrus 300g", "Suplementos", "SUP-PREENT-001", 459.00, 9, "https://images.unsplash.com/photo-1546483875-ad9014c88eba?w=400&q=80"),
    ];

    for (nombre, categoria, sku, precio, stock, imagen) in semilla {
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
    }
}

// ---------------------------------------------------
// Generación de SKU — porta og_normalizar / og_slug_nombre /
// og_prefijo_categoria / og_generar_sku de db.php tal cual.
// ---------------------------------------------------

/// Quita acentos y caracteres no alfabéticos, deja MAYÚSCULAS.
pub fn normalizar(texto: &str) -> String {
    let mut s = String::with_capacity(texto.len());
    for c in texto.chars() {
        let r = match c {
            'á' | 'Á' => 'a',
            'é' | 'É' => 'e',
            'í' | 'Í' => 'i',
            'ó' | 'Ó' => 'o',
            'ú' | 'Ú' => 'u',
            'ñ' | 'Ñ' => 'n',
            otro => otro,
        };
        // Solo letras A-Z/a-z; el resto se vuelve espacio.
        if r.is_ascii_alphabetic() {
            s.push(r);
        } else {
            s.push(' ');
        }
    }
    s.trim().to_uppercase()
}

const STOPWORDS: [&str; 12] = [
    "DE", "DEL", "LA", "EL", "LOS", "LAS", "Y", "CON", "PARA", "EN", "UN", "UNA",
];

/// Construye el "slug" base del SKU a partir del nombre del producto.
pub fn slug_nombre(nombre: &str) -> String {
    let norm = normalizar(nombre);
    let palabras: Vec<&str> = norm
        .split_whitespace()
        .filter(|p| p.chars().count() > 1 && !STOPWORDS.contains(p))
        .collect();

    if palabras.is_empty() {
        return "PRD".to_string();
    }
    if palabras.len() == 1 {
        return tomar(palabras[0], 6);
    }
    format!("{}{}", tomar(palabras[0], 3), tomar(palabras[1], 3))
}

/// Prefijo de 3 letras para la categoría.
pub fn prefijo_categoria(categoria: &str) -> String {
    let norm = normalizar(categoria);
    let base = if norm.is_empty() { "GEN" } else { &norm };
    tomar(base, 3)
}

/// substr seguro por caracteres (no por bytes), para no romper UTF-8.
fn tomar(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Genera el siguiente SKU disponible para nombre + categoría.
/// Fuente de verdad del SKU, igual que og_generar_sku en PHP.
pub fn generar_sku(
    conn: &Connection,
    nombre: &str,
    categoria: &str,
    ignorar_id: Option<i64>,
) -> String {
    let prefijo = prefijo_categoria(categoria);
    let slug = slug_nombre(nombre);
    let base = format!("{}-{}", prefijo, slug);
    let patron = format!("{}-%", base);

    let sql = if ignorar_id.is_some() {
        "SELECT sku FROM productos WHERE sku LIKE ?1 AND id <> ?2"
    } else {
        "SELECT sku FROM productos WHERE sku LIKE ?1"
    };

    let mut stmt = conn.prepare(sql).unwrap();
    let filas = if let Some(id) = ignorar_id {
        stmt.query_map(rusqlite::params![patron, id], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect::<Vec<String>>()
    } else {
        stmt.query_map(rusqlite::params![patron], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect::<Vec<String>>()
    };

    // Busca el secuencial más alto entre los SKU existentes (-NNN al final).
    let mut max_seq = 0u32;
    for sku in &filas {
        if let Some(pos) = sku.rfind('-') {
            let cola = &sku[pos + 1..];
            if cola.len() >= 3 && cola.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(n) = cola.parse::<u32>() {
                    if n > max_seq {
                        max_seq = n;
                    }
                }
            }
        }
    }

    format!("{}-{:03}", base, max_seq + 1)
}
