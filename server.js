const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static('public'));

// ============================================================
// ALMACENAMIENTO PERMANENTE — separado del código que se actualiza
//
// Problema que esto resuelve: cada vez que se sube una actualización del
// programa (git push → Railway vuelve a construir el contenedor), el disco
// del contenedor se reemplaza por uno nuevo. Si los datos de los clientes
// vivieran solo ahí, cada actualización los reiniciaría a lo que trae el
// código (perdiendo tiendas/pagos ya registrados).
//
// La solución es un Volumen persistente de Railway: un disco aparte que
// SOBREVIVE a cada actualización/redeploy, sin importar cuántas veces se
// suba código nuevo. Cuando ese volumen está conectado, Railway pone
// automáticamente su ruta en la variable de entorno RAILWAY_VOLUME_MOUNT_PATH
// — si existe, los datos se guardan ahí (para siempre); si no existe
// (por ejemplo, corriendo el programa en una PC local para pruebas), se usa
// la carpeta "data" que trae el proyecto, exactamente como antes.
//
// La carpeta "data" del proyecto (en git) queda entonces como una PLANTILLA
// de arranque: solo se usa una vez, para sembrar el volumen la primera vez
// que se conecta. Después de eso, el código nunca la vuelve a tocar — todo
// lo que pasa en el programa (nuevos clientes, pagos, cambios) se lee y
// escribe SOLO en el volumen permanente.
// ============================================================
const CARPETA_DATOS_PLANTILLA = path.join(__dirname, 'data');
let CARPETA_DATOS = process.env.RAILWAY_VOLUME_MOUNT_PATH || CARPETA_DATOS_PLANTILLA;

function asegurarAlmacenamientoPermanente() {
  try {
    fs.mkdirSync(CARPETA_DATOS, { recursive: true });
    const destino = path.join(CARPETA_DATOS, 'clientes.json');

    if (!fs.existsSync(destino)) {
      const plantilla = path.join(CARPETA_DATOS_PLANTILLA, 'clientes.json');
      if (CARPETA_DATOS !== CARPETA_DATOS_PLANTILLA && fs.existsSync(plantilla)) {
        fs.copyFileSync(plantilla, destino);
        console.log(`📦 Primer arranque con almacenamiento permanente: se copiaron los datos iniciales a ${destino}`);
      } else {
        fs.writeFileSync(destino, '[]', 'utf-8');
        console.log(`📦 Se creó un archivo de datos nuevo (vacío) en ${destino}`);
      }
    }

    if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
      console.log(`💾 Usando almacenamiento PERMANENTE (volumen de Railway): ${destino}`);
      console.log('   Los datos aquí NO se borran ni se reinician con las actualizaciones del código.');
    } else {
      console.log(`💾 Usando la carpeta local del proyecto (sin volumen conectado): ${destino}`);
      console.log('   ⚠️  En Railway, esto se reinicia con cada actualización — conecta un Volumen para que sea permanente.');
    }
  } catch (err) {
    console.log(`⚠️  No se pudo usar la carpeta de almacenamiento permanente (${CARPETA_DATOS}): ${err.message}`);
    console.log('   Se usará la carpeta local del proyecto en su lugar (los datos NO sobrevivirán a la próxima actualización).');
    CARPETA_DATOS = CARPETA_DATOS_PLANTILLA;
    fs.mkdirSync(CARPETA_DATOS, { recursive: true });
    if (!fs.existsSync(path.join(CARPETA_DATOS, 'clientes.json'))) {
      fs.writeFileSync(path.join(CARPETA_DATOS, 'clientes.json'), '[]', 'utf-8');
    }
  }
}
asegurarAlmacenamientoPermanente();

const RUTA_DATOS = path.join(CARPETA_DATOS, 'clientes.json');

// ---------- Utilidades para leer/escribir la "base de datos" (archivo JSON) ----------
function leerClientes() {
  const contenido = fs.readFileSync(RUTA_DATOS, 'utf-8');
  const clientes = JSON.parse(contenido);
  // Compatibilidad: los clientes antiguos pueden no tener historial de pagos todavía.
  clientes.forEach(c => { if (!Array.isArray(c.historial_pagos)) c.historial_pagos = []; });
  return clientes;
}

function guardarClientes(clientes) {
  fs.writeFileSync(RUTA_DATOS, JSON.stringify(clientes, null, 2), 'utf-8');
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Busca un cliente por ID sin importar mayúsculas/minúsculas ni espacios ----------
// (así "local-1", "Local-1" y "LOCAL-1" son el mismo, para evitar errores de tipeo)
function buscarCliente(clientes, id) {
  const buscado = (id || '').trim().toLowerCase();
  return clientes.find(c => (c.id || '').trim().toLowerCase() === buscado);
}

// ---------- Revisa vencimientos y desactiva automáticamente los que ya expiraron ----------
function verificarVencimientos() {
  const clientes = leerClientes();
  const hoy = hoyISO();
  let huboCambios = false;

  clientes.forEach(cliente => {
    if (cliente.activo && cliente.fecha_vencimiento && hoy > cliente.fecha_vencimiento) {
      cliente.activo = false;
      huboCambios = true;
      io.emit('suscripcion:actualizada', { id: cliente.id, activo: false, nombre: cliente.nombre });
      console.log(`Suscripción vencida automáticamente: ${cliente.id} (${cliente.nombre})`);
    }
  });

  if (huboCambios) guardarClientes(clientes);
  return clientes;
}

// Revisión periódica cada 5 minutos
setInterval(verificarVencimientos, 5 * 60 * 1000);
// Revisión al arrancar el servidor
verificarVencimientos();

// ---------- ENDPOINT PRINCIPAL: verificar si un local está activo ----------
app.get('/api/suscripcion/:id', (req, res) => {
  const clientes = verificarVencimientos(); // revisión perezosa antes de responder
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({
      encontrado: false,
      mensaje: 'Local no registrado en el sistema'
    });
  }

  const hoy = hoyISO();
  let diasRestantes = null;
  if (cliente.fecha_vencimiento) {
    const msPorDia = 1000 * 60 * 60 * 24;
    diasRestantes = Math.ceil((new Date(cliente.fecha_vencimiento) - new Date(hoy)) / msPorDia);
  }

  res.json({
    encontrado: true,
    id: cliente.id,
    nombre: cliente.nombre,
    activo: cliente.activo,
    plan: cliente.plan,
    fecha_vencimiento: cliente.fecha_vencimiento,
    dias_restantes: diasRestantes,
    mensaje: cliente.activo
      ? 'Suscripción activa'
      : 'Suscripción no pagada. Contacta a soporte para reactivar tu servicio.'
  });
});

// ---------- Listar todos los clientes (para el panel dashboard) ----------
app.get('/api/clientes', (req, res) => {
  const clientes = verificarVencimientos();
  res.json(clientes);
});

// ============================================================
// ESTADÍSTICAS DEL DASHBOARD (tarjetas de arriba) — todo calculado
// en vivo a partir de data/clientes.json, nada queda fijo/quemado.
// ============================================================
function rangoMesActual(fechaBase) {
  const base = fechaBase ? new Date(fechaBase + 'T00:00:00') : new Date();
  const primerDia = new Date(base.getFullYear(), base.getMonth(), 1);
  const ultimoDia = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return { desde: primerDia.toISOString().slice(0, 10), hasta: ultimoDia.toISOString().slice(0, 10) };
}

app.get('/api/estadisticas', (req, res) => {
  const clientes = verificarVencimientos();
  const hoy = hoyISO();
  const { desde, hasta } = rangoMesActual(hoy);

  const tiendasRegistradas = clientes.length;
  const suscripcionesActivas = clientes.filter(c => c.activo).length;
  const suscripcionesVencidas = clientes.filter(c => !c.activo).length;

  // Ingresos del mes: suma de todos los pagos (de cualquier cliente) cuya fecha de
  // pago cae DENTRO del mes en curso — corte del día 1 al último día del mes.
  let ingresosMes = 0;
  clientes.forEach(c => {
    (c.historial_pagos || []).forEach(p => {
      if (p.fecha_pago && p.fecha_pago >= desde && p.fecha_pago <= hasta) {
        ingresosMes += Number(p.monto) || 0;
      }
    });
  });

  res.json({
    tiendas_registradas: tiendasRegistradas,
    suscripciones_activas: suscripcionesActivas,
    suscripciones_vencidas: suscripcionesVencidas,
    ingresos_mes: ingresosMes,
    periodo: { desde, hasta }
  });
});

// ---------- Activar un local ----------
app.post('/api/suscripcion/:id/activar', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  cliente.activo = true;

  // Si viene acompañado de un cobro (por ejemplo, reactivar pagando de una vez),
  // se registra el pago para que aparezca en el historial y se pueda emitir recibo.
  let pagoRegistrado = null;
  if (req.body && req.body.monto) {
    pagoRegistrado = registrarPago(cliente, req.body);
  }

  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: true, nombre: cliente.nombre });

  res.json({ ok: true, mensaje: `${cliente.nombre} activado`, cliente, pago: pagoRegistrado });
});

// ---------- Desactivar un local ----------
app.post('/api/suscripcion/:id/desactivar', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  cliente.activo = false;
  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: false, nombre: cliente.nombre });

  res.json({ ok: true, mensaje: `${cliente.nombre} desactivado`, cliente });
});

// ---------- Registra un pago dentro del historial de un cliente (helper interno) ----------
function registrarPago(cliente, datos) {
  const pago = {
    id: 'pago-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    fecha_pago: datos.fecha_pago || hoyISO(),
    monto: Number(datos.monto) || 0,
    concepto: datos.concepto || `Pago plan ${cliente.plan || ''} — Billar Class`,
    cubre_desde: datos.cubre_desde || cliente.fecha_vencimiento || hoyISO(),
    cubre_hasta: datos.cubre_hasta || datos.fecha_vencimiento || cliente.fecha_vencimiento || hoyISO()
  };
  if (!Array.isArray(cliente.historial_pagos)) cliente.historial_pagos = [];
  cliente.historial_pagos.push(pago);
  return pago;
}

// ---------- Actualizar fecha de vencimiento (renovar) — y registrar el pago ----------
app.post('/api/suscripcion/:id/renovar', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  const { fecha_vencimiento, monto, concepto, fecha_pago, cubre_desde, cubre_hasta } = req.body || {};

  const cubreDesdeFinal = cubre_desde || cliente.fecha_vencimiento || cliente.fecha_inicio || hoyISO();
  if (fecha_vencimiento) cliente.fecha_vencimiento = fecha_vencimiento;
  cliente.activo = true;

  let pagoRegistrado = null;
  if (monto) {
    pagoRegistrado = registrarPago(cliente, {
      monto,
      concepto,
      fecha_pago,
      cubre_desde: cubreDesdeFinal,
      cubre_hasta: cubre_hasta || fecha_vencimiento
    });
  }

  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: true, nombre: cliente.nombre });

  res.json({ ok: true, mensaje: `${cliente.nombre} renovado`, cliente, pago: pagoRegistrado });
});

// ---------- Genera el siguiente identificador con formato Local-001, Local-002... ----------
function generarSiguienteId(clientes) {
  let maxNumero = 0;
  clientes.forEach(c => {
    const coincide = /^local-(\d+)$/i.exec(c.id || '');
    if (coincide) {
      const numero = parseInt(coincide[1], 10);
      if (numero > maxNumero) maxNumero = numero;
    }
  });
  const siguiente = maxNumero + 1;
  return `Local-${String(siguiente).padStart(3, '0')}`;
}

// ---------- Agregar un nuevo local ----------
app.post('/api/clientes', (req, res) => {
  const clientes = leerClientes();
  const { nombre, ciudad, telefono, plan, valor, fecha_inicio, fecha_vencimiento } = req.body;

  const nuevoId = generarSiguienteId(clientes);

  const nuevoCliente = {
    id: nuevoId,
    nombre: nombre || 'Sin nombre',
    ciudad: ciudad || '',
    telefono: telefono || '',
    plan: plan || 'Mensual',
    valor: valor || 100000,
    fecha_inicio: fecha_inicio || hoyISO(),
    fecha_vencimiento: fecha_vencimiento || '',
    activo: true,
    historial_pagos: []
  };

  // El alta de un cliente nuevo se trata como su primer pago (por eso trae plan/valor).
  if (nuevoCliente.valor && nuevoCliente.fecha_vencimiento) {
    registrarPago(nuevoCliente, {
      monto: nuevoCliente.valor,
      concepto: `Pago plan ${nuevoCliente.plan} — Billar Class`,
      fecha_pago: nuevoCliente.fecha_inicio,
      cubre_desde: nuevoCliente.fecha_inicio,
      cubre_hasta: nuevoCliente.fecha_vencimiento
    });
  }

  clientes.push(nuevoCliente);
  guardarClientes(clientes);
  res.json({ ok: true, cliente: nuevoCliente });
});

// ---------- Editar datos y fechas de un cliente existente ----------
app.post('/api/clientes/:id/editar', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  const { nombre, ciudad, telefono, plan, valor, fecha_inicio, fecha_vencimiento } = req.body;
  if (nombre !== undefined) cliente.nombre = nombre;
  if (ciudad !== undefined) cliente.ciudad = ciudad;
  if (telefono !== undefined) cliente.telefono = telefono;
  if (plan !== undefined) cliente.plan = plan;
  if (valor !== undefined) cliente.valor = valor;
  if (fecha_inicio !== undefined) cliente.fecha_inicio = fecha_inicio;
  if (fecha_vencimiento !== undefined) cliente.fecha_vencimiento = fecha_vencimiento;

  guardarClientes(clientes);
  verificarVencimientos(); // por si la nueva fecha cambia el estado de una vez
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: cliente.activo, nombre: cliente.nombre });

  res.json({ ok: true, mensaje: `${cliente.nombre} actualizado`, cliente });
});

// ---------- Eliminar un cliente ----------
app.delete('/api/clientes/:id', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  const restantes = clientes.filter(c => (c.id || '').trim().toLowerCase() !== (cliente.id || '').trim().toLowerCase());
  guardarClientes(restantes);

  res.json({ ok: true, mensaje: `${cliente.nombre} eliminado` });
});

// ============================================================
// HISTORIAL DE PAGOS POR MES (para la vista "Ver pagos")
// ============================================================
function claveMes(fechaISO) {
  return (fechaISO || '').slice(0, 7); // 'YYYY-MM'
}

function sumarMesClave(claveYYYYMM, delta) {
  const [anio, mes] = claveYYYYMM.split('-').map(Number);
  const fecha = new Date(anio, mes - 1 + delta, 1);
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

const NOMBRES_MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function etiquetaMes(claveYYYYMM) {
  const [anio, mes] = claveYYYYMM.split('-').map(Number);
  return `${NOMBRES_MES[mes - 1]} ${anio}`;
}

// Todos los meses (YYYY-MM) que un pago cubre, entre cubre_desde y cubre_hasta (inclusive)
function mesesCubiertosPorPago(pago) {
  const meses = [];
  if (!pago.cubre_desde) return meses;
  let actual = claveMes(pago.cubre_desde);
  const final = claveMes(pago.cubre_hasta || pago.cubre_desde);
  let guardas = 0;
  while (guardas < 36) { // límite de seguridad
    meses.push(actual);
    if (actual === final) break;
    actual = sumarMesClave(actual, 1);
    guardas++;
  }
  return meses;
}

app.get('/api/clientes/:id/pagos', (req, res) => {
  const clientes = verificarVencimientos();
  const cliente = buscarCliente(clientes, req.params.id);

  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }

  const pagos = (cliente.historial_pagos || []).slice().sort((a, b) => (b.fecha_pago || '').localeCompare(a.fecha_pago || ''));

  // Mapa mes -> el pago que lo cubre (para saber el estado de cada mes)
  const cubiertoPor = {};
  pagos.forEach(p => {
    mesesCubiertosPorPago(p).forEach(m => { cubiertoPor[m] = p; });
  });

  const mesHoy = claveMes(hoyISO());
  const mesesConDatos = Object.keys(cubiertoPor);
  let inicioVentana = cliente.fecha_inicio ? claveMes(cliente.fecha_inicio) : mesHoy;
  if (mesesConDatos.length) {
    mesesConDatos.sort();
    if (mesesConDatos[0] < inicioVentana) inicioVentana = mesesConDatos[0];
  }
  let finVentana = mesHoy;
  if (mesesConDatos.length && mesesConDatos[mesesConDatos.length - 1] > finVentana) finVentana = mesesConDatos[mesesConDatos.length - 1];
  finVentana = sumarMesClave(finVentana, 1); // un mes extra por delante: el próximo a pagar

  const meses = [];
  let cursor = inicioVentana;
  let tope = 0;
  while (cursor <= finVentana && tope < 24) {
    const pagoDelMes = cubiertoPor[cursor];
    meses.push({
      mes: cursor,
      etiqueta: etiquetaMes(cursor),
      estado: pagoDelMes ? 'pagado' : 'pendiente',
      pago_id: pagoDelMes ? pagoDelMes.id : null,
      monto: pagoDelMes ? pagoDelMes.monto : null
    });
    if (cursor === finVentana) break;
    cursor = sumarMesClave(cursor, 1);
    tope++;
  }
  meses.reverse(); // más reciente primero

  res.json({
    ok: true,
    cliente: { id: cliente.id, nombre: cliente.nombre, ciudad: cliente.ciudad, plan: cliente.plan },
    pagos,
    meses
  });
});

// ============================================================
// RECIBO EN PDF de un pago puntual — se abre directo en el navegador
// ============================================================
function formatearCOP(numero) {
  return '$' + Number(numero || 0).toLocaleString('es-CO');
}

function formatearFechaLarga(fechaISO) {
  if (!fechaISO) return '—';
  const [anio, mes, dia] = fechaISO.split('-');
  return `${dia} de ${NOMBRES_MES[parseInt(mes, 10) - 1]} de ${anio}`;
}

app.get('/api/clientes/:id/recibo/:pagoId', (req, res) => {
  const clientes = leerClientes();
  const cliente = buscarCliente(clientes, req.params.id);
  if (!cliente) return res.status(404).send('Local no encontrado');

  const pago = (cliente.historial_pagos || []).find(p => p.id === req.params.pagoId);
  if (!pago) return res.status(404).send('Pago no encontrado');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="recibo-${cliente.id}-${pago.id}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  // ---------- Encabezado ----------
  doc.rect(0, 0, doc.page.width, 110).fill('#0c2b4e');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('BILLAR CLASS', 50, 38);
  doc.font('Helvetica').fontSize(10.5).fillColor('#bcd6f5').text('Sistema de suscripción para salones de billar', 50, 66);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('RECIBO DE PAGO', 0, 42, { align: 'right', width: doc.page.width - 50 });
  doc.font('Helvetica').fontSize(10).fillColor('#bcd6f5').text(`No. ${pago.id}`, 0, 62, { align: 'right', width: doc.page.width - 50 });

  doc.fillColor('#1a1a1a');

  // ---------- Datos del recibo ----------
  let y = 140;
  doc.font('Helvetica-Bold').fontSize(11).text('Establecimiento', 50, y);
  doc.font('Helvetica').fontSize(12).text(cliente.nombre || '—', 50, y + 16);
  doc.font('Helvetica').fontSize(10).fillColor('#555').text(cliente.ciudad ? `${cliente.ciudad}, Colombia` : '', 50, y + 34);
  doc.fillColor('#1a1a1a');

  doc.font('Helvetica-Bold').fontSize(11).text('Fecha de pago', 320, y);
  doc.font('Helvetica').fontSize(12).text(formatearFechaLarga(pago.fecha_pago), 320, y + 16);

  y += 80;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#dddddd').stroke();
  y += 20;

  // ---------- Tabla del concepto ----------
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#555').text('CONCEPTO', 50, y);
  doc.text('PERÍODO CUBIERTO', 300, y);
  doc.text('VALOR', 460, y, { width: 90, align: 'right' });
  y += 18;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#dddddd').stroke();
  y += 12;

  doc.font('Helvetica').fontSize(11).fillColor('#1a1a1a');
  doc.text(pago.concepto || `Pago plan ${cliente.plan || ''}`, 50, y, { width: 240 });
  const periodoTexto = pago.cubre_desde ? `${formatearFechaLarga(pago.cubre_desde)}\na ${formatearFechaLarga(pago.cubre_hasta)}` : '—';
  doc.text(periodoTexto, 300, y, { width: 150 });
  doc.font('Helvetica-Bold').text(formatearCOP(pago.monto), 460, y, { width: 90, align: 'right' });

  y += 70;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#dddddd').stroke();
  y += 16;

  doc.font('Helvetica-Bold').fontSize(13).text('TOTAL PAGADO', 300, y);
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0c2b4e').text(formatearCOP(pago.monto), 460, y - 2, { width: 90, align: 'right' });

  // ---------- Pie de página ----------
  const yPie = doc.page.height - 120;
  doc.moveTo(50, yPie).lineTo(doc.page.width - 50, yPie).strokeColor('#dddddd').stroke();
  doc.font('Helvetica').fontSize(9.5).fillColor('#888')
    .text('Este recibo certifica el pago de la suscripción al sistema Billar Class para el establecimiento indicado.', 50, yPie + 14, { width: doc.page.width - 100 })
    .text(`Generado automáticamente el ${formatearFechaLarga(hoyISO())}.`, 50, yPie + 30, { width: doc.page.width - 100 });

  doc.end();
});

// ---------- Ruta de prueba original ----------
app.get('/api/datos', (req, res) => {
  res.json({
    mensaje: '¡Hola! Servidor Billar Class en Railway',
    timestamp: new Date(),
    estado: 'funcionando'
  });
});

// ---------- Conexión en vivo (Socket.io) ----------
io.on('connection', (socket) => {
  console.log('Una pantalla se conectó en vivo:', socket.id);

  // Cada pantalla (mostrador o pantalla táctil) se une a la "sala" de su local
  socket.on('unirse-local', (localId) => {
    socket.join(localId);
    socket.localId = localId;
  });

  // El Mostrador (Nivel 2) envía el estado de la mesa (tiempo, consumo, etc.)
  // y se retransmite SOLO a las pantallas del mismo local (ej. la Pantalla Táctil, Nivel 3)
  socket.on('mesa:actualizar', (data) => {
    if (!data || !data.id) return;
    socket.to(data.id).emit('mesa:actualizar', data);
  });

  socket.on('disconnect', () => {
    console.log('Una pantalla se desconectó:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor Billar Class corriendo en puerto ${PORT}`);
});
