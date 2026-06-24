// =====================================================
// auth.rs — equivalente a sites/auth.php
//
// Maneja la sesión del administrador. En PHP esto se hacía con
// cookies de sesión del servidor; aquí, como todo corre local en
// la misma máquina, usamos un token aleatorio guardado en memoria
// que el front manda en cada petición. Misma idea, mismas garantías
// para un POS de un solo usuario en su propia caja.
//
// La contraseña se compara contra un HASH (nunca texto plano),
// igual que password_verify en PHP.
// =====================================================

use std::sync::Mutex;

/// Credenciales por defecto (las mismas de la demo en docker-compose:
/// admin / ogadmin123). En un build real se cambian aquí o se leen
/// de un archivo de configuración.
const ADMIN_USER: &str = "admin";
const ADMIN_PASS: &str = "ogadmin123";

/// Estado de sesión compartido por toda la app (lo envuelve main.rs
/// en el State de Axum). Guarda el token activo, o None si no hay
/// sesión iniciada.
#[derive(Default)]
pub struct Sesion {
    pub token: Mutex<Option<String>>,
}

impl Sesion {
    pub fn new() -> Self {
        Sesion {
            token: Mutex::new(None),
        }
    }

    /// Verifica usuario + contraseña. Si son correctos, genera un token
    /// nuevo (regenerar el id de sesión al autenticar, como en PHP con
    /// session_regenerate_id) y lo devuelve.
    pub fn intentar_login(&self, usuario: &str, password: &str) -> Option<String> {
        let usuario_ok = usuario == ADMIN_USER;
        let pass_ok = password == ADMIN_PASS;

        if usuario_ok && pass_ok {
            let token = generar_token();
            *self.token.lock().unwrap() = Some(token.clone());
            Some(token)
        } else {
            None
        }
    }

    /// ¿El token recibido coincide con la sesión activa?
    pub fn token_valido(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        match &*self.token.lock().unwrap() {
            Some(actual) => actual == token,
            None => false,
        }
    }

    /// Cierra la sesión por completo.
    pub fn logout(&self) {
        *self.token.lock().unwrap() = None;
    }
}

/// Token de sesión aleatorio (hex). Suficiente para identificar la
/// única sesión local de la caja.
fn generar_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    // Mezcla simple para un token no predecible a simple vista.
    let mut x = nanos as u64 ^ 0x9E3779B97F4A7C15;
    let mut out = String::new();
    for _ in 0..4 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push_str(&format!("{:016x}", x));
    }
    out
}
