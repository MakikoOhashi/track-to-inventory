import { createServer } from "node:http";
import { createRequestListener } from "@react-router/node";

const port = Number(process.env.PORT || 3000);
const mode = process.env.NODE_ENV || "production";

const listener = createRequestListener({
  build: () => import("./build/server/index.js"),
  mode,
});

createServer(listener).listen(port, () => {
  console.log(`Web server listening on http://0.0.0.0:${port}`);
});
