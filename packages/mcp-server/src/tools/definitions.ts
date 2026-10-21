/**
 * The 9 tools: names, descriptions and schemas. Zod is the single source for validation and the published JSON Schema.
 * Names and schemas must stay stable: Alexa refreshes tool info only when the add-on is redeployed.
 * Adding, renaming or dropping a tool needs human approval.
 */
import { z } from 'zod';
import { MESSAGE_MAX, MOODS, NOTE_MAX } from '@care-circle/core';

export const TOOL_NAMES = [
  'care_circle_help',
  'join_circle',
  'check_in',
  'get_todays_doses',
  'log_dose',
  'message_circle',
  'get_status',
  'get_week_summary',
  'set_sharing',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that work without a linked account. */
export const PUBLIC_TOOLS: ReadonlySet<string> = new Set<ToolName>(['care_circle_help']);

export const CARD_URI = 'ui://care-circle/today';

// ---------------------------------------------------------------- shared output pieces

const speech = z.string().describe('What to say, in at most two sentences.');

export const cardDataSchema = z.object({
  recipientName: z.string(),
  date: z.string(),
  dateLabel: z.string(),
  paused: z.boolean(),
  checkIn: z.object({
    status: z.enum(['done', 'open', 'missed']),
    at: z.string().optional(),
    mood: z.enum(MOODS).optional(),
  }),
  doses: z.array(
    z.object({
      name: z.string(),
      time: z.string(),
      status: z.enum(['open', 'taken', 'skipped', 'missed']),
      /** Present when the viewer can log doses from the card (tap-to-log). */
      doseId: z.string().optional(),
    }),
  ),
  /** True only on the cared-for person's own card: the card may offer tap-to-log. */
  canLog: z.boolean().optional(),
});
export type CardData = z.infer<typeof cardDataSchema>;

const doseRef = z.object({ doseId: z.string(), name: z.string(), time: z.string() });

// ---------------------------------------------------------------- inputs

export const inputs = {
  care_circle_help: z.object({}).strict(),
  join_circle: z
    .object({
      code: z
        .string()
        .regex(/^[0-9]{6}$/)
        .describe("The 6-digit join code from the family's Care Circle dashboard, digits only."),
      confirm: z.boolean().default(false).describe('True only after the person clearly said yes to the read-back.'),
    })
    .strict(),
  check_in: z
    .object({
      mood: z
        .enum(MOODS)
        .optional()
        .describe(
          'Optional. good = great, fine, well, wonderful; okay = alright, so-so, not bad, a bit tired; not_great = poorly, not good, rough, unwell.',
        ),
      note: z.string().max(NOTE_MAX).optional().describe("Optional short note for the family, in the person's own words."),
    })
    .strict(),
  get_todays_doses: z
    .object({
      part_of_day: z
        .enum(['morning', 'afternoon', 'evening', 'all'])
        .default('all')
        .describe('morning = before noon; afternoon = noon to 5 pm; evening = 5 pm or later; all = the whole day.'),
    })
    .strict(),
  log_dose: z
    .object({
      dose_id: z.string().max(80).optional().describe('ID from get_todays_doses, if known.'),
      medication_name: z
        .string()
        .max(60)
        .optional()
        .describe('Name or nickname as said, e.g. metformin, my blood pressure pill.'),
      part_of_day: z
        .enum(['morning', 'afternoon', 'evening'])
        .optional()
        .describe("Use for 'I took my morning pills' to log all open doses in that part of the day."),
      status: z
        .enum(['taken', 'skipped'])
        .describe("taken = took, had, swallowed, done; skipped = missed, didn't take, forgot, skipped."),
      confirm: z.boolean().default(false).describe('True only after the person said yes to a read-back of several doses.'),
    })
    .strict(),
  message_circle: z
    .object({
      message: z.string().min(1).max(MESSAGE_MAX).describe('The short message for the family, in the person\'s own words.'),
    })
    .strict(),
  get_status: z
    .object({
      person: z.string().max(40).optional().describe("Optional: the person's name or how they're referred to, e.g. Mom."),
    })
    .strict(),
  get_week_summary: z
    .object({
      days: z.number().int().min(1).max(14).default(7).describe('How many days back to summarize, 1 to 14. Default 7.'),
    })
    .strict(),
  set_sharing: z
    .object({
      paused: z.boolean().describe('true = pause sharing (take a break, stop sharing, privacy); false = resume sharing (turn it back on).'),
    })
    .strict(),
} satisfies Record<ToolName, z.ZodType>;

// ---------------------------------------------------------------- outputs

export const outputs = {
  care_circle_help: z.object({
    speech,
    role: z.enum(['recipient', 'admin', 'member', 'none']),
    disclaimer: z.string(),
  }),
  join_circle: z.object({
    speech,
    step: z.enum(['confirm', 'joined']),
    circleId: z.string(),
    role: z.enum(['recipient', 'member']),
    members: z.array(z.string()),
  }),
  check_in: z.object({
    speech,
    date: z.string(),
    at: z.string(),
    mood: z.enum(MOODS).optional(),
    crisis: z.boolean(),
    sharedWith: z.array(z.string()),
  }),
  get_todays_doses: z.object({
    speech,
    date: z.string(),
    doses: z.array(doseRef.extend({ status: z.enum(['open', 'taken', 'skipped', 'missed']) })),
    today: cardDataSchema,
  }),
  log_dose: z.object({
    speech,
    step: z.enum(['confirm', 'logged']),
    logged: z.array(z.object({ doseId: z.string(), name: z.string(), status: z.enum(['taken', 'skipped']), at: z.string() })),
    stillOpen: z.array(doseRef),
    pending: z.array(doseRef).optional(),
  }),
  message_circle: z.object({
    speech,
    sentTo: z.array(z.string()),
    crisis: z.boolean(),
  }),
  get_status: z.object({
    speech,
    date: z.string(),
    checkIn: z.object({ at: z.string(), mood: z.enum(MOODS).optional() }).nullable(),
    windowEnd: z.string(),
    doses: z.object({ logged: z.number().int(), open: z.number().int(), missed: z.number().int() }),
    hasNote: z.boolean(),
    paused: z.boolean(),
    today: cardDataSchema.optional(),
  }),
  get_week_summary: z.object({
    speech,
    days: z.number().int(),
    checkInDays: z.number().int(),
    expectedDays: z.number().int(),
    dosesLogged: z.number().int(),
    dosesScheduled: z.number().int(),
    misses: z.array(z.object({ date: z.string(), kind: z.enum(['check_in', 'dose']), name: z.string().optional() })).max(5),
    paused: z.boolean(),
  }),
  set_sharing: z.object({
    speech,
    paused: z.boolean(),
  }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolInput<N extends ToolName> = z.infer<(typeof inputs)[N]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof outputs)[N]>;

export interface ToolMeta {
  title: string;
  description: string;
  readOnly: boolean;
  card: boolean;
}

export const meta: Record<ToolName, ToolMeta> = {
  care_circle_help: {
    title: 'Care Circle help',
    description: 'Explains what Care Circle can do. Use for: what can you do, help, how does this work, what is Care Circle.',
    readOnly: true,
    card: false,
  },
  join_circle: {
    title: 'Join a Care Circle',
    description:
      "Joins the family's Care Circle with a 6-digit code from the family dashboard. First call reads back what will be shared; call again with confirm true only after the person says yes. Use for: my code is 482159, join my family's circle, I have a Care Circle code, sign me up with this code.",
    readOnly: false,
    card: false,
  },
  check_in: {
    title: 'Morning check-in',
    description:
      "Records that the person Care Circle looks after is up and okay today, with an optional mood and short note for the family. Use for: I'm up, good morning, tell my family I'm okay, check in, I'm awake, I'm feeling a bit tired today.",
    readOnly: false,
    card: false,
  },
  get_todays_doses: {
    title: "Today's medicines",
    description:
      "Lists today's scheduled medicines and whether each is logged, open first. Use for: what pills do I have, what medicines are left, what do I take this morning, did I have my pills, what's on my list today.",
    readOnly: true,
    card: true,
  },
  log_dose: {
    title: 'Log a medicine',
    description:
      "Logs a scheduled medicine as taken or skipped. Several at once (part_of_day) needs a read-back and confirm true after a yes. Use for: I took my metformin, I had my blood pressure pill, I took my morning pills, I skipped the lisinopril, I forgot my evening pill, done with my pills.",
    readOnly: false,
    card: false,
  },
  message_circle: {
    title: 'Message the family',
    description:
      "Sends a short message (up to 140 characters) from the person Care Circle looks after to the family by email. Use for: tell my family I need groceries, send a message to my kids, let Sarah know I'll be out, ask my son to call me.",
    readOnly: false,
    card: false,
  },
  get_status: {
    title: 'How are they doing today',
    description:
      "Tells a family member whether their relative checked in today, their mood and how many medicines are logged. Never reads notes aloud. Use for: how's Mom doing, did Dad check in, how is Margaret today, any news from Mom, how am I doing today.",
    readOnly: true,
    card: true,
  },
  get_week_summary: {
    title: 'Weekly summary',
    description:
      "Summarizes check-ins and logged medicines over the last several days, for family members. Use for: how was Mom's week, how has Dad been this week, weekly summary, how many days did she check in, how was the last two weeks.",
    readOnly: true,
    card: false,
  },
  set_sharing: {
    title: 'Pause or resume sharing',
    description:
      'Pauses or resumes sharing check-ins and medicine logs with the family; the family is told it is paused but not why. Use for: pause sharing, stop sharing for now, I want some privacy, resume sharing, turn sharing back on, start sharing again.',
    readOnly: false,
    card: false,
  },
};
