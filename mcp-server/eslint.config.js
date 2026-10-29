import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["build/", "node_modules/", "eval/", "dist-mcp/", "dist-mcpb/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
