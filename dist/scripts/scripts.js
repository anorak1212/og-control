/* =====================================================
   OG CONTROL — scripts.js
   Toda la data vive en PostgreSQL. Este archivo solo habla
   con los endpoints de /sites vía fetch(); no hay localStorage.
   =====================================================
   API_PRODUCTOS:
     GET  ?accion=listar
     GET  ?accion=sugerencias&q=
     GET  ?accion=sku&nombre=&categoria=&id=
     POST accion=crear|actualizar|eliminar   (FormData)
   API_VENTAS:
     GET  ?accion=listar
     POST accion=crear   (JSON)
     POST accion=limpiar
   ===================================================== */

   // Rutas servidas por el backend en Rust (servidor local 127.0.0.1).
   // Antes apuntaban a archivos .php; ahora a endpoints /api/*.
   const API_PRODUCTOS = "/api/productos";
   const API_VENTAS = "/api/ventas";
   const API_PROMOCIONES = "/api/promociones";
   // Token de sesión devuelto por /api/login, guardado en el navegador.
   const TOKEN_KEY = "og_token";
   const PLACEHOLDER_IMG = "assets/productos/placeholder.svg";
   
   const state = {
     productos: [],
     ventas: [],
     ofertas: [],
     carrito: [], // [{id, cantidad}]
     vista: "dashboard",
     paginaProductos: 1,      // página actual de la tabla de productos
     porPagina: 8,            // productos por página
   };
   
   /* ---------------------------------------------------
      Utilidades
      --------------------------------------------------- */
   function money(n) {
     return "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
   }
   
   function escapeHtml(str) {
     const div = document.createElement("div");
     div.textContent = str ?? "";
     return div.innerHTML;
   }
   
   function imagenUrl(producto) {
     if (!producto.imagen) return PLACEHOLDER_IMG;
     // Si ya es una URL completa (http/https) o una imagen embebida
     // (data URL base64), la uso tal cual. Si no, es un archivo que
     // vive en assets/productos/.
     if (/^(https?:\/\/|data:image\/)/i.test(producto.imagen)) return producto.imagen;
     return `assets/productos/${producto.imagen}`;
   }
   
   function toast(msg, danger = false) {
     const el = document.getElementById("toast");
     el.textContent = msg;
     el.classList.toggle("toast-danger", danger);
     el.hidden = false;
     requestAnimationFrame(() => el.classList.add("show"));
     clearTimeout(window.__toastTimer);
     window.__toastTimer = setTimeout(() => {
       el.classList.remove("show");
       setTimeout(() => (el.hidden = true), 200);
     }, 2400);
   }
   
   async function llamar(url, opciones = {}) {
     // Inyecto el token de sesión en cada petición (equivale a la
     // cookie de sesión que antes manejaba PHP). El backend lo valida.
     const headers = new Headers(opciones.headers || {});
     const token = localStorage.getItem(TOKEN_KEY) || "";
     if (token) headers.set("x-og-token", token);

     // El backend en Rust recibe JSON, no FormData. Como el resto del
     // código sigue armando FormData (porque PHP lo pedía), aquí lo
     // convierto a JSON de forma transparente: nadie más se entera.
     let body = opciones.body;
     if (body instanceof FormData) {
       const obj = {};
       for (const [clave, valor] of body.entries()) {
         if (valor instanceof File) {
           // Una imagen subida: la paso a data URL (base64). Así viaja
           // como texto y se guarda sin necesidad de subir archivos.
           obj.imagen_url = await archivoADataUrl(valor);
         } else if (clave === "id" || clave === "producto_id" ||
                    clave === "lleva" || clave === "paga") {
           obj[clave] = valor === "" ? null : Number(valor);
         } else if (clave === "precio" || clave === "valor" || clave === "stock") {
           obj[clave] = valor === "" ? 0 : Number(valor);
         } else {
           obj[clave] = valor;
         }
       }
       body = JSON.stringify(obj);
       headers.set("Content-Type", "application/json");
     }

     const res = await fetch(url, { ...opciones, headers, body });

     // Si la sesión expiró, el servidor responde 401: de vuelta al login.
     if (res.status === 401) {
       localStorage.removeItem(TOKEN_KEY);
       window.location.href = "login.html";
       throw new Error("Sesión expirada.");
     }

     let data;
     try {
       data = await res.json();
     } catch {
       throw new Error("El servidor no respondió correctamente.");
     }
     if (!data.ok) throw new Error(data.error || "Ocurrió un error inesperado.");
     return data;
   }

   /** Convierte un File (imagen) a una cadena data URL base64. */
   function archivoADataUrl(file) {
     return new Promise((resolve, reject) => {
       const reader = new FileReader();
       reader.onload = (ev) => resolve(ev.target.result);
       reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
       reader.readAsDataURL(file);
     });
   }
   
   /* ---------------------------------------------------
      Carga inicial desde PostgreSQL
      --------------------------------------------------- */
   async function cargarProductos() {
     const data = await llamar(`${API_PRODUCTOS}?accion=listar`);
     state.productos = data.productos;
   }
   
   async function cargarVentas() {
     const data = await llamar(`${API_VENTAS}?accion=listar`);
     state.ventas = data.ventas;
   }

   async function cargarOfertas() {
     const data = await llamar(`${API_PROMOCIONES}?accion=listar`);
     state.ofertas = data.promociones;
   }
   
   async function cargarTodo() {
     mostrarCargando(true);
     try {
       await Promise.all([cargarProductos(), cargarVentas(), cargarOfertas()]);
       ocultarErrorConexion();
     } catch (e) {
       // Si la BD no responde, en vez de dejar la pantalla vacía y muda,
       // muestro un aviso claro con opción de reintentar.
       mostrarErrorConexion(e.message);
       toast("No se pudo conectar con la base de datos.", true);
     } finally {
       mostrarCargando(false);
     }
     renderAll();
   }

   /* Overlay de carga: se muestra mientras se consulta la BD. */
   function mostrarCargando(activo) {
     const el = document.getElementById("loadingOverlay");
     if (el) el.hidden = !activo;
   }

   /* Aviso de error de conexión, con botón para reintentar. */
   function mostrarErrorConexion(mensaje) {
     let el = document.getElementById("connError");
     if (!el) {
       el = document.createElement("div");
       el.id = "connError";
       el.className = "conn-error";
       document.querySelector(".main").prepend(el);
     }
     el.innerHTML = `
       <div class="conn-error-box">
         <strong>Sin conexión con la base de datos</strong>
         <p>${escapeHtml(mensaje || "Verifica que el contenedor de PostgreSQL esté corriendo.")}</p>
         <button class="btn btn-primary" id="btnReintentar">Reintentar</button>
       </div>`;
     el.hidden = false;
     document.getElementById("btnReintentar").addEventListener("click", cargarTodo);
   }

   function ocultarErrorConexion() {
     const el = document.getElementById("connError");
     if (el) el.hidden = true;
   }
   
   /* ---------------------------------------------------
      Navegación SPA
      --------------------------------------------------- */
   function initNav() {
     document.querySelectorAll(".nav-item").forEach((btn) => {
       btn.addEventListener("click", () => irAVista(btn.dataset.view));
     });
   }
   
   function irAVista(vista) {
     state.vista = vista;
     document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === vista));
     document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + vista));
     renderAll();
   }
   
   /* ---------------------------------------------------
      Render: Dashboard
      --------------------------------------------------- */
   function renderDashboard() {
     document.getElementById("statTotalProductos").textContent = state.productos.length;
     document.getElementById("statBajoStock").textContent = state.productos.filter((p) => p.stock <= 5).length;
     document.getElementById("statVentasHoy").textContent = state.ventas.length;
   
     const ingresos = state.ventas.reduce((sum, v) => sum + Number(v.total), 0);
     document.getElementById("statIngresos").textContent = money(ingresos);
   
     const criticos = state.productos.filter((p) => p.stock <= 5).sort((a, b) => a.stock - b.stock);
     const tbody = document.querySelector("#tablaCritico tbody");
     tbody.innerHTML = criticos.length
       ? criticos
           .map(
             (p) => `
         <tr>
           <td><img class="thumb" src="${imagenUrl(p)}" alt=""></td>
           <td class="cell-sku">${p.sku || "—"}</td>
           <td>${escapeHtml(p.nombre)}</td>
           <td>${escapeHtml(p.categoria)}</td>
           <td class="cell-precio">${money(p.precio)}</td>
           <td><span class="pill pill-low">${p.stock} pzs</span></td>
         </tr>`
           )
           .join("")
       : `<tr><td colspan="6" style="color:var(--text-dim); text-align:center; padding:18px 0;">Sin productos con stock crítico. Buen control.</td></tr>`;

     renderDistribucionCategorias();
   }

   /* Barra de distribución de productos por categoría (solo CSS, sin librerías). */
   function renderDistribucionCategorias() {
     const cont = document.getElementById("distribucionCategorias");
     if (!cont) return;

     // Cuento productos por categoría.
     const conteo = {};
     state.productos.forEach((p) => {
       conteo[p.categoria] = (conteo[p.categoria] || 0) + 1;
     });

     const entradas = Object.entries(conteo).sort((a, b) => b[1] - a[1]);
     const total = state.productos.length;

     if (total === 0) {
       cont.innerHTML = `<p class="dist-empty">Aún no hay productos para mostrar.</p>`;
       return;
     }

     cont.innerHTML = entradas
       .map(([cat, num]) => {
         const pct = Math.round((num / total) * 100);
         return `
         <div class="dist-row">
           <div class="dist-label"><span>${escapeHtml(cat)}</span><span class="dist-num">${num}</span></div>
           <div class="dist-bar"><div class="dist-fill" style="width:${pct}%"></div></div>
         </div>`;
       })
       .join("");
   }
   
   /* ---------------------------------------------------
      Render: Productos (tabla + filtros)
      --------------------------------------------------- */
   function productosFiltrados() {
     const texto = (document.getElementById("buscarProducto")?.value || "").toLowerCase().trim();
     const cat = document.getElementById("filtroCategoria")?.value || "";
     return state.productos.filter((p) => {
       const coincideTexto = !texto || p.nombre.toLowerCase().includes(texto) || (p.sku || "").toLowerCase().includes(texto);
       const coincideCat = !cat || p.categoria === cat;
       return coincideTexto && coincideCat;
     });
   }
   
   function renderProductos() {
     document.getElementById("navProductCount").textContent = state.productos.length;

     const lista = productosFiltrados();
     const tbody = document.querySelector("#tablaProductos tbody");
     const empty = document.getElementById("productosEmpty");

     // --- Paginación ---
     const totalPaginas = Math.max(1, Math.ceil(lista.length / state.porPagina));
     // Si por un filtro la página actual quedó fuera de rango, la ajusto.
     if (state.paginaProductos > totalPaginas) state.paginaProductos = totalPaginas;
     const inicio = (state.paginaProductos - 1) * state.porPagina;
     const pagina = lista.slice(inicio, inicio + state.porPagina);

     tbody.innerHTML = pagina
       .map((p) => {
         const bajo = p.stock <= 5;
         return `
         <tr>
           <td><img class="thumb" src="${imagenUrl(p)}" alt=""></td>
           <td class="cell-sku">${p.sku || "—"}</td>
           <td>${escapeHtml(p.nombre)}</td>
           <td>${escapeHtml(p.categoria)}</td>
           <td class="cell-precio">${money(p.precio)}</td>
           <td>${p.stock}</td>
           <td><span class="pill ${bajo ? "pill-low" : "pill-ok"}">${bajo ? "Stock bajo" : "Disponible"}</span></td>
           <td class="cell-acc">
             <button class="icon-btn" title="Editar" data-action="editar" data-id="${p.id}">✎</button>
             <button class="icon-btn danger" title="Eliminar" data-action="eliminar" data-id="${p.id}">🗑</button>
           </td>
         </tr>`;
       })
       .join("");

     empty.hidden = lista.length !== 0;
     tbody.closest("table").style.display = lista.length ? "" : "none";

     renderPaginacion(lista.length, totalPaginas);
   }

   /* Controles de paginación debajo de la tabla de productos */
   function renderPaginacion(totalItems, totalPaginas) {
     let cont = document.getElementById("paginacionProductos");
     if (!cont) return;

     if (totalItems <= state.porPagina) {
       cont.innerHTML = "";
       return;
     }

     const desde = (state.paginaProductos - 1) * state.porPagina + 1;
     const hasta = Math.min(state.paginaProductos * state.porPagina, totalItems);

     cont.innerHTML = `
       <span class="pag-info">Mostrando ${desde}–${hasta} de ${totalItems}</span>
       <div class="pag-btns">
         <button class="btn btn-ghost pag-btn" data-pag="prev" ${state.paginaProductos === 1 ? "disabled" : ""}>‹ Anterior</button>
         <span class="pag-actual">${state.paginaProductos} / ${totalPaginas}</span>
         <button class="btn btn-ghost pag-btn" data-pag="next" ${state.paginaProductos === totalPaginas ? "disabled" : ""}>Siguiente ›</button>
       </div>`;
   }
   
   /* ---------------------------------------------------
      Modal: alta / edición de producto
      --------------------------------------------------- */
   let archivoImagenSeleccionado = null;
   
   function abrirModal(producto = null) {
     document.getElementById("modalTitulo").textContent = producto ? "Editar producto" : "Nuevo producto";
     document.getElementById("fId").value = producto?.id || "";
     document.getElementById("fNombre").value = producto?.nombre || "";
     document.getElementById("fCategoria").value = producto?.categoria || "Suplementos";
     document.getElementById("fSku").value = producto?.sku || "Se genera al escribir…";
     document.getElementById("fPrecio").value = producto?.precio ?? "";
     document.getElementById("fStock").value = producto?.stock ?? "";
     document.getElementById("fImagenActual").value = producto?.imagen || "";
     document.getElementById("fImagenPreview").src = producto ? imagenUrl(producto) : PLACEHOLDER_IMG;
     document.getElementById("fImagen").value = "";
     // Si la imagen del producto era un link, lo precargo en el campo URL.
     const esUrl = producto?.imagen && /^https?:\/\//i.test(producto.imagen);
     document.getElementById("fImagenUrl").value = esUrl ? producto.imagen : "";
     archivoImagenSeleccionado = null;
     ocultarSugerencias();
     document.getElementById("modalBackdrop").hidden = false;
     document.getElementById("fNombre").focus();
   
     if (producto) actualizarSkuPreview();
   }
   
   function cerrarModal() {
     ocultarSugerencias();
     document.getElementById("modalBackdrop").hidden = true;
   }
   
   /* --- SKU automático: el campo nunca es editable a mano --- */
   let skuTimer = null;
   function actualizarSkuPreview() {
     const nombre = document.getElementById("fNombre").value.trim();
     const categoria = document.getElementById("fCategoria").value;
     const id = document.getElementById("fId").value;
     const campoSku = document.getElementById("fSku");

     if (!nombre) {
       campoSku.value = "Se genera al escribir…";
       return;
     }

     campoSku.value = "Generando…";
     clearTimeout(skuTimer);
     skuTimer = setTimeout(async () => {
       try {
         const params = new URLSearchParams({ accion: "sku", nombre, categoria, ...(id ? { id } : {}) });
         const data = await llamar(`${API_PRODUCTOS}?${params}`);
         campoSku.value = data.sku || "—";
       } catch {
         campoSku.value = "—";
       }
     }, 300);
   }
   
   /* --- Sugerencias por similitud (historial de nombres) --- */
   let sugTimer = null;
   function ocultarSugerencias() {
     const box = document.getElementById("sugerenciasNombre");
     box.hidden = true;
     box.innerHTML = "";
   }
   
   async function buscarSugerencias(texto) {
     if (!texto || texto.length < 2) {
       ocultarSugerencias();
       return;
     }
     try {
       const params = new URLSearchParams({ accion: "sugerencias", q: texto });
       const data = await llamar(`${API_PRODUCTOS}?${params}`);
       const box = document.getElementById("sugerenciasNombre");
   
       if (!data.sugerencias.length) {
         ocultarSugerencias();
         return;
       }
   
       box.innerHTML = data.sugerencias
         .map(
           (s) => `
         <button type="button" class="suggest-item" data-nombre="${escapeHtml(s.nombre)}" data-categoria="${escapeHtml(s.categoria)}">
           <span>${escapeHtml(s.nombre)}</span>
           <span class="sg-cat">${escapeHtml(s.categoria)}</span>
         </button>`
         )
         .join("");
       box.hidden = false;
     } catch {
       ocultarSugerencias();
     }
   }
   
   function initSugerenciasNombre() {
     const input = document.getElementById("fNombre");
     input.addEventListener("input", () => {
       clearTimeout(sugTimer);
       const texto = input.value.trim();
       sugTimer = setTimeout(() => buscarSugerencias(texto), 250);
       actualizarSkuPreview();
     });
   
     document.getElementById("sugerenciasNombre").addEventListener("click", (e) => {
       const item = e.target.closest(".suggest-item");
       if (!item) return;
       document.getElementById("fNombre").value = item.dataset.nombre;
       document.getElementById("fCategoria").value = item.dataset.categoria;
       ocultarSugerencias();
       actualizarSkuPreview();
     });
   
     document.addEventListener("click", (e) => {
       if (!e.target.closest(".campo-nombre")) ocultarSugerencias();
     });
   
     document.getElementById("fCategoria").addEventListener("change", actualizarSkuPreview);
   }
   
   function initImagenField() {
     const input = document.getElementById("fImagen");
     input.addEventListener("change", () => {
       const archivo = input.files[0];
       if (!archivo) return;
       archivoImagenSeleccionado = archivo;
       const reader = new FileReader();
       reader.onload = (ev) => (document.getElementById("fImagenPreview").src = ev.target.result);
       reader.readAsDataURL(archivo);
     });

     // Al pegar un link, muestro la previsualización en vivo.
     const inputUrl = document.getElementById("fImagenUrl");
     inputUrl.addEventListener("input", () => {
       const url = inputUrl.value.trim();
       if (/^https?:\/\//i.test(url)) {
         document.getElementById("fImagenPreview").src = url;
       } else if (!url) {
         document.getElementById("fImagenPreview").src = PLACEHOLDER_IMG;
       }
     });
   }
   
   function initModal() {
     document.getElementById("btnNuevoProducto").addEventListener("click", () => abrirModal());
     document.getElementById("modalClose").addEventListener("click", cerrarModal);

     /* CORRECCIÓN: Cancelar pide confirmación antes de cerrar */
     document.getElementById("btnCancelarModal").addEventListener("click", () => {
       const confirmar = confirm(
         "¿Deseas cancelar el registro del producto?\n\nSe perderán los cambios realizados."
       );
       if (confirmar) {
         cerrarModal();
       }
     });

     document.getElementById("modalBackdrop").addEventListener("click", (e) => {
       if (e.target.id === "modalBackdrop") cerrarModal();
     });
   
     document.getElementById("formProducto").addEventListener("submit", async (e) => {
       e.preventDefault();

       const nombre    = document.getElementById("fNombre").value.trim();
       const categoria = document.getElementById("fCategoria").value;
       const precio    = document.getElementById("fPrecio").value.trim();
       const stock     = document.getElementById("fStock").value.trim();

       // 1) Reviso qué campos importantes quedaron vacíos y aviso por nombre.
       const faltantes = [];
       if (!nombre) faltantes.push("Nombre");
       if (!precio) faltantes.push("Precio");
       if (!stock)  faltantes.push("Stock");

       if (faltantes.length) {
         const ok = confirm(
           "Estos campos están vacíos:\n\n• " + faltantes.join("\n• ") +
           "\n\n¿Quieres guardar el producto de todos modos?"
         );
         if (!ok) return;
         // El nombre sí es indispensable para generar SKU: sin él, no se puede.
         if (!nombre) {
           toast("El nombre es necesario para registrar el producto.", true);
           return;
         }
       }

       // 2) Si no se eligió imagen (ni archivo, ni link, ni una previa), confirmo.
       const id = document.getElementById("fId").value;
       const yaTeniaImagen = document.getElementById("fImagenActual").value;
       const urlImagen = document.getElementById("fImagenUrl").value.trim();
       if (!archivoImagenSeleccionado && !urlImagen && !yaTeniaImagen) {
         const ok = confirm(
           "¿Seguro que quieres registrarlo sin imagen?\n\nSe mostrará un ícono genérico en su lugar."
         );
         if (!ok) return;
       }

       const fd = new FormData();
       fd.append("accion", id ? "actualizar" : "crear");
       if (id) fd.append("id", id);
       fd.append("nombre", nombre);
       fd.append("categoria", categoria);
       fd.append("precio", precio || "0");
       fd.append("stock", stock || "0");
       fd.append("imagen_actual", yaTeniaImagen || "");
       // El archivo gana sobre el link si se pusieron ambos.
       if (archivoImagenSeleccionado) {
         fd.append("imagen", archivoImagenSeleccionado);
       } else if (urlImagen) {
         fd.append("imagen_url", urlImagen);
       }
       // El SKU no se envía: siempre lo calcula y confirma el servidor.

       try {
         await llamar(API_PRODUCTOS, { method: "POST", body: fd });
         toast(id ? "Producto actualizado" : "Producto creado");
         cerrarModal();
         await cargarProductos();
         renderAll();
       } catch (err) {
         toast(err.message, true);
       }
     });
   }
   
   function initTablaProductosAcciones() {
     document.querySelector("#tablaProductos tbody").addEventListener("click", async (e) => {
       const btn = e.target.closest("button[data-action]");
       if (!btn) return;
       const id = btn.dataset.id;
       const producto = state.productos.find((p) => String(p.id) === String(id));
       if (!producto) return;
   
       if (btn.dataset.action === "editar") {
         abrirModal(producto);
       } else if (btn.dataset.action === "eliminar") {
         if (confirm(`¿Eliminar "${producto.nombre}" del catálogo?`)) {
           try {
             const fd = new FormData();
             fd.append("accion", "eliminar");
             fd.append("id", id);
             await llamar(API_PRODUCTOS, { method: "POST", body: fd });
             toast("Producto eliminado", true);
             await cargarProductos();
             renderAll();
           } catch (err) {
             toast(err.message, true);
           }
         }
       }
     });
   }
   
   function initFiltrosProductos() {
     // Al buscar o cambiar de categoría, vuelvo a la página 1: si no,
     // podrías quedar atrapado en una página que ya no existe tras filtrar.
     document.getElementById("buscarProducto").addEventListener("input", () => {
       state.paginaProductos = 1;
       renderProductos();
     });
     document.getElementById("filtroCategoria").addEventListener("change", () => {
       state.paginaProductos = 1;
       renderProductos();
     });

     // Navegación entre páginas.
     document.getElementById("paginacionProductos").addEventListener("click", (e) => {
       const btn = e.target.closest(".pag-btn");
       if (!btn || btn.disabled) return;
       if (btn.dataset.pag === "prev") state.paginaProductos--;
       if (btn.dataset.pag === "next") state.paginaProductos++;
       renderProductos();
     });
   }
   
   /* ---------------------------------------------------
      Punto de Venta (POS) — carrito robusto
      El carrito vive en state.carrito como [{id, cantidad}].
      Los IDs se normalizan a Número al entrar, y siempre se
      comparan como Número, para evitar el clásico bug de
      "5" !== 5 entre lo que devuelve PostgreSQL y el front.
      --------------------------------------------------- */

   // Busca un producto por id (tolerante a string/número).
   function buscarProducto(id) {
     return state.productos.find((p) => Number(p.id) === Number(id));
   }

   // Mapa de promos activas por producto (para badges y precios).
   function promosPorProducto() {
     const mapa = {};
     state.ofertas
       .filter((o) => o.activa && o.producto_id)
       .forEach((o) => { if (!mapa[Number(o.producto_id)]) mapa[Number(o.producto_id)] = o; });
     return mapa;
   }

   function renderPosGrid() {
     const texto = (document.getElementById("buscarPos")?.value || "").toLowerCase().trim();
     const grid = document.getElementById("posGrid");
     if (!grid) return;

     const promos = promosPorProducto();
     const lista = state.productos.filter(
       (p) => !texto || p.nombre.toLowerCase().includes(texto) || (p.sku || "").toLowerCase().includes(texto)
     );

     grid.innerHTML = lista
       .map((p) => {
         const sinStock = Number(p.stock) <= 0;
         const promo = promos[Number(p.id)];
         const badge = promo ? `<span class="pc-promo">★ ${escapeHtml(promo.nombre)}</span>` : "";
         return `
         <button type="button" class="pos-card${promo ? " has-promo" : ""}" data-id="${p.id}" ${sinStock ? "disabled" : ""}>
           ${badge}
           <img class="pc-thumb" src="${imagenUrl(p)}" alt="">
           <span class="pc-cat">${escapeHtml(p.categoria)}</span>
           <span class="pc-name">${escapeHtml(p.nombre)}</span>
           <span class="pc-foot">
             <span class="pc-price">${money(p.precio)}</span>
             <span class="pc-stock">${sinStock ? "Sin stock" : p.stock + " pzs"}</span>
           </span>
         </button>`;
       })
       .join("");
   }

   function renderCarrito() {
     const cont = document.getElementById("carritoItems");
     const empty = document.getElementById("carritoEmpty");
     if (!cont) return;

     if (state.carrito.length === 0) {
       // Muestro el mensaje de vacío SIN destruir/reinyectar nodos:
       // solo cambio el contenido del contenedor.
       cont.innerHTML = `<div class="cart-empty" id="carritoEmpty">El ticket está vacío</div>`;
     } else {
       cont.innerHTML = state.carrito
         .map((item) => {
           const p = buscarProducto(item.id);
           if (!p) return "";
           return `
           <div class="cart-item" data-id="${p.id}">
             <img class="thumb" src="${imagenUrl(p)}" alt="">
             <div class="ci-info">
               <div class="ci-name">${escapeHtml(p.nombre)}</div>
               <div class="ci-price">${money(p.precio)} c/u</div>
             </div>
             <div class="ci-qty">
               <button type="button" data-qty="-1">−</button>
               <span>${item.cantidad}</span>
               <button type="button" data-qty="1">+</button>
             </div>
             <button type="button" class="ci-remove" data-remove>✕</button>
           </div>`;
         })
         .join("");
     }

     // Total: suma simple de precio × cantidad (los descuentos los
     // calcula el servidor al cobrar; aquí mostramos el subtotal base).
     const subtotal = state.carrito.reduce((sum, item) => {
       const p = buscarProducto(item.id);
       return sum + (p ? Number(p.precio) * Number(item.cantidad) : 0);
     }, 0);

     document.getElementById("cartSubtotal").textContent = money(subtotal);
     document.getElementById("cartTotal").textContent = money(subtotal);
   }

   // Render del POS = grid + carrito (se llaman juntos).
   function renderPos() {
     renderPosGrid();
     renderCarrito();
   }

   // Agrega un producto: si ya está en el ticket, sube su cantidad
   // en 1; si no, lo mete con cantidad 1. NUNCA crea duplicados.
   function agregarAlCarrito(id) {
     const p = buscarProducto(id);
     if (!p || Number(p.stock) <= 0) return;

     const existente = state.carrito.find((c) => Number(c.id) === Number(id));
     const enCarrito = existente ? existente.cantidad : 0;

     if (enCarrito >= Number(p.stock)) {
       toast("No hay más stock disponible de este producto", true);
       return;
     }

     if (existente) {
       existente.cantidad += 1;
     } else {
       state.carrito.push({ id: Number(p.id), cantidad: 1 });
     }
     renderCarrito();
   }

   function cambiarCantidad(id, delta) {
     const item = state.carrito.find((c) => Number(c.id) === Number(id));
     const p = buscarProducto(id);
     if (!item || !p) return;

     const nueva = item.cantidad + delta;
     if (nueva <= 0) {
       state.carrito = state.carrito.filter((c) => Number(c.id) !== Number(id));
     } else if (nueva > Number(p.stock)) {
       toast("No hay más stock disponible de este producto", true);
       return;
     } else {
       item.cantidad = nueva;
     }
     renderCarrito();
   }

   function quitarDelCarrito(id) {
     state.carrito = state.carrito.filter((c) => Number(c.id) !== Number(id));
     renderCarrito();
   }

   function initPos() {
     // Clic en una tarjeta del catálogo -> agregar al ticket.
     document.getElementById("posGrid").addEventListener("click", (e) => {
       const card = e.target.closest(".pos-card");
       if (!card || card.disabled) return;
       agregarAlCarrito(card.dataset.id);
     });

     // Buscar solo re-renderiza el grid (no toca el carrito).
     document.getElementById("buscarPos").addEventListener("input", renderPosGrid);

     // Clics dentro del ticket: +, −, o quitar.
     document.getElementById("carritoItems").addEventListener("click", (e) => {
       const fila = e.target.closest(".cart-item");
       if (!fila) return;
       const id = fila.dataset.id;

       if (e.target.matches("[data-qty]")) {
         cambiarCantidad(id, parseInt(e.target.dataset.qty, 10));
       } else if (e.target.matches("[data-remove]")) {
         quitarDelCarrito(id);
       }
     });

     document.getElementById("btnVaciarCarrito").addEventListener("click", () => {
       state.carrito = [];
       renderCarrito();
     });

     document.getElementById("btnCobrar").addEventListener("click", cobrarVenta);
   }

   async function cobrarVenta() {
     if (state.carrito.length === 0) {
       toast("Agrega productos al ticket antes de cobrar", true);
       return;
     }

     try {
       const data = await llamar(API_VENTAS, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ accion: "crear", items: state.carrito }),
       });

       state.carrito = [];
       const msg = data.venta.descuento_venta
         ? `Venta cobrada: ${money(data.venta.total)} (con "${data.venta.descuento_venta}")`
         : "Venta cobrada: " + money(data.venta.total);
       toast(msg);
       await Promise.all([cargarProductos(), cargarVentas(), cargarOfertas()]);
       renderAll();
     } catch (err) {
       toast(err.message, true);
     }
   }
   
   /* ---------------------------------------------------
      Render: Reportes
      --------------------------------------------------- */
   function renderReportes() {
     const total = state.ventas.length;
     const ingresos = state.ventas.reduce((sum, v) => sum + Number(v.total), 0);
     const promedio = total ? ingresos / total : 0;
   
     document.getElementById("repTotalVentas").textContent = total;
     document.getElementById("repTicketProm").textContent = money(promedio);
     document.getElementById("repIngresos").textContent = money(ingresos);
   
     const tbody = document.querySelector("#tablaVentas tbody");
     const empty = document.getElementById("ventasEmpty");
   
     tbody.innerHTML = state.ventas
       .map((v) => {
         const numArticulos = v.items.reduce((s, i) => s + Number(i.cantidad), 0);
         const fecha = new Date(v.creado_en).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

         // Sub-tabla con el detalle de productos de esta venta.
         const detalle = v.items
           .map(
             (i) => `
             <tr class="detalle-item">
               <td>${escapeHtml(i.nombre)}</td>
               <td>${i.cantidad}</td>
               <td class="cell-precio">${money(i.precio)}</td>
               <td class="cell-precio">${money(Number(i.precio) * Number(i.cantidad))}</td>
             </tr>`
           )
           .join("");

         return `
         <tr class="venta-row" data-folio="${v.folio}">
           <td class="cell-sku">${v.folio}</td>
           <td>${fecha}</td>
           <td>${numArticulos} artículos</td>
           <td class="cell-precio">${money(v.total)}</td>
           <td class="cell-toggle"><span class="toggle-ico">▸</span></td>
         </tr>
         <tr class="venta-detalle" data-folio="${v.folio}" hidden>
           <td colspan="5">
             <div class="detalle-wrap">
               <table class="detalle-tabla">
                 <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
                 <tbody>${detalle || '<tr><td colspan="4">Sin artículos.</td></tr>'}</tbody>
               </table>
             </div>
           </td>
         </tr>`;
       })
       .join("");
   
     empty.hidden = state.ventas.length !== 0;
     tbody.closest("table").style.display = state.ventas.length ? "" : "none";
   }
   
   function initReportes() {
     // Clic en una fila de venta: muestra u oculta su detalle de productos.
     document.querySelector("#tablaVentas tbody").addEventListener("click", (e) => {
       const fila = e.target.closest(".venta-row");
       if (!fila) return;
       const folio = fila.dataset.folio;
       const detalle = document.querySelector(`.venta-detalle[data-folio="${folio}"]`);
       const ico = fila.querySelector(".toggle-ico");
       if (!detalle) return;
       const abierto = !detalle.hidden;
       detalle.hidden = abierto;
       fila.classList.toggle("is-open", !abierto);
       if (ico) ico.textContent = abierto ? "▸" : "▾";
     });

     document.getElementById("btnLimpiarVentas").addEventListener("click", async () => {
       if (state.ventas.length === 0) return;
       if (confirm("¿Borrar todo el historial de ventas guardado en PostgreSQL?")) {
         try {
           const fd = new FormData();
           fd.append("accion", "limpiar");
           await llamar(API_VENTAS, { method: "POST", body: fd });
           toast("Historial de ventas borrado", true);
           await cargarVentas();
           renderAll();
         } catch (err) {
           toast(err.message, true);
         }
       }
     });
   }
   
   /* ---------------------------------------------------
      Render general + arranque
      --------------------------------------------------- */
   /* ---------------------------------------------------
      Ofertas / Promociones
      --------------------------------------------------- */

   // Texto legible de cada tipo de promoción.
   const TIPO_LABEL = {
     pct_producto: "% a producto",
     pct_venta: "% a la venta",
     precio_fijo: "Precio fijo",
     nx: "Lleva N paga M",
   };

   function detallePromo(o) {
     if (o.tipo === "pct_producto" || o.tipo === "pct_venta") return `${Number(o.valor)}% de descuento`;
     if (o.tipo === "precio_fijo") return `Precio especial: ${money(o.valor)}`;
     if (o.tipo === "nx") return `Lleva ${o.lleva}, paga ${o.paga}`;
     return "—";
   }

   function renderOfertas() {
     const cont = document.getElementById("navOfertasCount");
     if (cont) cont.textContent = state.ofertas.filter((o) => o.activa).length;

     const tbody = document.querySelector("#tablaOfertas tbody");
     const empty = document.getElementById("ofertasEmpty");
     if (!tbody) return;

     tbody.innerHTML = state.ofertas
       .map((o) => {
         const aplica = o.tipo === "pct_venta" ? "Toda la venta" : escapeHtml(o.producto_nombre || "—");
         return `
         <tr>
           <td>${escapeHtml(o.nombre)}</td>
           <td><span class="pill pill-tipo">${TIPO_LABEL[o.tipo] || o.tipo}</span></td>
           <td>${aplica}</td>
           <td>${detallePromo(o)}</td>
           <td><span class="pill ${o.activa ? "pill-ok" : "pill-off"}">${o.activa ? "Activa" : "Pausada"}</span></td>
           <td class="cell-acc">
             <button class="icon-btn" title="${o.activa ? "Pausar" : "Activar"}" data-oaccion="toggle" data-id="${o.id}">${o.activa ? "⏸" : "▶"}</button>
             <button class="icon-btn" title="Editar" data-oaccion="editar" data-id="${o.id}">✎</button>
             <button class="icon-btn danger" title="Eliminar" data-oaccion="eliminar" data-id="${o.id}">🗑</button>
           </td>
         </tr>`;
       })
       .join("");

     empty.hidden = state.ofertas.length !== 0;
     tbody.closest("table").style.display = state.ofertas.length ? "" : "none";
   }

   /* --- Modal de oferta --- */
   function llenarSelectProductos() {
     const sel = document.getElementById("oProducto");
     sel.innerHTML = state.productos
       .map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`)
       .join("");
   }

   // Muestra/oculta campos del modal según el tipo elegido.
   function ajustarCamposOferta() {
     const tipo = document.getElementById("oTipo").value;
     const campoProducto = document.getElementById("oCampoProducto");
     const campoValor = document.getElementById("oCampoValor");
     const campoNx = document.getElementById("oCampoNx");
     const valorLabel = document.getElementById("oValorLabel");

     // Producto: visible en todos menos "% a toda la venta".
     campoProducto.hidden = tipo === "pct_venta";

     if (tipo === "nx") {
       campoValor.hidden = true;
       campoNx.hidden = false;
     } else {
       campoValor.hidden = false;
       campoNx.hidden = true;
       valorLabel.textContent = tipo === "precio_fijo" ? "Precio especial (MXN)" : "Porcentaje (%)";
     }
   }

   function abrirModalOferta(oferta = null) {
     llenarSelectProductos();
     document.getElementById("modalOfertaTitulo").textContent = oferta ? "Editar oferta" : "Nueva oferta";
     document.getElementById("oId").value = oferta?.id || "";
     document.getElementById("oNombre").value = oferta?.nombre || "";
     document.getElementById("oTipo").value = oferta?.tipo || "pct_producto";
     document.getElementById("oProducto").value = oferta?.producto_id || (state.productos[0]?.id ?? "");
     document.getElementById("oValor").value = oferta?.valor ?? "";
     document.getElementById("oLleva").value = oferta?.lleva ?? "";
     document.getElementById("oPaga").value = oferta?.paga ?? "";
     ajustarCamposOferta();
     document.getElementById("modalOfertaBackdrop").hidden = false;
   }

   function cerrarModalOferta() {
     document.getElementById("modalOfertaBackdrop").hidden = true;
   }

   function initOfertas() {
     document.getElementById("btnNuevaOferta").addEventListener("click", () => {
       if (state.productos.length === 0) {
         toast("Primero registra al menos un producto.", true);
         return;
       }
       abrirModalOferta();
     });
     document.getElementById("modalOfertaClose").addEventListener("click", cerrarModalOferta);
     document.getElementById("btnCancelarOferta").addEventListener("click", cerrarModalOferta);
     document.getElementById("modalOfertaBackdrop").addEventListener("click", (e) => {
       if (e.target.id === "modalOfertaBackdrop") cerrarModalOferta();
     });
     document.getElementById("oTipo").addEventListener("change", ajustarCamposOferta);

     // Guardar oferta.
     document.getElementById("formOferta").addEventListener("submit", async (e) => {
       e.preventDefault();
       const nombre = document.getElementById("oNombre").value.trim();
       const tipo = document.getElementById("oTipo").value;

       if (!nombre) {
         toast("Ponle un nombre a la oferta.", true);
         return;
       }

       const fd = new FormData();
       const id = document.getElementById("oId").value;
       fd.append("accion", id ? "actualizar" : "crear");
       if (id) fd.append("id", id);
       fd.append("nombre", nombre);
       fd.append("tipo", tipo);

       if (tipo !== "pct_venta") fd.append("producto_id", document.getElementById("oProducto").value);
       if (tipo === "nx") {
         fd.append("lleva", document.getElementById("oLleva").value || "0");
         fd.append("paga", document.getElementById("oPaga").value || "0");
       } else {
         fd.append("valor", document.getElementById("oValor").value || "0");
       }

       try {
         await llamar(API_PROMOCIONES, { method: "POST", body: fd });
         toast(id ? "Oferta actualizada" : "Oferta creada");
         cerrarModalOferta();
         await cargarOfertas();
         renderAll();
       } catch (err) {
         toast(err.message, true);
       }
     });

     // Acciones de la tabla (toggle, editar, eliminar).
     document.querySelector("#tablaOfertas tbody").addEventListener("click", async (e) => {
       const btn = e.target.closest("button[data-oaccion]");
       if (!btn) return;
       const id = btn.dataset.id;
       const oferta = state.ofertas.find((o) => String(o.id) === String(id));
       const accion = btn.dataset.oaccion;

       if (accion === "editar") {
         abrirModalOferta(oferta);
       } else if (accion === "toggle") {
         try {
           const fd = new FormData();
           fd.append("accion", "toggle");
           fd.append("id", id);
           await llamar(API_PROMOCIONES, { method: "POST", body: fd });
           await cargarOfertas();
           renderAll();
         } catch (err) {
           toast(err.message, true);
         }
       } else if (accion === "eliminar") {
         if (confirm(`¿Eliminar la oferta "${oferta?.nombre}"?`)) {
           try {
             const fd = new FormData();
             fd.append("accion", "eliminar");
             fd.append("id", id);
             await llamar(API_PROMOCIONES, { method: "POST", body: fd });
             toast("Oferta eliminada", true);
             await cargarOfertas();
             renderAll();
           } catch (err) {
             toast(err.message, true);
           }
         }
       }
     });
   }

   /* ---------------------------------------------------
      Configuración (paleta + tema + fuente, persistente)
      Se guarda en localStorage (esto corre en un servidor
      real con Docker, donde localStorage sí está disponible).
      --------------------------------------------------- */
   const CONFIG_KEY = "og_config";

   function configPorDefecto() {
     return { color: "#ffe600", tema: "dark", fuente: 100 };
   }

   function leerConfig() {
     try {
       return { ...configPorDefecto(), ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") };
     } catch {
       return configPorDefecto();
     }
   }

   function guardarConfig(cfg) {
     try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch {}
   }

   // Aplica la configuración a las variables CSS de la página.
   function aplicarConfig(cfg) {
     const root = document.documentElement;
     root.style.setProperty("--yellow", cfg.color);
     // Versión translúcida del acento para fondos suaves.
     root.style.setProperty("--yellow-wash", cfg.color + "1a");
     // Una versión apagada del acento (para bordes), bajándole opacidad.
     root.style.setProperty("--yellow-dim", cfg.color + "55");
     root.style.fontSize = cfg.fuente + "%";

     if (cfg.tema === "light") {
       root.style.setProperty("--bg", "#f4f4f0");
       root.style.setProperty("--surface", "#ffffff");
       root.style.setProperty("--surface-2", "#eeeee8");
       root.style.setProperty("--text", "#1a1a18");
       root.style.setProperty("--text-dim", "#5a5a55");
       root.style.setProperty("--text-faint", "#8a8a82");
       root.style.setProperty("--border", "rgba(0,0,0,.10)");
       root.style.setProperty("--border-strong", "rgba(0,0,0,.20)");
     } else {
       // Restauro los valores oscuros originales.
       root.style.setProperty("--bg", "#0a0a0a");
       root.style.setProperty("--surface", "#141414");
       root.style.setProperty("--surface-2", "#1b1b1b");
       root.style.setProperty("--text", "#f5f5f0");
       root.style.setProperty("--text-dim", "#9a9a93");
       root.style.setProperty("--text-faint", "#66665f");
       root.style.setProperty("--border", "rgba(255,255,255,.08)");
       root.style.setProperty("--border-strong", "rgba(255,255,255,.16)");
     }

     // Marco las opciones activas en el modal.
     document.querySelectorAll(".color-dot").forEach((b) =>
       b.classList.toggle("is-active", b.dataset.color === cfg.color)
     );
     document.querySelectorAll(".theme-btn").forEach((b) =>
       b.classList.toggle("is-active", b.dataset.theme === cfg.tema)
     );
     const range = document.getElementById("fontSizeRange");
     const label = document.getElementById("fontSizeLabel");
     if (range) range.value = cfg.fuente;
     if (label) label.textContent = cfg.fuente + "%";
   }

   function initConfig() {
     let cfg = leerConfig();
     aplicarConfig(cfg);

     document.getElementById("btnConfig").addEventListener("click", () => {
       document.getElementById("modalConfigBackdrop").hidden = false;
     });
     const cerrar = () => (document.getElementById("modalConfigBackdrop").hidden = true);
     document.getElementById("modalConfigClose").addEventListener("click", cerrar);
     document.getElementById("btnCerrarConfig").addEventListener("click", cerrar);
     document.getElementById("modalConfigBackdrop").addEventListener("click", (e) => {
       if (e.target.id === "modalConfigBackdrop") cerrar();
     });

     document.getElementById("colorOptions").addEventListener("click", (e) => {
       const dot = e.target.closest(".color-dot");
       if (!dot) return;
       cfg.color = dot.dataset.color;
       aplicarConfig(cfg);
       guardarConfig(cfg);
     });

     document.getElementById("themeOptions").addEventListener("click", (e) => {
       const btn = e.target.closest(".theme-btn");
       if (!btn) return;
       cfg.tema = btn.dataset.theme;
       aplicarConfig(cfg);
       guardarConfig(cfg);
     });

     document.getElementById("fontSizeRange").addEventListener("input", (e) => {
       cfg.fuente = parseInt(e.target.value, 10);
       aplicarConfig(cfg);
       guardarConfig(cfg);
     });

     document.getElementById("btnResetConfig").addEventListener("click", () => {
       cfg = configPorDefecto();
       aplicarConfig(cfg);
       guardarConfig(cfg);
       toast("Configuración restablecida");
     });
   }

   function renderAll() {
     renderDashboard();
     renderProductos();
     renderPos();
     renderReportes();
     renderOfertas();
   }
   
   document.addEventListener("DOMContentLoaded", () => {
     // Guardia de sesión del lado cliente: sin token guardado, este
     // panel no tiene nada que hacer -> directo al login. (El backend
     // igual rechaza con 401 cualquier petición sin token, así que es
     // una doble protección, no la única.)
     if (!localStorage.getItem(TOKEN_KEY)) {
       window.location.href = "login.html";
       return;
     }

     // Cerrar sesión: avisa al backend, borra el token y vuelve al login.
     const btnLogout = document.getElementById("btnLogout");
     if (btnLogout) {
       btnLogout.addEventListener("click", async (e) => {
         e.preventDefault();
         try {
           await fetch("/api/logout", {
             method: "POST",
             headers: { "x-og-token": localStorage.getItem(TOKEN_KEY) || "" },
           });
         } catch {}
         localStorage.removeItem(TOKEN_KEY);
         window.location.href = "login.html";
       });
     }

     // Exportar CSV: como necesita mandar el token en el header, no
     // sirve un enlace directo. Lo pido por fetch y disparo la descarga
     // con un blob.
     const btnCsv = document.getElementById("btnExportarCsv");
     if (btnCsv) {
       btnCsv.addEventListener("click", async (e) => {
         e.preventDefault();
         try {
           const res = await fetch("/api/ventas?accion=csv", {
             headers: { "x-og-token": localStorage.getItem(TOKEN_KEY) || "" },
           });
           if (!res.ok) throw new Error("No se pudo exportar.");
           const blob = await res.blob();
           const url = URL.createObjectURL(blob);
           const a = document.createElement("a");
           a.href = url;
           a.download = "ventas_og_control.csv";
           document.body.appendChild(a);
           a.click();
           a.remove();
           URL.revokeObjectURL(url);
         } catch (err) {
           toast(err.message || "No se pudo exportar el CSV.", true);
         }
       });
     }

     initNav();
     initModal();
     initSugerenciasNombre();
     initImagenField();
     initTablaProductosAcciones();
     initFiltrosProductos();
     initPos();
     initReportes();
     initOfertas();
     initConfig();
   
     document.getElementById("btnRefreshDash").addEventListener("click", async () => {
       await cargarTodo();
       toast("Dashboard actualizado");
     });
   
     cargarTodo();
   });