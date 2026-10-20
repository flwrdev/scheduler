# Delivery Scheduler

Delivery Scheduler is a merchant operations app built for Shopify stores that need to manage order delivery timing, reschedule deliveries based on business rules, and keep customers informed with automated email notifications.

It gives merchants a simple dashboard to manage incoming orders, apply delivery rules, and adjust delivery windows without manually updating every order.

## Why this app exists

Many merchants need to coordinate order fulfillment and delivery timing manually. This creates delays, errors, and poor customer communication.

Delivery Scheduler helps merchants:
- view incoming orders in one place
- apply delivery timing rules
- reschedule orders automatically or manually
- send notification emails to customers or internal teams
- manage delivery operations from a centralized dashboard

## What the app does

- Manage incoming order data from Shopify
- Display orders in a merchant-friendly dashboard
- Apply scheduling logic and delivery rules
- Reschedule orders based on merchant-defined criteria
- Send email notifications through SMTP using Nodemailer
- Store operational data in Neon Postgres
- Run in a cloud-hosted environment on Google Cloud

## Key features

### Order management
- View incoming orders
- See status and delivery timeline
- Filter and review orders by date, customer, or delivery window

### Delivery scheduling
- Set rules for rescheduling deliveries
- Automatically adjust delivery dates based on business logic
- Support merchant-driven scheduling workflows

### Communication
- Send status or reschedule emails
- Notify customers or staff when order timing changes

### Merchant experience
- Built with Shopify Polaris web components (Polaris 2.0) for a familiar Shopify admin experience
- Designed for fast decision-making in a merchant operations workflow

## How it works

1. Orders are pulled into the app from the Shopify ecosystem.
2. Merchant rules determine delivery timing and rescheduling logic.
3. Orders are updated in the system and saved in the database.
4. Email notifications are triggered through an SMTP mailer.
5. Merchants can review, manage, and adjust operations in the dashboard.

## Tech stack

- Frontend: React + Shopify Polaris web components (Polaris 2.0)
- Backend: Node.js / TypeScript
- Database: Neon Postgres
- Email: Nodemailer
- Hosting: Google Cloud
- Platform integration: Shopify

## Project structure

```bash
.
├── src/
├── server/
├── config/
├── prisma/
├── migrations/
├── public/
├── .env.example
├── package.json
├── README.md
└── ...
