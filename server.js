// ==========================================================================
// Archinvest — сервер стройбиржи для SPWorlds
// ==========================================================================
// Что тут происходит:
//  1. Храним заказы (в файле orders.json — просто и надёжно для старта,
//     потом можно заменить на настоящую БД, структура кода это позволяет)
//  2. Принимаем оплату заказчика на карту БИРЖИ через SPWorlds Payments API
//     (это и есть "эскроу" — деньги лежат на карте биржи, а не у мастера)
//  3. Когда заказчик подтверждает приёмку — переводим АРы со счёта биржи
//     на карту мастера через createTransaction
//  4. /validate — эндпоинт, которым spwmini на фронте проверяет, что
//     пользователь не подделан
// ==========================================================================

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { SPWorlds } = require('spworlds');
const { validate: spwminiValidate, checkUser } = require('spwmini/middleware');

const {
  PORT = 3000,
  PUBLIC_URL,               // напр. https://podryad.example.com
  SPW_CARD_ID,               // ID карты биржи (эскроу-счёт)
  SPW_CARD_TOKEN,            // токен карты биржи
  SPWMINI_APP_TOKEN,         // токен мини-приложения (из /apps/ на spworlds.ru)
} = process.env;

if (!SPW_CARD_ID || !SPW_CARD_TOKEN) {
  console.warn('[!] Не заданы SPW_CARD_ID / SPW_CARD_TOKEN в .env — платежи работать не будут.');
}

const spw = new SPWorlds({ id: SPW_CARD_ID, token: SPW_CARD_TOKEN });

const app = express();

// ВАЖНО: /validate от spwmini должен стоять ДО express.json(),
// он сам читает тело запроса. Если поставить после — сломается.
if (SPWMINI_APP_TOKEN) {
  app.post('/validate', spwminiValidate(SPWMINI_APP_TOKEN));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Хранилище заказов (простой JSON-файл, orders.json создаётся сам)
// --------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'orders.json');

function loadOrders() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = [
      {
        id: 14,
        title: 'Жилой дом 8×8',
        description: 'Японский стиль, дерево + камень',
        budget: 240,
        deadlineDays: 3,
        status: 'open',            // open -> in_progress -> review -> done
        customer: null,            // ник заказчика
        builder: null,             // ник и карта мастера
        builderCard: null,
        paymentCode: null,
        createdAt: Date.now(),
      },
      {
        id: 15,
        title: 'Автоферма мобов',
        description: 'Тёмная, с сортировкой добычи',
        budget: 500,
        deadlineDays: 5,
        status: 'open',
        customer: null,
        builder: null,
        builderCard: null,
        paymentCode: null,
        createdAt: Date.now(),
      },
    ];
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveOrders(orders) {
  fs.writeFileSync(DB_PATH, JSON.stringify(orders, null, 2));
}

function nextId(orders) {
  return orders.reduce((max, o) => Math.max(max, o.id), 0) + 1;
}

// --------------------------------------------------------------------------
// GET /api/orders — список всех заказов
// --------------------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const orders = loadOrders();
  res.json(orders);
});

// --------------------------------------------------------------------------
// POST /api/orders — создать новый заказ
// body: { title, description, budget, deadlineDays, customer }
// --------------------------------------------------------------------------
app.post('/api/orders', (req, res) => {
  const { title, description, budget, deadlineDays, customer } = req.body;

  if (!title || !budget || !customer) {
    return res.status(400).json({ error: 'Нужны title, budget и customer' });
  }

  const orders = loadOrders();
  const order = {
    id: nextId(orders),
    title,
    description: description || '',
    budget: Number(budget),
    deadlineDays: Number(deadlineDays) || 3,
    status: 'open',
    customer,
    builder: null,
    builderCard: null,
    paymentCode: null,
    createdAt: Date.now(),
  };

  orders.push(order);
  saveOrders(orders);
  res.status(201).json(order);
});

// --------------------------------------------------------------------------
// POST /api/orders/:id/assign — заказчик выбрал мастера
// body: { builder, builderCard }  (ник мастера и номер его карты для выплаты)
// --------------------------------------------------------------------------
app.post('/api/orders/:id/assign', (req, res) => {
  const { builder, builderCard } = req.body;
  const orders = loadOrders();
  const order = orders.find((o) => o.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'open') return res.status(400).json({ error: 'Заказ уже занят' });
  if (!builder || !builderCard) return res.status(400).json({ error: 'Нужны builder и builderCard' });

  order.builder = builder;
  order.builderCard = builderCard;
  order.status = 'awaiting_payment';
  saveOrders(orders);
  res.json(order);
});

// --------------------------------------------------------------------------
// POST /api/orders/:id/pay — создать эскроу-платёж заказчика на карту биржи
// Возвращает { code } — этот код передаётся в spm.openPayment(code) на фронте
// --------------------------------------------------------------------------
app.post('/api/orders/:id/pay', async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'awaiting_payment') {
    return res.status(400).json({ error: 'Заказ не готов к оплате' });
  }

  try {
    const payment = await spw.initPayment({
      items: [
        {
          name: `Заказ №${order.id}: ${order.title}`,
          count: 1,
          price: order.budget,
          comment: `Эскроу-платёж за заказ №${order.id}`,
        },
      ],
      // '#MINIAPP' — обязательное значение, если открываем окно оплаты
      // через spm.openPayment() внутри мини-приложения на spworlds.ru
      redirectUrl: '#MINIAPP',
      webhookUrl: `${PUBLIC_URL}/api/webhook`,
      data: String(order.id),
    });

   order.paymentCode = payment.code;
    saveOrders(orders);

    res.json({ code: payment.code, url: payment.url });
  } catch (err) {
    console.error('Ошибка создания платежа:', err);
    res.status(502).json({ error: 'Не удалось создать платёж' });
  }
});

// --------------------------------------------------------------------------
// POST /api/webhook — сюда SPWorlds шлёт уведомление об успешной оплате
// --------------------------------------------------------------------------
app.post(
  '/api/webhook',
  express.raw({ type: '*/*' }), // нужно сырое тело, чтобы проверить подпись
  (req, res) => {
    const rawBody = req.body.toString('utf-8');
    const hashHeader = req.headers['x-body-hash'];

    if (!spw.validateHash(rawBody, hashHeader)) {
      console.warn('[webhook] невалидная подпись — запрос проигнорирован');
      return res.status(400).end();
    }

    const payload = JSON.parse(rawBody);
    const orderId = Number(payload.data); // мы передавали id заказа в data

    const orders = loadOrders();
    const order = orders.find((o) => o.id === orderId);

    if (order && order.status === 'awaiting_payment') {
      order.status = 'in_progress';
      saveOrders(orders);
      console.log(`[webhook] заказ №${orderId} оплачен, деньги в эскроу`);
    }

    res.status(200).end();
  }
);

// --------------------------------------------------------------------------
// POST /api/orders/:id/review — мастер сдаёт работу
// --------------------------------------------------------------------------
app.post('/api/orders/:id/review', (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'in_progress') {
    return res.status(400).json({ error: 'Заказ ещё не оплачен или уже закрыт' });
  }

  order.status = 'review';
  saveOrders(orders);
  res.json(order);
});

// --------------------------------------------------------------------------
// POST /api/orders/:id/complete — заказчик подтвердил приёмку.
// Переводим АРы со счёта биржи на карту мастера — эскроу закрывается.
// --------------------------------------------------------------------------
app.post('/api/orders/:id/complete', async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (order.status !== 'review') {
    return res.status(400).json({ error: 'Заказ не готов к завершению' });
  }

  try {
    await spw.createTransaction({
      receiver: order.builderCard,
      amount: order.budget,
      comment: `Оплата за заказ №${order.id}: ${order.title}`,
    });

    order.status = 'done';
    saveOrders(orders);
    res.json(order);
  } catch (err) {
    console.error('Ошибка выплаты мастеру:', err);
    res.status(502).json({ error: 'Не удалось выполнить перевод мастеру' });
  }
});

// --------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ПОДРЯД запущен на http://localhost:${PORT}`);
});
