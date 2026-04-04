import { HydratedRouter } from "react-router/dom";
import { createRoot } from "react-dom/client";
import { startTransition } from "react";
import "./i18n";

startTransition(() => {
  createRoot(document).render(<HydratedRouter />);
});
