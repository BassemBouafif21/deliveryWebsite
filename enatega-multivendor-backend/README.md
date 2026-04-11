# Enatega Local Backend

This folder provides a self-hosted backend that replaces the missing proprietary API for local development.

It exposes:

- `POST /graphql` for queries and mutations
- `WS /graphql` for real-time subscriptions (compatible with `subscriptions-transport-ws`)
- `POST /stripe/account` mock endpoint used by dashboard flows
- `GET /health` health/status endpoint

## Quick Start

```bash
cd enatega-multivendor-backend
npm install
npm run dev
```

Server default URL: `http://localhost:8001/graphql`

WebSocket URL: `ws://localhost:8001/graphql`

## Demo Account

- Email: `demo@enatega.local`
- Password: `12345678`

## Notes

- Data is seeded in memory on startup (users, restaurants, orders, rider, chats).
- Place-order, chat, and status updates are shared across clients using the same backend process.
- Unknown GraphQL operations fall back to safe mock responses so non-core screens do not crash immediately.
