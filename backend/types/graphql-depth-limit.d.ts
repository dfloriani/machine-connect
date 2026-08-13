/**
 * graphql-depth-limit ships no types, so this declares the single function
 * the server uses.
 */
declare module "graphql-depth-limit" {
  import type { ValidationContext } from "graphql";

  export default function depthLimit(
    maxDepth: number
  ): (context: ValidationContext) => Record<string, unknown>;
}
