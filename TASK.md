# backend-test-webhook-subscription

## Формат
- Документ с конкретикой, статусами и идемпотентностью
- Ничего не запускаем
- Допускается псевдокод

## Тест 1. Надежный webhook платежа и подписка

### Цель
Надежная обработка webhook платежей: идемпотентность, транзакции, восстановление, валидация, дебаг.

### Основные сущности (минимум)

**Subscription**
- id (uuid)
- userId (uuid)
- status: `inactive | active | past_due | canceled`
- currentPeriodStart (timestamp)
- currentPeriodEnd (timestamp)
- canceledAt (timestamp|null)
- createdAt, updatedAt

**PaymentEvent** (журнал webhook)
- id (uuid)
- providerEventId (string, уникальный)
- provider (string)
- rawPayload (jsonb)
- receivedAt (timestamp)
- processedAt (timestamp|null)
- status: `received | processed | rejected | failed`
- reason (string|null)
- signatureValid (boolean)
- idempotencyKey (string, уникальный)

**Payment**
- id (uuid)
- subscriptionId (uuid)
- amount (integer)
- currency (string)
- paidAt (timestamp)
- providerPaymentId (string, уникальный)
- status: `succeeded | failed | refunded`

### Уникальности (критично)
- `PaymentEvent.providerEventId` уникален
- `Payment.providerPaymentId` уникален
- `PaymentEvent.idempotencyKey` уникален

### Статусы событий
- `received` — принято, но еще не обработано
- `processed` — обработано успешно, подписка обновлена
- `rejected` — отклонено (невалидная подпись / критичные поля отсутствуют)
- `failed` — ошибка обработки (временная, можно ретраить)

### Валидация и безопасность
- Проверка подписи webhook (HMAC/асимметрия провайдера)
- Минимальная схема: `eventId`, `eventType`, `subscriptionId`, `paymentId`, `amount`, `currency`, `paidAt`
- Если критичных полей нет — `rejected` с `reason`
- rawPayload сохраняем всегда для дебага

### Идемпотентность
Ключи идемпотентности:
- `providerEventId` (главный)
- `providerPaymentId` (для платежа)
- Плюс составной `idempotencyKey = provider + ":" + providerEventId`

Поведение:
- При повторном webhook: находим `PaymentEvent` по `providerEventId`
  - если `processed` → вернуть 200 и не менять данные
  - если `received/failed` → можно повторить обработку
  - если `rejected` → вернуть 200, без изменений

### Обработка не по порядку
Webhook может прийти задним числом или раньше другого события:
- Используем `paidAt` и сравниваем с `currentPeriodEnd`
- Принцип: подписка продлевается от **max(currentPeriodEnd, paidAt)**
- Если событие пришло "раньше" и не влияет на период — сохраняем платеж, но подписку не меняем

### Логика продления (псевдокод)
```
begin transaction
  validate signature
  upsert PaymentEvent (received)
  if event already processed -> return ok

  validate required fields
  upsert Payment by providerPaymentId

  sub = lock subscription row for update
  if payment.status != succeeded -> mark event processed, return ok

  base = max(sub.currentPeriodEnd, payment.paidAt)
  newEnd = base + periodDuration

  if sub.status in (inactive, past_due) and payment.succeeded:
    sub.status = active
    sub.currentPeriodStart = base
  sub.currentPeriodEnd = newEnd

  save sub
  mark PaymentEvent processed
commit
```

### Транзакции и блокировки
- `SELECT ... FOR UPDATE` на подписке
- Все изменения (PaymentEvent + Payment + Subscription) в одной транзакции
- При конфликте уникальности — повторная попытка безопасна

### Восстановление и ретраи
- В таблице `PaymentEvent` `failed` с `reason`
- Фоновый job: переобработка `failed`/`received` старше N секунд
- Метрика retry_count (если нужно, можно добавить)

### Дебаг и наблюдаемость
- Корреляция по `providerEventId`
- Логи: входной payload, результат валидации, итоговый статус
- Метрики: количество `received/processed/rejected/failed`

### Результат
- Без дублей платежей
- Подписка активируется/продлевается корректно
- Повторы webhook безопасны
- Поздние/ранние события не ломают период

## Часть 1. Схема данных и уникальности

### Таблицы (минимум)

**users**
- id (uuid, PK)
- email (string, unique)
- password (string)
- createdAt (timestamp)

Уникальности:
- `email` — не допускаем дубль пользователя.

Индексы:
- `email` (unique) — быстрый поиск по логину и почте.

**subscriptions**
- id (uuid, PK)
- userId (uuid, FK -> users.id)
- status: `inactive | active | past_due | canceled`
- currentPeriodStart (timestamp)
- currentPeriodEnd (timestamp)
- createdAt, updatedAt

Уникальности:
- `userId` (unique) — одна активная подписка на пользователя.

Индексы:
- `userId` (unique) — быстрый доступ к подписке пользователя.
- `status` — выборки активных/просроченных.

**payments**
- id (uuid, PK)
- subscriptionId (uuid, FK -> subscriptions.id)
- providerPaymentId (string, unique)
- amount (integer)
- currency (string)
- paidAt (timestamp)
- status: `succeeded | failed | refunded`
- createdAt

Уникальности:
- `providerPaymentId` — предотвращает дубль платежа при повторном webhook.

Индексы:
- `subscriptionId, paidAt` — история платежей по подписке.
- `status` — аналитика и ретраи.

**webhook_events**
- id (uuid, PK)
- providerEventId (string, unique)
- provider (string)
- idempotencyKey (string, unique)
- eventType (string)
- status: `received | processed | rejected | failed`
- receivedAt (timestamp)
- processedAt (timestamp|null)
- rawPayload (jsonb)

Уникальности:
- `providerEventId` — основной ключ идемпотентности.
- `idempotencyKey` — доп. защита при мульти-провайдерах.

Индексы:
- `providerEventId` (unique) — быстрый дедуп.
- `status, receivedAt` — выборка для ретраев.
- `provider` — фильтр по провайдеру.

### Как предотвращаем дубль payment и повторное продление
- `payments.providerPaymentId` уникален → повторный webhook не создаст новый платеж.
- `webhook_events.providerEventId` уникален → повторный webhook отмечается как уже обработанный.
- В обработке: если `webhook_events.status = processed`, возвращаем 200 и **не** трогаем подписку.
