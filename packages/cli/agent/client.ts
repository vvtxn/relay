import { RelayClient } from "@vvtxn/client/client.ts";
import { resolveServerUrl } from "./config.ts";

export const serverUrl = resolveServerUrl();

export const client = new RelayClient({ baseUrl: serverUrl });
