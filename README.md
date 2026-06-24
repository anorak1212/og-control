# OG Control — versión de escritorio (Tauri + Rust + SQLite)

Esta es la versión de escritorio de tu sistema de punto de venta e
inventario. Es la misma app de antes, pero ahora **corre como programa
nativo de Windows (.exe), sin Docker, sin PHP y sin servidor de base de
datos**. Funciona completamente **fuera de línea**.

---

## ¿Qué cambió respecto a la versión PHP? (resumen rápido)

| Antes (PHP)                  | Ahora (Tauri)                          |
|------------------------------|----------------------------------------|
| PHP 8.2 + Apache             | **Rust + Axum** (servidor local interno)|
| PostgreSQL en Docker         | **SQLite** (un archivo `.db`, local)   |
| Navegador → `localhost:8080` | **Ventana de escritorio nativa**       |
| Necesita Docker corriendo    | **Doble clic al .exe y listo**         |

La idea clave: dentro de la app corre un mini-servidor en Rust que
escucha en `127.0.0.1:4775` (solo tu propia máquina). Ese servidor
responde exactamente las mismas rutas que antes respondía PHP, así que
**el frontend (HTML/CSS/JS) es casi el mismo**. La base de datos pasó de
PostgreSQL a SQLite, que es perfecto para una app de un solo equipo.

**Lo "online" como plus:** las imágenes de productos que son una URL
(`https://...`) se cargan si hay internet. Si no hay, se ve el ícono
genérico. La app **no necesita internet para nada más**.

---

## Lo que necesitas instalar (una sola vez)

Para compilar en **Windows** hacen falta tres cosas:

### 1. Rust
Descarga e instala desde https://rustup.rs
(Baja `rustup-init.exe`, ábrelo, y dale a la opción por defecto `1`.)

Al terminar, **cierra y reabre la terminal** y verifica:
```
rustc --version
cargo --version
```

### 2. Node.js (para el CLI de Tauri)
Descarga la versión LTS desde https://nodejs.org
Verifica:
```
node --version
npm --version
```

### 3. Dependencias de compilación de Windows
Tauri necesita el **WebView2** (ya viene en Windows 10/11 modernos) y las
**herramientas de compilación de C++**. La forma más fácil:

- Instala **Microsoft C++ Build Tools** desde:
  https://visualstudio.microsoft.com/visual-cpp-build-tools/
  Al instalar, marca la carga de trabajo **"Desarrollo para el escritorio
  con C++"**.

(Esto es porque Rust en Windows usa el enlazador de MSVC.)

---

## PASO 1 — La prueba (modo desarrollo)

Esto compila y abre la app en una ventana, con recarga rápida. Es para
confirmar que todo jala antes de generar el instalador.

Abre una terminal **dentro de la carpeta del proyecto** (la que tiene el
`package.json`) y corre:

```
npm install
npm run tauri dev
```

La **primera vez tarda varios minutos** porque Rust descarga y compila
todas las dependencias (Axum, SQLite, Tauri…). Es normal. Las siguientes
veces es mucho más rápido.

Cuando termine, se abre la ventana de **OG Control** mostrando el login.

**Entra con:**
- Usuario: `admin`
- Contraseña: `ogadmin123`

Prueba que funcione: crea un producto, haz una venta en el POS, crea una
promoción 2x1, exporta el CSV. Todo debe comportarse igual que la versión
PHP. Los datos se guardan en SQLite automáticamente.

> **¿Dónde se guarda la base de datos?**
> En `C:\Users\<tu_usuario>\AppData\Roaming\OGControl\ogcontrol.db`
> Si quieres empezar de cero, cierra la app y borra ese archivo: al
> volver a abrir, se recrea con el catálogo de ejemplo.

---

## PASO 2 — Generar el .exe (instalador)

Cuando la prueba te funcione, genera el ejecutable final:

```
npm run tauri build
```

Esto tarda más que el `dev` porque compila en modo optimizado. Al
terminar, encontrarás el instalador aquí:

```
src-tauri\target\release\bundle\nsis\OG Control_1.0.0_x64-setup.exe
```

Ese **`.exe` es lo que compartes o instalas**. Al instalarlo:
- Crea el acceso directo de "OG Control".
- Se abre con doble clic, sin terminal, sin Docker, sin internet.
- El frontend va **incrustado dentro del binario** (por eso funciona
  aunque muevas el ejecutable de carpeta).

> Si solo quieres el ejecutable "suelto" (sin instalador), también queda
> compilado en `src-tauri\target\release\og-control.exe`, pero la forma
> recomendada de distribuir es el `-setup.exe` del instalador.

---

## Cambiar la contraseña de admin (importante para uso real)

Las credenciales están en `src-tauri/src/auth.rs`, arriba del todo:

```rust
const ADMIN_USER: &str = "admin";
const ADMIN_PASS: &str = "ogadmin123";
```

Cámbialas a lo que quieras y vuelve a compilar (`npm run tauri build`).

---

## Estructura del proyecto (para que sepas qué es qué)

```
og-control-tauri/
├── package.json              → scripts npm (dev / build) y CLI de Tauri
├── dist/                     → FRONTEND (se incrusta en el .exe)
│   ├── index.html            → panel principal (antes index.php)
│   ├── login.html            → pantalla de acceso (antes login.php)
│   ├── styles/style.css      → estilos (sin cambios)
│   ├── scripts/scripts.js    → lógica del front (adaptada: token + JSON)
│   └── assets/               → logo e imágenes de productos
└── src-tauri/                → BACKEND en Rust
    ├── Cargo.toml            → dependencias de Rust
    ├── tauri.conf.json       → config de la app y del instalador
    ├── icons/                → iconos del .exe
    └── src/
        ├── main.rs           → arranca el servidor local + la ventana
        ├── db.rs             → SQLite: esquema, semilla y generación de SKU
        ├── auth.rs           → login con sesión por token
        └── api.rs            → endpoints (productos, ventas, promociones)
```

Cada archivo `.rs` está comentado indicando a qué archivo PHP equivale,
por si necesitas comparar con la versión vieja.

---

## Solución de problemas comunes

- **"link.exe not found" / errores de enlazador al compilar:** falta el
  C++ Build Tools del paso 3. Instálalo y reabre la terminal.

- **La ventana abre en blanco:** asegúrate de tener **WebView2**. En
  Windows 10/11 actualizado ya viene; si no, instálalo desde el sitio de
  Microsoft (busca "WebView2 Runtime").

- **"port already in use" / no abre:** algo más está usando el puerto
  4775. Ciérralo, o cambia el número en `src-tauri/src/main.rs`
  (`const PUERTO`) y recompila.

- **Quiero reiniciar los datos:** cierra la app y borra
  `%APPDATA%\OGControl\ogcontrol.db`.
```
```
