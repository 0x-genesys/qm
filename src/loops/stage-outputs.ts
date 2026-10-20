import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import type { StageOutputDeclaration } from "../types.ts";
import { LOOP_ITEM_PRIORITIES } from "./triage.ts";

const text = (description: string) => Type.String({ pattern: "\\S", description });

const outputsField = Type.Array(
  Type.Object({
    shipAction: text("The declared ship action."),
    title: text("One line."),
    label: Type.Optional(text("Optional grouping label.")),
    externalRef: Type.Optional(text("URL or id, if any.")),
    summary: Type.Optional(text("One line.")),
  }),
);

const replyDraft = Type.Object({
  body: Type.String({ description: "The draft reply." }),
  to: Type.Optional(Type.Array(Type.String(), { description: "Email recipients, if applicable." })),
  subject: Type.Optional(Type.String({ description: "Email subject, if applicable." })),
});

interface StageOutput<S extends TObject> extends StageOutputDeclaration {
  schema: S & Record<string, unknown>;
}

const stage = <S extends TObject>(description: string, schema: S): StageOutput<S> => ({
  description,
  schema: schema as S & Record<string, unknown>,
});

const closed = <P extends Parameters<typeof Type.Object>[0]>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });

export const INTAKE_OUTPUT = stage(
  "Submit the candidate work items this intake stage found. An empty items list is a fine answer.",
  closed({
    items: Type.Array(
      Type.Object({
        sourceKey: text("Stable unique id for the candidate."),
        sourceSummary: Type.Optional(text("One line.")),
      }),
    ),
  }),
);

export const TRIAGE_OUTPUT = stage(
  "Submit a triage decision for every item marked new.",
  closed({
    items: Type.Array(
      Type.Object({
        id: text("Id of an item marked new."),
        priority: Type.Optional(Type.Union(LOOP_ITEM_PRIORITIES.map((priority) => Type.Literal(priority)))),
        reason: Type.Optional(text("One line.")),
        groupWith: Type.Optional(text("Id of the listed item this one belongs with.")),
      }),
    ),
  }),
);

export const WORK_OUTPUT = stage(
  "Submit every externally-reviewable artifact you prepared for this item, once the work is finished. An empty outputs list means the item needed none.",
  closed({ outputs: outputsField }),
);

export const REPLY_WORK_OUTPUT = stage(
  "Submit the draft reply as proposal for human review, with an empty outputs list. Leave proposal out when no reply is needed.",
  closed({ proposal: Type.Optional(replyDraft), outputs: outputsField }),
);

export const JUDGE_OUTPUT = stage(
  'Submit your verdict. "met" only when the transcript proves the condition and every declared check passed; "park" when more attempts are pointless; otherwise "continue".',
  closed({
    outcome: Type.Union([Type.Literal("met"), Type.Literal("continue"), Type.Literal("park")]),
    reason: text("One line."),
    checks: Type.Optional(
      Type.Array(
        Type.Object({
          command: Type.String({ description: "The exact declared check." }),
          passed: Type.Boolean(),
          detail: Type.Optional(Type.String({ description: "Short result." })),
        }),
      ),
    ),
  }),
);

const FOLLOW_UP_DESCRIPTION =
  "Submit the complete revised proposal when the person asked you to change it without sending. Do not call this when the proposal is unchanged or the reply was sent.";

export const REPLY_PROPOSAL_OUTPUT = stage(FOLLOW_UP_DESCRIPTION, closed({ proposal: replyDraft }));

export const PROPOSAL_OUTPUT = stage(
  FOLLOW_UP_DESCRIPTION,
  closed({ proposal: Type.Record(Type.String(), Type.Unknown()) }),
);

export function submitted<S extends TObject>(output: StageOutput<S>, value: unknown): Static<S> | undefined {
  return value !== undefined && Check(output.schema, value) ? value : undefined;
}
