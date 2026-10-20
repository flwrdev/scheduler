// Heading row for a card on the Scheduler page: a title, an optional grey description under
// it, and an optional action (usually a button) on the right.

import type { ReactNode } from "react";

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <s-grid
      gridTemplateColumns={action ? "1fr auto" : "1fr"}
      alignItems="center"
      gap="base"
    >
      <s-stack gap="small-500">
        <s-heading>{title}</s-heading>
        {description && <s-paragraph color="subdued">{description}</s-paragraph>}
      </s-stack>
      {action}
    </s-grid>
  );
}
