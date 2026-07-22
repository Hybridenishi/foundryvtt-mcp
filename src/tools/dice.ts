import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface DiceDetail {
  notation: string;
  rolls: number[];
  kept: number[];
  total: number;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function normalizeFormula(formula: string): string {
  return formula.trim()
    .replace(/\badvantage\b|\badv\b/gi, "2d20kh1")
    .replace(/\bdisadvantage\b|\bdis\b/gi, "2d20kl1")
    .replace(/d%/gi, "d100");
}

/** A small fallback used only when the optional package is unavailable at runtime. */
function fallbackRoll(formula: string): { total: number; rolls: DiceDetail[] } {
  const expression = normalizeFormula(formula);
  const details: DiceDetail[] = [];
  const arithmetic = expression.replace(/(\d*)d(\d+)(k[hl]\d+)?/gi, (_match, rawCount: string, rawSides: string, keep: string | undefined) => {
    const count = rawCount === "" ? 1 : Number(rawCount);
    const sides = Number(rawSides);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sides) || count < 1 || count > 1_000 || sides < 1 || sides > 1_000_000) {
      throw new Error("Dice count and sides must be positive, reasonable integers");
    }
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    let kept = [...rolls];
    if (keep) {
      const number = Number(keep.slice(2));
      if (!Number.isSafeInteger(number) || number < 1 || number > count) throw new Error("Invalid keep modifier");
      kept = [...rolls].sort((a, b) => keep[1] === "h" ? b - a : a - b).slice(0, number);
    }
    const notation = `${count}d${sides}${keep ?? ""}`;
    const total = kept.reduce((sum, value) => sum + value, 0);
    details.push({ notation, rolls, kept, total });
    return String(total);
  });
  if (!/^[\d\s()+\-*/.]+$/.test(arithmetic)) throw new Error("Unsupported dice formula");
  const total = Function(`"use strict"; return (${arithmetic});`)();
  if (typeof total !== "number" || !Number.isFinite(total)) throw new Error("Formula did not produce a finite total");
  return { total, rolls: details };
}

async function roll(formula: string): Promise<{ formula: string; total: number; rolls: unknown }> {
  const normalized = normalizeFormula(formula);
  try {
    // A variable import specifier lets this project compile in restricted environments
    // before npm can download rpg-dice-roller; normal installations use the package.
    const packageName = "rpg-dice-roller";
    const diceModule: unknown = await import(packageName);
    const DiceRoll = (diceModule as { DiceRoll?: new (notation: string) => { total?: unknown; rolls?: unknown } }).DiceRoll;
    if (!DiceRoll) throw new Error("rpg-dice-roller does not export DiceRoll");
    const result = new DiceRoll(normalized);
    if (typeof result.total !== "number") throw new Error("Dice roll did not return a numeric total");
    return { formula: normalized, total: result.total, rolls: result.rolls ?? [] };
  } catch (error) {
    // Only missing-package errors merit a fallback. Parser errors from the package
    // should remain visible instead of silently rolling a different expression.
    if (!(error instanceof Error) || !/Cannot find package|Cannot find module/.test(error.message)) throw error;
    const fallback = fallbackRoll(normalized);
    return { formula: normalized, total: fallback.total, rolls: fallback.rolls };
  }
}

export function registerDiceTool(server: McpServer): void {
  server.registerTool(
    "roll_dice",
    {
      description: "Roll a dice formula (for example 4d6kh3, 1d20+5, d%, or adv).",
      inputSchema: { formula: z.string().min(1), label: z.string().optional() },
    },
    async ({ formula, label }) => {
      try {
        const result = await roll(formula);
        return textResult({ ...result, label });
      } catch (error) {
        return textResult({ error: error instanceof Error ? error.message : String(error), formula, label });
      }
    },
  );
}
