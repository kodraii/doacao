// backend/server.js
require('dotenv').config();
const express = require('express');
const mercadopago = require('mercadopago');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const basicAuth = require('express-basic-auth');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const mongoClient = new MongoClient(process.env.MONGO_URI, { useUnifiedTopology: true });
let db, paymentsCollection;

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db('doacoes-kodrai');
  paymentsCollection = db.collection('payments');
  console.log('MongoDB conectado');
}
connectDB().catch(console.error);

app.post('/create_payment', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });

    const preference = {
      items: [{
        title: 'Doação',
        quantity: 1,
        currency_id: 'BRL',
        unit_price: parseFloat(amount),
      }],
      payment_methods: {
        excluded_payment_types: [{ id: 'atm' }],
      },
      back_urls: {
        success: `${BASE_URL}/success.html`,
        failure: `${BASE_URL}/failure.html`,
        pending: `${BASE_URL}/pending.html`,
      },
      auto_return: 'approved',
      notification_url: `${BASE_URL}/webhook`,
    };

    const mpResponse = await mercadopago.preferences.create(preference);

    await paymentsCollection.insertOne({
      preference_id: mpResponse.body.id,
      status: 'pending',
      amount: parseFloat(amount),
      created_at: new Date(),
    });

    res.json({ init_point: mpResponse.body.init_point });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const paymentId = req.query.id || req.body.data?.id;
    if (!paymentId) {
      return res.status(400).send('No payment id');
    }

    const payment = await mercadopago.payment.findById(paymentId);

    if (payment.body.status === 'approved') {
      const token = crypto.randomBytes(8).toString('hex');

      await paymentsCollection.updateOne(
        { preference_id: payment.body.preference_id },
        {
          $set: {
            status: 'approved',
            payment_id: paymentId,
            token,
            approved_at: new Date(),
          },
        }
      );
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro no webhook');
  }
});

app.get('/acesso/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const payment = await paymentsCollection.findOne({ token, status: 'approved' });
    if (!payment) {
      return res.status(404).send('Link inválido ou não autorizado.');
    }

    res.redirect('https://seu-dominio.com/conteudo-secreto.html');
  } catch (err) {
    res.status(500).send('Erro interno');
  }
});

app.use(
  '/admin',
  basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,
  })
);

app.get('/admin', async (req, res) => {
  const pagamentos = await paymentsCollection.find({}).sort({ created_at: -1 }).toArray();

  let html = `
    <h1>Painel de Doações</h1>
    <table border="1" cellpadding="5" cellspacing="0">
      <tr>
        <th>ID Pagamento</th>
        <th>Status</th>
        <th>Valor</th>
        <th>Token</th>
        <th>Data</th>
      </tr>`;

  pagamentos.forEach((p) => {
    html += `<tr>
      <td>${p.payment_id || '-'}</td>
      <td>${p.status}</td>
      <td>R$ ${p.amount.toFixed(2)}</td>
      <td>${p.token || '-'}</td>
      <td>${p.created_at.toISOString()}</td>
    </tr>`;
  });

  html += `</table>`;
  res.send(html);
});

app.use(express.static('frontend'));

app.listen(PORT, () => {
  console.log(\`Servidor rodando na porta \${PORT}\`);
});
