#!/usr/bin/env bun
/**
 * SinwanJS CLI — project-wide reactive prop analyzer.
 *
 * Usage:
 *   bunx vite-plugin-sinwan analyze [root] [outFile]
 *
 * Writes `.sinwan/reactive-props.json` by default.
 */

import { runAnalyzeCli } from "sinwan-compiler";

runAnalyzeCli();
