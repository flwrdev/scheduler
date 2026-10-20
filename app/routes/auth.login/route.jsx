// Login page for entering a shop domain. The loader and the action both call login(), which
// starts the OAuth flow for a valid domain or returns an error shown under the field.

import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { POLARIS_URL } from "../../lib/polaris-url";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  // eslint-disable-next-line no-undef
  return { errors, apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;
  const apiKey = loaderData.apiKey;

  return (
    <AppProvider apiKey={apiKey} polarisUrl={POLARIS_URL}>
      <s-page>
        <Form method="post">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onInput={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
