import { z } from "zod";

const documentSchema = z
  .object({
    _id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const worldDataSchema = z
  .object({
    actors: z.array(documentSchema).default([]),
    scenes: z.array(documentSchema).default([]),
    items: z.array(documentSchema).default([]),
    journal: z.array(documentSchema).default([]),
    messages: z.array(documentSchema).default([]),
    combats: z.array(documentSchema).default([]),
    users: z.array(documentSchema).default([]),
    folders: z.array(documentSchema).default([]),
  })
  .passthrough();

export type WorldData = z.infer<typeof worldDataSchema>;
