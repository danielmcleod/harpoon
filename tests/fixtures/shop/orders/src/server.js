import express from 'express'
import { Kafka } from 'kafkajs'
import pg from 'pg'

const app = express()
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const producer = new Kafka({ brokers: [process.env.KAFKA_BROKERS] }).producer()

app.post('/v1/orders', async (req, res) => {
  const order = await db.query('insert into orders(total) values ($1) returning *', [req.body.total])
  const charge = await fetch(`${process.env.PAYMENTS_URL}/v1/charge`, { method: 'POST', body: JSON.stringify({ orderId: order.rows[0].id, amount: req.body.total }) })
  await producer.send({ topic: 'order-events', messages: [{ value: JSON.stringify({ type: 'order.created', id: order.rows[0].id }) }] })
  res.status(201).json({ order: order.rows[0], charged: charge.ok })
})

app.get('/v1/orders/:id', async (req, res) => {
  const r = await db.query('select * from orders where id = $1', [req.params.id])
  res.json(r.rows[0])
})

app.listen(3000)
