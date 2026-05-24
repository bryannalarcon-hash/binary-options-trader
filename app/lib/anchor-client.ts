/**
 * Typed Anchor client placeholder.
 *
 * Once `anchor build` produces `target/idl/meridian.json`, we copy it over
 * `lib/meridian-idl.json` and generate a typed `Program<Meridian>` here.
 *
 * For the scaffold this file just exposes the IDL constant and the program id.
 */

import idl from "./meridian-idl.json";
import { env } from "./env";

export const MERIDIAN_IDL = idl;
export const MERIDIAN_PROGRAM_ID =
  env.programId || "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
