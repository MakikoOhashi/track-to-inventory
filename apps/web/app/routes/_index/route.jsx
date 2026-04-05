import { Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";
import { useEffect } from "react";



export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const isEmbeddedEntry =
    url.searchParams.get("embedded") === "1" ||
    url.searchParams.has("host") ||
    url.searchParams.has("id_token");
  const shouldRedirect = isEmbeddedEntry || url.searchParams.get("shop");
  const redirectPath = `/app?${url.searchParams.toString()}`;

  return { showForm: Boolean(login), shouldRedirect, redirectPath };
};

export default function App() {
  const { showForm, shouldRedirect, redirectPath } = useLoaderData();

  useEffect(() => {
    if (shouldRedirect && typeof window !== "undefined") {
      window.location.replace(redirectPath);
    }
  }, [shouldRedirect, redirectPath]);

  if (shouldRedirect) {
    return (
      <div className={styles.index}>
        <div className={styles.content}>
          <h1 className={styles.heading}>Loading...</h1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>A short heading about [your app]</h1>
        <p className={styles.text}>
          A tagline about [your app] that describes your value proposition.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
        </ul>
      </div>
    </div>
  );
}
