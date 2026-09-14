const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
 
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});
 
app.use(express.json());
app.use(express.static('public'));
 
const RUTA_DATOS = path.join(__dirname, 'data', 'clientes.json');
 
// ---------- Utilidades para leer/escribir la "base de datos" (archivo JSON) ----------
function leerClientes() {
  const contenido = fs.readFileSync(RUTA_DATOS, 'utf-8');
  return JSON.parse(contenido);
}
 
function guardarClientes(clientes) {
  fs.writeFileSync(RUTA_DATOS, JSON.stringify(clientes, null, 2), 'utf-8');
}
 
function hoyISO() {
  return new Date().toISOString().slice(0, 10);
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
  const cliente = clientes.find(c => c.id === req.params.id);
 
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
 
// ---------- Activar un local ----------
app.post('/api/suscripcion/:id/activar', (req, res) => {
  const clientes = leerClientes();
  const cliente = clientes.find(c => c.id === req.params.id);
 
  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }
 
  cliente.activo = true;
  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: true, nombre: cliente.nombre });
 
  res.json({ ok: true, mensaje: `${cliente.nombre} activado`, cliente });
});
 
// ---------- Desactivar un local ----------
app.post('/api/suscripcion/:id/desactivar', (req, res) => {
  const clientes = leerClientes();
  const cliente = clientes.find(c => c.id === req.params.id);
 
  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }
 
  cliente.activo = false;
  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: false, nombre: cliente.nombre });
 
  res.json({ ok: true, mensaje: `${cliente.nombre} desactivado`, cliente });
});
 
// ---------- Actualizar fecha de vencimiento (renovar) ----------
app.post('/api/suscripcion/:id/renovar', (req, res) => {
  const clientes = leerClientes();
  const cliente = clientes.find(c => c.id === req.params.id);
 
  if (!cliente) {
    return res.status(404).json({ ok: false, mensaje: 'Local no encontrado' });
  }
 
  const { fecha_vencimiento } = req.body;
  if (fecha_vencimiento) cliente.fecha_vencimiento = fecha_vencimiento;
  cliente.activo = true;
  guardarClientes(clientes);
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: true, nombre: cliente.nombre });
 
  res.json({ ok: true, mensaje: `${cliente.nombre} renovado`, cliente });
});
 
// ---------- Agregar un nuevo local ----------
app.post('/api/clientes', (req, res) => {
  const clientes = leerClientes();
  const { nombre, ciudad, telefono, plan, valor, fecha_inicio, fecha_vencimiento } = req.body;
 
  const siguienteNumero = clientes.length + 1;
  const nuevoId = `local-${siguienteNumero}`;
 
  const nuevoCliente = {
    id: nuevoId,
    nombre: nombre || 'Sin nombre',
    ciudad: ciudad || '',
    telefono: telefono || '',
    plan: plan || 'Mensual',
    valor: valor || 100000,
    fecha_inicio: fecha_inicio || hoyISO(),
    fecha_vencimiento: fecha_vencimiento || '',
    activo: true
  };
 
  clientes.push(nuevoCliente);
  guardarClientes(clientes);
  res.json({ ok: true, cliente: nuevoCliente });
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
 