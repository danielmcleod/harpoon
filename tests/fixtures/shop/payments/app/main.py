import os
import redis
import stripe
from fastapi import FastAPI

app = FastAPI()
cache = redis.from_url(os.environ["REDIS_URL"])
stripe.api_key = os.environ["STRIPE_API_KEY"]


@app.post("/v1/charge")
def charge(body: dict):
    key = f"charge:{body['orderId']}"
    if cache.get(key):
        return {"status": "duplicate"}
    intent = stripe.PaymentIntent.create(amount=body["amount"], currency="usd")
    cache.set(key, intent.id, ex=86400)
    return {"status": "ok", "intent": intent.id}


@app.post("/v1/refund")
def refund(body: dict):
    return stripe.Refund.create(payment_intent=body["intent"])
