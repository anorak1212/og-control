/* =====================================================
   OG CONTROL — mock-data.js  (CAPA DEMO)
   -----------------------------------------------------
   Esta versión está pensada para correr SIN servidor PHP
   ni PostgreSQL (por ejemplo, publicada en Netlify).

   En lugar de tocar scripts.js, interceptamos window.fetch:
   cuando scripts.js llama a sites/api_*.php, aquí
   respondemos con los mismos datos y el mismo formato JSON
   que devolverían los endpoints reales. Toda la "base de
   datos" vive en memoria durante la sesión.

   Datos semilla = los mismos de db/init.sql.
   ===================================================== */
(function () {
  "use strict";

  /* ---------- "Base de datos" en memoria ---------- */
  const DB = {
    productos: [
      { id: 1, nombre: "Proteína Whey Vainilla 2lb", categoria: "Suplementos", sku: "SUP-PROWHE-001", precio: 549.00, stock: 18, imagen: "https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400&q=80", activo: true },
      { id: 2, nombre: "Creatina Monohidratada 300g", categoria: "Suplementos", sku: "SUP-CRE-001",    precio: 389.00, stock: 4,  imagen: "https://images.unsplash.com/photo-1579722820308-d74e571900a9?w=400&q=80", activo: true },
      { id: 3, nombre: "Guantes de Entrenamiento",    categoria: "Accesorios",  sku: "ACC-GUA-001",    precio: 259.00, stock: 23, imagen: "https://images.unsplash.com/photo-1583473848882-f9a5bc7fd2ee?w=400&q=80", activo: true },
      { id: 4, nombre: "Cinturón de Levantamiento",   categoria: "Accesorios",  sku: "ACC-CIN-001",    precio: 699.00, stock: 7,  imagen: "https://images.unsplash.com/photo-1517344884509-a0c97ec11bcc?w=400&q=80", activo: true },
      { id: 5, nombre: "Shaker OG 700ml",             categoria: "Botellas",    sku: "BOT-SHA-001",    precio: 149.00, stock: 40, imagen: "https://images.unsplash.com/photo-1626197031507-c17099753214?w=400&q=80", activo: true },
      { id: 6, nombre: "Playera OG Stencil",          categoria: "Ropa",        sku: "ROP-PLA-001",    precio: 329.00, stock: 2,  imagen: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80", activo: true },
      { id: 7, nombre: "Bandas de Resistencia (set)", categoria: "Accesorios",  sku: "ACC-BAN-001",    precio: 219.00, stock: 15, imagen: "https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=400&q=80", activo: true },
      { id: 8, nombre: "Pre-Entreno Citrus 300g",     categoria: "Suplementos", sku: "SUP-PREENT-001", precio: 459.00, stock: 9,  imagen: "https://images.unsplash.com/photo-1546483875-ad9014c88eba?w=400&q=80", activo: true },
    ],
    // Historial de nombres usados (para las sugerencias por similitud).
    historial: [
      { nombre: "Proteína Whey Vainilla 2lb", categoria: "Suplementos" },
      { nombre: "Creatina Monohidratada 300g", categoria: "Suplementos" },
      { nombre: "Guantes de Entrenamiento", categoria: "Accesorios" },
      { nombre: "Cinturón de Levantamiento", categoria: "Accesorios" },
      { nombre: "Shaker OG 700ml", categoria: "Botellas" },
      { nombre: "Playera OG Stencil", categoria: "Ropa" },
      { nombre: "Bandas de Resistencia (set)", categoria: "Accesorios" },
      { nombre: "Pre-Entreno Citrus 300g", categoria: "Suplementos" },
      { nombre: "Aminoácidos BCAA 250g", categoria: "Suplementos" },
      { nombre: "Toalla de Gym Microfibra", categoria: "Accesorios" },
    ],
    // Un par de promociones de ejemplo para que la pestaña no salga vacía.
    promociones: [
      { id: 1, nombre: "Martes de proteína", tipo: "pct_producto", producto_id: 1, valor: 15, lleva: null, paga: null, activa: true },
      { id: 2, nombre: "2x1 en Shakers", tipo: "nx", producto_id: 5, valor: null, lleva: 2, paga: 1, activa: true },
    ],
    ventas: [],   // historial de ventas de la sesión
    // Contadores tipo SERIAL / secuencia de PostgreSQL.
    seqProducto: 8,
    seqOferta: 2,
    seqVenta: 0,
    seqFolio: 0,
  };

  const PREFIJO_CAT = {
    "Suplementos": "SUP", "Accesorios": "ACC", "Botellas": "BOT", "Ropa": "ROP", "Equipo": "EQU",
  };

  /* ---------- Utilidades que imitan a db.php ---------- */

  // Quita acentos y deja solo A–Z 0–9 (igual que el generador de SKU del backend).
  function limpiar(txt) {
    return (txt || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // Genera un SKU único: PREFIJO-INICIALES-SECUENCIAL.
  function generarSku(nombre, categoria, idActual) {
    const prefijo = PREFIJO_CAT[categoria] || limpiar(categoria).slice(0, 3) || "GEN";
    const base = limpiar(nombre).slice(0, 6) || "PROD";
    // Busco el siguiente secuencial libre para ese prefijo+base.
    let n = 1, sku;
    do {
      sku = `${prefijo}-${base}-${String(n).padStart(3, "0")}`;
      n++;
    } while (DB.productos.some((p) => p.sku === sku && String(p.id) !== String(idActual)));
    return sku;
  }

  function similares(q) {
    const t = (q || "").toLowerCase();
    const vistos = new Set();
    return DB.historial
      .filter((h) => h.nombre.toLowerCase().includes(t))
      .filter((h) => { if (vistos.has(h.nombre)) return false; vistos.add(h.nombre); return true; })
      .slice(0, 6);
  }

  // Mapa de promos activas por producto.
  function promoDeProducto(pid) {
    return DB.promociones.find((o) => o.activa && Number(o.producto_id) === Number(pid)) || null;
  }
  function promoVentaActiva() {
    return DB.promociones.find((o) => o.activa && o.tipo === "pct_venta") || null;
  }

  // Calcula el total de una venta aplicando promociones (igual que el backend).
  function calcularVenta(items) {
    let total = 0;
    let descuentoVenta = null;
    const detalle = [];

    for (const it of items) {
      const p = DB.productos.find((x) => Number(x.id) === Number(it.id));
      if (!p) continue;
      const cant = Number(it.cantidad);
      let precioUnit = Number(p.precio);
      let subtotal = precioUnit * cant;

      const promo = promoDeProducto(p.id);
      if (promo) {
        if (promo.tipo === "pct_producto") {
          subtotal = subtotal * (1 - Number(promo.valor) / 100);
        } else if (promo.tipo === "precio_fijo") {
          precioUnit = Number(promo.valor);
          subtotal = precioUnit * cant;
        } else if (promo.tipo === "nx") {
          const lleva = Number(promo.lleva), paga = Number(promo.paga);
          if (lleva > 0) {
            const grupos = Math.floor(cant / lleva);
            const resto = cant % lleva;
            const unidadesCobradas = grupos * paga + resto;
            subtotal = precioUnit * unidadesCobradas;
          }
        }
      }
      total += subtotal;
      detalle.push({ producto_id: p.id, nombre: p.nombre, cantidad: cant, precio: precioUnit });
    }

    // Descuento sobre toda la venta (si hay una promo de ese tipo activa).
    const pv = promoVentaActiva();
    if (pv) {
      total = total * (1 - Number(pv.valor) / 100);
      descuentoVenta = pv.nombre;
    }

    return { total: Math.round(total * 100) / 100, detalle, descuentoVenta };
  }

  /* ---------- Generación de CSV (igual que api_ventas ?accion=csv) ---------- */
  function ventasACsv() {
    let filas = [["Folio", "Fecha", "Producto", "Cantidad", "Precio", "Subtotal", "Total venta"]];
    DB.ventas.forEach((v) => {
      v.items.forEach((i) => {
        filas.push([
          v.folio, v.creado_en, i.nombre, i.cantidad,
          Number(i.precio).toFixed(2), (Number(i.precio) * Number(i.cantidad)).toFixed(2),
          Number(v.total).toFixed(2),
        ]);
      });
    });
    // \uFEFF = BOM para que Excel respete los acentos.
    return "\uFEFF" + filas.map((f) => f.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }

  /* ---------- Helpers de respuesta ---------- */
  function json(obj) {
    return new Response(JSON.stringify(obj), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  // Lee un FormData o JSON del body de una petición simulada.
  function leerBody(opts) {
    if (!opts || !opts.body) return {};
    if (opts.body instanceof FormData) {
      const o = {};
      for (const [k, v] of opts.body.entries()) o[k] = v;
      return o;
    }
    try { return JSON.parse(opts.body); } catch { return {}; }
  }

  /* =====================================================
     ROUTERS — uno por cada endpoint PHP
     ===================================================== */

  function rutaProductos(url, opts) {
    const params = url.searchParams;
    const accion = params.get("accion") || leerBody(opts).accion;

    // --- GET listar ---
    if (accion === "listar") {
      const activos = DB.productos.filter((p) => p.activo);
      return json({ ok: true, productos: activos });
    }
    // --- GET sugerencias ---
    if (accion === "sugerencias") {
      return json({ ok: true, sugerencias: similares(params.get("q")) });
    }
    // --- GET sku ---
    if (accion === "sku") {
      const sku = generarSku(params.get("nombre"), params.get("categoria"), params.get("id"));
      return json({ ok: true, sku });
    }

    // --- POST crear / actualizar / eliminar ---
    const body = leerBody(opts);

    if (body.accion === "crear") {
      DB.seqProducto++;
      // Imagen: archivo subido -> URL temporal; o link pegado; o nada.
      let imagen = null;
      if (body.imagen instanceof File) imagen = URL.createObjectURL(body.imagen);
      else if (body.imagen_url) imagen = body.imagen_url;

      const nuevo = {
        id: DB.seqProducto,
        nombre: body.nombre,
        categoria: body.categoria,
        sku: generarSku(body.nombre, body.categoria, null),
        precio: parseFloat(body.precio) || 0,
        stock: parseInt(body.stock, 10) || 0,
        imagen,
        activo: true,
      };
      DB.productos.push(nuevo);
      if (!DB.historial.some((h) => h.nombre === nuevo.nombre)) {
        DB.historial.push({ nombre: nuevo.nombre, categoria: nuevo.categoria });
      }
      return json({ ok: true, producto: nuevo });
    }

    if (body.accion === "actualizar") {
      const p = DB.productos.find((x) => String(x.id) === String(body.id));
      if (!p) return json({ ok: false, error: "Producto no encontrado." });
      p.nombre = body.nombre;
      p.categoria = body.categoria;
      p.precio = parseFloat(body.precio) || 0;
      p.stock = parseInt(body.stock, 10) || 0;
      p.sku = generarSku(p.nombre, p.categoria, p.id);
      if (body.imagen instanceof File) p.imagen = URL.createObjectURL(body.imagen);
      else if (body.imagen_url) p.imagen = body.imagen_url;
      else if (body.imagen_actual) p.imagen = body.imagen_actual;
      return json({ ok: true, producto: p });
    }

    if (body.accion === "eliminar") {
      const p = DB.productos.find((x) => String(x.id) === String(body.id));
      if (p) p.activo = false; // borrado lógico, igual que el backend
      return json({ ok: true });
    }

    return json({ ok: false, error: "Acción no reconocida." });
  }

  function rutaVentas(url, opts) {
    const params = url.searchParams;
    const accion = params.get("accion") || leerBody(opts).accion;

    // --- GET csv: dispara la descarga de un archivo ---
    if (accion === "csv") {
      const blob = new Blob([ventasACsv()], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ventas_og_control.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Devuelvo algo válido para que el flujo no truene.
      return json({ ok: true });
    }

    // --- GET listar ---
    if (accion === "listar") {
      return json({ ok: true, ventas: DB.ventas });
    }

    const body = leerBody(opts);

    // --- POST crear (cobrar) ---
    if (body.accion === "crear") {
      const items = body.items || [];
      if (!items.length) return json({ ok: false, error: "El ticket está vacío." });

      // Validar stock antes de cobrar (como el FOR UPDATE del backend).
      for (const it of items) {
        const p = DB.productos.find((x) => Number(x.id) === Number(it.id));
        if (!p) return json({ ok: false, error: "Un producto del ticket ya no existe." });
        if (Number(it.cantidad) > Number(p.stock)) {
          return json({ ok: false, error: `Stock insuficiente de "${p.nombre}".` });
        }
      }

      const calc = calcularVenta(items);

      // Descontar stock.
      items.forEach((it) => {
        const p = DB.productos.find((x) => Number(x.id) === Number(it.id));
        if (p) p.stock -= Number(it.cantidad);
      });

      // Folio con secuencia que nunca repite.
      DB.seqVenta++;
      DB.seqFolio++;
      const folio = "V-" + String(DB.seqFolio).padStart(5, "0");
      const venta = {
        id: DB.seqVenta,
        folio,
        total: calc.total,
        creado_en: new Date().toISOString(),
        items: calc.detalle,
        descuento_venta: calc.descuentoVenta,
      };
      DB.ventas.unshift(venta); // la más reciente arriba
      return json({ ok: true, venta });
    }

    // --- POST limpiar ---
    if (body.accion === "limpiar") {
      DB.ventas = [];
      return json({ ok: true });
    }

    return json({ ok: false, error: "Acción no reconocida." });
  }

  function rutaPromociones(url, opts) {
    const params = url.searchParams;
    const accion = params.get("accion") || leerBody(opts).accion;

    // --- GET listar (con nombre del producto para la tabla) ---
    if (accion === "listar") {
      const conNombre = DB.promociones.map((o) => {
        const prod = DB.productos.find((p) => Number(p.id) === Number(o.producto_id));
        return { ...o, producto_nombre: prod ? prod.nombre : null };
      });
      return json({ ok: true, promociones: conNombre });
    }

    const body = leerBody(opts);

    if (body.accion === "crear") {
      DB.seqOferta++;
      const o = {
        id: DB.seqOferta,
        nombre: body.nombre,
        tipo: body.tipo,
        producto_id: body.producto_id ? parseInt(body.producto_id, 10) : null,
        valor: body.valor != null ? parseFloat(body.valor) : null,
        lleva: body.lleva != null ? parseInt(body.lleva, 10) : null,
        paga: body.paga != null ? parseInt(body.paga, 10) : null,
        activa: true,
      };
      DB.promociones.push(o);
      return json({ ok: true, promocion: o });
    }

    if (body.accion === "actualizar") {
      const o = DB.promociones.find((x) => String(x.id) === String(body.id));
      if (!o) return json({ ok: false, error: "Oferta no encontrada." });
      o.nombre = body.nombre;
      o.tipo = body.tipo;
      o.producto_id = body.producto_id ? parseInt(body.producto_id, 10) : null;
      o.valor = body.valor != null ? parseFloat(body.valor) : null;
      o.lleva = body.lleva != null ? parseInt(body.lleva, 10) : null;
      o.paga = body.paga != null ? parseInt(body.paga, 10) : null;
      return json({ ok: true, promocion: o });
    }

    if (body.accion === "toggle") {
      const o = DB.promociones.find((x) => String(x.id) === String(body.id));
      if (o) o.activa = !o.activa;
      return json({ ok: true });
    }

    if (body.accion === "eliminar") {
      DB.promociones = DB.promociones.filter((x) => String(x.id) !== String(body.id));
      return json({ ok: true });
    }

    return json({ ok: false, error: "Acción no reconocida." });
  }

  /* =====================================================
     Interceptor de fetch
     ===================================================== */
  const fetchOriginal = window.fetch.bind(window);

  window.fetch = function (recurso, opciones) {
    let urlStr = typeof recurso === "string" ? recurso : (recurso && recurso.url) || "";

    // Solo intercepto las llamadas a nuestros endpoints PHP.
    if (urlStr.includes("api_productos.php") ||
        urlStr.includes("api_ventas.php") ||
        urlStr.includes("api_promociones.php")) {

      // Construyo una URL absoluta para poder leer los query params.
      const url = new URL(urlStr, window.location.href);

      // Pequeño retraso para que se note el spinner de "Cargando…".
      return new Promise((resolve) => {
        setTimeout(() => {
          try {
            if (urlStr.includes("api_productos.php"))   return resolve(rutaProductos(url, opciones));
            if (urlStr.includes("api_ventas.php"))      return resolve(rutaVentas(url, opciones));
            if (urlStr.includes("api_promociones.php")) return resolve(rutaPromociones(url, opciones));
          } catch (e) {
            resolve(json({ ok: false, error: "Error en la capa demo: " + e.message }));
          }
        }, 120);
      });
    }

    // Cualquier otra petición (fuentes, imágenes…) va al fetch real.
    return fetchOriginal(recurso, opciones);
  };

  console.log("%cOG Control · MODO DEMO", "color:#ffe600;font-weight:bold", "— datos simulados en el navegador, sin base de datos.");
})();

/* El botón "Cerrar sesión" no aplica en la demo estática: lo dejo inerte. */
document.addEventListener("DOMContentLoaded", function () {
  var b = document.getElementById("btnLogout");
  if (b) b.addEventListener("click", function (e) {
    e.preventDefault();
    var t = document.getElementById("toast");
    if (t) { t.textContent = "Sesión cerrada (demo)"; t.hidden = false;
      requestAnimationFrame(function(){ t.classList.add("show"); });
      setTimeout(function(){ t.classList.remove("show"); setTimeout(function(){ t.hidden = true; }, 200); }, 1800);
    }
  });
});
