// Route table. Uses file-system routing (flatRoutes): every file in app/routes becomes a URL.
// Dots in a file name become slashes, e.g. app.orders.tsx -> /app/orders and
// apps.schedule-rules.reschedule.ts -> /apps/schedule-rules/reschedule.

import { flatRoutes } from "@react-router/fs-routes";

export default flatRoutes();
