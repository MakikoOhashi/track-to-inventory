import { authenticate } from "~/shopify.server";
import sessionStorage from "../sessionStorage.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  const current = payload.current;

  if (session) {
    session.scope = current.toString();
    await sessionStorage.storeSession(session);
  }

  return new Response();
};
