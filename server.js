const express = require('express');
const app = express();

app.use(express.static('public'));

app.get('/api/datos', (req, res) => {
  res.json({
    mensaje: "¡Hola! Servidor en Railway",
    timestamp: new Date(),
    estado: "funcionando"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});