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
  PUBLIC_URL,               // напр. https://archinvest.up.railway.app (БЕЗ слэша в конце!)
  SPW_CARD_ID,               // ID карты биржи (эскроу-счёт)
  SPW_CARD_TOKEN,            // токен карты биржи
  SPWMINI_APP_TOKEN,         // токен мини-приложения (из /apps/ на spworlds.ru)
} = process.env;

if (!SPW_CARD_ID || !SPW_CARD_TOKEN) {
  console.warn('[!] Не заданы SPW_CARD_ID / SPW_CARD_TOKEN — платежи работать не будут.');
}
if (!PUBLIC_URL) {
  console.warn('[!] Не задан PUBLIC_URL — платежи и вебхук работать не будут.');
}

const spw = new SPWorlds({ id: SPW_CARD_ID, token: SPW_CARD_TOKEN });

const app = express();

// ВАЖНО: /validate от spwmini должен стоять ДО express.json(),
// он сам читает тело запроса. Если поставить после — сломается.
if (SPWMINI_APP_TOKEN) {
  app.post('/validate', spwminiValidate(SPWMINI_APP_TOKEN));
}

// ВАЖНО: /api/webhook тоже должен стоять ДО express.json() по той же причине,
// что и /validate — SPWorlds подписывает СЫРОЕ тело запроса, а если
// express.json() успеет его распарсить первым, req.body станет объектом
// вместо строки, и проверка подписи будет всегда проваливаться (именно
// это и вызывало "статус висит на ожидании оплаты, хотя деньги списались").
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Хранилище заказов (простой JSON-файл, orders.json создаётся сам)
// --------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'orders.json');

function loadOrders() {
  if (!fs.existsSync(DB_PATH)) {
    // Пустая доска при первом запуске — никаких тестовых заказов по умолчанию
    const seed = [];
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
// GET /api/orders — список ВСЕХ заказов (без ограничения по количеству —
// доска резиновая и сама переносит карточки на новую строку)
// --------------------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const orders = loadOrders();
  res.json(orders);
});

// --------------------------------------------------------------------------
// POST /api/orders — создать новый заказ
// body: { title, description, budget, deadlineDays, customer, discordTag }
// --------------------------------------------------------------------------
app.post('/api/orders', (req, res) => {
  const { title, description, budget, deadlineDays, customer, discordTag } = req.body;

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
    discordTag: discordTag || '',
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
// DELETE /api/orders/:id — удалить заказ.
// Разрешено пока заказ ОТКРЫТ или ждёт оплаты (ещё не подтверждена оплата)
// и только автору заказа — это же страховка на случай, если вебхук оплаты
// не пришёл и статус завис на "ждёт оплаты". Проверка по нику — не железная
// защита (полноценная авторизация появится, когда сайт станет
// мини-приложением), но отсекает случайные/чужие удаления.
// body: { customer }
// --------------------------------------------------------------------------
app.delete('/api/orders/:id', (req, res) => {
  const { customer } = req.body;
  const orders = loadOrders();
  const order = orders.find((o) => o.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  if (!['open', 'awaiting_payment'].includes(order.status)) {
    return res.status(400).json({ error: 'Заказ уже в работе — отменить нельзя' });
  }
  if (order.customer !== customer) {
    return res.status(403).json({ error: 'Удалить заказ может только его автор' });
  }

  const filtered = orders.filter((o) => o.id !== order.id);
  saveOrders(filtered);
  res.status(204).end();
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
// Возвращает { code, url } — url открываем в новом окне (как FreshMarket)
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
      redirectUrl: `${PUBLIC_URL}?paid=${order.id}`,
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
  console.log(`Archinvest запущен на http://localhost:${PORT}`);
});
