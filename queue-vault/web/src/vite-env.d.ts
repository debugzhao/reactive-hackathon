/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_NETWORK?: "testnet" | "devnet";
  readonly VITE_BASE_RPC_URL?: string;
  readonly VITE_LASNA_RPC_URL?: string;
  readonly VITE_LOOKBACK_BLOCKS?: string;
  readonly VITE_LOG_CHUNK?: string;
  readonly VITE_POLL_MS?: string;
  readonly VITE_LEGACY_K?: string;
  readonly VITE_REPO_URL?: string;
}
