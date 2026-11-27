/* The agent's tools, system instruction and first-turn kickoff. */

export const TOOLS = [
  {
    name: "end_call",
    description:
      "Hang up the call. Call it right AFTER you have said your closing line (goodbye), never in the middle of the conversation. " +
      "Also call it straight away, without speaking, if the other side is clearly not a person (voicemail greeting, a recorded announcement, an IVR menu, silence after you asked twice).",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Why the call is ending, e.g. done, customer_request, voicemail, wrong_number, no_response" } },
      required: ["reason"],
    },
  },
  {
    name: "save_note",
    description:
      "Save one fact learned on this call for the business, as a key and a value (e.g. key 'preferred_time', value 'after 6 pm'). " +
      "Use short snake_case keys; saving the same key again replaces it. Save facts as soon as you learn them. " +
      "Before you end the call, save key 'summary' with a one-sentence summary of the call and its outcome.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short snake_case name of the fact" },
        value: { type: "string", description: "The fact, in plain words" },
      },
      required: ["key", "value"],
    },
  },
];

function languageName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code; }
}

/** Normalised BCP-47 language code to pin in the Gemini setup, or "" for auto. */
export function languagePinFor(language) {
  const l = String(language || "").trim();
  if (!l || /^(auto|any|none|off)$/i.test(l)) return "";
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : "";
}

const clip = (s, n) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n) : t; };

/** persona.instructions + a short generated preamble. */
export function buildSystemInstruction(persona = {}, context = {}, { direction = "inbound" } = {}) {
  const name = clip(persona.name, 80) || "the assistant";
  const business = clip(context.business_name, 120);
  const customer = clip(context.customer_name, 120);
  const notes = clip(context.notes, 4000);
  const lang = languagePinFor(persona.language);
  const lines = [];
  lines.push(`You are ${name}${business ? `, speaking on behalf of ${business}` : ""}.`);
  lines.push(
    `THIS IS A LIVE WHATSAPP VOICE CALL (${direction === "outbound" ? "the business called the customer" : "the customer called the business"}). ` +
      "Everything you say is spoken aloud: keep replies short (one or two sentences), natural and conversational, one question at a time. " +
      "Never read out lists, markdown, links, emojis or symbols. If you did not hear something clearly, ask them to repeat it. " +
      "Let the customer finish; if they talk over you, stop and listen.",
  );
  if (customer) lines.push(`The customer's name is ${customer}.`);
  if (notes) lines.push(`Notes from the business about this customer or call:\n${notes}`);
  if (lang) {
    const ln = languageName(lang);
    lines.push(`LANGUAGE: speak ${ln} (${lang}) the way people talk on the phone. If the customer clearly prefers another language, switch to theirs.`);
  } else {
    lines.push("LANGUAGE: reply in the language the customer speaks to you; keep it simple and conversational.");
  }
  lines.push(
    "TOOLS: use save_note to record any useful fact the customer gives (name, request, preferred time, order details, outcome). " +
      "When the conversation is finished, say a short goodbye, save the 'summary' note, then call end_call. " +
      "If the customer sincerely asks whether they are talking to a person or an AI, do not claim to be a human.",
  );
  const preamble = lines.join("\n");
  const soul = clip(persona.instructions, 60000);
  return soul ? preamble + "\n\n---\n\n" + soul : preamble;
}

/** The first turn, sent when the call goes live (/start). */
export function kickoffText(persona = {}, context = {}) {
  const greeting = clip(persona.greeting, 1000);
  if (greeting) return `The call is connected and the customer is on the line. Start now by saying your greeting: "${greeting}" — say it naturally, then wait for the customer to reply.`;
  const name = clip(persona.name, 80);
  const business = clip(context.business_name, 120);
  return `The call is connected and the customer is on the line. Greet them in one short, warm line${name ? `, introduce yourself as ${name}` : ""}${business ? ` from ${business}` : ""}, and ask how you can help. Then wait for the customer to reply.`;
}

/** The text turn sent to the model when the customer presses a key. */
export function dtmfText(digit) {
  return `[The customer pressed the "${digit}" key on their phone keypad.]`;
}
