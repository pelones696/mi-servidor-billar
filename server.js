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
 
// ---------- ENDPOINT PRINCIPAL: verificar si un local está activo ----------
app.get('/api/suscripcion/:id', (req, res) => {
  const clientes = leerClientes();
  const cliente = clientes.find(c => c.id === req.params.id);
 
  if (!cliente) {
    return res.status(404).json({
      encontrado: false,
      mensaje: 'Local no registrado en el sistema'
    });
  }
 
  res.json({
    encontrado: true,
    id: cliente.id,
    nombre: cliente.nombre,
    activo: cliente.activo,
    plan: cliente.plan,
    fecha_vencimiento: cliente.fecha_vencimiento,
    mensaje: cliente.activo
      ? 'Suscripción activa'
      : 'Suscripción no pagada. Contacta a soporte para reactivar tu servicio.'
  });
});
 
// ---------- Listar todos los clientes (para el panel dashboard) ----------
app.get('/api/clientes', (req, res) => {
  const clientes = leerClientes();
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
 
  // Avisa EN VIVO a todas las pantallas conectadas (mostradores) de este local
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
 
  // Avisa EN VIVO a todas las pantallas conectadas (mostradores) de este local
  io.emit('suscripcion:actualizada', { id: cliente.id, activo: false, nombre: cliente.nombre });
 
  res.json({ ok: true, mensaje: `${cliente.nombre} desactivado`, cliente });
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
    fecha_inicio: fecha_inicio || new Date().toISOString().slice(0, 10),
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
  socket.on('disconnect', () => {
    console.log('Una pantalla se desconectó:', socket.id);
  });
});
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor Billar Class corriendo en puerto ${PORT}`);
});