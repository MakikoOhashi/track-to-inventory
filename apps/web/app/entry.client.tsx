import { RemixBrowser } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import { StrictMode, startTransition } from "react";
import "./i18n";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>
  );
});