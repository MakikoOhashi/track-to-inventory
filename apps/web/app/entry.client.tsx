import { HydratedRouter } from "react-router/dom";
import { hydrateRoot } from "react-dom/client";
import { StrictMode, startTransition } from "react";
import "./i18n";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>
  );
});
