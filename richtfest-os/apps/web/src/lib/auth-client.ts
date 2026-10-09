import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [magicLinkClient(), passkeyClient()],
});
